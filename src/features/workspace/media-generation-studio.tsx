import {
  AudioLines,
  Check,
  CheckCircle2,
  CircleStop,
  Clipboard,
  Download,
  Film,
  Image as ImageIcon,
  Layers3,
  Grid2X2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  ShieldAlert,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";

import {
  MEDIA_GENERATION_LIFECYCLE,
  buildMediaGenerationPreviewJob,
  mediaGenerationActionAvailability,
  mediaGenerationStatusLabel,
  validateMediaGenerationDraft,
  type MediaGenerationDraft,
  type MediaGenerationPreviewJob,
  type MediaGenerationValidation,
} from "./media-generation-orchestration";
import { MediaGalleryPreview, type MediaGalleryRecentItem } from "./media-gallery-preview";
import { MediaCapabilityPreview } from "./media-capability-preview";
import {
  DEFAULT_MEDIA_STORYBOARD,
  MediaStoryboardPreview,
  type MediaStoryboardShot,
} from "./media-storyboard-preview";
import { createOmniaMediaRuntimeAdapter, type MediaRuntimeJobRecord, type OmniaMediaRuntimeAdapter } from "@/domain/omnia-media-runtime-adapter";

type MediaMode = "image" | "video" | "audio";
type VideoOperation = "text-to-video" | "storyboard";
type StudioTab = "create" | "queue" | "gallery" | "history";
type ExportFormat = "json" | "markdown";
type JobStatus = "queued" | "paused" | "ready" | "attention" | "cancelled";

type GenerationDraft = {
  prompt: string;
  negativePrompt: string;
  aspectRatio: string;
  resolution: string;
  duration: string;
  quality: string;
  seed: string;
  outputCount: string;
  transparent: boolean;
  motion: string;
  frameRate: string;
  includeAudio: boolean;
  voice: string;
  format: string;
};

type GenerationJob = {
  id: string;
  title: string;
  mode: MediaMode;
  status: JobStatus;
  preset: string;
  output: string;
  detail: string;
  createdAt: string;
  routeLabel?: string;
  modelLabel?: string;
  prompt?: string;
  operation?: VideoOperation;
  storyboardShots?: readonly MediaStoryboardShot[];
  /** Domain adapter linkage. Preview jobs never imply provider execution. */
  runtimeJobId?: string;
  runtimeQueueItemId?: string;
};

type EndpointProfile = {
  id: string;
  label: string;
  provider: string;
  endpoint: string;
  authLabel: string;
};

type Preset = {
  id: string;
  name: string;
  description: string;
  mode: MediaMode;
  accent: "blue" | "amber" | "teal" | "coral";
  settings: Partial<GenerationDraft>;
};

type PreviewBoardProps = {
  mode: MediaMode;
  draft: GenerationDraft;
  showGuides: boolean;
  onShowGuidesChange: (value: boolean) => void;
};

const modeLabels: Record<MediaMode, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
};

const modeDescriptions: Record<MediaMode, string> = {
  image: "Create polished illustrations, diagrams, UI concepts, and visual assets.",
  video: "Plan short clips with framing, motion, duration, and optional audio.",
  audio: "Draft voice, soundscape, and music generation requests with explicit format.",
};

const modeOutputLabels: Record<MediaMode, string> = {
  image: "PNG / WebP preview",
  video: "MP4 / WebM preview",
  audio: "WAV / MP3 preview",
};

const modeIcon = (mode: MediaMode, size = 16): ReactNode => {
  if (mode === "image") return <ImageIcon size={size} />;
  if (mode === "video") return <Film size={size} />;
  return <AudioLines size={size} />;
};

const defaultDraft: GenerationDraft = {
  prompt: "A calm, high-contrast developer workspace with warm desk light and precise details",
  negativePrompt: "blurry, noisy, unreadable text, distorted geometry",
  aspectRatio: "16:9",
  resolution: "2048",
  duration: "8",
  quality: "high",
  seed: "auto",
  outputCount: "2",
  transparent: false,
  motion: "slow push-in",
  frameRate: "24",
  includeAudio: false,
  voice: "neutral narrator",
  format: "wav",
};

const presets: readonly Preset[] = [
  {
    id: "coder-visuals",
    name: "Coder visuals",
    description: "Crisp diagrams, UI concepts, and technical illustrations.",
    mode: "image",
    accent: "blue",
    settings: { aspectRatio: "16:9", resolution: "2048", quality: "high", outputCount: "2" },
  },
  {
    id: "cinematic-motion",
    name: "Cinematic motion",
    description: "A restrained camera move with a clear subject and clean lighting.",
    mode: "video",
    accent: "coral",
    settings: { aspectRatio: "16:9", duration: "8", quality: "high", motion: "slow push-in", frameRate: "24" },
  },
  {
    id: "research-voice",
    name: "Research voice",
    description: "A calm narrated brief with a legible, editable delivery plan.",
    mode: "audio",
    accent: "teal",
    settings: { duration: "60", quality: "balanced", voice: "neutral narrator", format: "wav" },
  },
  {
    id: "fast-ideation",
    name: "Fast ideation",
    description: "Quick low-cost variants for deciding direction before a final render.",
    mode: "image",
    accent: "amber",
    settings: { aspectRatio: "1:1", resolution: "1024", quality: "draft", outputCount: "4" },
  },
];

const endpointProfiles: readonly EndpointProfile[] = [
  {
    id: "omnia-preview",
    label: "Omnia preview route",
    provider: "Renderer rehearsal",
    endpoint: "preview://not-connected",
    authLabel: "No credentials",
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible gateway",
    provider: "User-configured gateway",
    endpoint: "https://your-gateway.example/v1",
    authLabel: "Native secret store (planned)",
  },
  {
    id: "local-gateway",
    label: "Local model gateway",
    provider: "Self-hosted runtime",
    endpoint: "http://127.0.0.1:8000/v1",
    authLabel: "Local session (planned)",
  },
];

const modelOptions: Record<MediaMode, readonly string[]> = {
  image: ["omnia-image-preview", "flux-compatible-preview", "sdxl-compatible-preview"],
  video: ["omnia-motion-preview", "video-diffusion-preview", "storyboard-preview"],
  audio: ["omnia-voice-preview", "narration-compatible-preview", "soundscape-preview"],
};

const defaultModelForMode: Record<MediaMode, string> = {
  image: modelOptions.image[0]!,
  video: modelOptions.video[0]!,
  audio: modelOptions.audio[0]!,
};

const defaultEndpointProfile = endpointProfiles[0]!;

