import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Copy,
  Download,
  Filter,
  Search,
  PackageCheck,
  Play,
  Plus,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Trash2,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  BUILT_IN_TERMINAL_TOOLCHAIN_PROFILES,
  parseTerminalToolchainProfiles,
  serializeTerminalToolchainProfiles,
  type TerminalBuildProfile,
  type TerminalTargetId,
  type TerminalToolchainId,
  type TerminalToolchainProfile,
  type TerminalToolchainProfileExportFormat,
} from "./terminal-toolchain-profile";

type ToolchainId = TerminalToolchainId;
type TargetId = TerminalTargetId;
type RunState = "idle" | "completed";
type OutputKind = "system" | "stdout" | "stderr";

type OutputLine = {
  id: string;
  kind: OutputKind;
  text: string;
};

type Toolchain = {
  id: ToolchainId;
  label: string;
  version: string;
  command: string;
  accent: string;
};

type CatalogCategory = "software" | "systems" | "science";
type ToolchainCatalogEntry = {
  id: string;
  name: string;
  family: string;
  category: CatalogCategory;
  description: string;
  command: string;
  previewToolchainId?: ToolchainId;
};

const TOOLCHAINS: readonly Toolchain[] = [
  { id: "node", label: "Node.js", version: "Version not detected", command: "npm run test", accent: "JavaScript / TypeScript" },
  { id: "python", label: "Python", version: "Version not detected", command: "python -m pytest", accent: "Python / data" },
  { id: "rust", label: "Rust", version: "Version not detected", command: "cargo test", accent: "Rust / Tauri" },
  { id: "cpp", label: "C++", version: "Version not detected", command: "cmake --build build", accent: "C++ / systems" },
];

const TOOLCHAIN_CATALOG: readonly ToolchainCatalogEntry[] = [
  { id: "node", name: "Node.js", family: "JavaScript · TypeScript", category: "software", description: "Application runtimes, web tooling, package scripts, and fast feedback loops.", command: "npm run test", previewToolchainId: "node" },
  { id: "python", name: "Python", family: "Python · data · AI", category: "science", description: "General programming, notebooks, automation, data analysis, and ML workflows.", command: "python -m pytest", previewToolchainId: "python" },
  { id: "rust", name: "Rust", family: "Rust · Cargo · Tauri", category: "systems", description: "Systems software, native application backends, safe concurrency, and CLI tools.", command: "cargo test", previewToolchainId: "rust" },
  { id: "cpp", name: "C++ · GCC / Clang", family: "C · C++ · CMake", category: "systems", description: "Competitive programming, systems, game engines, and performance-critical projects.", command: "cmake --build build", previewToolchainId: "cpp" },
  { id: "go", name: "Go", family: "Go · modules", category: "software", description: "Cloud services, network tools, command-line apps, and concurrent systems.", command: "go test ./..." },
  { id: "java", name: "Java · JDK", family: "Java · JVM · Gradle", category: "software", description: "Backend services, Android-adjacent workflows, and JVM research tooling.", command: "./gradlew test" },
  { id: "dotnet", name: ".NET", family: "C# · F# · .NET SDK", category: "software", description: "Desktop, web, cloud, and cross-platform applications on the .NET ecosystem.", command: "dotnet test" },
  { id: "julia", name: "Julia", family: "Julia · scientific computing", category: "science", description: "Numerical computing, optimization, simulation, and scientific research.", command: 'julia --project -e "using Pkg; Pkg.test()"' },
  { id: "r", name: "R", family: "R · statistics", category: "science", description: "Statistics, data visualization, reproducible analysis, and academic reporting.", command: 'Rscript -e "devtools::test()"' },
  { id: "fortran", name: "Fortran", family: "Fortran · HPC", category: "science", description: "Scientific computing, numerical kernels, and high-performance simulation.", command: "cmake --build build --target all" },
  { id: "cuda", name: "CUDA Toolkit", family: "CUDA · GPU computing", category: "systems", description: "GPU programming and accelerated scientific or machine-learning workloads.", command: "nvcc --version" },
  { id: "swift", name: "Swift", family: "Swift · SwiftPM", category: "software", description: "Apple-platform applications and cross-platform Swift packages.", command: "swift test" },
  { id: "sql", name: "SQL · notebooks", family: "SQL · DuckDB · Jupyter", category: "science", description: "Querying, data exploration, analytical notebooks, and repeatable reports.", command: "jupyter lab" },
];

