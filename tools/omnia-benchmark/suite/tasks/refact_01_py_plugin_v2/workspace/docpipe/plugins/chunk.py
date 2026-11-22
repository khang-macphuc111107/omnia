"""Overlapping word-based chunking plugin."""

from __future__ import annotations

from typing import Any

from docpipe.base import PluginBase


class ChunkPlugin(PluginBase):
    """Splits document text into overlapping word chunks."""

    name = "chunk"

    def __init__(self, chunk_size: int = 50, overlap: int = 10) -> None:
        if chunk_size <= 0:
            raise ValueError("chunk_size must be positive")
        if overlap < 0 or overlap >= chunk_size:
            raise ValueError("overlap must satisfy 0 <= overlap < chunk_size")
        self.chunk_size = chunk_size
        self.overlap = overlap

    @staticmethod
    def _build_chunks(text: str, chunk_size: int, overlap: int) -> list[str]:
        words = text.split()
        if not words:
            return []
        chunks: list[str] = []
        step = chunk_size - overlap
        start = 0
        while start < len(words):
            end = start + chunk_size
            chunks.append(" ".join(words[start:end]))
            if end >= len(words):
                break
            start += step
        return chunks

    def process(self, doc: dict[str, Any]) -> dict[str, Any]:
        text = str(doc.get("text", ""))
        chunks = self._build_chunks(text, self.chunk_size, self.overlap)
        doc["chunks"] = chunks

        metadata = doc.setdefault("metadata", {})
        metadata["chunk_count"] = len(chunks)
        metadata["chunk_size"] = self.chunk_size
        metadata["chunk_overlap"] = self.overlap
        return doc
