/**
 * DEV-ONLY browser mock backend. Installed by src/main.tsx through a dynamic
 * import guarded by `import.meta.env.DEV`, so production builds never contain it.
 *
 * It intercepts at the narrowest shared point: `window.__TAURI_INTERNALS__`
 * (what `invoke`/`listen` from @tauri-apps/api use), via the official
 * `@tauri-apps/api/mocks` helpers. Every Tauri command, event and window call
 * the shell makes is answered here; nothing touches a real backend or provider.
 */
import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

import { OMNIA_CLIENT_CAPABILITIES, OMNIA_PROTOCOL_VERSION } from "@/lib/core-protocol";

import { AGENT_EVENT } from "../agent-api";
import type { AgentEventPayload, AgentSessionSummary } from "../types";
import * as fx from "./fixtures";

type Args = unknown;

function req(args: Args): Record<string, unknown> {
  const request = args && typeof args === "object" ? (args as Record<string, unknown>)["request"] : undefined;
  return request && typeof request === "object" ? (request as Record<string, unknown>) : {};
}

export function parseScenario(search: string): fx.MockScenario | null {
  const params = new URLSearchParams(search);
  if (!params.has("mock")) return null;
  const value = params.get("mock") ?? "";
  if (value === "0" || value === "off" || value === "false") return null;
  return value === "empty" || value === "error" ? value : "long";
}

const log = new Set<string>();

function handler(scenario: fx.MockScenario) {
  const list = fx.sessions(scenario);
  let navigation = { schemaVersion: 1, revision: 0, openIds: [] as string[], activeId: null as string | null, updatedAtMs: 0 };
  return (cmd: string, args: Args): unknown => {
    const r = req(args);
    const sessionId = typeof r["sessionId"] === "string" ? r["sessionId"] : fx.ACTIVE_ID;
    switch (cmd) {
      case "runtime_info":
        return { appName: "Omnia", appVersion: "0.1.0-dev", platform: "windows", tauri: true, debug: true };
      case "core_initialize":
        return {
          protocolVersion: OMNIA_PROTOCOL_VERSION,
          serverInfo: { name: "omnia-dev-mock", title: "Omnia Dev Mock", version: "0.1.0-dev" },
          capabilities: [...OMNIA_CLIENT_CAPABILITIES],
          unavailableCapabilities: [],
          sessionToken: "0".repeat(63) + "1",
          sessionEpoch: 1,
        };
      case "agent_session_list":
        if (scenario === "error") {
          throw { code: "harness_unavailable", message: "Mock startup failure: the harness bridge could not open its database at C:\\Users\\khang\\AppData\\Roaming\\com.omnia.desktop\\agent\\sessions.sqlite3 (os error 32: the process cannot access the file because it is being used by another process)" };
        }
        return list;
      case "agent_session_read":
        return fx.sessionDetail(scenario, sessionId);
      case "agent_session_navigation_load":
        return { snapshot: navigation, receiptId: "mock-navigation-load" };
      case "agent_session_navigation_save": {
        if (r["expectedRevision"] !== navigation.revision) return { status: "conflict", snapshot: navigation, receiptId: "mock-navigation-conflict" };
        navigation = { schemaVersion: 1, revision: navigation.revision + 1, openIds: r["openIds"] as string[], activeId: r["activeId"] as string | null, updatedAtMs: Date.now() };
        return { status: "saved", snapshot: navigation, receiptId: "mock-navigation-save" };
      }
      case "agent_session_create": {
        const now = Date.now();
        const summary: AgentSessionSummary = { id: `s-new-${now}`, title: String(r["title"] ?? "New session"), cwd: String(r["cwd"] ?? "D:\\scratch"), profileId: String(r["profileId"] ?? "p-anthropic"), model: String(r["model"] ?? "claude-sonnet-4-5"), permissionMode: "ask_writes", messageCount: 0, createdAtMs: now, updatedAtMs: now };
        list.unshift({ ...summary, running: false });
        return summary;
      }
      case "agent_session_update":
      case "agent_fork": {
        const found = list.find((s) => s.id === sessionId) ?? list[0];
        const { running: _running, ...summary } = found ?? fx.sessions("long")[0]!;
        return { ...summary, ...r, id: summary.id };
      }
      case "agent_rewind":
        return fx.sessionDetail(scenario, sessionId);
      case "agent_prompt_presets_list":
      case "agent_prompt_preset_save":
      case "agent_prompt_preset_delete":
        return fx.presets;
      case "agent_schedules_list":
      case "agent_schedule_save":
      case "agent_schedule_delete":
        return fx.schedules;
      case "agent_schedule_preview": {
        const now = Date.now();
        return [now + 3_600_000, now + 7_200_000, now + 10_800_000];
      }
      case "agent_system_prompt_preview":
        return "You are Omnia, a coding agent.\n\n" + "System prompt line that is reasonably long to test wrapping. ".repeat(40);
      case "agent_permission_rules_list":
      case "agent_permission_rules_set":
        return fx.permissionRules;
      case "agent_permission_rules_test":
        return { decision: "ask", reason: "No rule matched; mode ask_writes asks for commands.", rule: null, mode: "ask_writes", effect: "process.execute", effectAssumed: true };
      case "agent_mcp_status":
      case "agent_mcp_reload":
        return fx.mcpStatus;
      case "agent_mcp_server_status":
      case "agent_mcp_server_set":
      case "agent_mcp_server_rotate_token":
        return fx.mcpServerInfo;
      case "agent_inspector_list":
        return fx.inspectorList;
      case "agent_inspector_get":
        return fx.inspectorExchange(Number(r["id"] ?? 1));
      case "agent_workspace_diff":
      case "agent_hunk_revert":
      case "agent_hunk_stage":
        return fx.diff;
      case "agent_artifacts_list":
        return fx.artifacts;
      case "agent_artifact_get":
        return fx.artifactContent(String(r["id"] ?? ""), typeof r["version"] === "number" ? r["version"] : undefined);
      case "agent_artifact_preview_url": {
        const content = fx.artifactContent(String(r["id"] ?? "")).content;
        return `data:text/html;charset=utf-8,${encodeURIComponent(content)}`;
      }
      case "agent_artifact_export":
        return null;
      case "agent_workspace_files":
        return ["src/agent/agent-shell.tsx", "src/agent/sidebar.tsx", "src/agent/a/very/deeply/nested/directory/structure/that/keeps/going/component-with-long-name.tsx", "docs/"].map((path) => ({ path, isDir: path.endsWith("/") }));
      case "agent_commands_list":
        return [
          { name: "review", description: "Review the current diff", argumentHint: "[level]" },
          { name: "very-long-custom-command-name-for-testing", description: "A long description that explains what this command does in quite some detail, maybe too much detail.", argumentHint: "<file> [--flag value] [--another-flag another-value]" },
        ];
      case "agent_plugins_list":
        return fx.plugins;
      case "agent_plugin_install":
        return fx.plugins[0];
      case "agent_services_status":
      case "agent_computer_permission_set":
      case "agent_browser_open_for_signin":
        return fx.services();
      case "agent_download_control":
      case "agent_download_start":
        return fx.downloads[0];
      case "agent_media_list":
        return fx.media;
      case "agent_recordings_list":
        return fx.recordings;
      case "agent_browser_settings_get":
      case "agent_browser_settings_set":
      case "agent_browser_clear_data":
        return { keepSignIns: true, profileInUse: false, ffmpeg: fx.services().ffmpeg };
      case "agent_workspace_trust_status":
      case "agent_workspace_trust_set":
        return {
          cwd: String(r["cwd"] ?? ""),
          fingerprint: "f".repeat(64),
          trusted: r["trusted"] === true,
          sources: [
            { path: `${String(r["cwd"] ?? "")}\\.omnia\\settings.json`, scope: "project" },
            { path: `${String(r["cwd"] ?? "")}\\.omnia\\hooks\\pre-tool-use-with-a-long-hook-name.ps1`, scope: "project" },
            { path: "C:\\Users\\khang\\.omnia\\settings.json", scope: "user" },
          ],
        };
      case "agent_pick_folder":
        return null;
      case "agent_data_export":
        return { path: "C:\\Users\\khang\\Documents\\omnia-export-20261101-101500", parts: [{ name: "sessions", count: 25, bytes: 1_234_567 }], totalBytes: 1_234_567, keysExcluded: true, excludedFiles: [] };
      case "agent_data_import":
        return { imported: { sessions: 3, presets: 1, files: 4, settings: 1 }, skipped: { sessions: 0, presets: 0, files: 0, settings: 0 }, conflicts: [], skippedSessionIds: [], backups: [], restartRequired: false };
      case "provider_profile_list":
        return fx.profiles;
      case "provider_models_list":
        return { profileId: String(r["profileId"] ?? ""), models: fx.models(String(r["profileId"] ?? "")), discoveredAt: new Date().toISOString() };
      case "voice_status":
        return fx.voiceStatus;
      case "update_get_settings":
      case "update_set_settings":
        return fx.updateSettings;
      case "update_check":
        return { current: "0.1.0-dev", latest: "0.1.0-dev", available: false, notes: "", size: 0, signatureVerified: false, candidate: 0, generation: 1, pubDate: null };
      case "agent_send":
        setTimeout(() => void stream(sessionId, 8), 50);
        return null;
      case "agent_interrupt":
        setTimeout(() => void send(sessionId, { type: "run_finished", status: "interrupted" }), 10);
        return null;
      default:
        // Window controls (plugin:window|*), voice start/stop, approvals, interrupts, deletes… are no-ops.
        if (!log.has(cmd)) {
          log.add(cmd);
          console.debug(`[dev-mock] unhandled command ${cmd} → null`);
        }
        if (/_list$/.test(cmd)) return [];
        return null;
    }
  };
}

