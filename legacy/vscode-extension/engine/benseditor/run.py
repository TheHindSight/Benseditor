"""Entry point: ``python -m benseditor.run <project-folder>``."""

from __future__ import annotations

import argparse
import sys
import traceback
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="benseditor", description="Run a Benseditor game project."
    )
    parser.add_argument(
        "project",
        nargs="?",
        default=".",
        help="Folder containing benseditor.json (defaults to the current directory)",
    )
    parser.add_argument(
        "--steps",
        type=int,
        default=None,
        help="Exit after this many game steps. Used to smoke-test a project.",
    )
    parser.add_argument(
        "--screenshot",
        default=None,
        help="Save the final frame to this PNG path before exiting.",
    )
    args = parser.parse_args(argv)

    project_dir = Path(args.project).resolve()

    try:
        from .app import run
    except ImportError as exc:
        print(
            f"Benseditor could not import its dependencies: {exc}\n"
            "Run 'Benseditor: Install / Update Python Engine' from the command "
            "palette, or install them manually:\n"
            "    pip install moderngl pyglet pillow numpy",
            file=sys.stderr,
        )
        return 2

    try:
        run(project_dir, max_steps=args.steps, screenshot=args.screenshot)
    except Exception:
        traceback.print_exc()
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
