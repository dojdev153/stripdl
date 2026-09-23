import unittest
from unittest.mock import patch

from strip.parsers.base import ChapterInfo
from strip.parsers.webtoons import ChapterListError, WebtoonsParser


URL = "https://www.webtoons.com/en/x/list?title_no=1"


class PaginationFailureTests(unittest.TestCase):
    def test_retries_then_returns_page(self):
        parser = WebtoonsParser()
        with patch.object(
            parser, "_fetch_chapter_page",
            side_effect=[TimeoutError(), [ChapterInfo(1, "One", "u")]],
        ) as fetch, patch("strip.parsers.webtoons.time.sleep"):
            chapters = parser._fetch_page_with_retry(URL, 2)
        self.assertEqual(chapters[0].number, 1)
        self.assertEqual(fetch.call_count, 2)

    def test_exhaustion_raises_page_error_with_number(self):
        parser = WebtoonsParser()
        with patch.object(parser, "_fetch_chapter_page", side_effect=TimeoutError("offline")), \
             patch("strip.parsers.webtoons.time.sleep"):
            with self.assertRaisesRegex(ChapterListError, "2"):
                parser._fetch_page_with_retry(URL, 2)


def ch(number):
    return ChapterInfo(
        number, f"Episode {number}",
        f"https://www.webtoons.com/viewer?episode_no={number}",
    )


class OrderedIteratorTests(unittest.TestCase):
    def test_variable_pages_yield_each_chapter_once_oldest_first(self):
        pages = {1: [ch(5), ch(4)], 2: [ch(3), ch(2)], 3: [ch(1)]}
        parser = WebtoonsParser()
        with patch.object(
            parser, "_fetch_chapter_page",
            side_effect=lambda _url, page: pages.get(page, pages[3]),
        ):
            numbers = [chapter.number for chapter in parser.iter_chapter_list(URL)]
        self.assertEqual(numbers, [1, 2, 3, 4, 5])
        self.assertEqual(len(numbers), len(set(numbers)))

    def test_empty_series_yields_nothing(self):
        parser = WebtoonsParser()
        with patch.object(parser, "_fetch_chapter_page", return_value=[]):
            self.assertEqual(list(parser.iter_chapter_list(URL)), [])


class UrlValidationTests(unittest.TestCase):
    def test_accepts_only_https_webtoons_hosts(self):
        parser = WebtoonsParser()
        self.assertTrue(parser.supports("https://webtoons.com/en/x/list"))
        self.assertTrue(parser.supports("https://www.webtoons.com/en/x/list"))
        invalid = (
            "http://webtoons.com/x",
            "https://evil.test/webtoons.com",
            "https://webtoons.com.evil.test/x",
            "https://webtoons.com@evil.test/x",
            "https://user@www.webtoons.com/x",
            "https://[invalid/x",
            "https://www.webtoons.com:bad/x",
        )
        for url in invalid:
            self.assertFalse(parser.supports(url), url)
