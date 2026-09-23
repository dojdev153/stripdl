#!/usr/bin/env python3
"""
build_cli.py — Build the stripdl CLI into a single executable using PyInstaller.

Usage:
    pip install pyinstaller          # dev dependency, not in requirements.txt
    python build_cli.py              # produces dist/stripdl (or dist/stripdl.exe on Windows)

The resulting executable is self-contained (no Python installation needed)
and is copied to electron-app/resources/strip-cli/ for Electron packaging.
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT       = Path(__file__).parent
DIST       = ROOT / "dist"
BUILD      = ROOT / "build"
RESOURCES  = ROOT / "desktop" / "resources" / "strip-cli"
ENTRY      = ROOT / "core" / "strip" / "cli.py"
EXE_NAME   = "stripdl"


def run(*cmd):
    print(f"$ {' '.join(str(c) for c in cmd)}")
    result = subprocess.run([str(c) for c in cmd], check=True)
    return result


def main():
    # 1. Clean previous build artefacts
    shutil.rmtree(DIST,  ignore_errors=True)
    shutil.rmtree(BUILD, ignore_errors=True)

    # 2. Run PyInstaller
    run(
        sys.executable, "-m", "PyInstaller",
        "--onefile",
        "--name", EXE_NAME,
        "--distpath", str(DIST),
        "--workpath", str(BUILD),
        "--specpath", str(BUILD),
        # Hidden imports that PyInstaller may miss
        "--hidden-import", "strip.parsers.webtoons",
        "--hidden-import", "PIL._tkinter_finder",
        "--hidden-import", "lxml.etree",
        "--hidden-import", "lxml._elementpath",
        str(ENTRY),
    )

    # 3. Copy to Electron resources directory
    RESOURCES.mkdir(parents=True, exist_ok=True)
    exe_name  = EXE_NAME + (".exe" if sys.platform == "win32" else "")
    src       = DIST / exe_name
    dst       = RESOURCES / exe_name

    if src.exists():
        shutil.copy2(src, dst)
        os.chmod(dst, 0o755)
        print(f"\n✓ Executable copied to: {dst}")
    else:
        print(f"\n✗ Build failed — {src} not found", file=sys.stderr)
        sys.exit(1)

    print(f"\n✓ Build complete: {DIST / exe_name}")
    print(f"  Run: {dst}")


if __name__ == "__main__":
    main()
