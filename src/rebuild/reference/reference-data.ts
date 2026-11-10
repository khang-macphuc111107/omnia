import { cycle10Observations } from "./reference-cycle10";

export type ReferenceArea = "agent" | "ide" | "browser" | "research" | "workflow";
export type Decision = "adopt" | "adapt" | "defer";

export interface ReferenceObservation {
  id: string;
  name: string;
  owner: string;
  area: ReferenceArea;
  sourcePath: string;
  revision: string;
  license: string;
  freshness: string;
  observation: string;
  strength: string;
  weakness: string;
  omniaDecision: string;
  decision: Decision;
  acceptance: string;
}

/**
 * Hand-reviewed observations from the extracted corpus. These are intentionally
 * small, traceable records rather than copied UI source or a feature checklist.
 * The renderer uses them to show the synthesis decision before product UI work.
 */
export const referenceObservations: readonly ReferenceObservation[] = [
  {
    id: "codex-session-continuity",
    name: "Codex session continuity",
    owner: "openai/codex",
    area: "agent",
    sourcePath: "cli/codex-cli/SPEC_AND_PROTOCOL.md",
    revision: "extraction-2026-11-07",
    license: "unknown in extraction; adapter-only",
    freshness: "reviewed 2026-11-08",
    observation: "Session state and command execution are separate contracts, which lets a client resume work without treating a transcript as the runtime.",
    strength: "Clear boundary between conversation state, execution, and permissions.",
    weakness: "The extracted contract does not prove persistence or live provider behavior on this machine.",
    omniaDecision: "Represent a session as durable state plus an explicit run ledger; show reconnect and permission state instead of optimistic output.",
    decision: "adopt",
    acceptance: "Reloading a session restores its selected tab and run status from authoritative storage; disconnected providers remain visibly unavailable.",
  },
  {
    id: "claude-stream-events",
    name: "Claude stream event parser",
    owner: "anthropics/claude-cli",
    area: "agent",
    sourcePath: "cli/claude-cli/src/stream-parser.ts",
    revision: "extraction-2026-11-07",
    license: "unknown in extraction; adapter-only",
    freshness: "reviewed 2026-11-08",
    observation: "The parser distinguishes text deltas, thinking deltas, tool calls, and message termination while buffering incomplete lines.",
    strength: "Partial stream chunks do not have to become malformed messages.",
    weakness: "A parser alone cannot establish run identity, replay ordering, cancellation, or provider acceptance.",
    omniaDecision: "Use typed lifecycle events with session/run/sequence IDs and bounded replay; render tool and reasoning summaries as separate disclosure rows.",
    decision: "adapt",
    acceptance: "Out-of-order or duplicate events are rejected or reconciled deterministically; a cancel and reload never duplicate an assistant message.",
  },
  {
    id: "claude-file-history",
    name: "Claude file history DAG",
    owner: "anthropics/claude-cli",
    area: "agent",
    sourcePath: "harnesses/claude-cli-desktop/DAEMON_AND_SESSION_SPEC.md",
    revision: "extraction-2026-11-07",
    license: "unknown in extraction; design evidence only",
    freshness: "reviewed 2026-11-08",
    observation: "Content-addressed file snapshots and a daemon roster make edits inspectable and reversible across agent sessions.",
    strength: "Rollback can be attached to an exact content hash rather than a fragile path alone.",
    weakness: "The extraction is a specification, not evidence that the described daemon is available or safe to launch.",
    omniaDecision: "Use pointer identity plus immutable content snapshots in the project store, with explicit permission and restore actions.",
    decision: "adapt",
    acceptance: "Rename, move, or delete of an origin path keeps a stable pointer; the latest stored snapshot remains recoverable after origin deletion.",
  },
  {
    id: "cursor-shadow-workspace",
    name: "Cursor shadow workspace",
    owner: "cursor/cursor",
    area: "ide",
    sourcePath: "ide/cursor/src/shadow-workspace.ts",
    revision: "extraction-2026-11-07",
    license: "unknown in extraction; adapter-only",
    freshness: "reviewed 2026-11-08",
    observation: "Edits are staged in a virtual workspace, tracked as dirty/versioned entries and applied or rolled back as a deliberate operation.",
    strength: "Reviewable changes can be isolated before touching the origin file.",
    weakness: "The simplified extraction does not cover conflict detection, filesystem permissions, or large-file performance.",
    omniaDecision: "Own a local editor with an explicit draft/snapshot/apply boundary and conflict receipt; do not embed an external editor.",
    decision: "adapt",
    acceptance: "A dirty edit shows a diff and conflict state; apply and rollback are explicit and survive a reload without silent writes.",
  },
  {
    id: "chrome-cdp-leases",
    name: "Chrome CDP tab protocol",
    owner: "browser/chrome-canary",
    area: "browser",
    sourcePath: "browser/chrome-canary/src/cdp-client.ts",
    revision: "extraction-2026-11-07",
    license: "unknown in extraction; adapter-only",
    freshness: "reviewed 2026-11-08",
    observation: "The browser adapter separates a CDP connection from tab layout and allows page actions to be bounded by a target session.",
    strength: "Browser control can be scoped to a tab instead of leaking state across tabs.",
    weakness: "A connection contract does not prove DOM safety, capture freshness, or the behavior of a native WebView.",
    omniaDecision: "Keep tab leases, document identity and capture eligibility in the native bridge; lazy-enable capture only when requested.",
    decision: "adapt",
    acceptance: "Tab switch, navigation, release, and stale capture all produce deterministic cleanup and never surface text from another document.",
  },
  {
    id: "perplexity-citation-graph",
    name: "Perplexity-style synthesis graph",
    owner: "research/perplexity-synthesis",
    area: "research",
    sourcePath: "research/perplexity-synthesis/src/citation-graph.ts",
    revision: "extraction-2026-11-07",
    license: "unknown in extraction; workflow evidence",
    freshness: "reviewed 2026-11-08",
    observation: "A synthesis workflow keeps query fan-out and citation graph construction as separate stages.",
    strength: "A claim can retain its supporting source lineage rather than becoming unsupported prose.",
    weakness: "Static source objects do not establish freshness, authoritativeness, or independent corroboration.",
    omniaDecision: "Store retrieval receipts with URL, timestamp, content hash, extraction stage, and claim linkage; display stale or conflicting sources.",
    decision: "adapt",
    acceptance: "Every research claim can open its receipt and shows source freshness and conflict state; missing receipts block Done.",
  },
  {
    id: "ag-ui-run-events",
    name: "AG-UI lifecycle events",
    owner: "ag-ui-protocol/ag-ui",
    area: "workflow",
    sourcePath: "protocol event documentation (web research, 2026-11-08)",
    revision: "main, source reviewed 2026-11-08",
    license: "MIT (repository metadata; verify before vendoring)",
    freshness: "new source this cycle",
    observation: "Run started/finished/error and state snapshot/delta events provide a narrow transport contract between an agent and a UI.",
    strength: "Lifecycle and state synchronization can be tested without tying the UI to one model SDK.",
    weakness: "A protocol does not provide authorization, storage, provider routing, or UI design by itself.",
    omniaDecision: "Use the event shape as a transport boundary, adding Omnia run IDs, permission receipts, and durable replay semantics.",
    decision: "adapt",
    acceptance: "A replayed run renders the same terminal state; state deltas with an invalid cursor are rejected and recover through a snapshot.",
  },
  {
    id: "assistant-ui-disclosure",
    name: "Assistant UI primitive model",
    owner: "assistant-ui/assistant-ui",
    area: "agent",
    sourcePath: "apps/docs/content/docs/(reference)/api-reference/primitives/thread.mdx",
    revision: "main, source reviewed 2026-11-08",
    license: "MIT (repository metadata; verify before vendoring)",
    freshness: "new source this cycle",
    observation: "Thread, queue, suggestion, message-part, tool, reasoning and selection primitives separate conversation states from presentation.",
    strength: "Progressive disclosure can keep advanced tool state available without overwhelming the transcript.",
    weakness: "A component library can encourage visual replication and does not solve Omnia's native contracts.",
    omniaDecision: "Use the interaction taxonomy only: Omnia's own components expose transcript, queue, suggestions, tool receipts, and selection actions with independent visual language.",
    decision: "defer",
    acceptance: "The new renderer has explicit semantic regions and keyboard actions for queue, suggestions, tool details, and selected text without importing the library.",
  },
  ...cycle10Observations,
];

export const referenceAreas: readonly { id: ReferenceArea; label: string; description: string }[] = [
  { id: "agent", label: "Agent runtime", description: "Sessions, streams, permissions, tools, and durable runs." },
  { id: "ide", label: "IDE contracts", description: "Draft workspaces, review boundaries, and file safety." },
  { id: "browser", label: "Browser harness", description: "Tab leases, document identity, and capture lifecycle." },
  { id: "research", label: "Research", description: "Fan-out, citations, freshness, and retrieval receipts." },
  { id: "workflow", label: "Workflow", description: "State events, planning, checkpoints, and evidence." },
];
