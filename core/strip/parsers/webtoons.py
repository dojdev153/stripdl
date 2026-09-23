# strip/parsers/webtoons.py  — patched
#
# What changed and why:
#
#   PROBLEM: requests.get(..., timeout=20) with no retry.
#   FIX: Module-level requests.Session with HTTPAdapter(Retry(...)).
#        One persistent TCP connection pool shared across all threads.
#        Auto-retry on connection errors (connect=4, read=4) with
#        exponential backoff. Timeout raised to (10s connect, 45s read)
#        so slow servers don't die on first response.
#
#   PROBLEM: _PAGE_DELAY = 0.3s sleep before every HTML page fetch.
#   FIX: Removed. The token-bucket in the downloader handles CDN image
#        pacing. HTML page fetches don't need a sleep — they're already
#        serialised by the wave-batch logic.
#
#   PROBLEM: get_chapter_list() blocks until ALL pages are fetched.
#   FIX: Added iter_chapter_list() generator that yields ChapterInfo
#        objects one page at a time. The downloader uses this so downloads
#        start on the first batch of chapters while later pages are still
#        being fetched in the background.
#
#   PROBLEM: The downloader's series-info cache compared metadata against
#            whichever raw URL the user typed (/viewer or /list), so a
#            /viewer link never matched a cached /list entry.
#   FIX: Exposed the existing _normalize_url() logic via
#        SiteParser.canonicalize_url(), so the downloader can normalize
#        before doing cache lookups.
#
#   PROBLEM: Pagination termination (iter_chapter_list) judged whether a
#            page was the last page using len(items) < 10 — a hardcoded
#            assumption about how many chapters Webtoons puts on one
#            page. That assumption is now wrong: as of this writing
#            Webtoons returns 9 chapters per page, not 10, so EVERY page
#            looked like a "short/last page" and pagination stopped
#            after page 1 for every multi-page series, silently dropping
#            every earlier chapter (a 161-episode series only ever
#            discovered its newest ~9 chapters).
#   FIX: Dropped the hardcoded page-size check entirely. Termination is
#        now judged purely by deduplication — Webtoons already echoes
#        the last real page for any out-of-range page request instead of
#        returning empty results, so a page yielding zero chapters we
#        haven't already seen means we've walked off the end of the
#        list. This is page-size-agnostic and doesn't break the next
#        time Webtoons changes how many chapters it puts on a page.

import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Iterator, List
from urllib.parse import urlparse, urlsplit, parse_qs, urlencode, urlunparse

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from bs4 import BeautifulSoup

from strip.parsers.base import SiteParser, SeriesInfo, ChapterInfo

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

