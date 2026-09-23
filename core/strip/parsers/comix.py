# strip/parsers/comix.py
"""Parser for comix.to manga site (e.g., Sakamoto Days).
Implements the required SiteParser interface.
"""

import json
import re
from urllib.parse import urlparse, parse_qs, urlunparse

import requests
from bs4 import BeautifulSoup

from strip.parsers.base import SiteParser, SeriesInfo, ChapterInfo

# ---------------------------------------------------------------------------
# Session with retries and a generous timeout – comix.to can be a bit flaky.
# ---------------------------------------------------------------------------
_retry_policy = requests.adapters.Retry(
    total=6,
    connect=4,
    read=4,
    backoff_factor=1,
    status_forcelist={429, 500, 502, 503, 504},
    raise_on_status=False,
    respect_retry_after_header=True,
)
_session = requests.Session()
_adapter = requests.adapters.HTTPAdapter(max_retries=_retry_policy)
_session.mount("https://", _adapter)
_session.mount("http://", _adapter)

# Simple headers – the site does not require a special referer.
_BASE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}
_session.headers.update(_BASE_HEADERS)
_TIMEOUT = (10, 45)  # (connect, read)

def _get(url: str, extra_headers: dict = None) -> requests.Response:
    """GET with shared session, merging any extra headers."""
    h = {**_BASE_HEADERS, **(extra_headers or {})}
    resp = _session.get(url, headers=h, timeout=_TIMEOUT)
    resp.raise_for_status()
    return resp

def _soup(url: str) -> BeautifulSoup:
    """Fetch a page and return a BeautifulSoup object."""
    return BeautifulSoup(_get(url).text, "lxml")

class ComixParser(SiteParser):
    @classmethod
    def supports(cls, url: str) -> bool:
        return "comix.to" in url.lower()

    @property
    def name(self) -> str:
        return "Comix.to"

    def canonicalize_url(self, url: str) -> str:
        """Normalize a chapter URL to the series landing page.
        Example:
            https://comix.to/title/w2w78-sakamoto-days/9077891-chapter-74
        becomes
            https://comix.to/title/w2w78-sakamoto-days
        """
        parsed = urlparse(url)
        parts = parsed.path.strip("/").split("/")
        if len(parts) >= 2 and parts[0] == "title":
            slug = parts[1]
            new_path = f"/title/{slug}"
            return urlunparse(parsed._replace(path=new_path, query="", fragment=""))
        return url

    def get_series_info(self, url: str) -> SeriesInfo:
        series_url = self.canonicalize_url(url)
        soup = _soup(series_url)
        title_tag = soup.select_one("h1, .title, meta[property='og:title']")
        title = (
            title_tag.get_text(strip=True)
            if title_tag and title_tag.name != "meta"
            else (title_tag["content"] if title_tag and title_tag.name == "meta" else "")
        )
        author_tag = soup.select_one(".author, .detail_author, .info_author")
        author = author_tag.get_text(strip=True) if author_tag else ""
        desc_tag = soup.select_one("meta[name='description'], .description, .detail_desc")
        description = (
            desc_tag["content"]
            if desc_tag and desc_tag.name == "meta"
            else (desc_tag.get_text(strip=True) if desc_tag else "")
        )
        cover_tag = soup.select_one(".cover img, .detail_header .thmb img, .detail_header img")
        cover_url = cover_tag["src"] if cover_tag else ""
        status_tag = soup.select_one(".status, .detail_status, .info_status")
        status = status_tag.get_text(strip=True).lower() if status_tag else ""
        return SeriesInfo(
            title=title,
            author=author,
            description=description,
            cover_url=cover_url,
            url=series_url,
            genre="",
            status=status,
            total_chapters=0,
            extra={"site": "comix.to"},
        )

    def get_chapter_list(self, url: str) -> list[ChapterInfo]:
        """Fetch chapter list via the public JSON API.
        API pattern: https://comix.to/api/v2/manga/<slug>/chapters?limit=100
        """
        series_url = self.canonicalize_url(url)
        parsed = urlparse(series_url)
        parts = parsed.path.strip("/").split("/")
        slug = parts[1] if len(parts) >= 2 else ""
        api_url = f"https://comix.to/api/v2/manga/{slug}/chapters?limit=100"
        resp = _get(api_url)
        data = resp.json()
        chapters = []
        for item in data.get("chapters", []):
            number = float(item.get("number", 0))
            title = item.get("title", f"Chapter {number}")
            chap_url = item.get("url") or f"{series_url}/{item.get('id')}-chapter-{int(number)}"
            date = item.get("created_at", "")
            thumbnail = item.get("thumbnail", "")
            chapters.append(
                ChapterInfo(
                    number=number,
                    title=title,
                    url=chap_url,
                    date=date,
                    thumbnail_url=thumbnail,
                )
            )
        chapters.sort(key=lambda c: c.number)
        return chapters

    def get_chapter_images(self, chapter_url: str) -> list[str]:
        soup = _soup(chapter_url)
        img_tags = soup.select("img.page-img, img[data-src], img[src]")
        urls = []
        for img in img_tags:
            src = img.get("data-src") or img.get("src")
            if src and src.startswith("http"):
                urls.append(src)
        return urls

    def get_image_headers(self) -> dict:
        return {}
