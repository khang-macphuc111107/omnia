import { PanelRight } from "lucide-react";

import { useAgentStore } from "./agent-store";
import type { ToolItem } from "./transcript";

import "./artifacts-panel.css";

export interface ArtifactToolResult {
  id: string;
  version: number;
  title: string;
  kind: string;
  action: string;
}

/** Parses the JSON the `artifact` tool returns; null for errors, deletes and anything unexpected. */
export function artifactResult(item: ToolItem): ArtifactToolResult | null {
  if (item.name !== "artifact" || item.status !== "ok") return null;
  try {
    const value = JSON.parse(item.output) as Partial<ArtifactToolResult>;
    if (typeof value.id !== "string" || typeof value.title !== "string" || typeof value.version !== "number") return null;
    if (value.action === "delete") return null;
    return { id: value.id, version: value.version, title: value.title, kind: String(value.kind ?? ""), action: String(value.action ?? "") };
  } catch {
    return null;
  }
}

/** Transcript card for a completed `artifact` call, with a button that opens the side panel. */
export function ArtifactCard({ item, sessionId }: { item: ToolItem; sessionId: string | null }) {
  const requestArtifact = useAgentStore((state) => state.requestArtifact);
  const result = artifactResult(item);
  if (!result || !sessionId) return null;
  return (
    <div className="ag-artifact-card" role="group" aria-label={`Artifact ${result.title}`}>
      <div className="ag-artifact-card__text">
        <span className="ag-artifact-card__title">{result.title}</span>
        <span className="ag-muted">{result.kind} · v{result.version}{result.action === "update" ? " (updated)" : ""}</span>
      </div>
      <button
        type="button"
        className="ag-btn"
        aria-label={`Open artifact ${result.title}`}
        onClick={() => requestArtifact({ sessionId, id: result.id, version: result.version, reason: "open" })}
      >
        <PanelRight size={14} aria-hidden="true" />Open
      </button>
    </div>
  );
}
