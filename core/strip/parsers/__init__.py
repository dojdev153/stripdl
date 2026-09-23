# strip/parsers/__init__.py
# Parser registry – automatically maps URL patterns to the correct parser class.

from strip.parsers.webtoons import WebtoonsParser

PARSERS = [
    WebtoonsParser,
]


def get_parser(url: str):
    """Return an instantiated parser that supports *url*, or raise ValueError."""
    for cls in PARSERS:
        if cls.supports(url):
            return cls()
    raise ValueError(
        f"No parser found for URL: {url}\n"
        "Supported sites: webtoons.com"
    )
