# Remote setup

The root Git repository (`D:\Omnia`) is configured locally per the user's Msg #114 mandate and verified Git Credential Manager (GCM) account (correcting the earlier `khang-macphuc11107` typo):

- `user.name`: `khang-macphuc111107`
- `user.email`: `khang.macphuc111107@gmail.com`
- Target GitHub repository: `https://github.com/khang-macphuc111107/omnia`
- Intended collaborator: `HTMusTC`

No `origin` remote is configured yet while `DELIVERY-01` / `DOD-15` privacy, secret-redaction, license, root-allowlist, and clean-clone checks are finalized. Do not guess an alternate remote or push unreviewed workspace or externalized `D:\OmniaData` artifacts.

When ready to publish the verified tree:

```powershell
git -C "D:\Omnia" remote add origin https://github.com/khang-macphuc111107/omnia.git
git -C "D:\Omnia" remote -v
```
