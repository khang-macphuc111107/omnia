import os
import glob
import json

sessions = glob.glob(r"C:\Users\khang\.codex\sessions\**\*.jsonl", recursive=True)
sessions += glob.glob(r"C:\Users\khang\.claude\**\*.jsonl", recursive=True)

matches = []

keywords = ["tr�ch", "app", "�ng d�ng", "upstream", "source code", "m�i app", "danh s�ch", "nh�ng app", "t�t c� app"]

for s in sessions:
    try:
        with open(s, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    obj = json.loads(line)
                    text = ""
                    # Check Codex rollout format
                    if isinstance(obj, dict):
                        # Codex session event
                        if obj.get("type") == "event" and obj.get("event") == "user_message":
                            text = obj.get("data", {}).get("text", "")
                        elif obj.get("role") == "user":
                            c = obj.get("content")
                            if isinstance(c, str):
                                text = c
                            elif isinstance(c, list):
                                for item in c:
                                    if isinstance(item, dict) and item.get("type") == "text":
                                        text += item.get("text", "") + "\n"
                        elif obj.get("type") == "user":
                            msg = obj.get("message", {})
                            if isinstance(msg, dict):
                                c = msg.get("content")
                                if isinstance(c, str):
                                    text = c
                                elif isinstance(c, list):
                                    for item in c:
                                        if isinstance(item, dict) and item.get("type") == "text":
                                            text += item.get("text", "") + "\n"
                        elif "payload" in obj and isinstance(obj["payload"], dict):
                            p = obj["payload"]
                            if p.get("type") == "user":
                                msg = p.get("message", {})
                                if isinstance(msg, dict):
                                    c = msg.get("content")
                                    if isinstance(c, str):
                                        text = c

                    text = text.strip()
                    if text and not text.startswith("<environment_context>") and not text.startswith("<codex_internal_context>") and not text.startswith("<system-reminder>"):
                        lower = text.lower()
                        # check if it mentions multiple apps or extracting apps
                        if any(k in lower for k in ["tr�ch", "upstream", "nh�ng app", "c�c app", "app n�o"]):
                            matches.append((os.path.getmtime(s), s, text))
                except Exception:
                    pass
    except Exception:
        pass

matches.sort(key=lambda x: x[0])

# Deduplicate
seen = set()
unique = []
for mtime, path, text in matches:
    k = text[:80]
    if k not in seen:
        seen.add(k)
        unique.append((path, text))

print(f"Total matching user messages: {len(unique)}")
for idx, (path, text) in enumerate(unique[-30:]):
    print(f"\n--- MATCH #{idx+1} (from {os.path.basename(path)}) ---")
    print(text[:800])
