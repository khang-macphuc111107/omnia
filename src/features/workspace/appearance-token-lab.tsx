import { Check, Clipboard, Code2, Eye } from "lucide-react";
import { useMemo, useState } from "react";

import {
  buildAppearanceTokenRows,
  filterAppearanceTokenRows,
  serializeAppearanceTokenMap,
  type AppearanceTokenLabCategory,
} from "./appearance-token-lab-contract";
import { themeLabSurfaceLabel, type ThemeLabSurface } from "./theme-lab-preview-contract";

type RoleColors = readonly [string, string, string, string];

interface AppearanceTokenLabProps {
  roleColors: RoleColors;
  surface: ThemeLabSurface;
}

const CATEGORY_OPTIONS: readonly { value: AppearanceTokenLabCategory; label: string }[] = [
  { value: "all", label: "All tokens" },
  { value: "signals", label: "Signals" },
  { value: "surfaces", label: "Surfaces" },
  { value: "text", label: "Text" },
  { value: "borders", label: "Borders" },
];

async function copyText(payload: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(payload);
    return true;
  } catch {
    return false;
  }
}

export function AppearanceTokenLab({ roleColors, surface }: AppearanceTokenLabProps) {
  const [category, setCategory] = useState<AppearanceTokenLabCategory>("all");
  const [status, setStatus] = useState("Inspect the proposed semantic map before any global token change.");
  const rows = useMemo(() => buildAppearanceTokenRows({ roleColors, surface }), [roleColors, surface]);
  const visibleRows = useMemo(() => filterAppearanceTokenRows(rows, category), [category, rows]);
  const cssPayload = useMemo(() => serializeAppearanceTokenMap(rows), [rows]);

  const copyMap = async () => {
    setStatus(
      await copyText(cssPayload)
        ? "Copied the renderer-local token proposal to the clipboard."
        : "Clipboard access is unavailable; no token proposal was copied.",
    );
  };

  return (
    <section className="appearance-token-lab" aria-labelledby="appearance-token-lab-title">
      <header className="appearance-token-lab__header">
        <span className="appearance-token-lab__mark" aria-hidden="true"><Code2 size={15} /></span>
        <div>
          <span className="eyebrow">Semantic token lab</span>
          <h4 id="appearance-token-lab-title">See how the selected look maps onto a coder-native UI</h4>
          <p>Signals stay colorful while surfaces, text, and borders keep the workspace calm and readable.</p>
        </div>
        <span className="appearance-token-lab__boundary"><Eye size={13} /> Preview only</span>
      </header>

      <div className="appearance-token-lab__toolbar" role="toolbar" aria-label="Semantic token lab controls">
        <label>
          <span>Token family</span>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as AppearanceTokenLabCategory)}
            aria-label="Semantic token family"
          >
            {CATEGORY_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
          </select>
        </label>
        <span className="appearance-token-lab__surface">{`${themeLabSurfaceLabel(surface)} surface · ${visibleRows.length} of ${rows.length} tokens`}</span>
        <button type="button" className="button button--ghost" onClick={() => void copyMap()}><Clipboard size={14} /> Copy CSS map</button>
      </div>

      <div className="appearance-token-lab__status" aria-live="polite">
        {status}
      </div>

      <div className="appearance-token-lab__grid" role="list" aria-label="Proposed semantic appearance tokens">
        {visibleRows.map((row) => (
          <article className="appearance-token-card" key={row.id} role="listitem">
            <div className="appearance-token-card__heading">
              <span className="appearance-token-card__swatch" style={{ background: row.value }} aria-hidden="true" />
              <div>
                <strong>{row.label}</strong>
                <small>{row.category}</small>
              </div>
              <Check size={14} aria-label="Preview token" />
            </div>
            <code>{row.cssName}: {row.value};</code>
            <p>{row.usage}</p>
          </article>
        ))}
      </div>

      <p className="appearance-token-lab__fine-print">Renderer-local proposal · no global token mutation · no durable settings write. Copying only places the generated CSS map on the user clipboard.</p>
    </section>
  );
}
