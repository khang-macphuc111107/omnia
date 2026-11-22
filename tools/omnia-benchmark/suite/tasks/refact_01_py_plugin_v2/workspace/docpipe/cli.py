"""Command-line interface for docpipe."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from docpipe.pipeline import Pipeline, default_plugins


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="docpipe",
        description="Process a JSON document through the default docpipe pipeline.",
    )
    parser.add_argument(
        "--input",
        required=True,
        help="Path to the input JSON document file.",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Optional output JSON path (defaults to stdout).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    parser = build_parser()
    args = parser.parse_args(argv)

    input_path = Path(args.input)
    raw = json.loads(input_path.read_text(encoding="utf-8"))

    pipeline = Pipeline(default_plugins())
    result = pipeline.run(raw)
    serialized = json.dumps(result, indent=2, ensure_ascii=False)

    if args.output:
        Path(args.output).write_text(serialized + "\n", encoding="utf-8")
    else:
        print(serialized)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
