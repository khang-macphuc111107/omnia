import {
  Archive,
  Bookmark,
  Check,
  Clipboard,
  Copy,
  Download,
  FileJson2,
  Filter,
  Folder,
  FolderPlus,
  History,
  Plus,
  RotateCcw,
  Save,
  Search,
  Star,
  Tag,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  appendPromptTemplateVersion,
  comparePromptTemplateVersion,
  parsePromptTemplateBundle,
  resolvePromptTemplate,
  serializePromptTemplate,
  validatePromptTemplate,
  type PromptTemplate,
  type PromptTemplateExample,
  type PromptVariable,
  type PromptVariableValue,
  type PromptTemplateVersion,
} from "./prompt-template-contract";

type TemplateFilter = "all" | "active" | "archived";
type ExportFormat = "json" | "markdown";
type TemplateSort = "updated" | "name" | "version" | "relevance";
type FolderFilter = "all" | "unfiled" | string;

interface PromptLibrarySavedView {
  id: string;
  name: string;
  query: string;
  filter: TemplateFilter;
  tagFilter: string;
  folderFilter: FolderFilter;
  sort: TemplateSort;
  favoritesOnly: boolean;
}

export interface PromptLibraryPreviewProps {
  initialTemplates?: PromptTemplate[];
}

const SEEDED_DATE = "2026-09-20T00:00:00.000Z";

function makeVersion(template: Pick<PromptTemplate, "version" | "body" | "variables">, changeNote: string) {
  return {
    version: template.version,
    createdAt: SEEDED_DATE,
    changeNote,
    body: template.body,
    variableIds: template.variables.map((variable) => variable.id),
  };
}

const seededTemplateDefinitions: PromptTemplate[] = [
  {
    id: "prompt-template-meeting-brief",
    name: "Meeting brief",
    description: "Turn a meeting topic into an agenda, decisions, and follow-up checklist.",
    tags: ["planning", "team", "structured"],
    body: "Create a concise meeting brief for {{topic}}.\nAudience: {{audience}}\nDate: {{date}}\nInclude action items: {{includeActions}}.\n\nUse clear headings for context, decisions, risks, and next steps.",
    variables: [
      { id: "topic", name: "topic", label: "Meeting topic", type: "short-text", required: true, validation: { maxLength: 140 } },
      {
        id: "audience",
        name: "audience",
        label: "Audience",
        type: "choice",
        required: true,
        defaultValue: "team",
        options: [
          { label: "Team", value: "team" },
          { label: "Leadership", value: "leadership" },
          { label: "Customer", value: "customer" },
        ],
      },
      { id: "date", name: "date", label: "Meeting date", type: "date", required: true, defaultValue: "2026-09-20" },
      { id: "include-actions", name: "includeActions", label: "Include action items", type: "boolean", required: true, defaultValue: true },
    ],
    examples: [
      { id: "meeting-example-1", label: "Quarterly planning", values: { topic: "Q4 launch readiness", audience: "leadership", date: "2026-09-20", includeActions: true }, note: "A leadership-ready version with explicit next steps." },
    ],
    version: "1.2.0",
    versions: [],
    archived: false,
    createdAt: SEEDED_DATE,
    updatedAt: SEEDED_DATE,
  },
  {
    id: "prompt-template-code-review",
    name: "Evidence-first code review",
    description: "Review a code excerpt with explicit findings, confidence, and unresolved questions.",
    tags: ["engineering", "review", "evidence"],
    body: "Review the following {{language}} code for {{focus}}.\n\nCode:\n{{code}}\n\nVisible context: {{context}}\n\nReturn findings ordered by severity, cite exact evidence, and separate confirmed issues from questions.",
    variables: [
      { id: "language", name: "language", label: "Language", type: "choice", required: true, defaultValue: "typescript", options: [{ label: "TypeScript", value: "typescript" }, { label: "Python", value: "python" }, { label: "Rust", value: "rust" }] },
      { id: "focus", name: "focus", label: "Review focus", type: "choice", required: true, defaultValue: "correctness", options: [{ label: "Correctness", value: "correctness" }, { label: "Security", value: "security" }, { label: "Accessibility", value: "accessibility" }] },
      { id: "code", name: "code", label: "Code excerpt", type: "long-text", required: true, validation: { minLength: 1, maxLength: 10000 } },
      { id: "context", name: "context", label: "Visible context reference", type: "context-ref", required: false, defaultValue: "current-file-preview" },
    ],
    examples: [
      { id: "review-example-1", label: "TypeScript accessibility pass", values: { language: "typescript", focus: "accessibility", code: "<button onClick={save}>Save</button>", context: "component-preview" }, note: "Keeps findings tied to the visible excerpt." },
    ],
    version: "2.0.1",
    versions: [],
    archived: false,
    createdAt: SEEDED_DATE,
    updatedAt: SEEDED_DATE,
  },
  {
    id: "prompt-template-research-synthesis",
    name: "Research synthesis",
    description: "Draft a careful synthesis while preserving source scope and uncertainty.",
    tags: ["research", "sources", "academic"],
    body: "Synthesize the research question below using only the visible source scope.\n\nQuestion: {{question}}\nSource scope: {{sourceScope}}\nTone: {{tone}}\n\nSeparate evidence, interpretation, limitations, and follow-up questions. Do not imply retrieval or verification that is not present.",
    variables: [
      { id: "question", name: "question", label: "Research question", type: "long-text", required: true, validation: { minLength: 8, maxLength: 1200 } },
      { id: "source-scope", name: "sourceScope", label: "Visible source scope", type: "context-ref", required: true, defaultValue: "notebook-visible-sources" },
      { id: "tone", name: "tone", label: "Synthesis tone", type: "choice", required: true, defaultValue: "evidence-first", options: [{ label: "Evidence first", value: "evidence-first" }, { label: "Executive", value: "executive" }, { label: "Teaching", value: "teaching" }] },
    ],
    examples: [
      { id: "research-example-1", label: "Evidence map", values: { question: "What evidence supports this design decision?", sourceScope: "notebook-visible-sources", tone: "evidence-first" }, note: "Keeps source limits visible in the draft." },
    ],
    version: "0.9.0",
    versions: [],
    archived: false,
    createdAt: SEEDED_DATE,
    updatedAt: SEEDED_DATE,
  },
];

