import {
  AlertTriangle,
  Archive,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Clipboard,
  Clock3,
  Code2,
  Database,
  Download,
  ExternalLink,
  File,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  History,
  Image,
  LayoutGrid,
  List,
  PackageOpen,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { useMemo, useState } from "react";

import { ScreenHeader } from "./screen-header";
import { useWorkspaceStore } from "./store";
import type { ArtifactView, AttachmentView } from "./types";
import { LibraryConversationCrudPreview } from "./library-conversation-crud-preview";
import { ArtifactDocumentStudioPreview } from "./artifact-document-studio-preview";

type LibraryCollection = "all" | "attachments" | "artifacts";
type LibraryStatusFilter = "all" | "ready" | "processing" | "attention";
type LibraryViewMode = "grid" | "list";
type LibraryProvenanceFilter = "all" | "conversation" | "project";
type LibrarySort = "updated" | "name" | "size" | "revisions" | "state";
type ArtifactWorkbenchTab = "preview" | "studio" | "diff" | "metadata";
type LibraryExportFormat = "json" | "markdown";

type SavedLibraryView = {
  id: string;
  name: string;
  collection: LibraryCollection;
  status: LibraryStatusFilter;
  provenance: LibraryProvenanceFilter;
  sort: LibrarySort;
  query: string;
  viewMode: LibraryViewMode;
};

interface LibraryAttachment extends AttachmentView {
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  projectName: string | null;
  createdAt: string;
}

type LibraryItem =
  | { key: string; kind: "attachment"; attachment: LibraryAttachment }
  | { key: string; kind: "artifact"; artifact: ArtifactView };

export interface LibraryScreenProps {
  onImportFiles?: () => void;
  onOpenArtifact?: (artifactId: string) => void;
  onExportArtifact?: (artifactId: string) => void;
  onRetryAttachment?: (attachmentId: string) => void;
}

const attachmentStateCopy: Record<AttachmentView["state"], string> = {
  processing: "Processing",
  ready: "Ready",
  warning: "Needs review",
  failed: "Failed",
};

function attachmentIcon(kind: AttachmentView["kind"]) {
  if (kind === "image") return <FileImage size={21} />;
  if (kind === "code") return <FileCode2 size={21} />;
  if (kind === "data") return <FileSpreadsheet size={21} />;
  return <FileText size={21} />;
}

function artifactIcon(type: ArtifactView["type"]) {
  if (type === "Code") return <Code2 size={22} />;
  if (type === "Diagram") return <Image size={22} />;
  if (type === "Data") return <Database size={22} />;
  return <FileText size={22} />;
}

function artifactTone(type: ArtifactView["type"]): string {
  return type.toLowerCase();
}

function artifactPreviewLines(artifact: ArtifactView, revision: number): string[] {
  const revisionLabel = `revision-${revision}`;
  if (artifact.type === "Code") {
    return [
      "{",
      `  \"artifact\": \"${artifact.name}\",`,
      `  \"revision\": ${revision},`,
      `  \"project\": \"${artifact.projectName}\",`,
      `  \"status\": \"renderer-preview\",`,
      `  \"source\": \"${revisionLabel}\"`,
      "}",
    ];
  }
  if (artifact.type === "Data") {
    return [
      "metric,value,revision",
      `artifact_size,${artifact.sizeLabel},${revision}`,
      `version_count,${artifact.versionCount},${revision}`,
      `updated,${artifact.updatedLabel},${revision}`,
      "provenance,native-record-planned,renderer-preview",
    ];
  }
  if (artifact.type === "Diagram") {
    return [
      "flowchart LR",
      `  input[${artifact.name}] --> revision[Revision ${revision}]`,
      "  revision --> preview[Renderer preview]",
      "  preview --> export[Native export planned]",
    ];
  }
  return [
    `# ${artifact.name}`,
    "",
    `> Renderer preview · revision ${revision} · ${artifact.sizeLabel}`,
    "",
    "This workbench keeps artifact identity, revision selection, and provenance visible.",
    "Native bytes, diff computation, and export are connected in a later persistence slice.",
  ];
}

function artifactDiffLines(artifact: ArtifactView, revision: number): string[] {
  if (revision <= 1) {
    return ["No predecessor revision", "", "The first immutable revision has no prior content to compare."];
  }
  return [
    `@@ revision ${revision - 1} → ${revision} @@`,
    `- previous ${artifact.type.toLowerCase()} payload`,
    `+ current ${artifact.type.toLowerCase()} payload`,
    `+ metadata: updated ${artifact.updatedLabel}`,
    "  provenance: producing run receipt not hydrated in preview",
  ];
}

function collectionLabel(collection: LibraryCollection): string {
  if (collection === "attachments") return "Files";
  if (collection === "artifacts") return "Artifacts";
  return "All content";
}

function itemMatchesStatus(item: LibraryItem, status: LibraryStatusFilter): boolean {
  if (status === "all") return true;
  if (item.kind === "artifact") return status === "ready";
  if (status === "ready") return item.attachment.state === "ready";
  if (status === "processing") return item.attachment.state === "processing";
  return item.attachment.state === "warning" || item.attachment.state === "failed";
}

function itemProvenance(item: LibraryItem): "conversation" | "project" {
  return item.kind === "attachment" ? "conversation" : "project";
}

function itemProvenanceLabel(item: LibraryItem): string {
  return item.kind === "attachment" ? "Conversation source" : "Project artifact";
}

function parseSizeLabel(label: string): number {
  const match = label.trim().match(/([0-9]+(?:\.[0-9]+)?)\s*(b|kb|mb|gb|tb)?/i);
  if (!match) return 0;
  const value = Number(match[1]);
  const unit = (match[2] ?? "b").toLowerCase();
  const multiplier = unit === "tb" ? 1_099_511_627_776
    : unit === "gb" ? 1_073_741_824
      : unit === "mb" ? 1_048_576
        : unit === "kb" ? 1_024
          : 1;
  return value * multiplier;
}

function parseRelativeLabel(label: string): number {
  const normalized = label.trim().toLowerCase();
  if (normalized === "just now" || normalized === "now") return Date.now();
  const match = normalized.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/);
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2];
    const seconds = unit === "year" ? 31_536_000
      : unit === "month" ? 2_592_000
        : unit === "week" ? 604_800
          : unit === "day" ? 86_400
            : unit === "hour" ? 3_600
              : unit === "minute" ? 60
                : 1;
    return Date.now() - amount * seconds * 1_000;
  }
  const timestamp = Date.parse(label);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function itemUpdatedValue(item: LibraryItem): number {
  return item.kind === "attachment"
    ? Date.parse(item.attachment.createdAt) || parseRelativeLabel(item.attachment.createdAt)
    : parseRelativeLabel(item.artifact.updatedLabel);
}

