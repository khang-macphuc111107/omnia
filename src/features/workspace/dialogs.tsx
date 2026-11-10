import {
  AlertTriangle,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  FolderOpen,
  Globe2,
  KeyRound,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Plus,
  Server,
  ShieldCheck,
  X,
  Zap,
} from "lucide-react";
import { useId, useState } from "react";

import { ModalSurface } from "@/components/modal-surface";
import { ProductIcon } from "@/components/product-icons";

import {
  desktop,
  isDesktopRuntime,
  type ProviderConnectionProbeResult,
} from "@/lib/desktop";

import {
  modelProfileFromProviderModel,
  providerModelRecordFromNativeModel,
} from "./provider-catalog";
import { projectFromNativeRecord, workspaceFolderFromNativeGrant } from "./project-catalog";
import { createId, useWorkspaceStore } from "./store";
import { useWorkspaceOverlayStore } from "./overlay-store";
import type { ProviderKind, ProviderView, WorkspaceFolderView } from "./types";
import { ConversationStartDialog } from "./conversation-start-dialog";

type ProviderTemplate = {
  id: string;
  label: string;
  kind: ProviderKind;
  providerType: string;
  endpoint: string;
  authScheme: string;
  keyLabel: string;
  keyPlaceholder: string;
  description: string;
  allowCustomEndpoint: boolean;
  availability: "available" | "planned";
  unavailableReason?: string;
  authOptions: Array<{ value: string; label: string }>;
};