const seededTemplates: PromptTemplate[] = seededTemplateDefinitions.map((template) => ({ ...template, versions: [makeVersion(template, "Seeded preview baseline")] }));

const SEEDED_FOLDERS = ["Planning", "Engineering", "Research"] as const;

function inferSeededFolder(template: PromptTemplate): string {
  if (template.tags.includes("engineering")) return "Engineering";
  if (template.tags.includes("research")) return "Research";
  if (template.tags.includes("planning")) return "Planning";
  return "";
}

function valuesForTemplate(template: PromptTemplate): Record<string, PromptVariableValue> {
  return Object.fromEntries(template.variables.flatMap((variable) => variable.defaultValue === undefined ? [] : [[variable.name, variable.defaultValue]]));
}

function markdownForTemplate(template: PromptTemplate): string {
  const variableRows = template.variables.map((variable) => `- **${variable.label}** (\`${variable.name}\`, ${variable.type})${variable.required ? " — required" : " — optional"}`).join("\n");
  const versionRows = template.versions.map((version) => `- ${version.version} — ${version.changeNote} (${version.createdAt})`).join("\n");
  return `# ${template.name}\n\n${template.description}\n\n## Variables\n${variableRows}\n\n## Prompt body\n\n${template.body}\n\n## Version history\n${versionRows}\n\n> Preview only · Renderer-local · No provider request · No durable write · No native version receipt\n`;
}

function cloneTemplate(template: PromptTemplate, suffix: string): PromptTemplate {
  const now = new Date().toISOString();
  return {
    ...template,
    id: `${template.id}-copy-${suffix}`,
    name: `${template.name} copy`,
    versions: template.versions.map((version) => ({ ...version, variableIds: [...version.variableIds] })),
    tags: [...template.tags],
    variables: template.variables.map((variable) => {
      const cloned: PromptVariable = { ...variable };
      if (variable.options) cloned.options = variable.options.map((option) => ({ ...option }));
      if (variable.validation) cloned.validation = { ...variable.validation };
      return cloned;
    }),
    examples: template.examples.map((example) => ({ ...example, values: { ...example.values } })),
    createdAt: now,
    updatedAt: now,
  };
}

