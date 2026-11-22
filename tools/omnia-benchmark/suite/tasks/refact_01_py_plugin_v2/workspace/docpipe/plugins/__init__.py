"""Built-in plugins for docpipe."""

from docpipe.plugins.chunk import ChunkPlugin
from docpipe.plugins.enrich import EnrichPlugin
from docpipe.plugins.normalize import NormalizePlugin
from docpipe.plugins.redact import RedactPlugin

__all__ = [
    "NormalizePlugin",
    "RedactPlugin",
    "ChunkPlugin",
    "EnrichPlugin",
]
