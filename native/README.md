# Omnia native migration executable

Independent Rust package for a Windows shell without Tauri, WebView, Electron
or Node in its product dependency graph. This is an early migration executable,
**not the full Omnia application or its final visual design**.

```powershell
cargo test --manifest-path native/Cargo.toml --locked
cargo build --manifest-path native/Cargo.toml --locked --release
.\native\target\release\omnia-native.exe
```

Three original mode controls default to projectless Chat. A native Unicode
draft survives mode switches in memory. Browser and IDE describe unavailable
integrations. No provider, indexing, browser engine or background server starts.
Drafts are not persisted. The message loop blocks on Windows events.

`qa-smoke.ps1` launches this release executable and records bounded control-message
interaction, a window-only capture and process observations. `-KeepOpen` leaves
the tested window visible. This does not certify physical keyboard, IME or UIA.
The Cycle24 PowerShell observer omitted client-side proxy registration. Cycle25
`qa-session.ps1` registers those proxies and checks Button/InvokePattern,
single-line Edit/ValuePattern and multiline Document/TextPattern. Physical
keyboard, IME, Narrator and the DPI matrix remain open requirements.

![Actual native session evaluation](../docs/rebuild/receipts/native-session-cycle25-window.png)

## Shared session service

Canonical HarnessStore, errors and session navigation now live in
`src-tauri/crates/omnia-session-store`, with thin Tauri transport adapters.
The native session panel uses that same schema and CAS through a bounded worker.
Session rows now use a keyset page of at most 50, with Previous/Next and Refresh.
Navigation, the current page and active metadata share one SQLite read
transaction. The active session may be outside the page and stays editable.
Previous-page history retains at most 256 cursors; Refresh resets to the first
page. Edits between requests can move rows; this is not a frozen multi-page
export. Each summary is limited to 256 KiB and the read page (including sentinel
and active) to 2 MiB raw JSON; oversize returns an explicit error.
Launch with `--session-db <absolute isolated database path>` to evaluate durable
metadata; without that flag no database is opened. **Use a disposable database:** opening performs recovery writes. Production
open now takes an exclusive OS file-identity ownership guard before recovery;
a competing cooperative instance returns `harness_store_busy`. This does not
make the shell a read-only observer or a provider execution coordinator.
Provider execution needs an event-sink/executor boundary before Send is enabled.

The compatibility app remains in `src-tauri/`; this package never depends on it.
Final dark/light design, transcript persistence, advanced settings, browser/IDE
integration and comparative packaged performance remain open work.

## Native paging QA

`qa-paging.ps1` exercises a disposable 125-session fixture made by the
`qa_seed` example (which refuses an existing fixture directory). It uses UIA
to check 50/50/25 rows, Previous/Next states, off-page active metadata,
Refresh and clean-close/reopen. Root captures the actual app window.

![Native paged session evaluation](../docs/rebuild/receipts/native-paging-cycle26-window.png)

## Native metadata safety

Unsaved title/model/effort require explicit discard before replacing navigation
or close; the default keeps editing. Failed storage/selection retains the form
and restores the active selection. Save success resets the rendered baseline.
`qa-guard.ps1` targets the debug executable and an isolated synthetic database.
Cycle27 verifies12UIA cases including failed Select, invalid Save, cancellation,
explicit discard and reopen. Physical keyboard/IME/Narrator, release performance,
provider streaming and the final native design remain unverified.

The Rust implementation sequence and resource acceptance are documented in
[`NATIVE_MIGRATION.md`](../docs/rebuild/NATIVE_MIGRATION.md).

## Native ownership QA

`qa-ownership.ps1` uses a new isolated database and explicit output prefix to
check two actual native processes, busy status, retained metadata and reopen.
Its capture is evaluation-shell evidence only. Store integration tests also
exercise an independently spawned owner and forced termination. Windows local
file locking is tested; Unix/network-filesystem and hostile path replacement
are separate unresolved boundaries.

Cycle32 shares the store with `Sessions::from_shared(Arc<HarnessStore>)` and
retains stale-revision rejection between distinct service views. The desktop
host now uses the same Rust crate for bounded run reservations with opaque
owner/generation cleanup tickets. Native Send is still unavailable. The current
binary passed10native tests and6ownership UIA cases; see
[`native-runs-cycle32-ui-runtime.json`](../docs/rebuild/receipts/native-runs-cycle32-ui-runtime.json).

Cycle33 adds a native service integration test that shares the admission
coordinator's store, saves per-session settings, rejects a competing open and
retains ownership until the last metadata view drops. Native tests now11pass.
The shared coordinator performs replay-safe eligibility/reservation; the
evaluation executable still does not expose provider Send/Cancel.

### Cycle34: shared native run controls

The existing ActiveRun and approval-channel implementation now belong to the
Tauri-free Rust harness and are used directly by the compatibility host. This
removes another host-specific ownership seam without adding an Agent engine.
The [native runtime contract](../docs/rebuild/NATIVE_RUNTIME_CONTRACT.md) defines per-subsystem Rust ownership,
on-demand engine exceptions and resource qualification. Native provider Send,
final UI and measured performance remain incomplete; see the cycle checks and
independent review for the exact verified scope.
