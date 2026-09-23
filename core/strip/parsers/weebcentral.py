# strip/parsers/weebcentral.py
# Parser implementation for WeebCentral (weebcentral.com).
# Supports manga, manhwa, and manhua downloads including Sakamoto Days.

import re
from typing import Iterator, List
from urllib.parse import urlparse

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

_TIMEOUT = (10, 45)


def _make_session() -> requests.Session:
    s = requests.Session()
    retry = Retry(
        total=4,
        backoff_factor=1.0,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"],
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=10, pool_maxsize=20)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    s.headers.update({
        "User-Agent": _UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    })
    return s


class WeebCentralParser(SiteParser):
    """
    Parser for weebcentral.com manga & manhwa reader.
    """

    _session: requests.Session = None

    def __init__(self):
        if WeebCentralParser._session is None:
            WeebCentralParser._session = _make_session()
        self.session = WeebCentralParser._session

    @classmethod
    def supports(cls, url: str) -> bool:
        """Return True for any weebcentral.com URL."""
        try:
            netloc = urlparse(url).netloc.lower()
            return "weebcentral.com" in netloc
        except Exception:
            return False

    @property
    def name(self) -> str:
        return "WeebCentral"

    def canonicalize_url(self, url: str) -> str:
        """
        Normalize a WeebCentral URL to its canonical series landing URL:
        https://weebcentral.com/series/<series_id>/<slug>
        """
        parsed = urlparse(url)
        path = parsed.path.rstrip("/")

        # If it's a chapter URL (/chapters/<id>), resolve its series link
        if "/chapters/" in path:
            try:
                resp = self.session.get(url, timeout=_TIMEOUT)
                if resp.status_code == 200:
                    soup = BeautifulSoup(resp.text, "html.parser")
                    for a in soup.find_all("a", href=True):
                        href = a["href"]
                        if "/series/" in href and "/random" not in href:
                            if href.startswith("http"):
                                return href
                            return f"https://weebcentral.com{href}"
            except Exception:
                pass

        # If it's a series URL with extra paths like /full-chapter-list
        series_match = re.search(r"/series/([0-9A-Z]+)(?:/([^/?#]+))?", url)
        if series_match:
            series_id = series_match.group(1)
            slug = series_match.group(2) or ""
            if slug and slug != "full-chapter-list":
                return f"https://weebcentral.com/series/{series_id}/{slug}"
            return f"https://weebcentral.com/series/{series_id}"

        return url

    def _extract_series_id(self, url: str) -> str:
        canonical = self.canonicalize_url(url)
        m = re.search(r"/series/([0-9A-Z]+)", canonical)
        if m:
            return m.group(1)
        raise ValueError(f"Could not determine WeebCentral series ID from URL: {url}")

    def get_series_info(self, url: str) -> SeriesInfo:
        """
        Fetch and parse series metadata from the WeebCentral series page.
        """
        canonical_url = self.canonicalize_url(url)
        resp = self.session.get(canonical_url, timeout=_TIMEOUT)
        resp.raise_for_status()

        soup = BeautifulSoup(resp.text, "html.parser")

        # 1. Title
        title_el = soup.find("h1")
        title = title_el.get_text(strip=True) if title_el else ""
        if not title:
            og_title = soup.find("meta", property="og:title")
            title = og_title["content"].strip() if og_title and og_title.get("content") else "Unknown Title"

        # 2. Cover image
        cover_url = ""
        og_image = soup.find("meta", property="og:image")
        if og_image and og_image.get("content"):
            cover_url = og_image["content"].strip()
        else:
            poster = soup.find("picture")
            if poster:
                img = poster.find("img")
                if img and img.get("src"):
                    cover_url = img["src"].strip()

        # 3. Author & Status & Genre
        author = "Unknown"
        status = "ongoing"
        genres: List[str] = []

        for li in soup.find_all("li"):
            text = li.get_text(" ", strip=True)
            if "Author(s):" in text:
                val = text.replace("Author(s):", "").strip()
                if val:
                    author = val
            elif "Status:" in text:
                val = text.replace("Status:", "").strip().lower()
                if "complete" in val:
                    status = "completed"
                elif "hiatus" in val:
                    status = "hiatus"
                else:
                    status = "ongoing"
            elif "Tags(s):" in text or "Genre" in text:
                for a in li.find_all("a"):
                    tag_name = a.get_text(strip=True)
                    if tag_name:
                        genres.append(tag_name)

        # 4. Description
        description = ""
        desc_h = soup.find(lambda e: e.name in ["h2", "h3", "strong", "span"] and "Description" in e.get_text())
        if desc_h and desc_h.parent:
            full_text = desc_h.parent.get_text(strip=True)
            if full_text.startswith("Description"):
                description = full_text[len("Description"):].strip()
            else:
                description = full_text
        if not description:
            og_desc = soup.find("meta", property="og:description")
            if og_desc and og_desc.get("content"):
                description = og_desc["content"].strip()

        # Fetch chapter count
        chapters = self.get_chapter_list(canonical_url)
        total_chapters = len(chapters)

        return SeriesInfo(
            title=title,
            author=author,
            description=description,
            cover_url=cover_url,
            url=canonical_url,
            genre=", ".join(genres),
            status=status,
            total_chapters=total_chapters,
        )

    def get_chapter_list(self, url: str) -> List[ChapterInfo]:
        """
        Return all chapters for the series, sorted ascending by chapter number.
        """
        series_id = self._extract_series_id(url)
        list_url = f"https://weebcentral.com/series/{series_id}/full-chapter-list"

        resp = self.session.get(list_url, timeout=_TIMEOUT)
        resp.raise_for_status()

        soup = BeautifulSoup(resp.text, "html.parser")
        chapters: List[ChapterInfo] = []

        for a in soup.find_all("a", href=True):
            href = a["href"]
            if not href.startswith("/chapters/") and "/chapters/" not in href:
                continue

            chapter_url = href if href.startswith("http") else f"https://weebcentral.com{href}"

            # Extract chapter title and number
            raw_text = a.get_text(" ", strip=True)
            # Remove "Last Read" text if present
            raw_text = re.sub(r"\bLast Read\b", "", raw_text, flags=re.IGNORECASE).strip()

            # Find chapter number from text
            # Matches formats like: "Chapter 74", "Days 275", "Ep. 12.5", "Ch. 1"
            num_match = re.search(r"(?:Chapter|Ch\.?|Days?|Episode|Ep\.?|#)?\s*(\d+(?:\.\d+)?)", raw_text, re.IGNORECASE)
            if num_match:
                chapter_num = float(num_match.group(1))
            else:
                # Fallback to looking for any number
                fallback_num = re.search(r"(\d+(?:\.\d+)?)", raw_text)
                chapter_num = float(fallback_num.group(1)) if fallback_num else 0.0

            # Chapter Title
            chapter_title = raw_text.split("\n")[0].strip()
            # Clean up redundant dates if present in title
            time_el = a.find("time")
            date_str = ""
            if time_el:
                date_str = time_el.get("datetime") or time_el.get_text(strip=True)
                if date_str and date_str in chapter_title:
                    chapter_title = chapter_title.replace(date_str, "").strip()

            chapters.append(
                ChapterInfo(
                    number=chapter_num,
                    title=chapter_title or f"Chapter {chapter_num:g}",
                    url=chapter_url,
                    date=date_str,
                )
            )

        # Sort ascending by chapter number
        chapters.sort(key=lambda c: c.number)
        return chapters

    def iter_chapter_list(self, url: str) -> Iterator[ChapterInfo]:
        """
        Yield discovered chapters sorted ascending.
        """
        for chapter in self.get_chapter_list(url):
            yield chapter

    def get_chapter_images(self, chapter_url: str) -> List[str]:
        """
        Return the list of full image URLs for a chapter.
        """
        # Ensure long_strip reader endpoint is used for full image list
        if "/images" not in chapter_url:
            base_url = chapter_url.split("?")[0].rstrip("/")
            fetch_url = f"{base_url}/images?reading_style=long_strip"
        else:
            fetch_url = chapter_url

        resp = self.session.get(fetch_url, timeout=_TIMEOUT)
        resp.raise_for_status()

        soup = BeautifulSoup(resp.text, "html.parser")
        images: List[str] = []

        for img in soup.find_all("img"):
            src = img.get("src") or img.get("data-src")
            if not src:
                continue

            # Exclude icon/badge svgs
            if ".svg" in src or "static/images" in src:
                continue

            if src.startswith("//"):
                src = "https:" + src

            images.append(src)

        return images

    def get_image_headers(self) -> dict:
        """HTTP headers for fetching CDN images."""
        return {
            "User-Agent": _UA,
            "Referer": "https://weebcentral.com/",
            "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        }
