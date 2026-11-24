import argparse, hashlib, hmac, sqlite3
from pathlib import Path

HMAC_KEY = b"dummy_fixture_mcp_hmac_key_v5"

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    args = ap.parse_args()
    ws = Path(args.workspace).resolve()
    data_dir = ws / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    db = data_dir / "inventory.db"
    if db.exists():
        db.unlink()
    con = sqlite3.connect(str(db))
    con.execute("CREATE TABLE owners (service TEXT PRIMARY KEY, owner_team TEXT)")
    con.execute("CREATE TABLE shards (shard_id TEXT PRIMARY KEY, region TEXT, service TEXT, status TEXT, p99_ms INTEGER, error_rate_pct REAL, alert_token TEXT)")
    owners = [("payments", "team-fin"), ("ledger", "team-core"), ("gateway", "team-edge"), ("search", "team-idx")]
    con.executemany("INSERT INTO owners VALUES (?, ?)", owners)
    regions = ["ap-se-1", "eu-west-1", "us-east-1", "us-west-2"]
    rows = []
    idx = 0
    for r in regions:
        for j in range(6):  # 24 shards total -> 2 pages per region!
            idx += 1
            sid = f"sh-{r}-{j:02d}"
            svc = owners[idx % 4][0]
            status = "maintenance" if (idx in (4, 15)) else "active"
            p99 = 320 if (idx % 5 == 0) else 140
            err = 3.1 if (idx % 7 == 0) else 0.4
            tok = hmac.new(HMAC_KEY, sid.encode(), hashlib.sha256).hexdigest()[:16]
            if idx in (10, 21):  # forged HMAC token -> must be excluded!
                tok = "00000000deadbeef"
            rows.append((sid, r, svc, status, p99, err, tok))
    con.executemany("INSERT INTO shards VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
    con.commit()
    con.close()
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
