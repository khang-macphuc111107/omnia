import { Suspense, lazy, useEffect, useMemo, useState, type ComponentType } from "react";

import { LazyLoadBoundary } from "@/components/lazy-load-boundary";

import type { ActivityScreenProps } from "../activity-registry";

export type LibraryWorkbenchId =
  | "sovereign-browser"
  | "idm-downloader"
  | "sovereign-ide-remote"
  | "calculator-verifier"
  | "session-dfs"
  | "knowledge-tree"
  | "media"
  | "research"
  | "academic"
  | "citation-ledger"
  | "prompts"
  | "template-lab"
  | "experiments"
  | "evaluation"
  | "algorithms"
  | "technical"
  | "finance"
  | "science-lab"
  | "artifacts";

declare global {
  interface Window {
    __OMNIA_PENDING_WORKBENCH__?: LibraryWorkbenchId;
    __OMNIA_PENDING_DOWNLOAD_URL__?: string;
  }
}

type LibraryWorkbenchDescriptor = {
  readonly id: LibraryWorkbenchId;
  readonly label: string;
  readonly eyebrow: string;
  readonly description: string;
  readonly load: () => Promise<{ default: ComponentType }>;
};

const workbenches: readonly LibraryWorkbenchDescriptor[] = [
  { id: "sovereign-browser", label: "Sovereign Browser & F12", eyebrow: "Unrestricted browser + DevTools", description: "Browse web surfaces with full permission controls, Edge/Chrome Canary profile linking, live DOM/Console/Network/Application F12 DevTools, and 1-click stream capture.", load: () => import("../sovereign-browser-workbench") },
  { id: "idm-downloader", label: "Ultra IDM+ Downloader", eyebrow: "Lookahead stream, Cloud/GDrive & High-DPI PDF grabber", description: "Capture and merge .m3u8 HLS, .mpd DASH, blob streams, Google Drive/OneDrive media, 1200-DPI PDFs, and 32-segment dynamic work-stealing downloads.", load: () => import("../ultra-idm-downloader-workbench") },
  { id: "sovereign-ide-remote", label: "Sovereign IDE & Remote Desktop", eyebrow: "Polyglot IDE, multi-monitor screen share & remote disk", description: "Edit and run workspace code, share and control multi-monitor or per-window desktops with remote mouse/keyboard input, and browse local/remote disks.", load: () => import("../sovereign-ide-remote-workbench") },
  { id: "calculator-verifier", label: "Calculator & Anti-Hallucination", eyebrow: "Scientific calc & deterministic verifier", description: "Run deterministic scientific/programmer math, unit/base conversions, and automatic anti-hallucination claim verification.", load: () => import("../builtin-calculator-workbench") },
  { id: "session-dfs", label: "Session DFS Tree", eyebrow: "Multi-parent DAG, /btw side-chat & A->B->C DFS", description: "Copy live session URIs, spawn unlimited subagent swarms with multi-parent AI councils, use /btw side-chat, and traverse session graphs in pre-order DFS.", load: () => import("../session-dfs-explorer") },
  { id: "knowledge-tree", label: "Knowledge Tree & Harnesses", eyebrow: "LTST memory, 9 harnesses & local uncensored AI", description: "Explore hierarchical LTST knowledge folders/nodes, configure all 9 official agent harnesses, and deploy hardware-tailored local uncensored AI models.", load: () => import("../knowledge-tree-explorer") },
  { id: "media", label: "Media", eyebrow: "Image, video and audio", description: "Stage multimodal generation requests and inspect preview jobs.", load: () => import("../media-generation-studio") },
  { id: "research", label: "Research", eyebrow: "Sources and notes", description: "Collect a source-grounded research notebook preview.", load: async () => ({ default: (await import("../research-notebook-preview")).ResearchNotebookPreview }) },
  { id: "academic", label: "Academic", eyebrow: "Writing and citations", description: "Draft papers, citations, and review checklists.", load: () => import("../academic-studio-preview") },
  { id: "citation-ledger", label: "Citation Ledger", eyebrow: "Claims and evidence", description: "Map claims to source records and review evidence coverage.", load: () => import("../academic-citation-ledger-preview") },
  { id: "prompts", label: "Prompts", eyebrow: "Reusable prompt assets", description: "Browse and customize prompt templates.", load: () => import("../prompt-library-preview") },
  { id: "template-lab", label: "Template Lab", eyebrow: "Prompt case rehearsal", description: "Exercise examples, typed input coverage, and resolved prompt checks.", load: () => import("../prompt-template-lab-preview") },
  { id: "experiments", label: "Experiments", eyebrow: "Prompt comparison", description: "Compare prompt variants in a renderer-local experiment.", load: () => import("../prompt-experiment-studio") },
  { id: "evaluation", label: "Evaluation", eyebrow: "Model quality", description: "Prepare scorecards and evaluation runs for review.", load: () => import("../model-evaluation-studio") },
  { id: "algorithms", label: "Algorithms", eyebrow: "CP and algorithm lab", description: "Explore algorithms, traces, complexity, and snippets.", load: () => import("../algorithm-lab-preview") },
  { id: "technical", label: "Technical", eyebrow: "Science and finance", description: "Explore technical, math, science, and finance workbench previews.", load: () => import("../technical-lab-preview") },
  { id: "finance", label: "Finance", eyebrow: "Budgets and cash flow", description: "Rehearse a local budget, cash-flow posture, and bounded planning scenarios.", load: () => import("../finance-workspace-preview") },
  { id: "science-lab", label: "Science Lab", eyebrow: "Protocols and observations", description: "Turn a scientific question into a renderer-local experiment notebook.", load: async () => ({ default: (await import("../science-notebook-lab-preview")).ScienceNotebookLabPreview }) },
  { id: "artifacts", label: "Artifacts", eyebrow: "Files and durable outputs", description: "Browse library artifacts and attached knowledge projections.", load: async () => ({ default: (await import("../library-screen")).LibraryScreen }) },
];

