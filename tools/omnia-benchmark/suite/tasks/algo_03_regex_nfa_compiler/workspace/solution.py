"""ReDoS-Immune Linear-Time Thompson NFA / PikeVM Regex Engine."""

from __future__ import annotations

from dataclasses import dataclass


class RegexSyntaxError(ValueError):
    """Raised when a regular expression pattern is syntactically invalid."""


@dataclass(frozen=True)
class MatchResult:
    """Result of a successful regular expression match."""

    span: tuple[int, int]
    _full: str
    _groups: tuple[str | None, ...]

    def group(self, i: int = 0) -> str | None:
        """Return group 0 (full match) or capturing group 1..K (None if unmatched)."""
        raise NotImplementedError("Implement MatchResult.group")

    def groups(self) -> tuple[str | None, ...]:
        """Return tuple of all capturing groups (1..K)."""
        raise NotImplementedError("Implement MatchResult.groups")


class CompiledPattern:
    """Compiled Thompson NFA / PikeVM regular expression pattern."""

    def fullmatch(self, text: str) -> MatchResult | None:
        """Match the pattern against the entire text."""
        raise NotImplementedError("Implement CompiledPattern.fullmatch")

    def match(self, text: str) -> MatchResult | None:
        """Match the pattern starting at index 0 of text."""
        raise NotImplementedError("Implement CompiledPattern.match")

    def search(self, text: str) -> MatchResult | None:
        """Find the earliest match of the pattern anywhere in text."""
        raise NotImplementedError("Implement CompiledPattern.search")

    def findall(self, text: str) -> list[str]:
        """Return all non-overlapping full matched substrings in text."""
        raise NotImplementedError("Implement CompiledPattern.findall")


def compile_pattern(pattern: str) -> CompiledPattern:
    """Parse and compile pattern into a linear-time CompiledPattern.

    Raises:
        RegexSyntaxError: If pattern contains invalid regex syntax.
    """
    raise NotImplementedError("Implement compile_pattern")
