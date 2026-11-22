"""Text normalization and title slug generation plugin."""

from __future__ import annotations

import re
from typing import Any

from docpipe.base import PluginBase

_INLINE_WS_RE = re.compile(r"[ \t]+")
_MULTI_NEWLINE_RE = re.compile(r"\n{3,}")
_SLUG_NON_ALNUM_RE = re.compile(r"[^A-Za-z0-9]+")


class NormalizePlugin(PluginBase):
    """Normalizes line endings, whitespace, and computes metadata title slug."""

    name = "normalize"

    def __init__(
        self,
        lowercase_slug: bool = True,
        collapse_whitespace: bool = True,
    ) -> None:
        self.lowercase_slug = lowercase_slug
        self.collapse_whitespace = collapse_whitespace

    def _normalize_text(self, text: str, collapse_whitespace: bool) -> str:
        normalized = text.replace("\r\n", "\n").replace("\r", "\n")
        lines: list[str] = []
        for line in normalized.split("\n"):
            cleaned = line.strip()
            if collapse_whitespace:
                cleaned = _INLINE_WS_RE.sub(" ", cleaned)
            lines.append(cleaned)
        joined = "\n".join(lines)
        joined = _MULTI_NEWLINE_RE.sub("\n\n", joined)
        return joined.strip()

    def _slugify(self, title: str, lowercase_slug: bool) -> str:
        base = title.lower() if lowercase_slug else title
        return _SLUG_NON_ALNUM_RE.sub("-", base).strip("-")

    def process(self, doc: dict[str, Any]) -> dict[str, Any]:
        text = str(doc.get("text", ""))
        doc["text"] = self._normalize_text(text, self.collapse_whitespace)

        metadata = doc.setdefault("metadata", {})
        title = metadata.get("title")
        if isinstance(title, str) and title.strip():
            metadata["title_slug"] = self._slugify(title, self.lowercase_slug)
        metadata["normalized"] = True
        return doc
