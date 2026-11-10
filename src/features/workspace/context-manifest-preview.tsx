import { useMemo, useState } from "react";
import { Clipboard, Download, Layers3, SlidersHorizontal, Sparkles } from "lucide-react";

import { buildContextEstimate, contextEstimateInline, contextEstimateLabel, type ContextEstimateView } from "./context-estimate";

export function ContextManifestPreview({
  projectName,
  folderCount,
  instructionCount,
  memoryCount,
  skillCount,
  budget: controlledBudget,
  onBudgetChange,
  onBudgetChangeEnd,
  includeMemories,
  includeSkills,
  onIncludeMemoriesChange,
  onIncludeSkillsChange,
  estimate,
}: {
  readonly projectName: string;
  readonly folderCount: number;
  readonly instructionCount: number;
  readonly memoryCount: number;
  readonly skillCount: number;
  readonly budget?: number;
  readonly onBudgetChange?: (value: number) => void;
  readonly onBudgetChangeEnd?: () => void;
  readonly includeMemories: boolean;
  readonly includeSkills: boolean;
  readonly onIncludeMemoriesChange: (value: boolean) => void;
  readonly onIncludeSkillsChange: (value: boolean) => void;
  readonly estimate?: ContextEstimateView;
}) {
  const [localBudget, setLocalBudget] = useState(3200);
  const [format, setFormat] = useState<"json" | "markdown">("json");
  const [status, setStatus] = useState("Manifest is a renderer-local estimate.");
  const budget = controlledBudget ?? localBudget;
  const selectedMemoryCount = includeMemories ? memoryCount : 0;
  const selectedSkillCount = includeSkills ? skillCount : 0;
  const estimatedTokens = folderCount * 450 + instructionCount * 600 + selectedMemoryCount * 160 + selectedSkillCount * 300;
  const estimateView = estimate ?? buildContextEstimate({ estimatedTokens });
  const effectiveEstimatedTokens = estimateView.tokens === null ? null : Math.max(0, estimateView.tokens);
  const payload = useMemo(() => {
    const data = {
      schema: "omnia.context-manifest.preview.v1",
      scope: "renderer-session",
      projectName,
      budgetTokens: budget,
      estimatedTokens: effectiveEstimatedTokens,
      estimateStatus: estimateView.status,
      estimateSource: estimateView.source,
      estimateReason: estimateView.reason,
      sources: { folders: folderCount, instructions: instructionCount, memories: selectedMemoryCount, skills: selectedSkillCount },
      admission: effectiveEstimatedTokens === null ? "unknown" : effectiveEstimatedTokens <= budget ? "fits-preview-budget" : "over-preview-budget",
      native: "not-connected",
    };
    return format === "json" ? JSON.stringify(data, null, 2) : `# Context manifest preview\n\n- Project: ${projectName}\n- Budget: ${budget} tokens\n- Estimated: ${effectiveEstimatedTokens === null ? `${contextEstimateLabel(estimateView)} — ${estimateView.reason}` : `${effectiveEstimatedTokens} tokens (renderer heuristic)`}\n- Admission: ${effectiveEstimatedTokens === null ? "unknown" : effectiveEstimatedTokens <= budget ? "fits preview budget" : "over preview budget"}\n\nSources: folders ${folderCount}, instructions ${instructionCount}, memories ${selectedMemoryCount}, skills ${selectedSkillCount}\n\nRenderer-local estimate: ${contextEstimateInline(estimateView, budget)}. No native context compilation occurred.\n`;
  }, [budget, effectiveEstimatedTokens, estimateView, folderCount, format, instructionCount, projectName, selectedMemoryCount, selectedSkillCount]);
  const copy = async () => { if (!navigator.clipboard?.writeText) { setStatus("Clipboard unavailable; no manifest was copied."); return; } try { await navigator.clipboard.writeText(payload); setStatus(`Copied ${format.toUpperCase()} context manifest preview.`); } catch { setStatus("Clipboard access was denied; nothing was copied."); } };
  const download = () => { const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `omnia-context-manifest-preview.${format === "json" ? "json" : "md"}`; anchor.click(); URL.revokeObjectURL(url); setStatus("Downloaded a renderer-local context manifest."); };
  const handleBudgetChange = (value: number) => {
    setLocalBudget(value);
    onBudgetChange?.(value);
  };

  return <section className="context-manifest-preview" aria-label="Context manifest preview"><header><div><span className="eyebrow">Compiler rehearsal</span><h3><Layers3 size={15} /> Context manifest</h3><p>See source admission, token pressure, and omission boundaries before a future native compiler is connected.</p></div><span className="context-manifest-preview__badge"><Sparkles size={12} /> Preview only</span></header><div className="context-manifest-preview__controls"><label><span>Token budget</span><input aria-label="Context token budget" type="range" min="800" max="12000" step="200" value={budget} onChange={(event) => handleBudgetChange(Number(event.target.value))} onPointerUp={onBudgetChangeEnd} onKeyUp={onBudgetChangeEnd} onBlur={onBudgetChangeEnd} /><strong>{budget.toLocaleString()} tokens</strong></label><div className="context-manifest-preview__checks"><label><input type="checkbox" checked={includeMemories} onChange={(event) => onIncludeMemoriesChange(event.target.checked)} /> Memories ({memoryCount})</label><label><input type="checkbox" checked={includeSkills} onChange={(event) => onIncludeSkillsChange(event.target.checked)} /> Skills ({skillCount})</label></div></div><div className="context-manifest-preview__meter"><span style={{ width: `${Math.min(100, Math.max(0, ((effectiveEstimatedTokens ?? 0) / Math.max(1, budget)) * 100))}%` }} /><strong>{effectiveEstimatedTokens === null ? `${contextEstimateLabel(estimateView)} estimate` : `~${effectiveEstimatedTokens.toLocaleString()} estimated tokens · renderer heuristic`}</strong></div><p className="context-manifest-preview__estimate-note" role="status">{contextEstimateInline(estimateView, budget)}</p><div className="context-manifest-preview__actions"><span role="status" aria-live="polite">{status}</span><label><SlidersHorizontal size={13} /><select aria-label="Context manifest format" value={format} onChange={(event) => setFormat(event.target.value as "json" | "markdown")}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--ghost" title="Copy the current context manifest preview to the clipboard" onClick={() => void copy()}><Clipboard size={13} /> Copy</button><button type="button" className="button button--secondary" title="Download the current renderer-local context manifest" onClick={download}><Download size={13} /> Download</button></div><pre tabIndex={0}><code>{payload}</code></pre><p className="context-manifest-preview__boundary"><Sparkles size={13} /> No file read, retrieval, provider dispatch, durable context revision, or native receipt is produced by this preview. Token counts are renderer heuristics or explicit unknown/withheld states.</p></section>;
}

export default ContextManifestPreview;
