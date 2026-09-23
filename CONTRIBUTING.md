# Contributing to strip ◈

Thanks for your interest in contributing. This document covers everything you need to get set up, the areas where help is most welcome, and the conventions the codebase follows.

---

## Table of contents

- [Project structure](#project-structure)
- [Development setup](#development-setup)
- [Ways to contribute](#ways-to-contribute)
- [Adding a new site parser](#adding-a-new-site-parser)
- [Working on the Electron app](#working-on-the-electron-app)
- [Code conventions](#code-conventions)
- [Submitting changes](#submitting-changes)
- [Commit message format](#commit-message-format)

---

## Project structure

strip/
├── core/
│ ├── strip/ # Python package (CLI + downloader)
│ │ ├── cli.py # Click commands, Rich progress display
│ │ ├── downloader.py # Pipeline orchestrator, chapter/image download
│ │ ├── config.py # ~/.strip/config.json wrapper
│ │ ├── library.py # Scans local download directory
│ │ └── parsers/
│ │ ├── base.py # SiteParser ABC, SeriesInfo, ChapterInfo
│ │ ├── init.py # Parser registry (PARSERS list + get_parser())
│ │ └── webtoons.py # Webtoons.com implementation
│ ├── requirements.txt
│ └── setup.py
├── desktop/
│ ├── main/
│ │ ├── index.js # Main process: IPC handlers, CLI subprocess
│ │ ├── configKeys.js # Electron config key -> CLI flag mapping
│ │ └── preload.js # contextBridge API exposed to renderer
│ └── src/
│ ├── index.html # App shell
│ ├── js/app.js # All renderer logic (library, reader, tray, settings)
│ └── css/main.css # All styles
└── build_cli.py # PyInstaller wrapper

---

## Development setup

### Python CLI

```bash
git clone https://github.com/ZLouisMiguel/strip.git
cd strip/core

# Install in editable mode — changes to strip/ take effect immediately
pip install -e .

# Verify
stripdl --version
```

**Python 3.9+ required.** Dependencies (`requests`, `beautifulsoup4`, `lxml`, `Pillow`, `rich`, `click`) are installed automatically with `pip install -e .`.

### Electron app

```bash
cd desktop
npm install
npm start           # opens the app in development mode
npm run dev         # same, with --dev flag for extra logging
```

**Node.js 18+ required.**

The renderer has no build step — `index.html`, `app.js`, and `main.css` are loaded directly. Edit and reload the window (`Ctrl+R` / `Cmd+R`) to see changes.

### Running the CLI against the live app

The Electron app spawns `stripdl` from `PATH` during development (`npm start`) and from `resources/strip-cli/stripdl` in a packaged build. As long as you have `pip install -e .` active, `npm start` will pick up your local edits automatically.

---

## Ways to contribute

### Bug reports

Open an issue with:

- What you ran (URL, command, OS, Python version)
- The full error output or unexpected behaviour
- Whether it's reproducible — if so, steps to reproduce

### Bug fixes

Check the issue tracker for anything labelled **bug**. If you're fixing something not yet filed, open an issue first so the fix can be discussed before you spend time on it.

### New site parsers

The most impactful contribution. See [Adding a new site parser](#adding-a-new-site-parser) below. Any site that serves manga, manhwa, or webtoons as paginated image lists is a good candidate.

### Improving the Electron app

Good places to look:

- UX improvements to the download tray or reader toolbar
- Better error surfaces (the app currently shows raw CLI error strings in some cases)
- Keyboard shortcut gaps
- Windows-specific path or styling issues

### Configuration and CLI flags

New `stripdl` options that are broadly useful — things like `--output` overrides, new filter modes, or better progress output. If a new option should also be settable from the desktop app, add it to `desktop/main/configKeys.js` rather than hand-writing another branch in `download:start`.

### Documentation

Fixing errors in the README or this file, or adding examples and explanations that would have helped you when you first set things up.

---

## Adding a new site parser

All site-specific scraping lives in `core/strip/parsers/`. Adding a parser for a new site requires three files to touch and zero changes to the downloader or CLI.

### 1. Create the parser file

```python
# core/strip/parsers/mysite.py

from strip.parsers.base import SiteParser, SeriesInfo, ChapterInfo


class MySiteParser(SiteParser):

    @classmethod
    def supports(cls, url: str) -> bool:
        """Return True for any URL this parser can handle."""
        return "mysite.com" in url

    @property
    def name(self) -> str:
        return "MySite"

    def get_series_info(self, url: str) -> SeriesInfo:
        """
        Fetch title, author, description, cover URL from the series landing page.
        Return a SeriesInfo dataclass.
        """
        ...

    def get_chapter_list(self, url: str) -> list[ChapterInfo]:
        """
        Return all available chapters sorted ascending by chapter number.
        Handle pagination transparently — the caller expects the full list.
        ChapterInfo.number is a float so .5 chapters are supported.
        """
        ...

    def get_chapter_images(self, chapter_url: str) -> list[str]:
        """
        Return a list of full image URLs for every page in the chapter.
        Order matters — images are saved in the order returned.
        """
        ...

    def get_image_headers(self) -> dict:
        """
        HTTP headers to attach to every image download request.
        Override if the CDN requires a Referer or specific User-Agent.
        """
        return {"Referer": "https://mysite.com/", "User-Agent": "..."}
```

If a series can be reached via more than one URL shape (e.g. a chapter-reader URL vs. the series landing page), also override `canonicalize_url()` so the downloader's series-info cache can key on one consistent form — see `WebtoonsParser.canonicalize_url()` for a working example.

### 2. Register it

```python
# core/strip/parsers/__init__.py

from strip.parsers.webtoons import WebtoonsParser
from strip.parsers.mysite import MySiteParser   # ← add this

PARSERS = [
    WebtoonsParser,
    MySiteParser,   # ← and this
]
```

### 3. Optional — add `iter_chapter_list` for faster downloads

If the site paginates its chapter list, implementing `iter_chapter_list` as a generator lets the downloader report live discovery progress as pages arrive, instead of the progress display sitting frozen until the entire list has been fetched.

```python
from typing import Iterator

def iter_chapter_list(self, url: str) -> Iterator[ChapterInfo]:
    """
    Yield ChapterInfo objects as each list page arrives.
    The downloader uses this to report live discovery progress; note that
    it still collects and sorts the full list before any chapter is queued
    for download (see the comment at the top of core/strip/downloader.py).
    Falls back to get_chapter_list() if not implemented.
    """
    page = 1
    while True:
        items = self._fetch_page(url, page)
        yield from items
        if len(items) < self.PAGE_SIZE:
            break
        page += 1
```

### Tips for writing a parser

- Use a module-level `requests.Session` with an `HTTPAdapter(Retry(...))` — see `webtoons.py` for a working example. Bare `requests.get()` has no retry and will fail on transient network errors.
- Set a `(connect_timeout, read_timeout)` tuple, not a single number — e.g. `timeout=(10, 45)`.
- Check `ChapterInfo.number` is actually the episode number, not a list index — many sites have non-sequential numbering.
- Locked / paywalled chapters should be silently skipped (not raised as errors). Check for a lock indicator in the chapter list HTML before including a chapter.

---

## Working on the Electron app

### Main process (`main/index.js`)

Handles IPC from the renderer, spawns the CLI subprocess, and manages native dialogs. If you add a new IPC handler, also expose it via `preload.js` — the renderer has no direct access to Node APIs.

```js
// main/index.js
ipcMain.handle('my:action', async (event, args) => { ... });

// main/preload.js
contextBridge.exposeInMainWorld('strip', {
  myAction: (args) => ipcRenderer.invoke('my:action', args),
});
```

If your new IPC handler needs to spawn `stripdl download` with a new config-driven flag, add it to `DOWNLOAD_CONFIG_FLAGS` in `main/configKeys.js` rather than adding another `if (cfg.x) args.push(...)` line directly in `download:start`.

### Renderer (`src/js/app.js`)

There is no bundler. `app.js` is a single vanilla JS file loaded directly by `index.html`. Keep it that way — no build step means anyone can open the file and read it without tooling.

When adding UI:

- Add the HTML structure to `index.html`
- Add styles to `main.css`
- Wire behaviour in `app.js`

The renderer communicates with the main process exclusively through `window.strip.*` (the contextBridge API defined in `preload.js`).

### Testing locally

`npm start` opens the app in a normal Electron window. Open DevTools with `Ctrl+Shift+I` / `Cmd+Option+I`. Main process logs appear in the terminal; renderer logs appear in DevTools console.

---

## Code conventions

### Python

- **Formatting:** no enforced formatter, but follow the style of the file you're editing — 4-space indent, single quotes for strings, type hints on public functions.
- **Error handling:** never silently swallow exceptions in the downloader. Either re-raise, emit a JSON error event (`_emit({"status": "error", ...})`), or call `progress_cb` with `status="error"`. Users need to know when something failed.
- **Threading:** the downloader uses `ThreadPoolExecutor` and `queue.Queue`. If you add shared mutable state, protect it with a `threading.Lock`. Keep locks narrow — don't hold one across I/O.
- **HTTP:** always use the module-level `_session` (a `requests.Session`) rather than bare `requests.get()`. This ensures connection pooling and retry are active.
- **Chapter paths:** never build a chapter directory or filename with `int(chapter.number)` directly — use `downloader._chapter_dirname()`, which correctly distinguishes half-chapters (e.g. 12 vs. 12.5) instead of truncating them into the same folder.

### JavaScript

- Vanilla ES2020 — no frameworks, no bundler.
- DOM updates from background work go through `requestAnimationFrame` to batch repaints.
- IPC channels are named `namespace:action` (e.g. `fs:deleteChapter`, `download:start`).
- Add comments for anything non-obvious. The file is long — future readers will thank you.

### Commits

See [Commit message format](#commit-message-format) below.

---

## Submitting changes

1. Fork the repository and create a branch from `main`:

```bash
   git checkout -b fix/webtoons-pagination
   # or
   git checkout -b feat/mangadex-parser
```

2. Make your changes. Keep each commit focused on one thing.

3. Test your changes:
   - For parser changes: run a real download against the target site and verify the folder structure and image count are correct.
   - For Electron changes: run `npm start` and test the affected flow manually.

4. Open a pull request against `main`. Describe what the change does and why, and include any relevant URLs or screenshots.

---

## Commit message format

type(scope): short description in imperative mood

Optional longer explanation. Wrap at 72 characters.
Explain what changed and why, not how (the diff shows that).

**Types:**

| Type       | When to use                               |
| ---------- | ----------------------------------------- |
| `feat`     | New feature or behaviour                  |
| `fix`      | Bug fix                                   |
| `refactor` | Code change with no behaviour change      |
| `docs`     | README, CONTRIBUTING, comments            |
| `chore`    | Dependencies, build config, version bumps |
| `test`     | Adding or fixing tests                    |

**Scopes:** `cli`, `downloader`, `webtoons`, `electron`, `build`, `config`, `docs` — or the name of a new parser (e.g. `mangadex`).

**Examples:**

feat(cli): add --start / -s option to download from a specific chapter

fix(webtoons): stop chapter-list pagination via dedup, not len < 10

chore: bump version to 0.3.1

---

## Questions
