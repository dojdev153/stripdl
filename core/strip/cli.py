#!/usr/bin/env python3
# strip/cli.py
# v2: new CLI options, hierarchical concurrent-chapter progress display.
# v2.1: fixed `config --reset` import (core.strip.config -> strip.config).
# v2.2: added --cache-ttl (lets callers set an arbitrary metadata-cache TTL,
#       not just disable it via --no-cache) and --overwrite (previously only
#       reachable via `stripdl config --set overwrite=true`).
# v2.3: removed _fetch_chapters_live, a leftover helper from before
#       download_series() did its own pipelined chapter-list fetch —
#       nothing called it anymore.

import json
import sys
import threading
import time
from typing import List, Optional

import click
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.progress import (
    Progress, SpinnerColumn, BarColumn, TextColumn, TaskID,
)
from rich import box

from strip.config import config
from strip import __version__
from strip.parsers import get_parser
from strip.parsers.base import ChapterInfo
from strip.downloader import download_series, ChapterProgress, DownloadFailure
from strip.library import scan_library

console = Console()

def format_chapter_number(number: float) -> str:
    value = float(number)
    return str(int(value)) if value.is_integer() else f"{value:g}"


# ────────────────────────────────────────────────────────────────────
#  Root group
# ────────────────────────────────────────────────────────────────────

@click.group()
@click.version_option(__version__, prog_name="stripdl")
def cli():
    """
    \b
    ███████╗████████╗██████╗ ██╗██████╗
    ██╔════╝╚══██╔══╝██╔══██╗██║██╔══██╗
    ███████╗   ██║   ██████╔╝██║██████╔╝
    ╚════██║   ██║   ██╔══██╗██║██╔═══╝
    ███████║   ██║   ██║  ██║██║██║
    ╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝╚═╝

    Webtoon downloader & library manager — v2.
    """
    pass


# ────────────────────────────────────────────────────────────────────
#  Watchdog: marks stalled chapter tasks as "waiting…"
# ────────────────────────────────────────────────────────────────────

class _ProgressWatchdog:
    def __init__(self, progress: Progress, stall_secs: float = 20.0):
        self._progress   = progress
        self._stall_secs = stall_secs
        self._last_ping  = time.monotonic()
        self._task_map: dict[float, TaskID] = {}
        self._lock   = threading.Lock()
        self._stop   = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self): self._thread.start()
    def stop(self):  self._stop.set()

    def ping(self):
        with self._lock:
            self._last_ping = time.monotonic()

    def register(self, ch: float, tid: TaskID):
        with self._lock: self._task_map[ch] = tid

    def unregister(self, ch: float):
        with self._lock: self._task_map.pop(ch, None)

    def _run(self):
        stalled = False
        while not self._stop.wait(timeout=2.0):
            with self._lock:
                age      = time.monotonic() - self._last_ping
                task_ids = list(self._task_map.values())
            if age > self._stall_secs and task_ids and not stalled:
                stalled = True
                for tid in task_ids:
                    try: self._progress.update(tid, status="[yellow]waiting…[/yellow]")
                    except Exception: pass
            elif age <= self._stall_secs and stalled:
                stalled = False


# ────────────────────────────────────────────────────────────────────
#  Thread helpers
# ────────────────────────────────────────────────────────────────────

def _run_in_thread(fn):
    result = [None]; error = [None]; done = threading.Event()
    def _target():
        try:    result[0] = fn()
        except Exception as exc: error[0] = exc
        finally: done.set()
    threading.Thread(target=_target, daemon=True).start()
    return result, error, done


def _wait_animated(done: threading.Event, progress: Progress, task_id: TaskID,
                   base_desc: str, interval: float = 0.35):
    frames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]
    i = 0
    while not done.wait(timeout=interval):
        progress.update(task_id, description=f"{base_desc} {frames[i % len(frames)]}")
        i += 1


# ────────────────────────────────────────────────────────────────────
#  download
# ────────────────────────────────────────────────────────────────────

@cli.command()
@click.argument("url")
@click.option("--chapters", "-c",
              help="Chapters: range '1-20' or list '1,3,5'.")
@click.option("--start", "-s", default=None, type=float,
              help="Start from this chapter number (inclusive). Downloads chapter N through the latest.")
@click.option("--json-progress", is_flag=True, hidden=True)
@click.option("--output", "-o", type=click.Path())
@click.option("--chapter-concurrency", default=None, type=int,
              help="Concurrent chapters (default: from config, 3).")
