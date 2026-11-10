
import json

path = r"C:\Users\khang\.claude\projects\D--Omnia\7f8116e5-5aa3-4cbc-b021-0c4cf3a7a5ba.jsonl"
with open(path, "r", encoding="utf-8", errors="ignore") as f:
    for line in f:
        try:
            obj = json.loads(line)
            # Find any string containing Vietnamese or user prompt
            s = json.dumps(obj, ensure_ascii=False)
            if "b�n" in s or "tr�ch" in s:
                # print what type/keys
                print(obj.get("type"), obj.get("direction"), list(obj.keys()))
                if "payload" in obj:
                    p = obj["payload"]
                    if isinstance(p, dict):
                        print("  p keys:", list(p.keys()))
                        if "message" in p:
                            print("  message content:", str(p["message"])[:300])
        except Exception:
            pass
