"""Base plugin abstractions for docpipe (v1 synchronous API)."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class PluginBase(ABC):
    """Base class for v1 synchronous document-processing plugins."""

    name: str = "unnamed"

    @abstractmethod
    def process(self, doc: dict[str, Any]) -> dict[str, Any]:
        """Transform a document dict and return the updated document dict."""
        raise NotImplementedError
