"""docpipe — lightweight document-processing pipeline SDK (v1)."""

from docpipe.base import PluginBase
from docpipe.pipeline import Pipeline, default_plugins

__all__ = [
    "PluginBase",
    "Pipeline",
    "default_plugins",
]
