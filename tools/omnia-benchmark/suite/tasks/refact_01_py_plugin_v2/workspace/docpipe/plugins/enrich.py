"""Document statistics and content-hash enrichment plugin."""

from __future__ import annotations

import hashlib
from typing import Any

from docpipe.base import PluginBase


class EnrichPlugin(PluginBase):
    """Computes word/char counts, SHA-256 content hash, and reading time."""

    name = "enrich"

    def __init__(self, words_per_minute: int = 200) -> None:
        if words_per_minute <= 0:
            raise ValueError("words_per_minute must be positive")
        self.words_per_minute = words_per_minute

    def process(self, doc: dict[str, Any]) -> dict[str, Any]:
        text = str(doc.get("text", ""))
        words = text.split()
        word_count = len(words)
        char_count = len(text)
        content_sha256 = hashlib.sha256(text.encode("utf-8")).hexdigest()
        reading_time_sec = (
            round((word_count / self.words_per_minute) * 60.0, 2)
            if word_count > 0
            else 0.0
        )

        metadata = doc.setdefault("metadata", {})
        metadata["word_count"] = word_count
        metadata["char_count"] = char_count
        metadata["content_sha256"] = content_sha256
        metadata["reading_time_sec"] = reading_time_sec
        return doc
