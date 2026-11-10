import { useMemo, useState, type KeyboardEvent } from "react";
import { Calculator, Clipboard, Download, FlaskConical, Gauge, History, Sigma, Sparkles } from "lucide-react";

type LabDomain = "math" | "physics" | "chemistry" | "finance";
type ExportFormat = "json" | "markdown";
type FinanceScenario = "compound" | "loan" | "discounted-cash-flow";
type MassUnit = "kg" | "g";
type VelocityUnit = "m/s" | "km/h";
type VolumeUnit = "L" | "mL";

type LabState = {
  financeScenario: FinanceScenario;
  massUnit: MassUnit;
  velocityUnit: VelocityUnit;
  volumeUnit: VolumeUnit;
  mathA: string;
  mathB: string;
  mass: string;
  velocity: string;
  moles: string;
  volume: string;
  principal: string;
  rate: string;
  years: string;
  compounds: string;
  cashFlow: string;
};

type LabResult = {
  label: string;
  value: string;
  unit: string;
  formula: string;
  assumptions: string[];
  metrics: LabMetric[];
};

type LabHistoryEntry = {
  domain: LabDomain;
  state: LabState;
  result: LabResult;
};

type LabMetric = {
  label: string;
  value: string;
  unit: string;
};

type FinanceSensitivityPoint = {
  rate: number;
  compound: string;
  loan: string;
  discountedCashFlow: string;
};

const initialState: LabState = {
  financeScenario: "compound",
  massUnit: "kg",
  velocityUnit: "m/s",
  volumeUnit: "L",
  mathA: "4",
  mathB: "-12",
  mass: "2",
  velocity: "12",
  moles: "0.5",
  volume: "2",
  principal: "1000",
  rate: "5",
  years: "3",
  compounds: "12",
  cashFlow: "400",
};

const domainMeta: Record<LabDomain, { label: string; description: string }> = {
  math: { label: "Math", description: "Small, deterministic equation checks" },
  physics: { label: "Physics", description: "Mechanics and unit-aware previews" },
  chemistry: { label: "Chemistry", description: "Stoichiometry and concentration sketches" },
  finance: { label: "Finance", description: "Scenario math, not financial advice" },
};

const financeScenarioMeta: Record<FinanceScenario, { label: string; description: string }> = {
  compound: { label: "Compound growth", description: "Future value from a recurring compounding assumption" },
  loan: { label: "Loan amortization", description: "Periodic payment and total interest preview" },
  "discounted-cash-flow": { label: "Discounted cash flow", description: "Present-value scenario using one recurring cash flow" },
};