const CATALOG_FILTERS: readonly { id: "all" | CatalogCategory; label: string }[] = [
  { id: "all", label: "All" },
  { id: "software", label: "Application" },
  { id: "systems", label: "Systems" },
  { id: "science", label: "Science & data" },
];

const TARGETS: readonly { id: TargetId; label: string; description: string }[] = [
  { id: "dev", label: "Dev run", description: "Start a local development rehearsal" },
  { id: "test", label: "Focused test", description: "Run the selected file's focused check" },
  { id: "build", label: "Build", description: "Compile a preview artifact" },
  { id: "lint", label: "Lint / format", description: "Check style and diagnostics" },
];

const DEFAULT_OUTPUT: readonly OutputLine[] = [
  { id: "idle-1", kind: "system", text: "Terminal ready · choose a toolchain and target to rehearse a command." },
  { id: "idle-2", kind: "system", text: "No process, compiler, shell, or filesystem access is active in this preview." },
];

function outputFor(toolchain: Toolchain, target: TargetId, command: string, projectName: string, filePath: string, runNumber: number): OutputLine[] {
  const targetLabel = TARGETS.find((item) => item.id === target)?.label ?? "Preview run";
  const lines: OutputLine[] = [
    { id: `${runNumber}-system-1`, kind: "system", text: `[preview] ${targetLabel} · ${toolchain.label} ${toolchain.version}` },
    { id: `${runNumber}-system-2`, kind: "system", text: `[preview] cwd: ${projectName.toLowerCase().replace(/\s+/g, "-")} · file: ${filePath}` },
    { id: `${runNumber}-stdout-1`, kind: "stdout", text: `$ ${command}` },
  ];

  if (target === "test") {
    lines.push({ id: `${runNumber}-stdout-2`, kind: "stdout", text: "PASS  synthetic focused check (renderer preview)" });
    lines.push({ id: `${runNumber}-stdout-3`, kind: "stdout", text: "1 suite passed · 0 native processes started" });
  } else if (target === "build") {
    lines.push({ id: `${runNumber}-stdout-2`, kind: "stdout", text: "compile graph resolved · 6 synthetic inputs" });
    lines.push({ id: `${runNumber}-stdout-3`, kind: "stdout", text: "build plan ready · artifact bytes were not produced" });
  } else if (target === "lint") {
    lines.push({ id: `${runNumber}-stdout-2`, kind: "stdout", text: "diagnostics projection clean · formatter was not executed" });
  } else {
    lines.push({ id: `${runNumber}-stdout-2`, kind: "stdout", text: "dev server rehearsal prepared · listener was not opened" });
  }

  lines.push({ id: `${runNumber}-system-3`, kind: "system", text: "[preview] completed · no process, shell, compiler, network, or file write was used" });
  return lines;
}

