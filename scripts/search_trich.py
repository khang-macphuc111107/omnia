
import glob
import json

files = glob.glob(r"C:\Users\khang\.claude\projects\D--Omnia\*.jsonl")
for f in files:
    with open(f, "r", encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            try:
                obj = json.loads(line)
                s = json.dumps(obj, ensure_ascii=False)
                # Find prompts with "tr�ch" or "app"
                if "tr�ch" in s:
                    # find role user
                    if "user" in s:
                        print("File:", f)
                        # Extract the text
                        for k, v in obj.items():
                            if isinstance(v, dict):
                                for k2, v2 in v.items():
                                    if "tr�ch" in str(v2):
                                        print(f"[{k}.{k2}]:", str(v2)[:400])
                            elif "tr�ch" in str(v):
                                print(f"[{k}]:", str(v)[:400])
                        print("="*40)
            except Exception:
                pass
