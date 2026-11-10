import json
import glob
import os

files = glob.glob(r"D:\Omnia\.agents\checkpoints\claude-command-stream-*.jsonl")
files.sort()

user_texts = []
for f in files:
    with open(f, "r", encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            if not line.strip():
                continue
            try:
                data = json.loads(line)
                # Check for message payload
                msg = ""
                if isinstance(data, dict):
                    # Check text or message
                    text = data.get("text") or data.get("content") or data.get("prompt")
                    if text and isinstance(text, str):
                        # Filter for user messages
                        if any(k in text.lower() for k in ["tr�ch", "app", "gemini", "gdrive", "repo", "y�u c�u", "source"]):
                            user_texts.append(text)
            except Exception:
                pass

print(f"Total matching texts: {len(user_texts)}")
for t in user_texts[-25:]:
    print("========================================")
    print(t[:500])
