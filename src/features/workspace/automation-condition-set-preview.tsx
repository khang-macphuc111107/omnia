import { Check, Clipboard, Plus, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

export type AutomationConditionSetOperator = "exists" | "equals" | "contains" | "greater-than" | "less-than";
export type AutomationConditionSetJoin = "all" | "any";

export type AutomationConditionSetRule = {
  id: string;
  field: string;
  operator: AutomationConditionSetOperator;
  value: string;
};

export type AutomationConditionSetSnapshot = {
  join: AutomationConditionSetJoin;
  rules: AutomationConditionSetRule[];
};

export type AutomationConditionSetValidation = {
  ready: boolean;
  errors: string[];
  expression: string;
};

const operatorLabels: Record<AutomationConditionSetOperator, string> = {
  exists: "exists",
  equals: "equals",
  contains: "contains",
  "greater-than": "is greater than",
  "less-than": "is less than",
};

export function createDefaultAutomationConditionSet(ciGate = false): AutomationConditionSetSnapshot {
  return {
    join: "all",
    rules: [ciGate
      ? { id: "rule-1", field: "artifact.status", operator: "equals", value: "ready" }
      : { id: "rule-1", field: "context.status", operator: "exists", value: "" }],
  };
}

function nextRuleId(rules: readonly AutomationConditionSetRule[]): string {
  let suffix = rules.length + 1;
  let id = `rule-${suffix}`;
  while (rules.some((rule) => rule.id === id)) {
    suffix += 1;
    id = `rule-${suffix}`;
  }
  return id;
}

function validateRule(rule: AutomationConditionSetRule, index: number): string | null {
  if (!rule.field.trim()) return `Rule ${index + 1}: add a field.`;
  if (rule.operator === "exists") return null;
  if (!rule.value.trim()) return `Rule ${index + 1}: add a value.`;
  if ((rule.operator === "greater-than" || rule.operator === "less-than") && !Number.isFinite(Number(rule.value))) {
    return `Rule ${index + 1}: numeric comparisons need a number.`;
  }
  return null;
}

export function validateAutomationConditionSet(snapshot: AutomationConditionSetSnapshot): AutomationConditionSetValidation {
  const errors = snapshot.rules.map(validateRule).filter((error): error is string => Boolean(error));
  const expression = snapshot.rules.map((rule) => {
    const field = rule.field.trim() || "(field needed)";
    const value = rule.operator === "exists" ? "" : ` ${rule.value.trim() || "(value needed)"}`;
    return `${field} ${operatorLabels[rule.operator]}${value}`;
  }).join(snapshot.join === "all" ? " AND " : " OR ");
  return { ready: snapshot.rules.length > 0 && errors.length === 0, errors, expression: expression || "(add a rule)" };
}

export type AutomationConditionSetPreviewProps = {
  snapshot: AutomationConditionSetSnapshot;
  onChange: (snapshot: AutomationConditionSetSnapshot) => void;
  onReset: () => void;
};

export function AutomationConditionSetPreview({ snapshot, onChange, onReset }: AutomationConditionSetPreviewProps) {
  const [exportOpen, setExportOpen] = useState(false);
  const validation = useMemo(() => validateAutomationConditionSet(snapshot), [snapshot]);
  const exportPayload = useMemo(() => JSON.stringify({
    schema: "omnia.automation-condition-set.preview.v1",
    scope: "renderer-session",
    executionDisposition: "preview-only",
    boundary: "No scheduler, provider request, connector grant, or durable policy write.",
    conditionSet: snapshot,
    validation,
  }, null, 2), [snapshot, validation]);

  const commit = (next: AutomationConditionSetSnapshot) => {
    onChange(next);
  };

  const updateRule = (id: string, patch: Partial<AutomationConditionSetRule>) => {
    commit({ ...snapshot, rules: snapshot.rules.map((rule) => rule.id === id ? { ...rule, ...patch } : rule) });
  };

  const addRule = () => {
    const id = nextRuleId(snapshot.rules);
    commit({ ...snapshot, rules: [...snapshot.rules, { id, field: "", operator: "equals", value: "" }] });
  };

  const removeRule = (id: string) => {
    if (snapshot.rules.length <= 1) return;
    commit({ ...snapshot, rules: snapshot.rules.filter((rule) => rule.id !== id) });
  };

  return (
    <section className="automation-plan__condition-set" aria-label="Advanced condition rule set">
      <header className="automation-plan__condition-set-heading">
        <div>
          <span className="eyebrow"><ShieldCheck size={13} /> Optional guard set</span>
          <strong>Compose multiple conditions</strong>
          <p>Preview an ALL/ANY rule set before a future runtime evaluates it.</p>
        </div>
        <span className={validation.ready ? "automation-plan__state is-ready" : "automation-plan__state"}>
          {validation.ready ? <Check size={12} /> : null} {validation.ready ? "Ready" : "Needs input"}
        </span>
      </header>
      <p className="automation-plan__condition-set-boundary"><ShieldCheck size={13} /> Rule set stays renderer-local · preview validation only · no execution authority.</p>
      <div className="automation-plan__condition-set-toolbar">
        <label><span>Join rules</span><select aria-label="Condition rule join" value={snapshot.join} onChange={(event) => commit({ ...snapshot, join: event.target.value as AutomationConditionSetJoin })}><option value="all">ALL · every rule must match</option><option value="any">ANY · one rule may match</option></select></label>
        <span className="automation-plan__condition-set-summary">{snapshot.rules.length} rule{snapshot.rules.length === 1 ? "" : "s"} · {snapshot.join === "all" ? "all must match" : "any may match"}</span>
        <button type="button" className="button button--secondary" onClick={addRule}><Plus size={13} /> Add rule</button>
        <button type="button" className="button button--ghost" onClick={onReset}><RotateCcw size={13} /> Reset rules</button>
      </div>
      <div className="automation-plan__condition-rules">
        {snapshot.rules.map((rule, index) => {
          const error = validateRule(rule, index);
          return (
            <article className="automation-plan__condition-rule" key={rule.id}>
              <div className="automation-plan__condition-rule-heading"><span className="automation-plan__condition-rule-index">{index + 1}</span><strong>Rule {index + 1}</strong>{error ? <span className="automation-plan__condition-rule-error">{error}</span> : <span className="automation-plan__condition-rule-ready"><Check size={12} /> Valid</span>}<button type="button" className="button button--ghost" onClick={() => removeRule(rule.id)} disabled={snapshot.rules.length <= 1} aria-label={`Remove condition rule ${index + 1}`}><Trash2 size={13} /></button></div>
              <div className="automation-plan__condition-rule-grid">
                <label><span>Field</span><input aria-label={`Condition rule ${index + 1} field`} value={rule.field} onChange={(event) => updateRule(rule.id, { field: event.target.value })} placeholder="artifact.status" /></label>
                <label><span>Operator</span><select aria-label={`Condition rule ${index + 1} operator`} value={rule.operator} onChange={(event) => updateRule(rule.id, { operator: event.target.value as AutomationConditionSetOperator })}>{(Object.keys(operatorLabels) as AutomationConditionSetOperator[]).map((operator) => <option key={operator} value={operator}>{operatorLabels[operator]}</option>)}</select></label>
                <label><span>Value</span><input aria-label={`Condition rule ${index + 1} value`} value={rule.value} onChange={(event) => updateRule(rule.id, { value: event.target.value })} placeholder={rule.operator === "exists" ? "Optional" : "ready"} /></label>
              </div>
            </article>
          );
        })}
      </div>
      <div className="automation-plan__condition-set-expression"><span>Preview expression</span><code>{validation.expression}</code></div>
      <div className="automation-plan__condition-set-actions"><button type="button" className="button button--ghost" onClick={() => setExportOpen((open) => !open)} aria-expanded={exportOpen}><Clipboard size={13} /> {exportOpen ? "Hide rule JSON" : "Preview rule JSON"}</button></div>
      {exportOpen ? <pre className="automation-plan__condition-set-export" aria-label="Condition rule set export"><code>{exportPayload}</code></pre> : null}
    </section>
  );
}

export default AutomationConditionSetPreview;