function downloadTerminalToolchainProfile(payload: string, format: TerminalToolchainProfileExportFormat): boolean {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-terminal-toolchain-profiles.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export function TerminalCompilerPreview({ projectName, filePath = "src/main.ts" }: { readonly projectName: string; readonly filePath?: string }) {
  const [toolchainId, setToolchainId] = useState<ToolchainId>("node");
  const [target, setTarget] = useState<TargetId>("test");
  const [command, setCommand] = useState("npm run test -- src/main.test.ts");
  const [buildProfile, setBuildProfile] = useState<TerminalBuildProfile>("debug");
  const [sandbox, setSandbox] = useState(true);
  const [network, setNetwork] = useState(false);
  const [cache, setCache] = useState(true);
  const [watch, setWatch] = useState(false);
  const [activeProfileId, setActiveProfileId] = useState<string | null>("terminal-node-test");
  const [customProfiles, setCustomProfiles] = useState<TerminalToolchainProfile[]>([]);
  const [comparisonProfileIds, setComparisonProfileIds] = useState<[string, string]>(["terminal-node-test", "terminal-python-data"]);
  const [profileName, setProfileName] = useState("");
  const [profileStatus, setProfileStatus] = useState("Profiles stay in this renderer session.");
  const [profileExportFormat, setProfileExportFormat] = useState<TerminalToolchainProfileExportFormat>("json");
  const [profileExportStatus, setProfileExportStatus] = useState("Portable preview excludes native authority, secrets, and run receipts.");
  const [profileImportDraft, setProfileImportDraft] = useState("");
  const [profileImportStatus, setProfileImportStatus] = useState("Paste an Omnia JSON profile export to preview-import it into this session.");
  const [profileImportBatch, setProfileImportBatch] = useState(0);
  const [runState, setRunState] = useState<RunState>("idle");
  const [runNumber, setRunNumber] = useState(0);
  const [output, setOutput] = useState<OutputLine[]>([...DEFAULT_OUTPUT]);
  const [status, setStatus] = useState("Ready for a renderer-local rehearsal");
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogFilter, setCatalogFilter] = useState<(typeof CATALOG_FILTERS)[number]["id"]>("all");
  const [catalogSelectedId, setCatalogSelectedId] = useState("node");

  const toolchain = TOOLCHAINS.find((item) => item.id === toolchainId) ?? TOOLCHAINS[0]!;
  const selectedCatalogEntry = TOOLCHAIN_CATALOG.find((item) => item.id === catalogSelectedId) ?? TOOLCHAIN_CATALOG[0]!;
  const selectedTarget = TARGETS.find((item) => item.id === target) ?? TARGETS[0]!;
  const visibleCatalogEntries = useMemo(() => {
    const query = catalogQuery.trim().toLocaleLowerCase();
    return TOOLCHAIN_CATALOG.filter((entry) => {
      const matchesFilter = catalogFilter === "all" || entry.category === catalogFilter;
      const searchable = `${entry.name} ${entry.family} ${entry.description} ${entry.command}`.toLocaleLowerCase();
      return matchesFilter && (!query || searchable.includes(query));
    });
  }, [catalogFilter, catalogQuery]);
  const availableProfiles = useMemo(() => [...BUILT_IN_TERMINAL_TOOLCHAIN_PROFILES, ...customProfiles], [customProfiles]);
  const comparisonProfiles = comparisonProfileIds.map((id) => availableProfiles.find((profile) => profile.id === id) ?? availableProfiles[0]!);
  const comparisonRows = comparisonProfiles[0] && comparisonProfiles[1] ? [
    { label: "Toolchain", left: comparisonProfiles[0].toolchainId, right: comparisonProfiles[1].toolchainId },
    { label: "Target", left: comparisonProfiles[0].target, right: comparisonProfiles[1].target },
    { label: "Command", left: comparisonProfiles[0].command, right: comparisonProfiles[1].command },
    { label: "Build profile", left: comparisonProfiles[0].buildProfile, right: comparisonProfiles[1].buildProfile },
    { label: "Sandbox", left: comparisonProfiles[0].sandbox ? "On" : "Off", right: comparisonProfiles[1].sandbox ? "On" : "Off" },
    { label: "Network", left: comparisonProfiles[0].network ? "Requested" : "Blocked", right: comparisonProfiles[1].network ? "Requested" : "Blocked" },
    { label: "Cache", left: comparisonProfiles[0].cache ? "On" : "Off", right: comparisonProfiles[1].cache ? "On" : "Off" },
    { label: "Watch", left: comparisonProfiles[0].watch ? "On" : "Off", right: comparisonProfiles[1].watch ? "On" : "Off" },
  ] : [];
  const differenceCount = comparisonRows.filter((row) => row.left !== row.right).length;
  const currentProfile = useMemo(() => ({
    name: "Active terminal preview",
    description: "The current renderer-local command, toolchain, target, and run policy.",
    toolchainId,
    target,
    command,
    buildProfile,
    sandbox,
    network,
    cache,
    watch,
  }), [buildProfile, cache, command, network, sandbox, target, toolchainId, watch]);
  const profileExportPayload = useMemo(
    () => serializeTerminalToolchainProfiles(currentProfile, availableProfiles, profileExportFormat),
    [availableProfiles, currentProfile, profileExportFormat],
  );
  const capabilitySummary = useMemo(() => [
    sandbox ? "sandboxed" : "sandbox off",
    network ? "network requested" : "network blocked",
    cache ? "cache on" : "cache off",
    watch ? "watch mode" : "one-shot",
  ].join(" · "), [cache, network, sandbox, watch]);

  function markProfileEdited() {
    setActiveProfileId(null);
  }

  function selectToolchain(nextId: ToolchainId) {
    const next = TOOLCHAINS.find((item) => item.id === nextId) ?? TOOLCHAINS[0]!;
    markProfileEdited();
    setCatalogSelectedId(nextId);
    setToolchainId(nextId);
    setCommand(next.command);
    setStatus(`${next.label} selected · command template updated`);
  }

  function useCatalogEntry(entry: ToolchainCatalogEntry) {
    if (!entry.previewToolchainId) return;
    setCatalogSelectedId(entry.id);
    selectToolchain(entry.previewToolchainId);
    setStatus(`${entry.name} command template selected · this is not a detected or installed toolchain`);
  }

  function applyToolchainProfile(nextProfile: TerminalToolchainProfile) {
    setCatalogSelectedId(nextProfile.toolchainId);
    setToolchainId(nextProfile.toolchainId);
    setTarget(nextProfile.target);
    setCommand(nextProfile.command);
    setBuildProfile(nextProfile.buildProfile);
    setSandbox(nextProfile.sandbox);
    setNetwork(nextProfile.network);
    setCache(nextProfile.cache);
    setWatch(nextProfile.watch);
    setActiveProfileId(nextProfile.id);
    setProfileStatus(`${nextProfile.name} applied to the renderer terminal preview.`);
    setStatus(`${nextProfile.name} selected · no native toolchain was discovered`);
  }

  function saveToolchainProfile() {
    const name = profileName.trim();
    if (!name) return;
    const nextProfile: TerminalToolchainProfile = {
      id: `terminal-custom-${Date.now()}`,
      name,
      description: "A renderer-local snapshot of the current terminal command and run policy.",
      toolchainId,
      target,
      command,
      buildProfile,
      sandbox,
      network,
      cache,
      watch,
      custom: true,
    };
    setCustomProfiles((current) => [...current, nextProfile]);
    setActiveProfileId(nextProfile.id);
    setProfileName("");
    setProfileStatus(`${name} saved for this renderer session. Native profile persistence was not changed.`);
  }

  function removeToolchainProfile(nextProfile: TerminalToolchainProfile) {
    if (!nextProfile.custom) return;
    setCustomProfiles((current) => current.filter((profile) => profile.id !== nextProfile.id));
    setComparisonProfileIds((current) => [
      current[0] === nextProfile.id ? "terminal-node-test" : current[0],
      current[1] === nextProfile.id ? "terminal-python-data" : current[1],
    ]);
    if (activeProfileId === nextProfile.id) setActiveProfileId(null);
    setProfileStatus(`${nextProfile.name} removed from this renderer session.`);
  }

  function importToolchainProfiles() {
    const result = parseTerminalToolchainProfiles(profileImportDraft);
    if (result.profiles.length === 0) {
      setProfileImportStatus(result.warnings.join(" ") || "No importable profiles were found.");
      return;
    }
    const batch = profileImportBatch + 1;
    setProfileImportBatch(batch);
    const imported = result.profiles.map((profile, index) => ({
      ...profile,
      id: `terminal-import-${Date.now()}-${batch}-${index}`,
      custom: true as const,
    }));
    const existingNames = new Set(availableProfiles.map((profile) => profile.name.toLocaleLowerCase()));
    const uniqueImported = imported.map((profile, index) => {
      let name = profile.name;
      let suffix = 2;
      while (existingNames.has(name.toLocaleLowerCase())) {
        name = `${profile.name} (${suffix})`;
        suffix += 1;
      }
      existingNames.add(name.toLocaleLowerCase());
      return { ...profile, name, id: `${profile.id}-${index}` };
    });
    setCustomProfiles((current) => [...current, ...uniqueImported]);
    setProfileImportDraft("");
    const warningSummary = result.warnings.length > 0 ? ` ${result.warnings.join(" ")}` : "";
    setProfileImportStatus(`Imported ${uniqueImported.length} profile preview${uniqueImported.length === 1 ? "" : "s"} into this renderer session only.${warningSummary}`);
    setProfileStatus(`${uniqueImported.length} profile preview${uniqueImported.length === 1 ? "" : "s"} imported; nothing was persisted.`);
  }

  async function copyProfilePreview() {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setProfileExportStatus("Clipboard is unavailable; no toolchain profile preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(profileExportPayload);
      setProfileExportStatus(`Copied ${profileExportFormat === "json" ? "JSON" : "Markdown"} toolchain profile preview. No durable write was made.`);
    } catch {
      setProfileExportStatus("Clipboard access was denied; no toolchain profile preview was copied.");
    }
  }

  function downloadProfilePreview() {
    setProfileExportStatus(
      downloadTerminalToolchainProfile(profileExportPayload, profileExportFormat)
        ? `Downloaded ${profileExportFormat === "json" ? "JSON" : "Markdown"} renderer-local toolchain profile preview.`
        : "Browser download is unavailable; no toolchain profile preview was downloaded.",
    );
  }

  function runPreview() {
    const nextRun = runNumber + 1;
    setRunNumber(nextRun);
    setRunState("completed");
    setOutput(outputFor(toolchain, target, command.trim() || toolchain.command, projectName, filePath, nextRun));
    setStatus(`Preview run #${nextRun} completed · no process was started`);
  }

  function resetPreview() {
    setCatalogSelectedId("node");
    setToolchainId("node");
    setTarget("test");
    setCommand("npm run test -- src/main.test.ts");
    setBuildProfile("debug");
    setSandbox(true);
    setNetwork(false);
    setCache(true);
    setWatch(false);
    setActiveProfileId("terminal-node-test");
    setComparisonProfileIds(["terminal-node-test", "terminal-python-data"]);
    setRunState("idle");
    setOutput([...DEFAULT_OUTPUT]);
    setProfileStatus("Profiles stay in this renderer session.");
    setStatus("Terminal preview reset");
  }

  async function copyOutput() {
    const text = output.map((line) => line.text).join("\n");
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard unavailable · output remains visible in preview");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Preview output copied · renderer-local only");
    } catch {
      setStatus("Clipboard unavailable · output remains visible in preview");
    }
  }

  return (
    <section className="terminal-compiler-preview" aria-labelledby="terminal-compiler-preview-heading">
      <header className="terminal-compiler-preview__header">
        <div>
          <span className="eyebrow">Toolchain rehearsal</span>
          <h3 id="terminal-compiler-preview-heading">Terminal &amp; compiler preview</h3>
          <p>Shape commands, toolchains, and run policy before a native execution bridge is connected.</p>
        </div>
        <span className="terminal-compiler-preview__boundary"><ShieldCheck size={14} /> Preview only</span>
      </header>

      <div className="terminal-compiler-preview__profiles" aria-label="Terminal toolchain profiles">
        <div className="terminal-compiler-preview__profiles-heading">
          <span><strong>Toolchain profiles</strong><small>Save a reusable command, target, build mode, and run-policy snapshot.</small></span>
          <span className="terminal-compiler-preview__profiles-status">{profileStatus}</span>
        </div>
        <div className="terminal-compiler-preview__profile-list" role="list">
          {availableProfiles.map((profile) => {
            const selected = activeProfileId === profile.id;
            return <div className="terminal-compiler-preview__profile" role="listitem" key={profile.id}>
              <button type="button" className={`terminal-compiler-preview__profile-apply${selected ? " is-active" : ""}`} onClick={() => applyToolchainProfile(profile)} aria-pressed={selected} aria-label={`Apply ${profile.name} toolchain profile`}>
                <span className="terminal-compiler-preview__profile-mark"><Sparkles size={13} /></span>
                <span><strong>{profile.name}</strong><small>{profile.description}</small><em>{profile.toolchainId} · {profile.target} · {profile.buildProfile}</em></span>
              </button>
              {profile.custom ? <button type="button" className="terminal-compiler-preview__profile-remove" onClick={() => removeToolchainProfile(profile)} aria-label={`Remove ${profile.name} toolchain profile`}><Trash2 size={13} /></button> : null}
            </div>;
          })}
        </div>
        <section className="terminal-compiler-preview__compare" aria-label="Compare toolchain profiles">
          <div className="terminal-compiler-preview__compare-heading">
            <span><strong>Compare profiles</strong><small>Review command and run-policy differences before applying a profile.</small></span>
            <span className="terminal-compiler-preview__compare-count" aria-live="polite">{differenceCount} differences</span>
          </div>
          <div className="terminal-compiler-preview__compare-selects">
            {[0, 1].map((side) => (
              <label key={side}>
                <span>{side === 0 ? "Profile A" : "Profile B"}</span>
                <select
                  aria-label={`Compare profile ${side === 0 ? "A" : "B"}`}
                  value={comparisonProfileIds[side]!}
                  onChange={(event) => setComparisonProfileIds((current) => side === 0
                    ? [event.target.value, current[1]]
                    : [current[0], event.target.value])}
                >
                  {availableProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                </select>
              </label>
            ))}
          </div>
          <div className="terminal-compiler-preview__compare-table" role="table" aria-label="Toolchain profile differences">
            <div className="terminal-compiler-preview__compare-row terminal-compiler-preview__compare-row--head" role="row">
              <span role="columnheader">Setting</span>
              <span role="columnheader">{comparisonProfiles[0]?.name ?? "Profile A"}</span>
              <span role="columnheader">{comparisonProfiles[1]?.name ?? "Profile B"}</span>
            </div>
            {comparisonRows.map((row) => (
              <div className={`terminal-compiler-preview__compare-row${row.left !== row.right ? " is-different" : ""}`} role="row" key={row.label}>
                <strong role="rowheader">{row.label}</strong>
                <span role="cell">{row.left}</span>
                <span role="cell">{row.right}</span>
              </div>
            ))}
          </div>
          <p className="terminal-compiler-preview__compare-boundary">Comparison is renderer-local and descriptive; selecting profiles here does not apply them or authorize a command.</p>
        </section>
        <div className="terminal-compiler-preview__profile-create">
          <label><span>Save current profile as</span><input value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="e.g. Rust release check" aria-label="Toolchain profile name" /></label>
          <button type="button" className="button button--secondary" disabled={!profileName.trim()} onClick={saveToolchainProfile}><Plus size={13} /> Save profile</button>
        </div>
        <div className="terminal-compiler-preview__profile-export">
          <div><strong>Portable profile preview</strong><small>Take the visible session configuration with you; no credentials, native capability, or durable receipt is included.</small></div>
          <div className="terminal-compiler-preview__profile-export-actions">
            <label><span>Format</span><select value={profileExportFormat} onChange={(event) => setProfileExportFormat(event.target.value as TerminalToolchainProfileExportFormat)} aria-label="Toolchain profile export format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
            <button type="button" className="button button--secondary" onClick={() => void copyProfilePreview()}><Clipboard size={13} /> Copy</button>
            <button type="button" className="button button--secondary" onClick={downloadProfilePreview}><Download size={13} /> Download</button>
          </div>
          <p className="terminal-compiler-preview__profile-export-status">{profileExportStatus}</p>
          <pre aria-label="Terminal toolchain profile export preview">{profileExportPayload}</pre>
        </div>
        <div className="terminal-compiler-preview__profile-import">
          <div><strong>Import profile preview</strong><small>Paste a JSON export (up to 32 KB). Profiles are validated and added to this renderer session; commands are never executed.</small></div>
          <label><span className="sr-only">Terminal toolchain profile JSON to import</span><textarea value={profileImportDraft} onChange={(event) => setProfileImportDraft(event.target.value)} maxLength={32 * 1024} placeholder="Paste an omnia.terminal-toolchain-profile-preview.v1 JSON export…" aria-label="Terminal toolchain profile JSON to import" spellCheck={false} /></label>
          <div className="terminal-compiler-preview__profile-import-actions">
            <button type="button" className="button button--secondary" onClick={importToolchainProfiles} disabled={!profileImportDraft.trim()}>Import profile previews</button>
            <button type="button" className="button button--ghost" onClick={() => { setProfileImportDraft(""); setProfileImportStatus("Import draft cleared; saved profiles were not changed."); }} disabled={!profileImportDraft}>Clear</button>
          </div>
          <p className="terminal-compiler-preview__profile-export-status" aria-label="Terminal profile import status" aria-live="polite">{profileImportStatus}</p>
        </div>
      </div>

      <div className="terminal-compiler-preview__toolchain-grid">
        <label className="terminal-compiler-preview__field"><span>Toolchain</span><select value={toolchainId} onChange={(event) => selectToolchain(event.target.value as ToolchainId)} aria-label="Compiler toolchain">{TOOLCHAINS.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.version}</option>)}</select><small>{toolchain.accent}</small></label>
        <label className="terminal-compiler-preview__field"><span>Target</span><select value={target} onChange={(event) => { markProfileEdited(); setTarget(event.target.value as TargetId); setStatus("Target changed · preview command remains editable"); }} aria-label="Compiler target">{TARGETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select><small>{selectedTarget.description}</small></label>
        <label className="terminal-compiler-preview__field"><span>Build profile</span><select value={buildProfile} onChange={(event) => { markProfileEdited(); setBuildProfile(event.target.value as TerminalBuildProfile); setStatus("Build profile changed · native compiler remains unavailable"); }} aria-label="Compiler profile"><option value="debug">Debug · fast feedback</option><option value="release">Release · optimized plan</option><option value="research">Research · verbose evidence</option></select><small>Renderer policy: {buildProfile}</small></label>
      </div>

      <div className="terminal-compiler-preview__command-row">
        <label className="terminal-compiler-preview__command"><TerminalSquare size={14} /><span className="sr-only">Preview command</span><input value={command} onChange={(event) => { markProfileEdited(); setCommand(event.target.value); setStatus("Command edited · native execution remains unavailable"); }} spellCheck={false} aria-label="Preview command" /></label>
        <button type="button" className="button button--secondary" onClick={runPreview}><Play size={14} /> Run command preview</button>
        <button type="button" className="button button--ghost" onClick={resetPreview} aria-label="Reset terminal compiler preview"><RotateCcw size={14} /> Reset</button>
      </div>

      <div className="terminal-compiler-preview__options" role="group" aria-label="Compiler run options">
        <label><input type="checkbox" checked={sandbox} onChange={(event) => { markProfileEdited(); setSandbox(event.target.checked); }} /> Sandbox rehearsal</label>
        <label><input type="checkbox" checked={network} onChange={(event) => { markProfileEdited(); setNetwork(event.target.checked); }} /> Request network</label>
        <label><input type="checkbox" checked={cache} onChange={(event) => { markProfileEdited(); setCache(event.target.checked); }} /> Reuse cache</label>
        <label><input type="checkbox" checked={watch} onChange={(event) => { markProfileEdited(); setWatch(event.target.checked); }} /> Watch mode</label>
      </div>

      <div className="terminal-compiler-preview__body">
        <div className="terminal-compiler-preview__output" role="region" aria-label="Terminal preview output">
          <div className="terminal-compiler-preview__output-header"><span><span className={runState === "completed" ? "status-dot status-dot--success" : "status-dot"} />{runState === "completed" ? "Completed preview" : "Idle terminal"}</span><div><small>{capabilitySummary}</small><button type="button" className="button button--ghost" onClick={() => setOutput([])} disabled={output.length === 0} aria-label="Clear terminal preview output"><Trash2 size={13} /> Clear</button><button type="button" className="button button--ghost" onClick={() => void copyOutput()} disabled={output.length === 0}><Copy size={13} /> Copy</button></div></div>
          <pre className="terminal-compiler-preview__log" aria-label="Terminal preview log">{output.length > 0 ? output.map((line) => <span key={line.id} className={`terminal-compiler-preview__line terminal-compiler-preview__line--${line.kind}`}>{line.kind === "stdout" ? <CheckCircle2 size={12} /> : line.kind === "stderr" ? <AlertTriangle size={12} /> : <Zap size={12} />}<code>{line.text}</code></span>) : <span className="terminal-compiler-preview__empty"><PackageCheck size={17} />Output cleared · run a preview when ready.</span>}</pre>
        </div>
        <aside className="terminal-compiler-preview__catalog" aria-label="Toolchain catalog">
          <div className="terminal-compiler-preview__matrix-header"><span><PackageCheck size={14} /> Ecosystem catalog</span><small>{TOOLCHAIN_CATALOG.length} entries · preview</small></div>
          <label className="terminal-compiler-preview__catalog-search"><Search size={13} /><span className="sr-only">Search toolchains</span><input value={catalogQuery} onChange={(event) => setCatalogQuery(event.target.value)} placeholder="Search language, domain, command…" aria-label="Search toolchains" /></label>
          <div className="terminal-compiler-preview__catalog-filters" role="group" aria-label="Filter toolchain catalog">
            {CATALOG_FILTERS.map((filter) => <button type="button" key={filter.id} className={catalogFilter === filter.id ? "is-active" : ""} aria-pressed={catalogFilter === filter.id} onClick={() => setCatalogFilter(filter.id)}><Filter size={11} />{filter.label}</button>)}
          </div>
          <div className="terminal-compiler-preview__catalog-layout">
            <div className="terminal-compiler-preview__catalog-list" aria-label="Toolchains">
              {visibleCatalogEntries.map((entry) => <button type="button" key={entry.id} className={`terminal-compiler-preview__catalog-card${entry.id === catalogSelectedId ? " is-active" : ""}`} aria-pressed={entry.id === catalogSelectedId} onClick={() => setCatalogSelectedId(entry.id)}>
                <span><strong>{entry.name}</strong><small>{entry.family}</small></span>
                <em className={entry.previewToolchainId ? "is-template" : "is-planned"}>{entry.previewToolchainId ? "Template" : "Planned"}</em>
              </button>)}
              {visibleCatalogEntries.length === 0 ? <p className="terminal-compiler-preview__catalog-empty">No toolchains match this filter.</p> : null}
            </div>
            <section className="terminal-compiler-preview__catalog-detail" aria-label={`${selectedCatalogEntry.name} catalog details`}>
              <header><div><span className="eyebrow">{selectedCatalogEntry.previewToolchainId ? "Command template" : "Catalog idea"}</span><h4>{selectedCatalogEntry.name}</h4></div><span className={`terminal-compiler-preview__catalog-state${selectedCatalogEntry.previewToolchainId ? " is-template" : " is-planned"}`}>{selectedCatalogEntry.previewToolchainId ? "Template only" : "Planned"}</span></header>
              <p>{selectedCatalogEntry.description}</p>
              <div className="terminal-compiler-preview__catalog-fact"><small>Languages &amp; ecosystem</small><strong>{selectedCatalogEntry.family}</strong></div>
              <div className="terminal-compiler-preview__catalog-fact"><small>Example command</small><code>{selectedCatalogEntry.command}</code></div>
              {selectedCatalogEntry.previewToolchainId ? <button type="button" className="button button--secondary" onClick={() => useCatalogEntry(selectedCatalogEntry)}><TerminalSquare size={13} /> Use template in rehearsal</button> : <button type="button" className="button button--secondary" disabled title="Native toolchain discovery and execution are planned">Native support planned</button>}
              <p className="terminal-compiler-preview__catalog-boundary"><ShieldCheck size={13} /> {selectedCatalogEntry.previewToolchainId ? "Template does not mean installed or detected." : "Catalog entry only; no runtime was bundled, detected, or invoked."} Native compiler discovery, PATH resolution, terminal process launch, and artifact writes remain Planned; installation, process launch, and filesystem access are not connected.</p>
            </section>
          </div>
        </aside>
      </div>

      <p className="terminal-compiler-preview__status" role="status" aria-live="polite">{status}</p>
      <p className="terminal-compiler-preview__boundary-note"><Clipboard size={14} /> Renderer-local only · no shell/process spawn · no compiler invocation · no network request · no filesystem read/write · no durable run receipt.</p>
    </section>
  );
}
