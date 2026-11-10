import { Blend, Check, Eye, WandSparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  buildPaletteHarmonySnapshot,
  isPaletteHarmonyHex,
  paletteHarmonyModeLabel,
  type PaletteHarmonyMode,
  type PaletteHarmonyTemperature,
} from "./palette-harmony-lab-contract";

type RoleColors = readonly [string, string, string, string];

interface PaletteHarmonyLabProps {
  seedColor: string;
  onApply: (colors: RoleColors) => void;
}

const MODE_OPTIONS: readonly { value: PaletteHarmonyMode; label: string; description: string }[] = [
  { value: "analogous", label: "Analogous", description: "Near-neighbor hues with a smooth signal flow." },
  { value: "complementary", label: "Complementary", description: "High separation for clear primary vs alert states." },
  { value: "split-complementary", label: "Split complementary", description: "Contrast with a softer, more editorial edge." },
  { value: "triadic", label: "Triadic", description: "Three anchor hues for a distinctly colorful workspace." },
  { value: "monochrome", label: "Monochrome", description: "One hue family with stepped lightness." },
];

const TEMPERATURE_OPTIONS: readonly { value: PaletteHarmonyTemperature; label: string }[] = [
  { value: "cool", label: "Cool" },
  { value: "balanced", label: "Balanced" },
  { value: "warm", label: "Warm" },
];

export function PaletteHarmonyLab({ seedColor, onApply }: PaletteHarmonyLabProps) {
  const [mode, setMode] = useState<PaletteHarmonyMode>("split-complementary");
  const [temperature, setTemperature] = useState<PaletteHarmonyTemperature>("balanced");
  const [seedInput, setSeedInput] = useState(seedColor.toUpperCase());
  const [status, setStatus] = useState("Choose a harmony family, then preview the four semantic roles.");
  useEffect(() => {
    setSeedInput(seedColor.toUpperCase());
  }, [seedColor]);
  const snapshot = useMemo(
    () => buildPaletteHarmonySnapshot(seedInput, mode, temperature),
    [mode, seedInput, temperature],
  );

  const applyHarmony = () => {
    if (!isPaletteHarmonyHex(seedInput)) {
      setStatus("Use a six-digit hex seed such as #23C6B8; the role colors were not changed.");
      return;
    }
    onApply(snapshot.colors);
    setStatus(`${paletteHarmonyModeLabel(mode)} harmony applied to the four renderer role colors.`);
  };

  return (
    <section className="palette-harmony-lab" aria-labelledby="palette-harmony-lab-title">
      <header className="palette-harmony-lab__header">
        <span className="palette-harmony-lab__mark" aria-hidden="true"><Blend size={15} /></span>
        <div>
          <span className="eyebrow">Harmony mixer</span>
          <h4 id="palette-harmony-lab-title">Generate a richer role palette from one signal</h4>
          <p>Explore color relationships quickly, then apply the selected four-role recipe to this preview.</p>
        </div>
        <span className="palette-harmony-lab__boundary"><Eye size={13} /> Preview only</span>
      </header>

      <div className="palette-harmony-lab__toolbar" role="toolbar" aria-label="Palette harmony controls">
        <label>
          <span>Seed color</span>
          <span className="palette-harmony-lab__seed-input">
            <input
              type="color"
              value={isPaletteHarmonyHex(seedInput) ? seedInput : "#23C6B8"}
              onChange={(event) => setSeedInput(event.target.value.toUpperCase())}
              aria-label="Harmony seed color picker"
            />
            <input
              value={seedInput}
              onChange={(event) => setSeedInput(event.target.value)}
              aria-label="Harmony seed color hex"
              placeholder="#23C6B8"
              inputMode="text"
            />
          </span>
        </label>
        <label>
          <span>Harmony family</span>
          <select value={mode} onChange={(event) => setMode(event.target.value as PaletteHarmonyMode)} aria-label="Palette harmony family">
            {MODE_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label>
          <span>Temperature</span>
          <select value={temperature} onChange={(event) => setTemperature(event.target.value as PaletteHarmonyTemperature)} aria-label="Palette harmony temperature">
            {TEMPERATURE_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
          </select>
        </label>
        <button type="button" className="button button--secondary" onClick={applyHarmony}><WandSparkles size={14} /> Apply roles</button>
      </div>

      <div className="palette-harmony-lab__summary" aria-live="polite">
        <span><strong>{snapshot.diversityLabel}</strong> spectrum</span>
        <span>{snapshot.hueSpread}° hue spread</span>
        <span>{snapshot.rationale}</span>
      </div>

      <div className="palette-harmony-lab__swatches" role="list" aria-label="Generated semantic role colors">
        {snapshot.colors.map((color, index) => (
          <article key={`${snapshot.mode}-${color}-${index}`} role="listitem" className="palette-harmony-swatch">
            <span className="palette-harmony-swatch__color" style={{ background: color }} aria-hidden="true" />
            <div><span>{snapshot.labels[index]}</span><strong>{color}</strong></div>
            <Check size={14} aria-label="Generated preview role" />
          </article>
        ))}
      </div>

      <p className="palette-harmony-lab__status" aria-live="polite">{status}</p>
      <p className="palette-harmony-lab__fine-print">Renderer-local color math and preview only · no global token mutation · no durable settings write.</p>
    </section>
  );
}
