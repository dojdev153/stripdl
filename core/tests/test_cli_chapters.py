import unittest
from unittest.mock import patch

from click.testing import CliRunner

from strip.cli import cli, format_chapter_number
from strip.downloader import _passes_filter
from strip.parsers.base import ChapterInfo


class HalfChapterTests(unittest.TestCase):
    def test_exact_filter_does_not_conflate_half_chapter(self):
        chapter = ChapterInfo(12.5, "Half", "u")
        self.assertTrue(_passes_filter(chapter, None, [12.5]))
        self.assertFalse(_passes_filter(chapter, None, [12]))

    def test_formatter_keeps_half_chapter_distinct(self):
        self.assertEqual(format_chapter_number(12), "12")
        self.assertEqual(format_chapter_number(12.5), "12.5")

    def test_cli_parses_half_chapter_selector_as_float(self):
        with patch("strip.cli.get_parser", return_value=object()), \
             patch("strip.cli.download_series", return_value=None) as download:
            result = CliRunner().invoke(cli, [
                "download", "https://www.webtoons.com/en/x/list?title_no=1",
                "--chapters", "12.5", "--json-progress",
            ])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(download.call_args.kwargs["specific_chapters"], [12.5])
