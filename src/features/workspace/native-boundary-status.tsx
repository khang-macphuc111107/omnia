import { AlertTriangle, CheckCircle2, CircleHelp, Radio, ShieldCheck } from "lucide-react";

import { OMNIA_PROTOCOL_VERSION, type CoreRuntimeInfo } from "@/lib/core-protocol";
import type { AppRuntimeInfo } from "@/lib/desktop";

export interface NativeBoundaryStatusProps {
  runtime: AppRuntimeInfo;
  coreRuntime?: CoreRuntimeInfo | null | undefined;
}

const REQUIRED_CAPABILITY = "run.stream.v1";

function hasCompatibleProtocol(coreRuntime: CoreRuntimeInfo): boolean {
  return coreRuntime.protocolVersion === OMNIA_PROTOCOL_VERSION;
}

function hasValidNativeSession(coreRuntime: CoreRuntimeInfo | null | undefined): boolean {
  return Boolean(
    coreRuntime
    && hasCompatibleProtocol(coreRuntime)
    && coreRuntime.sessionToken
    && /^[0-9a-f]{64}$/.test(coreRuntime.sessionToken)
    && Number.isSafeInteger(coreRuntime.sessionEpoch)
    && (coreRuntime.sessionEpoch ?? 0) > 0,
  );
}

function capabilityLabel(capability: string): string {
  const labels: Record<string, string> = {
    "conversation.durable.v1": "Durable conversations",
    "project.v1": "Projects",
    "provider.byok.v1": "Provider credentials",
    "provider.capability-negotiation.v1": "Provider capability negotiation",
    "run.cancel.v1": "Run cancellation",
    "run.stream.v1": "Run streaming",
    "secret.opaque-ref.v1": "Opaque credential references",
    "workspace.read.v1": "Read-only workspace access",
    "process.execute": "Process execution",
    "browser.control": "Browser control",
    "computer.control": "Computer control",
    "memory.read-write": "Memory read/write",
    "skill.prompt-only": "Skill prompt injection",
    "workspace.write": "Workspace writes",
  };
  return labels[capability] ?? capability;
}

function stateFor(runtime: AppRuntimeInfo, coreRuntime: CoreRuntimeInfo | null | undefined) {
  if (!runtime.tauri) {
    return {
      tone: "info" as const,
      label: "Browser preview",
      detail: "No native core session is connected in this browser surface.",
    };
  }
  if (!coreRuntime) {
    return {
      tone: "warning" as const,
      label: "Native status unknown",
      detail: "The desktop shell is present, but the negotiated core snapshot is unavailable.",
    };
  }
  if (!hasCompatibleProtocol(coreRuntime)) {
    return {
      tone: "warning" as const,
      label: "Native protocol mismatch",
      detail: `The core advertises protocol ${coreRuntime.protocolVersion}, but this renderer requires ${OMNIA_PROTOCOL_VERSION}.`,
    };
  }
  if (
    !coreRuntime.sessionToken
    || !/^[0-9a-f]{64}$/.test(coreRuntime.sessionToken)
    || !Number.isSafeInteger(coreRuntime.sessionEpoch)
    || (coreRuntime.sessionEpoch ?? 0) <= 0
  ) {
    return {
      tone: "warning" as const,
      label: "Native handshake incomplete",
      detail: "A core snapshot exists, but no valid IPC session token and epoch were provided.",
    };
  }
  if (!coreRuntime.capabilities.includes(REQUIRED_CAPABILITY)) {
    return {
      tone: "warning" as const,
      label: "Native core incompatible",
      detail: `The core session is present, but required capability ${REQUIRED_CAPABILITY} was not advertised.`,
    };
  }
  return {
    tone: "success" as const,
    label: "Native core negotiated",
    detail: `Protocol ${coreRuntime.protocolVersion} · ${coreRuntime.serverInfo.title} ${coreRuntime.serverInfo.version}`,
  };
}

