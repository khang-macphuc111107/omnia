## Summary

- What does this PR change, and why?
- Related Issue / Discussion / Steer ID:

## Architecture & Zero-Nerf Checklist

- [ ] Pure Native Rust 17-crate workspace preserved (`0` `.cpp`/`.hpp`/`CMake*` files added)
- [ ] Out-of-source build rule honored (`0` `target/`, `build/`, `node_modules/`, `dist/`, `__pycache__/`, `*.exe`, `*.pdb` inside repo)
- [ ] Lean CLI performance budget preserved (`omnia.exe <= 14 MiB`, warm `--version <= 15 ms`)
- [ ] Full-freedom default harness (`ApprovalMode::Yolo` / `SOLO`) preserved without unintended regressions or restrictions
- [ ] Pure UTF-8 without BOM, Unix `LF` (`git ls-files --eol` -> `0` CRLF), zero trailing whitespace

## Verification Evidence

Paste exact commands and observed outputs (do not claim unrun checks):

```powershell
# cargo clippy --workspace --all-targets --offline --locked -- -D warnings
# cargo test --workspace --offline --locked -- --test-threads=2
# python -B tools/omnia-consolidated-audit/audit.py --secret-scope all --strict --strict-scope full
# python -B tools/omnia-skill-parity/validate_skills.py --strict-all-skills
# node --test ui/tests/*.test.js
```

## Privacy & Security

- [ ] Zero secrets, API keys, tokens, cookies, browser profiles, or private transcripts included
- [ ] Synthetic test fixtures use unmistakable dummy markers and RFC-2606 (`example.com`/`example.test`) or loopback hosts