@click.option("--image-concurrency",   default=None, type=int,
              help="Concurrent images per chapter (default: from config, 4).")
@click.option("--rate-limit",          default=None, type=float,
              help="Max requests/sec across all threads (default: from config, 8).")
@click.option("--cache-ttl", default=None, type=int,
              help="Days to reuse cached series metadata (default: from config, 7). "
                   "0 disables caching for this run. Overridden by --no-cache.")
@click.option("--no-cache", is_flag=True, default=False,
              help="Ignore cached series metadata; re-fetch from network. "
                   "Shorthand for --cache-ttl 0.")
@click.option("--overwrite", is_flag=True, default=False,
              help="Re-download chapters even if already marked complete.")
@click.option("--verify", is_flag=True, default=False,
              help="Verify image integrity via SHA-256 checksums.")
def download(
    url, chapters, start, json_progress, output,
    chapter_concurrency, image_concurrency, rate_limit,
    cache_ttl, no_cache, overwrite, verify,
):
    """Download a webtoon series from URL.

    Chapters download concurrently (configurable).
    Resumes automatically; completed chapters are skipped unless --overwrite
    is given. If no filter is given, downloads all chapters from chapter 1.
    """
    if output:                config["download_dir"]          = output
    if chapter_concurrency:   config["max_concurrent_chapters"] = chapter_concurrency
    if image_concurrency:     config["image_concurrency"]     = image_concurrency
    if rate_limit is not None: config["rate_limit"]           = rate_limit
    if no_cache:
        config["cache_ttl_days"] = 0
    elif cache_ttl is not None:
        config["cache_ttl_days"] = cache_ttl
    if overwrite:              config["overwrite"]             = True
    if verify:                config["verify_integrity"]       = True

    try:
        parser = get_parser(url)
    except ValueError as e:
        if json_progress:
            print(json.dumps({"status": "error", "message": str(e)}), flush=True)
        else:
            console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)

    # Parse chapter filter
    chapter_range     = None
    specific_chapters = None
    if chapters:
        if "-" in chapters and "," not in chapters:
            parts = chapters.split("-")
            try:
                chapter_range = (float(parts[0]), float(parts[1]))
            except ValueError:
                console.print("[red]Invalid range. Use e.g. 1-10[/red]"); sys.exit(1)
        else:
            try:
                specific_chapters = [float(x.strip()) for x in chapters.split(",")]
            except ValueError:
                console.print("[red]Invalid list. Use e.g. 1,2,5[/red]"); sys.exit(1)
    elif start is not None:
        # --start N means: download from chapter N through the latest
        chapter_range = (float(start), float("inf"))

    # ── JSON / Electron mode ─────────────────────────────────────────
    if json_progress:
        try:
            download_series(parser=parser, url=url,
                            chapter_range=chapter_range,
                            specific_chapters=specific_chapters,
                            json_progress=True)
        except DownloadFailure as e:
            if not e.events_emitted:
                for failure in e.failures:
                    print(json.dumps({
                        "status": "chapter_error", "chapter": failure.number,
                        "message": failure.message,
                    }), flush=True)
            print(json.dumps({
                "status": e.outcome,
                "message": str(e),
                "failures": [
                    {"chapter": failure.number, "message": failure.message}
                    for failure in e.failures
                ],
            }), flush=True)
            sys.exit(1)
        except RuntimeError as e:
            print(json.dumps({"status": "error", "message": str(e)}), flush=True)
            sys.exit(1)
        return

    # ── Interactive Rich CLI mode ────────────────────────────────────
    console.print(Panel.fit(
        f"[bold cyan]stripdl[/bold cyan] – [dim]{url}[/dim]",
        border_style="cyan",
    ))

    progress = Progress(
        SpinnerColumn(),
        TextColumn("[bold]{task.description:<54}"),
        BarColumn(bar_width=24),
        TextColumn("[cyan]{task.completed}[/cyan]/[white]{task.total}[/white]"),
        TextColumn(" {task.fields[status]}"),
        console=console,
        transient=False,
    )

    chapter_tasks: dict[float, TaskID] = {}
    overall_task:  list[Optional[TaskID]] = [None]
    ch_task:       list[Optional[TaskID]] = [None]   # fetch-progress row
    cb_lock  = threading.Lock()
    watchdog = _ProgressWatchdog(progress, stall_secs=20.0)

    def on_progress(cp: ChapterProgress):
        watchdog.ping()
        with cb_lock:
            ch    = cp.chapter_number
            label = f"Ch {format_chapter_number(ch):>4}  {cp.chapter_title[:36]}"

            # ── New pipeline events ──────────────────────────────────
            if cp.status == "chapter_found":
                # A new chapter was discovered; expand the overall bar total by 1.
                if overall_task[0] is not None:
                    t = progress.tasks[overall_task[0]]
                    progress.update(overall_task[0], total=max(1, (t.total or 0) + 1))
                else:
                    # Overall bar doesn't exist yet — create it now on first chapter
                    tid = progress.add_task("[bold white]Overall",
                        total=1, completed=0, status="")
                    overall_task[0] = tid
                # Also update the fetch-progress row
                if ch_task[0] is not None:
                    progress.update(ch_task[0],
                        description=f"Fetching chapters…  ({cp.pages_done} found)")
                return

            if cp.status == "fetch_done":
                # Chapter list is fully discovered — mark fetch row complete.
                if ch_task[0] is not None:
                    progress.update(ch_task[0],
                        description=f"Chapter list  [dim]({cp.pages_done} total)[/dim]",
                        total=1, completed=1, status="")
                return
            # ────────────────────────────────────────────────────────

            if cp.status == "skipped":
                if ch not in chapter_tasks:
                    tid = progress.add_task(label,
                        total=max(cp.pages_total, 1),
                        completed=cp.pages_total,
                        status="[dim]skipped[/dim]")
                    chapter_tasks[ch] = tid
                # Skipped chapters don't count as "downloaded" — remove from overall
                if overall_task[0] is not None:
                    t = progress.tasks[overall_task[0]]
                    new_total = max(1, (t.total or 1) - 1)
                    progress.update(overall_task[0], total=new_total)
                return

            if cp.status.startswith("rate_limited:"):
                secs = cp.status.split(":")[1]
                if ch in chapter_tasks:
                    progress.update(chapter_tasks[ch],
                        status=f"[yellow]rate-limited – waiting {secs}s[/yellow]")
                return

            if ch not in chapter_tasks:
                tid = progress.add_task(label,
                    total=max(cp.pages_total, 1), completed=0, status="")
                chapter_tasks[ch] = tid
                watchdog.register(ch, tid)

            tid = chapter_tasks[ch]

            if cp.status == "done":
                progress.update(tid, completed=cp.pages_total,
                    status="[green]✓ done[/green]")
                watchdog.unregister(ch)
                if overall_task[0] is not None:
                    progress.advance(overall_task[0], 1)
            elif cp.status == "error":
                progress.update(tid, status="[red]✗ error[/red]")
                watchdog.unregister(ch)
            else:
                progress.update(tid,
                    completed=cp.pages_done,
                    total=max(cp.pages_total, 1),
                    status=f"[dim]{cp.pages_done}/{cp.pages_total}[/dim]")

    with progress:
        watchdog.start()

        # Phase 1: series info  (single lightweight request)
        si_task = progress.add_task("Connecting…", total=None, completed=0, status="")
        si_result, si_error, si_done = _run_in_thread(lambda: parser.get_series_info(url))
        _wait_animated(si_done, progress, si_task, "Fetching series info…")

        if si_error[0]:
            console.print(f"\n[red]Failed to fetch series info:[/red] {si_error[0]}")
            watchdog.stop(); sys.exit(1)

        series_info = si_result[0]
        progress.update(si_task,
            description=f"[bold]{series_info.title}[/bold] by {series_info.author}",
            total=1, completed=1, status="")

        max_ch = config.get("max_concurrent_chapters", 3)
        console.print(
            f"\n  [cyan]◈[/cyan] [bold]{series_info.title}[/bold]  "
            f"[dim]{series_info.author}[/dim]\n"
            f"  [dim]fetching chapters & downloading  ·  {max_ch} concurrent  ·  "
            f"saving to {config.download_dir}[/dim]\n"
        )

        # Phase 2 + 3: fetch chapter list and download are now pipelined inside
        # download_series() — it starts downloading the first chapters while later
        # pages of the chapter list are still being fetched in the background.
        # The on_progress callback handles chapter_found / fetch_done events to
        # keep the progress display live.
        ch_task[0] = progress.add_task(
            "Fetching chapters…  (connecting)", total=None, completed=0, status="")

        try:
            series_dir = download_series(
                parser=parser, url=url,
                chapter_range=chapter_range,
                specific_chapters=specific_chapters,
                json_progress=False,
                progress_cb=on_progress,
            )
        except RuntimeError as e:
            console.print(f"\n[red bold]✗ {e}[/red bold]")
            watchdog.stop(); sys.exit(1)
        except Exception as e:
            console.print(f"\n[red]Download failed:[/red] {e}")
            watchdog.stop(); sys.exit(1)

        watchdog.stop()

    console.print(f"\n[bold green]✓ Done![/bold green]  {series_dir}\n")


