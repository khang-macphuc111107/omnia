import { ArrowDown, ArrowUp, Clapperboard, Copy, Plus, Trash2 } from "lucide-react";

export type MediaStoryboardShot = {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly durationSeconds: number;
  readonly camera: string;
};

export const DEFAULT_MEDIA_STORYBOARD: readonly MediaStoryboardShot[] = [
  {
    id: "shot-01",
    title: "Establish the workspace",
    prompt: "Wide view of a calm developer workspace at dusk, monitors waking with a warm amber glow",
    durationSeconds: 3,
    camera: "slow push-in",
  },
  {
    id: "shot-02",
    title: "Reveal the detail",
    prompt: "Move closer to a clean editor with colorful code reflections and precise desk details",
    durationSeconds: 3,
    camera: "pan right",
  },
  {
    id: "shot-03",
    title: "Land on the mark",
    prompt: "Settle on a minimal Omnia command ring glowing softly on the dark screen",
    durationSeconds: 2,
    camera: "locked camera",
  },
];

export type MediaStoryboardPreviewProps = {
  readonly shots: readonly MediaStoryboardShot[];
  readonly onChange: (shots: readonly MediaStoryboardShot[]) => void;
};

const cameraMoves = ["slow push-in", "locked camera", "pan left", "pan right", "orbit subject", "handheld drift"] as const;

function nextShotId(shots: readonly MediaStoryboardShot[]): string {
  const used = new Set(shots.map((shot) => shot.id));
  let index = 1;
  while (used.has(`shot-${String(index).padStart(2, "0")}`)) index += 1;
  return `shot-${String(index).padStart(2, "0")}`;
}

export function MediaStoryboardPreview({ shots, onChange }: MediaStoryboardPreviewProps) {
  const totalDuration = shots.reduce((total, shot) => total + shot.durationSeconds, 0);

  const updateShot = (id: string, patch: Partial<MediaStoryboardShot>) => {
    onChange(shots.map((shot) => shot.id === id ? { ...shot, ...patch } : shot));
  };

  const moveShot = (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= shots.length) return;
    const next = [...shots];
    [next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
    onChange(next);
  };

  const addShot = () => {
    const shot: MediaStoryboardShot = {
      id: nextShotId(shots),
      title: `Shot ${shots.length + 1}`,
      prompt: "Describe the subject, framing, lighting, and action for this shot",
      durationSeconds: 2,
      camera: "locked camera",
    };
    onChange([...shots, shot]);
  };

  const duplicateShot = (shot: MediaStoryboardShot) => {
    const duplicate: MediaStoryboardShot = { ...shot, id: nextShotId(shots), title: `${shot.title} copy` };
    const index = shots.findIndex((entry) => entry.id === shot.id);
    onChange([...shots.slice(0, index + 1), duplicate, ...shots.slice(index + 1)]);
  };

  return (
    <section className="media-storyboard" aria-label="Video storyboard preview">
      <header className="media-storyboard__header">
        <div>
          <span className="eyebrow"><Clapperboard size={13} aria-hidden="true" /> Shot planning</span>
          <h4>Storyboard sequence</h4>
          <p>Shape each scene and camera move before a provider route exists.</p>
        </div>
        <div className="media-storyboard__header-actions">
          <span className="media-storyboard__runtime">{shots.length} shots · {totalDuration} s</span>
          <button type="button" className="button button--secondary button--compact" onClick={addShot}><Plus size={13} aria-hidden="true" /> Add shot</button>
        </div>
      </header>

      <div className="media-storyboard__timeline" aria-label={`${totalDuration} second storyboard timeline`}>
        {shots.length ? shots.map((shot, index) => (
          <span
            key={shot.id}
            className={`media-storyboard__timeline-shot media-storyboard__timeline-shot--${index % 4}`}
            style={{ flexGrow: shot.durationSeconds }}
            title={`${shot.title} · ${shot.durationSeconds} seconds`}
          >
            <strong>{String(index + 1).padStart(2, "0")}</strong>
            <small>{shot.durationSeconds}s</small>
          </span>
        )) : <span className="media-storyboard__timeline-empty">Add a shot to start the sequence</span>}
      </div>

      <div className="media-storyboard__shots">
        {shots.length ? shots.map((shot, index) => (
          <article className="media-storyboard__shot" key={shot.id} aria-label={`Shot ${index + 1}: ${shot.title}`}>
            <div className="media-storyboard__shot-index"><span>{String(index + 1).padStart(2, "0")}</span><small>SHOT</small></div>
            <div className="media-storyboard__shot-fields">
              <label className="media-generation__field media-storyboard__title-field">
                <span>Shot title</span>
                <input aria-label={`Shot ${index + 1} title`} value={shot.title} maxLength={60} onChange={(event) => updateShot(shot.id, { title: event.target.value })} />
              </label>
              <label className="media-generation__field media-storyboard__prompt-field">
                <span>Scene direction</span>
                <textarea aria-label={`Shot ${index + 1} scene direction`} value={shot.prompt} rows={2} maxLength={500} onChange={(event) => updateShot(shot.id, { prompt: event.target.value })} />
              </label>
              <label className="media-generation__field">
                <span>Camera move</span>
                <select aria-label={`Shot ${index + 1} camera move`} value={shot.camera} onChange={(event) => updateShot(shot.id, { camera: event.target.value })}>
                  {cameraMoves.map((move) => <option key={move} value={move}>{move}</option>)}
                </select>
              </label>
              <label className="media-generation__field">
                <span>Duration</span>
                <select aria-label={`Shot ${index + 1} duration`} value={shot.durationSeconds} onChange={(event) => updateShot(shot.id, { durationSeconds: Number(event.target.value) })}>
                  {[2, 3, 4, 5, 6, 8].map((seconds) => <option key={seconds} value={seconds}>{seconds} seconds</option>)}
                </select>
              </label>
            </div>
            <div className="media-storyboard__shot-actions" role="group" aria-label={`Reorder or edit shot ${index + 1}`}>
              <button type="button" className="button button--ghost button--compact" aria-label={`Move shot ${index + 1} up`} disabled={index === 0} onClick={() => moveShot(index, -1)}><ArrowUp size={13} aria-hidden="true" /></button>
              <button type="button" className="button button--ghost button--compact" aria-label={`Move shot ${index + 1} down`} disabled={index === shots.length - 1} onClick={() => moveShot(index, 1)}><ArrowDown size={13} aria-hidden="true" /></button>
              <button type="button" className="button button--ghost button--compact" aria-label={`Duplicate shot ${index + 1}`} onClick={() => duplicateShot(shot)}><Copy size={13} aria-hidden="true" /></button>
              <button type="button" className="button button--ghost button--compact" aria-label={`Remove shot ${index + 1}`} disabled={shots.length <= 1} onClick={() => onChange(shots.filter((entry) => entry.id !== shot.id))}><Trash2 size={13} aria-hidden="true" /></button>
            </div>
          </article>
        )) : (
          <div className="media-storyboard__empty"><Clapperboard size={17} aria-hidden="true" /><span><strong>No shots yet</strong>Add a shot to build a sequence and estimate its runtime.</span></div>
        )}
      </div>
      <p className="media-storyboard__boundary">Renderer-local storyboard only. No reference media is uploaded and no video is generated.</p>
    </section>
  );
}

export default MediaStoryboardPreview;
