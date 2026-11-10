import {
  Check,
  Clipboard,
  Download,
  FileUp,
  Filter,
  Info,
  LockKeyhole,
  PackageSearch,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import { useMemo, useState, type ChangeEvent } from "react";

type CatalogSource = "hugging-face" | "ollama" | "lmstudio-local" | "local-files" | "plugin";
type CatalogTask = "chat" | "code" | "embedding" | "rerank" | "vision" | "speech_to_text";
type FitBand = "recommended" | "fits-with-tradeoffs" | "borderline" | "cpu-only" | "unsupported" | "unknown";
type CatalogSort = "compatibility" | "quality" | "speed" | "memory" | "size" | "context" | "freshness";

type LocalModelCatalogEntry = {
  readonly id: string;
  readonly name: string;
  readonly family: string;
  readonly source: CatalogSource;
  readonly author: string;
  readonly revision: string;
  readonly tasks: readonly CatalogTask[];
  readonly modalities: readonly string[];
  readonly format: string;
  readonly quantization: string;
  readonly license: string;
  readonly gated: boolean;
  readonly verifiedPublisher: boolean;
  readonly diskGb: number;
  readonly ramGb: number;
  readonly vramGb: number;
  readonly contextK: number;
  readonly quality: number;
  readonly speed: number;
  readonly freshness: number;
  readonly fit: FitBand;
  readonly fitReason: string;
  readonly runtime: string;
  readonly benchmark: "Observed" | "Seeded estimate" | "Not observed";
};

const SOURCE_LABELS: Record<CatalogSource, string> = {
  "hugging-face": "Hugging Face",
  ollama: "Ollama",
  "lmstudio-local": "LM Studio",
  "local-files": "Local files",
  plugin: "Plugin registry",
};

const TASK_LABELS: Record<CatalogTask, string> = {
  chat: "Chat",
  code: "Code",
  embedding: "Embedding",
  rerank: "Rerank",
  vision: "Vision/OCR",
  speech_to_text: "Speech to text",
};

const FIT_LABELS: Record<FitBand, string> = {
  recommended: "Recommended",
  "fits-with-tradeoffs": "Fits with trade-offs",
  borderline: "Borderline",
  "cpu-only": "CPU only",
  unsupported: "Unsupported",
  unknown: "Unknown",
};

const CATALOG: readonly LocalModelCatalogEntry[] = [
  {
    id: "ollama-llama-3.2-3b-q4",
    name: "Llama 3.2 3B Instruct",
    family: "Llama 3.2",
    source: "ollama",
    author: "Meta",
    revision: "3.2@q4_k_m",
    tasks: ["chat", "code"],
    modalities: ["text", "tools"],
    format: "GGUF",
    quantization: "Q4_K_M",
    license: "Llama 3.2 Community",
    gated: false,
    verifiedPublisher: true,
    diskGb: 2.0,
    ramGb: 4.6,
    vramGb: 2.9,
    contextK: 128,
    quality: 72,
    speed: 86,
    freshness: 91,
    fit: "recommended",
    fitReason: "Comfortable 4 GiB VRAM target with room for a moderate KV cache.",
    runtime: "Ollama / llama.cpp",
    benchmark: "Seeded estimate",
  },
  {
    id: "hf-qwen-2.5-coder-7b-q4",
    name: "Qwen2.5 Coder 7B Instruct",
    family: "Qwen2.5 Coder",
    source: "hugging-face",
    author: "Qwen",
    revision: "main@q4_k_m",
    tasks: ["chat", "code"],
    modalities: ["text", "tools", "json"],
    format: "GGUF",
    quantization: "Q4_K_M",
    license: "Apache-2.0",
    gated: false,
    verifiedPublisher: true,
    diskGb: 4.7,
    ramGb: 7.2,
    vramGb: 4.1,
    contextK: 32,
    quality: 88,
    speed: 63,
    freshness: 88,
    fit: "fits-with-tradeoffs",
    fitReason: "Usable with partial GPU offload; larger contexts may spill into system RAM.",
    runtime: "llama.cpp / LM Studio",
    benchmark: "Seeded estimate",
  },
  {
    id: "hf-bge-small-en-v1.5",
    name: "BGE-small-en-v1.5",
    family: "BGE",
    source: "hugging-face",
    author: "BAAI",
    revision: "v1.5",
    tasks: ["embedding"],
    modalities: ["text"],
    format: "Safetensors",
    quantization: "FP32",
    license: "MIT",
    gated: false,
    verifiedPublisher: true,
    diskGb: 0.13,
    ramGb: 0.5,
    vramGb: 0.2,
    contextK: 0,
    quality: 78,
    speed: 96,
    freshness: 75,
    fit: "recommended",
    fitReason: "Small retrieval component; leaves nearly all host capacity for a chat model.",
    runtime: "Python / ONNX",
    benchmark: "Seeded estimate",
  },
  {
    id: "hf-whisper-small",
    name: "Whisper Small",
    family: "Whisper",
    source: "hugging-face",
    author: "OpenAI",
    revision: "small",
    tasks: ["speech_to_text"],
    modalities: ["audio"],
    format: "Safetensors",
    quantization: "FP16",
    license: "MIT",
    gated: false,
    verifiedPublisher: true,
    diskGb: 0.46,
    ramGb: 1.5,
    vramGb: 1.2,
    contextK: 0,
    quality: 82,
    speed: 79,
    freshness: 69,
    fit: "recommended",
    fitReason: "Modest memory footprint for offline transcription experiments.",
    runtime: "CTranslate2 / whisper.cpp",
    benchmark: "Seeded estimate",
  },
  {
    id: "lmstudio-qwen-vl-7b-q4",
    name: "Qwen2.5-VL 7B Instruct",
    family: "Qwen2.5-VL",
    source: "lmstudio-local",
    author: "Qwen",
    revision: "7b@q4",
    tasks: ["chat", "vision", "code"],
    modalities: ["text", "image", "tools"],
    format: "GGUF + projector",
    quantization: "Q4_K_M",
    license: "Apache-2.0",
    gated: false,
    verifiedPublisher: true,
    diskGb: 5.1,
    ramGb: 8.4,
    vramGb: 5.2,
    contextK: 32,
    quality: 86,
    speed: 48,
    freshness: 86,
    fit: "borderline",
    fitReason: "4 GiB VRAM is below the estimated full-offload requirement; CPU spill is expected.",
    runtime: "LM Studio / llama.cpp",
    benchmark: "Seeded estimate",
  },
  {
    id: "hf-deepseek-r1-qwen-14b-q4",
    name: "DeepSeek-R1-Distill-Qwen-14B",
    family: "DeepSeek-R1 Distill",
    source: "hugging-face",
    author: "DeepSeek",
    revision: "14b@q4",
    tasks: ["chat", "code"],
    modalities: ["text", "reasoning"],
    format: "GGUF",
    quantization: "Q4_K_M",
    license: "MIT",
    gated: false,
    verifiedPublisher: true,
    diskGb: 9.1,
    ramGb: 12.4,
    vramGb: 8.5,
    contextK: 64,
    quality: 94,
    speed: 28,
    freshness: 93,
    fit: "unsupported",
    fitReason: "Estimated VRAM and RAM exceed the audited host envelope for a practical interactive route.",
    runtime: "llama.cpp",
    benchmark: "Seeded estimate",
  },
];

const sourceOptions: readonly CatalogSource[] = ["hugging-face", "ollama", "lmstudio-local", "local-files", "plugin"];
const taskOptions: readonly CatalogTask[] = ["chat", "code", "embedding", "rerank", "vision", "speech_to_text"];
const fitOptions: readonly FitBand[] = ["recommended", "fits-with-tradeoffs", "borderline", "cpu-only", "unsupported", "unknown"];

function compareNullable(left: number | null, right: number | null, direction: "asc" | "desc"): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return direction === "asc" ? left - right : right - left;
}

