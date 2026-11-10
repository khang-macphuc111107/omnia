import { useMemo, useState } from "react";
import { BarChart3, Clipboard, Download, Landmark, RefreshCw, ShieldCheck, Sparkles, Wallet } from "lucide-react";

type FinanceScenario = "baseline" | "lean" | "stretch";
type ExportFormat = "json" | "markdown";

type BudgetRow = {
  id: string;
  label: string;
  planned: string;
  actual: string;
};

type FinanceSnapshot = {
  income: string;
  reserve: string;
  horizon: string;
  scenario: FinanceScenario;
  rows: BudgetRow[];
};

const initialSnapshot: FinanceSnapshot = {
  income: "5200",
  reserve: "8400",
  horizon: "6",
  scenario: "baseline",
  rows: [
    { id: "housing", label: "Housing", planned: "1850", actual: "1820" },
    { id: "food", label: "Food", planned: "620", actual: "585" },
    { id: "transport", label: "Transport", planned: "360", actual: "410" },
    { id: "utilities", label: "Utilities", planned: "280", actual: "265" },
    { id: "health", label: "Health", planned: "220", actual: "190" },
    { id: "discretionary", label: "Discretionary", planned: "480", actual: "520" },
  ],
};

const scenarioMeta: Record<FinanceScenario, { label: string; description: string; factor: number }> = {
  baseline: { label: "Baseline", description: "Use the current plan as entered.", factor: 1 },
  lean: { label: "Lean plan", description: "Model a 10% reduction in discretionary planning.", factor: 0.9 },
  stretch: { label: "Stretch plan", description: "Reserve room for a 10% higher spending month.", factor: 1.1 },
};

function amount(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function money(value: number) {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : "Unavailable";
}

function ratio(value: number) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : "Unavailable";
}

function reviewSnapshot(snapshot: FinanceSnapshot) {
  const messages: string[] = [];
  const check = (value: string, label: string, allowZero = true) => {
    const parsed = amount(value);
    if (!value.trim() || !Number.isFinite(parsed)) messages.push(`${label} must be a finite number.`);
    else if (parsed < 0) messages.push(`${label} cannot be negative.`);
    else if (!allowZero && parsed === 0) messages.push(`${label} must be greater than zero.`);
  };
  check(snapshot.income, "Monthly income", false);
  check(snapshot.reserve, "Cash reserve");
  check(snapshot.horizon, "Planning horizon", false);
  snapshot.rows.forEach((row) => {
    check(row.planned, `${row.label} planned amount`);
    check(row.actual, `${row.label} actual amount`);
  });
  return messages;
}

function updateRow(rows: BudgetRow[], id: string, key: "planned" | "actual", value: string) {
  return rows.map((row) => (row.id === id ? { ...row, [key]: value } : row));
}