# ────────────────────────────────────────────────────────────────────
#  list
# ────────────────────────────────────────────────────────────────────

@cli.command(name="list")
@click.argument("url")
def list_chapters(url: str):
    """List all available chapters for a webtoon URL."""
    try:
        parser = get_parser(url)
    except ValueError as e:
        console.print(f"[red]{e}[/red]"); sys.exit(1)

    with console.status("Fetching series info…"):
        info = parser.get_series_info(url)
    with console.status("Fetching chapter list…"):
        chapters = parser.get_chapter_list(url)

    console.print(Panel(
        f"[bold]{info.title}[/bold]\n"
        f"[dim]Author:[/dim] {info.author}\n"
        f"[dim]Status:[/dim] {info.status or 'unknown'}\n"
        f"[dim]Genre:[/dim]  {info.genre or '—'}",
        title="Series Info", border_style="cyan",
    ))
    table = Table(box=box.SIMPLE_HEAD, show_edge=False)
    table.add_column("#",    style="cyan", width=6, justify="right")
    table.add_column("Title")
    table.add_column("Date", style="dim",  width=12)
    for ch in chapters:
        table.add_row(format_chapter_number(ch.number), ch.title, ch.date)
    console.print(table)
    console.print(f"\n[dim]Total: {len(chapters)} chapters[/dim]")