function itemSizeValue(item: LibraryItem): number {
  return parseSizeLabel(item.kind === "attachment" ? item.attachment.size : item.artifact.sizeLabel);
}

function itemRevisionValue(item: LibraryItem): number {
  return item.kind === "artifact" ? item.artifact.versionCount : 0;
}

function itemStateValue(item: LibraryItem): number {
  if (item.kind === "artifact") return 4;
  return item.attachment.state === "ready" ? 3
    : item.attachment.state === "processing" ? 2
      : item.attachment.state === "warning" ? 1
        : 0;
}

function compareLibraryItems(left: LibraryItem, right: LibraryItem, sort: LibrarySort): number {
  if (sort === "name") {
    const leftName = left.kind === "attachment" ? left.attachment.name : left.artifact.name;
    const rightName = right.kind === "attachment" ? right.attachment.name : right.artifact.name;
    return leftName.localeCompare(rightName, undefined, { sensitivity: "base" });
  }
  if (sort === "size") return itemSizeValue(right) - itemSizeValue(left);
  if (sort === "revisions") return itemRevisionValue(right) - itemRevisionValue(left);
  if (sort === "state") return itemStateValue(right) - itemStateValue(left);
  return itemUpdatedValue(right) - itemUpdatedValue(left);
}

function exportLibraryRecord(item: LibraryItem) {
  if (item.kind === "attachment") {
    return {
      kind: "attachment",
      id: item.attachment.id,
      name: item.attachment.name,
      contentType: item.attachment.kind,
      size: item.attachment.size,
      state: item.attachment.state,
      provenance: itemProvenanceLabel(item),
      conversation: item.attachment.conversationTitle,
      project: item.attachment.projectName,
      createdAt: item.attachment.createdAt,
    };
  }
  return {
    kind: "artifact",
    id: item.artifact.id,
    name: item.artifact.name,
    contentType: item.artifact.type,
    size: item.artifact.sizeLabel,
    revisionCount: item.artifact.versionCount,
    updated: item.artifact.updatedLabel,
    provenance: itemProvenanceLabel(item),
    project: item.artifact.projectName,
  };
}

function downloadLibraryPreview(payload: string, format: LibraryExportFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], {
    type: format === "json" ? "application/json" : "text/markdown",
  }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-library-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  const revokeObjectUrl = URL.revokeObjectURL;
  if (typeof revokeObjectUrl === "function") {
    window.setTimeout(() => revokeObjectUrl(url), 0);
  }
  return true;
}

function libraryMarkdownPreview({
  collection,
  status,
  provenance,
  query,
  sort,
  items,
}: {
  collection: LibraryCollection;
  status: LibraryStatusFilter;
  provenance: LibraryProvenanceFilter;
  query: string;
  sort: LibrarySort;
  items: LibraryItem[];
}): string {
  const records = items.map(exportLibraryRecord);
  const scope = items.length === 1 ? "selected record" : "library records";
  const recordLines = records.flatMap((record, index) => [
    `### ${index + 1}. ${record.name}`,
    "",
    `- Kind: ${record.kind}`,
    `- Format: ${record.contentType}`,
    `- Size: ${record.size}`,
    `- Provenance: ${record.provenance}`,
    ...(record.kind === "attachment"
      ? [
        `- State: ${record.state}`,
        `- Conversation: ${record.conversation}`,
        `- Project: ${record.project ?? "Not set"}`,
        `- Added: ${record.createdAt}`,
      ]
      : [
        `- Revisions: ${record.revisionCount}`,
        `- Project: ${record.project}`,
        `- Updated: ${record.updated}`,
      ]),
    "",
  ]);

  return [
    "# Omnia library export preview",
    "",
    "> Renderer-local preview only. No file was written; durable native export remains planned.",
    "",
    `- Scope: ${scope}`,
    `- Records: ${records.length}`,
    `- Collection: ${collectionLabel(collection)}`,
    `- State filter: ${status}`,
    `- Provenance filter: ${provenance}`,
    `- Query: ${query || "None"}`,
    `- Sort: ${sort}`,
    "",
    "## Records",
    "",
    ...(recordLines.length > 0 ? recordLines : ["No records matched the current preview.", ""]),
  ].join("\n");
}

function LibraryMetric({
  icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  detail: string;
  tone: "violet" | "blue" | "green" | "amber";
}) {
  return (
    <article className={`library-metric library-metric--${tone}`}>
      <span className="library-metric__icon">{icon}</span>
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
        <em>{detail}</em>
      </span>
    </article>
  );
}

