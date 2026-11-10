import os
import json
import glob

# Search in C:\Users\khang\.claude and C:\Users\khang\.codex
paths = glob.glob(r"C:\Users\khang\.claude\**\*.json*", recursive=True) + glob.glob(r"C:\Users\khang\.codex\**\*.json*", recursive=True)

print(f"Found {len(paths)} files")
recent = sorted(paths, key=os.path.getmtime, reverse=True)
for p in recent[:20]:
    print(p, os.path.getsize(p))
