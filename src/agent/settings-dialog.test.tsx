import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/desktop", () => ({ desktop: { saveProviderProfile: vi.fn(), deleteProviderProfile: vi.fn() } }));
vi.mock("./agent-api", () => ({ agentApi: { listProfiles: vi.fn(async () => []), pickFolder: vi.fn(), dataExport: vi.fn(), dataImport: vi.fn(), mcpServerStatus: vi.fn(async () => ({ enabled: false, url: null, token: null, port: 0 })), mcpServerSet: vi.fn(), mcpServerRotateToken: vi.fn(), pluginsList: vi.fn(async () => []), pluginSetEnabled: vi.fn(), pluginInstall: vi.fn(), pluginUninstall: vi.fn(), permissionRules: vi.fn(async () => ({ global: [], project: null, session: null, mode: null })), voiceStatus: vi.fn(async () => ({ supported: false, available: false, languages: [], systemLanguage: "en-US", micPermission: "unknown", speechPrivacyAccepted: false, listening: false })), voiceOpenSettings: vi.fn(async () => undefined) }, errorMessage: (cause: unknown) => String(cause) }));
vi.mock("./update-api", () => ({ updateApi: { getSettings: vi.fn(async () => ({ feedUrl: "", autoCheck: false, currentVersion: "0.1.0", keyConfigured: false, keyInvalid: false, keyFingerprint: null, allowUnsigned: false, unsignedAllowed: false, availableVersion: null, availableCandidate: null, pendingReset: false, generation: 0, platform: "windows-x86_64" })), setSettings: vi.fn(), check: vi.fn(), download: vi.fn(), install: vi.fn(), onEvent: vi.fn(async () => () => undefined) } }));
import { desktop } from "@/lib/desktop";
import { agentApi } from "./agent-api";
import { updateApi } from "./update-api";
import { SettingsDialog } from "./settings-dialog";
const api = vi.mocked(desktop);
beforeEach(() => { vi.clearAllMocks(); api.saveProviderProfile.mockResolvedValue({} as Awaited<ReturnType<typeof desktop.saveProviderProfile>>); });

function openSettingsSection(name: string) {
  fireEvent.click(screen.getByRole("tab", { name }));
}

