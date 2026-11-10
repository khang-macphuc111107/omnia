import { useEffect, useId, useRef, useState } from "react";

import { errorMessage } from "./agent-api";
import { updateApi, type UpdateSettings } from "./update-api";

import "./updates.css";

type Phase = "idle" | "checking" | "uptodate" | "available" | "downloading" | "ready" | "installing" | "error";

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Subtle "Update available" button for the sidebar footer. Renders nothing otherwise. */
export function UpdateBadge({ onOpen }: { onOpen: () => void }) {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let eventRevision = 0;
    let unlisten: (() => void) | null = null;
    try {
      const initialRevision = eventRevision;
      updateApi
        .getSettings()
        .then((settings) => {
          if (!live || initialRevision !== eventRevision) return;
          setVersion(settings.availableVersion);
        })
        .catch(() => undefined);
      updateApi
        .onEvent((payload) => {
          if (!live || payload.kind !== "available") return;
          const revision = ++eventRevision;
          void updateApi.getSettings().then((current) => {
            if (!live || revision !== eventRevision) return;
            // The backend snapshot is authoritative, including after a feed reset.
            setVersion(current.availableVersion);
          }).catch(() => undefined);
        })
        .then((stop) => {
          if (live) unlisten = stop;
          else stop();
        })
        .catch(() => undefined);
    } catch {
      // Not running inside the desktop shell.
    }
    return () => {
      live = false;
      unlisten?.();
    };
  }, []);

  if (!version) return null;
  return (
    <button
      type="button"
      className="ag-btn ag-btn--ghost ag-update-badge"
      onClick={onOpen}
      title={version === "new" ? "A new version of Omnia is available" : `Omnia ${version} is available`}
    >
      Update available
    </button>
  );
}

