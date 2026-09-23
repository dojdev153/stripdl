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
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Iterator, List
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

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
        return "webtoons.com" in url

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

    def iter_chapter_list(self, url: str) -> Iterator[ChapterInfo]:
        """
        Yield ChapterInfo objects as each page arrives.
        Pages are fetched in parallel batches of _CONCURRENT_PAGES.
        Yields in site order (newest chapters first on Webtoons).

        Termination is judged ENTIRELY by deduplication: Webtoons echoes the
        last real page for any out-of-range page request instead of returning
        empty results, so as soon as a page yields zero chapters we haven't
        already seen, we've walked off the end of the list and can stop.

        Deliberately NOT judged by a fixed "chapters per page" threshold
        (previously len(items) < 10, and briefly a raw-item-count variant of
        the same idea): the real page size is a Webtoons implementation
        detail this project doesn't control, and it has changed — observed
        to be 9 as of this writing, not the 10 this code used to assume.
        Hardcoding any specific number made every page look like a
        short/last page and stopped pagination after page 1 for every
        multi-page series, silently dropping every earlier chapter. Dedup
        alone is page-size-agnostic and self-correcting no matter what
        number Webtoons uses today or changes to next.
        """
        seen: set = set()

        # Page 1 serial — establishes whether the series has any chapters at all
        p1 = self._fetch_chapter_page(url, 1)
        new_on_p1 = []
        for ch in p1:
            if ch.number not in seen:
                seen.add(ch.number)
                new_on_p1.append(ch)
        yield from new_on_p1

        if not new_on_p1:
            return  # empty series, or page 1 is already an echo of nothing

        # Remaining pages — parallel batches, yielded in page order
        next_page = 2
        with ThreadPoolExecutor(max_workers=_CONCURRENT_PAGES) as pool:
            while True:
                batch = list(range(next_page, next_page + _CONCURRENT_PAGES))
                next_page += _CONCURRENT_PAGES

                futures = {pool.submit(self._fetch_chapter_page, url, p): p
                           for p in batch}
                results = {}
                for fut in as_completed(futures):
                    p = futures[fut]
                    try:
                        results[p] = fut.result()
                    except Exception:
                        results[p] = []

                done = False
                for p in sorted(results):
                    items = results[p]
                    new_items = [ch for ch in items if ch.number not in seen]
                    for ch in new_items:
                        seen.add(ch.number)
                    yield from new_items
                    # Stop as soon as a page has nothing new — the
                    # page-size-agnostic signal that we've reached the end.
                    if not new_items:
                        done = True
                        break
                if done:
                    break

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