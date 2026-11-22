# Omnia Runtime Compatibility Tool (`omnia-runtime-compat`)

Deterministic Python 3 standard-library module and CLI implementing verified, non-secret runtime compatibility contracts extracted from `D:/opencode` (MIT) and `D:/CodexBetaPatched`:

1. **`/v1/responses` Tool-Namespace Preservation & Restoration**
   - Lowers nested `type: "namespace"` and `type: "custom"` tools into flat `function` declarations while stripping non-standard `encrypted` / `input_schema` extensions (`lower_responses_request`).
   - Restores stripped `namespace` + original `name` on `function_call` items across non-streaming JSON payloads (`restore_responses_json`) and streaming SSE frames (`restore_sse_event`, `restore_sse_stream`).
   - Enforces the pseudo-root `"functions"` guard (never attaches `namespace="functions"` to root builtin tools) and never mislabels namespaced `function_call_arguments.delta` frames as `custom_tool_call_input.delta`.
   - Preserves unrelated payload fields, messages, reasoning deltas, and usage metrics without mutation.

2. **`TurnSteer` + Omnia `ADDITIVE_INTAKE` Validator**
   - Validates `threadId` (`<= 240` chars, no ASCII control characters), `expectedTurnId` CAS precondition (`active_turn_id` mismatch returns `CAS_TURN_MISMATCH`), and non-empty `input` across all 7 typed `UserInput` variants (`text` + `text_elements` `byteRange`, `image`, `localImage`, `audio`, `localAudio`, `skill`, `mention`).
   - Validates `additionalContext` (`kind` in `{"untrusted", "application"}`) and blocks `responsesapiClientMetadata` overrides of reserved keys (`session_id`, `thread_id`, `turn_id`, `window_id`).
   - Enforces Omnia `ADDITIVE_INTAKE` invariants (`steerMode` in `{"ADDITIVE_INTAKE", "BOUNDARY_CORRECTION", "EXPLICIT_STOP_OR_REPLACE"}`, `token_budget` / `tokenBudget` strictly `null`/unset).

3. **`opencode` Provider, Model & Tool Descriptor -> Omnia Routing Mapper**
   - Maps sanitized `Provider.Info` + `Model.Info` / `models.dev` capability schemas into Omnia `omnia.routing.v2.cpp20` candidates (`adapterFamily`, `privacyTier`, `capabilitiesFlags`, microunit pricing, explicit `quotaState: {"kind": "unknown", ...}`, and utility ID filtering).
   - Maps `Tool.Info` / MCP / namespace descriptors into normalized Omnia tool descriptors while enforcing `"functions"` pseudo-root normalization and flagging reserved `execute` collisions in codemode.
   - Rejects or strips inline API keys, Bearer tokens, and secret-bearing URLs so exported receipts strictly follow `strict_no_secrets_no_prompts_no_raw_urls_v1`.

## Usage

Always invoke Python with `-B` so zero `__pycache__` or `.pyc` files are created inside `D:/Omnia`:

```powershell
# Run unit tests (pure UTF-8, stdlib only)
python -B -m unittest discover -s D:\Omnia\tools\omnia-runtime-compat -p "test_*.py" -v

# Lower /v1/responses request and restore SSE stream
python -B D:\Omnia\tools\omnia-runtime-compat\cli.py lower-responses --input req.json > plan.json
python -B D:\Omnia\tools\omnia-runtime-compat\cli.py restore-sse --tools plan.json --input raw.sse

# Validate TurnSteer + ADDITIVE_INTAKE payload
python -B D:\Omnia\tools\omnia-runtime-compat\cli.py validate-steer --active-turn-id turn_42 --input steer.json

# Map sanitized opencode provider + models to Omnia routing candidates
python -B D:\Omnia\tools\omnia-runtime-compat\cli.py map-provider --input provider_bundle.json

# Map opencode tool descriptor
python -B D:\Omnia\tools\omnia-runtime-compat\cli.py map-tool --input tool.json
```
