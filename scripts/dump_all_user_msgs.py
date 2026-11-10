
import os
import glob
import json

sessions = glob.glob(r"C:\Users\khang\.codex\sessions\**\*.jsonl", recursive=True)
sessions += glob.glob(r"C:\Users\khang\.claude\**\*.jsonl", recursive=True)

user_msgs = []

for s in sessions:
    try:
        with open(s, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    obj = json.loads(line)
                    # Check Codex rollout format
                    # Codex rollouts usually have:
                    # {"type": "user", "message": ...} or {"role": "user", "content": ...}
                    # or in items
                    text = ""
                    if isinstance(obj, dict):
                        if obj.get("role") == "user":
                            text = str(obj.get("content", ""))
                        elif obj.get("type") == "user":
                            text = str(obj.get("message", {}).get("content", ""))
                        elif "payload" in obj:
                            p = obj["payload"]
                            if isinstance(p, dict) and p.get("type") == "user":
                                text = str(p.get("message", {}).get("content", ""))
                    if text and len(text.strip()) > 10:
                        # Filter out system context blocks if text starts with <
                        if not text.strip().startswith("<environment_context>") and not text.strip().startswith("<codex_internal_context>"):
                            user_msgs.append((os.path.getmtime(s), text.strip()))
                except Exception:
                    pass
    except Exception:
        pass

user_msgs.sort(key=lambda x: x[0])

# Deduplicate
seen = set()
unique_msgs = []
for mtime, m in user_msgs:
    # First 100 chars as key
    k = m[:100]
    if k not in seen:
        seen.add(k)
        unique_msgs.append(m)

print(f"Total unique user messages found: {len(unique_msgs)}")
for idx, m in enumerate(unique_msgs[-35:]):
    print(f"=== MSG #{idx+1} ===")
    print(m[:600])