function exportCatalog(entries: readonly LocalModelCatalogEntry[], compareIds: readonly string[]): string {
  return JSON.stringify({
    schema: "omnia.local-model-catalog.preview.v1",
    generatedAt: new Date().toISOString(),
    boundary: "Renderer-local seeded catalog; no network request, download, filesystem scan, runtime launch, credential lookup, or durable write.",
    hardwareProfile: "audit-2026-08-14",
    compareIds,
    entries,
  }, null, 2);
}

function downloadText(filename: string, content: string): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function LocalModelCatalogPreview() {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<CatalogSource | "all">("all");
  const [task, setTask] = useState<CatalogTask | "all">("all");
  const [fit, setFit] = useState<FitBand | "all">("all");
  const [sort, setSort] = useState<CatalogSort>("compatibility");
  const [selectedId, setSelectedId] = useState(CATALOG[0]!.id);
  const [compareIds, setCompareIds] = useState<string[]>([CATALOG[0]!.id, CATALOG[1]!.id]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [status, setStatus] = useState("Seeded catalog loaded; no source query or hardware probe was performed.");

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const result = CATALOG.filter((entry) => {
      const haystack = [entry.name, entry.family, entry.author, entry.revision, entry.format, entry.quantization, entry.license, ...entry.tasks, ...entry.modalities].join(" ").toLowerCase();
      return (!normalized || haystack.includes(normalized))
        && (source === "all" || entry.source === source)
        && (task === "all" || entry.tasks.includes(task))
        && (fit === "all" || entry.fit === fit);
    });
    return [...result].sort((left, right) => {
      if (sort === "quality") return right.quality - left.quality || left.name.localeCompare(right.name);
      if (sort === "speed") return right.speed - left.speed || left.name.localeCompare(right.name);
      if (sort === "memory") return left.ramGb - right.ramGb || left.name.localeCompare(right.name);
      if (sort === "size") return left.diskGb - right.diskGb || left.name.localeCompare(right.name);
      if (sort === "context") return compareNullable(right.contextK, left.contextK, "desc") || left.name.localeCompare(right.name);
      if (sort === "freshness") return right.freshness - left.freshness || left.name.localeCompare(right.name);
      const fitRank: Record<FitBand, number> = { recommended: 0, "fits-with-tradeoffs": 1, borderline: 2, "cpu-only": 3, unknown: 4, unsupported: 5 };
      return fitRank[left.fit] - fitRank[right.fit] || right.quality - left.quality;
    });
  }, [fit, query, sort, source, task]);

  const selected = CATALOG.find((entry) => entry.id === selectedId) ?? CATALOG[0]!;
  const compareEntries = compareIds.map((id) => CATALOG.find((entry) => entry.id === id)).filter((entry): entry is LocalModelCatalogEntry => Boolean(entry));
  const activeFilters = [query.trim(), source !== "all" ? source : "", task !== "all" ? task : "", fit !== "all" ? fit : ""].filter(Boolean).length;

  const toggleCompare = (id: string) => {
    setCompareIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
    setStatus("Compare set updated in the renderer preview.");
  };

  const resetFilters = () => {
    setQuery("");
    setSource("all");
    setTask("all");
    setFit("all");
    setSort("compatibility");
    setStatus("Catalog filters reset.");
  };

  const planDownload = () => {
    setStatus(`Download plan staged for ${selected.name}; revision ${selected.revision} and ${selected.license} still require native approval and verification.`);
  };

  const handleManifest = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) setStatus(`Manifest ${file.name} selected locally; it was not read, imported, or persisted.`);
    event.target.value = "";
  };

  return (
    <section className="local-model-catalog" aria-labelledby="local-model-catalog-title">
      <header className="local-model-catalog__header">
        <span className="local-model-catalog__icon" aria-hidden="true"><PackageSearch size={18} /></span>
        <span><span className="eyebrow">Hardware-aware discovery</span><h2 id="local-model-catalog-title">Local Model Catalog</h2><p>Search candidate runtimes and model payloads by role, source, resource fit, quality, and evidence posture.</p></span>
        <span className="local-model-catalog__badge"><Sparkles size={12} /> Preview only</span>
      </header>

      <div className="local-model-catalog__boundary" role="note"><Info size={14} /><span>Seeded catalog for UI planning. Values are illustrative estimates from the audited host snapshot; no network catalog, filesystem, download, license acceptance, or runtime probe is active.</span></div>

      <div className="local-model-catalog__metrics" aria-label="Local model catalog summary">
        <span><strong>{CATALOG.length}</strong><small>candidate records</small></span>
        <span><strong>{CATALOG.filter((entry) => entry.fit === "recommended").length}</strong><small>recommended fits</small></span>
        <span><strong>{CATALOG.filter((entry) => entry.tasks.includes("chat") || entry.tasks.includes("code")).length}</strong><small>chat/code routes</small></span>
        <span><strong>{compareIds.length}</strong><small>in compare set</small></span>
      </div>

      <div className="local-model-catalog__toolbar" role="search" aria-label="Local model catalog filters">
        <label className="local-model-catalog__search"><Search size={14} /><span className="sr-only">Search local models</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search family, task, format, license…" aria-label="Search local models" />{query ? <button type="button" aria-label="Clear local model search" onClick={() => setQuery("")}><X size={13} /></button> : null}</label>
        <label><span>Source</span><select value={source} onChange={(event) => setSource(event.target.value as CatalogSource | "all")} aria-label="Filter local models by source"><option value="all">All sources</option>{sourceOptions.map((value) => <option key={value} value={value}>{SOURCE_LABELS[value]}</option>)}</select></label>
        <label><span>Task</span><select value={task} onChange={(event) => setTask(event.target.value as CatalogTask | "all")} aria-label="Filter local models by task"><option value="all">All tasks</option>{taskOptions.map((value) => <option key={value} value={value}>{TASK_LABELS[value]}</option>)}</select></label>
        <label><span>Hardware fit</span><select value={fit} onChange={(event) => setFit(event.target.value as FitBand | "all")} aria-label="Filter local models by hardware fit"><option value="all">All fit states</option>{fitOptions.map((value) => <option key={value} value={value}>{FIT_LABELS[value]}</option>)}</select></label>
        <label><span>Sort</span><select value={sort} onChange={(event) => setSort(event.target.value as CatalogSort)} aria-label="Sort local models"><option value="compatibility">Compatibility first</option><option value="quality">Quality</option><option value="speed">Speed</option><option value="memory">RAM · low first</option><option value="size">Disk · small first</option><option value="context">Context · high first</option><option value="freshness">Freshness</option></select></label>
        <span className="local-model-catalog__count" role="status"><Filter size={12} /> {filtered.length} of {CATALOG.length} · {activeFilters} filters</span>
        {activeFilters ? <button type="button" className="button button--ghost" onClick={resetFilters} aria-label="Clear local model catalog filters"><RotateCcw size={13} /> Reset</button> : null}
      </div>

      <div className="local-model-catalog__layout">
        <div className="local-model-catalog__list" role="list" aria-label="Local model candidates">
          {filtered.map((entry) => {
            const isSelected = entry.id === selected.id;
            const isCompared = compareIds.includes(entry.id);
            return <article key={entry.id} className={`local-model-catalog__card${isSelected ? " is-selected" : ""}`} role="listitem">
              <button type="button" className="local-model-catalog__card-main" onClick={() => setSelectedId(entry.id)} aria-label={`Inspect ${entry.name}`}>
                <span className={`local-model-catalog__fit local-model-catalog__fit--${entry.fit}`}><span />{FIT_LABELS[entry.fit]}</span>
                <span className="local-model-catalog__card-copy"><strong>{entry.name}</strong><small>{SOURCE_LABELS[entry.source]} · {entry.format} · {entry.quantization}</small><small>{entry.tasks.map((item) => TASK_LABELS[item]).join(" · ")}</small></span>
                <span className="local-model-catalog__card-meta"><b>{entry.ramGb.toFixed(1)} GB</b><small>RAM est.</small></span>
              </button>
              <footer><span>{entry.benchmark} · {entry.runtime}</span><button type="button" className={isCompared ? "is-active" : ""} onClick={() => toggleCompare(entry.id)} aria-pressed={isCompared}>{isCompared ? <Check size={12} /> : null} Compare</button></footer>
            </article>;
          })}
          {!filtered.length ? <div className="local-model-catalog__empty"><Search size={18} /><strong>No candidate matches</strong><span>Change the query or filters to inspect another route.</span><button type="button" className="button button--ghost" onClick={resetFilters}>Reset filters</button></div> : null}
        </div>

        <aside className="local-model-catalog__details" aria-label="Selected local model details">
          <div className="local-model-catalog__details-heading"><span className="eyebrow">Selected candidate</span><span className={`local-model-catalog__fit local-model-catalog__fit--${selected.fit}`}><span />{FIT_LABELS[selected.fit]}</span></div>
          <h3>{selected.name}</h3><p>{selected.family} · {selected.author} · {SOURCE_LABELS[selected.source]}</p>
          <div className="local-model-catalog__signals"><span><strong>{selected.diskGb.toFixed(2)} GB</strong><small>disk</small></span><span><strong>{selected.ramGb.toFixed(1)} GB</strong><small>RAM est.</small></span><span><strong>{selected.vramGb.toFixed(1)} GB</strong><small>VRAM est.</small></span><span><strong>{selected.contextK ? `${selected.contextK}k` : "—"}</strong><small>context</small></span></div>
          <div className="local-model-catalog__detail-block"><span className="eyebrow">Why this fit</span><p>{selected.fitReason}</p></div>
          <div className="local-model-catalog__tags">{selected.tasks.map((item) => <span key={item}>{TASK_LABELS[item]}</span>)}{selected.modalities.map((item) => <span key={item}>{item}</span>)}</div>
          <dl className="local-model-catalog__metadata"><div><dt>Revision</dt><dd>{selected.revision}</dd></div><div><dt>License</dt><dd>{selected.license}{selected.gated ? " · gated" : ""}</dd></div><div><dt>Runtime</dt><dd>{selected.runtime}</dd></div><div><dt>Publisher</dt><dd>{selected.verifiedPublisher ? "Verified metadata" : "Not verified"}</dd></div></dl>
          <div className="local-model-catalog__actions"><button type="button" className="button button--primary" onClick={planDownload}><Download size={13} /> Plan download</button><button type="button" className="button button--ghost" onClick={() => toggleCompare(selected.id)}>{compareIds.includes(selected.id) ? <Check size={13} /> : null} {compareIds.includes(selected.id) ? "In compare" : "Add compare"}</button></div>
          <p className="local-model-catalog__action-note" role="status">{status}</p>
        </aside>
      </div>

      <div className="local-model-catalog__lower-actions"><button type="button" className="button button--ghost" onClick={() => setCompareOpen((open) => !open)} aria-expanded={compareOpen} aria-controls="local-model-catalog-compare"><SlidersHorizontal size={13} /> {compareOpen ? "Hide compare" : "Open compare"} ({compareEntries.length})</button><label className="button button--ghost local-model-catalog__import"><FileUp size={13} /> Import manifest<input type="file" accept="application/json,.json" onChange={handleManifest} aria-label="Import local model manifest" /></label><button type="button" className="button button--ghost" onClick={() => downloadText("omnia-local-model-catalog.preview.json", exportCatalog(CATALOG, compareIds))}><Clipboard size={13} /> Export catalog JSON</button></div>

      {compareOpen ? <section id="local-model-catalog-compare" className="local-model-catalog__compare" aria-labelledby="local-model-catalog-compare-title"><header><span><span className="eyebrow">Side-by-side</span><h3 id="local-model-catalog-compare-title">Compare candidates</h3></span><span>{compareEntries.length} selected</span></header>{compareEntries.length ? <div className="local-model-catalog__compare-table" role="table" aria-label="Compared local models"><div className="local-model-catalog__compare-row local-model-catalog__compare-row--head" role="row"><span role="columnheader">Model</span><span role="columnheader">Fit</span><span role="columnheader">RAM / VRAM</span><span role="columnheader">Quality / speed</span><span role="columnheader" aria-label="Remove" /></div>{compareEntries.map((entry) => <div className="local-model-catalog__compare-row" role="row" key={entry.id}><span><strong>{entry.name}</strong><small>{SOURCE_LABELS[entry.source]}</small></span><span>{FIT_LABELS[entry.fit]}</span><span>{entry.ramGb.toFixed(1)} / {entry.vramGb.toFixed(1)} GB</span><span>{entry.quality} / {entry.speed}</span><button type="button" className="icon-button icon-button--small" onClick={() => toggleCompare(entry.id)} aria-label={`Remove ${entry.name} from compare`}><X size={13} /></button></div>)}</div> : <p>No candidates selected. Use Compare on a catalog card.</p>}</section> : null}

      <p className="local-model-catalog__footer"><LockKeyhole size={13} /> Renderer-local catalog preview · no provider request · no credential lookup · no filesystem authority · no runtime install/launch · no durable import/download.</p>
    </section>
  );
}

export default LocalModelCatalogPreview;
