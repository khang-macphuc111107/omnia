import { useId } from "react";
import "./effort-select.css";

const EFFORT_OPTIONS = ["low", "medium", "high", "max"];
const EFFORT_HINT = "Applies to the next run. Supported levels vary by provider and model.";

/** Common native-provider effort values; default leaves provider behavior unchanged. */
export function EffortSelect({ value, onChange, disabled = false }: {
  value?: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label className="ag-muted ag-effort-select" htmlFor={id}>
      <span className="ag-effort-select__label">Reasoning effort</span>
      {/* Keep the native popup: it escapes clipped/scrolling ancestors and provides
          platform keyboard navigation, type-ahead, dismissal and focus handling. */}
      <select id={id} className="ag-input ag-effort-select__control" value={value ?? ""} disabled={disabled}
        title={`${value || "Provider default"}. ${EFFORT_HINT}`}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(event.target.value || null)}>
        <option value="">Provider default</option>
        {value && !EFFORT_OPTIONS.includes(value) ? <option value={value}>{value}</option> : null}
        {EFFORT_OPTIONS.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
      </select>
      <span id={`${id}-hint`} hidden>{EFFORT_HINT}</span>
    </label>
  );
}
