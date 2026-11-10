import {
  Braces,
  Code2,
  Eraser,
  FileJson,
  Heading2,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  RotateCcw,
  Sigma,
  Table2,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export type ComposerBlockCategory = "Structure" | "Code" | "Data" | "Math" | "Layout";

export interface ComposerBlockTemplate {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly category: ComposerBlockCategory;
  readonly snippet: string;
  readonly tags: readonly string[];
  readonly icon: "heading" | "quote" | "checklist" | "steps" | "code" | "json" | "mermaid" | "math" | "table" | "rule";
}

export const COMPOSER_BLOCK_TEMPLATES: readonly ComposerBlockTemplate[] = [
  {
    id: "heading",
    label: "Heading",
    description: "Start a named section with a Markdown heading.",
    category: "Structure",
    snippet: "## Section title",
    tags: ["title", "section", "outline"],
    icon: "heading",
  },
  {
    id: "callout",
    label: "Callout",
    description: "Highlight a decision, warning, or important note.",
    category: "Structure",
    snippet: "> [!NOTE]\n> Important context goes here.",
    tags: ["note", "admonition", "context"],
    icon: "quote",
  },
  {
    id: "checklist",
    label: "Checklist",
    description: "Track work with task items that continue on Enter.",
    category: "Structure",
    snippet: "- [ ] First task\n- [ ] Next task",
    tags: ["tasks", "todo", "work"],
    icon: "checklist",
  },
  {
    id: "steps",
    label: "Numbered steps",
    description: "Create a compact sequence for procedures or plans.",
    category: "Structure",
    snippet: "1. First step\n2. Next step\n3. Verify result",
    tags: ["ordered", "procedure", "plan"],
    icon: "steps",
  },
  {
    id: "code",
    label: "Code block",
    description: "Add a fenced code block with an editable language hint.",
    category: "Code",
    snippet: "```ts\n// paste code here\n```",
    tags: ["snippet", "programming", "fence"],
    icon: "code",
  },
  {
    id: "json",
    label: "JSON object",
    description: "Sketch structured input or an API payload.",
    category: "Code",
    snippet: "```json\n{\n  \"key\": \"value\"\n}\n```",
    tags: ["api", "schema", "structured"],
    icon: "json",
  },
  {
    id: "mermaid",
    label: "Mermaid diagram",
    description: "Draft a flowchart or sequence diagram in plain text.",
    category: "Code",
    snippet: "```mermaid\nflowchart LR\n  A[Input] --> B[Review]\n  B --> C[Output]\n```",
    tags: ["diagram", "flow", "graph"],
    icon: "mermaid",
  },
  {
    id: "math",
    label: "LaTeX equation",
    description: "Insert a block equation for the local math preview.",
    category: "Math",
    snippet: "$$\n\\frac{a}{b} + \\alpha = \\gamma\n$$",
    tags: ["formula", "latex", "equation"],
    icon: "math",
  },
  {
    id: "table",
    label: "Table",
    description: "Start a GitHub-flavored Markdown comparison table.",
    category: "Data",
    snippet: "| Column | Value |\n| --- | --- |\n| Item | Detail |",
    tags: ["matrix", "compare", "grid"],
    icon: "table",
  },
  {
    id: "rule",
    label: "Section divider",
    description: "Separate two ideas with a clean horizontal rule.",
    category: "Layout",
    snippet: "---",
    tags: ["divider", "separator", "layout"],
    icon: "rule",
  },
];

const CATEGORIES: readonly ("All" | ComposerBlockCategory)[] = [
  "All",
  "Structure",
  "Code",
  "Data",
  "Math",
  "Layout",
];

function TemplateIcon({ icon }: { icon: ComposerBlockTemplate["icon"] }) {
  if (icon === "heading") return <Heading2 size={14} aria-hidden="true" />;
  if (icon === "quote") return <Quote size={14} aria-hidden="true" />;
  if (icon === "checklist") return <ListChecks size={14} aria-hidden="true" />;
  if (icon === "steps") return <ListOrdered size={14} aria-hidden="true" />;
  if (icon === "code") return <Code2 size={14} aria-hidden="true" />;
  if (icon === "json") return <FileJson size={14} aria-hidden="true" />;
  if (icon === "mermaid") return <Workflow size={14} aria-hidden="true" />;
  if (icon === "math") return <Sigma size={14} aria-hidden="true" />;
  if (icon === "table") return <Table2 size={14} aria-hidden="true" />;
  return <Minus size={14} aria-hidden="true" />;
}

export interface ComposerBlockInsertStudioProps {
  readonly id?: string;
  readonly disabled?: boolean;
  readonly onClose?: () => void;
  readonly onInsert: (block: string) => void;
}

/**
 * Quick-insert palette for common Markdown blocks.
 *
 * This is deliberately a renderer-local drafting aid: selecting a template
 * only hands a snippet back to the composer. It does not render or execute
 * code, call a provider, read a file, or create a durable artifact.
 */
export function ComposerBlockInsertStudio({
  id = "composer-format-menu",
  disabled = false,
  onClose,
  onInsert,
}: ComposerBlockInsertStudioProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"All" | ComposerBlockCategory>("All");
  const [selectedId, setSelectedId] = useState(COMPOSER_BLOCK_TEMPLATES[0]?.id ?? "heading");
  const [draftSnippet, setDraftSnippet] = useState(COMPOSER_BLOCK_TEMPLATES[0]?.snippet ?? "");
  const [draftDirty, setDraftDirty] = useState(false);

  const filteredTemplates = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return COMPOSER_BLOCK_TEMPLATES.filter((template) => {
      if (category !== "All" && template.category !== category) return false;
      if (!normalizedQuery) return true;
      const haystack = [template.label, template.description, template.category, ...template.tags]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [category, query]);

  const selectedTemplate = filteredTemplates.find((template) => template.id === selectedId)
    ?? filteredTemplates[0]
    ?? null;

  useEffect(() => {
    if (selectedTemplate && selectedTemplate.id !== selectedId) setSelectedId(selectedTemplate.id);
  }, [selectedId, selectedTemplate?.id]);

  useEffect(() => {
    setDraftSnippet(selectedTemplate?.snippet ?? "");
    setDraftDirty(false);
  }, [selectedTemplate?.id]);

  const resetDraftSnippet = () => {
    setDraftSnippet(selectedTemplate?.snippet ?? "");
    setDraftDirty(false);
  };

  const updateDraftSnippet = (value: string) => {
    setDraftSnippet(value);
    setDraftDirty(value !== (selectedTemplate?.snippet ?? ""));
  };

  const draftStatusId = `${id}-draft-status`;
  const draftHasContent = draftSnippet.trim().length > 0;

  return (
    <div id={id} className="composer-popover composer-block-studio" role="dialog" aria-label="Block insert studio">
      <header className="composer-block-studio__header">
        <span>
          <strong>Block insert studio</strong>
          <small>Pick a structured Markdown starter</small>
        </span>
        <span className="composer-block-studio__header-actions">
          <span className="composer-block-studio__badge">Renderer-local</span>
          {onClose ? (
            <button
              type="button"
              className="composer-block-studio__close"
              aria-label="Close block insert studio"
              title="Close block insert studio"
              onMouseDown={(event) => event.preventDefault()}
              onClick={onClose}
            >
              <X size={14} aria-hidden="true" />
            </button>
          ) : null}
        </span>
      </header>

      <label className="composer-block-studio__search">
        <span className="sr-only">Search block templates</span>
        <input
          type="search"
          value={query}
          placeholder="Search blocks, tags, or format…"
          aria-label="Search block templates"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      <div className="composer-block-studio__categories" role="tablist" aria-label="Block categories">
        {CATEGORIES.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={category === value}
            tabIndex={category === value ? 0 : -1}
            className={category === value ? "composer-block-studio__category composer-block-studio__category--active" : "composer-block-studio__category"}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setCategory(value)}
          >
            {value}
          </button>
        ))}
      </div>

      <div className="composer-block-studio__body">
        <div className="composer-block-studio__templates" role="listbox" aria-label="Markdown block templates">
          {filteredTemplates.length > 0 ? filteredTemplates.map((template) => (
            <button
              key={template.id}
              type="button"
              role="option"
              aria-selected={selectedTemplate?.id === template.id}
              className={selectedTemplate?.id === template.id ? "composer-block-studio__template composer-block-studio__template--selected" : "composer-block-studio__template"}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setSelectedId(template.id)}
            >
              <span className="composer-block-studio__template-icon"><TemplateIcon icon={template.icon} /></span>
              <span className="composer-block-studio__template-copy">
                <strong>{template.label}</strong>
                <small>{template.description}</small>
              </span>
              <span className="composer-block-studio__template-kind">{template.category}</span>
            </button>
          )) : (
            <p className="composer-block-studio__empty">No block templates match this search.</p>
          )}
        </div>

        <section className="composer-block-studio__preview" aria-label="Selected block preview">
          {selectedTemplate ? (
            <>
              <div className="composer-block-studio__preview-heading">
                <span>
                  <TemplateIcon icon={selectedTemplate.icon} />
                  <strong>{selectedTemplate.label}</strong>
                </span>
                <span>{selectedTemplate.category}</span>
              </div>
              <p>{selectedTemplate.description}</p>
              <div className="composer-block-studio__draft-header">
                <label htmlFor={`${id}-draft-snippet`}>Draft snippet</label>
                <span id={draftStatusId} role="status">
                  {draftDirty ? "Custom draft" : "Starter snippet"} · {draftSnippet.length.toLocaleString()} chars
                </span>
              </div>
              <textarea
                id={`${id}-draft-snippet`}
                className="composer-block-studio__draft-input"
                value={draftSnippet}
                rows={6}
                spellCheck={false}
                aria-label="Edit block snippet"
                aria-describedby={draftStatusId}
                onChange={(event) => updateDraftSnippet(event.target.value)}
              />
              <div className="composer-block-studio__draft-actions">
                <button
                  type="button"
                  className="composer-block-studio__draft-action"
                  disabled={!draftDirty}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={resetDraftSnippet}
                >
                  <RotateCcw size={13} aria-hidden="true" />
                  Reset starter
                </button>
                <button
                  type="button"
                  className="composer-block-studio__draft-action"
                  disabled={!draftHasContent}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setDraftSnippet("");
                    setDraftDirty(true);
                  }}
                >
                  <Eraser size={13} aria-hidden="true" />
                  Clear draft
                </button>
              </div>
              <pre aria-label="Rendered draft snippet"><code>{draftSnippet || "(empty draft)"}</code></pre>
              <button
                type="button"
                className="composer-block-studio__insert"
                disabled={disabled || !draftHasContent}
                aria-describedby={draftStatusId}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onInsert(draftSnippet)}
              >
                <Braces size={14} aria-hidden="true" />
                Insert block
              </button>
            </>
          ) : (
            <p className="composer-block-studio__empty">Select a template to inspect its snippet.</p>
          )}
        </section>
      </div>

      <p className="composer-block-studio__boundary" role="note">
        Preview only · inserts draft text in this browser session; no file read, provider call, code execution, or durable write.
      </p>
    </div>
  );
}
