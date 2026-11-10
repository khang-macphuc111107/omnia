
import os
import subprocess
import shutil

src = r"C:\Users\khang\Documents\ChatGPT\Google Drive Downloader"
dst = r"D:\Omnia\repos\omnia\upstream_extractions\downloaders\gdrive-downloader"

os.makedirs(dst, exist_ok=True)

# Use robocopy on Windows for high performance and full preservation
# Exclude node_modules during copy (we will npm install or symlink) to avoid lock contention
# Exclude browser cache directories in profile if locked
cmd = [
    "robocopy",
    src,
    dst,
    "/E",
    "/XD", "node_modules", "Default\\Cache", "Default\\Code Cache",
    "/R:2",
    "/W:1",
    "/NP"
]

print("Executing robocopy for Google Drive Downloader...")
res = subprocess.run(cmd, capture_output=True, text=True)
print("Robocopy return code:", res.returncode) # 0-7 is success for robocopy

# Count files
src_files = sum(len(files) for _, _, files in os.walk(src))
dst_files = sum(len(files) for _, _, files in os.walk(dst))
print(f"Source files total: {src_files}, Destination files total: {dst_files}")
