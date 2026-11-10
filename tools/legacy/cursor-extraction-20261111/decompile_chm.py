import subprocess, os

chms = ['idman.chm', 'grabber.chm', 'scheduler.chm', 'tutor.chm']
idm_dir = r"C:\Program Files (x86)\Internet Download Manager"
out_base = r"D:\Omnia\repos\omnia\upstream_extractions\downloaders\idm-multistream\docs_chm_unpacked"

os.makedirs(out_base, exist_ok=True)
for c in chms:
    src = os.path.join(idm_dir, c)
    dest = os.path.join(out_base, os.path.splitext(c)[0])
    os.makedirs(dest, exist_ok=True)
    subprocess.run(["hh.exe", "-decompile", dest, src], capture_output=True)

total_files = sum(len(files) for _, _, files in os.walk(out_base))
print(f"Total files in docs_chm_unpacked: {total_files}")
