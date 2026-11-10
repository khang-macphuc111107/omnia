# -*- coding: utf-8 -*-
import glob, os, json

sessions = glob.glob(r"C:\Users\khang\.codex\sessions\**\*.jsonl", recursive=True)
sessions.sort(key=os.path.getmtime, reverse=True)

print(f"Found {len(sessions)} sessions. Inspecting 20 most recent...")
found = []
for s in sessions[:20]:
    try:
        with open(s, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                if not line.strip(): continue
                try:
                    obj = json.loads(line)
                    text = ""
                    if isinstance(obj, dict):
                        if obj.get("role") == "user":
                            c = obj.get("content")
                            if isinstance(c, str): text = c
                            elif isinstance(c, list):
                                for item in c:
                                    if isinstance(item, dict) and item.get("type") == "text":
                                        text += item.get("text", "") + "\n"
                        elif obj.get("type") == "user":
                            msg = obj.get("message", {})
                            c = msg.get("content")
                            if isinstance(c, str): text = c
                            elif isinstance(c, list):
                                for item in c:
                                    if isinstance(item, dict) and item.get("type") == "text":
                                        text += item.get("text", "") + "\n"
                    text = text.strip()
                    if text and len(text) > 15 and not text.startswith("<"):
                        lower = text.lower()
                        if any(k in lower for k in ["idm", "app", "upstream", "omnia", "ui", "cursor"]):
                            found.append((os.path.getmtime(s), text))
                except: pass
    except: pass

found.sort(key=lambda x: x[0], reverse=True)
seen = set()
for t, txt in found[:30]:
    h = txt[:60]
    if h in seen: continue
    seen.add(h)
    print("="*60)
    print(txt[:500])