const seedQueue: readonly GenerationJob[] = [
  {
    id: "job-video-01",
    title: "Omnia launch loop",
    mode: "video",
    status: "queued",
    preset: "Cinematic motion",
    output: "MP4 / WebM preview",
    detail: "16:9 · 8 s · 24 fps",
    createdAt: "Queued in preview",
  },
  {
    id: "job-audio-01",
    title: "Architecture narration",
    mode: "audio",
    status: "attention",
    preset: "Research voice",
    output: "WAV / MP3 preview",
    detail: "60 s · neutral narrator",
    createdAt: "Waiting for endpoint",
  },
];

const seedHistory: readonly GenerationJob[] = [
  {
    id: "history-image-01",
    title: "Command ring logo study",
    mode: "image",
    status: "ready",
    preset: "Coder visuals",
    output: "PNG / WebP preview",
    detail: "1:1 · 2048 px · 2 variants",
    createdAt: "Renderer result · today",
  },
  {
    id: "history-image-02",
    title: "Dark IDE moodboard",
    mode: "image",
    status: "ready",
    preset: "Fast ideation",
    output: "PNG / WebP preview",
    detail: "1:1 · 1024 px · 4 variants",
    createdAt: "Renderer result · yesterday",
  },
];

const statusLabels: Record<JobStatus, string> = {
  queued: "Queued preview",
  paused: "Paused preview",
  ready: "Ready preview",
  attention: "Needs endpoint",
  cancelled: "Cancelled preview",
};

function mergeDraft(base: GenerationDraft, patch: Partial<GenerationDraft>): GenerationDraft {
  return { ...base, ...patch };
}

function draftDetail(mode: MediaMode, draft: GenerationDraft, durationOverride?: number): string {
  if (mode === "image") return `${draft.aspectRatio} · ${draft.resolution} px · ${draft.outputCount} variants`;
  if (mode === "video") return `${draft.aspectRatio} · ${durationOverride ?? draft.duration} s · ${draft.frameRate} fps`;
  return `${draft.duration} s · ${draft.voice} · ${draft.format.toUpperCase()}`;
}

function downloadMediaPreview(payload: string, format: ExportFormat): boolean {
  if (typeof document === "undefined" || typeof URL === "undefined") return false;
  const blob = new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = `omnia-media-generation-preview.${format === "json" ? "json" : "md"}`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 0);
  return true;
}

function jobIcon(job: GenerationJob): ReactNode {
  return <span className={`media-generation__job-icon media-generation__job-icon--${job.mode}`}>{modeIcon(job.mode, 17)}</span>;
}

function JobCard({
  job,
  onPreview,
  onPrimaryAction,
  primaryActionLabel,
  primaryActionIcon,
  onCancel,
  onRequeue,
  onRemove,
}: {
  job: GenerationJob;
  onPreview?: () => void;
  onPrimaryAction?: () => void;
  primaryActionLabel?: string;
  primaryActionIcon?: ReactNode;
  onCancel?: () => void;
  onRequeue?: () => void;
  onRemove?: () => void;
}) {
  return (
    <article className={`media-generation__job media-generation__job--${job.status}`}>
      {jobIcon(job)}
      <div className="media-generation__job-main">
        <div className="media-generation__job-title-row">
          <strong>{job.title}</strong>
          <span className={`media-generation__status media-generation__status--${job.status}`}>{statusLabels[job.status]}</span>
        </div>
        <span className="media-generation__job-meta">{job.preset}{job.operation === "storyboard" ? ` · Storyboard · ${job.storyboardShots?.length ?? 0} shots` : ""} · {job.detail}{job.modelLabel ? ` · ${job.modelLabel}` : ""}</span>
        <small>{job.output} · {job.createdAt}</small>
        {job.routeLabel ? <small className="media-generation__job-route">Route: {job.routeLabel}</small> : null}
      </div>
      {(onPreview || onPrimaryAction || onCancel || onRequeue || onRemove) ? (
        <div className="media-generation__job-actions">
          {onPrimaryAction ? <button type="button" className="button button--ghost button--compact" onClick={onPrimaryAction} aria-label={`${primaryActionLabel ?? "Advance"} ${job.title}`}>{primaryActionIcon}{primaryActionLabel ?? "Advance"}</button> : null}
          {onPreview ? <button type="button" className="button button--ghost button--compact" onClick={onPreview} aria-label={`Preview ${job.title}`}><Play size={13} /> Preview</button> : null}
          {onCancel ? <button type="button" className="button button--ghost button--compact" onClick={onCancel} aria-label={`Cancel ${job.title}`}><CircleStop size={13} /> Cancel</button> : null}
          {onRequeue ? <button type="button" className="button button--ghost button--compact" onClick={onRequeue} aria-label={`Queue ${job.title} again`}><Plus size={13} /> Queue again</button> : null}
          {onRemove ? <button type="button" className="button button--ghost button--compact" onClick={onRemove} aria-label={`Remove ${job.title}`}><Trash2 size={13} /></button> : null}
        </div>
      ) : null}
    </article>
  );
}

function PreviewBoard({ mode, draft, showGuides, onShowGuidesChange }: PreviewBoardProps) {
  const promptLabel = draft.prompt.trim().split("\n")[0]?.slice(0, 72) || "Untitled media direction";

  return (
    <section className="media-generation__visual-preview" aria-label={`${modeLabels[mode]} composition preview`}>
      <div className="media-generation__panel-heading">
        <div>
          <span className="eyebrow">Canvas preview</span>
          <h3>Composition board</h3>
        </div>
        <span className="media-generation__preview-badge"><Sparkles size={12} /> Renderer-local</span>
      </div>

      <div className={`media-generation__preview-canvas media-generation__preview-canvas--${mode}${showGuides ? " media-generation__preview-canvas--guides" : ""}`}>
        {mode === "image" ? (
          <div className="media-generation__preview-image" aria-hidden="true">
            <span className="media-generation__preview-image__halo" />
            <span className="media-generation__preview-image__grid" />
            <span className="media-generation__preview-image__subject">OMNIA</span>
            <span className="media-generation__preview-image__caption">{draft.aspectRatio} · {draft.resolution}px</span>
          </div>
        ) : null}

        {mode === "video" ? (
          <div className="media-generation__preview-video" aria-hidden="true">
            <div className="media-generation__preview-video__frames">
              {["01", "02", "03", "04", "05"].map((frame) => <span key={frame}>{frame}</span>)}
            </div>
            <div className="media-generation__preview-video__playhead" />
            <div className="media-generation__preview-video__timeline"><span style={{ width: `${Math.min(92, Math.max(18, Number(draft.duration) * 5))}%` }} /></div>
            <div className="media-generation__preview-video__caption"><span>Timeline rehearsal</span><strong>{draft.duration} s · {draft.frameRate} fps</strong></div>
          </div>
        ) : null}

        {mode === "audio" ? (
          <div className="media-generation__preview-audio" aria-hidden="true">
            <div className="media-generation__preview-audio__waveform">
              {[18, 34, 24, 48, 68, 39, 76, 52, 32, 60, 42, 72, 28, 46, 64, 36, 56, 26, 44, 70].map((height, index) => <span key={`${height}-${index}`} style={{ height: `${height}%` }} />)}
            </div>
            <div className="media-generation__preview-audio__caption"><span>Sound bed rehearsal</span><strong>{draft.duration} s · {draft.voice}</strong></div>
          </div>
        ) : null}
        <span className="media-generation__preview-canvas__watermark">Preview only</span>
      </div>

      <div className="media-generation__preview-toolbar">
        <span title={promptLabel}>{promptLabel}</span>
        <label><input type="checkbox" checked={showGuides} onChange={(event) => onShowGuidesChange(event.target.checked)} /> Show composition guides</label>
      </div>
      <p className="media-generation__preview-note">This board communicates framing and intent only; no generated media bytes, provider call, or native write is produced.</p>
    </section>
  );
}

