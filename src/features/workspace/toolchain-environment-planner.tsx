import { useMemo, useState } from "react";
import { Box, Braces, Check, Clipboard, Download, Gauge, Package, RotateCcw, ShieldCheck, Sparkles } from "lucide-react";

type RuntimeId = "node" | "python" | "rust" | "llvm" | "go" | "jdk" | "julia" | "cuda";
type BlueprintPreset = "web-app" | "systems-cp" | "research-ai";
type TargetPlatform = "windows-x64" | "windows-arm64" | "linux-x64" | "wsl2";
type InstallScope = "project-cache" | "user-managed" | "portable";
type ArtifactKind = "native-binary" | "wasm" | "library" | "container" | "notebook";

type RuntimeOption = {
  id: RuntimeId;
  label: string;
  family: string;
  defaultVersion: string;
  sizeGiB: number;
  command: string;
  tint: "blue" | "green" | "amber" | "coral" | "teal" | "steel";
};

const RUNTIMES: readonly RuntimeOption[] = [
  { id: "node", label: "Node.js", family: "JS · TS · web", defaultVersion: "22 LTS", sizeGiB: 0.4, command: "node --version", tint: "blue" },
  { id: "python", label: "Python", family: "Data · AI · scripting", defaultVersion: "3.12", sizeGiB: 0.8, command: "python --version", tint: "green" },
  { id: "rust", label: "Rust", family: "Cargo · native", defaultVersion: "stable", sizeGiB: 1.8, command: "rustc --version", tint: "coral" },
  { id: "llvm", label: "LLVM / Clang", family: "C · C++ · Fortran", defaultVersion: "19", sizeGiB: 2.4, command: "clang++ --version", tint: "amber" },
  { id: "go", label: "Go", family: "Services · concurrency", defaultVersion: "1.24", sizeGiB: 0.6, command: "go version", tint: "teal" },
  { id: "jdk", label: "JDK", family: "Java · JVM", defaultVersion: "21 LTS", sizeGiB: 1.2, command: "java --version", tint: "steel" },
  { id: "julia", label: "Julia", family: "Numerical · science", defaultVersion: "1.11 LTS", sizeGiB: 1.1, command: "julia --version", tint: "green" },
  { id: "cuda", label: "CUDA Toolkit", family: "GPU · research", defaultVersion: "12.8", sizeGiB: 5.5, command: "nvcc --version", tint: "amber" },
];

const PRESETS: Record<BlueprintPreset, { label: string; description: string; runtimes: RuntimeId[]; artifact: ArtifactKind }> = {
  "web-app": { label: "Web app", description: "Lean JS/TS feedback loop with room for a Python sidecar.", runtimes: ["node", "python"], artifact: "wasm" },
  "systems-cp": { label: "Systems & CP", description: "Native compiler pair with fast, repeatable local builds.", runtimes: ["rust", "llvm", "go"], artifact: "native-binary" },
  "research-ai": { label: "Research & AI", description: "Python and Julia base; GPU toolkit is an optional large layer.", runtimes: ["python", "julia"], artifact: "notebook" },
};

const DEFAULT_VERSIONS = Object.fromEntries(RUNTIMES.map((runtime) => [runtime.id, runtime.defaultVersion])) as Record<RuntimeId, string>;
const DEFAULT_SELECTED: RuntimeId[] = [...PRESETS["web-app"].runtimes];

function formatSize(value: number): string {
  return `${value.toFixed(value < 1 ? 1 : 1)} GiB`;
}

function packageLabel(source: string): string {
  return source === "winget" ? "WinGet" : source === "scoop" ? "Scoop" : source === "choco" ? "Chocolatey" : "Manual / vendor";
}

