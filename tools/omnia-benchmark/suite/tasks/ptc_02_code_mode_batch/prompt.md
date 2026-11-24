# Task: Batch Migrate 64 Service Manifests & Build Dependency Cycle Index

The `services/` directory contains 64 JSON manifests (`svc_00.json` .. `svc_63.json`).
Using programmatic batch execution (`run_code` or Python):
1. In every `services/svc_*.json`, migrate `"api_version": "v1"` -> `"v2"`, replace URL prefix `"/api/v1/"` -> `"/api/v2/"` in `"endpoint"`, and compute `"spec_sha256"` = SHA-256 hex of `f"{id}:{endpoint}:{tier}"` (leave `"v2"` services' endpoint untouched if already v2, still ensuring `"spec_sha256"` matches the new formula!).
2. Detect all service IDs participating in ANY directed dependency cycle across `"depends_on"` edges, and list `"in_cycle": sorted(cycle_ids)` plus `"topo_order"` (or `"acyclic_count"`) in `registry/index.json`:
```json
{
  "total_services": 64,
  "migrated_from_v1": int,
  "cycle_nodes": [sorted service ids],
  "by_tier": {"critical": int, "standard": int},
  "checksums": {"svc_00": str, ...}
}
```
Make `python -m unittest discover -s tests` pass without modifying `tests/`.
