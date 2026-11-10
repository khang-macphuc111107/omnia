import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { ModalSurface } from "@/components/modal-surface";
import { desktop, type ProviderProfileRecord } from "@/lib/desktop";

import { agentApi, errorMessage } from "./agent-api";
import { useAgentStore } from "./agent-store";
import { PermissionRulesManager } from "./permission-rules";
import {
  DENSITIES,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FONT_SCALE_STEP,
  THEMES,
  applyAgentAppearance,
  readAgentAppearance,
  writeAgentAppearance,
  type AgentAppearance,
  type AgentDensity,
  type AgentTheme,
} from "./appearance";
import { readPrefs, writePrefs } from "./prefs";
import {
  SPEECH_RATE_MAX,
  SPEECH_RATE_MIN,
  SPEECH_RATE_STEP,
  listVoices,
  onVoicesChanged,
  readVoicePrefs,
  speakMarkdown,
  speechSynthesisAvailable,
  stopSpeaking,
  writeVoicePrefs,
  type VoicePrefs,
  type VoiceStatus,
} from "./voice";
import { UpdatesSection } from "./updates";
import "./settings-dialog.css";
import type { DataImportMode, DataImportSummary, McpServerInfo, PluginInfo } from "./types";
import { readRuntimeSettings, writeRuntimeSettings, REASONING_EFFORTS, type OmniaRetryPolicy, type OmniaRuntimeSettings } from "./runtime-settings";

const PROVIDER_TYPES = [
  { value: "anthropic", label: "Anthropic", url: "https://api.anthropic.com", auth: "api_key_header" },
  { value: "openai", label: "OpenAI", url: "https://api.openai.com/v1", auth: "bearer" },
  { value: "deepseek", label: "DeepSeek", url: "https://api.deepseek.com", auth: "bearer" },
  { value: "openai_compatible", label: "OpenAI-compatible", url: "", auth: "bearer" },
  { value: "local", label: "Local model", url: "http://127.0.0.1:11434/v1", auth: "none" },
] as const;