export function ToolchainEnvironmentPlanner() {
  const [preset, setPreset] = useState<BlueprintPreset>("web-app");
  const [selected, setSelected] = useState<RuntimeId[]>(DEFAULT_SELECTED);
  const [versions, setVersions] = useState<Record<RuntimeId, string>>(DEFAULT_VERSIONS);
  const [platform, setPlatform] = useState<TargetPlatform>("windows-x64");
  const [scope, setScope] = useState<InstallScope>("project-cache");
  const [packageSource, setPackageSource] = useState("winget");
  const [artifact, setArtifact] = useState<ArtifactKind>(PRESETS["web-app"].artifact);
  const [cachePath, setCachePath] = useState(".omnia/toolchains");
  const [cacheBudget, setCacheBudget] = useState("8");
  const [parallelJobs, setParallelJobs] = useState("4");
  const [networkCache, setNetworkCache] = useState(true);
  const [debugSymbols, setDebugSymbols] = useState(false);
  const [planReady, setPlanReady] = useState(false);
  const [status, setStatus] = useState("Blueprint is renderer-local. Nothing is installed or detected.");

  const selectedRuntimes = useMemo(() => RUNTIMES.filter((runtime) => selected.includes(runtime.id)), [selected]);
  const estimatedSize = selectedRuntimes.reduce((total, runtime) => total + runtime.sizeGiB, 0);
  const targetLabel = platform.replaceAll("-", " ").toUpperCase();
  const blueprint = useMemo(() => ({
    schema: "omnia.toolchain-environment-blueprint.preview.v1",
    disposition: "preview-only",
    preset,
    runtimes: selectedRuntimes.map((runtime) => ({ id: runtime.id, name: runtime.label, version: versions[runtime.id], estimatedGiB: runtime.sizeGiB })),
    targetPlatform: platform,
    installScope: scope,
    packageSource,
    artifact,
    cache: { path: cachePath, budgetGiB: Number(cacheBudget), reuseNetworkCache: networkCache },
    build: { parallelJobs: Number(parallelJobs), debugSymbols },
    estimatedRuntimeGiB: Number(estimatedSize.toFixed(1)),
    nativeDiscovery: "not-connected",
    executionDisposition: "preview-only",
  }), [artifact, cacheBudget, cachePath, debugSymbols, estimatedSize, networkCache, packageSource, parallelJobs, platform, preset, scope, selectedRuntimes, versions]);
  const exportText = JSON.stringify(blueprint, null, 2);

  function applyPreset(nextPreset: BlueprintPreset) {
    setPreset(nextPreset);
    setSelected(PRESETS[nextPreset].runtimes);
    setArtifact(PRESETS[nextPreset].artifact);
    setPlanReady(false);
    setStatus(`${PRESETS[nextPreset].label} blueprint loaded · editable preview only`);
  }

  function toggleRuntime(id: RuntimeId) {
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
    setPreset("web-app");
    setPlanReady(false);
    setStatus("Runtime selection changed · plan preview is out of date");
  }

  function reset() {
    setPreset("web-app");
    setSelected(DEFAULT_SELECTED);
    setVersions(DEFAULT_VERSIONS);
    setPlatform("windows-x64");
    setScope("project-cache");
    setPackageSource("winget");
    setArtifact(PRESETS["web-app"].artifact);
    setCachePath(".omnia/toolchains");
    setCacheBudget("8");
    setParallelJobs("4");
    setNetworkCache(true);
    setDebugSymbols(false);
    setPlanReady(false);
    setStatus("Blueprint reset to defaults · no machine state changed");
  }

  async function copyBlueprint() {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard unavailable · export preview remains visible");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportText);
      setStatus("Blueprint JSON copied · renderer-local only");
    } catch {
      setStatus("Clipboard access denied · no blueprint was copied");
    }
  }

  function downloadBlueprint() {
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      setStatus("Download unavailable · export preview remains visible");
      return;
    }
    const url = URL.createObjectURL(new Blob([exportText], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "omnia-toolchain-blueprint.preview.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus("Blueprint downloaded · export only, no native install plan was dispatched");
  }

  return (
    <section className="toolchain-blueprint" aria-labelledby="toolchain-blueprint-heading">
      <header className="toolchain-blueprint__header">
        <div>
          <span className="eyebrow"><Sparkles size={13} /> Environment design</span>
          <h3 id="toolchain-blueprint-heading">Toolchain &amp; Compiler Lab</h3>
          <p>Compose a portable runtime matrix, provisioning policy, and build target before native setup exists.</p>
        </div>
        <span className="toolchain-blueprint__badge"><ShieldCheck size={13} /> Preview only</span>
      </header>

      <div className="toolchain-blueprint__presets" role="group" aria-label="Environment blueprint presets">
        {(Object.entries(PRESETS) as Array<[BlueprintPreset, typeof PRESETS[BlueprintPreset]]>).map(([id, item]) => (
          <button key={id} type="button" className={preset === id ? "is-active" : ""} aria-pressed={preset === id} onClick={() => applyPreset(id)}>
            <span><strong>{item.label}</strong><small>{item.description}</small></span><Check size={14} />
          </button>
        ))}
      </div>

      <div className="toolchain-blueprint__summary" aria-live="polite">
        <span><Package size={15} /><strong>{selectedRuntimes.length}</strong><small>runtimes</small></span>
        <span><Box size={15} /><strong>{formatSize(estimatedSize)}</strong><small>estimated</small></span>
        <span><Gauge size={15} /><strong>{parallelJobs}</strong><small>build jobs</small></span>
        <span className="toolchain-blueprint__summary-target"><Braces size={15} /><strong>{artifact.replaceAll("-", " ")}</strong><small>{targetLabel}</small></span>
      </div>

      <div className="toolchain-blueprint__layout">
        <section className="toolchain-blueprint__runtime-panel" aria-label="Runtime and compiler selection">
          <div className="toolchain-blueprint__section-heading"><span><strong>Runtime matrix</strong><small>Choose components and pin the version you want in the future install.</small></span><span>{selected.length} selected</span></div>
          <div className="toolchain-blueprint__runtime-list">
            {RUNTIMES.map((runtime) => {
              const isSelected = selected.includes(runtime.id);
              return <article className={`toolchain-blueprint__runtime-card toolchain-blueprint__runtime-card--${runtime.tint}${isSelected ? " is-selected" : ""}`} key={runtime.id}>
                <label className="toolchain-blueprint__runtime-toggle"><input type="checkbox" checked={isSelected} onChange={() => toggleRuntime(runtime.id)} /><span><strong>{runtime.label}</strong><small>{runtime.family}</small></span><em>{formatSize(runtime.sizeGiB)}</em></label>
                <label className="toolchain-blueprint__version"><span>Version pin</span><input aria-label={`${runtime.label} version pin`} value={versions[runtime.id]} onChange={(event) => { setVersions((current) => ({ ...current, [runtime.id]: event.target.value })); setPlanReady(false); }} disabled={!isSelected} /></label>
              </article>;
            })}
          </div>
          {selected.length === 0 ? <p className="toolchain-blueprint__warning" role="alert">Select at least one runtime to prepare a blueprint.</p> : null}
        </section>

        <section className="toolchain-blueprint__policy" aria-label="Provisioning and build policy">
          <div className="toolchain-blueprint__section-heading"><span><strong>Provisioning policy</strong><small>Editable defaults for a later managed-toolchain phase.</small></span><span className="toolchain-blueprint__planned">Planned</span></div>
          <div className="toolchain-blueprint__fields">
            <label><span>Target platform</span><select value={platform} onChange={(event) => { setPlatform(event.target.value as TargetPlatform); setPlanReady(false); }} aria-label="Toolchain target platform"><option value="windows-x64">Windows · x64</option><option value="windows-arm64">Windows · ARM64</option><option value="linux-x64">Linux · x64</option><option value="wsl2">WSL2 · Linux environment</option></select></label>
            <label><span>Install scope</span><select value={scope} onChange={(event) => { setScope(event.target.value as InstallScope); setPlanReady(false); }} aria-label="Toolchain install scope"><option value="project-cache">Project-local cache</option><option value="user-managed">User profile</option><option value="portable">Portable bundle</option></select></label>
            <label><span>Package source</span><select value={packageSource} onChange={(event) => { setPackageSource(event.target.value); setPlanReady(false); }} aria-label="Toolchain package source"><option value="winget">WinGet · Windows</option><option value="scoop">Scoop</option><option value="choco">Chocolatey</option><option value="manual">Vendor / manual</option></select></label>
            <label><span>Build artifact</span><select value={artifact} onChange={(event) => { setArtifact(event.target.value as ArtifactKind); setPlanReady(false); }} aria-label="Compiler artifact target"><option value="native-binary">Native executable</option><option value="wasm">WebAssembly</option><option value="library">Library package</option><option value="container">Container image</option><option value="notebook">Notebook environment</option></select></label>
            <label className="toolchain-blueprint__wide-field"><span>Project cache root</span><input value={cachePath} onChange={(event) => { setCachePath(event.target.value); setPlanReady(false); }} aria-label="Toolchain cache root" /></label>
            <label><span>Cache budget · GiB</span><input type="number" min="1" max="1024" value={cacheBudget} onChange={(event) => { setCacheBudget(event.target.value); setPlanReady(false); }} aria-label="Toolchain cache budget" /></label>
            <label><span>Parallel build jobs</span><input type="number" min="1" max="128" value={parallelJobs} onChange={(event) => { setParallelJobs(event.target.value); setPlanReady(false); }} aria-label="Parallel build jobs" /></label>
          </div>
          <div className="toolchain-blueprint__toggles" role="group" aria-label="Build environment options">
            <label><input type="checkbox" checked={networkCache} onChange={(event) => { setNetworkCache(event.target.checked); setPlanReady(false); }} /> Allow package cache downloads</label>
            <label><input type="checkbox" checked={debugSymbols} onChange={(event) => { setDebugSymbols(event.target.checked); setPlanReady(false); }} /> Include debug symbols</label>
          </div>
          <div className="toolchain-blueprint__source"><ShieldCheck size={14} /><span><strong>{packageLabel(packageSource)} source · {scope.replaceAll("-", " ")}</strong><small>Network access, package trust, checksums, storage grants, and rollback still need a native reviewed provisioning bridge.</small></span></div>
        </section>
      </div>

      <div className="toolchain-blueprint__actions">
        <button type="button" className="button button--secondary" onClick={() => { setPlanReady(selected.length > 0); setStatus(selected.length > 0 ? "Provisioning plan preview prepared · no installer or compiler was started" : "Choose at least one runtime before preparing a plan"); }} disabled={selected.length === 0}><Package size={14} /> Prepare install plan</button>
        <button type="button" className="button button--ghost" onClick={reset}><RotateCcw size={14} /> Reset defaults</button>
        <button type="button" className="button button--ghost" onClick={() => void copyBlueprint()}><Clipboard size={14} /> Copy blueprint</button>
        <button type="button" className="button button--ghost" onClick={downloadBlueprint}><Download size={14} /> Download JSON</button>
        <span className="toolchain-blueprint__status" role="status" aria-live="polite">{status}</span>
      </div>

      {planReady ? <div className="toolchain-blueprint__plan" role="region" aria-label="Toolchain provisioning plan preview">
        <div className="toolchain-blueprint__plan-heading"><span><strong>Provisioning sequence</strong><small>Prepared from current choices · planned only</small></span><span className="toolchain-blueprint__planned">No commands executed</span></div>
        <ol>{[
          `Reserve ${formatSize(estimatedSize)} runtime estimate in ${cachePath || "(cache root not set)"}`,
          `Resolve ${selectedRuntimes.length} pinned package${selectedRuntimes.length === 1 ? "" : "s"} from ${packageLabel(packageSource)} for ${targetLabel}`,
          `${networkCache ? "Fetch and verify" : "Use existing cache only for"} selected toolchain archives · checksum policy pending native bridge`,
          `Generate ${artifact.replaceAll("-", " ")} build profile with ${parallelJobs || "0"} parallel jobs${debugSymbols ? " and debug symbols" : ""}`,
        ].map((step, index) => <li key={step}><span>{String(index + 1).padStart(2, "0")}</span>{step}</li>)}</ol>
      </div> : null}

      <details className="toolchain-blueprint__export">
        <summary>Portable environment blueprint <span>JSON · exportable</span></summary>
        <pre aria-label="Toolchain environment blueprint JSON preview">{exportText}</pre>
      </details>
      <p className="toolchain-blueprint__boundary"><ShieldCheck size={13} /> Renderer-local only · no PATH scan · no package-manager call · no shell/process · no download · no disk write · no native compiler or runtime bundled.</p>
    </section>
  );
}
