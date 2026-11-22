#!/usr/bin/env python3
"""Focused unit tests for Omnia runtime compatibility contracts.

Run with:
    python -B -m unittest discover -s D:\\Omnia\\tools\\omnia-runtime-compat -p "test_*.py" -v
"""

from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

MODULE_DIR = Path(__file__).resolve().parent
if str(MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(MODULE_DIR))

from compat_contracts import (  # noqa: E402
    CompatContractError,
    OMNIA_REDACTION_POLICY,
    OMNIA_ROUTING_SCHEMA_VERSION,
    SseRestorationState,
    build_namespace_index,
    lower_responses_request,
    map_opencode_provider_and_models,
    map_opencode_tool_descriptor,
    restore_responses_json,
    restore_sse_event,
    restore_sse_stream,
    validate_turn_steer_payload,
)


class ResponsesNamespaceTests(unittest.TestCase):
    """Tests for /v1/responses namespace lowering and SSE/JSON restoration."""

    def test_lower_and_restore_namespace_preserves_unrelated_fields(self) -> None:
        req = {
            "model": "gpt-5",
            "temperature": 0.2,
            "metadata": {"trace_id": "req-123", "custom_tag": "keep-me"},
            "tools": [
                {
                    "type": "namespace",
                    "name": "mcp.filesystem",
                    "tools": [
                        {
                            "type": "function",
                            "name": "read-file",
                            "description": "Read file",
                            "parameters": {
                                "type": "object",
                                "encrypted": True,
                                "properties": {"path": {"type": "string", "encrypted": False}},
                                "required": ["path"],
                            },
                        }
                    ],
                },
                {
                    "type": "function",
                    "name": "plain_tool",
                    "parameters": {"type": "object", "properties": {}},
                },
            ],
            "tool_choice": {"type": "function", "namespace": "mcp.filesystem", "name": "read-file"},
        }
        original_snapshot = copy.deepcopy(req)
        plan = lower_responses_request(req)
        # Input payload was not mutated in place
        self.assertEqual(req, original_snapshot)
        self.assertEqual(plan.payload["temperature"], 0.2)
        self.assertEqual(plan.payload["metadata"], {"trace_id": "req-123", "custom_tag": "keep-me"})
        self.assertEqual(plan.payload["tools"][0]["name"], "mcp_filesystem_read_file")
        self.assertNotIn("encrypted", plan.payload["tools"][0]["parameters"])
        self.assertNotIn("encrypted", plan.payload["tools"][0]["parameters"]["properties"]["path"])
        self.assertEqual(plan.payload["tool_choice"], {"type": "function", "name": "mcp_filesystem_read_file"})

        upstream_resp = {
            "id": "resp_1",
            "status": "completed",
            "usage": {"input_tokens": 11, "output_tokens": 7},
            "output": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "Checking file"}],
                },
                {
                    "type": "function_call",
                    "id": "fc_1",
                    "call_id": "call_1",
                    "name": "mcp_filesystem_read_file",
                    "arguments": "{\"path\":\"README.md\"}",
                },
                {
                    "type": "function_call",
                    "id": "fc_2",
                    "call_id": "call_2",
                    "name": "plain_tool",
                    "arguments": "{}",
                },
            ],
        }
        restored = restore_responses_json(upstream_resp, plan.index)
        self.assertEqual(restored["usage"], {"input_tokens": 11, "output_tokens": 7})
        self.assertEqual(restored["output"][0]["content"][0]["text"], "Checking file")
        self.assertEqual(restored["output"][1]["namespace"], "mcp.filesystem")
        self.assertEqual(restored["output"][1]["name"], "read-file")
        self.assertEqual(restored["output"][1]["arguments"], "{\"path\":\"README.md\"}")
        self.assertNotIn("namespace", restored["output"][2])
        self.assertEqual(restored["output"][2]["name"], "plain_tool")

    def test_pseudo_namespace_functions_never_injected_or_kept(self) -> None:
        req = {
            "tools": [
                {
                    "type": "namespace",
                    "name": "functions",
                    "tools": [
                        {"type": "function", "name": "shell_exec", "parameters": {"type": "object"}},
                    ],
                }
            ]
        }
        plan = lower_responses_request(req)
        self.assertEqual(plan.payload["tools"][0]["name"], "shell_exec")
        self.assertNotIn("functions_shell_exec", plan.index.namespace_aliases)

        resp_with_pseudo = {
            "output": [
                {
                    "type": "function_call",
                    "id": "fc_fn",
                    "call_id": "call_fn",
                    "name": "shell_exec",
                    "namespace": "functions",
                    "arguments": "{}",
                }
            ]
        }
        restored = restore_responses_json(resp_with_pseudo, plan.index)
        self.assertEqual(restored["output"][0]["name"], "shell_exec")
        self.assertNotIn("namespace", restored["output"][0])

    def test_sse_stream_restores_namespaces_without_mislabeling_deltas_as_custom(self) -> None:
        index = build_namespace_index([
            {
                "type": "namespace",
                "name": "mcp__github",
                "tools": [{"type": "function", "name": "get_issue"}],
            },
            {"type": "custom", "name": "exec"},
        ])
        sse_frames = "\n\n".join([
            "event: response.output_text.delta\ndata: "
            + json.dumps({"type": "response.output_text.delta", "delta": "Hi", "sequence_number": 1}),
            "event: response.output_item.added\ndata: "
            + json.dumps({
                "type": "response.output_item.added",
                "output_index": 0,
                "item": {"type": "function_call", "id": "fc_ns", "call_id": "c_ns", "name": "mcp__github_get_issue"},
            }),
            "event: response.function_call_arguments.delta\ndata: "
            + json.dumps({
                "type": "response.function_call_arguments.delta",
                "item_id": "fc_ns",
                "output_index": 0,
                "delta": "{\"num\":1}",
            }),
            "event: response.function_call_arguments.done\ndata: "
            + json.dumps({
                "type": "response.function_call_arguments.done",
                "item_id": "fc_ns",
                "output_index": 0,
                "name": "mcp__github_get_issue",
                "arguments": "{\"num\":1}",
            }),
            "event: response.output_item.done\ndata: "
            + json.dumps({
                "type": "response.output_item.done",
                "output_index": 0,
                "item": {
                    "type": "function_call",
                    "call_id": "c_ns",
                    "name": "mcp__github_get_issue",
                    "arguments": "{\"num\":1}",
                },
            }),
            "event: response.completed\ndata: "
            + json.dumps({
                "type": "response.completed",
                "response": {
                    "id": "resp_done",
                    "output": [
                        {
                            "type": "function_call",
                            "id": "fc_exec",
                            "call_id": "c_exec",
                            "name": "exec",
                            "arguments": "{\"command\":\"dir\"}",
                        }
                    ],
                },
            }),
            "data: [DONE]",
        ])
        restored_sse = restore_sse_stream(sse_frames, index, restore_custom_exec=True)
        events = []
        for block in restored_sse.split("\n\n"):
            data_line = next((line for line in block.splitlines() if line.startswith("data: ")), None)
            if data_line and data_line != "data: [DONE]":
                events.append(json.loads(data_line[6:]))

        self.assertEqual(events[0], {"type": "response.output_text.delta", "delta": "Hi", "sequence_number": 1})
        self.assertEqual(events[1]["item"]["namespace"], "mcp__github")
        self.assertEqual(events[1]["item"]["name"], "get_issue")
        # Namespace tool delta MUST stay function_call_arguments.delta (never custom_tool_call_input.delta)
        self.assertEqual(events[2]["type"], "response.function_call_arguments.delta")
        self.assertEqual(events[3]["namespace"], "mcp__github")
        self.assertEqual(events[3]["name"], "get_issue")
        self.assertEqual(events[4]["item"]["namespace"], "mcp__github")
        self.assertEqual(events[4]["item"]["name"], "get_issue")
        self.assertEqual(events[5]["response"]["output"][0]["type"], "custom_tool_call")
        self.assertEqual(events[5]["response"]["output"][0]["input"], "dir")
        self.assertTrue(restored_sse.endswith("data: [DONE]"))

    def test_sse_custom_exec_delta_and_mcp_inference(self) -> None:
        index = build_namespace_index(
            [{"type": "custom", "name": "exec"}],
            infer_mcp_double_underscore=True,
        )
        state = SseRestorationState()
        added = restore_sse_event(
            {
                "type": "response.output_item.added",
                "output_index": 0,
                "item": {"type": "function_call", "id": "fc_e", "call_id": "c_e", "name": "exec"},
            },
            state,
            index,
            restore_custom_exec=True,
        )
        delta = restore_sse_event(
            {
                "type": "response.function_call_arguments.delta",
                "item_id": "fc_e",
                "output_index": 0,
                "delta": "{\"command\":\"ls\"}",
            },
            state,
            index,
            restore_custom_exec=True,
        )
        done = restore_sse_event(
            {
                "type": "response.function_call_arguments.done",
                "item_id": "fc_e",
                "output_index": 0,
            },
            state,
            index,
            restore_custom_exec=True,
        )
        self.assertEqual(added["item"]["type"], "custom_tool_call")
        self.assertEqual(delta["type"], "response.custom_tool_call_input.delta")
        self.assertEqual(done["type"], "response.custom_tool_call_input.done")
        self.assertEqual(done["input"], "ls")

        inferred_resp = restore_responses_json(
            {"output": [{"type": "function_call", "name": "mcp__sqlite__query", "arguments": "{}"}]},
            index,
        )
        self.assertEqual(inferred_resp["output"][0]["namespace"], "mcp__sqlite")
        self.assertEqual(inferred_resp["output"][0]["name"], "query")