export const providerTemplates: ProviderTemplate[] = [
  {
    id: "openai",
    label: "OpenAI",
    kind: "OpenAI",
    providerType: "openai",
    endpoint: "https://api.openai.com/v1",
    authScheme: "bearer",
    keyLabel: "API key",
    keyPlaceholder: "sk-…",
    description: "Responses API text streaming, BYOK, usage events, and model discovery.",
    allowCustomEndpoint: false,
    availability: "available",
    authOptions: [{ value: "bearer", label: "Bearer token" }],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    kind: "Anthropic",
    providerType: "anthropic",
    endpoint: "https://api.anthropic.com/v1",
    authScheme: "api-key-header",
    keyLabel: "API key",
    keyPlaceholder: "sk-ant-…",
    description: "Messages API text streaming with normalized usage and reasoning events.",
    allowCustomEndpoint: false,
    availability: "available",
    authOptions: [
      { value: "api-key-header", label: "Anthropic x-api-key" },
      { value: "bearer", label: "Anthropic bearer token" },
    ],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    kind: "Gemini",
    providerType: "gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    authScheme: "api-key-header",
    keyLabel: "API key",
    keyPlaceholder: "AIza…",
    description: "streamGenerateContent text streaming with normalized usage and reasoning events.",
    allowCustomEndpoint: false,
    availability: "available",
    authOptions: [{ value: "api-key-header", label: "Google API key header" }],
  },
  {
    id: "azure-openai",
    label: "Azure OpenAI",
    kind: "Azure OpenAI",
    providerType: "azure_openai",
    endpoint: "https://RESOURCE.openai.azure.com/openai",
    authScheme: "azure-api-key",
    keyLabel: "Azure API key",
    keyPlaceholder: "Your resource key",
    description: "Planned · deployment-path and API-version routing are not wired in this preview.",
    allowCustomEndpoint: true,
    availability: "planned",
    unavailableReason: "Azure OpenAI is planned. Deployment-path and API-version routing are not implemented in this preview, so this connection cannot be tested or saved yet.",
    authOptions: [{ value: "azure-api-key", label: "Azure API key" }],
  },
  {
    id: "openai-compatible",
    label: "Compatible API",
    kind: "OpenAI-compatible",
    providerType: "openai_compatible",
    endpoint: "https://api.example.com/v1",
    authScheme: "bearer",
    keyLabel: "API key",
    keyPlaceholder: "Provider credential",
    description: "OpenAI-compatible /models discovery and /chat/completions text streaming.",
    allowCustomEndpoint: true,
    availability: "available",
    authOptions: [
      { value: "bearer", label: "Bearer token" },
      { value: "api-key-header", label: "API key header" },
      { value: "none", label: "No authentication" },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "OpenAI-compatible",
    providerType: "deepseek",
    endpoint: "https://api.deepseek.com/v1",
    authScheme: "bearer",
    keyLabel: "API key",
    keyPlaceholder: "sk-…",
    description: "DeepSeek's OpenAI-compatible /models discovery and /chat/completions text streaming.",
    allowCustomEndpoint: false,
    availability: "available",
    authOptions: [{ value: "bearer", label: "Bearer token" }],
  },
  {
    id: "local",
    label: "Local runtime",
    kind: "Local",
    providerType: "local",
    endpoint: "http://127.0.0.1:11434/v1",
    authScheme: "none",
    keyLabel: "API key",
    keyPlaceholder: "Optional",
    description: "OpenAI-compatible text streaming for loopback or explicitly granted LAN endpoints.",
    allowCustomEndpoint: true,
    availability: "available",
    authOptions: [
      { value: "none", label: "No authentication" },
      { value: "bearer", label: "Bearer token" },
      { value: "api-key-header", label: "API key header" },
    ],
  },
  {
    id: "custom-adapter",
    label: "Custom adapter",
    kind: "Custom",
    providerType: "custom_adapter",
    endpoint: "https://api.example.com",
    authScheme: "bearer",
    keyLabel: "Credential",
    keyPlaceholder: "Optional for no-auth endpoints",
    description: "Planned · declarative adapter manifests and custom headers are not wired yet.",
    allowCustomEndpoint: true,
    availability: "planned",
    unavailableReason: "Custom adapters are planned. Declarative manifests and the custom-header security policy are not implemented in this preview, so this connection cannot be tested or saved yet.",
    authOptions: [{ value: "bearer", label: "Bearer token" }],
  },
];

function DialogFrame({
  title,
  description,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <ModalSurface
      className={wide ? "dialog dialog--wide" : "dialog"}
      titleId={titleId}
      descriptionId={descriptionId}
      onClose={onClose}
    >
        <header className="dialog__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            <p id={descriptionId}>{description}</p>
          </div>
          <button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        {children}
    </ModalSurface>
  );
}

export function ProjectDialog({ onClose }: { onClose: () => void }) {
  const createProject = useWorkspaceStore((state) => state.createProject);
  const addProject = useWorkspaceStore((state) => state.addProject);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nativeRuntime = isDesktopRuntime();

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (isDesktopRuntime()) {
        const record = await desktop.createProject({
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        });
        addProject(projectFromNativeRecord(record, [], useWorkspaceStore.getState().conversations));
      } else {
        createProject({
          name: name.trim(),
          description: description.trim(),
          instructions: instructions.trim(),
          modelProfileId: "auto",
        });
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Project could not be created.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogFrame title="Create a project" description={`${nativeRuntime ? "A local container" : "A browser-preview container"} for conversations, instructions, and explicit read-only workspace grants. Memory, skills, indexing, and context compilation are planned.`} onClose={onClose}>
      <div className="dialog__body form-stack">
        <label><span>Project name</span><input autoFocus data-dialog-initial-focus value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Product research" /></label>
        <label><span>Description <small>Optional</small></span><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What belongs in this project?" /></label>
        <label><span>Instructions <small>Optional</small></span><textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="How should Omnia approach work in this project?" rows={4} /></label>
        <div className="dialog-choice-row" aria-label="Current project behavior">
          <div className="dialog-choice dialog-choice--active">
            <LockKeyhole size={17} />
            <span><strong>{nativeRuntime ? "Local project metadata" : "Renderer preview metadata"}</strong><small>{nativeRuntime ? "Stored on this device" : "Session-only in this browser preview"}</small></span>
            <Check size={15} />
          </div>
          <div className="dialog-choice">
            <ProductIcon name="model" size={17} />
            <span><strong>{nativeRuntime ? "Current text route" : "Preview response route"}</strong><small>{nativeRuntime ? "Uses the available selected/automatic model" : "Renderer mock response; no provider request"}</small></span>
          </div>
        </div>
        {error ? <div className="provider-error" role="alert"><AlertTriangle size={17} /><span><strong>Project needs attention</strong><small>{error}</small></span></div> : null}
      </div>
      <footer className="dialog__footer"><button type="button" className="button button--ghost" onClick={onClose}>Cancel</button><button type="button" className="button button--primary" disabled={!name.trim() || saving} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} {saving ? "Creating…" : "Create project"}</button></footer>
    </DialogFrame>
  );
}

