"""PII redaction plugin for emails, SSNs, and payment card numbers."""

from __future__ import annotations

import re
from typing import Any

from docpipe.base import PluginBase

_EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
_SSN_RE = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
_CARD_RE = re.compile(r"\b(?:\d{4}[-\s]){3}\d{4}\b")


class RedactPlugin(PluginBase):
    """Redacts sensitive tokens from document text and records redaction counts."""

    name = "redact"

    def __init__(
        self,
        replacement_email: str = "[REDACTED_EMAIL]",
        replacement_ssn: str = "[REDACTED_SSN]",
        replacement_card: str = "[REDACTED_CARD]",
    ) -> None:
        self.replacement_email = replacement_email
        self.replacement_ssn = replacement_ssn
        self.replacement_card = replacement_card

    def process(self, doc: dict[str, Any]) -> dict[str, Any]:
        text = str(doc.get("text", ""))
        text, n_email = _EMAIL_RE.subn(self.replacement_email, text)
        text, n_ssn = _SSN_RE.subn(self.replacement_ssn, text)
        text, n_card = _CARD_RE.subn(self.replacement_card, text)

        doc["text"] = text
        metadata = doc.setdefault("metadata", {})
        metadata["redactions"] = {
            "email": n_email,
            "ssn": n_ssn,
            "card": n_card,
        }
        metadata["redaction_count"] = n_email + n_ssn + n_card
        return doc