function AttachmentCard({
  attachment,
  selected,
  bulkSelected,
  onSelect,
  onToggleBulk,
}: {
  attachment: LibraryAttachment;
  selected: boolean;
  bulkSelected: boolean;
  onSelect: () => void;
  onToggleBulk: () => void;
}) {
  return (
    <article className={selected ? "library-card library-card--selected" : "library-card"}>
      <button
        type="button"
        className={bulkSelected ? "library-card__bulk-toggle library-card__bulk-toggle--selected" : "library-card__bulk-toggle"}
        aria-pressed={bulkSelected}
        aria-label={`${bulkSelected ? "Remove" : "Select"} ${attachment.name} for bulk actions`}
        onClick={onToggleBulk}
      >
        {bulkSelected ? "✓" : ""}
      </button>
      <button
        type="button"
        className="library-card__select"
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={`Inspect file ${attachment.name}`}
      >
        <span className={`library-card__preview library-card__preview--attachment library-card__preview--${attachment.kind}`}>
          {attachmentIcon(attachment.kind)}
          <small>{attachment.kind}</small>
        </span>
        <span className="library-card__body">
          <span className="library-card__badges">
            <small>File</small>
            <small className={`library-state library-state--${attachment.state}`}>
              {attachment.state === "processing" ? <Clock3 size={10} /> : null}
              {attachment.state === "ready" ? <CheckCircle2 size={10} /> : null}
              {attachment.state === "warning" || attachment.state === "failed" ? <AlertTriangle size={10} /> : null}
              {attachmentStateCopy[attachment.state]}
            </small>
          </span>
          <strong title={attachment.name}>{attachment.name}</strong>
          <span>{attachment.conversationTitle}</span>
          <small>{attachment.projectName ?? "Local history"} · {attachment.size}</small>
        </span>
      </button>
    </article>
  );
}

function ArtifactCard({
  artifact,
  selected,
  bulkSelected,
  onSelect,
  onToggleBulk,
}: {
  artifact: ArtifactView;
  selected: boolean;
  bulkSelected: boolean;
  onSelect: () => void;
  onToggleBulk: () => void;
}) {
  const tone = artifactTone(artifact.type);
  return (
    <article className={selected ? "library-card library-card--selected" : "library-card"}>
      <button
        type="button"
        className={bulkSelected ? "library-card__bulk-toggle library-card__bulk-toggle--selected" : "library-card__bulk-toggle"}
        aria-pressed={bulkSelected}
        aria-label={`${bulkSelected ? "Remove" : "Select"} ${artifact.name} for bulk actions`}
        onClick={onToggleBulk}
      >
        {bulkSelected ? "✓" : ""}
      </button>
      <button
        type="button"
        className="library-card__select"
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={`Inspect artifact ${artifact.name}`}
      >
        <span className={`library-card__preview library-card__preview--artifact library-card__preview--${tone}`}>
          {artifactIcon(artifact.type)}
          <small>{artifact.type}</small>
        </span>
        <span className="library-card__body">
          <span className="library-card__badges">
            <small>Artifact</small>
            <small className="library-state library-state--persisted"><ShieldCheck size={10} /> Persisted</small>
          </span>
          <strong title={artifact.name}>{artifact.name}</strong>
          <span>{artifact.projectName}</span>
          <small>{artifact.updatedLabel} · {artifact.sizeLabel} · {artifact.versionCount} {artifact.versionCount === 1 ? "revision" : "revisions"}</small>
        </span>
      </button>
    </article>
  );
}

function EmptyLibrary({ canImport }: { canImport: boolean }) {
  return (
    <div className="library-empty" role="status">
      <span className="library-empty__illustration">
        <Archive size={30} />
        <File size={17} />
      </span>
      <h2>Your content library is empty</h2>
      <p>
        Files attached to conversations and immutable artifacts saved from model output will appear here with their
        extraction, revision, and source provenance.
      </p>
      {canImport ? <small>Use Import files to add a supported local source.</small> : <small>Add files from the chat composer to begin.</small>}
    </div>
  );
}

function NoLibraryMatches({ onClear }: { onClear: () => void }) {
  return (
    <div className="library-empty library-empty--compact" role="status">
      <Search size={25} />
      <h2>No matching content</h2>
      <p>Try a different name, source, content type, or processing state.</p>
      <button type="button" className="button button--secondary" onClick={onClear}>Clear filters</button>
    </div>
  );
}