function MediaOrchestrationRail({
  job,
  validation,
}: {
  job: MediaGenerationPreviewJob;
  validation: MediaGenerationValidation;
}) {
  const actions = mediaGenerationActionAvailability(job);
  const currentIndex = MEDIA_GENERATION_LIFECYCLE.indexOf(job.status);
  const evidenceNotObserved = job.capabilitySnapshotRevisionId.startsWith("preview:");

  return (
    <section className="media-generation__orchestration" aria-label="Media orchestration preview">
      <div className="media-generation__panel-heading">
        <div>
          <span className="eyebrow"><ShieldAlert size={13} /> Orchestration rehearsal</span>
          <h3>Job lifecycle and recovery</h3>
          <p>Map the native handoff before an endpoint is connected. This is a status contract, not a live provider job.</p>
        </div>
        <span className="media-generation__orchestration-badge">No dispatch</span>
      </div>

      <ol className="media-generation__lifecycle" aria-label="Media job lifecycle preview">
        {MEDIA_GENERATION_LIFECYCLE.map((stage, index) => {
          const reached = currentIndex >= 0 && index <= currentIndex;
          const current = stage === job.status;
          return (
            <li key={stage} className={current ? "is-current" : reached ? "is-reached" : ""}>
              <span aria-hidden="true">{index + 1}</span>
              <strong>{mediaGenerationStatusLabel(stage)}</strong>
            </li>
          );
        })}
      </ol>

      <div className="media-generation__orchestration-grid">
        <span><strong>Request shape</strong><small>{validation.valid ? "Valid preview" : "Needs input"}</small></span>
        <span><strong>Capability evidence</strong><small>{evidenceNotObserved ? "Not observed" : "Native snapshot"}</small></span>
        <span><strong>Provider acceptance</strong><small>{job.providerAcceptance === "not-sent" ? "Not sent" : job.providerAcceptance}</small></span>
        <span><strong>Retry rule</strong><small>{job.status === "outcome-unknown" || job.status === "reconcile-required" ? "Reconcile before retry" : "Known failure only"}</small></span>
      </div>

      <details className="media-generation__recovery-details">
        <summary>Recovery and authority boundaries</summary>
        <ul>
          <li>Dispatch: {actions.dispatch.reason}</li>
          <li>Retry: {actions.retry.reason}</li>
          <li>Reconcile: {actions.reconcile.reason}</li>
          {validation.warnings.slice(0, 2).map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      </details>

      <p className="media-generation__boundary"><ShieldAlert size={14} /> Lifecycle labels are renderer-local. Native acceptance, idempotency, polling, cancellation, artifacts, cost, and recovery receipts remain unobserved until the harness supplies them.</p>
    </section>
  );
}

export function MediaGenerationStudio() {
  const [tab, setTab] = useState<StudioTab>("create");
  const [mode, setMode] = useState<MediaMode>("image");
  const [videoOperation, setVideoOperation] = useState<VideoOperation>("text-to-video");
  const [storyboardShots, setStoryboardShots] = useState<readonly MediaStoryboardShot[]>(DEFAULT_MEDIA_STORYBOARD);
  const [presetId, setPresetId] = useState("coder-visuals");
  const [draft, setDraft] = useState<GenerationDraft>(defaultDraft);
  const [queue, setQueue] = useState<GenerationJob[]>([...seedQueue]);
  const [history, setHistory] = useState<GenerationJob[]>([...seedHistory]);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("json");
  const [status, setStatus] = useState("Renderer-local media planning preview.");
  const [historyFilter, setHistoryFilter] = useState<MediaMode | "all">("all");
  const [showPreviewGuides, setShowPreviewGuides] = useState(false);
  const [endpointProfileId, setEndpointProfileId] = useState("omnia-preview");
  const [endpointUrl, setEndpointUrl] = useState(defaultEndpointProfile.endpoint);
  const [modelId, setModelId] = useState(defaultModelForMode.image);
  const [region, setRegion] = useState("auto");
  const [fallbackEnabled, setFallbackEnabled] = useState(true);
  const [streamPreview, setStreamPreview] = useState(true);
  const [mediaRuntime] = useState<OmniaMediaRuntimeAdapter>(() => createOmniaMediaRuntimeAdapter());
  const mediaModes = Object.keys(modeLabels) as MediaMode[];
  const studioTabs: Array<{ id: StudioTab; label: string }> = [
    { id: "create", label: "Create" },
    { id: "queue", label: "Queue" },
    { id: "gallery", label: "Gallery" },
    { id: "history", label: "History" },
  ];

  const moveMediaMode = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? mediaModes.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + mediaModes.length) % mediaModes.length;
    const nextMode = mediaModes[nextIndex];
    if (!nextMode) return;
    selectMode(nextMode);
    document.getElementById(`media-mode-tab-${nextMode}`)?.focus();
  };

  const moveStudioTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? studioTabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + studioTabs.length) % studioTabs.length;
    const nextTab = studioTabs[nextIndex];
    if (!nextTab) return;
    setTab(nextTab.id);
    document.getElementById(`media-studio-tab-${nextTab.id}`)?.focus();
  };

  const currentPreset = presets.find((preset) => preset.id === presetId) ?? presets[0]!;
  const endpointProfile = endpointProfiles.find((profile) => profile.id === endpointProfileId) ?? defaultEndpointProfile;
  const storyboardDuration = storyboardShots.reduce((total, shot) => total + shot.durationSeconds, 0);
  const effectiveVideoDuration = videoOperation === "storyboard" ? storyboardDuration : Number(draft.duration);
  const orchestrationDraft = useMemo<MediaGenerationDraft>(() => ({
    modality: mode,
    operation: mode === "image" ? "text-to-image" : mode === "video" ? videoOperation : "audio-compose",
    prompt: draft.prompt,
    negativePrompt: draft.negativePrompt,
    parameters: {
      aspectRatio: draft.aspectRatio,
      ...(mode === "image"
        ? { width: Number(draft.resolution), height: Number(draft.resolution) }
        : { durationSeconds: mode === "video" ? effectiveVideoDuration : Number(draft.duration) }),
      ...(mode === "video" ? { fps: Number(draft.frameRate) } : {}),
      ...(mode === "video" && videoOperation === "storyboard" ? { storyboardShots } : {}),
      seed: draft.seed === "auto" || draft.seed.trim() === "" ? null : Number(draft.seed),
      variantCount: Number(draft.outputCount),
      quality: draft.quality,
    },
    authority: { watermarkAuthorization: "not-applicable" },
  }), [draft, effectiveVideoDuration, mode, storyboardShots, videoOperation]);
  const orchestrationJob = useMemo(
    () => buildMediaGenerationPreviewJob(orchestrationDraft, { jobId: "preview:media-studio-draft" }),
    [orchestrationDraft],
  );
  const orchestrationValidation = useMemo(
    () => validateMediaGenerationDraft(orchestrationDraft),
    [orchestrationDraft],
  );
  const visibleHistory = useMemo(
    () => historyFilter === "all" ? history : history.filter((job) => job.mode === historyFilter),
    [history, historyFilter],
  );
  const galleryRecentItems = useMemo<MediaGalleryRecentItem[]>(
    () => history.map((job) => ({
      id: `history-gallery-${job.id}`,
      title: job.title,
      kind: job.mode,
      subtitle: job.preset,
      detail: job.detail,
      prompt: job.prompt ?? job.title,
      createdAt: job.createdAt,
      status: job.status === "attention" ? "attention" : job.status === "ready" ? "ready" : "queued",
    })),
    [history],
  );
  const exportPayload = useMemo(() => {
    const body = {
      format: "omnia.media-generation.preview.v1",
      scope: "renderer-session",
      mode,
      operation: mode === "video" ? videoOperation : mode === "image" ? "text-to-image" : "audio-compose",
      preset: currentPreset.name,
      route: {
        profile: endpointProfile.label,
        provider: endpointProfile.provider,
        model: modelId,
        endpoint: endpointUrl,
        region,
        fallbackEnabled,
      streamPreview,
      storyboard: mode === "video" && videoOperation === "storyboard" ? storyboardShots : [],
      auth: endpointProfile.authLabel,
      },
      draft,
      queue,
      history,
      endpoint: "not-called-in-preview",
      nativeWrite: "planned",
      outputBytes: "not-generated-in-preview",
    };
    if (exportFormat === "json") return JSON.stringify(body, null, 2);
    return [
      "# Omnia media generation preview",
      "",
      `- Mode: ${modeLabels[mode]}`,
      `- Operation: ${mode === "video" ? videoOperation : mode === "image" ? "text-to-image" : "audio-compose"}`,
      `- Preset: ${currentPreset.name}`,
      `- Scope: renderer session`,
      "- Endpoint: not called in preview",
      "- Native write: planned",
      "",
      "## Prompt",
      "",
      draft.prompt || "(empty)",
      ...(mode === "video" && videoOperation === "storyboard" ? [
        "",
        "## Storyboard",
        "",
        ...storyboardShots.map((shot, index) => `- ${index + 1}. ${shot.title} · ${shot.durationSeconds}s · ${shot.camera}\n  ${shot.prompt}`),
      ] : []),
      "",
      "## Queue",
      "",
      ...(queue.length ? queue.map((job) => `- ${job.title} · ${statusLabels[job.status]} · ${job.detail}`) : ["- Empty"]),
    ].join("\n");
  }, [currentPreset.name, draft, endpointProfile.authLabel, endpointProfile.label, endpointProfile.provider, endpointUrl, exportFormat, fallbackEnabled, history, mode, modelId, queue, region, storyboardShots, streamPreview, videoOperation]);

  const updateDraft = (patch: Partial<GenerationDraft>) => setDraft((current) => mergeDraft(current, patch));

  const selectMode = (nextMode: MediaMode) => {
    const nextPreset = presets.find((preset) => preset.mode === nextMode) ?? presets[0]!;
    setMode(nextMode);
    if (nextMode !== "video") setVideoOperation("text-to-video");
    setPresetId(nextPreset.id);
    setModelId(defaultModelForMode[nextMode]);
    setDraft((current) => mergeDraft(current, nextPreset.settings));
    setStatus(`${modeLabels[nextMode]} controls ready in renderer preview.`);
  };

  const selectPreset = (preset: Preset) => {
    setPresetId(preset.id);
    setMode(preset.mode);
    setModelId(defaultModelForMode[preset.mode]);
    setDraft((current) => mergeDraft(current, preset.settings));
    setStatus(`${preset.name} applied to this renderer-local draft.`);
  };

  const useGalleryDirection = (item: MediaGalleryRecentItem) => {
    const matchingPreset = presets.find((preset) => preset.mode === item.kind && preset.name === item.subtitle)
      ?? presets.find((preset) => preset.mode === item.kind)
      ?? presets[0]!;
    setMode(item.kind);
    setPresetId(matchingPreset.id);
    setModelId(defaultModelForMode[item.kind]);
    setDraft((current) => mergeDraft(current, { ...matchingPreset.settings, prompt: item.prompt }));
    setTab("create");
    setStatus(`Loaded ${item.title} into a renderer-local ${modeLabels[item.kind]} draft; no generation request was sent.`);
  };

  const queueGeneration = () => {
    const title = draft.prompt.trim().split("\n")[0]?.slice(0, 48) || `${modeLabels[mode]} concept`;
    let runtimeRecord: MediaRuntimeJobRecord | undefined;
    let runtimeWarning: string | undefined;

    // The durable media contract currently supports image/video/document.
    // Audio remains a renderer-only rehearsal until the native schema gains an
    // audio modality; do not coerce it into a misleading provider job.
    if (mode !== "audio") {
      try {
        runtimeRecord = mediaRuntime.create({
          prompt: draft.prompt.trim() || `${modeLabels[mode]} concept`,
          modality: mode,
          operation: mode === "image" ? "text-to-image" : videoOperation,
          providerProfileRevisionId: `preview:provider:${endpointProfileId}`,
          modelProfileRevisionId: `preview:model:${modelId}`,
          capabilitySnapshotRevisionId: "preview:media-capabilities:v1",
          promptRevisionId: `preview:prompt:${Date.now().toString(36)}`,
          negativePromptRevisionId: draft.negativePrompt.trim()
            ? `preview:negative-prompt:${Date.now().toString(36)}`
            : null,
          parameters: {
            aspectRatio: draft.aspectRatio,
            ...(mode === "image"
              ? { width: Number(draft.resolution), height: Number(draft.resolution) }
              : {
                  durationSeconds: effectiveVideoDuration,
                  fps: Number(draft.frameRate),
                }),
            ...(mode === "video" && videoOperation === "storyboard" ? { storyboardShots } : {}),
            seed: draft.seed === "auto" || draft.seed.trim() === "" ? null : Number(draft.seed),
            variantCount: Number(draft.outputCount),
            quality: draft.quality,
          },
          authority: {
            policyRevisionId: "preview:policy:v1",
            watermarkAuthorization: "not-applicable",
          },
          idempotencyKey: `preview:${mode}:${Date.now().toString(36)}:${queue.length + history.length + 1}`,
        });
      } catch (error) {
        // Keep the renderer preview usable even when a draft contains an
        // incomplete numeric field. The typed adapter error is surfaced in the
        // status line instead of blocking local composition work.
        runtimeWarning = error instanceof Error ? error.message : "Media runtime tracking was unavailable for this draft.";
      }
    }

    const job: GenerationJob = {
      id: `job-preview-${queue.length + history.length + 1}`,
      title,
      mode,
      status: "queued",
      preset: currentPreset.name,
      output: modeOutputLabels[mode],
      detail: draftDetail(mode, draft, mode === "video" ? effectiveVideoDuration : undefined),
      prompt: draft.prompt,
      createdAt: "Queued in renderer preview",
      routeLabel: endpointProfile.label,
      modelLabel: modelId,
      ...(mode === "video" ? { operation: videoOperation } : {}),
      ...(mode === "video" && videoOperation === "storyboard" ? { storyboardShots: [...storyboardShots] } : {}),
      ...(runtimeRecord === undefined ? {} : {
        runtimeJobId: runtimeRecord.job.jobId,
        runtimeQueueItemId: runtimeRecord.queueItemId,
      }),
    };
    setQueue((current) => [job, ...current]);
    setTab("queue");
    setStatus(
      runtimeWarning === undefined
        ? mode === "audio"
          ? "Queued an audio renderer preview; durable media runtime tracking is unavailable for audio."
          : "Queued a renderer-local generation preview and recorded its typed media lifecycle; no endpoint was called."
        : `Queued a renderer-local generation preview; runtime tracking unavailable: ${runtimeWarning}`,
    );
  };

  const previewJob = (job: GenerationJob) => {
    const readyJob: GenerationJob = { ...job, status: "ready", createdAt: "Renderer result · just now" };
    setQueue((current) => current.filter((item) => item.id !== job.id));
    setHistory((current) => [readyJob, ...current.filter((item) => item.id !== job.id)]);
    setTab("history");
    setStatus(`Previewed ${job.title}; no media bytes were generated.`);
  };

  const togglePauseJob = (job: GenerationJob) => {
    const nextStatus: JobStatus = job.status === "paused" ? "queued" : "paused";
    setQueue((current) => current.map((item) => item.id === job.id ? {
      ...item,
      status: nextStatus,
      createdAt: nextStatus === "paused" ? "Paused in renderer preview" : "Resumed in renderer preview",
    } : item));
    setStatus(`${nextStatus === "paused" ? "Paused" : "Resumed"} ${job.title} in the renderer queue; native scheduling remains planned.`);
  };

  const retryJob = (job: GenerationJob) => {
    setQueue((current) => current.map((item) => item.id === job.id ? {
      ...item,
      status: "queued",
      createdAt: "Retry rehearsed in renderer preview",
    } : item));
    setStatus(`Retry rehearsal queued for ${job.title}; no provider request was sent.`);
  };

  const cancelJob = (job: GenerationJob) => {
    if (job.runtimeJobId !== undefined) {
      const result = mediaRuntime.cancelLocal(job.runtimeJobId);
      if (!result.ok) {
        setStatus(`Cancelled ${job.title} in the renderer preview; runtime record was not updated: ${result.reason}`);
      }
    }
    const cancelledJob: GenerationJob = {
      ...job,
      status: "cancelled",
      createdAt: "Cancelled in renderer preview",
    };
    setQueue((current) => current.filter((item) => item.id !== job.id));
    setHistory((current) => [cancelledJob, ...current.filter((item) => item.id !== job.id)]);
    setStatus(`Cancelled ${job.title} in the renderer preview; no scheduler or provider job was cancelled.`);
  };

  const requeueJob = (job: GenerationJob) => {
    let runtimeJobId = job.runtimeJobId;
    let runtimeQueueItemId = job.runtimeQueueItemId;
    if (runtimeJobId !== undefined) {
      const result = mediaRuntime.retryLocal(runtimeJobId);
      if (!result.ok) {
        runtimeJobId = undefined;
        runtimeQueueItemId = undefined;
      } else {
        runtimeQueueItemId = result.value.queueItemId;
      }
    }
    const nextJob: GenerationJob = {
      ...job,
      id: `job-preview-${Date.now()}`,
      status: "queued",
      createdAt: "Re-queued in renderer preview",
      ...(runtimeJobId === undefined ? {} : { runtimeJobId, runtimeQueueItemId }),
    };
    setQueue((current) => [nextJob, ...current]);
    setTab("queue");
    setStatus(`Re-queued ${job.title} in the renderer preview; no provider request was sent.`);
  };

  const resetDraft = () => {
    setMode("image");
    setPresetId("coder-visuals");
    setDraft(defaultDraft);
    setVideoOperation("text-to-video");
    setStoryboardShots(DEFAULT_MEDIA_STORYBOARD);
    setEndpointProfileId("omnia-preview");
    setEndpointUrl(defaultEndpointProfile.endpoint);
    setModelId(defaultModelForMode.image);
    setRegion("auto");
    setFallbackEnabled(true);
    setStreamPreview(true);
    setStatus("Draft reset to the renderer-local default.");
  };

  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable in this preview.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setStatus(`${exportFormat.toUpperCase()} preview copied; no native record was created.`);
    } catch {
      setStatus("Clipboard access is unavailable in this preview.");
    }
  };

  const downloadExport = () => {
    setStatus(downloadMediaPreview(exportPayload, exportFormat) ? "Browser download started; native media was not written." : "Download unavailable; nothing was exported.");
  };

  return (
    <section className="media-generation-studio" aria-labelledby="media-generation-title">
      <header className="media-generation__header">
        <div className="media-generation__title-block">
          <span className="eyebrow"><WandSparkles size={14} /> Media workspace</span>
          <h2 id="media-generation-title">Media Generation Studio</h2>
          <p>Design image, video, and audio requests in one place before connecting a provider endpoint.</p>
        </div>
        <div className="media-generation__header-actions">
          <span className="media-generation__boundary-badge"><Sparkles size={13} /> Preview only</span>
          <button type="button" className="button button--ghost" onClick={resetDraft}><RotateCcw size={14} /> Reset draft</button>
        </div>
      </header>

      <div className="media-generation__mode-strip" role="tablist" aria-label="Media generation modes" aria-orientation="horizontal">
        {mediaModes.map((entry, index) => (
          <button
            key={entry}
            id={`media-mode-tab-${entry}`}
            type="button"
            role="tab"
            aria-selected={mode === entry}
            aria-controls="media-studio-panel-create"
            tabIndex={mode === entry ? 0 : -1}
            className={mode === entry ? "media-generation__mode media-generation__mode--selected" : "media-generation__mode"}
            onClick={() => selectMode(entry)}
            onKeyDown={(event) => moveMediaMode(event, index)}
          >
            <span className="media-generation__mode-icon">{modeIcon(entry, 17)}</span>
            <span><strong>{modeLabels[entry]}</strong><small>{entry === "image" ? "Visual assets" : entry === "video" ? "Motion studies" : "Voice & sound"}</small></span>
          </button>
        ))}
      </div>

      <nav className="media-generation__tabs" role="tablist" aria-label="Media studio views" aria-orientation="horizontal">
        {([
          ["create", "Create", Plus],
          ["queue", "Queue", Layers3],
          ["gallery", "Gallery", Grid2X2],
          ["history", "History", CheckCircle2],
        ] as const).map(([entry, label, Icon], index) => (
          <button
            key={entry}
            id={`media-studio-tab-${entry}`}
            type="button"
            role="tab"
            aria-selected={tab === entry}
            aria-controls={`media-studio-panel-${entry}`}
            tabIndex={tab === entry ? 0 : -1}
            className={tab === entry ? "media-generation__tab media-generation__tab--selected" : "media-generation__tab"}
            onClick={() => setTab(entry)}
            onKeyDown={(event) => moveStudioTab(event, index)}
          >
            <Icon size={14} /> {label}
            {entry === "queue" ? <span className="media-generation__tab-count">{queue.length}</span> : entry === "history" ? <span className="media-generation__tab-count">{history.length}</span> : null}
          </button>
        ))}
      </nav>

      {tab === "create" ? (
        <div id="media-studio-panel-create" className="media-generation__create-grid" role="tabpanel" aria-labelledby="media-studio-tab-create" tabIndex={0}>
          <div className="media-generation__composer-panel">
            <div className="media-generation__panel-heading">
              <div><span className="eyebrow">{modeLabels[mode]} request</span><h3>{modeDescriptions[mode]}</h3></div>
              <span className="media-generation__endpoint-chip">Endpoint: preview</span>
            </div>

            <label className="media-generation__field media-generation__field--wide">
              <span>Prompt</span>
              <textarea aria-label="Prompt" value={draft.prompt} onChange={(event) => updateDraft({ prompt: event.target.value })} rows={5} placeholder={`Describe the ${mode} you want to create...`} />
              <small>Be explicit about subject, style, composition, motion, voice, or constraints.</small>
            </label>
            <label className="media-generation__field media-generation__field--wide">
              <span>Negative prompt <em>optional</em></span>
              <input aria-label="Negative prompt" value={draft.negativePrompt} onChange={(event) => updateDraft({ negativePrompt: event.target.value })} placeholder="What should the result avoid?" />
            </label>

            {mode === "video" ? (
              <div className="media-generation__operation-picker" role="group" aria-label="Video request type">
                <span>Build type</span>
                <button type="button" className={videoOperation === "text-to-video" ? "is-selected" : ""} aria-pressed={videoOperation === "text-to-video"} onClick={() => setVideoOperation("text-to-video")}>Single video prompt</button>
                <button type="button" className={videoOperation === "storyboard" ? "is-selected" : ""} aria-pressed={videoOperation === "storyboard"} onClick={() => setVideoOperation("storyboard")}>Storyboard sequence</button>
                <small>Storyboard runtime is calculated from the individual shot durations.</small>
              </div>
            ) : null}

            {mode === "video" && videoOperation === "storyboard" ? (
              <MediaStoryboardPreview
                shots={storyboardShots}
                onChange={(nextShots) => setStoryboardShots([...nextShots])}
              />
            ) : null}

            <details className="media-generation__routing-panel" open>
              <summary>
                <span>
                  <strong>Endpoint &amp; model routing</strong>
                  <small>Choose a route shape now; native capability probing remains unavailable in this preview.</small>
                </span>
                <span className="media-generation__routing-badge">Renderer-local</span>
              </summary>
              <div className="media-generation__routing-grid">
                <label className="media-generation__field">
                  <span>Endpoint profile</span>
                  <select aria-label="Media endpoint profile" value={endpointProfileId} onChange={(event) => {
                    const profile = endpointProfiles.find((entry) => entry.id === event.target.value);
                    setEndpointProfileId(event.target.value);
                    if (profile && profile.id !== "openai-compatible") setEndpointUrl(profile.endpoint);
                  }}>
                    {endpointProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
                  </select>
                  <small>{endpointProfile.provider} · {endpointProfile.authLabel}</small>
                </label>
                <label className="media-generation__field">
                  <span>Model label</span>
                  <select aria-label="Media generation model" value={modelId} onChange={(event) => setModelId(event.target.value)}>
                    {modelOptions[mode].map((model) => <option key={model} value={model}>{model}</option>)}
                  </select>
                  <small>Preview label only; no model catalog request is made.</small>
                </label>
                <label className="media-generation__field media-generation__field--wide">
                  <span>Endpoint URL <em>editable preview value</em></span>
                  <input aria-label="Media endpoint URL" value={endpointUrl} onChange={(event) => { setEndpointUrl(event.target.value); setEndpointProfileId("openai-compatible"); }} placeholder="preview://not-connected" />
                  <small>Stored in the renderer draft/export only. Credentials are never entered here.</small>
                </label>
                <label className="media-generation__field">
                  <span>Region / placement</span>
                  <select aria-label="Media endpoint region" value={region} onChange={(event) => setRegion(event.target.value)}>
                    <option value="auto">Auto</option>
                    <option value="us-east">US East</option>
                    <option value="us-west">US West</option>
                    <option value="eu-west">EU West</option>
                    <option value="local">Local machine</option>
                  </select>
                </label>
                <label className="media-generation__check">
                  <input type="checkbox" checked={fallbackEnabled} onChange={(event) => setFallbackEnabled(event.target.checked)} />
                  <span><strong>Allow fallback route</strong><small>Rehearses a fallback preference; no automatic failover runs here.</small></span>
                </label>
                <label className="media-generation__check">
                  <input type="checkbox" checked={streamPreview} onChange={(event) => setStreamPreview(event.target.checked)} />
                  <span><strong>Stream preview updates</strong><small>UI preference for a future provider stream, not a live connection.</small></span>
                </label>
              </div>
              <p className="media-generation__routing-note"><ShieldAlert size={13} /> Route, model, region, and fallback choices are renderer-session metadata. Provider dispatch, secret lookup, capability probes, and failover remain planned.</p>
            </details>

            <MediaCapabilityPreview mode={mode} endpointLabel={endpointProfile.label} modelLabel={modelId} />

            <div className="media-generation__control-grid">
              <label className="media-generation__field"><span>Preset</span><select value={presetId} onChange={(event) => { const preset = presets.find((entry) => entry.id === event.target.value); if (preset) selectPreset(preset); }} aria-label="Media generation preset">{presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label>
              <label className="media-generation__field"><span>Quality</span><select value={draft.quality} onChange={(event) => updateDraft({ quality: event.target.value })}><option value="draft">Draft</option><option value="balanced">Balanced</option><option value="high">High fidelity</option></select></label>
              <label className="media-generation__field"><span>Seed</span><input value={draft.seed} onChange={(event) => updateDraft({ seed: event.target.value })} placeholder="auto" /></label>
              <label className="media-generation__field"><span>Outputs</span><select value={draft.outputCount} onChange={(event) => updateDraft({ outputCount: event.target.value })}><option value="1">1 variant</option><option value="2">2 variants</option><option value="4">4 variants</option></select></label>
            </div>

            {mode === "image" ? (
              <div className="media-generation__control-grid">
                <label className="media-generation__field"><span>Aspect ratio</span><select value={draft.aspectRatio} onChange={(event) => updateDraft({ aspectRatio: event.target.value })}><option>16:9</option><option>1:1</option><option>4:5</option><option>9:16</option><option>3:2</option></select></label>
                <label className="media-generation__field"><span>Resolution</span><select value={draft.resolution} onChange={(event) => updateDraft({ resolution: event.target.value })}><option value="1024">1024 px</option><option value="1536">1536 px</option><option value="2048">2048 px</option><option value="4096">4096 px</option></select></label>
                <label className="media-generation__check"><input type="checkbox" checked={draft.transparent} onChange={(event) => updateDraft({ transparent: event.target.checked })} /><span><strong>Transparent background</strong><small>Useful for logos and UI assets.</small></span></label>
              </div>
            ) : null}

            {mode === "video" ? (
              <div className="media-generation__control-grid">
                <label className="media-generation__field"><span>Aspect ratio</span><select value={draft.aspectRatio} onChange={(event) => updateDraft({ aspectRatio: event.target.value })}><option>16:9</option><option>1:1</option><option>9:16</option><option>21:9</option></select></label>
                {videoOperation === "text-to-video" ? <label className="media-generation__field"><span>Duration</span><select value={draft.duration} onChange={(event) => updateDraft({ duration: event.target.value })}><option value="4">4 seconds</option><option value="8">8 seconds</option><option value="12">12 seconds</option><option value="20">20 seconds</option></select></label> : <label className="media-generation__field"><span>Calculated duration</span><input aria-label="Calculated video duration" value={`${storyboardDuration} seconds`} readOnly /><small>Sum of the shot durations above.</small></label>}
                <label className="media-generation__field"><span>Motion</span><select value={draft.motion} onChange={(event) => updateDraft({ motion: event.target.value })}><option>slow push-in</option><option>locked camera</option><option>handheld drift</option><option>orbit subject</option></select></label>
                <label className="media-generation__field"><span>Frame rate</span><select value={draft.frameRate} onChange={(event) => updateDraft({ frameRate: event.target.value })}><option value="24">24 fps</option><option value="30">30 fps</option><option value="60">60 fps</option></select></label>
                <label className="media-generation__check"><input type="checkbox" checked={draft.includeAudio} onChange={(event) => updateDraft({ includeAudio: event.target.checked })} /><span><strong>Include audio bed</strong><small>Route audio planning alongside video.</small></span></label>
              </div>
            ) : null}

            {mode === "audio" ? (
              <div className="media-generation__control-grid">
                <label className="media-generation__field"><span>Duration</span><select value={draft.duration} onChange={(event) => updateDraft({ duration: event.target.value })}><option value="15">15 seconds</option><option value="30">30 seconds</option><option value="60">60 seconds</option><option value="120">2 minutes</option></select></label>
                <label className="media-generation__field"><span>Voice / sound</span><select value={draft.voice} onChange={(event) => updateDraft({ voice: event.target.value })}><option>neutral narrator</option><option>warm narrator</option><option>documentary voice</option><option>ambient soundscape</option><option>minimal piano</option></select></label>
                <label className="media-generation__field"><span>Format</span><select value={draft.format} onChange={(event) => updateDraft({ format: event.target.value })}><option value="wav">WAV</option><option value="mp3">MP3</option><option value="flac">FLAC</option><option value="ogg">OGG</option></select></label>
              </div>
            ) : null}

            <div className="media-generation__composer-footer">
              <span role="status" aria-live="polite">{status}</span>
              <button type="button" className="button button--primary" onClick={queueGeneration}><Plus size={15} /> Queue generation preview</button>
            </div>
          </div>

          <aside className="media-generation__side-panel" aria-label="Generation presets">
            <div className="media-generation__panel-heading"><div><span className="eyebrow">Starter recipes</span><h3>Choose a direction</h3></div><Sparkles size={16} /></div>
            <div className="media-generation__preset-list">
              {presets.map((preset) => (
                <button key={preset.id} type="button" className={preset.id === presetId ? `media-generation__preset media-generation__preset--${preset.accent} media-generation__preset--selected` : `media-generation__preset media-generation__preset--${preset.accent}`} aria-pressed={preset.id === presetId} onClick={() => selectPreset(preset)}>
                  <span className="media-generation__preset-icon">{modeIcon(preset.mode, 15)}</span>
                  <span><strong>{preset.name}</strong><small>{preset.description}</small><em>{modeLabels[preset.mode]} · {preset.id === presetId ? "Selected" : "Use preset"}</em></span>
                  {preset.id === presetId ? <Check size={14} /> : null}
                </button>
             ))}
            </div>
            <PreviewBoard mode={mode} draft={mode === "video" && videoOperation === "storyboard" ? { ...draft, duration: String(effectiveVideoDuration) } : draft} showGuides={showPreviewGuides} onShowGuidesChange={setShowPreviewGuides} />
            <MediaOrchestrationRail job={orchestrationJob} validation={orchestrationValidation} />
            <div className="media-generation__side-summary"><span><strong>{modeOutputLabels[mode]}</strong><small>Declared output family for this draft</small></span><span><strong>{draftDetail(mode, draft, mode === "video" ? effectiveVideoDuration : undefined)}</strong><small>{mode === "video" && videoOperation === "storyboard" ? `${storyboardShots.length} storyboard shots · renderer-local` : "Current parameter summary"}</small></span></div>
            <p className="media-generation__boundary"><Sparkles size={14} /> This studio only shapes a request and previews queue state. It does not upload files, call a provider, or write generated media.</p>
          </aside>
        </div>
      ) : null}

      {tab === "queue" ? (
        <section id="media-studio-panel-queue" className="media-generation__list-panel" role="tabpanel" aria-labelledby="media-studio-tab-queue" tabIndex={0}>
          <div className="media-generation__panel-heading"><div><span className="eyebrow">Renderer session queue</span><h3>Generation handoff</h3><p>Review queued requests and simulate the next UI state without dispatching work.</p></div><Pause size={17} /></div>
          <span className="media-generation__queue-status" role="status" aria-live="polite">{status}</span>
          <div className="media-generation__job-list">{queue.length ? queue.map((job) => {
            const lifecycleAction = job.status === "attention"
              ? { label: "Retry", icon: <RotateCcw size={13} />, action: () => retryJob(job) }
              : { label: job.status === "paused" ? "Resume" : "Pause", icon: job.status === "paused" ? <Play size={13} /> : <Pause size={13} />, action: () => togglePauseJob(job) };
            return <JobCard
              key={job.id}
              job={job}
              onPrimaryAction={lifecycleAction.action}
              primaryActionLabel={lifecycleAction.label}
              primaryActionIcon={lifecycleAction.icon}
              onPreview={() => previewJob(job)}
              onCancel={() => cancelJob(job)}
            />;
          }) : <div className="media-generation__empty"><Layers3 size={20} /><strong>Queue is empty</strong><span>Return to Create to add a renderer-local request.</span><button type="button" className="button button--secondary" onClick={() => setTab("create")}><Plus size={14} /> Create request</button></div>}</div>
          <p className="media-generation__boundary"><Pause size={14} /> Queue actions are a visual rehearsal. Native scheduler, provider dispatch, cancellation, and retry receipts remain planned.</p>
        </section>
      ) : null}

      {tab === "gallery" ? (
        <section id="media-studio-panel-gallery" className="media-generation__list-panel" role="tabpanel" aria-labelledby="media-studio-tab-gallery" tabIndex={0}>
          <div className="media-generation__panel-heading"><div><span className="eyebrow">Renderer session gallery</span><h3>Compare output directions</h3><p>Inspect mixed media references and choose what to explore next without loading generated bytes.</p></div><Grid2X2 size={17} /></div>
          <MediaGalleryPreview recentItems={galleryRecentItems} onUseAsNextDirection={useGalleryDirection} />
          <p className="media-generation__boundary"><Sparkles size={14} /> Gallery selection is a renderer-local planning signal. It does not create an artifact, dispatch a provider request, or mutate history.</p>
        </section>
      ) : null}

      {tab === "history" ? (
        <section id="media-studio-panel-history" className="media-generation__list-panel" role="tabpanel" aria-labelledby="media-studio-tab-history" tabIndex={0}>
          <div className="media-generation__panel-heading"><div><span className="eyebrow">Renderer session history</span><h3>Past media directions</h3><p>Keep visual references and parameter summaries close to the rest of the workspace.</p></div><div className="media-generation__history-filters" role="group" aria-label="History media filter">{(["all", "image", "video", "audio"] as const).map((filter) => <button key={filter} type="button" className={historyFilter === filter ? "media-generation__filter media-generation__filter--selected" : "media-generation__filter"} onClick={() => setHistoryFilter(filter)}>{filter === "all" ? "All" : modeLabels[filter]}</button>)}</div></div>
          <div className="media-generation__job-list">{visibleHistory.length ? visibleHistory.map((job) => <JobCard key={job.id} job={job} onRequeue={() => requeueJob(job)} />) : <div className="media-generation__empty"><CheckCircle2 size={20} /><strong>No results in this filter</strong><span>Try another media type.</span></div>}</div>
          <div className="media-generation__export-actions"><button type="button" className="button button--secondary" onClick={() => setExportOpen((current) => !current)}><Layers3 size={14} /> {exportOpen ? "Hide export preview" : "Preview export"}</button><span role="status" aria-live="polite">{status}</span></div>
        </section>
      ) : null}

      {exportOpen ? (
        <section className="media-generation__export" aria-label="Media generation export preview">
          <header><div><span className="eyebrow">Portable preview</span><h3>Request and queue manifest</h3></div><div className="media-generation__export-toolbar"><label><span>Format</span><select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ExportFormat)} aria-label="Media generation export format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--ghost button--compact" onClick={() => void copyExport()}><Clipboard size={13} /> Copy</button><button type="button" className="button button--secondary button--compact" onClick={downloadExport}><Download size={13} /> Download</button></div></header>
          <pre><code>{exportPayload}</code></pre>
          <p className="media-generation__boundary"><Sparkles size={14} /> Export is generated in the browser session only. It contains request metadata, not generated bytes or provider credentials.</p>
        </section>
      ) : null}
    </section>
  );
}

export default MediaGenerationStudio;