export function NativeBoundaryStatus({
  runtime,
  coreRuntime = null,
}: NativeBoundaryStatusProps) {
  const state = stateFor(runtime, coreRuntime);
  const nativeSession = runtime.tauri && hasValidNativeSession(coreRuntime);
  const advertised = runtime.tauri ? coreRuntime?.capabilities ?? [] : [];
  const unavailable = runtime.tauri ? coreRuntime?.unavailableCapabilities ?? [] : [];
  const requiredAvailable = Boolean(
    runtime.tauri
    && coreRuntime
    && hasCompatibleProtocol(coreRuntime)
    && advertised.includes(REQUIRED_CAPABILITY),
  );
  const coreProtocolCompatible = Boolean(coreRuntime && hasCompatibleProtocol(coreRuntime));

  return (
    <section className="settings-section native-boundary-status" aria-label="Native boundary status">
      <header className="native-boundary-status__header">
        <div>
          <span className="eyebrow">Evidence boundary</span>
          <h2>Native boundary status</h2>
          <p>
            This surface reports the current renderer-to-core boundary; it does not turn source,
            schema, or preview evidence into a packaged-release claim.
          </p>
        </div>
        <span className={`native-boundary-status__badge native-boundary-status__badge--${state.tone}`}>
          {state.tone === "success" ? <CheckCircle2 size={14} /> : state.tone === "warning" ? <AlertTriangle size={14} /> : <CircleHelp size={14} />}
          {state.label}
        </span>
      </header>

      <div className="native-boundary-status__grid">
        <article className="native-boundary-status__card">
          <Radio size={16} />
          <span>
            <strong>Runtime surface</strong>
            <small>{runtime.tauri ? "Tauri desktop shell" : "Browser development preview"}</small>
          </span>
        </article>
        <article className="native-boundary-status__card">
          <ShieldCheck size={16} />
          <span>
            <strong>Core session</strong>
            <small>
              {nativeSession
                ? "Session token negotiated"
                : runtime.tauri
                  ? coreRuntime && !coreProtocolCompatible
                    ? "Session not accepted: protocol mismatch"
                    : "No valid session evidence"
                  : "Not applicable in browser"}
            </small>
          </span>
        </article>
        <article className="native-boundary-status__card">
          <CheckCircle2 size={16} />
          <span>
            <strong>Required stream capability</strong>
            <small>
              {requiredAvailable
                ? "run.stream.v1 available"
                : !runtime.tauri
                  ? "Preview fallback only"
                  : !coreRuntime
                    ? "No capability evidence"
                    : !coreProtocolCompatible
                      ? "Not accepted: protocol mismatch"
                      : "run.stream.v1 not advertised"}
            </small>
          </span>
        </article>
      </div>

      <div className="native-boundary-status__detail">
        <p className="native-boundary-status__summary">{state.detail}</p>
        {runtime.tauri && coreRuntime ? (
          <div className="native-boundary-status__capabilities">
            <span>
              <strong>{advertised.length}</strong> advertised {advertised.length === 1 ? "capability" : "capabilities"}
            </span>
            <span>
              <strong>{unavailable.length}</strong> unavailable by negotiation
            </span>
          </div>
        ) : null}
        <p className="native-boundary-status__boundary">
          {runtime.tauri
            ? "Native handshake evidence is visible above. Rust toolchain, packaged-app, provider HTTP, and release-signing evidence are separate gates."
            : "Browser preview remains renderer-local: no native storage, provider request, filesystem write, or execution authority is implied."}
        </p>
      </div>

      {runtime.tauri && coreRuntime ? (
        <div className="native-boundary-status__capability-details">
          {advertised.length > 0 ? (
            <details className="native-boundary-status__unavailable native-boundary-status__available">
              <summary>Advertised capability details</summary>
              <ul>
                {advertised.map((capability) => (
                  <li key={capability}>{capabilityLabel(capability)}</li>
                ))}
              </ul>
            </details>
          ) : null}
          {unavailable.length > 0 ? (
            <details className="native-boundary-status__unavailable">
              <summary>Unavailable capability details</summary>
              <ul>
                {unavailable.map((capability) => (
                  <li key={capability}>{capabilityLabel(capability)}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export default NativeBoundaryStatus;
