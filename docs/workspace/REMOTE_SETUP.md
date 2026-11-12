# Remote setup

The root Git repository (`D:\Omnia`) is published to the verified private GitHub repository per the user's Msg #114 mandate and OS-managed Git Credential Manager (GCM) account (correcting the earlier `khang-macphuc11107` typo):

- **Active `origin` remote**: `https://github.com/khang-macphuc111107/omnia.git` (fetch & push)
- **Repository URL & visibility**: `https://github.com/khang-macphuc111107/omnia` (`private`, owner `khang-macphuc111107`)
- **Local Git identity**:
  - `user.name`: `khang-macphuc111107`
  - `user.email`: `khang.macphuc111107@gmail.com`
  - `credential.https://github.com.username`: `khang-macphuc111107`
- **Collaborator access note (`HTMusTC`)**: `HTMusTC` is a Discord handle rather than a resolvable GitHub login. Once the collaborator shares their exact GitHub username, grant repository access at `https://github.com/khang-macphuc111107/omnia/settings/access`.

## Verified publication & clean-clone baseline (`DELIVERY-01` / `SESSION-G06`)

- **Commit #1 baseline pushed & verified**: commit `d8b456e357dde65d8ee314194743fb93655f5d6a`, tree `5f8ecc4966a859dcc032bca0b3013d2f81233abb` (`2,039` tracked files).
- **Independent remote & isolated local clean-clone receipt**: `D:\OmniaData\qa\github-clean-clone-20261112\GITHUB_DELIVERY_AND_CLONE_RECEIPT.json` (`sha256=35aaac06a396bfc60e6d8a9bc893ccaf28c1f298c2ed958f344bdffc9285e610`, `allChecksPassed=true`: remote GitHub clone and `--no-local --no-hardlinks` isolated clone match `d8b456e357dde65d8ee314194743fb93655f5d6a`, both `cargo metadata --locked` `rc=0`, both `cargo fmt --all --check` `rc=0`, `524/524` locked Cargo tests `rc=0`, `5/5` `agy_history_sync` unit tests `rc=0`, and `12/12` `.agents/skills/*` `quick_validate.py` `rc=0`).
- **Boundary rule**: Never push externalized `D:\OmniaData` archives, SQLite databases, raw chat transcripts, credentials, or unreviewed dirty worktrees into `origin`.

## Non-interactive push & verification commands

```powershell
$env:GCM_INTERACTIVE = 'never'
$env:GIT_TERMINAL_PROMPT = '0'
git -C "D:\Omnia" push origin master
git -C "D:\Omnia" status --short --branch
```
