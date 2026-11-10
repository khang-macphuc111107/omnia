import { describe, expect, it } from "vitest";

import {
  analyzeIdeCodeBuffer,
  computeUnifiedDiffLines,
  createDiskTransferJob,
  createRemoteInputPacket,
  DEFAULT_DISK_VOLUMES,
  DEFAULT_IDE_WORKSPACE_FILES,
  DEFAULT_OMNIA_REMOTE_DAEMON_CONFIG,
  DEFAULT_REMOTE_CAPTURE_SURFACES,
  extractCodeOutlineSymbols,
  findRemoteCaptureSurface,
  generateOmniParserSomTargets,
  inferIdeLanguageFromPath,
  planComputerUseActionSequence,
  searchWorkspaceFilesRipgrep,
  toDesktopIsolatedInputEvent,
  type IdeVirtualFile,
} from "@/domain/sovereign-ide-remote-desktop";

describe("sovereign-ide-remote-desktop domain", () => {
  describe("Integrated Polyglot IDE Engine", () => {
    it("provides default polyglot IDE workspace files across all 6 languages", () => {
      expect(DEFAULT_IDE_WORKSPACE_FILES.length).toBeGreaterThanOrEqual(6);
      const languages = new Set(DEFAULT_IDE_WORKSPACE_FILES.map((file) => file.language));
      expect(languages.has("typescript")).toBe(true);
      expect(languages.has("rust")).toBe(true);
      expect(languages.has("python")).toBe(true);
      expect(languages.has("powershell")).toBe(true);
      expect(languages.has("json")).toBe(true);
      expect(languages.has("markdown")).toBe(true);
    });

    it("analyzes TypeScript, Rust, Python, and PowerShell buffers for symbol counts, bracket balance, and quick-run commands", () => {
      const tsFile = DEFAULT_IDE_WORKSPACE_FILES.find((f) => f.language === "typescript")!;
      const tsAnalysis = analyzeIdeCodeBuffer(tsFile);
      expect(tsAnalysis.lineCount).toBe(15);
      expect(tsAnalysis.symbols.exports).toBeGreaterThanOrEqual(3);
      expect(tsAnalysis.symbols.consts).toBeGreaterThanOrEqual(1);
      expect(tsAnalysis.symbols.functions).toBeGreaterThanOrEqual(1);
      expect(tsAnalysis.symbolCount).toBeGreaterThanOrEqual(5);
      expect(tsAnalysis.balanced).toBe(true);
      expect(tsAnalysis.bracketBalance.balanced).toBe(true);
      expect(tsAnalysis.bracketBalanceStatus).toBe("balanced");
      expect(tsAnalysis.quickRunCommand).toContain("npx vitest");

      const rustFile = DEFAULT_IDE_WORKSPACE_FILES.find((f) => f.language === "rust")!;
      const rustAnalysis = analyzeIdeCodeBuffer(rustFile);
      expect(rustAnalysis.symbols.structs).toBe(1);
      expect(rustAnalysis.symbols.rustFns).toBe(2);
      expect(rustAnalysis.balanced).toBe(true);
      expect(rustAnalysis.quickRunCommand).toContain("cargo test");

      const pyFile = DEFAULT_IDE_WORKSPACE_FILES.find((f) => f.language === "python")!;
      const pyAnalysis = analyzeIdeCodeBuffer(pyFile);
      expect(pyAnalysis.symbols.pythonDefs).toBe(2);
      expect(pyAnalysis.balanced).toBe(true);
      expect(pyAnalysis.quickRunCommand).toContain("python");

      const psFile = DEFAULT_IDE_WORKSPACE_FILES.find((f) => f.language === "powershell")!;
      const psAnalysis = analyzeIdeCodeBuffer(psFile);
      expect(psAnalysis.symbols.functions).toBe(1);
      expect(psAnalysis.balanced).toBe(true);
      expect(psAnalysis.quickRunCommand).toContain("pwsh");
    });

    it("detects unbalanced brackets and JSON syntax issues accurately", () => {
      const brokenFile: IdeVirtualFile = {
        path: "src/broken.ts",
        language: "typescript",
        content: "export function broken(a: number) {\n  const x = [1, 2;\n",
        isModified: true,
        lineCount: 3,
        lastSavedAt: "2026-10-18T18:55:00.000Z",
      };
      const analysis = analyzeIdeCodeBuffer(brokenFile);
      expect(analysis.balanced).toBe(false);
      expect(analysis.bracketBalance.balanced).toBe(false);
      expect(analysis.bracketBalanceStatus).toBe("unbalanced");
      expect(analysis.bracketBalance.curlyDelta).toBe(1);
      expect(analysis.bracketBalance.squareDelta).toBe(1);
      expect(analysis.diagnostics.length).toBeGreaterThan(0);
    });

    it("infers language from file extension", () => {
      expect(inferIdeLanguageFromPath("src-tauri/src/lib.rs")).toBe("rust");
      expect(inferIdeLanguageFromPath("scripts/check.py")).toBe("python");
      expect(inferIdeLanguageFromPath("scripts/deploy.ps1")).toBe("powershell");
      expect(inferIdeLanguageFromPath("package.json")).toBe("json");
      expect(inferIdeLanguageFromPath("README.md")).toBe("markdown");
      expect(inferIdeLanguageFromPath("src/App.tsx")).toBe("typescript");
    });

    it("extracts AST outline symbols with line numbers across TypeScript, Rust, and Python", () => {
      const tsFile = DEFAULT_IDE_WORKSPACE_FILES.find((f) => f.language === "typescript")!;
      const tsOutline = extractCodeOutlineSymbols(tsFile.content, tsFile.language);
      expect(tsOutline.map((s) => s.name)).toEqual([
        "SovereignRuntimeProbe",
        "DEFAULT_RUNTIME_PROBE",
        "verifySovereignBridge",
      ]);
      expect(tsOutline[0]?.kind).toBe("interface");
      expect(tsOutline[0]?.lineLabel).toBe("Ln 1");
      expect(tsOutline[2]?.kind).toBe("function");
      expect(tsOutline[2]?.line).toBe(13);

      const rustFile = DEFAULT_IDE_WORKSPACE_FILES.find((f) => f.language === "rust")!;
      const rustOutline = extractCodeOutlineSymbols(rustFile.content, rustFile.language);
      expect(rustOutline.map((s) => `${s.kind}:${s.name}`)).toEqual([
        "struct:Win32IsolatedPostMessageFrame",
        "function:encode_lparam_coords",
        "function:dispatch_unfocused_window_input",
      ]);

      const pyFile = DEFAULT_IDE_WORKSPACE_FILES.find((f) => f.language === "python")!;
      const pyOutline = extractCodeOutlineSymbols(pyFile.content, pyFile.language);
      expect(pyOutline.map((s) => s.name)).toEqual([
        "validate_sovereign_disk_mounts",
        "compute_cluster_health_score",
      ]);
    });

    it("computes unified line-by-line git diffs for added, removed, and unchanged lines", () => {
      const original = ["const a = 1;", "const b = 2;", "return a + b;"].join("\n");
      const modified = ["const a = 1;", "const b = 42;", "const c = 3;", "return a + b;"].join("\n");

      const diff = computeUnifiedDiffLines(original, modified);
      const removed = diff.filter((line) => line.kind === "removed");
      const added = diff.filter((line) => line.kind === "added");
      const unchanged = diff.filter((line) => line.kind === "unchanged");

      expect(unchanged).toHaveLength(2);
      expect(removed).toHaveLength(1);
      expect(removed[0]?.content).toBe("const b = 2;");
      expect(removed[0]?.prefix).toBe("-");
      expect(added).toHaveLength(2);
      expect(added.map((l) => l.content)).toEqual(["const b = 42;", "const c = 3;"]);
    });

    it("searches workspace files with Ripgrep query and regex support", () => {
      const literalMatches = searchWorkspaceFilesRipgrep(
        DEFAULT_IDE_WORKSPACE_FILES,
        "SovereignRuntimeProbe",
      );
      expect(literalMatches.length).toBeGreaterThanOrEqual(2);
      expect(literalMatches[0]?.path).toBe("src/domain/sovereign-ide-remote-desktop.ts");
      expect(literalMatches[0]?.line).toBe(1);

      const regexMatches = searchWorkspaceFilesRipgrep(
        DEFAULT_IDE_WORKSPACE_FILES,
        "pub\\s+(struct|fn)\\s+\\w+",
        { regex: true },
      );
      expect(regexMatches).toHaveLength(3);
      expect(regexMatches.every((m) => m.language === "rust")).toBe(true);
    });
  });

  describe("Multi-Monitor & Per-Window Screen Share + Remote Desktop Input Engine", () => {
    it("includes all 7 required multi-monitor, single-display, and application-window capture surfaces", () => {
      const ids = DEFAULT_REMOTE_CAPTURE_SURFACES.map((s) => s.id);
      expect(ids).toEqual([
        "panorama-all-monitors",
        "display-1-acer-nitro",
        "display-2-external-4k",
        "window-omnia-sovereign",
        "window-chrome-canary",
        "window-edge",
        "window-powershell",
      ]);

      const panorama = findRemoteCaptureSurface("panorama-all-monitors");
      expect(panorama.resolutionWidth).toBe(5760);
      expect(panorama.resolutionHeight).toBe(2160);
      expect(panorama.kind).toBe("multi-monitor-panorama");

      const chromeWindow = findRemoteCaptureSurface("window-chrome-canary");
      expect(chromeWindow.windowHandleHex).toBe("0x002204F0");
      expect(chromeWindow.processName).toBe("chrome.exe");
      expect(chromeWindow.supportsIsolatedPostMessageInput).toBe(true);
    });

    it("normalizes and clamps remote mouse coordinates within surface bounds and generates Win32 PostMessage frame hex", () => {
      const packet = createRemoteInputPacket({
        surfaceId: "display-1-acer-nitro",
        type: "mouse-click",
        x: 2450.7,
        y: -45,
        deliveryMethod: "win32-postmessage-isolated",
      });

      expect(packet.x).toBe(1919);
      expect(packet.y).toBe(0);
      expect(packet.clamped).toBe(true);
      expect(packet.win32MessageHex).toContain("0x0201");
      expect(packet.lParamHex).toBe("0x0000077F");
      expect(packet.id).toMatch(/^rip-[0-9a-f]{8}$/);

      const desktopEvent = toDesktopIsolatedInputEvent(packet);
      expect(desktopEvent).toEqual({
        kind: "pointer",
        phase: "down",
        x: 1919,
        y: 0,
        button: "left",
      });
    });

    it("creates remote keyboard chord and text packets and maps them to desktop isolated input events", () => {
      const chordPacket = createRemoteInputPacket({
        surfaceId: "window-chrome-canary",
        type: "key-chord",
        keyOrChord: "Ctrl+Shift+I",
        deliveryMethod: "win32-postmessage-isolated",
      });

      expect(chordPacket.keyOrChord).toBe("Ctrl+Shift+I");
      expect(chordPacket.win32MessageHex).toContain("WM_KEYDOWN");

      const desktopKeyEvent = toDesktopIsolatedInputEvent(chordPacket);
      expect(desktopKeyEvent.kind).toBe("keyboard");
      if (desktopKeyEvent.kind === "keyboard") {
        expect(desktopKeyEvent.phase).toBe("down");
        expect(desktopKeyEvent.modifiers).toEqual(["ctrl", "shift"]);
      }
    });

    it("generates OmniParser v2 Set-of-Marks (SoM) bounding-box targets and plans Computer-Use action sequences", () => {
      const targets = generateOmniParserSomTargets("window-chrome-canary");
      expect(targets).toHaveLength(6);
      expect(targets[0]?.tag).toBe("[#1]");
      expect(targets[0]?.hwnd).toBe("0x002204F0");
      expect(targets[0]?.bounds.width).toBeGreaterThan(0);
      expect(targets[0]?.confidence).toBeGreaterThanOrEqual(0.9);

      const plan = planComputerUseActionSequence(
        "npx vitest run",
        targets,
        "win32-postmessage-isolated",
      );
      expect(plan).toHaveLength(3);
      expect(plan[0]?.tag).toBe("[#1]");
      expect(plan[1]?.actionType).toBe("key-type");
      expect(plan[1]?.packet.text).toBe("npx vitest run");
      expect(plan[2]?.actionType).toBe("mouse-click");
    });
  });

  describe("Remote & Local Disk / Volume Explorer Engine", () => {
    it("accurately models C:\\, D:\\, and Z:\\ (Remote Sovereign Node) disk volumes", () => {
      expect(DEFAULT_DISK_VOLUMES).toHaveLength(3);

      const volC = DEFAULT_DISK_VOLUMES.find((v) => v.mountPoint.startsWith("C:\\"))!;
      expect(volC.freeGb).toBe(201.96);
      expect(volC.totalGb).toBe(475.53);
      expect(volC.location).toBe("local-host");

      const volD = DEFAULT_DISK_VOLUMES.find((v) => v.mountPoint.startsWith("D:\\"))!;
      expect(volD.freeGb).toBe(324.82);
      expect(volD.totalGb).toBe(953.65);
      expect(volD.entries.some((e) => e.path === "D:\\Omnia\\repos\\omnia")).toBe(true);
      expect(volD.entries.some((e) => e.path === "D:\\Omnia\\models")).toBe(true);

      const volZ = DEFAULT_DISK_VOLUMES.find((v) => v.mountPoint.startsWith("Z:\\"))!;
      expect(volZ.freeGb).toBe(1420.0);
      expect(volZ.totalGb).toBe(2048.0);
      expect(volZ.location).toBe("remote-peer");
    });

    it("creates deterministic disk transfer jobs between local and remote volumes", () => {
      const job = createDiskTransferJob({
        sourcePath: "D:\\Omnia\\repos\\omnia\\package.json",
        destinationPath: "Z:\\sovereign-cluster\\backups\\package.json",
        sizeBytes: 4455,
        direction: "local-to-remote",
      });

      expect(job.id).toMatch(/^xfer-[0-9a-f]{8}$/);
      expect(job.status).toBe("completed");
      expect(job.protocol).toBe("Tailscale-QUIC-ZeroCopy");
      expect(job.sha256Integrity).toHaveLength(64);
      expect(DEFAULT_OMNIA_REMOTE_DAEMON_CONFIG.sessionEndpoint).toContain("omnia-remote://");
    });
  });
});

