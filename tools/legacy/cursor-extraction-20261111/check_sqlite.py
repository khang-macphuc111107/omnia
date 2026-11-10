import sqlite3, json
conn = sqlite3.connect(r"C:\Users\khang\.codex\thread_history_1.sqlite")
cursor = conn.cursor()
cursor.execute("SELECT item_id, item_json FROM thread_items WHERE item_type='userMessage' ORDER BY rowid DESC LIMIT 15;")
rows = cursor.fetchall()
rows.reverse()
for idx, (iid, ijson) in enumerate(rows[4:]):
    try:
        data = json.loads(ijson)
        for c in data.get('content', []):
            if c.get('type') == 'text':
                print(f"=== USER MSG #{idx+5} ({iid}) ===")
                print(c['text'])
    except Exception as e:
        print("Err:", e)
