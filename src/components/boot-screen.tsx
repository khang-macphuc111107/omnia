import type { AppRuntimeInfo } from "@/lib/desktop";

import { OmniaLogo } from "./omnia-logo";

interface BootScreenProps {
  runtime: AppRuntimeInfo | null;
  error: string | null;
}

export function BootScreen({ runtime, error }: BootScreenProps) {
  const runtimeLabel = runtime
    ? `${runtime.appName} ${runtime.appVersion} · ${runtime.platform} · ${runtime.tauri ? "desktop" : "browser preview"}`
    : null;

  return (
    <main className="boot-screen" data-state={error ? "error" : "loading"}>
      <section className="boot-screen__identity" aria-labelledby="boot-screen-title">
        <div className="boot-screen__mark" aria-hidden="true">
          <OmniaLogo size={56} label={null} />
        </div>

        <div className="boot-screen__wordmark">
          <h1 id="boot-screen-title">Omnia</h1>
          <p>AI workbench</p>
        </div>

        {error ? (
          <div className="boot-screen__notice" role="alert">
            <strong>Omnia could not finish starting.</strong>
            <span>{error}</span>
            {runtimeLabel ? <small>{runtimeLabel}</small> : null}
          </div>
        ) : (
          <div className="boot-screen__progress" role="status" aria-live="polite">
            <span className="boot-screen__progress-track" aria-hidden="true">
              <span />
            </span>
            <span className="boot-screen__status-copy">
              <span>Opening your workspace</span>
              {runtimeLabel ? <small>{runtimeLabel}</small> : null}
            </span>
          </div>
        )}
      </section>
    </main>
  );
}
