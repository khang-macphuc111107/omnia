import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import validate_suite


class ValidatorTests(unittest.TestCase):
    def test_broken_verifier_cannot_replace_last_valid_manifest(self):
        for script in (
            'raise RuntimeError("broken verifier")',
            'print(\'{"passed": false, "checks": [], "error": "worker timeout"}\'); raise SystemExit(1)',
            'print(\'{"passed": false, "checks": []}\'); raise SystemExit(1)',
        ):
            with self.subTest(script=script), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                task = root / "fixture"
                task.mkdir()
                (task / "prompt.md").write_text("Fix the fixture and verify the resulting workspace locally.")
                (task / "verify.py").write_text(script)
                manifest = root / "suite" / "manifest.json"
                manifest.parent.mkdir()
                previous = json.dumps({"total_tasks": 1, "tasks": ["known-good"]})
                manifest.write_text(previous)
                with patch.object(validate_suite, "BENCH_ROOT", root), patch.object(
                    validate_suite, "discover_tasks", return_value=[{"id": "fixture", "axis": 2, "_dir": task}]
                ), contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(validate_suite.main(), 1)
                self.assertEqual(manifest.read_text(), previous)