function providerViewFromProbe(
  id: string,
  template: ProviderTemplate,
  name: string,
  endpoint: string,
  authScheme: string,
  organizationId: string,
  remoteProjectId: string,
  result: ProviderConnectionProbeResult,
  source: ProviderView["source"],
): ProviderView {
  const models = result.models.map((model) =>
    modelProfileFromProviderModel({ id, name }, model),
  );
  return {
    id,
    name,
    kind: template.kind,
    providerType: template.providerType,
    endpoint: result.normalizedBaseUrl || endpoint,
    authScheme,
    state: result.healthy
      ? source === "native"
        ? "connected"
        : "configuration-validated"
      : "degraded",
    modelCount: models.length,
    enabled: true,
    credentialState: authScheme === "none" ? "not-required" : "present",
    source,
    organizationId: organizationId.trim() || null,
    remoteProjectId: remoteProjectId.trim() || null,
    lastCheckedAt: new Date().toISOString(),
    latencyMs: result.latencyMs,
    errorMessage: result.warning ?? null,
    models,
  };
}

export function ProviderDialog({ onClose }: { onClose: () => void }) {
  const addProvider = useWorkspaceStore((state) => state.addProvider);
  const [templateId, setTemplateId] = useState("openai");
  const template = providerTemplates.find((item) => item.id === templateId) ?? providerTemplates[0]!;
  const [name, setName] = useState(template.label);
  const [endpoint, setEndpoint] = useState(template.endpoint);
  const [authScheme, setAuthScheme] = useState(template.authScheme);
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [organizationId, setOrganizationId] = useState("");
  const [remoteProjectId, setRemoteProjectId] = useState("");
  const [modelHint, setModelHint] = useState("");
  const [allowLocalNetwork, setAllowLocalNetwork] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState<ProviderConnectionProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isAvailable = template.availability === "available";
  const requiresCredential = authScheme !== "none";
  const canTest = Boolean(
    isAvailable && name.trim() && endpoint.trim() && (!requiresCredential || key.trim()),
  );

  const selectTemplate = (nextId: string) => {
    const next = providerTemplates.find((item) => item.id === nextId);
    if (!next) return;
    setTemplateId(nextId);
    setName(next.label);
    setEndpoint(next.endpoint);
    setAuthScheme(next.authScheme);
    setOrganizationId("");
    setRemoteProjectId("");
    setModelHint("");
    setKey("");
    setShowKey(false);
    setAllowLocalNetwork(next.kind === "Local");
    setProbe(null);
    setError(null);
  };

  const buildSaveRequest = () => ({
    providerType: template.providerType,
    displayName: name.trim(),
    baseUrl: endpoint.trim(),
    authScheme,
    ...(organizationId.trim() ? { organizationId: organizationId.trim() } : {}),
    ...(remoteProjectId.trim() ? { remoteProjectId: remoteProjectId.trim() } : {}),
    ...(key.trim() ? { secret: key } : {}),
    allowLocalNetwork,
  });

  const buildProbeRequest = () => ({
    ...buildSaveRequest(),
    ...(modelHint.trim() ? { modelHint: modelHint.trim() } : {}),
  });

  const test = async () => {
    if (!isAvailable) {
      setError(template.unavailableReason ?? "This provider adapter is not available in this preview.");
      return;
    }
    setTesting(true);
    setProbe(null);
    setError(null);
    try {
      setProbe(await desktop.preflightProviderConnection(buildProbeRequest()));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Configuration validation failed.");
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!probe || !isAvailable) return;
    setSaving(true);
    setError(null);
    try {
      if (isDesktopRuntime()) {
        const receipt = await desktop.saveProviderProfile(buildSaveRequest());
        let liveProbe = probe;
        try {
          const [health, catalog] = await Promise.all([
            desktop.testProviderConnection(receipt.profile.id),
            desktop.listProviderModels(receipt.profile.id),
          ]);
          liveProbe = {
            healthy: health.healthy,
            normalizedBaseUrl: receipt.profile.normalizedBaseUrl,
            latencyMs: health.latencyMs,
            models: catalog.models.map(providerModelRecordFromNativeModel),
          };
        } catch (cause) {
          liveProbe = {
            healthy: false,
            normalizedBaseUrl: receipt.profile.normalizedBaseUrl,
            latencyMs: null,
            models: [],
            warning: cause instanceof Error ? cause.message : "Saved, but live validation did not complete.",
          };
        }
        addProvider(
          providerViewFromProbe(
            receipt.profile.id,
            template,
            receipt.profile.displayName,
            receipt.profile.normalizedBaseUrl,
            receipt.profile.authScheme,
            receipt.profile.organizationId ?? "",
            receipt.profile.remoteProjectId ?? "",
            liveProbe,
            "native",
          ),
        );
      } else {
        addProvider(
          providerViewFromProbe(
            createId("provider"),
            template,
            name.trim(),
            endpoint.trim(),
            authScheme,
            organizationId,
            remoteProjectId,
            probe,
            "preview",
          ),
        );
      }
      setKey("");
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Provider could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogFrame
      title="Connect your AI provider"
      description="Bring your own key, retain provider-native controls, and keep secrets behind the native credential boundary."
      onClose={onClose}
      wide
    >
      <div className="dialog__body provider-dialog-body">
        <div className="provider-template-grid" role="list" aria-label="Provider type">
          {providerTemplates.map((item) => (
            <button
              key={item.id}
              type="button"
              className={[
                "provider-template",
                item.id === templateId ? "provider-template--active" : "",
                item.availability === "planned" ? "provider-template--planned" : "",
              ].filter(Boolean).join(" ")}
              onClick={() => selectTemplate(item.id)}
              aria-pressed={item.id === templateId}
            >
              <span className="provider-template__icon">
                {item.kind === "Local" ? <Server size={16} /> : item.kind === "Custom" ? <Zap size={16} /> : <Globe2 size={16} />}
              </span>
              <span>
                <strong>{item.label}{item.availability === "planned" ? <em>Planned</em> : null}</strong>
                <small>{item.description}</small>
              </span>
              {item.id === templateId ? <Check size={15} /> : null}
            </button>
          ))}
        </div>

        <div className="provider-form form-stack">
          {!isAvailable ? <div className="provider-planned-callout" role="status"><AlertTriangle size={17} /><span><strong>Planned adapter · unavailable in this preview</strong><small>{template.unavailableReason}</small></span></div> : null}
          <div className="security-callout"><ShieldCheck size={17} /><div><strong>{isDesktopRuntime() ? "Protected by Windows" : "Desktop-safe preview"}</strong><p>{isDesktopRuntime() ? "Your credential is handed once to native secret storage. Renderer state receives only an opaque reference." : "The browser preview validates configuration locally and never persists the credential. Native builds use the operating-system vault."}</p></div></div>
          <div className="provider-form-grid">
            <label><span>Connection name</span><input autoFocus data-dialog-initial-focus value={name} disabled={!isAvailable} onChange={(event) => { setName(event.target.value); setProbe(null); }} /></label>
            <label><span>Authentication</span><div className="select-with-icon"><KeyRound size={15} /><select value={authScheme} disabled={!isAvailable} onChange={(event) => { setAuthScheme(event.target.value); setProbe(null); }}>{template.authOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><ChevronDown size={13} /></div></label>
          </div>
          <label><span>Base URL <small>{template.allowCustomEndpoint && isAvailable ? "Editable" : "Provider default"}</small></span><div className="input-with-icon"><Link2 size={15} /><input value={endpoint} disabled={!isAvailable} readOnly={!template.allowCustomEndpoint} onChange={(event) => { setEndpoint(event.target.value); setProbe(null); }} spellCheck={false} /></div></label>
          {requiresCredential ? <label><span>{template.keyLabel}<small>Never written to renderer storage</small></span><div className="input-with-icon"><KeyRound size={15} /><input type={showKey ? "text" : "password"} value={key} disabled={!isAvailable} onChange={(event) => { setKey(event.target.value); setProbe(null); }} placeholder={template.keyPlaceholder} autoComplete="new-password" spellCheck={false} /><button type="button" className="input-inline-action" disabled={!isAvailable} onClick={() => setShowKey((value) => !value)} aria-label={showKey ? "Hide credential" : "Show credential"}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></label> : null}
          {isAvailable ? <details className="provider-advanced">
            <summary><span><strong>Advanced connection options</strong><small>Provider metadata, model hint, and explicit local-network grant</small></span><ChevronDown size={15} /></summary>
            <div className="provider-advanced__body">
              {template.id === "openai" || template.id === "openai-compatible" || template.id === "local" ? <div className="provider-form-grid">
                <label><span>Organization ID<small>Optional · OpenAI header</small></span><input value={organizationId} onChange={(event) => { setOrganizationId(event.target.value); setProbe(null); }} placeholder="org_…" /></label>
                <label><span>Remote project ID<small>Optional · OpenAI header</small></span><input value={remoteProjectId} onChange={(event) => { setRemoteProjectId(event.target.value); setProbe(null); }} placeholder="proj_…" /></label>
              </div> : null}
              <label><span>Model ID hint <small>Useful when model discovery is unavailable</small></span><input value={modelHint} onChange={(event) => { setModelHint(event.target.value); setProbe(null); }} placeholder="e.g. model-name-or-deployment" /></label>
              <label className="provider-network-grant hit-target-control"><input type="checkbox" checked={allowLocalNetwork} onChange={(event) => { setAllowLocalNetwork(event.target.checked); setProbe(null); }} /><span><strong>Allow local or private network destination</strong><small>Required for loopback, LAN, Ollama, LM Studio, and self-hosted endpoints. This grant does not allow arbitrary redirects.</small></span></label>
            </div>
          </details> : null}
          {testing ? <div className="provider-probe-callout"><LoaderCircle className="spin" size={17} /><span><strong>Validating configuration</strong><small>Checking endpoint policy, authentication shape, and provider request constraints before saving…</small></span></div> : null}
          {probe ? <div className="success-callout provider-probe-result"><Check size={17} /><span><strong>Configuration preflight passed</strong><small>{probe.warning ?? "Endpoint policy and request shape are valid. Live model discovery runs after the native profile is saved."}</small></span></div> : null}
          {error ? <div className="provider-error" role="alert"><AlertTriangle size={17} /><span><strong>Connection needs attention</strong><small>{error}</small></span></div> : null}
        </div>
      </div>
      <footer className="dialog__footer dialog__footer--split">
        <button type="button" className="button button--secondary" disabled={!canTest || testing || saving} onClick={() => void test()}>{testing ? <LoaderCircle className="spin" size={15} /> : <Zap size={15} />}{!isAvailable ? "Not available" : testing ? "Validating…" : probe ? "Validate again" : "Validate configuration"}</button>
        <span><button type="button" className="button button--ghost" onClick={onClose}>Cancel</button><button type="button" className="button button--primary" disabled={!isAvailable || !probe || testing || saving} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}{!isAvailable ? "Planned" : saving ? "Saving securely…" : isDesktopRuntime() ? "Save connection" : "Add preview connection"}</button></span>
      </footer>
    </DialogFrame>
  );
}

function FolderDialog({ onClose, projectId }: { onClose: () => void; projectId: string }) {
  const activeProjectId = projectId;
  const activeProject = useWorkspaceStore((state) =>
    state.projects.find((project) => project.id === projectId),
  );
  const addWorkspaceFolder = useWorkspaceStore((state) => state.addWorkspaceFolder);
  const [path, setPath] = useState("");
  const [grant, setGrant] = useState<Awaited<ReturnType<typeof desktop.pickWorkspaceFolder>>>(null);
  const [error, setError] = useState<string | null>(null);

  const browse = async () => {
    if (isDesktopRuntime()) {
      if (!activeProject) {
        setError("Create a project before granting a workspace folder.");
        return;
      }
      try {
        setError(null);
        const selected = await desktop.pickWorkspaceFolder(activeProjectId);
        if (selected) {
          setGrant(selected);
          setPath(selected.displayPath);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Workspace folder could not be granted.");
      }
    } else {
      setPath("C:\\Workspace\\Example");
    }
  };

  const add = () => {
    if (!activeProject) {
      setError("Create a project before granting a workspace folder.");
      return;
    }
    const segments = path.split(/[\\/]/).filter(Boolean);
    const folder: WorkspaceFolderView = grant
      ? workspaceFolderFromNativeGrant(grant)
      : { id: createId("folder"), displayName: segments.at(-1) ?? "Workspace", canonicalPath: path, state: "referenced", scope: "read-only", fileCount: null, chunkCount: null, lastIndexedAt: null, localOnly: true };
    addWorkspaceFolder(activeProjectId, folder); onClose();
  };

  return (
    <DialogFrame title="Add workspace folder" description="Grant explicit, read-only access to local files for this project." onClose={onClose}>
      <div className="dialog__body form-stack">
        <button type="button" className="folder-picker-button" disabled={!activeProject} onClick={() => void browse()}><FolderOpen size={22} /><span><strong>{path || (activeProject ? "Choose a folder" : "Create a project first")}</strong><small>{path ? "Read-only grant created" : activeProject ? "Use the native Windows folder picker" : "Workspace grants must belong to a saved project"}</small></span></button>
        <div className="security-callout"><ShieldCheck size={17} /><div><strong>Read access only</strong><p>Omnia can list and read files inside this folder. Search indexing and file writes are not enabled in this preview.</p></div></div>
        <div className="security-callout"><ShieldCheck size={17} /><div><strong>No file is modified or executed</strong><p>You can revoke this grant at any time. Removing it never deletes source files from disk.</p></div></div>
        {error ? <div className="provider-error" role="alert"><AlertTriangle size={17} /><span><strong>Folder needs attention</strong><small>{error}</small></span></div> : null}
      </div>
      <footer className="dialog__footer"><button type="button" className="button button--ghost" onClick={onClose}>Cancel</button><button type="button" className="button button--primary" disabled={!path || !activeProject} onClick={add}><FolderOpen size={15} /> Grant read access</button></footer>
    </DialogFrame>
  );
}

export function GlobalDialogs() {
  const overlay = useWorkspaceOverlayStore((state) => state.activeOverlay);
  const closeOverlay = useWorkspaceOverlayStore((state) => state.closeOverlay);
  if (overlay?.kind === "create-project") return <ProjectDialog onClose={closeOverlay} />;
  if (overlay?.kind === "start-conversation") {
    return overlay.projectId
      ? <ConversationStartDialog projectId={overlay.projectId} {...(overlay.planDraft ? { planDraft: overlay.planDraft } : {})} onClose={closeOverlay} />
      : <ConversationStartDialog onClose={closeOverlay} />;
  }
  if (overlay?.kind === "connect-provider") return <ProviderDialog onClose={closeOverlay} />;
  if (overlay?.kind === "grant-folder") {
    return <FolderDialog key={overlay.projectId} projectId={overlay.projectId} onClose={closeOverlay} />;
  }
  return null;
}
