import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");

// This is a source-contract audit, not Rust execution or live discovery proof.
test("native model discovery projects the identity resolved by catalog storage", () => {
  const gateway = readFileSync(resolve(root, "src-tauri/src/provider_gateway.rs"), "utf8");
  const start = gateway.indexOf("pub async fn provider_models_list(");
  assert.ok(start >= 0, "Native catalog discovery command must exist");
  const body = gateway.slice(start, gateway.indexOf("\n///", start));
  const binding = body.match(/let\s+([a-z_][a-z_0-9]*)\s*=\s*state\s*\.\s*storage\s*\.\s*persist_provider_catalog_snapshot\s*\([\s\S]*?\)\s*\?\s*;/);
  assert.ok(binding, "The returned native snapshot identity must be bound, not discarded in favor of the caller hint");
  const returned = body.match(/Ok\(ProviderModelList\s*\{([\s\S]*?)\}\)/)?.[1];
  assert.ok(returned, "Native discovery must return the catalog envelope");
  assert.match(returned, new RegExp(binding[1] === "snapshot_id" ? "(?:^|[,\\s])snapshot_id(?:\\s*,|\\s*$)" : `snapshot_id\\s*:\\s*${binding[1]}(?:\\s*,|\\s*$)`), "Returned catalog identity must come from native storage resolution");
});
