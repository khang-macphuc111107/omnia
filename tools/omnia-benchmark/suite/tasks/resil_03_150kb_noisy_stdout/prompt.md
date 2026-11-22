# Task: Debug Buried Failure in High-Volume Diagnostic Test Suite

Run `python run_noisy_tests.py` to execute the packet-window test runner.
It produces ~150 KB of verbose packet trace output with the real failing check buried near the bottom.
Locate the exact bug in `telemetry/window.py` and fix it so `python run_noisy_tests.py` exits `0` (and all hidden boundary checks pass) without editing `run_noisy_tests.py`.