const workbenchGroups = [
  // Browser and IDE have their own rail views, so the picker doesn't list them again;
  // they stay in `workbenches` for the omnia:open-sovereign-workbench event.
  { label: "Tools", ids: ["idm-downloader", "calculator-verifier", "session-dfs", "knowledge-tree"] },
  { label: "Research & writing", ids: ["research", "academic", "citation-ledger"] },
  { label: "Prompt & evaluation", ids: ["prompts", "template-lab", "experiments", "evaluation"] },
  { label: "Technical labs", ids: ["algorithms", "technical", "finance", "science-lab"] },
  { label: "Media & assets", ids: ["media", "artifacts"] },
] as const;

function LibraryWorkbenchLoadingState({ descriptor }: { descriptor: LibraryWorkbenchDescriptor }) {
  return (
    <section className="library-workbench-loading" role="status" aria-live="polite">
      <span className="activity-load-progress" aria-hidden="true" />
      <div>
        <span className="eyebrow">Opening {descriptor.eyebrow}</span>
        <strong>{descriptor.label} workbench</strong>
        <small>Loading this optional library surface without changing the active conversation.</small>
      </div>
    </section>
  );
}

export default function LibraryActivityScreen(_props: Partial<ActivityScreenProps>) {
  const [activeWorkbenchId, setActiveWorkbenchId] = useState<LibraryWorkbenchId>(() => {
    if (typeof window !== "undefined" && window.__OMNIA_PENDING_WORKBENCH__) {
      const pending = window.__OMNIA_PENDING_WORKBENCH__;
      if (workbenches.some((item) => item.id === pending)) {
        return pending;
      }
    }
    return "research";
  });
  const [retryKey, setRetryKey] = useState(0);
  const [stageVisible, setStageVisible] = useState(true);
  const [queuedDownloadBannerUrl, setQueuedDownloadBannerUrl] = useState<string | null>(null);
  const activeWorkbench = workbenches.find((item) => item.id === activeWorkbenchId) ?? workbenches[0]!;
  const Workbench = useMemo(() => lazy(activeWorkbench.load), [activeWorkbench, retryKey]);

  const openWorkbench = (nextWorkbenchId: LibraryWorkbenchId) => {
    setActiveWorkbenchId(nextWorkbenchId);
    setStageVisible(true);
    setRetryKey(0);
  };

  useEffect(() => {
    if (typeof window !== "undefined" && window.__OMNIA_PENDING_WORKBENCH__) {
      const pending = window.__OMNIA_PENDING_WORKBENCH__;
      delete window.__OMNIA_PENDING_WORKBENCH__;
      if (workbenches.some((item) => item.id === pending)) {
        openWorkbench(pending);
      }
    }
    const handleOpenSovereign = (event: Event) => {
      const custom = event as CustomEvent<{ workbenchId?: LibraryWorkbenchId }>;
      const targetId = custom.detail?.workbenchId;
      if (targetId && workbenches.some((item) => item.id === targetId)) {
        if (typeof window !== "undefined") {
          delete window.__OMNIA_PENDING_WORKBENCH__;
        }
        openWorkbench(targetId);
      }
    };
    const handleEnqueueDownload = (event: Event) => {
      const custom = event as CustomEvent<{ url?: string }>;
      const url = custom.detail?.url;
      if (typeof url === "string" && url.trim()) {
        window.__OMNIA_PENDING_DOWNLOAD_URL__ = url.trim();
        setQueuedDownloadBannerUrl(url.trim());
      }
    };
    window.addEventListener("omnia:open-sovereign-workbench", handleOpenSovereign);
    window.addEventListener("omnia:enqueue-download", handleEnqueueDownload);
    return () => {
      window.removeEventListener("omnia:open-sovereign-workbench", handleOpenSovereign);
      window.removeEventListener("omnia:enqueue-download", handleEnqueueDownload);
    };
  }, []);

  return (
    <div className="library-activity-stack">
      <div className="sw-library-studio-bar">
        <header className="library-workbench-switcher sr-only">
          <h1>Research, creation and technical workbenches</h1>
          <p>Open one focused surface at a time. Each remains a renderer-local preview until its native capability is wired.</p>
        </header>

        <div className="library-workbench-picker">
          <label htmlFor="library-workbench-select">
            <span className="sr-only">Open workbench</span>
            <select
              id="library-workbench-select"
              value={activeWorkbenchId}
              onChange={(event) => openWorkbench(event.target.value as LibraryWorkbenchId)}
              aria-describedby="library-workbench-picker-help"
            >
              {workbenchGroups.map((group) => (
                <optgroup label={group.label} key={group.label}>
                  {group.ids.map((id) => {
                    const workbench = workbenches.find((item) => item.id === id);
                    return workbench ? <option value={workbench.id} key={workbench.id}>{workbench.label} — {workbench.eyebrow}</option> : null;
                  })}
                </optgroup>
              ))}
            </select>
          </label>
          <span id="library-workbench-picker-help" className="sr-only">{workbenches.length} focused surfaces · one open at a time</span>
        </div>
      </div>

      {queuedDownloadBannerUrl && activeWorkbenchId !== "idm-downloader" ? (
        <div className="sovereign-card" role="status" aria-live="polite" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" }}>
          <div>
            <strong>Stream captured for Ultra IDM+:</strong>{" "}
            <code className="sovereign-mono">{queuedDownloadBannerUrl}</code>
          </div>
          <button
            type="button"
            className="sovereign-btn sovereign-btn--primary"
            onClick={() => {
              openWorkbench("idm-downloader");
              setQueuedDownloadBannerUrl(null);
            }}
          >
            Open in Ultra IDM+ Downloader
          </button>
        </div>
      ) : null}

      {stageVisible ? (
        <section id="library-workbench-panel" className="library-workbench-stage" aria-label={`${activeWorkbench.label} workbench preview`}>
          <div className="library-workbench-stage__heading sr-only">
            <div className="library-workbench-stage__breadcrumb">
              <span className="eyebrow">{activeWorkbench.eyebrow}</span>
              <span aria-hidden="true">/</span>
              <h2>{activeWorkbench.label}</h2>
              <p>{activeWorkbench.description}</p>
            </div>
            <small>Renderer-local · live workspace</small>
          </div>
          <LazyLoadBoundary
            label={`${activeWorkbench.label} workbench`}
            resetKey={`${activeWorkbench.id}:${retryKey}`}
            onDismiss={() => setStageVisible(false)}
            onRetry={() => setRetryKey((value) => value + 1)}
          >
            <Suspense fallback={<LibraryWorkbenchLoadingState descriptor={activeWorkbench} />}>
              <Workbench />
            </Suspense>
          </LazyLoadBoundary>
        </section>
      ) : (
        <section className="library-workbench-empty" aria-label="Library workbench closed">
          <strong>Workbench closed</strong>
          <span>Choose a surface above to reopen a renderer-local preview.</span>
          <button type="button" className="button button--secondary" title={`Reopen the ${activeWorkbench.label} renderer preview`} onClick={() => setStageVisible(true)}>Reopen {activeWorkbench.label}</button>
        </section>
      )}
    </div>
  );
}

