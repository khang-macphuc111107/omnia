# Task: Git Archaeology, Selective Revert, and 3-Branch Merge Resolution

You are working inside a Git repository in the current working directory containing the **NexusPay Gateway Service** (`service/` and `tests/`).

The `main` branch currently has failing tests and several repository hygiene and integration issues that must be resolved cleanly without destroying commit history.

## Requirements

Perform ALL of the following steps inside the current working directory on branch `main`:

1. **Identify the Checksum Regression Commit**
   - Inspect the Git history on `main` (e.g., using `git log` / `git bisect`) to find the exact commit that introduced the checksum regression in `service/checksum.py`.
   - Write **ONLY** the full 40-character lowercase hexadecimal SHA-1 commit hash of that culprit commit (with an optional trailing newline) to `CULPRIT_COMMIT.txt` in the repository root.

2. **Selectively Revert the Checksum Regression**
   - Revert **ONLY** the checksum regression commit on `main` (e.g., via `git revert <hash>`).
   - **Do NOT** use `git reset --hard`, rebase, or rewrite existing `main` history: all original commits on `main` — including the later `service/metrics.py` telemetry commits — must remain intact as ancestors of `HEAD`.

3. **Merge `feature/cache-v2` into `main`**
   - Perform a real Git merge of `feature/cache-v2` into `main` so that both `feature/cache-v2` and `hotfix/auth` are ancestors of `HEAD`.
   - Resolve the merge conflict in `service/app.py` so that **ALL** functionality is preserved together:
     - `hotfix/auth`: `TokenAuthenticator` with `auth_clock` keyword argument, `ALLOWED_ROLES` validation, and `"role"` included in the cache key and response `data`.
     - `feature/cache-v2`: `ResponseCache` v2 LRU+TTL initialized with `max_size=cache_size, default_ttl=cache_ttl, clock=cache_clock` (`cache_ttl: float | None = 60.0` and `cache_clock: Callable[[], float] | None = None` as keyword arguments on `GatewayService.__init__`).
     - `main` telemetry: `self.metrics = MetricsRegistry()` and all counter increments (`requests_total`, `auth_failures`, `checksum_failures`, `cache_hits`, `cache_misses`).

4. **Untrack and Ignore Build Artifacts**
   - Remove the mistakenly tracked file `build/artifact.bin` from Git tracking (`git rm` or `git rm --cached`).
   - Add `build/` to `.gitignore` so all files under `build/` are ignored by Git.

5. **Verify and Commit Everything Cleanly**
   - Run `python test_suite.py` and verify that **all** tests pass.
   - Commit all changes (including `CULPRIT_COMMIT.txt`, `.gitignore`, the removal of `build/artifact.bin` from tracking, the revert, and the merge) on branch `main`.
   - When finished, `git branch --show-current` must be `main` and `git status --porcelain` must be completely empty.

## Constraints
- Work only inside the current working directory.
- Use only the Python 3 standard library and `git`.