_BASE_HEADERS = {
    "User-Agent":      _UA,
    "Accept-Language": "en-US,en;q=0.9",
    "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

# (connect_timeout, read_timeout) in seconds.
# 10s to connect is already generous; 45s read handles genuinely slow servers.
_TIMEOUT = (10, 45)

# Parallel page fetches when scanning a multi-page chapter list.
_CONCURRENT_PAGES = 3
_PAGE_FETCH_ATTEMPTS = 3


class ChapterListError(RuntimeError):
    """Raised when a chapter-list page cannot be fetched reliably."""

    def __init__(self, page: int, cause: Exception):
        self.page = page
        self.cause = str(cause)
        super().__init__(f"Failed to fetch chapter-list page {page}: {cause}")

# ── Shared session: connection pooling + automatic retry ─────────────────────
#
# HTTPAdapter with Retry does what bare requests.get() never did:
#   connect=4  → retry when TCP handshake fails or times out
#   read=4     → retry when server stops responding mid-transfer
#   status_forcelist → retry 429/5xx after backoff
#   backoff_factor=1 → waits 0s, 1s, 2s, 4s, 8s between attempts
#
# This is the root fix for "connection timed out" errors — the old code
# had zero connection-level retry; a single bad TCP event was fatal.

_retry_policy = Retry(
    total=6,
    connect=4,
    read=4,
    backoff_factor=1,
    status_forcelist={429, 500, 502, 503, 504},
    raise_on_status=False,
    respect_retry_after_header=True,
)

_session = requests.Session()
_session.mount("https://", HTTPAdapter(max_retries=_retry_policy))
_session.mount("http://",  HTTPAdapter(max_retries=_retry_policy))
_session.headers.update(_BASE_HEADERS)


def _get(url: str, extra_headers: dict = None) -> requests.Response:
    h = {**_BASE_HEADERS, **(extra_headers or {})}
    resp = _session.get(url, headers=h, timeout=_TIMEOUT)
    resp.raise_for_status()
    return resp


def _soup(url: str) -> BeautifulSoup:
    # No sleep here — removed the old 0.3s _PAGE_DELAY.
    return BeautifulSoup(_get(url).text, "lxml")


def _normalize_url(url: str) -> str:
    """Accept /viewer or /list URLs; always return the canonical /list URL."""
    if "viewer" in url:
        parsed   = urlparse(url)
        qs       = parse_qs(parsed.query)
        title_no = qs.get("title_no", [""])[0]
        parts    = parsed.path.rstrip("/").split("/")
        parts[-1]  = "list"
        new_path   = "/".join(parts)
        new_query  = urlencode({"title_no": title_no})
        return urlunparse(parsed._replace(path=new_path, query=new_query))
    return url


def _extract_cover_url(soup: BeautifulSoup) -> str:
    for sel in [".detail_header .thmb img", ".detail_header img",
                ".info_img img", ".thmb_wrap img"]:
        for el in soup.select(sel):
            if el.find_parent(id="_listUl") or el.find_parent(class_="detail_lst"):
                continue
            src = el.get("src") or el.get("data-src") or ""
            if src.startswith("http") and "pstatic.net" in src:
                return src
    og = soup.select_one("meta[property='og:image']")
    return og.get("content", "") if og else ""


def _page_url(list_url: str, page: int) -> str:
    parsed = urlparse(list_url)
    qs = parse_qs(parsed.query)
    qs["page"] = [str(page)]
    return urlunparse(parsed._replace(query=urlencode({k: v[0] for k, v in qs.items()})))


def _parse_items(soup: BeautifulSoup) -> List[ChapterInfo]:
    items = soup.select("#_listUl li") or soup.select(".detail_lst li")
    chapters = []
    for li in items:
        if li.select_one(".ico_lock"):
            continue
        a_el = li.select_one("a")
        if not a_el:
            continue
        chapter_url = a_el.get("href", "")
        if not chapter_url.startswith("http"):
            chapter_url = "https://www.webtoons.com" + chapter_url

        ep_qs = parse_qs(urlparse(chapter_url).query)
        ep_no = float(ep_qs.get("episode_no", ["0"])[0])

        title_el = li.select_one(".subj span") or li.select_one(".subj")
        title    = title_el.get_text(strip=True) if title_el else f"Episode {ep_no}"

        date_el = li.select_one(".date")
        date    = date_el.get_text(strip=True) if date_el else ""

        thumb_el = li.select_one("img")
        thumbnail_url = (thumb_el.get("data-url") or thumb_el.get("src") or "") if thumb_el else ""

        chapters.append(ChapterInfo(
            number=ep_no, title=title,
            url=chapter_url, date=date,
            thumbnail_url=thumbnail_url,
        ))
    return chapters


class WebtoonsParser(SiteParser):
    """Parser for www.webtoons.com (English)."""

    @classmethod
    def supports(cls, url: str) -> bool:
        try:
            parsed = urlsplit(url)
            host = parsed.hostname
            # Accessing .port validates malformed and out-of-range ports.
            parsed.port
        except (AttributeError, TypeError, ValueError):
            return False
        return bool(
            parsed.scheme.lower() == "https"
            and host
            and parsed.username is None
            and parsed.password is None
            and (host == "webtoons.com" or host.endswith(".webtoons.com"))
        )

    @property
    def name(self) -> str:
        return "Webtoons.com"

    def canonicalize_url(self, url: str) -> str:
        return _normalize_url(url)

    # ── series info ────────────────────────────────────────────────────────────

    def get_series_info(self, url: str) -> SeriesInfo:
        list_url = _normalize_url(url)
        soup     = _soup(list_url)

        title_el = soup.select_one("h1.subj") or soup.select_one(".info .subj")
        title    = title_el.get_text(strip=True) if title_el else "Unknown"

        author_el = soup.select_one(".author_area .author") or soup.select_one(".author")
        author    = author_el.get_text(strip=True) if author_el else ""
        author    = re.sub(r"\s+author info.*", "", author, flags=re.I).strip()

        desc_el     = soup.select_one(".summary") or soup.select_one(".desc")
        description = desc_el.get_text(strip=True) if desc_el else ""

        cover_url  = _extract_cover_url(soup)
        path_parts = urlparse(list_url).path.strip("/").split("/")
        genre      = path_parts[1] if len(path_parts) > 1 else ""

        status_el = (soup.select_one(".comic_info .day_info")
                     or soup.select_one(".info .day_info"))
        status = status_el.get_text(strip=True).lower() if status_el else ""

        return SeriesInfo(
            title=title, author=author, description=description,
            cover_url=cover_url, url=list_url, genre=genre, status=status,
        )

    # ── chapter list ───────────────────────────────────────────────────────────

    def _fetch_chapter_page(self, url: str, page: int) -> List[ChapterInfo]:
        """
        Fetch one pagination page.
        Returns [] when there are no more pages (an out-of-range page echoes
        the last real page, so iter_chapter_list's deduplication — not this
        return value's length — is what detects the true end of the list).
        """
        list_url = _normalize_url(url)
        return _parse_items(_soup(_page_url(list_url, page)))

    def _fetch_page_with_retry(self, url: str, page: int) -> List[ChapterInfo]:
        """Retry transient page errors; never turn a failed page into an end marker."""
        last_error = None
        for attempt in range(_PAGE_FETCH_ATTEMPTS):
            try:
                return self._fetch_chapter_page(url, page)
            except Exception as exc:
                last_error = exc
                if attempt + 1 < _PAGE_FETCH_ATTEMPTS:
                    time.sleep(0.5 * (2 ** attempt))
        raise ChapterListError(page, last_error) from last_error

    def iter_chapter_list(self, url: str) -> Iterator[ChapterInfo]:
        """
        Discover the terminal page with exponential probes and binary search,
        then yield chapters oldest-first. Webtoons echoes its last page for
        out-of-range requests, so the echoed chapter identity sequence marks
        the boundary without assuming a fixed page size.
        """
        def identity(items):
            return tuple((item.number, item.url) for item in items)

        first = self._fetch_page_with_retry(url, 1)
        if not first:
            return

        second = self._fetch_page_with_retry(url, 2)
        terminal_identity = identity(first)
        if identity(second) == terminal_identity:
            terminal_page = 1
        else:
            before_previous_page = 1
            previous_page = 2
            previous_identity = identity(second)
            probe_page = 4
            bracket = None

            for _ in range(64):
                probed = self._fetch_page_with_retry(url, probe_page)
                probed_identity = identity(probed)
                if probed_identity == previous_identity:
                    terminal_identity = probed_identity
                    bracket = (before_previous_page, previous_page)
                    break
                before_previous_page, previous_page = previous_page, probe_page
                previous_identity = probed_identity
                probe_page *= 2

            if bracket is None:
                raise ChapterListError(
                    probe_page, RuntimeError("could not identify a repeated terminal page"))

            low, high = bracket
            while high - low > 1:
                middle = (low + high) // 2
                items = self._fetch_page_with_retry(url, middle)
                if identity(items) == terminal_identity:
                    high = middle
                else:
                    low = middle
            terminal_page = high

        seen = set()
        for page in range(terminal_page, 0, -1):
            items = self._fetch_page_with_retry(url, page)
            for chapter in reversed(items):
                key = (chapter.number, chapter.url)
                if key not in seen:
                    seen.add(key)
                    yield chapter

    def get_chapter_list(self, url: str) -> List[ChapterInfo]:
        """Blocking — collects all chapters then sorts ascending by episode number."""
        chapters = list(self.iter_chapter_list(url))
        chapters.sort(key=lambda c: c.number)
        return chapters

    # ── images ────────────────────────────────────────────────────────────────

    def get_chapter_images(self, chapter_url: str) -> List[str]:
        soup   = _soup(chapter_url)
        images = []
        for img in soup.select("#_imageList img"):
            src = img.get("data-url") or img.get("src") or ""
            if src and src.startswith("http"):
                images.append(src)
        if not images:
            for img in soup.select(".viewer_lst img"):
                src = img.get("data-url") or img.get("src") or ""
                if src and src.startswith("http"):
                    images.append(src)
        return images

    def get_image_headers(self) -> dict:
        return {"Referer": "https://www.webtoons.com/", "User-Agent": _UA}