function AttachmentDetail({
  attachment,
  onOpenConversation,
  onRetry,
}: {
  attachment: LibraryAttachment;
  onOpenConversation: () => void;
  onRetry?: () => void;
}) {
  const canRetry = attachment.state === "failed" || attachment.state === "warning";
  return (
    <>
      <header className="library-detail__header">
        <span className={`library-detail__icon library-detail__icon--${attachment.kind}`}>{attachmentIcon(attachment.kind)}</span>
        <span>
          <span className="eyebrow">Attached file</span>
          <h2>{attachment.name}</h2>
          <p>{attachment.kind} · {attachment.size}</p>
        </span>
      </header>
      <div className={`library-detail__notice library-detail__notice--${attachment.state}`}>
        {attachment.state === "ready" ? <CheckCircle2 size={16} /> : null}
        {attachment.state === "processing" ? <Clock3 size={16} /> : null}
        {attachment.state === "warning" || attachment.state === "failed" ? <AlertTriangle size={16} /> : null}
        <span>
          <strong>{attachmentStateCopy[attachment.state]}</strong>
          <small>
            {attachment.state === "ready" ? "Extraction completed. Omnia includes this source only when a request explicitly selects it." : null}
            {attachment.state === "processing" ? "The local extraction pipeline is preparing searchable text and stable source spans." : null}
            {attachment.state === "warning" ? "Some content may be unavailable. Review the extraction result before grounding a request." : null}
            {attachment.state === "failed" ? "No extracted text is available. The original file remains preserved for recovery or retry." : null}
          </small>
        </span>
      </div>
      <dl className="library-detail__metadata">
        <div><dt>Conversation</dt><dd>{attachment.conversationTitle}</dd></div>
        <div><dt>Project</dt><dd>{attachment.projectName ?? "No project"}</dd></div>
        <div><dt>Added</dt><dd>{attachment.createdAt}</dd></div>
        <div><dt>Boundary</dt><dd>Local persisted source</dd></div>
      </dl>
      <section className="library-detail__provenance">
        <ShieldCheck size={16} />
        <span>
          <strong>Source provenance retained</strong>
          <small>The file remains linked to the message and conversation where it entered Omnia.</small>
        </span>
      </section>
      <footer className="library-detail__actions">
        <button type="button" className="button button--primary" onClick={onOpenConversation}>
          <ArrowUpRight size={14} /> Open conversation
        </button>
        <button
          type="button"
          className="button button--secondary"
          disabled={!canRetry || !onRetry}
          title={!canRetry ? "This file does not need extraction recovery" : !onRetry ? "Extraction retry is unavailable in this build" : "Retry extraction"}
          onClick={onRetry}
        >
          <RefreshCw size={14} /> Retry extraction
        </button>
      </footer>
    </>
  );
}

function ArtifactDetail({
  artifact,
  onOpen,
  onExport,
}: {
  artifact: ArtifactView;
  onOpen?: () => void;
  onExport?: () => void;
}) {
  return (
    <>
      <header className="library-detail__header">
        <span className={`library-detail__icon library-detail__icon--${artifactTone(artifact.type)}`}>{artifactIcon(artifact.type)}</span>
        <span>
          <span className="eyebrow">Versioned artifact</span>
          <h2>{artifact.name}</h2>
          <p>{artifact.type} · {artifact.sizeLabel}</p>
        </span>
      </header>
      <div className="library-detail__revision">
        <span><History size={16} /></span>
        <span>
          <small>Current immutable revision</small>
          <strong>Revision {artifact.versionCount}</strong>
        </span>
        <small>{artifact.updatedLabel}</small>
      </div>
      <dl className="library-detail__metadata">
        <div><dt>Project</dt><dd>{artifact.projectName}</dd></div>
        <div><dt>Format</dt><dd>{artifact.type}</dd></div>
        <div><dt>Revision history</dt><dd>{artifact.versionCount} {artifact.versionCount === 1 ? "revision" : "revisions"}</dd></div>
        <div><dt>Execution</dt><dd>Never executed in chat</dd></div>
      </dl>
      <section className="library-detail__provenance">
        <ShieldCheck size={16} />
        <span>
          <strong>Run provenance retained</strong>
          <small>Native artifact records preserve the producing run and the content hash of every immutable revision.</small>
        </span>
      </section>
      <footer className="library-detail__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={!onOpen}
          title={onOpen ? "Open artifact preview" : "Artifact preview is unavailable in this build"}
          onClick={onOpen}
        >
          <PackageOpen size={14} /> Open artifact
        </button>
        <button
          type="button"
          className="button button--secondary"
          disabled={!onExport}
          title={onExport ? "Export current revision" : "Artifact export is unavailable in this build"}
          onClick={onExport}
        >
          <Download size={14} /> Export
        </button>
      </footer>
    </>
  );
}

