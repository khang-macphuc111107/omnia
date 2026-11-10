import {
  Check,
  Image,
  Music2,
  Plus,
  ShieldCheck,
  Video,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

export type ComposerMediaKind = "image" | "video" | "audio";

interface MediaPreset {
  kind: ComposerMediaKind;
  label: string;
  detail: string;
  formats: string;
}

const MEDIA_PRESETS: readonly MediaPreset[] = [
  { kind: "image", label: "Image", detail: "Vision input", formats: "PNG · JPG · WEBP" },
  { kind: "video", label: "Video", detail: "Timeline input", formats: "MP4 · MOV · WEBM" },
  { kind: "audio", label: "Audio", detail: "Voice input", formats: "MP3 · WAV · M4A" },
];

function MediaIcon({ kind }: { kind: ComposerMediaKind }) {
  if (kind === "image") return <Image size={16} aria-hidden="true" />;
  if (kind === "video") return <Video size={16} aria-hidden="true" />;
  return <Music2 size={16} aria-hidden="true" />;
}

interface ComposerMediaPreviewProps {
  disabled?: boolean;
  /**
   * Optional controlled selection used by the composer toolbar. Keeping this
   * prop optional preserves the self-contained preview surface for screens
   * that only need to demonstrate the media affordance.
   */
  selectedKinds?: readonly ComposerMediaKind[];
  onSelectionChange?: (next: ComposerMediaKind[]) => void;
}

/**
 * Renderer-only media affordance for the chat composer.
 *
 * The controls intentionally create preview chips instead of files. This
 * makes the future multimodal surface inspectable while keeping the native
 * ingestion/bridge boundary honest and fail-closed.
 */
export function ComposerMediaPreview({
  disabled = false,
  selectedKinds: controlledKinds,
  onSelectionChange,
}: ComposerMediaPreviewProps) {
  const [internalKinds, setInternalKinds] = useState<ComposerMediaKind[]>([]);
  const selectedKinds = controlledKinds ?? internalKinds;
  const selectedSet = useMemo(() => new Set(selectedKinds), [selectedKinds]);

  const updateSelection = (next: ComposerMediaKind[]) => {
    if (controlledKinds === undefined) setInternalKinds(next);
    onSelectionChange?.(next);
  };

  const toggleKind = (kind: ComposerMediaKind) => {
    if (disabled) return;
    updateSelection(
      selectedKinds.includes(kind)
        ? selectedKinds.filter((item) => item !== kind)
        : [...selectedKinds, kind],
    );
  };

  const removeKind = (kind: ComposerMediaKind) => {
    updateSelection(selectedKinds.filter((item) => item !== kind));
  };

  return (
    <section className="composer-media-preview" aria-label="Media input preview">
      <header className="composer-media-preview__header">
        <span>
          <span className="composer-media-preview__title">
            <ShieldCheck size={14} aria-hidden="true" />
            Media workspace
          </span>
          <small>Preview affordances for image, video, and audio inputs</small>
        </span>
        <span className="composer-media-preview__badge">Preview only</span>
      </header>

      <div className="composer-media-preview__presets" role="list" aria-label="Media input types">
        {MEDIA_PRESETS.map((preset) => {
          const selected = selectedSet.has(preset.kind);
          return (
            <button
              key={preset.kind}
              type="button"
              className={`composer-media-preview__preset${selected ? " composer-media-preview__preset--selected" : ""}`}
              aria-pressed={selected}
              aria-label={`${preset.label} input preview`}
              disabled={disabled}
              onClick={() => toggleKind(preset.kind)}
              title={`${preset.label} input preview · provider dispatch is planned`}
            >
              <span className="composer-media-preview__preset-icon">
                <MediaIcon kind={preset.kind} />
              </span>
              <span>
                <strong>{preset.label}</strong>
                <small>{preset.detail}</small>
              </span>
              <span className="composer-media-preview__preset-action" aria-hidden="true">
                {selected ? <Check size={13} /> : <Plus size={13} />}
              </span>
            </button>
          );
        })}
      </div>

      {selectedKinds.length > 0 ? (
        <ul className="composer-media-preview__queue" aria-label="Preview media queue">
          {selectedKinds.map((kind) => {
            const preset = MEDIA_PRESETS.find((item) => item.kind === kind);
            if (!preset) return null;
            return (
              <li key={kind} className="composer-media-preview__chip">
                <span className="composer-media-preview__chip-icon">
                  <MediaIcon kind={kind} />
                </span>
                <span>
                  <strong>{preset.label} input</strong>
                  <small>{preset.formats} · awaiting file</small>
                </span>
                <span className="composer-media-preview__chip-state">Queued</span>
                <button
                  type="button"
                  onClick={() => removeKind(kind)}
                  disabled={disabled}
                  aria-label={`Remove ${preset.label.toLowerCase()} media preview`}
                  title={`Remove ${preset.label.toLowerCase()} media preview`}
                >
                  <X size={13} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="composer-media-preview__empty">
          Choose a media type to preview its queue state. No file is read or uploaded from this control.
        </p>
      )}

      <p className="composer-media-preview__boundary" role="note" aria-label="Media dispatch boundary">
        <ShieldCheck size={12} aria-hidden="true" />
        Native media ingestion and provider-bound dispatch remain planned for a later phase.
      </p>
    </section>
  );
}
