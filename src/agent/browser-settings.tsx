import { useEffect, useId, useRef, useState } from "react";
import { ModalSurface } from "@/components/modal-surface";
import "./browser-settings.css";
import { agentApi } from "./agent-api";
import type { AgentServicesStatus, ProfileMode } from "./types";

const MODE_LABEL: Record<ProfileMode, string> = {
  persistent: "Saved profile (sign-ins kept)",
  disposable_fallback: "Temporary profile (the saved profile is in use by another session)",
  disposable: "Temporary profile (deleted when the session closes)",
};

function validUrl(value: string): boolean {
  if (!value.trim()) return true;
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch { return false; }
}

/** Browser sign-in persistence and ffmpeg controls. Opening the browser is always an explicit click. */
export function BrowserSettingsSection({ sessionId, status, busy, act }: {
  sessionId: string;
  status: AgentServicesStatus;
  busy: boolean;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const keep = status.browser.keepSignIns ?? true;
  const mode = status.browser.profileMode;
  const ffmpeg = status.ffmpeg;
  const [signInUrl, setSignInUrl] = useState("");
  const [ffmpegPath, setFfmpegPath] = useState(ffmpeg?.configuredPath ?? "");
  const [confirmClear, setConfirmClear] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const clearTitleId = useId();
  const clearDescriptionId = useId();
  useEffect(() => { setFfmpegPath(ffmpeg?.configuredPath ?? ""); }, [ffmpeg?.configuredPath]);
  return <section className="ag-browser-settings" aria-labelledby={headingId}>
    <h3 id={headingId} className="ag-subtitle">Browser sign-ins</h3>
    <p className="ag-muted">Omnia keeps sign-ins in its own browser profile, separate from your personal browser. Sign in yourself in the window it opens; Omnia never types your password.</p>
    <label className="ag-row"><input type="checkbox" checked={keep} disabled={busy}
      onChange={(event) => void act(() => agentApi.browserSettingsSet(sessionId, { keepSignIns: event.target.checked }))} />Keep browser sign-ins</label>
    <p role="status">Profile: {mode ? MODE_LABEL[mode] : keep ? "Saved profile (sign-ins kept)" : MODE_LABEL.disposable}</p>
    <label className="ag-label">Sign-in page (optional)
      <input className="ag-input" value={signInUrl} placeholder="https://example.com/login" disabled={busy} onChange={(event) => setSignInUrl(event.target.value)} />
    </label>
    <div className="ag-row">
      <button type="button" className="ag-btn" disabled={busy || !status.browser.available || !validUrl(signInUrl)}
        onClick={() => void act(() => agentApi.browserOpenForSignin(sessionId, signInUrl.trim() || undefined))}>Open browser to sign in</button>
      <button type="button" className="ag-btn ag-btn--danger" disabled={busy} onClick={() => setConfirmClear(true)}>Clear browser data</button>
    </div>
    {confirmClear ? <ModalSurface
      className="ag-dialog ag-dialog--small ag-browser-settings__confirm"
      scrimClassName="ag-scrim ag-browser-settings__scrim"
      titleId={clearTitleId}
      descriptionId={clearDescriptionId}
      initialFocusRef={cancelRef}
      onClose={() => setConfirmClear(false)}
    >
      <h2 id={clearTitleId} className="ag-dialog__title">Clear browser data</h2>
      <p id={clearDescriptionId} className="ag-muted">This signs you out of every site in Omnia's browser profile. It is refused while a session browser is using it.</p>
      <div className="ag-dialog__actions">
        <button ref={cancelRef} type="button" className="ag-btn" onClick={() => setConfirmClear(false)}>Cancel</button>
        <button type="button" className="ag-btn ag-btn--danger" disabled={busy}
          onClick={() => { setConfirmClear(false); void act(() => agentApi.browserClearData()); }}>Clear data</button>
      </div>
    </ModalSurface> : null}
    <h3 className="ag-subtitle">ffmpeg</h3>
    <p role="status">{ffmpeg?.available ? `ffmpeg found: ${ffmpeg.path ?? ""}` : "ffmpeg not found. Separate audio and video tracks are kept as raw files."}</p>
    <label className="ag-label">Custom ffmpeg path (blank to auto-detect)
      <input className="ag-input" value={ffmpegPath} placeholder="C:\tools\ffmpeg\bin\ffmpeg.exe" disabled={busy} onChange={(event) => setFfmpegPath(event.target.value)} />
    </label>
    <div className="ag-row">
      <button type="button" className="ag-btn" disabled={busy || ffmpegPath.trim() === (ffmpeg?.configuredPath ?? "")}
        onClick={() => void act(() => agentApi.browserSettingsSet(sessionId, { ffmpegPath: ffmpegPath.trim() }))}>Save ffmpeg path</button>
    </div>
  </section>;
}
