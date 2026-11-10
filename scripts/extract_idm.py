import os
import sys
import zipfile
import shutil
import json

idm_dir = r"C:\Program Files (x86)\Internet Download Manager"
out_dir = r"D:\Omnia\repos\omnia\upstream_extractions\downloaders\idm-multistream\idm_original_extracted"

os.makedirs(out_dir, exist_ok=True)

for fn in ["IDMMsgHost.json", "IDMMsgHostMoz.json", "defexclist.txt", "tips.txt", "license.txt", "Brotli-license.txt", "openssl-license.txt"]:
    src = os.path.join(idm_dir, fn)
    if os.path.exists(src):
        shutil.copy2(src, os.path.join(out_dir, fn))
        print(f"Copied {fn}")

xpi_path = os.path.join(idm_dir, "idmmzcc3.xpi")
if os.path.exists(xpi_path):
    fx_dir = os.path.join(out_dir, "firefox_extension_xpi")
    os.makedirs(fx_dir, exist_ok=True)
    with zipfile.ZipFile(xpi_path, 'r') as zf:
        zf.extractall(fx_dir)
    print(f"Extracted Firefox XPI: {len(os.listdir(fx_dir))} items")

for crx_name, folder_name in [("IDMGCExt.crx", "chrome_extension_crx"), ("IDMEdgeExt.crx", "edge_extension_crx")]:
    crx_path = os.path.join(idm_dir, crx_name)
    if os.path.exists(crx_path):
        target_dir = os.path.join(out_dir, folder_name)
        os.makedirs(target_dir, exist_ok=True)
        with open(crx_path, 'rb') as f:
            data = f.read()
        pk_idx = data.find(b'PK\x03\x04')
        if pk_idx != -1:
            zip_data = data[pk_idx:]
            tmp_zip = os.path.join(out_dir, f"temp_{crx_name}.zip")
            with open(tmp_zip, 'wb') as f:
                f.write(zip_data)
            try:
                with zipfile.ZipFile(tmp_zip, 'r') as zf:
                    zf.extractall(target_dir)
                print(f"Extracted {crx_name}: {len(os.listdir(target_dir))} items")
            except Exception as e:
                print(f"Failed extracting {crx_name}: {e}")
            finally:
                if os.path.exists(tmp_zip):
                    os.remove(tmp_zip)

idman_path = os.path.join(idm_dir, "IDMan.exe")
if os.path.exists(idman_path):
    file_size = os.path.getsize(idman_path)
    info = {
        "file_path": idman_path,
        "file_size_bytes": file_size,
        "file_size_mb": round(file_size / (1024 * 1024), 2),
        "target_architecture": "x86 (32-bit PE GUI executable)",
        "framework": "Win32 / Microsoft Foundation Classes (MFC)",
        "companion_binaries": [
            "idmBroker.exe",
            "IDMMsgHost.exe",
            "IDMGrHlp.exe",
            "IEMonitor.exe",
            "MediumILStart.exe"
        ],
        "native_drivers": [
            "idmwfp64.sys",
            "idmwfp32.sys",
            "idmtdi64.sys",
            "idmtdi32.sys"
        ]
    }
    with open(os.path.join(out_dir, "IDMAN_PE_METADATA.json"), "w", encoding="utf-8") as f:
        json.dump(info, f, indent=2)
    print("Wrote IDMAN_PE_METADATA.json")

print("IDM asset extraction complete!")
