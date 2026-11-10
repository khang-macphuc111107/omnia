import { Braces, Globe2, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { isDesktopRuntime } from "@/lib/desktop";

import { readRuntimeSettings } from "./runtime-settings";

import "./harness-status.css";

/** Compact, truthful capability receipt on the start surface. */
export function HarnessStatus({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const [settings, setSettings] = useState(() => readRuntimeSettings());
  useEffect(() => {
    const onSettings = (event: Event) => {
      const detail = (event as CustomEvent<ReturnType<typeof readRuntimeSettings>>).detail;
      if (detail) setSettings(detail);
    };
    window.addEventListener("omnia:runtime-settings", onSettings);
    return () => window.removeEventListener("omnia:runtime-settings", onSettings);
  }, []);
  const native = isDesktopRuntime();
  return (
    <section className="ag-harness-status" aria-label="Omnia harness status">
      <div className="ag-harness-status__heading"><Sparkles size={14} aria-hidden="true" /><strong>Harness posture</strong><span className="ag-muted">live renderer policy</span></div>
      <div className="ag-harness-status__grid">
        <div><Braces size={14} aria-hidden="true" /><span><b>{(settings.contextWindowTokens / 1000).toLocaleString()}k</b><small>context budget</small></span></div>
        <div><ShieldCheck size={14} aria-hidden="true" /><span><b>{(settings.toolOutputLimitChars / 1000).toLocaleString()}k</b><small>tool output cap</small></span></div>
        <div><Globe2 size={14} aria-hidden="true" /><span><b>{native ? "Native" : "Preview"}</b><small>RAG/index bridge</small></span></div>
      </div>
      <div className="ag-harness-status__footer"><span>{settings.autoPlan ? "Plan-first" : "Plan on request"} · {settings.autoResearch ? "research aware" : "research on request"} · {settings.defaultEffort} effort · retry {settings.retryPolicy.retryDelaySeconds}s × {settings.retryPolicy.retryMultiplier} · {settings.retryPolicy.maxAttempts ?? "∞"}</span>{onOpenSettings ? <button type="button" className="ag-link" onClick={onOpenSettings}>Tune runtime</button> : null}</div>
    </section>
  );
}
