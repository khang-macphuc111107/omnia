from pathlib import Path

def read_csv_rows(path: str | Path) -> list[dict]:
    p = Path(path)
    # BUG 2: manual split("\n") leaks \r from CRLF files
    raw = p.read_bytes().decode("utf-8")
    lines = [ln for ln in raw.split("\n") if ln]
    header = lines[0].split(",")
    rows = []
    for ln in lines[1:]:
        vals = ln.split(",")
        rows.append(dict(zip(header, vals)))
    return rows