function numberOf(value: string, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isNumeric(value: string) {
  return value.trim().length > 0 && Number.isFinite(Number(value));
}

function hasBlockingInputReview(messages: string[]) {
  return messages.some((message) => (
    message.includes("must be a finite number")
    || message.includes("must be greater than zero")
    || message.includes("must be zero or greater")
    || message.includes("cannot be negative")
    || message.includes("must be above -100%")
  ));
}

function inputReview(domain: LabDomain, state: LabState): string[] {
  const messages: string[] = [];
  const requireNumeric = (value: string, label: string) => {
    if (!isNumeric(value)) messages.push(`${label} must be a finite number.`);
  };
  if (domain === "math") {
    requireNumeric(state.mathA, "Coefficient a");
    requireNumeric(state.mathB, "Constant b");
    if (isNumeric(state.mathA) && numberOf(state.mathA) === 0) messages.push("Coefficient a is zero, so the linear root is undefined.");
  } else if (domain === "physics") {
    requireNumeric(state.mass, "Mass");
    requireNumeric(state.velocity, "Velocity");
    if (isNumeric(state.mass) && numberOf(state.mass) < 0) messages.push("Mass must be zero or greater.");
  } else if (domain === "chemistry") {
    requireNumeric(state.moles, "Amount");
    requireNumeric(state.volume, "Volume");
    if (isNumeric(state.moles) && numberOf(state.moles) < 0) messages.push("Amount must be zero or greater.");
    if (isNumeric(state.volume) && numberOf(state.volume) <= 0) messages.push("Volume must be greater than zero for concentration.");
  } else {
    requireNumeric(state.principal, "Principal / notional");
    requireNumeric(state.rate, "Annual rate");
    requireNumeric(state.years, "Years");
    requireNumeric(state.compounds, "Compounds / payments per year");
    if (state.financeScenario === "discounted-cash-flow") requireNumeric(state.cashFlow, "Cash flow / period");
    if (isNumeric(state.compounds) && numberOf(state.compounds) <= 0) messages.push("Compounds / payments per year must be greater than zero.");
    if (isNumeric(state.years) && numberOf(state.years) <= 0) messages.push("Years must be greater than zero in this preview.");
    if (isNumeric(state.rate) && numberOf(state.rate) <= -100) messages.push("Annual rate must be above -100% for this formula preview.");
  }
  return messages;
}

function invalidResult(messages: string[]): LabResult {
  return {
    label: "Preview unavailable",
    value: "Unavailable",
    unit: "",
    formula: "Resolve the input review warnings before calculating.",
    assumptions: ["No numeric result was computed from invalid or incomplete inputs", ...messages],
    metrics: [],
  };
}

function calculate(domain: LabDomain, state: LabState, reviewedMessages = inputReview(domain, state)): LabResult {
  if (hasBlockingInputReview(reviewedMessages)) return invalidResult(reviewedMessages);
  if (domain === "math") {
    const a = numberOf(state.mathA);
    const b = numberOf(state.mathB);
    return {
      label: "Linear root",
      value: a === 0 ? "Undefined" : String(Number((-b / a).toFixed(6))),
      unit: "x",
      formula: `${a}x + (${b}) = 0`,
      assumptions: ["Real-valued linear equation", "a must be non-zero for a unique root"],
      metrics: [{ label: "Coefficient ratio", value: a === 0 ? "Undefined" : String(Number((Math.abs(b / a)).toFixed(4))), unit: "|b/a|" }],
    };
  }
  if (domain === "physics") {
    const rawMass = numberOf(state.mass);
    const rawVelocity = numberOf(state.velocity);
    const mass = state.massUnit === "g" ? rawMass / 1000 : rawMass;
    const velocity = state.velocityUnit === "km/h" ? rawVelocity / 3.6 : rawVelocity;
    return {
      label: "Kinetic energy",
      value: (0.5 * mass * velocity ** 2).toFixed(4),
      unit: "J",
      formula: `E = 1/2 · m · v² = 1/2 · ${mass.toFixed(4)} kg · (${velocity.toFixed(4)} m/s)²`,
      assumptions: [`Mass input is ${rawMass} ${state.massUnit} and normalized to kg`, `Velocity input is ${rawVelocity} ${state.velocityUnit} and normalized to m/s`, "Classical mechanics approximation"],
      metrics: [{ label: "Momentum", value: (mass * velocity).toFixed(4), unit: "kg·m/s" }],
    };
  }
  if (domain === "chemistry") {
    const moles = numberOf(state.moles);
    const rawVolume = numberOf(state.volume);
    const volume = state.volumeUnit === "mL" ? rawVolume / 1000 : rawVolume;
    return {
      label: "Molar concentration",
      value: volume === 0 ? "Undefined" : (moles / volume).toFixed(6),
      unit: "mol/L",
      formula: `c = n / V = ${moles} mol / ${volume.toFixed(6)} L`,
      assumptions: [`Volume input is ${rawVolume} ${state.volumeUnit} and normalized to litres`, "Ideal-solution approximation", "No activity correction applied"],
      metrics: [{ label: "Amount", value: moles.toFixed(4), unit: "mol" }],
    };
  }
  const principal = numberOf(state.principal);
  const rate = numberOf(state.rate) / 100;
  const years = numberOf(state.years);
  const compounds = Math.max(1, numberOf(state.compounds, 1));
  const periods = Math.max(1, compounds * years);
  const periodicRate = rate / compounds;
  if (state.financeScenario === "loan") {
    const payment = periodicRate === 0
      ? principal / periods
      : principal * periodicRate / (1 - (1 + periodicRate) ** -periods);
    const totalPaid = payment * periods;
    return {
      label: "Loan amortization scenario",
      value: payment.toFixed(2),
      unit: "currency / period",
      formula: `PMT = P·i / (1 − (1 + i)^−N) = ${principal}·${periodicRate.toFixed(6)} / (1 − (1 + ${periodicRate.toFixed(6)})^−${periods})`,
      assumptions: ["Rate is an annual percentage", "Payments occur at a fixed frequency", "Scenario is illustrative, not advice"],
      metrics: [
        { label: "Total paid", value: totalPaid.toFixed(2), unit: "currency units" },
        { label: "Total interest", value: Math.max(0, totalPaid - principal).toFixed(2), unit: "currency units" },
      ],
    };
  }
  if (state.financeScenario === "discounted-cash-flow") {
    const cashFlow = numberOf(state.cashFlow);
    const presentValue = periodicRate === 0
      ? cashFlow * periods
      : cashFlow * (1 - (1 + periodicRate) ** -periods) / periodicRate;
    return {
      label: "Discounted cash-flow scenario",
      value: presentValue.toFixed(2),
      unit: "currency units",
      formula: `PV = C·(1 − (1 + i)^−N) / i = ${cashFlow}·(1 − (1 + ${periodicRate.toFixed(6)})^−${periods}) / ${periodicRate.toFixed(6) || "0"}`,
      assumptions: ["Cash flow repeats every period", "Discount rate is an annual percentage", "Scenario is illustrative, not advice"],
      metrics: [{ label: "Undiscounted cash flow", value: (cashFlow * periods).toFixed(2), unit: "currency units" }],
    };
  }
  const future = principal * (1 + periodicRate) ** periods;
  return {
    label: "Compound-growth scenario",
    value: future.toFixed(2),
    unit: "currency units",
    formula: `A = P(1 + r/n)^(nt) = ${principal}(1 + ${rate.toFixed(4)}/${compounds})^(${compounds}·${years})`,
    assumptions: ["Rate is an annual percentage", "Compounding frequency is fixed", "Scenario is illustrative, not advice"],
    metrics: [
      { label: "Growth", value: (future - principal).toFixed(2), unit: "currency units" },
      { label: "Multiple", value: principal === 0 ? "Undefined" : (future / principal).toFixed(4), unit: "× principal" },
    ],
  };
}

function inputFor(domain: LabDomain, state: LabState, update: (key: keyof LabState, value: string) => void) {
  if (domain === "math") return <div className="technical-lab__input-grid"><label><span>Coefficient a</span><input aria-label="Coefficient a" inputMode="decimal" value={state.mathA} onChange={(event) => update("mathA", event.target.value)} /></label><label><span>Constant b</span><input aria-label="Constant b" inputMode="decimal" value={state.mathB} onChange={(event) => update("mathB", event.target.value)} /></label></div>;
  if (domain === "physics") return <div className="technical-lab__input-grid"><label><span>Mass</span><div className="technical-lab__unit-input"><input aria-label="Mass value" inputMode="decimal" step="any" value={state.mass} onChange={(event) => update("mass", event.target.value)} /><select aria-label="Mass unit" value={state.massUnit} onChange={(event) => update("massUnit", event.target.value)}><option value="kg">kg</option><option value="g">g</option></select></div></label><label><span>Velocity</span><div className="technical-lab__unit-input"><input aria-label="Velocity value" inputMode="decimal" step="any" value={state.velocity} onChange={(event) => update("velocity", event.target.value)} /><select aria-label="Velocity unit" value={state.velocityUnit} onChange={(event) => update("velocityUnit", event.target.value)}><option value="m/s">m/s</option><option value="km/h">km/h</option></select></div></label></div>;
  if (domain === "chemistry") return <div className="technical-lab__input-grid"><label><span>Amount (mol)</span><input aria-label="Amount in moles" inputMode="decimal" min="0" step="any" value={state.moles} onChange={(event) => update("moles", event.target.value)} /></label><label><span>Volume</span><div className="technical-lab__unit-input"><input aria-label="Volume value" inputMode="decimal" min="0" step="any" value={state.volume} onChange={(event) => update("volume", event.target.value)} /><select aria-label="Volume unit" value={state.volumeUnit} onChange={(event) => update("volumeUnit", event.target.value)}><option value="L">L</option><option value="mL">mL</option></select></div></label></div>;
  return <>
    <div className="technical-lab__scenario-grid" role="group" aria-label="Finance scenario presets">
      {(Object.keys(financeScenarioMeta) as FinanceScenario[]).map((scenario) => <button
        key={scenario}
        type="button"
        className={`technical-lab__scenario ${state.financeScenario === scenario ? "is-active" : ""}`}
        aria-pressed={state.financeScenario === scenario}
        onClick={() => update("financeScenario", scenario)}
      >
        <strong>{financeScenarioMeta[scenario].label}</strong>
        <span>{financeScenarioMeta[scenario].description}</span>
      </button>)}
    </div>
    <div className="technical-lab__input-grid">
      <label><span>Principal / notional</span><input aria-label="Principal amount" inputMode="decimal" value={state.principal} onChange={(event) => update("principal", event.target.value)} /></label>
      <label><span>Annual rate (%)</span><input aria-label="Annual rate" inputMode="decimal" value={state.rate} onChange={(event) => update("rate", event.target.value)} /></label>
      <label><span>Years</span><input aria-label="Years" inputMode="decimal" min="0" step="any" value={state.years} onChange={(event) => update("years", event.target.value)} /></label>
      <label><span>Compounds / payments per year</span><input aria-label="Compounds per year" inputMode="numeric" min="1" step="1" value={state.compounds} onChange={(event) => update("compounds", event.target.value)} /></label>
      {state.financeScenario === "discounted-cash-flow" ? <label><span>Cash flow / period</span><input aria-label="Cash flow per period" inputMode="decimal" value={state.cashFlow} onChange={(event) => update("cashFlow", event.target.value)} /></label> : null}
    </div>
  </>;
}

export function TechnicalLabPreview() {
  const [domain, setDomain] = useState<LabDomain>("math");
  const [state, setState] = useState<LabState>(initialState);
  const [history, setHistory] = useState<LabHistoryEntry[]>([]);
  const [format, setFormat] = useState<ExportFormat>("json");
  const [status, setStatus] = useState("Ready for a local calculation preview.");
  const domains = Object.keys(domainMeta) as LabDomain[];
  const reviewMessages = useMemo(() => inputReview(domain, state), [domain, state]);
  const result = useMemo(() => calculate(domain, state, reviewMessages), [domain, reviewMessages, state]);
  const financeComparisons = useMemo(() => {
    if (domain !== "finance") return [];
    return (Object.keys(financeScenarioMeta) as FinanceScenario[]).map((scenario) => {
      const scenarioState = { ...state, financeScenario: scenario };
      const scenarioResult = calculate("finance", scenarioState, inputReview("finance", scenarioState));
      return { scenario, ...scenarioResult };
    });
  }, [domain, state]);
  const financeSensitivity = useMemo<FinanceSensitivityPoint[]>(() => {
    if (domain !== "finance" || hasBlockingInputReview(reviewMessages)) return [];
    const baseRate = numberOf(state.rate);
    const rates = Array.from(new Set([-2, 0, 2].map((offset) => Math.max(-99.9, Number((baseRate + offset).toFixed(2))))));
    return rates.map((rate) => {
      const rateState = { ...state, rate: String(rate) };
      return {
        rate,
        compound: calculate("finance", { ...rateState, financeScenario: "compound" }).value,
        loan: calculate("finance", { ...rateState, financeScenario: "loan" }).value,
        discountedCashFlow: calculate("finance", { ...rateState, financeScenario: "discounted-cash-flow" }).value,
      };
    });
  }, [domain, reviewMessages, state]);

  const update = (key: keyof LabState, value: string) => setState((current) => ({ ...current, [key]: value }));
  const moveDomainTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? domains.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + domains.length) % domains.length;
    const nextDomain = domains[nextIndex];
    if (!nextDomain) return;
    setDomain(nextDomain);
    setStatus(`Switched to ${domainMeta[nextDomain].label} preview.`);
    document.getElementById(`technical-lab-tab-${nextDomain}`)?.focus();
  };
  const record = () => {
    if (hasBlockingInputReview(reviewMessages)) {
      setStatus("Resolve the input review warnings before recording a result.");
      return;
    }
    const entry: LabHistoryEntry = { domain, state: { ...state }, result };
    setHistory((current) => [entry, ...current.filter((item) => item.domain !== domain || item.result.formula !== result.formula)].slice(0, 4));
    setStatus(`${result.label} recalculated in the browser preview.`);
  };
  const payload = useMemo(() => {
    const data = { schema: "omnia.technical-lab.preview.v1", scope: "renderer-session", domain, inputs: state, inputReview: reviewMessages, result, comparisons: financeComparisons, sensitivity: financeSensitivity, history };
    if (format === "json") return JSON.stringify(data, null, 2);
    const comparisonText = financeComparisons.length
      ? `\n## Finance scenario comparison\n\n${financeComparisons.map((item) => `- **${financeScenarioMeta[item.scenario].label}**: ${item.value} ${item.unit}`).join("\n")}\n`
      : "";
    const sensitivityText = financeSensitivity.length
      ? `\n## Finance sensitivity (+/- 2 percentage points)\n\n${financeSensitivity.map((point) => `- **${point.rate}%**: compound ${point.compound}; loan ${point.loan}; DCF ${point.discountedCashFlow}`).join("\n")}\n`
      : "";
    const reviewText = reviewMessages.length ? `\n## Input review\n\n${reviewMessages.map((message) => `- ${message}`).join("\n")}\n` : "";
    return `# Omnia technical lab preview\n\n- Domain: ${domainMeta[domain].label}\n- Result: ${result.value} ${result.unit}\n- Formula: ${result.formula}\n${reviewText}${comparisonText}${sensitivityText}\nRenderer-local preview; no external data or professional advice.\n`;
  }, [domain, financeComparisons, financeSensitivity, format, history, result, reviewMessages, state]);
  const copy = async () => {
    if (!navigator.clipboard?.writeText) { setStatus("Clipboard unavailable; nothing was copied."); return; }
    try { await navigator.clipboard.writeText(payload); setStatus(`Copied ${format.toUpperCase()} technical preview.`); } catch { setStatus("Clipboard access was denied; nothing was copied."); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `omnia-technical-lab-preview.${format === "json" ? "json" : "md"}`; anchor.click(); URL.revokeObjectURL(url); setStatus("Downloaded a renderer-local technical preview.");
  };

  return <section className="technical-lab" aria-labelledby="technical-lab-heading">
    <header className="technical-lab__header"><div><span className="eyebrow">Science · maths · finance</span><h2 id="technical-lab-heading">Technical Lab</h2><p>Small, inspectable workbenches for equations, mechanics, chemistry, and scenario math.</p></div><span className="technical-lab__badge"><Sparkles size={13} /> Preview only</span></header>
    <div className="technical-lab__tabs" role="tablist" aria-label="Technical lab domains" aria-orientation="horizontal">{domains.map((entry, index) => <button key={entry} id={`technical-lab-tab-${entry}`} type="button" role="tab" aria-selected={entry === domain} aria-controls={`technical-lab-panel-${entry}`} tabIndex={entry === domain ? 0 : -1} className={entry === domain ? "is-active" : ""} onClick={() => { setDomain(entry); setStatus(`Switched to ${domainMeta[entry].label} preview.`); }} onKeyDown={(event) => moveDomainTab(event, index)}>{entry === "math" ? <Sigma size={15} /> : entry === "physics" ? <Gauge size={15} /> : entry === "chemistry" ? <FlaskConical size={15} /> : <Calculator size={15} />}{domainMeta[entry].label}</button>)}</div>
    <div id={`technical-lab-panel-${domain}`} className="technical-lab__grid" role="tabpanel" aria-labelledby={`technical-lab-tab-${domain}`} tabIndex={0}>
      <div className="technical-lab__card">
        <div className="technical-lab__card-heading"><div><span className="eyebrow">Inputs</span><h3>{domainMeta[domain].description}</h3></div><span className="technical-lab__domain">{domainMeta[domain].label}</span></div>
        {inputFor(domain, state, update)}
        <div className={`technical-lab__input-review ${reviewMessages.length ? "has-warnings" : "is-ready"}`} role="status" aria-live="polite" aria-label="Technical lab input review"><strong>{reviewMessages.length ? "Review inputs" : "Inputs ready"}</strong>{reviewMessages.length ? <ul>{reviewMessages.map((message) => <li key={message}>{message}</li>)}</ul> : <span>All visible values pass the local shape checks.</span>}</div>
        <div className="technical-lab__actions"><button type="button" className="button button--secondary" onClick={record}>Recalculate preview</button><button type="button" className="button button--ghost" onClick={() => { setState(initialState); setHistory([]); setStatus("Technical lab preview reset."); }}>Reset</button></div>
        <p className="technical-lab__boundary"><Sparkles size={14} /> No external datasets, provider calls, code execution, or professional advice are involved.</p>
      </div>
      <aside className="technical-lab__card technical-lab__result">
        <div className="technical-lab__card-heading"><div><span className="eyebrow">Result card</span><h3>{result.label}</h3></div><Clipboard size={16} aria-hidden="true" /></div>
        <strong className="technical-lab__value">{result.value} <small>{result.unit}</small></strong>
        <code>{result.formula}</code>
        <div className="technical-lab__assumptions"><strong>Assumptions</strong>{result.assumptions.map((item) => <span key={item}>{item}</span>)}</div>
        <div className="technical-lab__metrics" aria-label="Derived metrics">{result.metrics.map((metric) => <div key={metric.label}><span>{metric.label}</span><strong>{metric.value} <small>{metric.unit}</small></strong></div>)}</div>
      </aside>
    </div>
    {domain === "finance" ? <section className="technical-lab__comparison" aria-label="Finance scenario comparison"><div className="technical-lab__card-heading"><div><span className="eyebrow">Scenario board</span><h3>Compare finance models</h3></div><span className="technical-lab__domain">Renderer-local</span></div><p className="technical-lab__comparison-note">Same inputs, three deterministic models. Select one to make it the active result.</p><div className="technical-lab__comparison-grid">{financeComparisons.map((item) => <button key={item.scenario} type="button" className={`technical-lab__comparison-card ${state.financeScenario === item.scenario ? "is-active" : ""}`} aria-pressed={state.financeScenario === item.scenario} onClick={() => update("financeScenario", item.scenario)}><span>{financeScenarioMeta[item.scenario].label}</span><strong>{item.value} <small>{item.unit}</small></strong><em>{item.metrics[0]?.label}: {item.metrics[0]?.value ?? "—"}</em></button>)}</div><div className="technical-lab__sensitivity"><div className="technical-lab__card-heading"><div><span className="eyebrow">Sensitivity preview</span><h3>Rate sweep</h3></div><span className="technical-lab__domain">±2 percentage points</span></div><p className="technical-lab__comparison-note">A compact deterministic sweep around the current annual rate; it does not use market data or forecasts.</p><div className="technical-lab__table-wrap"><table aria-label="Finance sensitivity preview"><thead><tr><th scope="col">Annual rate</th><th scope="col">Compound</th><th scope="col">Loan payment</th><th scope="col">DCF</th></tr></thead><tbody>{financeSensitivity.map((point) => <tr key={point.rate}><th scope="row">{point.rate}%</th><td>{point.compound}</td><td>{point.loan}</td><td>{point.discountedCashFlow}</td></tr>)}</tbody></table></div></div></section> : null}
    <section className="technical-lab__history" aria-label="Technical lab history"><div className="technical-lab__card-heading"><div><span className="eyebrow">Session history</span><h3>Recent calculations</h3></div><History size={16} aria-hidden="true" /></div>{history.length ? <div className="technical-lab__history-list">{history.map((item) => <button key={`${item.domain}:${item.result.formula}`} type="button" aria-label={`Restore ${item.result.label} from ${domainMeta[item.domain].label} history`} onClick={() => { setDomain(item.domain); setState({ ...item.state }); setStatus(`Restored ${item.result.label} from local history.`); }}><strong>{item.result.value} {item.result.unit}</strong><span>{domainMeta[item.domain].label} · {item.result.formula}</span></button>)}</div> : <p className="technical-lab__empty">No calculations recorded yet. Recalculate to pin a result here.</p>}</section>
    <section className="technical-lab__export" aria-label="Technical lab export preview"><div className="technical-lab__export-toolbar"><label><span>Format</span><select aria-label="Technical lab export format" value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><span role="status" aria-live="polite">{status}</span><button type="button" className="button button--ghost" onClick={() => void copy()}>Copy</button><button type="button" className="button button--secondary" onClick={download}><Download size={13} /> Download</button></div><pre tabIndex={0} aria-label="Technical lab export payload"><code>{payload}</code></pre></section>
  </section>;
}

export default TechnicalLabPreview;
