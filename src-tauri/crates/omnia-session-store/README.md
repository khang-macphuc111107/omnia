# Omnia session store

Canonical Rust owner of existing agent-session storage, navigation, schemas and
native error types. The Tauri desktop package keeps compatibility imports and
two thin navigation command wrappers. The independent native shell can consume
this crate without depending on Tauri or WebView.

This is a source extraction, not a replacement schema or separate sessions
database. Existing serialized field names, project/projectless semantics,
revision CAS, deletion tombstones, navigation receipts and recovery behavior
are retained. Legacy summaries without explicit scope continue to deserialize
as `Project`; new projectless sessions must specify `Projectless`.

`test-support` exposes existing test helpers to the desktop test target. Runtime
consumers should leave default features empty.

## Important runtime boundary

`HarnessStore::open` performs schema bootstrap and marks running journal states
interrupted. Opening an active database from another process is therefore not
an observational read. A native replacement needs explicit cutover, recovery
ownership and same-file coordination before using a live compatibility store.

The crate also depends on the existing Tauri-free `omnia-harness` message,
permission and prompt types. That dependency has a substantial Rust dependency
graph; crate reuse alone does not prove optimal startup or binary size.

## Verification

Parent integration owns serialized Cargo execution. Required checks include:

```text
cargo test --manifest-path src-tauri/Cargo.toml -p omnia-session-store
cargo check --manifest-path src-tauri/Cargo.toml -p omnia-desktop
cargo test --manifest-path src-tauri/Cargo.toml -p omnia-desktop --test omnia_native
```

Pure store tests establish persistence/CAS/navigation behavior. They do not prove
native UI, live provider dispatch, cross-process crash recovery or packaging.
