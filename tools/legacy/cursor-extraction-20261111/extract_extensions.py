
import os, zipfile, io

idm_dir = r"C:\Program Files (x86)\Internet Download Manager"
out_dir = r"D:\Omnia\repos\omnia\upstream_extractions\downloaders\idm-multistream\unpacked_browser_extensions"
os.makedirs(out_dir, exist_ok=True)

extensions = [
    'IDMEdgeExt.crx', 'IDMGCExt.crx', 'IDMGCExt59.crx',
    'idmmzcc.xpi', 'idmmzcc2.xpi', 'idmmzcc3.xpi', 'IDMOpExt.nex'
]

for ext in extensions:
    p = os.path.join(idm_dir, ext)
    if not os.path.exists(p):
        continue
    dest = os.path.join(out_dir, os.path.splitext(ext)[0])
    os.makedirs(dest, exist_ok=True)
    with open(p, 'rb') as f:
        data = f.read()
    # Find PK header
    pk_idx = data.find(b'PK\x03\x04')
    if pk_idx != -1:
        zip_data = data[pk_idx:]
        try:
            with zipfile.ZipFile(io.BytesIO(zip_data)) as zf:
                zf.extractall(dest)
                print(f"Extracted {ext} -> {len(zf.namelist())} files")
        except Exception as e:
            print(f"Error extracting {ext}: {e}")
    else:
        print(f"No ZIP header found in {ext}")

total_files = sum(len(files) for _, _, files in os.walk(out_dir))
print(f"Total files in unpacked_browser_extensions: {total_files}")

