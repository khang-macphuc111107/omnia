import { useMemo, useState } from "react";

import {
  createUpstreamAdapterPlan,
  listUpstreamCapabilities,
  upstreamCapabilitySummary,
  type UpstreamCapabilityDescriptor,
} from "../domain/upstream-capability-catalog";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function modeLabel(mode: UpstreamCapabilityDescriptor["integrationMode"]): string {
  return mode.replaceAll("-", " ");
}

/**
 * A bounded, read-only view of the extracted upstream inventory.
 *
 * This intentionally exposes routing metadata only. It does not launch an
 * upstream process, read a profile, or turn an extracted path into a tool.
 * Execution remains behind the native adapter/permission boundary.
 */
export function UpstreamCapabilitiesSection() {
  const [expanded, setExpanded] = useState(false);
  const [category, setCategory] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const summary = upstreamCapabilitySummary();
  const capabilities = listUpstreamCapabilities();
  const categories = useMemo(
    () => Array.from(new Set(capabilities.map((capability) => capability.category))).sort(),
    [capabilities],
  );
  const visible = useMemo(
    () => capabilities.filter((capability) => category === "all" || capability.category === category),
    [capabilities, category],
  );
  const selected = selectedId ? capabilities.find((capability) => capability.id === selectedId) ?? null : null;
  const plan = selected ? createUpstreamAdapterPlan(selected.id) : null;

  return (
    <section aria-labelledby="ag-upstream-title" className="ag-upstream-capabilities">
      <div className="ag-upstream-capabilities__heading">
        <div>
          <h3 className="ag-subtitle" id="ag-upstream-title">
            Upstream capability catalog
          </h3>
          <p className="ag-muted">
            {summary.total} extracted modules across {summary.categories} categories · {summary.runnable} adapter-ready · {summary.evidenceOnly} review-only
          </p>
        </div>
        <button
          type="button"
          className="ag-btn"
          aria-expanded={expanded}
          aria-controls="ag-upstream-catalog"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Hide catalog" : "Inspect catalog"}
        </button>
      </div>
      {expanded ? (
        <div id="ag-upstream-catalog" className="ag-upstream-capabilities__catalog">
          <div className="ag-row ag-upstream-capabilities__filters">
            <label className="ag-label" htmlFor="ag-upstream-category">
              Category
              <select
                id="ag-upstream-category"
                className="ag-input"
                value={category}
                onChange={(event) => {
                  setCategory(event.target.value);
                  setSelectedId(null);
                }}
              >
                <option value="all">All categories ({capabilities.length})</option>
                {categories.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry} ({capabilities.filter((capability) => capability.category === entry).length})
                  </option>
                ))}
              </select>
            </label>
            <span className="ag-muted" role="status">
              Showing {visible.length} of {capabilities.length}
            </span>
          </div>
          <ul className="ag-upstream-capabilities__list" aria-label="Extracted upstream modules">
            {visible.map((capability) => (
              <li key={capability.id} className="ag-upstream-capabilities__item">
                <button
                  type="button"
                  className="ag-upstream-capabilities__item-button"
                  aria-expanded={selectedId === capability.id}
                  onClick={() => setSelectedId((current) => (current === capability.id ? null : capability.id))}
                >
                  <span className="ag-upstream-capabilities__item-name">{capability.name}</span>
                  <span className="ag-upstream-capabilities__item-meta">
                    {capability.category} · {modeLabel(capability.integrationMode)}
                  </span>
                </button>
                {selectedId === capability.id && plan ? (
                  <div className="ag-upstream-capabilities__details" role="region" aria-label={`${capability.name} adapter details`}>
                    <p className="ag-muted">{capability.integrationReason}</p>
                    <dl className="ag-upstream-capabilities__facts">
                      <div><dt>Classification</dt><dd>{capability.classification.replaceAll("-", " ")}</dd></div>
                      <div><dt>Evidence</dt><dd>{capability.totalFiles.toLocaleString()} files · {formatBytes(capability.totalBytes)}</dd></div>
                      <div><dt>Source files</dt><dd>{capability.sourceFiles.toLocaleString()}</dd></div>
                      <div><dt>Adapter plan</dt><dd>{plan.mode} · {plan.evidenceOnly ? "evidence only" : "execution behind native boundary"}</dd></div>
                      <div><dt>Review</dt><dd>{plan.requiresHumanReview ? "human review required" : "catalog metadata verified"}</dd></div>
                    </dl>
                    {capability.manifests.length > 0 ? <p className="ag-muted">Manifest: {capability.manifests[0]}</p> : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="ag-muted ag-upstream-capabilities__provenance">
            Catalog data is generated from <code>upstream_extractions</code>. Browser profiles, credentials, caches and runtime state stay evidence-only and are never exposed to model-authored tools.
          </p>
        </div>
      ) : null}
    </section>
  );
}

