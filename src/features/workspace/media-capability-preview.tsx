import { Info, ShieldAlert, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";

export type MediaCapabilityPreviewMode = "image" | "video" | "audio";

type CapabilityRow = {
  readonly operation: string;
  readonly label: string;
  readonly inputs: string;
  readonly constraints: string;
  readonly lifecycle: string;
  readonly state: "unobserved" | "renderer-only";
};

export type MediaCapabilityPreviewProps = {
  readonly mode: MediaCapabilityPreviewMode;
  readonly endpointLabel: string;
  readonly modelLabel: string;
};

const capabilityRows: Record<MediaCapabilityPreviewMode, readonly CapabilityRow[]> = {
  image: [
    { operation: "text-to-image", label: "Text to image", inputs: "Text prompt", constraints: "1024–4096 px · aspect ratio", lifecycle: "Sync / poll unknown", state: "unobserved" },
    { operation: "image-variation", label: "Image variation", inputs: "Image reference", constraints: "Reference carrier unknown", lifecycle: "Upload / poll unknown", state: "unobserved" },
    { operation: "inpaint", label: "Inpaint", inputs: "Image + mask", constraints: "Mask rules unknown", lifecycle: "Upload / poll unknown", state: "unobserved" },
    { operation: "outpaint", label: "Outpaint", inputs: "Image + edge mask", constraints: "Canvas bounds unknown", lifecycle: "Upload / poll unknown", state: "unobserved" },
    { operation: "background-remove", label: "Background remove", inputs: "Image", constraints: "Output carrier unknown", lifecycle: "Async unknown", state: "unobserved" },
    { operation: "upscale", label: "Upscale", inputs: "Image", constraints: "Scale and size unknown", lifecycle: "Async unknown", state: "unobserved" },
    { operation: "authorized-watermark-cleanup", label: "Authorized overlay cleanup", inputs: "Image + authority", constraints: "Ownership proof required", lifecycle: "Mask / QA unknown", state: "unobserved" },
  ],
  video: [
    { operation: "text-to-video", label: "Text to video", inputs: "Text prompt", constraints: "4–20 s · 24–60 fps", lifecycle: "Poll / stream unknown", state: "unobserved" },
    { operation: "image-to-video", label: "Image to video", inputs: "Image reference", constraints: "Motion controls unknown", lifecycle: "Upload / poll unknown", state: "unobserved" },
    { operation: "video-extend", label: "Video extend", inputs: "Video reference", constraints: "Duration limits unknown", lifecycle: "Poll / reconcile unknown", state: "unobserved" },
    { operation: "video-interpolate", label: "Frame interpolation", inputs: "Video reference", constraints: "Frame-rate limits unknown", lifecycle: "Async unknown", state: "unobserved" },
    { operation: "storyboard", label: "Storyboard / shots", inputs: "Prompt + shot list", constraints: "Shot schema unknown", lifecycle: "Poll / stream unknown", state: "unobserved" },
    { operation: "lip-sync", label: "Lip sync", inputs: "Video + audio", constraints: "Audio/video carrier unknown", lifecycle: "Upload / poll unknown", state: "unobserved" },
    { operation: "compose", label: "Video + audio compose", inputs: "Video + audio", constraints: "Codec and mix rules unknown", lifecycle: "Async / QA unknown", state: "unobserved" },
  ],
  audio: [
    { operation: "audio-compose", label: "Audio compose", inputs: "Text + voice/sound", constraints: "15–120 s · format", lifecycle: "Renderer rehearsal", state: "renderer-only" },
  ],
};

const modeLabels: Record<MediaCapabilityPreviewMode, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
};

const stateLabels: Record<CapabilityRow["state"], string> = {
  unobserved: "Capability unobserved",
  "renderer-only": "Renderer extension",
};

function stateIcon(state: CapabilityRow["state"]): ReactNode {
  return state === "renderer-only" ? <SlidersHorizontal size={13} aria-hidden="true" /> : <Info size={13} aria-hidden="true" />;
}

/**
 * Read-only capability rehearsal for the media studio. The rows mirror the
 * provider-neutral operation vocabulary, but never imply that the selected
 * endpoint or model actually supports any operation until native discovery
 * supplies a signed capability snapshot.
 */
export function MediaCapabilityPreview({ mode, endpointLabel, modelLabel }: MediaCapabilityPreviewProps) {
  const rows = capabilityRows[mode];

  return (
    <section className="media-capability-preview" aria-label="Media capability preview">
      <header className="media-capability-preview__header">
        <div>
          <span className="eyebrow"><SlidersHorizontal size={13} aria-hidden="true" /> Read-only catalog rehearsal</span>
          <h4>Capability &amp; constraints</h4>
          <p>Review the operation vocabulary and the limits that a future native capability snapshot must confirm.</p>
        </div>
        <span className="media-capability-preview__badge"><Info size={12} aria-hidden="true" /> Not observed</span>
      </header>

      <div className="media-capability-preview__summary" aria-label="Selected media route summary">
        <span><strong>{modeLabels[mode]}</strong><small>Selected modality</small></span>
        <span><strong>{rows.length}</strong><small>Known operations</small></span>
        <span><strong>{endpointLabel}</strong><small>Endpoint profile</small></span>
        <span><strong>{modelLabel}</strong><small>Model label</small></span>
      </div>

      <div
        className="media-capability-preview__table-wrap"
        role="region"
        aria-label={`${modeLabels[mode]} capability table`}
        tabIndex={0}
      >
        <table className="media-capability-preview__table">
          <caption>{modeLabels[mode]} operation capability rehearsal</caption>
          <thead>
            <tr>
              <th scope="col">Operation</th>
              <th scope="col">Inputs</th>
              <th scope="col">Constraints to confirm</th>
              <th scope="col">Lifecycle</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.operation}>
                <th scope="row"><strong>{row.label}</strong><code>{row.operation}</code></th>
                <td>{row.inputs}</td>
                <td>{row.constraints}</td>
                <td>{row.lifecycle}</td>
                <td><span className={`media-capability-preview__state media-capability-preview__state--${row.state}`}>{stateIcon(row.state)} {stateLabels[row.state]}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="media-capability-preview__table-hint">
        Scroll horizontally to inspect all capability columns.
      </p>

      <p className="media-capability-preview__boundary"><ShieldAlert size={14} aria-hidden="true" /> Read-only renderer data. No endpoint probe, upload, secret lookup, provider acceptance, pricing, or native capability snapshot was observed.</p>
    </section>
  );
}

export default MediaCapabilityPreview;
