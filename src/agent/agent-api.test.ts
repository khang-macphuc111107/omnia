import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/desktop", () => ({ desktop: {}, invokeCore: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
import { invokeCore } from "@/lib/desktop";
import { agentApi } from "./agent-api";
beforeEach(() => { vi.clearAllMocks(); });
describe("native agent contracts", () => {
  it("loads and saves ordered session navigation with an exact native revision", async () => {
    await agentApi.navigationLoad();
    expect(invokeCore).toHaveBeenLastCalledWith("agent_session_navigation_load");
    await agentApi.navigationSave({ expectedRevision: 4, openIds: ["b", "a"], activeId: "a" });
    expect(invokeCore).toHaveBeenLastCalledWith("agent_session_navigation_save", { request: { expectedRevision: 4, openIds: ["b", "a"], activeId: "a" } });
  });
  it("exposes upstream integrations through a bounded renderer-safe catalog", () => {
    expect(agentApi.upstreamCapabilities.summary()).toMatchObject({ total: 55, categories: 10 });
    expect(agentApi.upstreamCapabilities.find("browser/chrome-canary")?.integrationMode).toBe("adapter-first");
    expect(agentApi.upstreamCapabilities.plan("cli/codex-cli")).toMatchObject({
      capabilityId: "cli/codex-cli",
      mode: "process-adapter",
      evidenceOnly: false,
    });
  });

  it("sends reviewed workspace trust as request cwd/fingerprint/trusted", async () => {
    await agentApi.workspaceTrust("C:\\project");
    expect(invokeCore).toHaveBeenLastCalledWith("agent_workspace_trust_status", { request: { cwd: "C:\\project" } });
    await agentApi.setWorkspaceTrust("C:\\project", "fingerprint", true);
    expect(invokeCore).toHaveBeenLastCalledWith("agent_workspace_trust_set", { request: { cwd: "C:\\project", fingerprint: "fingerprint", trusted: true } });
  });
  it("keeps passive MCP inspection distinct from explicit process restart", async () => {
    await agentApi.mcpStatus("s");
    expect(invokeCore).toHaveBeenLastCalledWith("agent_mcp_status", { request: { sessionId: "s" } });
    await agentApi.reloadMcp("s");
    expect(invokeCore).toHaveBeenLastCalledWith("agent_mcp_reload", { request: { sessionId: "s" } });
  });
  it("lists the session's resolved skills and subagent roles through the native bridge", async () => {
    await agentApi.skillsList("session-1");
    expect(invokeCore).toHaveBeenLastCalledWith("agent_skills_list", { request: { sessionId: "session-1" } });
    await agentApi.agentsList("session-1");
    expect(invokeCore).toHaveBeenLastCalledWith("agent_agents_list", { request: { sessionId: "session-1" } });
    await agentApi.pluginConnectionReceipts("session-1");
    expect(invokeCore).toHaveBeenLastCalledWith("agent_plugin_connection_receipts", { request: { sessionId: "session-1" } });
  });
  it("matches host services grant, global stop, and download-control contracts", async () => {
    await agentApi.servicesStatus("s");
    expect(invokeCore).toHaveBeenLastCalledWith("agent_services_status", { request: { sessionId: "s" } });
    await agentApi.setComputerPermission("s", true, true, ["notepad.exe"]);
    expect(invokeCore).toHaveBeenLastCalledWith("agent_computer_permission_set", { request: { sessionId: "s", capture: true, control: true, allowedApps: ["notepad.exe"] } });
    await agentApi.emergencyStopComputer();
    expect(invokeCore).toHaveBeenLastCalledWith("agent_computer_emergency_stop");
    await agentApi.downloadControl("s", "j", "resume");
    expect(invokeCore).toHaveBeenLastCalledWith("agent_download_control", { request: { sessionId: "s", jobId: "j", action: "resume" } });
  });
  it("matches host media list, user download start, and reveal contracts", async () => {
    await agentApi.mediaList("s");
    expect(invokeCore).toHaveBeenLastCalledWith("agent_media_list", { request: { sessionId: "s" } });
    await agentApi.downloadStart("s", { capturedRequestId: "r", kind: "hls" });
    expect(invokeCore).toHaveBeenLastCalledWith("agent_download_start", { request: { sessionId: "s", capturedRequestId: "r", kind: "hls" } });
    await agentApi.downloadReveal("s", "j");
    expect(invokeCore).toHaveBeenLastCalledWith("agent_download_reveal", { request: { sessionId: "s", jobId: "j" } });
    await agentApi.recordingsList("s");
    expect(invokeCore).toHaveBeenLastCalledWith("agent_recordings_list", { request: { sessionId: "s" } });
    await agentApi.recordingReveal("s", "C:/r/x");
    expect(invokeCore).toHaveBeenLastCalledWith("agent_recording_reveal", { request: { sessionId: "s", path: "C:/r/x" } });
  });
  it("serializes explicit null reasoning reset rather than omitting the field", async () => {
    await agentApi.update("s", { reasoningEffort: null });
    expect(invokeCore).toHaveBeenLastCalledWith("agent_session_update", { request: { sessionId: "s", reasoningEffort: null } });
  });
  it("preserves an explicit session settings CAS revision", async () => {
    await agentApi.update("s", { model: "reviewed-model", expectedSettingsRevision: 7 });
    expect(invokeCore).toHaveBeenLastCalledWith("agent_session_update", { request: { sessionId: "s", model: "reviewed-model", expectedSettingsRevision: 7 } });
  });
});

describe("Omnia MCP server contracts", () => {
  it("wraps enable/disable in a request and sends no port unless given", async () => {
    await agentApi.mcpServerStatus();
    expect(invokeCore).toHaveBeenLastCalledWith("agent_mcp_server_status");
    await agentApi.mcpServerSet(true);
    expect(invokeCore).toHaveBeenLastCalledWith("agent_mcp_server_set", { request: { enabled: true } });
    await agentApi.mcpServerSet(true, 4000);
    expect(invokeCore).toHaveBeenLastCalledWith("agent_mcp_server_set", { request: { enabled: true, port: 4000 } });
    await agentApi.mcpServerRotateToken();
    expect(invokeCore).toHaveBeenLastCalledWith("agent_mcp_server_rotate_token");
  });
});