describe("settings section navigation", () => {
  it("keeps chrome outside the scroll area and resets the section scroll on navigation", () => {
    render(<SettingsDialog onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog).toHaveClass("ag-settings-dialog");
    const content = dialog.querySelector<HTMLElement>(".ag-settings-content")!;
    expect(content).not.toContainElement(screen.getByRole("button", { name: "Close" }));
    expect(content).not.toContainElement(screen.getByRole("tablist"));
    content.scrollTop = 300;
    openSettingsSection("Appearance");
    expect(content.scrollTop).toBe(0);
  });

  it("wraps tab navigation, ignores modified arrows, and keeps one tab stop", () => {
    render(<SettingsDialog onClose={vi.fn()} />);
    const providers = screen.getByRole("tab", { name: "Providers" });
    fireEvent.keyDown(providers, { key: "ArrowDown", ctrlKey: true });
    expect(providers).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(providers, { key: "End" });
    const data = screen.getByRole("tab", { name: "Data" });
    fireEvent.keyDown(data, { key: "ArrowDown" });
    expect(providers).toHaveFocus();
    expect(screen.getAllByRole("tab").filter((tab) => tab.tabIndex === 0)).toEqual([providers]);
  });

  it("uses instance-specific tab and panel relationships", () => {
    render(<><SettingsDialog onClose={vi.fn()} /><SettingsDialog onClose={vi.fn()} /></>);
    const tabs = screen.getAllByRole("tab");
    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(tabs.length);
    for (const tab of tabs) {
      expect(document.getElementById(tab.getAttribute("aria-controls")!)).toHaveAttribute("aria-labelledby", tab.id);
    }
  });

  it("traps focus without including hidden panels, closes on Escape and restores focus", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const view = render(<SettingsDialog onClose={onClose} />);
    const close = screen.getByRole("button", { name: "Close" });
    await waitFor(() => expect(close).toHaveFocus());
    openSettingsSection("Appearance");
    fireEvent.keyDown(close, { key: "Tab" });
    expect(screen.getByRole("tab", { name: "Appearance" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
  it("shows one section at a time and updates selected tab accessibly", () => {
    render(<SettingsDialog onClose={vi.fn()} />);
    expect(screen.getByRole("tablist", { name: "Settings sections" })).toHaveAttribute("aria-orientation", "vertical");
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Providers");
    expect(screen.getByRole("tab", { name: "Providers" })).toHaveAttribute("aria-selected", "true");
    const appearancePanelId = screen.getByRole("tab", { name: "Appearance" }).getAttribute("aria-controls") ?? "";
    expect(document.getElementById(appearancePanelId)).toHaveAttribute("hidden");
    expect(screen.queryByRole("tabpanel", { name: "Appearance" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
    expect(screen.getByRole("tab", { name: "Appearance" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Appearance");
  });

  it("defers mount-time APIs of unvisited sections until their tab is selected", async () => {
    const lazyApi = agentApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    render(<SettingsDialog onClose={vi.fn()} />);
    await waitFor(() => expect(agentApi.listProfiles).toHaveBeenCalledTimes(1));
    // Let any stray mount effects flush before asserting they never ran.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agentApi.mcpServerStatus).not.toHaveBeenCalled();
    expect(agentApi.pluginsList).not.toHaveBeenCalled();
    expect(lazyApi.voiceStatus).not.toHaveBeenCalled();
    expect(lazyApi.permissionRules).not.toHaveBeenCalled();
    expect(updateApi.getSettings).not.toHaveBeenCalled();
    expect(updateApi.onEvent).not.toHaveBeenCalled();
    // Hidden panels still exist so every tab's aria-controls resolves.
    for (const tab of screen.getAllByRole("tab")) {
      expect(document.getElementById(tab.getAttribute("aria-controls") ?? "")).not.toBeNull();
    }

    openSettingsSection("MCP server");
    await waitFor(() => expect(agentApi.mcpServerStatus).toHaveBeenCalledTimes(1));
    openSettingsSection("Plugins");
    await waitFor(() => expect(agentApi.pluginsList).toHaveBeenCalledTimes(1));
    openSettingsSection("Voice");
    await waitFor(() => expect(lazyApi.voiceStatus).toHaveBeenCalledTimes(1));
    openSettingsSection("Permissions");
    await waitFor(() => expect(lazyApi.permissionRules).toHaveBeenCalledTimes(1));
    openSettingsSection("Updates");
    await waitFor(() => expect(updateApi.getSettings).toHaveBeenCalled());
    const updatesCalls = vi.mocked(updateApi.getSettings).mock.calls.length;

    // Reselecting visited tabs keeps them mounted instead of remounting.
    for (const name of ["Appearance", "MCP server", "Plugins", "Voice", "Permissions", "Updates", "Providers"]) {
      openSettingsSection(name);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agentApi.mcpServerStatus).toHaveBeenCalledTimes(1);
    expect(agentApi.pluginsList).toHaveBeenCalledTimes(1);
    expect(lazyApi.voiceStatus).toHaveBeenCalledTimes(1);
    expect(lazyApi.permissionRules).toHaveBeenCalledTimes(1);
    expect(updateApi.getSettings).toHaveBeenCalledTimes(updatesCalls);
    expect(agentApi.listProfiles).toHaveBeenCalledTimes(1);
  });

  it("keeps a visited section's draft state while it is hidden", async () => {
    render(<SettingsDialog onClose={vi.fn()} />);
    openSettingsSection("Plugins");
    fireEvent.change(await screen.findByLabelText("Git URL"), { target: { value: "https://example.com/draft.git" } });
    openSettingsSection("Data");
    openSettingsSection("Plugins");
    expect(screen.getByLabelText("Git URL")).toHaveValue("https://example.com/draft.git");
    expect(agentApi.pluginsList).toHaveBeenCalledTimes(1);
  });

  it("preserves an unsaved provider draft when switching settings sections", () => {
    render(<SettingsDialog onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "draft-only-secret" } });
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
    fireEvent.click(screen.getByRole("tab", { name: "Providers" }));
    expect(screen.getByLabelText("API key")).toHaveValue("draft-only-secret");
  });

  it("supports orientation-specific tab navigation with an accessible tablist", () => {
    const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
    try {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
      render(<SettingsDialog onClose={vi.fn()} />);
      const tablist = screen.getByRole("tablist", { name: "Settings sections" });
      expect(tablist).toHaveAttribute("aria-orientation", "vertical");
      const providers = screen.getByRole("tab", { name: "Providers" });
      fireEvent.keyDown(providers, { key: "ArrowDown" });
      const appearance = screen.getByRole("tab", { name: "Appearance" });
      expect(appearance).toHaveAttribute("aria-selected", "true");
      expect(appearance).toHaveFocus();
      fireEvent.keyDown(appearance, { key: "End" });
      expect(screen.getByRole("tab", { name: "Data" })).toHaveFocus();
      fireEvent.keyDown(screen.getByRole("tab", { name: "Data" }), { key: "Home" });
      expect(screen.getByRole("tab", { name: "Providers" })).toHaveFocus();

      Object.defineProperty(window, "innerWidth", { configurable: true, value: 600 });
      fireEvent(window, new Event("resize"));
      expect(tablist).toHaveAttribute("aria-orientation", "horizontal");
      fireEvent.keyDown(screen.getByRole("tab", { name: "Providers" }), { key: "ArrowRight" });
      expect(screen.getByRole("tab", { name: "Appearance" })).toHaveFocus();
      fireEvent.keyDown(screen.getByRole("tab", { name: "Appearance" }), { key: "ArrowLeft" });
      expect(screen.getByRole("tab", { name: "Providers" })).toHaveFocus();
    } finally {
      if (originalWidth) Object.defineProperty(window, "innerWidth", originalWidth);
      else Reflect.deleteProperty(window, "innerWidth");
      fireEvent(window, new Event("resize"));
    }
  });
});

describe("provider settings consent", () => {
  it("preserves long names, endpoints and input values without truncating their data", async () => {
    const name = "provider-".repeat(80);
    const url = `https://example.com/${"endpoint/".repeat(80)}`;
    vi.mocked(agentApi.listProfiles).mockResolvedValueOnce([{
      id: "long-profile", displayName: name, providerType: "openai_compatible", normalizedBaseUrl: url,
      credentialStatus: "missing",
    } as Awaited<ReturnType<typeof agentApi.listProfiles>>[number]]);
    render(<SettingsDialog onClose={vi.fn()} />);
    expect(await screen.findByText(name)).toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.classList.contains("ag-profile__meta") === true && element.textContent?.includes(url) === true)).toHaveTextContent(url);
    expect(screen.getByRole("button", { name: `Delete ${name}` })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: url } });
    expect(screen.getByLabelText("Base URL")).toHaveValue(url);
  });

  it("does not infer local-network consent from selecting a local provider", async () => {
    render(<SettingsDialog onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "local" } });
    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));
    await waitFor(() => expect(api.saveProviderProfile).toHaveBeenCalledWith(expect.objectContaining({ providerType: "local", allowLocalNetwork: false })));
  });
  it("passes explicit local-network consent and clears it when the endpoint changes", async () => {
    render(<SettingsDialog onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "local" } });
    const consent = screen.getByRole("checkbox");
    fireEvent.click(consent);
    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));
    await waitFor(() => expect(api.saveProviderProfile).toHaveBeenCalledWith(expect.objectContaining({ allowLocalNetwork: true })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save provider" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "http://127.0.0.1:1234/v1" } });
    expect(consent).not.toBeChecked();
  });
  it("does not carry a typed credential to a different provider preset", () => {
    render(<SettingsDialog onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "test-only-secret" } });
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "openai" } });
    expect(screen.getByLabelText("API key")).toHaveValue("");
  });
});