# ────────────────────────────────────────────────────────────────────
#  library
# ────────────────────────────────────────────────────────────────────

@cli.command()
def library():
    """Show all locally downloaded series."""
    series_list = scan_library()
    if not series_list:
        console.print(
            f"[yellow]Library is empty.[/yellow]\n"
            f"Download something: [bold]stripdl download <url>[/bold]\n"
            f"Library location:   {config.download_dir}"
        )
        return
    table = Table(title="Local Library", box=box.ROUNDED, show_edge=True)
    table.add_column("Title",    style="bold")
    table.add_column("Author",   style="dim")
    table.add_column("Chapters", justify="right", style="cyan")
    table.add_column("Location", style="dim")
    for s in series_list:
        table.add_row(s.title, s.author or "—", str(s.chapter_count), str(s.directory))
    console.print(table)


# ────────────────────────────────────────────────────────────────────
#  config
# ────────────────────────────────────────────────────────────────────

@cli.command(name="config")
@click.option("--set",   "set_kv",  metavar="KEY=VALUE")
@click.option("--get",   "get_key", metavar="KEY")
@click.option("--reset", is_flag=True)
def config_cmd(set_kv: Optional[str], get_key: Optional[str], reset: bool):
    """View or edit stripdl configuration."""
    if reset:
        import copy
        from strip.config import _DEFAULTS
        config._data = copy.deepcopy(_DEFAULTS)
        config.save()
        console.print("[green]Config reset to defaults.[/green]")
        return
    if set_kv:
        if "=" not in set_kv:
            console.print("[red]Use KEY=VALUE format[/red]"); sys.exit(1)
        k, v = set_kv.split("=", 1)
        for cast in (int, float):
            try: v = cast(v); break
            except ValueError: pass
        if v in ("true",  "True"):  v = True
        if v in ("false", "False"): v = False
        config[k] = v; config.save()
        console.print(f"[green]Set[/green] {k} = {v}")
        return
    if get_key:
        val = config.get(get_key)
        console.print(f"{get_key} = {val}" if val is not None
                      else f"[yellow]Key '{get_key}' not found[/yellow]")
        return
    table = Table(title="stripdl Configuration", box=box.SIMPLE)
    table.add_column("Key",   style="bold cyan")
    table.add_column("Value")
    for k, v in sorted(config.all().items()):
        table.add_row(k, str(v))
    console.print(table)


# ────────────────────────────────────────────────────────────────────
#  Entry point
# ────────────────────────────────────────────────────────────────────

def main():
    cli()

if __name__ == "__main__":
    main()
