"""Project configuration loader backed by pyproject.toml."""

from __future__ import annotations

from pathlib import Path
import tomllib
from typing import Any


def load_project_config(pyproject_path: str | Path | None = None) -> dict[str, Any]:
    """Load [tool.quantlib_mini] settings from pyproject.toml using stdlib tomllib."""
    if pyproject_path is None:
        pyproject_path = Path(__file__).resolve().parent.parent / "pyproject.toml"
    else:
        pyproject_path = Path(pyproject_path)

    with pyproject_path.open("rb") as fh:
        data = tomllib.load(fh)

    tool_cfg = data.get("tool", {}).get("quantlib_mini", {})
    if not isinstance(tool_cfg, dict):
        raise ValueError("[tool.quantlib_mini] section must be a TOML table")
    return dict(tool_cfg)