class TurnSteerValidationTests(unittest.TestCase):
    """Tests for TurnSteer CAS precondition, typed UserInput, and ADDITIVE_INTAKE."""

    def test_valid_payload_with_all_seven_user_input_variants(self) -> None:
        payload = {
            "threadId": "thr_abc123",
            "expectedTurnId": "turn_42",
            "clientUserMessageId": "msg_99",
            "steerMode": "ADDITIVE_INTAKE",
            "tokenBudget": None,
            "input": [
                {
                    "type": "text",
                    "text": "Please also inspect @app.py",
                    "text_elements": [
                        {"byteRange": {"start": 19, "end": 26}, "placeholder": "@app.py"}
                    ],
                },
                {"type": "image", "url": "https://example.com/ui.png", "detail": "high"},
                {"type": "localImage", "path": "D:/OmniaData/qa/shot.png", "detail": "original"},
                {"type": "audio", "url": "https://example.com/clip.wav"},
                {"type": "localAudio", "path": "D:/OmniaData/qa/note.wav"},
                {"type": "skill", "name": "deep-cpp-native", "path": "D:/Omnia/.agents/skills/deep-cpp-native/SKILL.md"},
                {"type": "mention", "name": "studio_server.cpp", "path": "D:/Omnia/cpp/src/studio/studio_server.cpp"},
            ],
            "additionalContext": {
                "notes": {"kind": "application", "value": "Preserve running tasks."},
                "web": {"kind": "untrusted", "value": "External snippet"},
            },
            "responsesapiClientMetadata": {"client_surface": "flagship_studio"},
        }
        result = validate_turn_steer_payload(payload, active_turn_id="turn_42")
        self.assertTrue(result["valid"], msg=result["errors"])
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["receipt"]["inputItemCount"], 7)
        self.assertEqual(result["receipt"]["steerMode"], "ADDITIVE_INTAKE")
        self.assertIsNone(result["receipt"]["tokenBudget"])
        self.assertEqual(result["receipt"]["redactionPolicy"], OMNIA_REDACTION_POLICY)

    def test_cas_turn_mismatch_rejected(self) -> None:
        payload = {
            "threadId": "thr_1",
            "expectedTurnId": "turn_old",
            "input": [{"type": "text", "text": "Steer note"}],
        }
        result = validate_turn_steer_payload(payload, active_turn_id="turn_new")
        self.assertFalse(result["valid"])
        codes = {err["code"] for err in result["errors"]}
        self.assertIn("CAS_TURN_MISMATCH", codes)

    def test_empty_input_and_invalid_byte_range_rejected(self) -> None:
        empty_res = validate_turn_steer_payload({"threadId": "t", "expectedTurnId": "u", "input": []})
        self.assertFalse(empty_res["valid"])
        self.assertIn("EMPTY_USER_INPUT", {e["code"] for e in empty_res["errors"]})

        bad_range_res = validate_turn_steer_payload({
            "threadId": "t",
            "expectedTurnId": "u",
            "input": [
                {
                    "type": "text",
                    "text": "hello",
                    "text_elements": [{"byteRange": {"start": 4, "end": 2}}],
                },
                {"type": "unknown_kind", "foo": "bar"},
            ],
        })
        self.assertFalse(bad_range_res["valid"])
        codes = {e["code"] for e in bad_range_res["errors"]}
        self.assertIn("INVALID_BYTE_RANGE_BOUNDS", codes)
        self.assertIn("INVALID_USER_INPUT_TYPE", codes)

    def test_reserved_client_metadata_and_token_budget_cap_rejected(self) -> None:
        payload = {
            "threadId": "thr_1",
            "expectedTurnId": "turn_1",
            "token_budget": 1024,
            "steerMode": "EXPLICIT_STOP_OR_REPLACE",
            "input": [{"type": "text", "text": "Continue"}],
            "responsesapiClientMetadata": {
                "session_id": "hijack",
                "turn_id": "override",
                "custom_ok": "value",
            },
        }
        result = validate_turn_steer_payload(payload)
        self.assertFalse(result["valid"])
        codes = {e["code"] for e in result["errors"]}
        self.assertIn("FORBIDDEN_TOKEN_BUDGET_CAP", codes)
        self.assertIn("RESERVED_METADATA_KEY_OVERRIDE", codes)
        self.assertIn("MISSING_SUPERSESSION_TARGET", codes)

    def test_omnia_steer_mapping_cannot_bypass_top_level_token_budget(self) -> None:
        bypass_payload = {
            "threadId": "thr_1",
            "expectedTurnId": "turn_1",
            "tokenBudget": 5000,
            "omniaSteer": {"steerMode": "ADDITIVE_INTAKE"},
            "input": [{"type": "text", "text": "Additive follow-up"}],
        }
        res = validate_turn_steer_payload(bypass_payload)
        self.assertFalse(res["valid"])
        self.assertIn("FORBIDDEN_TOKEN_BUDGET_CAP", {e["code"] for e in res["errors"]})
        self.assertEqual([e["path"] for e in res["errors"]], ["$.tokenBudget"])

        nested_bypass = {
            "threadId": "thr_1",
            "expectedTurnId": "turn_1",
            "omniaSteer": {"steerMode": "ADDITIVE_INTAKE", "token_budget": 1200},
            "input": [{"type": "text", "text": "Additive follow-up"}],
        }
        nested_res = validate_turn_steer_payload(nested_bypass)
        self.assertFalse(nested_res["valid"])
        self.assertIn("FORBIDDEN_TOKEN_BUDGET_CAP", {e["code"] for e in nested_res["errors"]})
        self.assertEqual([e["path"] for e in nested_res["errors"]], ["$.omniaSteer.token_budget"])

    def test_non_mapping_omnia_steer_rejected(self) -> None:
        bad_omnia_steer = {
            "threadId": "thr_1",
            "expectedTurnId": "turn_1",
            "omniaSteer": ["not", "a", "mapping"],
            "input": [{"type": "text", "text": "Proceed"}],
        }
        res = validate_turn_steer_payload(bad_omnia_steer)
        self.assertFalse(res["valid"])
        self.assertIn("INVALID_OMNIA_STEER", {e["code"] for e in res["errors"]})
        self.assertEqual(res["errors"][0]["path"], "$.omniaSteer")

        null_omnia_steer = {
            "threadId": "thr_1",
            "expectedTurnId": "turn_1",
            "omniaSteer": None,
            "input": [{"type": "text", "text": "Proceed"}],
        }
        null_res = validate_turn_steer_payload(null_omnia_steer)
        self.assertTrue(null_res["valid"], msg=null_res["errors"])

    def test_explicit_user_budget_reflected_in_receipt_and_validated(self) -> None:
        explicit_payload = {
            "threadId": "thr_1",
            "expectedTurnId": "turn_1",
            "omniaSteer": {"steerMode": "ADDITIVE_INTAKE", "tokenBudget": 5000},
            "input": [{"type": "text", "text": "Bounded run requested explicitly"}],
        }
        res = validate_turn_steer_payload(explicit_payload, explicit_user_budget=True)
        self.assertTrue(res["valid"], msg=res["errors"])
        self.assertEqual(res["receipt"]["tokenBudget"], 5000)

        invalid_explicit = {
            "threadId": "thr_1",
            "expectedTurnId": "turn_1",
            "tokenBudget": True,
            "input": [{"type": "text", "text": "Bad explicit budget"}],
        }
        bad_res = validate_turn_steer_payload(invalid_explicit, explicit_user_budget=True)
        self.assertFalse(bad_res["valid"])
        self.assertIn("INVALID_TOKEN_BUDGET", {e["code"] for e in bad_res["errors"]})

        conflicting_explicit = {
            "threadId": "thr_1",
            "expectedTurnId": "turn_1",
            "tokenBudget": 5000,
            "omniaSteer": {"token_budget": 3000},
            "input": [{"type": "text", "text": "Conflicting budgets"}],
        }
        conflict_res = validate_turn_steer_payload(conflicting_explicit, explicit_user_budget=True)
        self.assertFalse(conflict_res["valid"])
        self.assertIn("CONFLICTING_TOKEN_BUDGET", {e["code"] for e in conflict_res["errors"]})