function ArtifactWorkbench({
  artifact,
  onBack,
  onExport,
}: {
  artifact: ArtifactView;
  onBack: () => void;
  onExport?: () => void;
}) {
  const [tab, setTab] = useState<ArtifactWorkbenchTab>("preview");
  const [revision, setRevision] = useState(artifact.versionCount);
  const lines = tab === "diff"
    ? artifactDiffLines(artifact, revision)
    : artifactPreviewLines(artifact, revision);

  return (
    <section className="artifact-workbench" aria-label={`Artifact workbench for ${artifact.name}`}>
      <header className="artifact-workbench__header">
        <button type="button" className="button button--ghost artifact-workbench__back" onClick={onBack}>
          <ArrowUpRight size={14} /> Back to details
        </button>
        <span className={`library-detail__icon library-detail__icon--${artifactTone(artifact.type)}`}>
          {artifactIcon(artifact.type)}
        </span>
        <div>
          <span className="eyebrow">Artifact workbench</span>
          <h2>{artifact.name}</h2>
          <p>{artifact.type} · renderer preview</p>
        </div>
        <span className="artifact-workbench__status"><Sparkles size={12} /> Preview</span>
      </header>

      <div className="artifact-workbench__revisions" role="group" aria-label="Artifact revisions">
        <span>Revision</span>
        {Array.from({ length: artifact.versionCount }, (_, index) => index + 1).map((value) => (
          <button
            key={value}
            type="button"
            className={revision === value ? "active" : ""}
            aria-pressed={revision === value}
            onClick={() => {
              setRevision(value);
              setTab("preview");
            }}
          >
            v{value}
          </button>
        ))}
      </div>

      <div className="artifact-workbench__tabs" role="tablist" aria-label="Artifact views">
        {([
          ["preview", "Preview"],
          ["studio", "Studio"],
          ["diff", "Diff"],
          ["metadata", "Metadata"],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            aria-controls="artifact-workbench-panel"
            tabIndex={tab === value ? 0 : -1}
            className={tab === value ? "active" : ""}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "studio" ? (
        <ArtifactDocumentStudioPreview artifact={artifact} revision={revision} />
      ) : tab === "metadata" ? (
        <dl className="artifact-workbench__metadata" id="artifact-workbench-panel" role="tabpanel" aria-label="Artifact metadata">
          <div><dt>Artifact ID</dt><dd>{artifact.id}</dd></div>
          <div><dt>Project</dt><dd>{artifact.projectName}</dd></div>
          <div><dt>Current revision</dt><dd>v{revision} of {artifact.versionCount}</dd></div>
          <div><dt>Size</dt><dd>{artifact.sizeLabel}</dd></div>
          <div><dt>Updated</dt><dd>{artifact.updatedLabel}</dd></div>
          <div><dt>Native hash</dt><dd>Not hydrated</dd></div>
          <div><dt>Execution</dt><dd>Not executed in chat</dd></div>
          <div><dt>Export</dt><dd>{onExport ? "Available" : "Planned"}</dd></div>
        </dl>
      ) : (
        <div id="artifact-workbench-panel" className={`artifact-workbench__code artifact-workbench__code--${tab}`} role="tabpanel" aria-label={`${tab} content`}>
          {lines.map((line, index) => (
            <div className="artifact-workbench__line" key={`${index}-${line}`}>
              <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
              <code>{line || " "}</code>
            </div>
          ))}
        </div>
      )}

      <div className="artifact-workbench__provenance">
        <ShieldCheck size={14} />
        <span>
          <strong>Lineage stays visible</strong>
          <small>Revision selection is local preview state. Durable bytes, hashes, and producing receipts still come from native storage.</small>
        </span>
      </div>

      <footer className="artifact-workbench__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={!onExport}
          title={onExport ? "Export current revision" : "Native artifact export is planned"}
          onClick={onExport}
        >
          <Download size={14} /> Export revision
        </button>
        <button type="button" className="button button--secondary" disabled title="Open in a new window is planned">
          <ExternalLink size={14} /> Open window
        </button>
      </footer>
    </section>
  );
}

export function LibraryScreen({
  onImportFiles,
  onOpenArtifact,
  onExportArtifact,
  onRetryAttachment,
}: LibraryScreenProps = {}) {
  const conversations = useWorkspaceStore((state) => state.conversations);
  const attachmentCatalog = useWorkspaceStore((state) => state.attachments);
  const artifacts = useWorkspaceStore((state) => state.artifacts);
  const selectConversation = useWorkspaceStore((state) => state.selectConversation);
  const [collection, setCollection] = useState<LibraryCollection>("all");
  const [status, setStatus] = useState<LibraryStatusFilter>("all");
  const [provenance, setProvenance] = useState<LibraryProvenanceFilter>("all");
  const [sortBy, setSortBy] = useState<LibrarySort>("updated");
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<LibraryViewMode>("grid");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [workbenchArtifactId, setWorkbenchArtifactId] = useState<string | null>(null);
  const [exportPreviewOpen, setExportPreviewOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<LibraryExportFormat>("json");
  const [exportStatus, setExportStatus] = useState("Renderer-local preview is ready.");
  const [exportCopied, setExportCopied] = useState(false);
  const [savedViews, setSavedViews] = useState<SavedLibraryView[]>([]);
  const [activeSavedViewId, setActiveSavedViewId] = useState<string | null>(null);
  const [savedViewName, setSavedViewName] = useState("");
  const [savedViewStatus, setSavedViewStatus] = useState("Views stay in this renderer session.");

  const attachments = useMemo(() => {
    const records = new Map<string, LibraryAttachment>();
    const conversationsByMessageId = new Map<
      string,
      { conversationId: string; conversationTitle: string; projectName: string | null; createdAt: string }
    >();
    for (const conversation of conversations) {
      for (const message of conversation.messages) {
        conversationsByMessageId.set(message.id, {
          conversationId: conversation.id,
          conversationTitle: conversation.title,
          projectName: conversation.projectName,
          createdAt: message.createdAt,
        });
        for (const attachment of message.attachments) {
          if (records.has(attachment.id)) continue;
          records.set(attachment.id, {
            ...attachment,
            messageId: message.id,
            conversationId: conversation.id,
            conversationTitle: conversation.title,
            projectName: conversation.projectName,
            createdAt: message.createdAt,
          });
        }
      }
    }

    // The normalized catalog is authoritative for extraction/deletion state.
    // Message projections only supply conversation labels when native records
    // have already been durably bound to a message.
    for (const attachment of attachmentCatalog) {
      if (!attachment.messageId) continue;
      const owner = conversationsByMessageId.get(attachment.messageId);
      if (!owner) continue;
      records.set(attachment.id, {
        ...attachment,
        messageId: attachment.messageId,
        conversationId: owner.conversationId,
        conversationTitle: owner.conversationTitle,
        projectName: owner.projectName,
        createdAt: attachment.createdAt ?? owner.createdAt,
      });
    }
    return [...records.values()];
  }, [attachmentCatalog, conversations]);

  const items = useMemo<LibraryItem[]>(() => [
    ...attachments.map((attachment) => ({
      key: `attachment:${attachment.id}`,
      kind: "attachment" as const,
      attachment,
    })),
    ...artifacts.map((artifact) => ({
      key: `artifact:${artifact.id}`,
      kind: "artifact" as const,
      artifact,
    })),
  ], [artifacts, attachments]);

  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return items.filter((item) => {
      if (collection === "attachments" && item.kind !== "attachment") return false;
      if (collection === "artifacts" && item.kind !== "artifact") return false;
      if (!itemMatchesStatus(item, status)) return false;
      if (provenance !== "all" && itemProvenance(item) !== provenance) return false;
      if (!normalized) return true;
      const haystack = item.kind === "attachment"
        ? `${item.attachment.name} ${item.attachment.kind} ${item.attachment.conversationTitle} ${item.attachment.projectName ?? ""} ${attachmentStateCopy[item.attachment.state]} ${itemProvenanceLabel(item)}`
        : `${item.artifact.name} ${item.artifact.type} ${item.artifact.projectName} ${item.artifact.updatedLabel} ${itemProvenanceLabel(item)}`;
      return haystack.toLowerCase().includes(normalized);
    });
  }, [collection, items, provenance, query, status]);

  const sortedItems = useMemo(
    () => [...filteredItems].sort((left, right) => compareLibraryItems(left, right, sortBy)),
    [filteredItems, sortBy],
  );

  // Keep the selection key stable while refining the gallery, but only render
  // detail/workbench state for records that are still visible. This prevents a
  // hidden artifact or attachment from leaving a stale detail panel beside an
  // empty/no-match gallery. Clearing the refinement restores the same local
  // selection without implying that a filtered-out record was deleted.
  const selectedItem = sortedItems.find((item) => item.key === selectedKey) ?? null;
  const selectedItemExists = selectedKey !== null && items.some((item) => item.key === selectedKey);
  const hiddenSelectedItem = selectedItemExists && selectedItem === null;
  const selectedBulkItems = items.filter((item) => selectedKeys.includes(item.key));
  const workbenchArtifact = selectedItem?.kind === "artifact" && selectedItem.artifact.id === workbenchArtifactId
    ? selectedItem.artifact
    : null;
  const readyCount = attachments.filter((attachment) => attachment.state === "ready").length + artifacts.length;
  const processingCount = attachments.filter((attachment) => attachment.state === "processing").length;
  const attentionCount = attachments.filter((attachment) => attachment.state === "warning" || attachment.state === "failed").length;
  const exportItems = selectedBulkItems.length > 0
    ? selectedBulkItems
    : selectedItem
      ? [selectedItem]
      : sortedItems;

  const exportPreview = useMemo(() => {
    if (exportFormat === "markdown") {
      return libraryMarkdownPreview({
        collection,
        status,
        provenance,
        query,
        sort: sortBy,
        items: exportItems,
      });
    }
    return JSON.stringify({
      format: "omnia.library.preview.v1",
      scope: selectedBulkItems.length > 0 ? "selected-items" : selectedItem ? "selected-item" : "filtered-library",
      generatedAt: "renderer-session preview",
      nativeWrite: "planned",
      filters: {
        collection,
        status,
        provenance,
        query: query || null,
        sort: sortBy,
      },
      recordCount: exportItems.length,
      records: exportItems.map(exportLibraryRecord),
    }, null, 2);
  }, [collection, exportFormat, exportItems, provenance, query, selectedBulkItems.length, selectedItem, sortBy, status]);

  const copyExportPreview = async () => {
    if (!navigator.clipboard?.writeText) {
      setExportCopied(false);
      setExportStatus("Clipboard access is unavailable in this preview.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPreview);
      setExportCopied(true);
      setExportStatus(`Library ${exportFormat.toUpperCase()} preview copied.`);
      window.setTimeout(() => setExportCopied(false), 1600);
    } catch {
      setExportCopied(false);
      setExportStatus("Clipboard access is unavailable in this preview.");
    }
  };

  const downloadExportPreview = () => {
    const exported = downloadLibraryPreview(exportPreview, exportFormat);
    setExportStatus(
      exported
        ? `Started a browser download of the renderer-local ${exportFormat.toUpperCase()} library preview.`
        : "Browser download is unavailable in this preview; no library file was written.",
    );
  };

  const toggleBulkSelection = (key: string) => {
    setSelectedKeys((current) => current.includes(key)
      ? current.filter((candidate) => candidate !== key)
      : [...current, key]);
  };

  const selectVisibleItems = () => {
    setSelectedKeys((current) => [...new Set([...current, ...sortedItems.map((item) => item.key)])]);
  };

  const clearBulkSelection = () => setSelectedKeys([]);

  const markManualSavedView = () => {
    setActiveSavedViewId(null);
  };

  const saveLibraryView = () => {
    const name = savedViewName.trim();
    if (!name) {
      setSavedViewStatus("Enter a name before saving this library view.");
      return;
    }
    const view: SavedLibraryView = {
      id: `library-view-${Date.now()}`,
      name,
      collection,
      status,
      provenance,
      sort: sortBy,
      query,
      viewMode,
    };
    setSavedViews((current) => [
      ...current.filter((item) => item.name.toLowerCase() !== name.toLowerCase()),
      view,
    ]);
    setActiveSavedViewId(view.id);
    setSavedViewName("");
    setSavedViewStatus(`Saved “${name}” in this renderer preview.`);
  };

  const applySavedLibraryView = (viewId: string) => {
    if (viewId === "manual") {
      setActiveSavedViewId(null);
      setSavedViewStatus("Manual current filters are active.");
      return;
    }
    const view = savedViews.find((item) => item.id === viewId);
    if (!view) return;
    setCollection(view.collection);
    setStatus(view.status);
    setProvenance(view.provenance);
    setSortBy(view.sort);
    setQuery(view.query);
    setViewMode(view.viewMode);
    setActiveSavedViewId(view.id);
    setSavedViewStatus(`Applied “${view.name}” in this renderer preview.`);
  };

  const deleteActiveSavedLibraryView = () => {
    if (!activeSavedViewId) return;
    const view = savedViews.find((item) => item.id === activeSavedViewId);
    setSavedViews((current) => current.filter((item) => item.id !== activeSavedViewId));
    setActiveSavedViewId(null);
    setSavedViewStatus(view ? `Deleted “${view.name}” from this renderer session.` : "Deleted the selected renderer-local view.");
  };

  const clearFilters = () => {
    setQuery("");
    setCollection("all");
    setStatus("all");
    setProvenance("all");
    setSortBy("updated");
    setViewMode("grid");
    markManualSavedView();
    setSavedViewStatus("Manual current filters are active.");
  };

  return (
    <div className="screen-scroll library-screen">
      <ScreenHeader
        title="Library"
        action={
          <>
          <button
            type="button"
            className="button button--secondary"
            disabled={items.length === 0}
            title={items.length === 0 ? "There are no library records to preview" : "Preview a redacted library index export"}
            onClick={() => setExportPreviewOpen((open) => !open)}
          >
            <Download size={16} /> {exportPreviewOpen ? "Hide index preview" : "Preview index export"}
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={!onImportFiles}
            title={onImportFiles ? "Import local files" : "Native file import is unavailable in this build"}
            onClick={onImportFiles}
          >
            <Upload size={16} /> Import files
          </button>
          </>
        }
      />

      <section className="library-metrics" aria-label="Library summary">
        <LibraryMetric icon={<FileText size={18} />} label="Attached files" value={attachments.length} detail="Conversation sources" tone="blue" />
        <LibraryMetric icon={<PackageOpen size={18} />} label="Artifacts" value={artifacts.length} detail="Immutable outputs" tone="violet" />
        <LibraryMetric icon={<CheckCircle2 size={18} />} label="Available" value={readyCount} detail={processingCount > 0 ? `${processingCount} processing` : "Ready to inspect"} tone="green" />
        <LibraryMetric icon={<AlertTriangle size={18} />} label="Attention" value={attentionCount} detail={attentionCount > 0 ? "Review required" : "No extraction issues"} tone="amber" />
      </section>

      <LibraryConversationCrudPreview />

      <section className="library-toolbar" aria-label="Library filters">
        <label className="library-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => { setQuery(event.target.value); markManualSavedView(); }}
            placeholder="Search files, artifacts, projects, or conversations"
            aria-label="Search library"
          />
          {query ? <button type="button" onClick={() => setQuery("")} aria-label="Clear library search">×</button> : null}
        </label>
        <div className="library-segments" role="group" aria-label="Content type">
          {(["all", "attachments", "artifacts"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={collection === value ? "active" : ""}
              onClick={() => { setCollection(value); markManualSavedView(); }}
              aria-pressed={collection === value}
            >
              {collectionLabel(value)}
              <small>{value === "all" ? items.length : value === "attachments" ? attachments.length : artifacts.length}</small>
            </button>
          ))}
        </div>
        <select value={status} onChange={(event) => { setStatus(event.target.value as LibraryStatusFilter); markManualSavedView(); }} aria-label="Filter by processing state">
          <option value="all">Every state</option>
          <option value="ready">Available</option>
          <option value="processing">Processing</option>
          <option value="attention">Needs attention</option>
        </select>
        <select value={provenance} onChange={(event) => { setProvenance(event.target.value as LibraryProvenanceFilter); markManualSavedView(); }} aria-label="Filter by provenance">
          <option value="all">Any provenance</option>
          <option value="conversation">Conversation sources</option>
          <option value="project">Project artifacts</option>
        </select>
        <select value={sortBy} onChange={(event) => { setSortBy(event.target.value as LibrarySort); markManualSavedView(); }} aria-label="Sort library">
          <option value="updated">Recently updated</option>
          <option value="name">Name A–Z</option>
          <option value="size">Largest first</option>
          <option value="revisions">Most revisions</option>
          <option value="state">State priority</option>
        </select>
        <div className="view-switcher" role="group" aria-label="Library view">
          <button type="button" className={viewMode === "grid" ? "active" : ""} onClick={() => { setViewMode("grid"); markManualSavedView(); }} aria-label="Grid view" aria-pressed={viewMode === "grid"}><LayoutGrid size={15} /></button>
          <button type="button" className={viewMode === "list" ? "active" : ""} onClick={() => { setViewMode("list"); markManualSavedView(); }} aria-label="List view" aria-pressed={viewMode === "list"}><List size={15} /></button>
        </div>
      </section>

      <section className="library-saved-views" aria-label="Saved library views">
        <div className="library-saved-views__heading">
          <span><Sparkles size={14} /><strong>Saved views</strong></span>
          <small>Renderer-local filters; no durable write</small>
        </div>
        <label className="library-saved-views__select">
          <span className="sr-only">Saved library view</span>
          <select value={activeSavedViewId ?? "manual"} onChange={(event) => applySavedLibraryView(event.target.value)} aria-label="Saved library view">
            <option value="manual">Manual current filters</option>
            {savedViews.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
          </select>
        </label>
        <div className="library-saved-views__actions">
          <input value={savedViewName} onChange={(event) => setSavedViewName(event.target.value)} placeholder="Name this view" aria-label="New saved library view name" />
          <button type="button" className="button button--ghost" onClick={saveLibraryView}><Check size={13} /> Save view</button>
          <button type="button" className="button button--ghost" onClick={deleteActiveSavedLibraryView} disabled={!activeSavedViewId} aria-label="Delete saved library view" title="Delete selected saved view"><Trash2 size={13} /></button>
        </div>
        <span className="library-saved-views__status" role="status" aria-live="polite">{savedViewStatus}</span>
      </section>

      {selectedKeys.length > 0 ? (
        <section className="library-bulk-bar" aria-label="Bulk library actions">
          <span className="library-bulk-bar__count">
            <strong>{selectedKeys.length}</strong> selected
          </span>
          <span className="library-bulk-bar__scope">Selection is renderer-local until a native export is connected.</span>
          <div className="library-bulk-bar__actions">
            <button type="button" className="button button--ghost" onClick={selectVisibleItems} disabled={sortedItems.length === 0}>
              Select visible
            </button>
            <button type="button" className="button button--secondary" onClick={() => setExportPreviewOpen(true)}>
              <Download size={13} /> Preview selected export
            </button>
            <button type="button" className="button button--ghost" onClick={clearBulkSelection}>
              Clear selection
            </button>
          </div>
        </section>
      ) : null}

      {exportPreviewOpen ? (
        <section className="library-export-preview" aria-label="Library export preview">
          <header className="library-export-preview__header">
            <div>
              <span className="eyebrow">Renderer-local preview</span>
              <h2>Library index export</h2>
              <p>{exportItems.length} {selectedItem ? "selected" : "visible"} {exportItems.length === 1 ? "record" : "records"} · no file was written</p>
            </div>
            <div className="library-export-preview__toolbar" role="toolbar" aria-label="Library export preview actions">
              <label>
                <span className="sr-only">Library export format</span>
                <select
                  value={exportFormat}
                  onChange={(event) => {
                    setExportFormat(event.target.value as LibraryExportFormat);
                    setExportCopied(false);
                    setExportStatus("Renderer-local preview is ready.");
                  }}
                  aria-label="Library export format"
                >
                  <option value="json">JSON</option>
                  <option value="markdown">Markdown</option>
                </select>
              </label>
              <button type="button" className="button button--secondary" onClick={() => void copyExportPreview()}>
                {exportCopied ? <Check size={14} /> : <Clipboard size={14} />} {exportCopied ? "Copied" : "Copy"}
              </button>
              <button type="button" className="button button--ghost" onClick={downloadExportPreview}>
                <Download size={14} /> Download
              </button>
              <button type="button" className="button button--ghost" onClick={() => setExportPreviewOpen(false)} aria-label="Close library export preview">×</button>
            </div>
          </header>
          <pre>{exportPreview}</pre>
          <footer>
            <ShieldCheck size={14} />
            <span>
              <span>Names, state, provenance, and revision metadata are shown for UI review. Durable export, full filesystem scanning, and native index receipts remain planned.</span>
              <span className="library-export-preview__status" role="status" aria-live="polite">{exportStatus}</span>
            </span>
          </footer>
        </section>
      ) : null}

      <div className={selectedItem ? "library-layout library-layout--detail" : "library-layout"}>
        <section className="library-collection" aria-labelledby="library-collection-heading">
          <header className="library-collection__header">
            <span>
              <h2 id="library-collection-heading">{collectionLabel(collection)}</h2>
            <p aria-live="polite">
              {filteredItems.length} {filteredItems.length === 1 ? "item" : "items"}
              {filteredItems.length !== items.length ? ` of ${items.length} total` : ""}
              {query ? ` matching “${query}”` : ""}
            </p>
          </span>
            <span className="library-collection__header-meta">
              {hiddenSelectedItem ? <small role="status">Selected record hidden by current filters; clear filters to restore its details.</small> : null}
              <small><ShieldCheck size={12} /> Content-addressed local records</small>
            </span>
          </header>
          {items.length === 0 ? <EmptyLibrary canImport={Boolean(onImportFiles)} /> : null}
          {items.length > 0 && filteredItems.length === 0 ? <NoLibraryMatches onClear={clearFilters} /> : null}
          {filteredItems.length > 0 ? (
            <div className={viewMode === "grid" ? "library-grid" : "library-grid library-grid--list"}>
              {sortedItems.map((item) => item.kind === "attachment" ? (
                <AttachmentCard
                  key={item.key}
                  attachment={item.attachment}
                  selected={item.key === selectedKey}
                  bulkSelected={selectedKeys.includes(item.key)}
                  onSelect={() => setSelectedKey(item.key)}
                  onToggleBulk={() => toggleBulkSelection(item.key)}
                />
              ) : (
                <ArtifactCard
                  key={item.key}
                  artifact={item.artifact}
                  selected={item.key === selectedKey}
                  bulkSelected={selectedKeys.includes(item.key)}
                  onSelect={() => setSelectedKey(item.key)}
                  onToggleBulk={() => toggleBulkSelection(item.key)}
                />
              ))}
            </div>
          ) : null}
        </section>

        {selectedItem ? (
          <aside className="library-detail" aria-label="Selected library item">
            <button
              type="button"
              className="library-detail__close"
              onClick={() => {
                setSelectedKey(null);
                setWorkbenchArtifactId(null);
              }}
              aria-label="Close library details"
            >×</button>
            {selectedItem.kind === "attachment" ? (
              <AttachmentDetail
                attachment={selectedItem.attachment}
                onOpenConversation={() => selectConversation(selectedItem.attachment.conversationId)}
                {...(onRetryAttachment ? { onRetry: () => onRetryAttachment(selectedItem.attachment.id) } : {})}
              />
            ) : workbenchArtifact ? (
              <ArtifactWorkbench
                artifact={workbenchArtifact}
                onBack={() => setWorkbenchArtifactId(null)}
                {...(onExportArtifact ? { onExport: () => onExportArtifact(workbenchArtifact.id) } : {})}
              />
            ) : (
              <ArtifactDetail
                artifact={selectedItem.artifact}
                onOpen={() => {
                  setWorkbenchArtifactId(selectedItem.artifact.id);
                  onOpenArtifact?.(selectedItem.artifact.id);
                }}
                {...(onExportArtifact ? { onExport: () => onExportArtifact(selectedItem.artifact.id) } : {})}
              />
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