function describeVariable(variable: PromptVariable): string {
  if (variable.type === "choice") return `${variable.type} · ${variable.options?.length ?? 0} choices`;
  return variable.type;
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split(".").map((part) => Number(part) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

export default function PromptLibraryPreview({ initialTemplates = seededTemplates }: PromptLibraryPreviewProps) {
  const [templates, setTemplates] = useState<PromptTemplate[]>(() => initialTemplates.map((template) => ({ ...template, tags: [...template.tags], variables: [...template.variables], examples: [...template.examples], versions: [...template.versions] })));
  const [selectedId, setSelectedId] = useState(initialTemplates[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TemplateFilter>("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [folderFilter, setFolderFilter] = useState<FolderFilter>("all");
  const [sort, setSort] = useState<TemplateSort>("updated");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(() => new Set());
  const [folders, setFolders] = useState<string[]>(() => [...SEEDED_FOLDERS]);
  const [folderByTemplate, setFolderByTemplate] = useState<Record<string, string>>(() => Object.fromEntries(initialTemplates.map((template) => [template.id, inferSeededFolder(template)])));
  const [showOrganization, setShowOrganization] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [folderDrafts, setFolderDrafts] = useState<Record<string, string>>({});
  const [organizationStatus, setOrganizationStatus] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [savedViews, setSavedViews] = useState<PromptLibrarySavedView[]>([]);
  const [activeSavedViewId, setActiveSavedViewId] = useState("");
  const [savedViewName, setSavedViewName] = useState("");
  const [savedViewStatus, setSavedViewStatus] = useState("");
  const [values, setValues] = useState<Record<string, PromptVariableValue>>(() => (initialTemplates[0] ? valuesForTemplate(initialTemplates[0]) : {}));
  const [exportFormat, setExportFormat] = useState<ExportFormat>("json");
  const [showExport, setShowExport] = useState(false);
  const [status, setStatus] = useState("");
  const [importError, setImportError] = useState("");
  const [inspectedVersionKey, setInspectedVersionKey] = useState("");
  const [rollbackPreview, setRollbackPreview] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedTemplate = templates.find((template) => template.id === selectedId) ?? templates[0];
  const tags = useMemo(() => Array.from(new Set(templates.flatMap((template) => template.tags))).sort(), [templates]);
  const templateFolder = (templateId: string) => folderByTemplate[templateId] ?? "";
  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const template of templates) {
      const folder = templateFolder(template.id) || "unfiled";
      counts.set(folder, (counts.get(folder) ?? 0) + 1);
    }
    return counts;
  }, [folderByTemplate, templates]);
  const visibleTemplates = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = templates.filter((template) => {
      const matchesQuery = !normalizedQuery || [template.name, template.description, ...template.tags].join(" ").toLowerCase().includes(normalizedQuery);
      const matchesFilter = filter === "all" || (filter === "archived" ? template.archived : !template.archived);
      const matchesTag = tagFilter === "all" || template.tags.includes(tagFilter);
      const folder = folderByTemplate[template.id] ?? "";
      const matchesFolder = folderFilter === "all" || (folderFilter === "unfiled" ? !folder : folder === folderFilter);
      const matchesFavorite = !favoritesOnly || favoriteIds.has(template.id);
      return matchesQuery && matchesFilter && matchesTag && matchesFolder && matchesFavorite;
    });
    return filtered.slice().sort((left, right) => {
      if (sort === "name") return left.name.localeCompare(right.name);
      if (sort === "version") return compareVersions(right.version, left.version);
      if (sort === "relevance" && normalizedQuery) {
        const score = (template: PromptTemplate) => {
          const name = template.name.toLowerCase();
          const description = template.description.toLowerCase();
          if (name === normalizedQuery) return 0;
          if (name.startsWith(normalizedQuery)) return 1;
          if (name.includes(normalizedQuery)) return 2;
          if (description.includes(normalizedQuery)) return 3;
          return 4;
        };
        return score(left) - score(right) || left.name.localeCompare(right.name);
      }
      return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime() || left.name.localeCompare(right.name);
    });
  }, [favoriteIds, favoritesOnly, filter, folderByTemplate, folderFilter, query, sort, tagFilter, templates]);
  const templateIssues = selectedTemplate ? validatePromptTemplate(selectedTemplate) : [];
  const resolution = selectedTemplate ? resolvePromptTemplate(selectedTemplate, values) : undefined;
  const exportPayload = selectedTemplate ? exportFormat === "json" ? serializePromptTemplate(selectedTemplate) : markdownForTemplate(selectedTemplate) : "";
  const versionKey = (version: PromptTemplateVersion) => `${version.version}:${version.createdAt}`;
  const inspectedVersion = selectedTemplate?.versions.find((version) => versionKey(version) === inspectedVersionKey) ?? selectedTemplate?.versions.at(-1);
  const versionDiff = selectedTemplate && inspectedVersion ? comparePromptTemplateVersion(selectedTemplate, inspectedVersion) : undefined;

  useEffect(() => {
    if (!selectedTemplate) return;
    setValues(valuesForTemplate(selectedTemplate));
    setInspectedVersionKey(versionKey(selectedTemplate.versions.at(-1)!));
    setRollbackPreview("");
  }, [selectedId]);

  const selectTemplate = (template: PromptTemplate) => {
    setSelectedId(template.id);
    setStatus(`Selected ${template.name} ${template.version}.`);
    setImportError("");
  };

  const currentSavedView = (): Omit<PromptLibrarySavedView, "id" | "name"> => ({ query, filter, tagFilter, folderFilter, sort, favoritesOnly });

  const saveView = () => {
    const name = savedViewName.trim();
    if (!name) {
      setSavedViewStatus("Enter a name before saving this renderer-local view.");
      return;
    }
    if (savedViews.length >= 16) {
      setSavedViewStatus("This session already has 16 saved prompt views. Delete one to make room.");
      return;
    }
    if (savedViews.some((view) => view.name.toLowerCase() === name.toLowerCase())) {
      setSavedViewStatus("A saved prompt view with that name already exists.");
      return;
    }
    const view: PromptLibrarySavedView = { id: `prompt-view-${Date.now()}`, name, ...currentSavedView() };
    setSavedViews((current) => [...current, view]);
    setActiveSavedViewId(view.id);
    setSavedViewName("");
    setSavedViewStatus(`Saved ${name} for this renderer session.`);
  };

  const applySavedView = (id: string) => {
    if (id === "") {
      setActiveSavedViewId("");
      setSavedViewStatus("Manual template filters are active.");
      return;
    }
    const view = savedViews.find((item) => item.id === id);
    if (!view) return;
    setQuery(view.query);
    setFilter(view.filter);
    setTagFilter(view.tagFilter);
    setFolderFilter(view.folderFilter);
    setSort(view.sort);
    setFavoritesOnly(view.favoritesOnly);
    setActiveSavedViewId(view.id);
    setSavedViewStatus(`Applied ${view.name} in this renderer preview.`);
  };

  const updateSavedView = () => {
    if (!activeSavedViewId) return;
    setSavedViews((current) => current.map((view) => view.id === activeSavedViewId ? { ...view, ...currentSavedView() } : view));
    const view = savedViews.find((item) => item.id === activeSavedViewId);
    setSavedViewStatus(view ? `Updated ${view.name} for this renderer session.` : "Saved prompt view updated.");
  };

  const deleteSavedView = () => {
    if (!activeSavedViewId) return;
    const view = savedViews.find((item) => item.id === activeSavedViewId);
    setSavedViews((current) => current.filter((item) => item.id !== activeSavedViewId));
    setActiveSavedViewId("");
    setSavedViewStatus(view ? `Deleted ${view.name} from this renderer session.` : "Saved prompt view deleted.");
  };

  const toggleFavorite = (templateId: string) => {
    setFavoriteIds((current) => {
      const next = new Set(current);
      if (next.has(templateId)) next.delete(templateId); else next.add(templateId);
      return next;
    });
    const template = templates.find((item) => item.id === templateId);
    setStatus(`${template?.name ?? "Template"} favorite updated in this preview.`);
  };

  const createFolder = () => {
    const name = newFolderName.trim();
    if (!name) {
      setOrganizationStatus("Enter a folder name before creating it.");
      return;
    }
    if (folders.length >= 24) {
      setOrganizationStatus("This session already has 24 prompt folders. Delete one to make room.");
      return;
    }
    if (folders.some((folder) => folder.toLowerCase() === name.toLowerCase())) {
      setOrganizationStatus(`A folder named ${name} already exists.`);
      return;
    }
    setFolders((current) => [...current, name]);
    setFolderFilter(name);
    setNewFolderName("");
    setOrganizationStatus(`Created ${name} for this renderer session.`);
  };

  const assignFolder = (templateId: string, folder: string) => {
    setFolderByTemplate((current) => {
      const next = { ...current };
      if (folder === "") delete next[templateId];
      else next[templateId] = folder;
      return next;
    });
    const template = templates.find((item) => item.id === templateId);
    setOrganizationStatus(`${template?.name ?? "Template"} moved to ${folder || "Unfiled"} in this preview.`);
  };

  const renameFolder = (folder: string) => {
    const nextName = (folderDrafts[folder] ?? folder).trim();
    if (!nextName) {
      setOrganizationStatus("Folder names cannot be empty.");
      return;
    }
    if (nextName.toLowerCase() !== folder.toLowerCase() && folders.some((item) => item.toLowerCase() === nextName.toLowerCase())) {
      setOrganizationStatus(`A folder named ${nextName} already exists.`);
      return;
    }
    setFolders((current) => current.map((item) => item === folder ? nextName : item));
    setFolderByTemplate((current) => Object.fromEntries(Object.entries(current).map(([templateId, value]) => [templateId, value === folder ? nextName : value])));
    if (folderFilter === folder) setFolderFilter(nextName);
    setFolderDrafts((current) => {
      const next = { ...current };
      delete next[folder];
      return next;
    });
    setOrganizationStatus(`Renamed ${folder} to ${nextName} in this preview.`);
  };

  const deleteFolder = (folder: string) => {
    setFolders((current) => current.filter((item) => item !== folder));
    setFolderByTemplate((current) => Object.fromEntries(Object.entries(current).filter(([, value]) => value !== folder)));
    if (folderFilter === folder) setFolderFilter("all");
    setOrganizationStatus(`Deleted ${folder}; assigned templates are now Unfiled in this preview.`);
  };

  const addTagToSelected = () => {
    if (!selectedTemplate) return;
    const tag = tagDraft.trim().toLowerCase().replace(/\s+/g, "-");
    if (!tag) {
      setOrganizationStatus("Enter a tag before adding it.");
      return;
    }
    if (selectedTemplate.tags.some((item) => item.toLowerCase() === tag)) {
      setOrganizationStatus(`${selectedTemplate.name} already has the ${tag} tag.`);
      return;
    }
    setTemplates((current) => current.map((template) => template.id === selectedTemplate.id ? { ...template, tags: [...template.tags, tag], updatedAt: new Date().toISOString() } : template));
    setTagDraft("");
    setOrganizationStatus(`Added #${tag} to ${selectedTemplate.name} in this preview.`);
  };

  const removeTagFromSelected = (tag: string) => {
    if (!selectedTemplate) return;
    setTemplates((current) => current.map((template) => template.id === selectedTemplate.id ? { ...template, tags: template.tags.filter((item) => item !== tag), updatedAt: new Date().toISOString() } : template));
    if (tagFilter === tag) setTagFilter("all");
    setOrganizationStatus(`Removed #${tag} from ${selectedTemplate.name} in this preview.`);
  };

  const updateValue = (variable: PromptVariable, raw: string | boolean) => {
    const value = variable.type === "number" ? (raw === "" ? "" : Number(raw)) : raw;
    setValues((current) => ({ ...current, [variable.name]: value as PromptVariableValue }));
    setStatus(`${variable.label} updated in this preview.`);
  };

  const applyExample = (example: PromptTemplateExample) => {
    setValues({ ...valuesForTemplate(selectedTemplate!), ...example.values });
    setStatus(`Loaded example ${example.label}.`);
  };

  const createTemplate = () => {
    const now = new Date().toISOString();
    const template: PromptTemplate = {
      id: `prompt-template-draft-${Date.now()}`,
      name: "Untitled prompt template",
      description: "A renderer-local prompt template draft.",
      tags: ["draft"],
      body: "Write a response about {{subject}} for {{audience}}.",
      variables: [
        { id: "subject", name: "subject", label: "Subject", type: "short-text", required: true },
        { id: "audience", name: "audience", label: "Audience", type: "short-text", required: true, defaultValue: "the reader" },
      ],
      examples: [{ id: "draft-example", label: "Starter example", values: { subject: "the task", audience: "the reader" } }],
      version: "0.1.0",
      versions: [],
      archived: false,
      createdAt: now,
      updatedAt: now,
    };
    template.versions = [makeVersion(template, "Created in renderer preview")];
    setTemplates((current) => [template, ...current]);
    setSelectedId(template.id);
    setValues(valuesForTemplate(template));
    setStatus("Created a renderer-local prompt template draft.");
  };

  const cloneSelected = () => {
    if (!selectedTemplate) return;
    const copy = cloneTemplate(selectedTemplate, String(Date.now()));
    setTemplates((current) => [copy, ...current]);
    setSelectedId(copy.id);
    setValues(valuesForTemplate(copy));
    setStatus(`Cloned ${selectedTemplate.name} as a renderer-local copy.`);
  };

  const toggleArchive = () => {
    if (!selectedTemplate) return;
    setTemplates((current) => current.map((template) => template.id === selectedTemplate.id ? { ...template, archived: !template.archived, updatedAt: new Date().toISOString() } : template));
    setStatus(`${selectedTemplate.archived ? "Restored" : "Archived"} ${selectedTemplate.name} in this preview.`);
  };

  const bumpVersion = () => {
    if (!selectedTemplate) return;
    const next = appendPromptTemplateVersion(selectedTemplate, "Captured current prompt body in preview", "patch");
    setTemplates((current) => current.map((template) => template.id === next.id ? next : template));
    setInspectedVersionKey(versionKey(next.versions.at(-1)!));
    setRollbackPreview("");
    setStatus(`Created preview version ${next.version}. No native version receipt was created.`);
  };

  const inspectVersion = (version: PromptTemplateVersion) => {
    setInspectedVersionKey(versionKey(version));
    setRollbackPreview("");
    setStatus(`Inspecting preview version ${version.version}. No durable revision was loaded.`);
  };

  const previewRollback = () => {
    if (!inspectedVersion || !selectedTemplate) return;
    setRollbackPreview(`Rollback to v${inspectedVersion.version} is staged as a renderer preview only. The current template remains v${selectedTemplate.version}.`);
    setStatus(`Prepared a rollback preview for v${inspectedVersion.version}; no template was changed.`);
  };

  const copyExport = async () => {
    if (!exportPayload) return;
    if (!navigator.clipboard) {
      setStatus("Clipboard is unavailable; no export was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setStatus(`${exportFormat.toUpperCase()} export copied from this renderer preview.`);
    } catch {
      setStatus("Clipboard write failed; no export was copied.");
    }
  };

  const downloadExport = () => {
    if (!exportPayload) return;
    const blob = new Blob([exportPayload], { type: exportFormat === "json" ? "application/json" : "text/markdown" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${selectedTemplate?.id ?? "prompt-template"}.${exportFormat === "json" ? "json" : "md"}`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus(`Started a browser download for the ${exportFormat.toUpperCase()} preview.`);
  };

  const importBundle = async (file: File) => {
    setImportError("");
    try {
      const template = parsePromptTemplateBundle(await file.text());
      setTemplates((current) => [template, ...current.filter((item) => item.id !== template.id)]);
      setSelectedId(template.id);
      setValues(valuesForTemplate(template));
      setStatus(`Imported ${template.name} into this renderer session.`);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Prompt template import failed.");
    }
  };

  return (
    <section className="prompt-library-preview" aria-labelledby="prompt-library-title">
      <div className="prompt-library-preview__header">
        <div>
          <div className="prompt-library-preview__eyebrow"><WandSparkles size={15} aria-hidden="true" /> Prompt library</div>
          <h2 id="prompt-library-title">Reusable prompt templates</h2>
          <p>Typed variables, examples, resolved previews, and version history in one local workbench.</p>
        </div>
        <div className="prompt-library-preview__actions">
          <button type="button" className="button button--primary" onClick={createTemplate}><Plus size={15} aria-hidden="true" /> New template</button>
          <button type="button" className="button" onClick={cloneSelected} disabled={!selectedTemplate}><Copy size={15} aria-hidden="true" /> Clone</button>
          <button type="button" className="button" onClick={toggleArchive} disabled={!selectedTemplate}><Archive size={15} aria-hidden="true" /> {selectedTemplate?.archived ? "Restore" : "Archive"}</button>
          <button type="button" className="button" onClick={() => fileInputRef.current?.click()}><FileJson2 size={15} aria-hidden="true" /> Import JSON</button>
          <input ref={fileInputRef} type="file" accept=".json,application/json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importBundle(file); event.target.value = ""; }} />
        </div>
      </div>

      <div className="prompt-library-preview__boundary" role="note">
        <strong>Preview only · Renderer-local</strong>
        <span>No provider request · No durable write · No native version receipt</span>
      </div>

      <div className="prompt-library-preview__toolbar">
        <label className="prompt-library-preview__search"><Search size={15} aria-hidden="true" /><span className="sr-only">Search prompt templates</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, description, or tag" /></label>
        <label><Filter size={15} aria-hidden="true" /><span className="sr-only">Filter template status</span><select value={filter} onChange={(event) => setFilter(event.target.value as TemplateFilter)}><option value="all">All templates</option><option value="active">Active</option><option value="archived">Archived</option></select></label>
        <label><Tag size={15} aria-hidden="true" /><span className="sr-only">Filter template tag</span><select value={tagFilter} onChange={(event) => { setTagFilter(event.target.value); setActiveSavedViewId(""); }}><option value="all">All tags</option>{tags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}</select></label>
        <label><Folder size={15} aria-hidden="true" /><span className="sr-only">Filter template folder</span><select value={folderFilter} onChange={(event) => { setFolderFilter(event.target.value); setActiveSavedViewId(""); }}><option value="all">All folders</option><option value="unfiled">Unfiled</option>{folders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}</select></label>
        <label><span className="sr-only">Sort templates</span><select aria-label="Sort templates" value={sort} onChange={(event) => { setSort(event.target.value as TemplateSort); setActiveSavedViewId(""); }}><option value="updated">Recently updated</option><option value="relevance">Relevance</option><option value="name">Name A–Z</option><option value="version">Version</option></select></label>
        <label className="prompt-library-preview__favorite-filter"><input type="checkbox" checked={favoritesOnly} onChange={(event) => { setFavoritesOnly(event.target.checked); setActiveSavedViewId(""); }} aria-label="Show favorite templates only" /><Star size={14} fill={favoritesOnly ? "currentColor" : "none"} aria-hidden="true" /><span>Favorites</span></label>
      </div>

      <div className="prompt-library-preview__saved-views" aria-label="Saved prompt template views">
        <label className="prompt-library-preview__saved-view-select"><Bookmark size={14} aria-hidden="true" /><span>Saved view</span><select aria-label="Saved prompt template view" value={activeSavedViewId} onChange={(event) => applySavedView(event.target.value)}><option value="">Manual current filters</option>{savedViews.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}</select></label>
        <input aria-label="Saved prompt view name" value={savedViewName} onChange={(event) => setSavedViewName(event.target.value)} placeholder="Name this filter set" />
        <button type="button" className="button button--compact" onClick={saveView}><Save size={13} aria-hidden="true" /> Save view</button>
        <button type="button" className="button button--compact" onClick={updateSavedView} disabled={!activeSavedViewId}>Update</button>
        <button type="button" className="button button--compact button--ghost" onClick={deleteSavedView} disabled={!activeSavedViewId} aria-label="Delete saved prompt template view"><Trash2 size={13} aria-hidden="true" /></button>
        {savedViewStatus && <span role="status">{savedViewStatus}</span>}
      </div>

      <div className="prompt-library-preview__organization" aria-label="Prompt template organization">
        <div className="prompt-library-preview__organization-head">
          <div><span className="prompt-library-preview__kicker"><Folder size={14} aria-hidden="true" /> Organization</span><strong>Folders & tags</strong><span>Keep reusable prompts easy to scan; all edits stay in this renderer session.</span></div>
          <button type="button" className="button button--compact" onClick={() => setShowOrganization((current) => !current)} aria-expanded={showOrganization}>{showOrganization ? "Hide organizer" : "Open organizer"}</button>
        </div>
        <div className="prompt-library-preview__folder-strip" role="list" aria-label="Prompt template folders">
          <button type="button" className={folderFilter === "all" ? "is-active" : ""} aria-pressed={folderFilter === "all"} onClick={() => setFolderFilter("all")}>All <span>{templates.length}</span></button>
          <button type="button" className={folderFilter === "unfiled" ? "is-active" : ""} aria-pressed={folderFilter === "unfiled"} onClick={() => setFolderFilter("unfiled")}>Unfiled <span>{folderCounts.get("unfiled") ?? 0}</span></button>
          {folders.map((folder) => <button type="button" key={folder} className={folderFilter === folder ? "is-active" : ""} aria-pressed={folderFilter === folder} onClick={() => setFolderFilter(folder)}>{folder} <span>{folderCounts.get(folder) ?? 0}</span></button>)}
        </div>
        {showOrganization && <div className="prompt-library-preview__organization-panel" role="region" aria-label="Prompt folder organizer">
          <div className="prompt-library-preview__folder-create"><input aria-label="New prompt folder name" value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} placeholder="New folder name" /><button type="button" className="button button--compact" onClick={createFolder}><FolderPlus size={13} aria-hidden="true" /> Create folder</button></div>
          <div className="prompt-library-preview__folder-list" aria-label="Editable prompt folders">
            {folders.map((folder) => <div className="prompt-library-preview__folder-row" key={folder}><span><Folder size={14} aria-hidden="true" />{folder}<small>{folderCounts.get(folder) ?? 0} templates</small></span><input aria-label={`Rename folder ${folder}`} value={folderDrafts[folder] ?? folder} onChange={(event) => setFolderDrafts((current) => ({ ...current, [folder]: event.target.value }))} /><button type="button" className="button button--compact" onClick={() => renameFolder(folder)}>Rename</button><button type="button" className="button button--compact button--ghost" onClick={() => deleteFolder(folder)} aria-label={`Delete folder ${folder}`}><Trash2 size={13} aria-hidden="true" /></button></div>)}
          </div>
          {organizationStatus && <span className="prompt-library-preview__organization-status" role="status">{organizationStatus}</span>}
        </div>}
      </div>

      <div className="prompt-library-preview__layout">
        <aside className="prompt-library-preview__catalog" aria-label="Prompt templates">
          <div className="prompt-library-preview__catalog-heading"><span>{visibleTemplates.length} visible</span><span>{templates.filter((template) => !template.archived).length} active</span></div>
          {visibleTemplates.length === 0 ? <div className="prompt-library-preview__empty">No templates match this preview filter.</div> : visibleTemplates.map((template) => (
            <div className="prompt-library-preview__template-row" key={template.id}>
              <button type="button" className={`prompt-library-preview__template ${template.id === selectedTemplate?.id ? "is-selected" : ""}`} aria-pressed={template.id === selectedTemplate?.id} onClick={() => selectTemplate(template)}>
                <span className="prompt-library-preview__template-title">{template.name}</span>
                <span className="prompt-library-preview__template-meta">v{template.version} · {template.variables.length} variables · {template.archived ? "Archived" : "Active"}</span>
                <span className="prompt-library-preview__template-tags">{template.tags.map((tag) => <span key={tag}>{tag}</span>)}</span>
              </button>
              <button type="button" className={`prompt-library-preview__favorite ${favoriteIds.has(template.id) ? "is-active" : ""}`} aria-label={favoriteIds.has(template.id) ? "Unfavorite template" : "Favorite template"} title={`${favoriteIds.has(template.id) ? "Unfavorite" : "Favorite"} ${template.name}`} aria-pressed={favoriteIds.has(template.id)} onClick={() => toggleFavorite(template.id)}><Star size={14} fill={favoriteIds.has(template.id) ? "currentColor" : "none"} aria-hidden="true" /></button>
            </div>
          ))}
        </aside>

        {selectedTemplate && resolution ? <div className="prompt-library-preview__workspace">
          <div className="prompt-library-preview__workspace-head">
            <div><span className="prompt-library-preview__kicker">Selected template</span><h3>{selectedTemplate.name}</h3><p>{selectedTemplate.description}</p><div className="prompt-library-preview__tag-editor" aria-label="Selected template tags"><span className="prompt-library-preview__tag-editor-label">Tags</span>{selectedTemplate.tags.map((tag) => <button type="button" className="prompt-library-preview__tag-chip" key={tag} onClick={() => removeTagFromSelected(tag)} aria-label={`Remove tag ${tag}`} title={`Remove #${tag}`}>#{tag}<X size={11} aria-hidden="true" /></button>)}<input aria-label="Add tag to selected template" value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addTagToSelected(); } }} placeholder="add tag" /><button type="button" className="button button--compact" onClick={addTagToSelected}>Add tag</button></div></div>
            <div className="prompt-library-preview__selection-meta"><label><Folder size={14} aria-hidden="true" /><span className="sr-only">Selected template folder</span><select aria-label="Selected template folder" value={templateFolder(selectedTemplate.id)} onChange={(event) => assignFolder(selectedTemplate.id, event.target.value)}><option value="">Unfiled</option>{folders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}</select></label><div className="prompt-library-preview__version-badge">v{selectedTemplate.version}<span>{selectedTemplate.archived ? "Archived" : "Active"}</span></div></div>
          </div>

          <div className="prompt-library-preview__cards">
            <section className="prompt-library-preview__card" aria-labelledby="prompt-template-inputs-title">
              <div className="prompt-library-preview__card-head"><div><span className="prompt-library-preview__kicker">Typed variables</span><h4 id="prompt-template-inputs-title">Fill the template</h4></div><span className="prompt-library-preview__metric">{selectedTemplate.variables.length} fields</span></div>
              <div className="prompt-library-preview__variables">
                {selectedTemplate.variables.map((variable) => {
                  const current = values[variable.name];
                  const fieldId = `prompt-variable-${selectedTemplate.id}-${variable.id}`;
                  return <div className="prompt-library-preview__variable" key={variable.id}>
                    <label htmlFor={fieldId}>{variable.label} <span className="prompt-library-preview__variable-type">{describeVariable(variable)}{variable.required ? " · required" : " · optional"}</span></label>
                    {variable.type === "long-text" ? <textarea id={fieldId} value={typeof current === "string" ? current : ""} onChange={(event) => updateValue(variable, event.target.value)} rows={4} /> : variable.type === "choice" ? <select id={fieldId} value={typeof current === "string" ? current : ""} onChange={(event) => updateValue(variable, event.target.value)}><option value="">Select…</option>{(variable.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : variable.type === "boolean" ? <label className="prompt-library-preview__checkbox"><input id={fieldId} type="checkbox" checked={current === true} onChange={(event) => updateValue(variable, event.target.checked)} /> <span>{current === true ? "True" : "False"}</span></label> : <input id={fieldId} type={variable.type === "number" ? "number" : variable.type === "date" ? "date" : "text"} value={current === undefined ? "" : String(current)} onChange={(event) => updateValue(variable, event.target.value)} />}
                  </div>;
                })}
              </div>
              {selectedTemplate.examples.length > 0 && <div className="prompt-library-preview__examples"><span className="prompt-library-preview__kicker">Examples</span><div>{selectedTemplate.examples.map((example) => <button type="button" className="button button--compact" key={example.id} onClick={() => applyExample(example)}>{example.label}</button>)}</div></div>}
            </section>

            <section className="prompt-library-preview__card" aria-labelledby="prompt-template-resolution-title">
              <div className="prompt-library-preview__card-head"><div><span className="prompt-library-preview__kicker">Resolved prompt</span><h4 id="prompt-template-resolution-title">Live output preview</h4></div><span className={`prompt-library-preview__status-chip ${resolution.missingVariableIds.length ? "is-warning" : "is-ready"}`}>{resolution.missingVariableIds.length ? `${resolution.missingVariableIds.length} missing` : "Ready"}</span></div>
              <pre className="prompt-library-preview__resolved">{resolution.resolvedPrompt}</pre>
              {resolution.warnings.length > 0 && <div className="prompt-library-preview__issues" role="status"><strong>Validation notes</strong>{resolution.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>}
              {resolution.missingVariableIds.length === 0 && resolution.warnings.length === 0 && <div className="prompt-library-preview__ready-note"><Check size={15} aria-hidden="true" /> All required values are valid for this renderer preview.</div>}
            </section>
          </div>

          <div className="prompt-library-preview__lower-grid">
            <section className="prompt-library-preview__card" aria-labelledby="prompt-template-version-title">
              <div className="prompt-library-preview__card-head"><div><span className="prompt-library-preview__kicker">History</span><h4 id="prompt-template-version-title">Version history</h4></div><button type="button" className="button button--compact" onClick={bumpVersion}><History size={14} aria-hidden="true" /> Capture version</button></div>
              <div className="prompt-library-preview__history" role="region" aria-label="Prompt template version history">{selectedTemplate.versions.slice().reverse().map((version) => <button type="button" className={`prompt-library-preview__history-row ${inspectedVersion && versionKey(inspectedVersion) === versionKey(version) ? "is-inspected" : ""}`} aria-pressed={Boolean(inspectedVersion && versionKey(inspectedVersion) === versionKey(version))} key={versionKey(version)} onClick={() => inspectVersion(version)}><span className="prompt-library-preview__history-version">v{version.version}{version.version === selectedTemplate.version ? " · current" : ""}</span><span>{version.changeNote}</span><time dateTime={version.createdAt}>{new Date(version.createdAt).toLocaleDateString()}</time></button>)}</div>
              {inspectedVersion && versionDiff ? <div className="prompt-library-preview__version-inspector" role="region" aria-label="Prompt template version inspector"><div className="prompt-library-preview__card-head"><div><span className="prompt-library-preview__kicker">Inspector</span><h4>v{inspectedVersion.version} compared with v{selectedTemplate.version}</h4></div><button type="button" className="button button--compact" onClick={previewRollback} disabled={inspectedVersion.version === selectedTemplate.version}>Preview rollback</button></div><div className="prompt-library-preview__version-diff"><span><strong>{versionDiff.bodyChanged ? "Changed" : "Same"}</strong><small>prompt body</small></span><span><strong>{versionDiff.variablesAdded.length}</strong><small>variables added</small></span><span><strong>{versionDiff.variablesRemoved.length}</strong><small>variables removed</small></span></div><ul className="prompt-library-preview__version-summary">{versionDiff.summary.map((item) => <li key={item}>{item}</li>)}</ul>{rollbackPreview && <p className="prompt-library-preview__rollback-note" role="status">{rollbackPreview}</p>}</div> : null}
              <p className="prompt-library-preview__muted">Version records are session-only metadata; selecting or previewing rollback does not mutate the template, create a native receipt, or write durable history.</p>
            </section>
            <section className="prompt-library-preview__card" aria-labelledby="prompt-template-export-title">
              <div className="prompt-library-preview__card-head"><div><span className="prompt-library-preview__kicker">Portable bundle</span><h4 id="prompt-template-export-title">Export or inspect</h4></div><button type="button" className="button button--compact" onClick={() => setShowExport((current) => !current)}>{showExport ? <X size={14} aria-hidden="true" /> : <FileJson2 size={14} aria-hidden="true" />}{showExport ? "Hide preview" : "Preview export"}</button></div>
              {showExport && <div className="prompt-library-preview__export" role="region" aria-label="Prompt template export preview"><div className="prompt-library-preview__export-controls"><label>Format<select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ExportFormat)}><option value="json">JSON bundle</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--compact" onClick={() => void copyExport()}><Clipboard size={14} aria-hidden="true" /> Copy</button><button type="button" className="button button--compact" onClick={downloadExport}><Download size={14} aria-hidden="true" /> Download</button></div><pre className="prompt-library-preview__payload">{exportPayload}</pre></div>}
            </section>
          </div>

          {templateIssues.length > 0 && <div className="prompt-library-preview__definition-warning" role="alert"><strong>Template definition needs review</strong>{templateIssues.map((issue) => <span key={`${issue.path}-${issue.message}`}>{issue.path}: {issue.message}</span>)}</div>}
        </div> : <div className="prompt-library-preview__empty">Create or import a prompt template to begin.</div>}
      </div>

      <div className="prompt-library-preview__footer"><span><RotateCcw size={14} aria-hidden="true" /> Changes stay in this renderer session.</span>{status && <span role="status">{status}</span>}{organizationStatus && <span role="status">{organizationStatus}</span>}{importError && <span className="is-error" role="alert">{importError}</span>}</div>
    </section>
  );
}
