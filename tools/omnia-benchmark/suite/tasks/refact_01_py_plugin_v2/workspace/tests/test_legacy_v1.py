"""Legacy v1 test suite for docpipe. MUST remain passing after v2 migration."""

from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from docpipe import Pipeline, PluginBase, default_plugins
from docpipe.cli import main as cli_main
from docpipe.plugins import ChunkPlugin, EnrichPlugin, NormalizePlugin, RedactPlugin


class UppercaseTagV1Plugin(PluginBase):
    """External v1-style custom plugin overriding only sync process()."""

    name = "uppercase_tag_v1"

    def process(self, doc: dict[str, Any]) -> dict[str, Any]:
        doc["text"] = doc["text"].upper()
        doc.setdefault("metadata", {})["v1_touched"] = True
        doc["legacy_marker"] = "kept-v1"
        return doc


class TestLegacyV1(unittest.TestCase):
    def test_default_pipeline_end_to_end(self) -> None:
        raw = {
            "id": "doc-100",
            "text": "  Hello   world\r\n\r\n\r\nEmail: bob@example.org SSN: 111-22-3333 Card: 4111 2222 3333 4444  ",
            "metadata": {"title": "Legacy V1: Pipeline Test!"},
            "source_system": "ingest-alpha",
        }
        original_snapshot = json.dumps(raw, sort_keys=True)

        result = Pipeline(default_plugins()).run(raw)

        # Caller input must not be mutated
        self.assertEqual(json.dumps(raw, sort_keys=True), original_snapshot)

        expected_text = (
            "Hello world\n\n"
            "Email: [REDACTED_EMAIL] SSN: [REDACTED_SSN] Card: [REDACTED_CARD]"
        )
        self.assertEqual(result["id"], "doc-100")
        self.assertEqual(result["text"], expected_text)
        self.assertEqual(result["source_system"], "ingest-alpha")

        meta = result["metadata"]
        self.assertTrue(meta["normalized"])
        self.assertEqual(meta["title_slug"], "legacy-v1-pipeline-test")
        self.assertEqual(meta["redactions"], {"email": 1, "ssn": 1, "card": 1})
        self.assertEqual(meta["redaction_count"], 3)
        self.assertEqual(meta["chunk_count"], 1)
        self.assertEqual(result["chunks"], [" ".join(expected_text.split())])
        self.assertEqual(meta["word_count"], len(expected_text.split()))
        self.assertEqual(meta["char_count"], len(expected_text))
        self.assertEqual(
            meta["content_sha256"],
            hashlib.sha256(expected_text.encode("utf-8")).hexdigest(),
        )
        self.assertGreater(meta["reading_time_sec"], 0.0)

    def test_individual_builtin_plugins_v1_process(self) -> None:
        doc = {
            "id": "d2",
            "text": "one two three four five six seven",
            "metadata": {"title": "Seven Words"},
        }
        doc = NormalizePlugin().process(doc)
        self.assertEqual(doc["metadata"]["title_slug"], "seven-words")

        doc = ChunkPlugin(chunk_size=4, overlap=1).process(doc)
        self.assertEqual(
            doc["chunks"],
            ["one two three four", "four five six seven"],
        )
        self.assertEqual(doc["metadata"]["chunk_count"], 2)

        doc = EnrichPlugin(words_per_minute=140).process(doc)
        self.assertEqual(doc["metadata"]["word_count"], 7)
        self.assertEqual(doc["metadata"]["reading_time_sec"], 3.0)

    def test_custom_v1_subclass_in_pipeline(self) -> None:
        pipeline = Pipeline([
            NormalizePlugin(),
            RedactPlugin(),
            UppercaseTagV1Plugin(),
        ])
        doc = {
            "id": "d3",
            "text": "  reach me at jane@test.io  ",
            "metadata": {},
        }
        out = pipeline.run(doc)
        self.assertEqual(out["text"], "REACH ME AT [REDACTED_EMAIL]")
        self.assertTrue(out["metadata"]["v1_touched"])
        self.assertEqual(out["legacy_marker"], "kept-v1")

    def test_cli_v1_output(self) -> None:
        sample = {
            "id": "cli-1",
            "text": "Contact dev@example.com\r\nnow.",
            "metadata": {"title": "CLI Check"},
        }
        with tempfile.TemporaryDirectory() as tmp:
            in_path = Path(tmp) / "in.json"
            out_path = Path(tmp) / "out.json"
            in_path.write_text(json.dumps(sample), encoding="utf-8")

            rc = cli_main(["--input", str(in_path), "--output", str(out_path)])
            self.assertEqual(rc, 0)

            out = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertEqual(out["id"], "cli-1")
            self.assertEqual(out["text"], "Contact [REDACTED_EMAIL]\nnow.")
            self.assertEqual(out["metadata"]["title_slug"], "cli-check")
            self.assertEqual(out["metadata"]["redaction_count"], 1)


if __name__ == "__main__":
    unittest.main()
