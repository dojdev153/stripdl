# Changelog

All notable changes to this project are documented here.

## [Unreleased]

Desktop app rewrite: the renderer (`desktop/src/`) has been replaced with an Electron + React + Vite application (`desktop/renderer/`), built via [electron-vite](https://electron-vite.org/). The Python CLI, main-process IPC contract (`window.strip.*`), and on-disk folder structure are all unchanged — this is a renderer-only rewrite.

- **feat:** Library, Series detail, Reader, Settings, and the Download tray are now React components/views instead of hand-written HTML + vanilla JS, backed by dedicated hooks and context providers (`useLibrary`, `useConfig`, `DownloadTrayContext`, `ToastContext`, `ConfirmContext`).
- **feat:** Per-series auto-download scheduling (subscribe a series to specific weekdays; a background check downloads new chapters automatically while the app is open, with native OS notifications and in-app toasts) — see `desktop/main/scheduler.js`.
- **fix:** Local images (covers, chapter pages) are now served through a custom `strip-file://` protocol instead of `file://`, which Chromium blocks from loading when the page itself is served over `http://` (as the renderer is during development via Vite's dev server). This also fixes a Windows-specific bug where an earlier `strip-file://` URL format silently dropped the drive letter, breaking every local image uniformly.
- **fix:** The app would intermittently freeze ("Not Responding") during active downloads. Root cause: every raw per-page download-progress event triggered an immediate, synchronous React re-render across the whole app; progress events are now buffered and flushed in a single batched update per animation frame, and per-job log/chapter tracking state is capped so long downloads of large series don't grow unboundedly.
- **fix:** An unhandled `'error'` event on the spawned `stripdl` child process would have crashed the entire main process if the CLI were ever missing from `PATH` (or the bundled binary missing in a packaged build); now caught and reported through the normal progress/notification channels.
- **fix:** Queued downloads (when `max_concurrent_jobs` is reached) now correctly replace their "queued" placeholder card with the real job card once a slot frees up, instead of leaving an orphaned duplicate card behind.

## v0.3.1

- **fix:** Chapter-list pagination infinite loop — Webtoons echoes the last valid page for out-of-range requests; pagination now terminates via episode-number deduplication
- **fix:** Downloads were starting from the newest chapter — list sorted ascending before the download queue is populated so chapter 1 always downloads first
- **fix:** Connection timeouts — persistent `Session` + `HTTPAdapter(Retry(...))` replaces bare `requests.get()` for automatic retry on TCP failures and 5xx responses
- **fix:** Removed 0.3 s artificial sleep between chapter-list page requests
- **fix:** `build_cli.py` now auto-installs PyInstaller if not present instead of crashing
- **feat:** `--start N` / `-s N` — download from chapter N through the latest
- **fix:** Broken `core.strip` import paths in cached series-info lookup and `config --reset`, both of which raised `ModuleNotFoundError`
- **fix:** `SeriesLock`'s stale-lock check could call `TerminateProcess` on an unrelated process on Windows; replaced with a query-only PID check
- **fix:** Half-chapters (e.g. 12.5) collided with their preceding whole chapter on disk, silently overwriting images/metadata; each chapter number now gets a distinct folder
- **fix:** Series-metadata cache lookups compared against the raw user-provided URL instead of its canonical form, so `/viewer` links never hit the cache
- **feat:** `--cache-ttl N` and `--overwrite` exposed as CLI flags (previously `--overwrite` was `config`-only, and there was no way to set a non-zero/non-default cache TTL from the CLI or the desktop app)
- **refactor:** Electron's download-config-to-CLI-flag translation centralized in `desktop/main/configKeys.js` instead of hand-written per-setting branches
- **docs:** Fixed `electron-app/` → `desktop/` and root-level → `core/` path references throughout README and CONTRIBUTING

## v0.3.0

- Concurrent chapter downloads with configurable worker count
- Pipelined chapter-list fetch and image download
- Partial chapter resume — only missing images re-downloaded
- Optional SHA-256 integrity verification (`--verify`)
- Series metadata cache with configurable TTL
- Token-bucket rate limiter shared across all download threads
- Per-series file lock prevents duplicate concurrent downloads
- Lazy image loading and next-chapter preload in the reader
- Right-click context menus, keyboard shortcuts, toast notifications in Electron app

## v0.2.1

- Fixed frozen "Fetching chapter list…" progress spinner

## v0.2.0

- Sequential chapter downloads (fixed ThreadPoolExecutor ordering bug)
- Rate-limit backoff on 429/503
- Correct cover image extraction
- Persistent download tray in Electron app

## v0.1.0

- Initial release
