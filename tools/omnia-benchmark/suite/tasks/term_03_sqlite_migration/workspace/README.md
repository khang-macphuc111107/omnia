# Legacy SQLite v1 -> v2 Migration

This workspace contains:
- `app.db`: Legacy v1 SQLite database containing `users_legacy` and `orders_legacy`.
- `fx_rates.json`: Deterministic FX-to-USD conversion rates.

Write `migrate.py` according to the task specification and execute:

```bash
python migrate.py
```
