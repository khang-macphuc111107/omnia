
import json

path = r"C:\Users\khang\.claude\projects\D--Omnia\7f8116e5-5aa3-4cbc-b021-0c4cf3a7a5ba.jsonl"
with open(path, "r", encoding="utf-8", errors="ignore") as f:
    for line in f:
        try:
            obj = json.loads(line)
            if obj.get("payload", {}).get("type") == "user":
                msg = obj["payload"].get("message", {}).get("content", "")
                print("=== USER MSG ===")
                print(msg)
        except Exception:
            pass