describe("data export and import", () => {
  const counts = { sessions: 0, presets: 0, files: 0, settings: 0 };
  const summary = { imported: { ...counts, sessions: 3 }, skipped: { ...counts, sessions: 1 }, conflicts: ["memory/notes.md"], skippedSessionIds: ["a"], backups: [], restartRequired: false };
  const mocked = vi.mocked(agentApi);

  it("exports to the picked folder and says keys are excluded", async () => {
    mocked.pickFolder.mockResolvedValue("D:/out");
    mocked.dataExport.mockResolvedValue({ path: "D:/out/omnia-export-1", parts: [{ name: "sessions", count: 2, bytes: 10 }], totalBytes: 2048, keysExcluded: true, excludedFiles: [] });
    render(<SettingsDialog onClose={vi.fn()} />);
    openSettingsSection("Data");
    expect(screen.getByText(/API keys and browser sign-ins are not\s+included/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export all data…" }));
    await waitFor(() => expect(mocked.dataExport).toHaveBeenCalledWith("D:/out"));
    expect(await screen.findByText(/omnia-export-1/)).toBeInTheDocument();
  });

  it("merges immediately and shows the summary", async () => {
    mocked.pickFolder.mockResolvedValue("D:/in");
    mocked.dataImport.mockResolvedValue(summary);
    render(<SettingsDialog onClose={vi.fn()} />);
    openSettingsSection("Data");
    fireEvent.click(screen.getByRole("button", { name: "Import…" }));
    await waitFor(() => expect(mocked.dataImport).toHaveBeenCalledWith("D:/in", "merge"));
    expect(await screen.findByText(/Imported 3 sessions/)).toBeInTheDocument();
    expect(screen.getByText(/memory\/notes\.md/)).toBeInTheDocument();
  });

  it("shows the native content-free import receipt for a different app version", async () => {
    mocked.pickFolder.mockResolvedValue("D:/in");
    mocked.dataImport.mockResolvedValue({
      ...summary,
      receipt: {
        schemaVersion: 1,
        id: "import_receipt_123",
        sourceManifestSha256: "a".repeat(64),
        sourceFormatVersion: 1,
        sourceAppVersion: "0.0.1",
        targetAppVersion: "0.1.0",
        appVersionChanged: true,
        mode: "merge",
        imported: summary.imported,
        skipped: summary.skipped,
        conflicts: [{ kind: "home-file", entityId: "memory/notes.md", incomingSha256: "b".repeat(64), existingSha256: "c".repeat(64), disposition: "kept-existing", reason: "different-content" }],
        backupCount: 0,
        restartRequired: false,
        completedAt: "2026-11-07T12:00:00Z",
      },
    });
    render(<SettingsDialog onClose={vi.fn()} />);
    openSettingsSection("Data");
    fireEvent.click(screen.getByRole("button", { name: "Import…" }));
    expect(await screen.findByText("Import receipt")).toBeInTheDocument();
    expect(screen.getByText(/Source format v1/)).toHaveTextContent("app version changed");
    expect(screen.getByText("import_receipt_123")).toBeInTheDocument();
  });

  it("cancels replace with Escape before dismissing Settings and restores the trigger", async () => {
    mocked.pickFolder.mockResolvedValue("D:/in");
    const onClose = vi.fn();
    render(<SettingsDialog onClose={onClose} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toHaveFocus());
    openSettingsSection("Data");
    fireEvent.change(screen.getByLabelText("Import mode"), { target: { value: "replace" } });
    const trigger = screen.getByRole("button", { name: "Import…" });
    trigger.focus();
    fireEvent.click(trigger);
    const confirmation = await screen.findByRole("alertdialog", { name: "Confirm replace" });
    const cancel = within(confirmation).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toHaveFocus());
    fireEvent.keyDown(cancel, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(mocked.dataImport).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("requires confirmation before a replace import", async () => {
    mocked.pickFolder.mockResolvedValue("D:/in");
    mocked.dataImport.mockResolvedValue(summary);
    render(<SettingsDialog onClose={vi.fn()} />);
    openSettingsSection("Data");
    fireEvent.change(screen.getByLabelText("Import mode"), { target: { value: "replace" } });
    fireEvent.click(screen.getByRole("button", { name: "Import…" }));
    await screen.findByRole("alertdialog");
    expect(mocked.dataImport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Replace and import" }));
    await waitFor(() => expect(mocked.dataImport).toHaveBeenCalledWith("D:/in", "replace"));
  });
});

describe("Omnia MCP server", () => {
  const mocked = vi.mocked(agentApi);
  const on = { enabled: true, url: "http://127.0.0.1:5123/mcp", token: "omnia_abc", port: 5123 };

  it("is off by default and warns about the token", async () => {
    render(<SettingsDialog onClose={vi.fn()} />);
    openSettingsSection("MCP server");
    const toggle = await screen.findByRole("switch", { name: "Enable Omnia MCP server" });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/any local app that has this token can control Omnia/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Token")).not.toBeInTheDocument();
  });

  it("enables the server and shows the URL, token and a ready-to-paste config", async () => {
    mocked.mcpServerSet.mockResolvedValue(on);
    render(<SettingsDialog onClose={vi.fn()} />);
    openSettingsSection("MCP server");
    const toggle = await screen.findByRole("switch", { name: "Enable Omnia MCP server" });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    await waitFor(() => expect(mocked.mcpServerSet).toHaveBeenCalledWith(true));
    expect(await screen.findByLabelText("URL")).toHaveValue(on.url);
    expect(screen.getByLabelText("Token")).toHaveValue("omnia_abc");
    expect(JSON.parse((screen.getByLabelText("MCP client configuration") as HTMLTextAreaElement).value)).toEqual({
      mcpServers: { omnia: { type: "http", url: on.url, headers: { Authorization: "Bearer omnia_abc" } } },
    });
  });

  it("copies the token and rotates it", async () => {
    mocked.mcpServerStatus.mockResolvedValueOnce(on);
    mocked.mcpServerRotateToken.mockResolvedValue({ ...on, token: "omnia_new" });
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<SettingsDialog onClose={vi.fn()} />);
    openSettingsSection("MCP server");
    fireEvent.click(await screen.findByRole("button", { name: "Copy token" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("omnia_abc"));
    fireEvent.click(screen.getByRole("button", { name: "Rotate token" }));
    await waitFor(() => expect(screen.getByLabelText("Token")).toHaveValue("omnia_new"));
  });

  it("shows a native failure and stays off", async () => {
    mocked.mcpServerSet.mockRejectedValue("Cannot listen on 127.0.0.1:80");
    render(<SettingsDialog onClose={vi.fn()} />);
    openSettingsSection("MCP server");
    const toggle = await screen.findByRole("switch", { name: "Enable Omnia MCP server" });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    expect(await screen.findByText(/Cannot listen/)).toBeInTheDocument();
    expect(toggle).not.toBeChecked();
  });
});

describe("plugins", () => {
  const mocked = vi.mocked(agentApi);
  const contents = { skills: 2, agents: 0, commands: 1, hooks: 1, mcpServers: 1 };
  const alpha = { name: "alpha", version: "1.2.0", description: "Demo plugin", author: null, scope: "user" as const, path: "C:/u/.omnia/plugins/alpha", enabled: true, contents };
  const beta = { ...alpha, name: "beta", version: "0.1.0", scope: "project" as const, enabled: false, contents: { ...contents, hooks: 0 } };

  it("groups plugins by scope with a contents summary", async () => {
    mocked.pluginsList.mockResolvedValue([alpha, beta]);
    render(<SettingsDialog onClose={vi.fn()} />);
    openSettingsSection("Plugins");
    const user = await screen.findByRole("group", { name: "Installed for you" });
    expect(user).toHaveTextContent("alpha");
    expect(user).toHaveTextContent("2 skills, 1 command, 1 hook, 1 MCP server");
    const project = screen.getByRole("group", { name: "In this workspace" });
    expect(project).toHaveTextContent("beta");
    expect(screen.queryByRole("button", { name: "Uninstall beta" })).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Enable plugin alpha" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Enable plugin beta" })).not.toBeChecked();
  });

  it("toggles a plugin and reloads the list", async () => {
    mocked.pluginsList.mockResolvedValueOnce([alpha]).mockResolvedValueOnce([{ ...alpha, enabled: false }]);
    mocked.pluginSetEnabled.mockResolvedValue(undefined);
    render(<SettingsDialog onClose={vi.fn()} />);
    openSettingsSection("Plugins");
    fireEvent.click(await screen.findByRole("switch", { name: "Enable plugin alpha" }));
    await waitFor(() => expect(mocked.pluginSetEnabled).toHaveBeenCalledWith("alpha", false));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Enable plugin alpha" })).not.toBeChecked());
  });

  it("asks for confirmation before uninstalling", async () => {
    mocked.pluginsList.mockResolvedValueOnce([alpha]).mockResolvedValueOnce([]);
    mocked.pluginUninstall.mockResolvedValue(undefined);
    render(<SettingsDialog onClose={vi.fn()} />);
    openSettingsSection("Plugins");
    fireEvent.click(await screen.findByRole("button", { name: "Uninstall alpha" }));
    await screen.findByRole("alertdialog", { name: "Confirm uninstall" });
    expect(mocked.pluginUninstall).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
    await waitFor(() => expect(mocked.pluginUninstall).toHaveBeenCalledWith("alpha"));
    expect(await screen.findByText(/Uninstalled alpha/)).toBeInTheDocument();
    expect(screen.getByText("No plugins installed.")).toBeInTheDocument();
  });

  it("installs from a picked folder", async () => {
    mocked.pluginsList.mockResolvedValueOnce([]).mockResolvedValueOnce([alpha]);
    mocked.pickFolder.mockResolvedValue("D:/plugins/alpha");
    mocked.pluginInstall.mockResolvedValue(alpha);
    render(<SettingsDialog onClose={vi.fn()} />);
    openSettingsSection("Plugins");
    fireEvent.click(await screen.findByRole("button", { name: "Install from folder…" }));
    await waitFor(() => expect(mocked.pluginInstall).toHaveBeenCalledWith("D:/plugins/alpha", false));
    expect(await screen.findByText(/Installed alpha 1\.2\.0/)).toBeInTheDocument();
    expect(await screen.findByRole("group", { name: "Installed for you" })).toBeInTheDocument();
  });

  it("does nothing when the folder picker is cancelled", async () => {
    mocked.pickFolder.mockResolvedValue(null);
    render(<SettingsDialog onClose={vi.fn()} />);
    openSettingsSection("Plugins");
    fireEvent.click(await screen.findByRole("button", { name: "Install from folder…" }));
    await waitFor(() => expect(mocked.pickFolder).toHaveBeenCalled());
    expect(mocked.pluginInstall).not.toHaveBeenCalled();
  });

  it("installs from a git URL and offers replace when already installed", async () => {
    mocked.pluginsList.mockResolvedValue([alpha]);
    mocked.pluginInstall.mockRejectedValueOnce("plugin `alpha` is already installed");
    render(<SettingsDialog onClose={vi.fn()} />);
    openSettingsSection("Plugins");
    const submit = await screen.findByRole("button", { name: "Install from git URL" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Git URL"), { target: { value: " https://example.com/a/alpha.git " } });
    fireEvent.click(submit);
    await waitFor(() => expect(mocked.pluginInstall).toHaveBeenCalledWith("https://example.com/a/alpha.git", false));
    await screen.findByRole("alertdialog", { name: "Confirm replace plugin" });
    mocked.pluginInstall.mockResolvedValueOnce(alpha);
    fireEvent.click(screen.getByRole("button", { name: "Replace plugin" }));
    await waitFor(() => expect(mocked.pluginInstall).toHaveBeenLastCalledWith("https://example.com/a/alpha.git", true));
  });

  it("shows install failures", async () => {
    mocked.pluginInstall.mockRejectedValue("git clone failed: not found");
    render(<SettingsDialog onClose={vi.fn()} />);
    openSettingsSection("Plugins");
    fireEvent.change(await screen.findByLabelText("Git URL"), { target: { value: "https://example.com/x.git" } });
    fireEvent.click(screen.getByRole("button", { name: "Install from git URL" }));
    expect(await screen.findByText(/git clone failed/)).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});

describe("voice settings", () => {
  const synth = { speak: vi.fn(), cancel: vi.fn(), getVoices: vi.fn(() => [{ voiceURI: "en-1", name: "Zira", lang: "en-US" }]), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  beforeEach(() => {
    const data = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, String(v)), removeItem: (k: string) => void data.delete(k), clear: () => data.clear() },
    });
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
    vi.stubGlobal("SpeechSynthesisUtterance", class { text: string; constructor(text: string) { this.text = text; } });
    Object.assign(agentApi, {
      voiceStatus: vi.fn(async () => ({ supported: true, available: true, languages: [{ tag: "vi-VN", name: "Vietnamese" }], systemLanguage: "en-US", micPermission: "allowed", speechPrivacyAccepted: true, listening: false })),
      voiceOpenSettings: vi.fn(async () => undefined),
    });
  });

  it("persists dictation language, voice, rate and auto-read", async () => {
    render(<SettingsDialog onClose={vi.fn()} />);
    openSettingsSection("Voice");
    await screen.findByRole("option", { name: "Vietnamese (vi-VN)" });
    fireEvent.change(screen.getByLabelText("Dictation language"), { target: { value: "vi-VN" } });
    fireEvent.change(screen.getByLabelText("Read-aloud voice"), { target: { value: "en-1" } });
    fireEvent.change(screen.getByLabelText(/Speaking rate/), { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("switch", { name: /Read the final answer aloud/ }));
    expect(JSON.parse(window.localStorage.getItem("omnia.agent.prefs.v1") ?? "{}")).toMatchObject({
      voiceLanguage: "vi-VN", speechVoiceURI: "en-1", speechRate: 1.5, autoRead: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview voice" }));
    expect(synth.speak).toHaveBeenCalledTimes(1);
  });

  it("opens the Windows privacy pages and reports status", async () => {
    render(<SettingsDialog onClose={vi.fn()} />);
    openSettingsSection("Voice");
    expect(await screen.findByText(/Microphone access: allowed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open microphone settings" }));
    await waitFor(() => expect(agentApi.voiceOpenSettings).toHaveBeenCalledWith("microphone"));
  });
});
