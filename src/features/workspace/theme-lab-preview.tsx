import { Eye, ShieldCheck, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";

import {
  buildThemeLabSnapshot,
  themeLabSurfaceLabel,
  visionLabel,
  type ThemeLabSurface,
  type ThemeLabVision,
} from "./theme-lab-preview-contract";

type RoleColors = readonly [string, string, string, string];

interface ThemeLabPreviewProps {
  roleColors: RoleColors;
  surface: ThemeLabSurface;
}

const VISION_OPTIONS: readonly { value: ThemeLabVision; label: string }[] = [
  { value: "default", label: "Default signal view" },
  { value: "high-contrast", label: "High contrast simulation" },
  { value: "protanopia", label: "Protanopia simulation" },
  { value: "deuteranopia", label: "Deuteranopia simulation" },
  { value: "tritanopia", label: "Tritanopia simulation" },
];

export function ThemeLabPreview({ roleColors, surface }: ThemeLabPreviewProps) {
  const [vision, setVision] = useState<ThemeLabVision>("default");
  const snapshot = useMemo(
    () => buildThemeLabSnapshot(roleColors, surface, vision),
    [roleColors, surface, vision],
  );

  return (
    <section className="theme-lab-preview" aria-labelledby="theme-lab-preview-title">
      <header className="theme-lab-preview__header">
        <span className="theme-lab-preview__mark" aria-hidden="true"><Sparkles size={15} /></span>
        <div>
          <span className="eyebrow">Theme Lab</span>
          <h4 id="theme-lab-preview-title">Check the spectrum before you ship the look</h4>
          <p>Compare signal contrast and color diversity without changing global tokens or durable settings.</p>
        </div>
        <span className="theme-lab-preview__boundary"><Eye size={13} /> Preview only</span>
      </header>

      <div className="theme-lab-preview__toolbar" role="toolbar" aria-label="Theme Lab preview controls">
        <label>
          <span>Vision simulation</span>
          <select
            value={vision}
            onChange={(event) => setVision(event.target.value as ThemeLabVision)}
            aria-label="Theme Lab vision simulation"
          >
            {VISION_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
          </select>
        </label>
        <span className="theme-lab-preview__toolbar-status" aria-live="polite">
          {visionLabel(vision)} · {themeLabSurfaceLabel(surface)} surface
        </span>
      </div>

      <div className="theme-lab-preview__metrics" aria-label="Theme Lab summary">
        <article>
          <span>Text-safe signals</span>
          <strong>{snapshot.passingChecks}/4</strong>
          <small>{snapshot.passingChecks === 4 ? "All roles clear AA" : "Review highlighted roles"}</small>
        </article>
        <article>
          <span>Color diversity</span>
          <strong>{snapshot.diversityLabel}</strong>
          <small>{snapshot.uniqueHueCount} hue families · {snapshot.chromaSpread}% spread</small>
        </article>
        <article>
          <span>Surface</span>
          <strong>{themeLabSurfaceLabel(surface)}</strong>
          <small>{snapshot.surfaceColor}</small>
        </article>
      </div>

      <div className="theme-lab-preview__checks" aria-label="Theme Lab contrast checks">
        {snapshot.checks.map((check) => (
          <article key={check.role} className={`theme-lab-check theme-lab-check--${check.grade.toLowerCase()}`}>
            <div className="theme-lab-check__heading">
              <span className="theme-lab-check__swatch" style={{ background: check.displayColor }} aria-hidden="true" />
              <span>
                <strong>{check.label}</strong>
                <small>{check.passesText ? "Text-safe signal" : "Tune before text"}</small>
              </span>
              <b>{check.grade}</b>
            </div>
            <div className="theme-lab-check__ratio">
              <span>Contrast</span>
              <strong>{check.contrast.toFixed(1)}:1</strong>
            </div>
            <div className="theme-lab-check__badges">
              <span className={check.passesText ? "is-pass" : "is-review"}>{check.passesText ? "Text AA" : "Text review"}</span>
              <span className={check.passesUi ? "is-pass" : "is-review"}>{check.passesUi ? "UI AA" : "UI review"}</span>
            </div>
          </article>
        ))}
      </div>

      <p className="theme-lab-preview__recommendation"><ShieldCheck size={14} aria-hidden="true" /> {snapshot.recommendation}</p>
      <p className="theme-lab-preview__fine-print">Renderer-local heuristic and simulated vision preview. It does not certify every component state, replace design review, or write a production theme.</p>
    </section>
  );
}
