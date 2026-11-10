
import os, json

lang_dir = r"C:\Program Files (x86)\Internet Download Manager\Languages"
out_dir = r"D:\Omnia\repos\omnia\upstream_extractions\downloaders\idm-multistream\unpacked_languages_json"
os.makedirs(out_dir, exist_ok=True)

def parse_lng_file(path):
    encodings = ['utf-8', 'cp1252', 'cp1251', 'cp1250', 'cp1256', 'cp1254', 'cp1258', 'latin1']
    content = None
    for enc in encodings:
        try:
            with open(path, 'r', encoding=enc) as f:
                content = f.readlines()
            break
        except Exception:
            continue
    if content is None:
        with open(path, 'r', encoding='latin1', errors='replace') as f:
            content = f.readlines()

    strings = {}
    dialogs = {}
    menus = {}
    tooltips = {}
    metadata = {}
    for line in content:
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        if "=" in line:
            parts = line.split("=", 1)
            k, v = parts[0].strip(), parts[1].strip()
            if k.startswith("t") and k[1:].isdigit():
                tooltips[k] = v
            elif k.isdigit():
                num = int(k)
                if num < 2000:
                    dialogs[k] = v
                elif num < 30000:
                    strings[k] = v
                else:
                    menus[k] = v
            else:
                metadata[k] = v

    return {
        "file": os.path.basename(path),
        "metadata": metadata,
        "dialogs": dialogs,
        "menus": menus,
        "strings": strings,
        "tooltips": tooltips,
        "total_keys": len(dialogs) + len(menus) + len(strings) + len(tooltips)
    }

total_parsed = 0
for f in os.listdir(lang_dir):
    full = os.path.join(lang_dir, f)
    if f.endswith('.lng'):
        parsed = parse_lng_file(full)
        out_name = os.path.splitext(f)[0] + '.json'
        with open(os.path.join(out_dir, out_name), 'w', encoding='utf-8') as out_f:
            json.dump(parsed, out_f, indent=2, ensure_ascii=False)
        total_parsed += 1
    elif f.startswith('tips_') and f.endswith('.txt'):
        try:
            with open(full, 'r', encoding='utf-8', errors='replace') as tf:
                lines = [l.strip() for l in tf if l.strip() and not l.strip().startswith('#')]
            out_name = os.path.splitext(f)[0] + '.json'
            with open(os.path.join(out_dir, out_name), 'w', encoding='utf-8') as out_f:
                json.dump({"file": f, "tips": lines, "count": len(lines)}, out_f, indent=2, ensure_ascii=False)
            total_parsed += 1
        except Exception:
            pass

print(f"Total language catalogs created: {total_parsed}")