let sequence = 10_000;

async function send(sessionId: string, event: AgentEventPayload["event"]) {
  sequence += 1;
  const payload: AgentEventPayload = { sessionId, event, sequence };
  await emit(AGENT_EVENT, payload);
}

async function stream(sessionId: string, ticks: number, delayMs = 900) {
  for (let tick = 0; tick < ticks; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    for (const event of fx.streamTick(tick)) await send(sessionId, event);
  }
}

/** Installs the mock; returns a callback to run once the app has mounted. */
export function installDevMock(scenario: fx.MockScenario): () => void {
  mockWindows("main");
  mockIPC(handler(scenario), { shouldMockEvents: true });
  console.info(`[dev-mock] Omnia browser mock backend active (scenario: ${scenario}). Use ?mock=long|empty|error, &stream=0, &split=1.`);
  const params = new URLSearchParams(window.location.search);
  return () => {
    if (scenario !== "long") return;
    void (async () => {
      const { useAgentStore } = await import("../agent-store");
      const ready = () => useAgentStore.getState().ready;
      while (!ready()) await new Promise((resolve) => setTimeout(resolve, 50));
      const target = params.get("session") ?? fx.ACTIVE_ID;
      await useAgentStore.getState().open(target);
      if (params.get("split") === "1") useAgentStore.getState().openInSplit(fx.SECOND_ID);
      if (params.get("stream") !== "0") void stream(target, 25);
    })();
  };
}
