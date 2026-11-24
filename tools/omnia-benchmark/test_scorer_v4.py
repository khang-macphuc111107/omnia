import unittest

from scorer_v4 import summarize_harness


def attempt(passed, **wire):
    return dict(model="fixed", task_id="task", axis=1, passed=passed, wire=wire)


class UsageTests(unittest.TestCase):
    def test_failed_attempt_spend_is_not_discarded(self):
        records = [attempt(True, wire_total_tokens=100, wire_effective_cost_units=15),
                   attempt(False, wire_total_tokens=50, wire_effective_cost_units=9)]
        summary = summarize_harness("omnia", records, {})
        self.assertEqual(summary["tokens_per_solved"], 150)
        self.assertEqual(summary["cost_units_per_solved"], 24)

    def test_missing_cost_does_not_invalidate_measured_zero_tokens(self):
        for incomplete in ({}, {"wire_effective_cost_units": None}):
            with self.subTest(incomplete=incomplete):
                records = [attempt(True, wire_total_tokens=0, wire_effective_cost_units=0),
                           attempt(False, wire_total_tokens=0, **incomplete)]
                summary = summarize_harness("omnia", records, {})
                self.assertEqual(summary["tokens_per_solved"], 0)
                self.assertIsNone(summary["cost_units_per_solved"])

    def test_uninstrumented_launch_failure_does_not_make_cohort_cheaper(self):
        failed = attempt(False)
        del failed["wire"]
        summary = summarize_harness("omnia", [attempt(True, wire_total_tokens=12, wire_effective_cost_units=3), failed], {})
        self.assertIsNone(summary["tokens_per_solved"])
        self.assertIsNone(summary["cost_units_per_solved"])