class OpencodeMappingTests(unittest.TestCase):
    """Tests for opencode provider, model, and tool mapping with zero-secret guarantees."""

    def test_provider_and_model_mapping_with_env_ref_and_utility_filtering(self) -> None:
        provider = {
            "id": "openai-main",
            "canonical": "openai",
            "name": "OpenAI Responses",
            "activation": "auto",
            "package": "@opencode/ai/providers/openai-responses",
            "settings": {
                "apiKey": "{env:OPENAI_API_KEY}",
                "baseURL": "https://api.openai.com/v1?ignored=1",
                "zeroDataRetention": True,
            },
        }
        models = [
            {
                "id": "gpt-5",
                "modelID": "gpt-5",
                "providerID": "openai-main",
                "name": "GPT-5",
                "type": "chat",
                "status": "active",
                "enabled": True,
                "capabilities": {
                    "tools": True,
                    "input": ["text", "image"],
                    "output": ["text"],
                    "structuredOutput": True,
                    "reasoning": True,
                },
                "limit": {"context": 400000, "output": 32768},
                "cost": [{"input": 1.25, "output": 10.0, "cache": {"read": 0.125, "write": 0.0}}],
            },
            {
                "id": "plugin:internal-helper",
                "modelID": "plugin:internal-helper",
                "providerID": "openai-main",
                "name": "Internal Helper",
                "enabled": True,
            },
        ]
        mapped = map_opencode_provider_and_models(provider, models)
        self.assertEqual(mapped["schemaVersion"], OMNIA_ROUTING_SCHEMA_VERSION)
        self.assertEqual(mapped["redactionPolicy"], OMNIA_REDACTION_POLICY)
        self.assertTrue(mapped["provider"]["credentialPresent"])
        self.assertEqual(mapped["provider"]["credentialRef"], "env:OPENAI_API_KEY")
        self.assertEqual(mapped["provider"]["endpointOrigin"], "https://api.openai.com")
        self.assertEqual(mapped["provider"]["privacyTier"], "zero_data_retention")
        self.assertEqual(len(mapped["candidates"]), 1)
        self.assertEqual(len(mapped["excludedModels"]), 1)
        self.assertEqual(mapped["excludedModels"][0]["id"], "plugin:internal-helper")

        cand = mapped["candidates"][0]
        self.assertEqual(cand["candidateId"], "openai-main:gpt-5")
        self.assertEqual(cand["adapterFamily"], "openai-responses")
        self.assertTrue(cand["capabilitiesFlags"]["vision"])
        self.assertTrue(cand["capabilitiesFlags"]["toolUse"])
        self.assertTrue(cand["capabilitiesFlags"]["structuredOutput"])
        self.assertEqual(cand["pricing"]["inputPerMillionMicrounits"], 1250000)
        self.assertEqual(cand["pricing"]["outputPerMillionMicrounits"], 10000000)
        self.assertEqual(cand["quotaState"]["kind"], "unknown")
        self.assertFalse(cand["healthVerified"])

    def test_inline_secrets_rejected_by_default_and_never_exported_when_redacted(self) -> None:
        raw_secret = "-".join(["sk", "proj", "UnitTestFixture0123456789"])
        bearer_secret = " ".join(["Bearer", "unittest_dummy_token_987654321"])
        url_with_creds = "https://" + "user" + ":" + "pass" + "@gateway.local:8443/v1?api_key=leak"
        provider_with_secret = {
            "id": "custom-gw",
            "package": "@opencode/ai/providers/openai",
            "settings": {
                "apiKey": raw_secret,
                "baseURL": url_with_creds,
            },
            "headers": {"Authorization": bearer_secret},
        }
        models = {
            "local-coder": {
                "name": "Local Coder",
                "capabilities": {"tools": {"supported": True}},
                "modalities": {"input": ["text"], "output": ["text"]},
                "limit": {"context": 128000, "output": 8192},
            }
        }
        with self.assertRaises(CompatContractError) as ctx:
            map_opencode_provider_and_models(provider_with_secret, models)
        self.assertEqual(ctx.exception.code, "INLINE_SECRET_REJECTED")

        redacted = map_opencode_provider_and_models(
            provider_with_secret,
            models,
            reject_inline_secrets=False,
        )
        serialized = json.dumps(redacted)
        self.assertNotIn(raw_secret, serialized)
        self.assertNotIn("unittest_dummy_token", serialized)
        self.assertNotIn("user:pass", serialized)
        self.assertNotIn("api_key=leak", serialized)
        self.assertTrue(redacted["provider"]["inlineSecretsStripped"])
        self.assertEqual(redacted["provider"]["credentialRef"], "redacted:inline_secret_omitted")
        self.assertEqual(redacted["provider"]["endpointOrigin"], "https://gateway.local:8443")

    def test_local_provider_privacy_tier_and_missing_cost_remain_honest(self) -> None:
        mapped = map_opencode_provider_and_models(
            {
                "id": "ollama-local",
                "package": "@opencode/ai/providers/openai",
                "settings": {"baseURL": "http://127.0.0.1:11434/v1"},
            },
            [
                {
                    "id": "qwen2.5-coder",
                    "name": "Qwen 2.5 Coder",
                    "capabilities": {"tools": False, "input": ["text"], "output": ["text"]},
                    "limit": {"context": 65536, "output": 8192},
                }
            ],
        )
        cand = mapped["candidates"][0]
        self.assertEqual(cand["privacyTier"], "local_only")
        self.assertEqual(cand["privacyLabel"], "strict_local_zero_retention")
        self.assertIsNone(cand["pricing"]["inputPerMillionMicrounits"])
        self.assertIsNone(cand["pricing"]["outputPerMillionMicrounits"])
        self.assertEqual(cand["quotaState"]["kind"], "unknown")

    def test_opencode_tool_descriptor_mapping_and_reserved_guards(self) -> None:
        mcp_tool = map_opencode_tool_descriptor({
            "name": "search.code",
            "namespace": "mcp__ripgrep",
            "description": "Search repo text",
            "options": {"codemode": True, "pinned": True, "permission": "fs_search"},
            "input": {"type": "object", "encrypted": True, "properties": {"query": {"type": "string"}}},
        })
        self.assertEqual(mcp_tool["namespace"], "mcp__ripgrep")
        self.assertEqual(mcp_tool["effectiveName"], "mcp__ripgrep_search.code".replace(".", "_"))
        self.assertEqual(mcp_tool["executionMode"], "codemode")
        self.assertTrue(mcp_tool["pinned"])
        self.assertEqual(mcp_tool["permissionAction"], "fs_search")
        self.assertNotIn("encrypted", mcp_tool["inputSchema"])

        reserved_exec = map_opencode_tool_descriptor({
            "id": "execute",
            "namespace": "functions",
            "options": {"codemode": False},
        })
        self.assertIsNone(reserved_exec["namespace"])
        self.assertEqual(reserved_exec["executionMode"], "native")
        self.assertIn("pseudo_namespace_functions_normalized_to_root", reserved_exec["warnings"])
        self.assertIn("reserved_codemode_identifier_execute_collision", reserved_exec["warnings"])


