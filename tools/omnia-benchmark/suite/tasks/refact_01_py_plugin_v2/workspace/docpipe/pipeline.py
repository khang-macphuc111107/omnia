"""Sequential document-processing pipeline (v1)."""

from __future__ import annotations

import copy
from collections.abc import Sequence
from typing import Any

from docpipe.base import PluginBase
from docpipe.plugins import ChunkPlugin, EnrichPlugin, NormalizePlugin, RedactPlugin


def default_plugins() -> list[PluginBase]:
    """Return the standard four-stage document-processing plugin chain."""
    return [
        NormalizePlugin(),
        RedactPlugin(),
        ChunkPlugin(),
        EnrichPlugin(),
    ]


class Pipeline:
    """Runs a sequence of plugins over a document."""

    def __init__(self, plugins: Sequence[PluginBase]) -> None:
        self.plugins: list[PluginBase] = list(plugins)

    def run(self, doc: dict[str, Any]) -> dict[str, Any]:
        """Run all plugins sequentially on a deep copy of ``doc``."""
        current = copy.deepcopy(doc)
        current.setdefault("metadata", {})
        current.setdefault("chunks", [])
        for plugin in self.plugins:
            current = plugin.process(current)
        return current
