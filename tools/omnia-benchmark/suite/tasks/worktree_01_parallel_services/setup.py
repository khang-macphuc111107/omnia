import argparse, subprocess
from pathlib import Path

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    for cmd in [
        ["git", "init", "-b", "main"],
        ["git", "config", "user.name", "Bench Setup"],
        ["git", "config", "user.email", "bench@example.test"],
        ["git", "add", "-A"],
        ["git", "commit", "-m", "initial broken services"],
    ]:
        subprocess.run(cmd, cwd=str(ws), check=True, capture_output=True)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