export function UpdatesSection() {
  const id = useId();
  const [settings, setSettings] = useState<UpdateSettings | null>(null);
  const [feedDraft, setFeedDraft] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [latest, setLatest] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [size, setSize] = useState(0);
  const [progress, setProgress] = useState({ received: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [signatureVerified, setSignatureVerified] = useState<boolean | null>(null);
  // Identity is independent of render timing. Generation distinguishes A -> B -> A.
  const candidateRef = useRef<number | null>(null);
  const generationRef = useRef<number | null>(null);
  const revisionRef = useRef(0);
  const operationRef = useRef<string | null>(null);
  const settingsRef = useRef<UpdateSettings | null>(null);
  const mountedRef = useRef(true);
  const settingsLoadedRef = useRef(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  // Busy actions are disabled or removed on the next render. Keep keyboard
  // focus in the section without moving it when an operation starts elsewhere.
  const focusStatus = () => {
    if (actionsRef.current?.contains(document.activeElement)) {
      statusRef.current?.focus({ preventScroll: true });
    }
  };

  const resetToCheck = () => {
    candidateRef.current = null;
    operationRef.current = null;
    revisionRef.current += 1;
    setError(null);
    setPhase("idle");
    setLatest(null);
    setNotes("");
    setSize(0);
    setProgress({ received: 0, total: 0 });
    setSignatureVerified(null);
  };

  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | null = null;
    updateApi
      .getSettings()
      .then((next) => {
        if (!live) return;
        settingsRef.current = next;
        generationRef.current = next.generation;
        settingsLoadedRef.current = true;
        setSettings(next);
        setFeedDraft(next.feedUrl);
        if (next.availableVersion) {
          candidateRef.current = next.availableCandidate ?? null;
          setLatest(next.availableVersion);
          setPhase("available");
        }
      })
      .catch((cause) => live && setError(errorMessage(cause)));
    updateApi
      .onEvent((payload) => {
        if (!live) return;
        if (payload.kind === "available") {
          // Delivery can lag a feed reset or a newer check. Confirm against an
          // atomic backend snapshot, never trust arrival order (including A-B-A).
          const revision = revisionRef.current;
          void updateApi.getSettings().then((current) => {
            if (!live || revision !== revisionRef.current || payload.generation !== current.generation ||
                payload.candidate == null || payload.candidate !== current.availableCandidate ||
                !current.availableVersion || payload.candidate === candidateRef.current) return;
            generationRef.current = current.generation;
            settingsRef.current = current;
            setSettings(current);
            candidateRef.current = payload.candidate;
            operationRef.current = null;
            setLatest(current.availableVersion);
            setNotes("");
            setSize(0);
            setError(null);
            setSignatureVerified(null);
            setPhase("available");
          }).catch(() => undefined);
          return;
        }
        if (payload.candidate == null || payload.candidate !== candidateRef.current ||
            payload.generation !== generationRef.current || !payload.operationId ||
            payload.operationId !== operationRef.current) return;
        if (payload.kind === "progress") {
          setPhase("downloading");
          setProgress({ received: payload.received, total: payload.total });
        } else if (payload.kind === "ready") {
          setProgress({ received: payload.total, total: payload.total });
          setPhase("ready");
        } else if (payload.kind === "error") {
          setPhase("error");
          setError(payload.message ?? "The update failed.");
        }
      })
      .then((stop) => {
        if (live) unlisten = stop;
        else stop();
      })
      .catch(() => undefined);
    return () => {
      live = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; revisionRef.current += 1; };
  }, []);

  const saveSettings = async (feedUrl: string, autoCheck: boolean, allowUnsigned?: boolean) => {
    setError(null);
    try {
      const next = await updateApi.setSettings(feedUrl, autoCheck, allowUnsigned);
      if (!mountedRef.current || !settingsLoadedRef.current || next.generation < (generationRef.current ?? 0)) return;
      const feedChanged = next.generation !== generationRef.current || next.feedUrl !== settingsRef.current?.feedUrl;
      generationRef.current = next.generation;
      settingsRef.current = next;
      setSettings(next);
      setFeedDraft(next.feedUrl);
      // The backend dropped its pending release (feed change): back to the check state.
      if (feedChanged || next.pendingReset) resetToCheck();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const checkNow = async () => {
    const revision = ++revisionRef.current;
    const generation = generationRef.current;
    operationRef.current = null;
    const current = () => mountedRef.current && revision === revisionRef.current && generation === generationRef.current;
    focusStatus();
    setPhase("checking");
    setError(null);
    try {
      const result = await updateApi.check();
      if (!current() || result.generation !== generation) return;
      // A result committed before a reset may be delivered after it. A backend
      // snapshot also rejects a replacement candidate in the same generation.
      const snapshot = await updateApi.getSettings();
      if (!current() || snapshot.generation !== result.generation) return;
      settingsRef.current = snapshot;
      setSettings(snapshot);
      const resultIsCurrent = result.available
        ? snapshot.availableCandidate === result.candidate && snapshot.availableVersion === result.latest
        : snapshot.availableCandidate == null && snapshot.availableVersion == null;
      if (!resultIsCurrent) {
        // A later check may have replaced this candidate while the response was in flight.
        candidateRef.current = snapshot.availableCandidate;
        operationRef.current = null;
        setLatest(snapshot.availableVersion);
        setNotes("");
        setSize(0);
        setProgress({ received: 0, total: 0 });
        setSignatureVerified(null);
        setPhase(snapshot.availableVersion ? "available" : "uptodate");
        return;
      }
      candidateRef.current = result.available ? result.candidate : null;
      operationRef.current = null;
      setSignatureVerified(result.signatureVerified);
      setLatest(result.available ? result.latest : null);
      setNotes(result.available ? result.notes : "");
      setSize(result.available ? result.size : 0);
      setProgress({ received: 0, total: 0 });
      setPhase(result.available ? "available" : "uptodate");
    } catch (cause) {
      if (!current()) return;
      setPhase("error");
      setError(errorMessage(cause));
    }
  };

  const download = async () => {
    const candidate = candidateRef.current;
    const generation = generationRef.current;
    if (candidate === null || generation === null) return;
    const revision = ++revisionRef.current;
    const operation = crypto.randomUUID();
    operationRef.current = operation;
    const current = () => mountedRef.current && revision === revisionRef.current &&
      candidateRef.current === candidate && generationRef.current === generation && operationRef.current === operation;
    focusStatus();
    setPhase("downloading");
    setProgress({ received: 0, total: size });
    setError(null);
    try {
      await updateApi.download(candidate, generation, operation);
      if (!current()) return;
      setPhase("ready");
    } catch (cause) {
      if (!current()) return;
      setPhase("error");
      setError(errorMessage(cause));
    }
  };

  const install = async () => {
    const candidate = candidateRef.current;
    if (candidate === null) return;
    const revision = ++revisionRef.current;
    focusStatus();
    setPhase("installing");
    setError(null);
    try {
      await updateApi.install(candidate);
    } catch (cause) {
      if (!mountedRef.current || revision !== revisionRef.current || candidate !== candidateRef.current) return;
      setPhase("error");
      setError(errorMessage(cause));
    }
  };

  const setAllowUnsigned = (allow: boolean) =>
    void saveSettings(settings?.feedUrl ?? "", settings?.autoCheck ?? false, allow);

  const feedConfigured = (settings?.feedUrl ?? "") !== "";
  const unsignedActive = settings?.allowUnsigned === true && !settings.keyConfigured && !settings.keyInvalid;
  const blockedUnsigned = !!settings && !settings.keyConfigured && !settings.keyInvalid && !settings.allowUnsigned;
  const percent = progress.total > 0 ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : 0;
  const busy = phase === "checking" || phase === "downloading" || phase === "installing";
  let status: string;
  if (!settings) status = "Loading update settings…";
  else if (!feedConfigured) status = "Updates are off: no update feed is configured.";
  else if (phase === "checking") status = "Checking for updates…";
  else if (phase === "uptodate") status = `Omnia is up to date (${settings.currentVersion}).`;
  else if (phase === "available") status = `Update ${latest ?? "available"} is available.`;
  else if (phase === "downloading") status = `Downloading update… ${percent}%`;
  else if (phase === "ready") status = "Update downloaded and verified. Ready to install.";
  else if (phase === "installing") status = "Starting the installer…";
  else if (phase === "error") status = "The update could not be completed.";
  else status = "Not checked yet.";

  return (
    <section className="ag-updates" aria-labelledby={`${id}-title`}>
      <h3 className="ag-subtitle" id={`${id}-title`}>
        Updates
      </h3>
      <p className="ag-muted">
        Omnia only contacts the update feed you enter here, and only when you check or enable the daily check. Installers
        are verified by SHA-256 before they run.
      </p>
      <p className="ag-muted">Current version: {settings?.currentVersion ?? "…"}</p>
      <div className="ag-field">
        <label className="ag-label" htmlFor={`${id}-feed`}>
          Update feed URL
        </label>
        <div className="ag-row ag-updates__feed">
          <input
            id={`${id}-feed`}
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            aria-describedby={error ? `${id}-error` : undefined}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing || !settings ||
                  phase === "downloading" || phase === "installing" || feedDraft.trim() === settings.feedUrl) return;
              event.preventDefault();
              void saveSettings(feedDraft, settings.autoCheck);
            }}
            className="ag-input"
            value={feedDraft}
            placeholder="https://example.com/omnia/update.json"
            spellCheck={false}
            onChange={(event) => setFeedDraft(event.target.value)}
          />
          <button
            type="button"
            className="ag-btn"
            disabled={!settings || phase === "downloading" || phase === "installing" || feedDraft.trim() === settings.feedUrl}
            onClick={() => void saveSettings(feedDraft, settings?.autoCheck ?? false)}
          >
            Save feed
          </button>
        </div>
      </div>
      <label className="ag-row ag-updates__toggle">
        <input
          type="checkbox"
          role="switch"
          aria-label="Check automatically on startup (daily)"
          checked={settings?.autoCheck === true}
          disabled={!settings || !feedConfigured}
          onChange={(event) => void saveSettings(settings?.feedUrl ?? "", event.target.checked)}
        />
        <span>Check automatically on startup (daily)</span>
      </label>
      {settings?.keyInvalid ? (
        <p className="ag-error" role="alert">
          This build contains an invalid update signing key, so updates are disabled.
        </p>
      ) : null}
      {settings?.keyConfigured && settings.keyFingerprint ? (
        <p className="ag-muted">Signing key configured (fingerprint: {settings.keyFingerprint}). Each release is checked against it.</p>
      ) : null}
      {feedConfigured && blockedUnsigned ? (
        <p className="ag-error" role="note">
          Unsigned feed: this build has no release signing key, so updates can be checked but will not be downloaded or
          installed unless you allow unsigned updates below.
        </p>
      ) : null}
      {settings && !settings.keyConfigured && !settings.keyInvalid ? (
        <label className="ag-row ag-updates__toggle">
          <input
            type="checkbox"
            role="switch"
            aria-label="Allow unsigned updates (I trust this feed)"
            checked={settings.allowUnsigned}
            disabled={!feedConfigured || busy}
            onChange={(event) => setAllowUnsigned(event.target.checked)}
          />
          <span>Allow unsigned updates (I trust this feed)</span>
        </label>
      ) : null}
      {unsignedActive ? (
        <p className="ag-error" role="alert" data-testid="unsigned-warning">
          WARNING: unsigned updates are enabled. Anything the feed serves, with a matching SHA-256 it publishes itself,
          will run as an installer on this computer. If the feed or its server is compromised, so is this PC. Turn this
          off unless you control the feed. It resets whenever you change the feed URL.
        </p>
      ) : null}
      <div className="ag-row" ref={actionsRef}>
        <button type="button" className="ag-btn" disabled={!feedConfigured || busy} onClick={() => void checkNow()}>
          Check now
        </button>
        {phase === "available" ? (
          <button
            type="button"
            className="ag-btn ag-btn--primary"
            disabled={settings?.keyInvalid === true || blockedUnsigned}
            onClick={() => void download()}
          >
            Download
          </button>
        ) : null}
        {phase === "ready" ? (
          <button
            type="button"
            className="ag-btn ag-btn--primary"
            disabled={settings?.keyInvalid === true || blockedUnsigned}
            onClick={() => void install()}
          >
            {unsignedActive ? "Install UNSIGNED update and restart" : "Install and restart"}
          </button>
        ) : null}
      </div>
      <p className="ag-muted" role="status" aria-atomic="true" tabIndex={-1} ref={statusRef}>
        {status}
        {phase === "available" && size > 0 ? ` (${formatSize(size)})` : ""}
      </p>
      {settings?.keyConfigured && signatureVerified !== null && (phase === "available" || phase === "ready" || phase === "uptodate") ? (
        <p className={signatureVerified ? "ag-muted" : "ag-error"} role="note" data-testid="signature-state">
          {signatureVerified
            ? "Signature verified against the built-in signing key."
            : "Signature NOT verified: this release will be refused."}
        </p>
      ) : null}
      {unsignedActive && (phase === "available" || phase === "ready" || phase === "uptodate") ? (
        <p className="ag-error" role="alert">
          This update is not signature-verified (unsigned updates are allowed).
        </p>
      ) : null}
      {phase === "downloading" ? <progress aria-label="Update download progress" max={100} value={percent} /> : null}
      {notes && (phase === "available" || phase === "ready" || phase === "downloading") ? (
        <pre className="ag-muted ag-updates__notes" role="region" aria-label="Release notes" tabIndex={0}>
          {notes}
        </pre>
      ) : null}
      {error ? (
        <p className="ag-error" role="alert" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </section>
  );
}