function ProfileForm({ onSaved }: { onSaved: () => void }) {
  const [type, setType] = useState<(typeof PROVIDER_TYPES)[number]["value"]>("anthropic");
  const preset = PROVIDER_TYPES.find((entry) => entry.value === type) ?? PROVIDER_TYPES[0];
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState<string>(preset.url);
  const [secret, setSecret] = useState("");
  const [allowLocalNetwork, setAllowLocalNetwork] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await desktop.saveProviderProfile({
        providerType: type,
        displayName: name.trim() || preset.label,
        baseUrl: baseUrl.trim(),
        authScheme: preset.auth,
        ...(secret ? { secret } : {}),
        allowLocalNetwork,
      });
      setName("");
      setSecret("");
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="ag-profile-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h3 className="ag-subtitle">Add a provider</h3>
      <div className="ag-field">
        <label className="ag-label" htmlFor={`${id}-type`}>
          Type
        </label>
        <select
          id={`${id}-type`}
          className="ag-input"
          value={type}
          onChange={(event) => {
            const next = PROVIDER_TYPES.find((entry) => entry.value === event.target.value) ?? PROVIDER_TYPES[0];
            setType(next.value);
            setBaseUrl(next.url);
            setSecret("");
            setAllowLocalNetwork(false);
          }}
        >
          {PROVIDER_TYPES.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>
      <div className="ag-field">
        <label className="ag-label" htmlFor={`${id}-name`}>
          Name
        </label>
        <input id={`${id}-name`} className="ag-input" value={name} placeholder={preset.label} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="ag-field">
        <label className="ag-label" htmlFor={`${id}-url`}>
          Base URL
        </label>
        <input id={`${id}-url`} className="ag-input" value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setAllowLocalNetwork(false); }} />
      </div>
      <label className="ag-row">
        <input type="checkbox" checked={allowLocalNetwork} onChange={(event) => setAllowLocalNetwork(event.target.checked)} />
        Allow this provider endpoint to connect to loopback or private-network addresses. This can expose prompts to a local service.
      </label>
      {type !== "local" ? (
        <div className="ag-field">
          <label className="ag-label" htmlFor={`${id}-key`}>
            API key
          </label>
          <input
            id={`${id}-key`}
            className="ag-input"
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          <p className="ag-muted">Saved through the native system credential store; not persisted in renderer preferences.</p>
        </div>
      ) : null}
      {error ? (
        <p className="ag-error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className="ag-btn ag-btn--primary" disabled={busy || !baseUrl.trim()}>
        Save provider
      </button>
    </form>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function SettingsConfirmation({ label, onCancel, children }: { label: string; onCancel: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const trigger = document.activeElement;
    ref.current?.querySelector<HTMLButtonElement>("button:last-of-type")?.focus();
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return (
    <div ref={ref} role="alertdialog" aria-label={label} onKeyDown={(event) => {
      if (event.key === "Escape" && !event.nativeEvent.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    }}>
      {children}
    </div>
  );
}

function DataSection() {
  const [mode, setMode] = useState<DataImportMode>("merge");
  const [pendingDir, setPendingDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [summary, setSummary] = useState<DataImportSummary | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    setSummary(null);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const exportAll = () =>
    run(async () => {
      const dir = await agentApi.pickFolder();
      if (!dir) return;
      const result = await agentApi.dataExport(dir);
      const counts = result.parts.map((part) => `${part.count} ${part.name}`).join(", ");
      setMessage(`Exported to ${result.path} (${formatBytes(result.totalBytes)}): ${counts}.`);
    });

  const runImport = (dir: string) =>
    run(async () => {
      setPendingDir(null);
      setSummary(await agentApi.dataImport(dir, mode));
    });

  const importData = () =>
    run(async () => {
      const dir = await agentApi.pickFolder();
      if (!dir) return;
      if (mode === "replace") {
        setPendingDir(dir);
        return;
      }
      setSummary(await agentApi.dataImport(dir, mode));
    });

  return (
    <section aria-labelledby="ag-data-title">
      <h3 className="ag-subtitle" id="ag-data-title">
        Data
      </h3>
      <p className="ag-muted">
        Sessions, prompt presets, browser settings and your ~/.omnia config. API keys and browser sign-ins are not
        included.
      </p>
      <div className="ag-row">
        <button type="button" className="ag-btn" disabled={busy} onClick={() => void exportAll()}>
          Export all data…
        </button>
        <button type="button" className="ag-btn" disabled={busy} onClick={() => void importData()}>
          Import…
        </button>
        <select
          className="ag-input"
          aria-label="Import mode"
          value={mode}
          onChange={(event) => {
            setMode(event.target.value as DataImportMode);
            setPendingDir(null);
          }}
        >
          <option value="merge">Merge (keep existing)</option>
          <option value="replace">Replace (back up existing)</option>
        </select>
      </div>
      {pendingDir ? (
        <SettingsConfirmation label="Confirm replace" onCancel={() => setPendingDir(null)}>
          <p className="ag-muted">
            Replace your sessions, presets and ~/.omnia config with the contents of {pendingDir}? The current
            ~/.omnia folder is backed up first.
          </p>
          <button type="button" className="ag-btn ag-btn--primary" disabled={busy} onClick={() => void runImport(pendingDir)}>
            Replace and import
          </button>{" "}
          <button type="button" className="ag-btn" onClick={() => setPendingDir(null)}>
            Cancel
          </button>
        </SettingsConfirmation>
      ) : null}
      {message ? (
        <p className="ag-muted" role="status">
          {message}
        </p>
      ) : null}
      {summary ? (
        <div role="status">
          <p className="ag-muted">
            Imported {summary.imported.sessions} sessions, {summary.imported.presets} presets, {summary.imported.files}{" "}
            files. Skipped {summary.skipped.sessions} sessions, {summary.skipped.presets} presets,{" "}
            {summary.skipped.files} files.
            {summary.restartRequired ? " Restart Omnia to apply browser settings." : ""}
          </p>
          {summary.conflicts.length > 0 ? (
            <p className="ag-muted">Kept existing (conflicts): {summary.conflicts.join(", ")}</p>
          ) : null}
          {summary.receipt ? (
            <details className="ag-muted">
              <summary>Import receipt</summary>
              <p>
                Source format v{summary.receipt.sourceFormatVersion} · {summary.receipt.appVersionChanged ? "app version changed" : "same app version"} · {summary.receipt.conflicts.length} hashed conflict{summary.receipt.conflicts.length === 1 ? "" : "s"} · manifest <code>{summary.receipt.sourceManifestSha256.slice(0, 16)}…</code>
              </p>
              <p>Receipt <code>{summary.receipt.id}</code> completed {summary.receipt.completedAt}.</p>
            </details>
          ) : null}
          {summary.backups.length > 0 ? <p className="ag-muted">Backups: {summary.backups.join(", ")}</p> : null}
        </div>
      ) : null}
      {error ? (
        <p className="ag-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function mcpClientSnippet(info: McpServerInfo): string {
  return JSON.stringify(
    {
      mcpServers: {
        omnia: {
          type: "http",
          url: info.url ?? "",
          headers: { Authorization: `Bearer ${info.token ?? ""}` },
        },
      },
    },
    null,
    2,
  );
}

function McpServerSection() {
  const [info, setInfo] = useState<McpServerInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    agentApi
      .mcpServerStatus()
      .then((next) => live && setInfo(next))
      .catch((cause) => live && setError(errorMessage(cause)));
    return () => {
      live = false;
    };
  }, []);

  const run = async (action: () => Promise<McpServerInfo>) => {
    setBusy(true);
    setError(null);
    try {
      setInfo(await action());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
    } catch {
      setError("Copy failed; select the text and copy it manually.");
    }
  };

  const enabled = info?.enabled === true;
  return (
    <section aria-labelledby="ag-mcp-server-title">
      <h3 className="ag-subtitle" id="ag-mcp-server-title">
        Omnia MCP server
      </h3>
      <p className="ag-muted">
        Lets other apps on this computer list, read and drive Omnia sessions over MCP. Off by default; listens on
        127.0.0.1 only.
      </p>
      <label className="ag-row">
        <input
          type="checkbox"
          role="switch"
          aria-label="Enable Omnia MCP server"
          checked={enabled}
          disabled={busy || info === null}
          onChange={(event) => void run(() => agentApi.mcpServerSet(event.target.checked))}
        />
        Enable Omnia MCP server
      </label>
      <p className="ag-error" role="note">
        Warning: any local app that has this token can control Omnia, including sending messages that run tools in
        your workspaces. Keep it secret and rotate it if it leaks.
      </p>
      {enabled && info ? (
        <div>
          <div className="ag-field">
            <label className="ag-label" htmlFor="ag-mcp-url">
              URL
            </label>
            <div className="ag-row">
              <input id="ag-mcp-url" className="ag-input" readOnly value={info.url ?? ""} />
              <button type="button" className="ag-btn" onClick={() => void copy("url", info.url ?? "")}>
                Copy URL
              </button>
            </div>
          </div>
          <div className="ag-field">
            <label className="ag-label" htmlFor="ag-mcp-token">
              Token
            </label>
            <div className="ag-row">
              <input id="ag-mcp-token" className="ag-input" readOnly value={info.token ?? ""} />
              <button type="button" className="ag-btn" onClick={() => void copy("token", info.token ?? "")}>
                Copy token
              </button>
              <button type="button" className="ag-btn" disabled={busy} onClick={() => void run(() => agentApi.mcpServerRotateToken())}>
                Rotate token
              </button>
            </div>
          </div>
          <div className="ag-field">
            <label className="ag-label" htmlFor="ag-mcp-snippet">
              MCP client configuration
            </label>
            <textarea id="ag-mcp-snippet" className="ag-input" readOnly rows={9} value={mcpClientSnippet(info)} />
            <button type="button" className="ag-btn" onClick={() => void copy("config", mcpClientSnippet(info))}>
              Copy configuration
            </button>
          </div>
          {copied ? (
            <p className="ag-muted" role="status">
              Copied {copied}.
            </p>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p className="ag-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function contentsSummary(plugin: PluginInfo): string {
  const { skills, agents, commands, hooks, mcpServers } = plugin.contents;
  const counts: Array<[number, string]> = [
    [skills, "skill"],
    [agents, "agent"],
    [commands, "command"],
    [hooks, "hook"],
    [mcpServers, "MCP server"],
  ];
  const parts = counts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}${count === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(", ") : "empty";
}

const PLUGIN_SCOPES: Array<{ scope: PluginInfo["scope"]; title: string }> = [
  { scope: "user", title: "Installed for you" },
  { scope: "project", title: "In this workspace" },
];

function PluginsSection() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [gitUrl, setGitUrl] = useState("");
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPlugins(await agentApi.pluginsList());
  }, []);

  useEffect(() => {
    let live = true;
    agentApi
      .pluginsList()
      .then((list) => live && setPlugins(list))
      .catch((cause) => live && setError(errorMessage(cause)));
    return () => {
      live = false;
    };
  }, []);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const installSource = async (source: string, replace: boolean) => {
    setConfirmReplace(null);
    try {
      const plugin = await agentApi.pluginInstall(source, replace);
      setMessage(`Installed ${plugin.name} ${plugin.version}. It applies from the next run.`);
      setGitUrl("");
      await load();
    } catch (cause) {
      if (!replace && /already installed/i.test(errorMessage(cause))) {
        setConfirmReplace(source);
        return;
      }
      throw cause;
    }
  };

  const installFromFolder = () =>
    run(async () => {
      const dir = await agentApi.pickFolder();
      if (!dir) return;
      await installSource(dir, false);
    });

  const toggle = (plugin: PluginInfo, enabled: boolean) =>
    run(async () => {
      await agentApi.pluginSetEnabled(plugin.name, enabled);
      await load();
    });

  const uninstall = (name: string) =>
    run(async () => {
      setConfirmUninstall(null);
      await agentApi.pluginUninstall(name);
      setMessage(`Uninstalled ${name}. The folder was moved to ~/.omnia/plugins/.trash.`);
      await load();
    });

  return (
    <section aria-labelledby="ag-plugins-title">
      <h3 className="ag-subtitle" id="ag-plugins-title">
        Plugins
      </h3>
      <p className="ag-muted">
        A plugin bundles skills, agents, commands, hooks and MCP servers. Hooks and MCP servers run code on this
        computer, so install only plugins you trust. Changes apply from the next run.
      </p>
      {plugins.length === 0 ? <p className="ag-muted">No plugins installed.</p> : null}
      {PLUGIN_SCOPES.map(({ scope, title }) => {
        const group = plugins.filter((plugin) => plugin.scope === scope);
        if (group.length === 0) return null;
        return (
          <div key={scope} role="group" aria-label={title}>
            <p className="ag-label">{title}</p>
            <ul className="ag-profiles">
              {group.map((plugin) => (
                <li key={`${scope}:${plugin.name}`} className="ag-profile">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={`Enable plugin ${plugin.name}`}
                    checked={plugin.enabled}
                    disabled={busy}
                    onChange={(event) => void toggle(plugin, event.target.checked)}
                  />
                  <span className="ag-profile__name">
                    {plugin.name} <span className="ag-muted">v{plugin.version}</span>
                  </span>
                  <span className="ag-muted ag-profile__meta" title={plugin.description || undefined}>
                    {contentsSummary(plugin)}
                    {plugin.description ? ` · ${plugin.description}` : ""}
                  </span>
                  {plugin.scope === "user" ? (
                    <button
                      type="button"
                      className="ag-icon-btn"
                      aria-label={`Uninstall ${plugin.name}`}
                      disabled={busy}
                      onClick={() => setConfirmUninstall(plugin.name)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {confirmUninstall ? (
        <SettingsConfirmation label="Confirm uninstall" onCancel={() => setConfirmUninstall(null)}>
          <p className="ag-muted">
            Uninstall {confirmUninstall}? Its folder is moved to ~/.omnia/plugins/.trash, so you can restore it by hand.
          </p>
          <button type="button" className="ag-btn ag-btn--primary" disabled={busy} onClick={() => void uninstall(confirmUninstall)}>
            Uninstall
          </button>{" "}
          <button type="button" className="ag-btn" onClick={() => setConfirmUninstall(null)}>
            Cancel
          </button>
        </SettingsConfirmation>
      ) : null}
      {confirmReplace ? (
        <SettingsConfirmation label="Confirm replace plugin" onCancel={() => setConfirmReplace(null)}>
          <p className="ag-muted">
            A plugin with this name is already installed. Replace it with {confirmReplace}? The old copy is moved to
            ~/.omnia/plugins/.trash.
          </p>
          <button
            type="button"
            className="ag-btn ag-btn--primary"
            disabled={busy}
            onClick={() => void run(() => installSource(confirmReplace, true))}
          >
            Replace plugin
          </button>{" "}
          <button type="button" className="ag-btn" onClick={() => setConfirmReplace(null)}>
            Cancel
          </button>
        </SettingsConfirmation>
      ) : null}
      <div className="ag-row">
        <button type="button" className="ag-btn" disabled={busy} onClick={() => void installFromFolder()}>
          Install from folder…
        </button>
      </div>
      <form
        className="ag-row"
        onSubmit={(event) => {
          event.preventDefault();
          if (gitUrl.trim()) void run(() => installSource(gitUrl.trim(), false));
        }}
      >
        <input
          className="ag-input"
          aria-label="Git URL"
          placeholder="https://github.com/owner/plugin.git"
          value={gitUrl}
          onChange={(event) => setGitUrl(event.target.value)}
        />
        <button type="submit" className="ag-btn" disabled={busy || gitUrl.trim() === ""}>
          Install from git URL
        </button>
      </form>
      {message ? (
        <p className="ag-muted" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="ag-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function VoiceSection() {
  const id = useId();
  const [prefs, setPrefs] = useState<VoicePrefs>(readVoicePrefs);
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(listVoices);
  const canSpeak = speechSynthesisAvailable();

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => agentApi.voiceStatus())
      .then((value) => live && setStatus(value))
      .catch((cause) => live && setStatusError(errorMessage(cause)));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => onVoicesChanged(() => setVoices(listVoices())), []);
  useEffect(() => () => stopSpeaking(), []);

  const update = (patch: Partial<VoicePrefs>) => setPrefs(writeVoicePrefs(patch));
  const openSettings = (target: "speech" | "microphone") => {
    Promise.resolve()
      .then(() => agentApi.voiceOpenSettings(target))
      .catch((cause) => setStatusError(errorMessage(cause)));
  };

  return (
    <section aria-labelledby="ag-voice-title">
      <h3 className="ag-subtitle" id="ag-voice-title">
        Voice
      </h3>
      <div className="ag-field">
        <label className="ag-label" htmlFor={`${id}-language`}>
          Dictation language
        </label>
        <select
          id={`${id}-language`}
          className="ag-input"
          value={prefs.language}
          onChange={(event) => update({ language: event.target.value })}
        >
          <option value="">Windows default{status?.systemLanguage ? ` (${status.systemLanguage})` : ""}</option>
          {(status?.languages ?? []).map((language) => (
            <option key={language.tag} value={language.tag}>
              {language.name} ({language.tag})
            </option>
          ))}
        </select>
        <p className="ag-muted">
          Dictate into the message box with the microphone button or Ctrl+Shift+Space (tap to toggle, hold for push-to-talk).
          Omnia uses the Windows speech recognizer and never the browser&apos;s online Web Speech API. Windows may still send
          audio to Microsoft&apos;s speech service while &quot;Online speech recognition&quot; is turned on in Windows privacy
          settings.
        </p>
        {status ? (
          <p className="ag-muted" role="status">
            {!status.supported
              ? "Dictation is not available on this platform."
              : !status.available
                ? "No dictation language is installed. Add a language with speech support in Windows settings."
                : "Dictation is available."}{" "}
            Microphone access: {status.micPermission}.{" "}
            {status.speechPrivacyAccepted === false
              ? "Online speech recognition is off in Windows, so dictation will not start."
              : null}
          </p>
        ) : null}
        {statusError ? (
          <p className="ag-error" role="alert">
            {statusError}
          </p>
        ) : null}
        <div className="ag-row">
          <button type="button" className="ag-btn" onClick={() => openSettings("speech")}>
            Open speech settings
          </button>
          <button type="button" className="ag-btn" onClick={() => openSettings("microphone")}>
            Open microphone settings
          </button>
        </div>
      </div>
      {canSpeak ? (
        <>
          <div className="ag-field">
            <label className="ag-label" htmlFor={`${id}-voice`}>
              Read-aloud voice
            </label>
            <select
              id={`${id}-voice`}
              className="ag-input"
              value={prefs.voiceURI}
              onChange={(event) => update({ voiceURI: event.target.value })}
            >
              <option value="">System default</option>
              {voices.map((voice) => (
                <option key={voice.voiceURI} value={voice.voiceURI}>
                  {voice.name} ({voice.lang})
                </option>
              ))}
            </select>
          </div>
          <div className="ag-field">
            <label className="ag-label" htmlFor={`${id}-rate`}>
              Speaking rate: {prefs.rate.toFixed(1)}x
            </label>
            <input
              id={`${id}-rate`}
              type="range"
              min={SPEECH_RATE_MIN}
              max={SPEECH_RATE_MAX}
              step={SPEECH_RATE_STEP}
              value={prefs.rate}
              onChange={(event) => update({ rate: Number(event.target.value) })}
            />
          </div>
          <label className="ag-row">
            <input
              type="checkbox"
              role="switch"
              checked={prefs.autoRead}
              onChange={(event) => update({ autoRead: event.target.checked })}
            />
            Read the final answer aloud when a run finishes
          </label>
          <div className="ag-row">
            <button
              type="button"
              className="ag-btn"
              onClick={() => speakMarkdown("This is how Omnia will read answers aloud.", "voice-preview", prefs)}
            >
              Preview voice
            </button>
            <button type="button" className="ag-btn" onClick={() => stopSpeaking()}>
              Stop speaking
            </button>
          </div>
        </>
      ) : (
        <p className="ag-muted">Read aloud is not available in this webview.</p>
      )}
    </section>
  );
}

export function AppearanceSection() {
  const [appearance, setAppearance] = useState<AgentAppearance>(readAgentAppearance);
  const id = useId();
  const update = (patch: Partial<AgentAppearance>) => {
    const next = writeAgentAppearance(patch);
    setAppearance(next);
    applyAgentAppearance(document.documentElement, next);
  };
  return (
    <section aria-labelledby="ag-appearance-title">
      <h3 className="ag-subtitle" id="ag-appearance-title">
        Appearance
      </h3>
      <div className="ag-field">
        <label className="ag-label" htmlFor={`${id}-theme`}>
          Theme
        </label>
        <select
          id={`${id}-theme`}
          className="ag-input"
          value={appearance.theme}
          onChange={(event) => update({ theme: event.target.value as AgentTheme })}
        >
          {THEMES.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
        <p className="ag-muted">
          System follows your operating system, including its increased-contrast and forced-colors modes. High contrast is a dark
          theme with strong borders and 2px focus rings.
        </p>
      </div>
      <div className="ag-field">
        <label className="ag-label" htmlFor={`${id}-density`}>
          Density
        </label>
        <select
          id={`${id}-density`}
          className="ag-input"
          value={appearance.density}
          onChange={(event) => update({ density: event.target.value as AgentDensity })}
        >
          {DENSITIES.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>
      <div className="ag-field">
        <label className="ag-label" htmlFor={`${id}-font`}>
          Text size: {appearance.fontScale}%
        </label>
        <input
          id={`${id}-font`}
          type="range"
          min={FONT_SCALE_MIN}
          max={FONT_SCALE_MAX}
          step={FONT_SCALE_STEP}
          value={appearance.fontScale}
          onChange={(event) => update({ fontScale: Number(event.target.value) })}
        />
      </div>
    </section>
  );
}

/** Global rules, plus the active session's project rules when it has a folder. */
export function PermissionRulesSection() {
  const cwd = useAgentStore((state) => state.sessions.find((entry) => entry.id === state.activeId)?.cwd);
  const [message, setMessage] = useState(() => readPrefs().planApprovedMessage ?? "");
  return (
    <section aria-labelledby="ag-rules-title">
      <h3 className="ag-subtitle" id="ag-rules-title">
        Permission rules
      </h3>
      <PermissionRulesManager cwd={cwd} scopes={cwd ? ["global", "project"] : ["global"]} />
      <div className="ag-field">
        <label className="ag-label" htmlFor="ag-plan-message">
          Message sent when a plan is approved
        </label>
        <input
          id="ag-plan-message"
          className="ag-input"
          value={message}
          placeholder="Plan approved. Proceed."
          onChange={(event) => {
            setMessage(event.target.value);
            writePrefs({ planApprovedMessage: event.target.value });
          }}
        />
      </div>
    </section>
  );
}

function RuntimeSection() {
  const [settings, setSettings] = useState<OmniaRuntimeSettings>(() => readRuntimeSettings());
  const update = (patch: Partial<OmniaRuntimeSettings>) => {
    const next = writeRuntimeSettings({ ...settings, ...patch });
    setSettings(next);
    window.dispatchEvent(new CustomEvent("omnia:runtime-settings", { detail: next }));
  };
  const updateRetryPolicy = (patch: Partial<OmniaRetryPolicy>) => {
    update({ retryPolicy: { ...settings.retryPolicy, ...patch } });
  };
  return (
    <section aria-labelledby="ag-runtime-title">
      <h3 className="ag-subtitle" id="ag-runtime-title">Runtime &amp; orchestration</h3>
      <p className="ag-muted">Hot reloadable controls for context assembly, research, browser/computer capture, retry behavior and run telemetry. Native permissions and provider safety rules still apply.</p>
      <div className="ag-field"><label className="ag-label" htmlFor="ag-runtime-context">Context window (tokens)</label><input id="ag-runtime-context" className="ag-input" type="number" min={8192} max={2000000} step={1024} value={settings.contextWindowTokens} onChange={(event) => update({ contextWindowTokens: Number(event.target.value) })} /></div>
      <div className="ag-field"><label className="ag-label" htmlFor="ag-runtime-trunc">Tool output limit (characters)</label><input id="ag-runtime-trunc" className="ag-input" type="number" min={1000} max={200000} step={500} value={settings.toolOutputLimitChars} onChange={(event) => update({ toolOutputLimitChars: Number(event.target.value) })} /></div>
      <div className="ag-field"><label className="ag-label" htmlFor="ag-runtime-iterations">Plan enhancement iterations (0–10)</label><input id="ag-runtime-iterations" className="ag-input" type="number" min={0} max={10} value={settings.planIterations} onChange={(event) => update({ planIterations: Number(event.target.value) })} /></div>
      <fieldset className="ag-fieldset">
        <legend className="ag-label">Retry policy</legend>
        <p className="ag-muted">Renderer policy draft only. Native routing decides whether an attempt is safe, especially after an ambiguous provider outcome.</p>
        <div className="ag-field"><label className="ag-label" htmlFor="ag-runtime-retry-window">Retry window (seconds)</label><input id="ag-runtime-retry-window" className="ag-input" type="number" min={0} max={604800} step={60} value={settings.retryPolicy.maxElapsedSeconds} onChange={(event) => updateRetryPolicy({ maxElapsedSeconds: Number(event.target.value) })} /></div>
        <div className="ag-field"><label className="ag-label" htmlFor="ag-runtime-retry-attempts">Maximum retry attempts</label><input id="ag-runtime-retry-attempts" className="ag-input" type="number" min={1} max={20} placeholder="No attempt limit" value={settings.retryPolicy.maxAttempts ?? ""} onChange={(event) => updateRetryPolicy({ maxAttempts: event.target.value ? Number(event.target.value) : null })} /></div>
        <div className="ag-field"><label className="ag-label" htmlFor="ag-runtime-retry-delay">Retry delay (seconds)</label><input id="ag-runtime-retry-delay" className="ag-input" type="number" min={1} max={900} step={1} value={settings.retryPolicy.retryDelaySeconds} onChange={(event) => updateRetryPolicy({ retryDelaySeconds: Number(event.target.value) })} /></div>
        <div className="ag-field"><label className="ag-label" htmlFor="ag-runtime-retry-multiplier">Retry multiplier</label><input id="ag-runtime-retry-multiplier" className="ag-input" type="number" min={0.1} max={10} step={0.1} value={settings.retryPolicy.retryMultiplier} onChange={(event) => updateRetryPolicy({ retryMultiplier: Number(event.target.value) })} /></div>
        <div className="ag-field"><label className="ag-label" htmlFor="ag-runtime-retry-max-delay">Maximum retry delay (seconds)</label><input id="ag-runtime-retry-max-delay" className="ag-input" type="number" min={1} max={900} step={1} value={settings.retryPolicy.maxSingleDelaySeconds} onChange={(event) => updateRetryPolicy({ maxSingleDelaySeconds: Number(event.target.value) })} /></div>
        <div className="ag-field"><label className="ag-label" htmlFor="ag-runtime-retry-jitter">Retry jitter</label><select id="ag-runtime-retry-jitter" className="ag-input" value={settings.retryPolicy.jitter} onChange={(event) => updateRetryPolicy({ jitter: event.target.value as OmniaRetryPolicy["jitter"] })}><option value="none">None</option><option value="full">Full</option><option value="equal">Equal</option><option value="decorrelated">Decorrelated</option></select></div>
        <label className="ag-row"><input type="checkbox" role="switch" checked={settings.retryPolicy.retryOnAnyError} onChange={(event) => updateRetryPolicy({ retryOnAnyError: event.target.checked })} /> Retry incomplete sessions after any error</label>
        <label className="ag-row"><input type="checkbox" role="switch" checked={settings.retryPolicy.honorRetryAfter} onChange={(event) => updateRetryPolicy({ honorRetryAfter: event.target.checked })} /> Honor provider Retry-After hints when they are bounded</label>
        <label className="ag-row"><input type="checkbox" role="switch" checked={settings.retryPolicy.allowProviderFallback} onChange={(event) => updateRetryPolicy({ allowProviderFallback: event.target.checked })} /> Allow an explicitly approved provider fallback</label>
        <label className="ag-row"><input type="checkbox" role="switch" checked={settings.retryPolicy.allowModelFallback} onChange={(event) => updateRetryPolicy({ allowModelFallback: event.target.checked })} /> Allow an explicitly approved model fallback</label>
        <label className="ag-row"><input type="checkbox" role="switch" checked={settings.retryPolicy.allowPromptRepair} onChange={(event) => updateRetryPolicy({ allowPromptRepair: event.target.checked })} /> Allow deterministic prompt repair with a semantic diff</label>
      </fieldset>
      <label className="ag-row"><input type="checkbox" role="switch" checked={settings.autoPlan} onChange={(event) => update({ autoPlan: event.target.checked })} /> Plan before each goal and report coverage after each task</label>
      <label className="ag-row"><input type="checkbox" role="switch" checked={settings.autoResearch} onChange={(event) => update({ autoResearch: event.target.checked })} /> Prefer grounded research and cite retrieved sources when a task needs current information</label>
      <div className="ag-field"><label className="ag-label" htmlFor="ag-runtime-search">Web search policy</label><select id="ag-runtime-search" className="ag-input" value={settings.webSearch} onChange={(event) => update({ webSearch: event.target.value as OmniaRuntimeSettings["webSearch"] })}><option value="smart">Smart (intent and freshness aware)</option><option value="always">Always search</option><option value="off">Off</option></select></div>
      <div className="ag-field"><label className="ag-label" htmlFor="ag-runtime-effort">Default reasoning effort</label><select id="ag-runtime-effort" className="ag-input" value={settings.defaultEffort} onChange={(event) => update({ defaultEffort: event.target.value as OmniaRuntimeSettings["defaultEffort"] })}>{REASONING_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort === "ultra" ? "ultra · dynamic workflow" : effort}</option>)}</select></div>
      <label className="ag-row"><input type="checkbox" role="switch" checked={settings.browser.enabled} onChange={(event) => update({ browser: { ...settings.browser, enabled: event.target.checked } })} /> Enable browser tools on demand <span className="ag-muted">(headless default)</span></label>
      <label className="ag-row"><input type="checkbox" role="switch" checked={settings.computer.enabled} onChange={(event) => update({ computer: { ...settings.computer, enabled: event.target.checked } })} /> Enable computer tools on demand <span className="ag-muted">(headless default)</span></label>
      <label className="ag-row"><input type="checkbox" role="switch" checked={settings.telemetry.enabled} onChange={(event) => update({ telemetry: { ...settings.telemetry, enabled: event.target.checked } })} /> Record redacted run metrics (tokens/s, req/min, cost estimate)</label>
      <p className="ag-muted">Current defaults: {settings.contextWindowTokens.toLocaleString()} context · {settings.toolOutputLimitChars.toLocaleString()} tool chars · {settings.planIterations} plan passes · retry after {settings.retryPolicy.retryDelaySeconds}s × {settings.retryPolicy.retryMultiplier} · {settings.retryPolicy.maxAttempts ?? "unlimited"} attempts{settings.retryPolicy.maxElapsedSeconds === 0 ? " with no time cap" : ` within ${settings.retryPolicy.maxElapsedSeconds.toLocaleString()}s`}.</p>
    </section>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const dialogId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const [profiles, setProfiles] = useState<ProviderProfileRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notifyOnFinish, setNotifyOnFinish] = useState(() => readPrefs().notifyOnFinish !== false);
  const [activeSection, setActiveSection] = useState("providers");
  // Tab bodies mount on first visit and then stay mounted while hidden, so
  // drafts survive tab changes and each section's mount-time API calls wait
  // until the user actually opens it.
  const [visitedSections, setVisitedSections] = useState<ReadonlySet<string>>(() => new Set(["providers"]));
  const selectSection = (sectionId: string) => {
    setActiveSection(sectionId);
    setVisitedSections((current) => (current.has(sectionId) ? current : new Set(current).add(sectionId)));
  };
  const [horizontalTabs, setHorizontalTabs] = useState(() => window.innerWidth <= 640);
  const load = useCallback(() => {
    agentApi.listProfiles().then((list) => { setProfiles(list); setError(null); }).catch((cause) => setError(errorMessage(cause)));
  }, []);
  const sections = [
    {
      id: "providers",
      label: "Providers",
      content: (
        <section aria-labelledby="ag-providers-title">
          <h3 className="ag-subtitle" id="ag-providers-title">Providers</h3>
          {profiles.length === 0 ? <p className="ag-muted">No providers yet.</p> : null}
          <ul className="ag-profiles">
            {profiles.map((profile) => (
              <li key={profile.id} className="ag-profile">
                <span className="ag-profile__name">{profile.displayName}</span>
                <span className="ag-muted ag-profile__meta">
                  {profile.providerType} · {profile.normalizedBaseUrl}{profile.credentialStatus === "missing" ? " · no key" : ""}
                </span>
                <button type="button" className="ag-icon-btn" aria-label={`Delete ${profile.displayName}`} onClick={() => void remove(profile.id)}>
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          {error ? <p className="ag-error" role="alert">{error}</p> : null}
          <ProfileForm onSaved={load} />
        </section>
      ),
    },
    { id: "appearance", label: "Appearance", content: <AppearanceSection /> },
    {
      id: "notifications",
      label: "Notifications",
      content: (
        <section aria-labelledby="ag-notify-title">
          <h3 className="ag-subtitle" id="ag-notify-title">Notifications</h3>
          <label className="ag-row">
            <input
              type="checkbox"
              role="switch"
              checked={notifyOnFinish}
              onChange={(event) => {
                setNotifyOnFinish(event.target.checked);
                writePrefs({ notifyOnFinish: event.target.checked });
              }}
            />
            Show a desktop notification when a run finishes or needs approval while Omnia is in the background
          </label>
        </section>
      ),
    },
    { id: "permissions", label: "Permissions", content: <PermissionRulesSection /> },
    { id: "runtime", label: "Runtime", content: <RuntimeSection /> },
    { id: "voice", label: "Voice", content: <VoiceSection /> },
    { id: "mcp", label: "MCP server", content: <McpServerSection /> },
    { id: "updates", label: "Updates", content: <UpdatesSection /> },
    { id: "plugins", label: "Plugins", content: <PluginsSection /> },
    { id: "data", label: "Data", content: <DataSection /> },
  ];

  useEffect(load, [load]);
  useEffect(() => {
    const updateOrientation = () => setHorizontalTabs(window.innerWidth <= 640);
    window.addEventListener("resize", updateOrientation);
    return () => window.removeEventListener("resize", updateOrientation);
  }, []);

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
    navRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeSection, horizontalTabs]);

  const focusSection = (sectionId: string) => {
    selectSection(sectionId);
    document.getElementById(`${dialogId}-tab-${sectionId}`)?.focus({ preventScroll: true });
  };

  const remove = async (profileId: string) => {
    try {
      await desktop.deleteProviderProfile(profileId);
      load();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <ModalSurface className="ag-dialog ag-dialog--wide ag-settings-dialog" scrimClassName="ag-scrim" title="Settings" onClose={onClose}>
      <h2 className="ag-dialog__title">Settings</h2>
      <div className="ag-settings-layout">
        <div
          ref={navRef}
          className="ag-settings-nav"
          role="tablist"
          aria-label="Settings sections"
          aria-orientation={horizontalTabs ? "horizontal" : "vertical"}
            onKeyDown={(event) => {
              if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
              const currentIndex = sections.findIndex((section) => section.id === activeSection);
              let nextIndex: number | null = null;
              if (event.key === (horizontalTabs ? "ArrowRight" : "ArrowDown")) nextIndex = (currentIndex + 1) % sections.length;
              if (event.key === (horizontalTabs ? "ArrowLeft" : "ArrowUp")) nextIndex = (currentIndex - 1 + sections.length) % sections.length;
              if (event.key === "Home") nextIndex = 0;
              if (event.key === "End") nextIndex = sections.length - 1;
              const nextSection = nextIndex === null ? undefined : sections[nextIndex];
              if (nextSection) {
                event.preventDefault();
                focusSection(nextSection.id);
              }
            }}
          >
            {sections.map((section) => (
              <button
                key={section.id}
                type="button"
                role="tab"
                id={`${dialogId}-tab-${section.id}`}
                aria-controls={`${dialogId}-panel-${section.id}`}
                aria-selected={activeSection === section.id}
                tabIndex={activeSection === section.id ? 0 : -1}
                className="ag-settings-nav__item"
                onClick={() => selectSection(section.id)}
              >
                {section.label}
              </button>
            ))}
        </div>
        <div ref={contentRef} className="ag-settings-content">
          {sections.map((section) => (
            <div
              key={section.id}
              role="tabpanel"
              tabIndex={0}
              id={`${dialogId}-panel-${section.id}`}
              aria-labelledby={`${dialogId}-tab-${section.id}`}
              hidden={activeSection !== section.id}
            >
              {visitedSections.has(section.id) ? section.content : null}
            </div>
          ))}
        </div>
      </div>
      <div className="ag-dialog__actions">
        <button type="button" className="ag-btn" onClick={onClose} data-dialog-initial-focus>
          Close
        </button>
      </div>
    </ModalSurface>
  );
}