export function FinanceWorkspacePreview() {
  const [snapshot, setSnapshot] = useState<FinanceSnapshot>(initialSnapshot);
  const [format, setFormat] = useState<ExportFormat>("json");
  const [status, setStatus] = useState("Ready for a renderer-local finance planning preview.");
  const reviewMessages = useMemo(() => reviewSnapshot(snapshot), [snapshot]);
  const hasReview = reviewMessages.length > 0;

  const calculations = useMemo(() => {
    const income = amount(snapshot.income);
    const reserve = amount(snapshot.reserve);
    const horizon = amount(snapshot.horizon);
    const factor = scenarioMeta[snapshot.scenario].factor;
    const rows = snapshot.rows.map((row) => {
      const planned = amount(row.planned);
      const actual = amount(row.actual);
      const adjustedPlan = snapshot.scenario === "lean" && row.id !== "discretionary"
        ? planned
        : planned * factor;
      return { ...row, plannedValue: planned, actualValue: actual, adjustedPlan, variance: adjustedPlan - actual };
    });
    const plannedTotal = rows.reduce((sum, row) => sum + row.adjustedPlan, 0);
    const actualTotal = rows.reduce((sum, row) => sum + row.actualValue, 0);
    const monthlyNet = income - actualTotal;
    const projectedNet = income - plannedTotal;
    const reserveMonths = actualTotal > 0 ? reserve / actualTotal : Number.NaN;
    const utilization = plannedTotal > 0 ? actualTotal / plannedTotal : Number.NaN;
    const projectedHorizonBalance = reserve + projectedNet * horizon;
    return { income, reserve, horizon, rows, plannedTotal, actualTotal, monthlyNet, projectedNet, reserveMonths, utilization, projectedHorizonBalance };
  }, [snapshot]);

  const payload = useMemo(() => {
    const data = {
      schema: "omnia.finance-workspace.preview.v1",
      scope: "renderer-session",
      scenario: snapshot.scenario,
      inputs: snapshot,
      review: reviewMessages,
      metrics: {
        plannedMonthlySpend: calculations.plannedTotal,
        actualMonthlySpend: calculations.actualTotal,
        monthlyNet: calculations.monthlyNet,
        projectedNet: calculations.projectedNet,
        reserveMonths: calculations.reserveMonths,
        projectedHorizonBalance: calculations.projectedHorizonBalance,
      },
      native: "not-connected",
    };
    if (format === "json") return JSON.stringify(data, null, 2);
    return `# Omnia finance workspace preview\n\n- Scenario: ${scenarioMeta[snapshot.scenario].label}\n- Monthly income: ${money(calculations.income)}\n- Planned spend: ${money(calculations.plannedTotal)}\n- Actual spend: ${money(calculations.actualTotal)}\n- Monthly net: ${money(calculations.monthlyNet)}\n- Reserve runway: ${Number.isFinite(calculations.reserveMonths) ? calculations.reserveMonths.toFixed(1) : "Unavailable"} months\n\n## Budget ledger\n\n${calculations.rows.map((row) => `- **${row.label}**: plan ${money(row.adjustedPlan)}; actual ${money(row.actualValue)}; variance ${money(row.variance)}`).join("\n")}\n\nRenderer-local planning preview; no account connection, market data, transaction import, advice, or durable write occurred.\n`;
  }, [calculations, format, reviewMessages, snapshot]);

  const updateSnapshot = (patch: Partial<FinanceSnapshot>) => setSnapshot((current) => ({ ...current, ...patch }));
  const updateRowValue = (id: string, key: "planned" | "actual", value: string) => setSnapshot((current) => ({ ...current, rows: updateRow(current.rows, id, key, value) }));
  const copy = async () => {
    if (!navigator.clipboard?.writeText) { setStatus("Clipboard unavailable; nothing was copied."); return; }
    try { await navigator.clipboard.writeText(payload); setStatus(`Copied ${format.toUpperCase()} finance preview.`); } catch { setStatus("Clipboard access was denied; nothing was copied."); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `omnia-finance-workspace-preview.${format === "json" ? "json" : "md"}`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus("Downloaded a renderer-local finance preview.");
  };

  return (
    <section className="finance-workspace" aria-labelledby="finance-workspace-heading">
      <header className="finance-workspace__header">
        <div>
          <span className="eyebrow">Planning · cash flow · budgets</span>
          <h2 id="finance-workspace-heading">Finance Workspace</h2>
          <p>Inspect a monthly budget, cash-flow posture, and bounded planning scenarios without connecting an account.</p>
        </div>
        <span className="finance-workspace__badge"><Sparkles size={13} /> Preview only</span>
      </header>

      <div className="finance-workspace__layout">
        <section className="finance-workspace__card" aria-label="Finance workspace inputs">
          <div className="finance-workspace__card-heading"><div><span className="eyebrow">Planning inputs</span><h3>Set the local assumptions</h3></div><Wallet size={17} aria-hidden="true" /></div>
          <div className="finance-workspace__input-grid">
            <label><span>Monthly income</span><input aria-label="Monthly income" inputMode="decimal" value={snapshot.income} onChange={(event) => updateSnapshot({ income: event.target.value })} /></label>
            <label><span>Cash reserve</span><input aria-label="Cash reserve" inputMode="decimal" value={snapshot.reserve} onChange={(event) => updateSnapshot({ reserve: event.target.value })} /></label>
            <label><span>Planning horizon (months)</span><input aria-label="Planning horizon" inputMode="numeric" min="1" step="1" value={snapshot.horizon} onChange={(event) => updateSnapshot({ horizon: event.target.value })} /></label>
          </div>
          <div className={`finance-workspace__review ${hasReview ? "has-warnings" : "is-ready"}`} role="status" aria-live="polite" aria-label="Finance workspace input review">
            <strong>{hasReview ? "Review inputs" : "Inputs ready"}</strong>
            {hasReview ? <ul>{reviewMessages.map((message) => <li key={message}>{message}</li>)}</ul> : <span>Values stay local to this browser preview.</span>}
          </div>
          <div className="finance-workspace__scenario-tabs" role="tablist" aria-label="Finance planning scenarios">
            {(Object.keys(scenarioMeta) as FinanceScenario[]).map((scenario) => (
              <button key={scenario} type="button" role="tab" aria-selected={snapshot.scenario === scenario} className={snapshot.scenario === scenario ? "is-active" : ""} onClick={() => updateSnapshot({ scenario })}>
                <strong>{scenarioMeta[scenario].label}</strong><span>{scenarioMeta[scenario].description}</span>
              </button>
            ))}
          </div>
          <p className="finance-workspace__boundary"><ShieldCheck size={14} /> No account sync, transaction import, market quote, provider call, or financial advice is involved.</p>
        </section>

        <aside className="finance-workspace__card finance-workspace__posture" aria-label="Finance posture summary">
          <div className="finance-workspace__card-heading"><div><span className="eyebrow">Posture</span><h3>{scenarioMeta[snapshot.scenario].label} plan</h3></div><Landmark size={17} aria-hidden="true" /></div>
          <strong className="finance-workspace__headline">{money(calculations.monthlyNet)} <small>actual monthly net</small></strong>
          <div className="finance-workspace__metrics">
            <div><span>Planned spend</span><strong>{money(calculations.plannedTotal)}</strong><small>per month</small></div>
            <div><span>Actual spend</span><strong>{money(calculations.actualTotal)}</strong><small>per month</small></div>
            <div><span>Budget used</span><strong>{ratio(calculations.utilization)}</strong><small>actual / plan</small></div>
            <div><span>Reserve runway</span><strong>{Number.isFinite(calculations.reserveMonths) ? `${calculations.reserveMonths.toFixed(1)} mo` : "Unavailable"}</strong><small>at actual spend</small></div>
          </div>
          <div className={`finance-workspace__callout ${calculations.projectedNet >= 0 ? "is-positive" : "is-warning"}`}>
            <BarChart3 size={15} /><span>{calculations.projectedNet >= 0 ? `${money(calculations.projectedNet)} projected monthly headroom.` : `${money(Math.abs(calculations.projectedNet))} projected monthly gap.`}</span>
          </div>
        </aside>
      </div>

      <section className="finance-workspace__card finance-workspace__ledger" aria-label="Finance budget ledger">
        <div className="finance-workspace__card-heading"><div><span className="eyebrow">Budget ledger</span><h3>Plan against actuals</h3></div><span className="finance-workspace__domain">Renderer-local</span></div>
        <p className="finance-workspace__note">Edit the visible rows to rehearse a monthly plan. Positive variance means room remains under the selected scenario.</p>
        <div className="finance-workspace__table-wrap">
          <table aria-label="Finance budget ledger">
            <thead><tr><th scope="col">Category</th><th scope="col">Planned</th><th scope="col">Actual</th><th scope="col">Variance</th><th scope="col">Signal</th></tr></thead>
            <tbody>{calculations.rows.map((row) => <tr key={row.id}><th scope="row">{row.label}</th><td><input aria-label={`${row.label} planned amount`} inputMode="decimal" value={row.planned} onChange={(event) => updateRowValue(row.id, "planned", event.target.value)} /></td><td><input aria-label={`${row.label} actual amount`} inputMode="decimal" value={row.actual} onChange={(event) => updateRowValue(row.id, "actual", event.target.value)} /></td><td className={row.variance < 0 ? "is-negative" : "is-positive"}>{money(row.variance)}</td><td><span className={`finance-workspace__signal ${row.variance < 0 ? "is-over" : "is-within"}`}>{row.variance < 0 ? "Over plan" : "Within plan"}</span></td></tr>)}</tbody>
            <tfoot><tr><th scope="row">Total</th><td>{money(calculations.plannedTotal)}</td><td>{money(calculations.actualTotal)}</td><td className={calculations.plannedTotal - calculations.actualTotal < 0 ? "is-negative" : "is-positive"}>{money(calculations.plannedTotal - calculations.actualTotal)}</td><td>{calculations.plannedTotal - calculations.actualTotal >= 0 ? "Room" : "Review"}</td></tr></tfoot>
          </table>
        </div>
      </section>

      <section className="finance-workspace__card finance-workspace__export" aria-label="Finance workspace export preview">
        <div className="finance-workspace__card-heading"><div><span className="eyebrow">Session handoff</span><h3>Export this rehearsal</h3></div><Clipboard size={16} aria-hidden="true" /></div>
        <div className="finance-workspace__export-toolbar"><span role="status" aria-live="polite">{status}</span><label><span>Format</span><select aria-label="Finance export format" value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--ghost" onClick={() => void copy()}><Clipboard size={13} /> Copy</button><button type="button" className="button button--ghost" onClick={download}><Download size={13} /> Download</button><button type="button" className="button button--ghost" onClick={() => { setSnapshot(initialSnapshot); setFormat("json"); setStatus("Finance workspace preview reset."); }}><RefreshCw size={13} /> Reset</button></div>
        <pre tabIndex={0}><code>{payload}</code></pre>
        <p className="finance-workspace__boundary"><Sparkles size={14} /> Export is a session-only projection. It does not create a durable budget, ledger, account connection, or native receipt.</p>
      </section>
    </section>
  );
}

export default FinanceWorkspacePreview;