class CliRoundTripTests(unittest.TestCase):
    """End-to-end subprocess checks invoking cli.py under python -B."""

    def test_cli_validate_steer_and_map_provider_exit_codes(self) -> None:
        cli_path = str(MODULE_DIR / "cli.py")
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")

        valid_steer = json.dumps({
            "threadId": "thr_cli",
            "expectedTurnId": "turn_cli",
            "input": [{"type": "text", "text": "Additive task"}],
        })
        proc_ok = subprocess.run(
            [sys.executable, "-B", cli_path, "validate-steer", "--active-turn-id", "turn_cli"],
            input=valid_steer,
            text=True,
            capture_output=True,
            env=env,
            check=False,
        )
        self.assertEqual(proc_ok.returncode, 0, msg=proc_ok.stderr)
        parsed_ok = json.loads(proc_ok.stdout)
        self.assertTrue(parsed_ok["valid"])

        bad_steer = json.dumps({
            "threadId": "thr_cli",
            "expectedTurnId": "turn_stale",
            "tokenBudget": 500,
            "input": [],
        })
        proc_bad = subprocess.run(
            [sys.executable, "-B", cli_path, "validate-steer", "--active-turn-id", "turn_cli"],
            input=bad_steer,
            text=True,
            capture_output=True,
            env=env,
            check=False,
        )
        self.assertEqual(proc_bad.returncode, 2)
        parsed_bad = json.loads(proc_bad.stdout)
        self.assertFalse(parsed_bad["valid"])

        synthetic_key = "-".join(["sk", "test", "unit", "0123456789abcdef"])
        secret_provider = json.dumps({
            "provider": {"id": "p1", "settings": {"apiKey": synthetic_key}},
            "models": [],
        })
        proc_secret = subprocess.run(
            [sys.executable, "-B", cli_path, "map-provider"],
            input=secret_provider,
            text=True,
            capture_output=True,
            env=env,
            check=False,
        )
        self.assertEqual(proc_secret.returncode, 2)
        self.assertNotIn(synthetic_key, proc_secret.stderr + proc_secret.stdout)

    def test_cli_lower_responses_and_restore_sse_round_trip(self) -> None:
        import tempfile

        cli_path = str(MODULE_DIR / "cli.py")
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        req_obj = {
            "tools": [
                {
                    "type": "namespace",
                    "name": "mcp.docs",
                    "tools": [{"type": "function", "name": "lookup", "parameters": {"type": "object"}}],
                }
            ]
        }
        proc_lower = subprocess.run(
            [sys.executable, "-B", cli_path, "lower-responses"],
            input=json.dumps(req_obj),
            text=True,
            capture_output=True,
            env=env,
            check=False,
        )
        self.assertEqual(proc_lower.returncode, 0, msg=proc_lower.stderr)
        lowered_plan = json.loads(proc_lower.stdout)
        self.assertEqual(lowered_plan["payload"]["tools"][0]["name"], "mcp_docs_lookup")

        sse_text = (
            "event: response.output_item.done\n"
            + "data: "
            + json.dumps({
                "type": "response.output_item.done",
                "output_index": 0,
                "item": {
                    "type": "function_call",
                    "id": "fc_cli",
                    "call_id": "c_cli",
                    "name": "mcp_docs_lookup",
                    "arguments": "{}",
                },
            })
            + "\n\ndata: [DONE]\n"
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            tools_path = Path(tmpdir) / "plan.json"
            tools_path.write_text(json.dumps(lowered_plan), encoding="utf-8")
            proc_sse = subprocess.run(
                [sys.executable, "-B", cli_path, "restore-sse", "--tools", str(tools_path)],
                input=sse_text,
                text=True,
                capture_output=True,
                env=env,
                check=False,
            )
        self.assertEqual(proc_sse.returncode, 0, msg=proc_sse.stderr)
        self.assertIn('"namespace": "mcp.docs"', proc_sse.stdout)
        self.assertIn('"name": "lookup"', proc_sse.stdout)

    def test_cli_map_tool_outputs_normalized_descriptor(self) -> None:
        cli_path = str(MODULE_DIR / "cli.py")
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        tool_obj = {
            "name": "query_graph",
            "namespace": "mcp__graphify",
            "description": "Inspect structural graph",
            "options": {"codemode": True, "pinned": False},
        }
        proc_tool = subprocess.run(
            [sys.executable, "-B", cli_path, "map-tool"],
            input=json.dumps(tool_obj),
            text=True,
            capture_output=True,
            env=env,
            check=False,
        )
        self.assertEqual(proc_tool.returncode, 0, msg=proc_tool.stderr)
        mapped = json.loads(proc_tool.stdout)
        self.assertEqual(mapped["effectiveName"], "mcp__graphify_query_graph")
        self.assertEqual(mapped["executionMode"], "codemode")


if __name__ == "__main__":
    unittest.main()
