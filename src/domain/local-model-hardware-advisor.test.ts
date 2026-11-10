import { describe, expect, it } from "vitest";

import {
  buildDirectSovereignCustomProviderBlueprint,
  DEFAULT_SOVEREIGN_DIRECT_SYSTEM_DIRECTIVE,
  DETECTED_ACER_NITRO_HARDWARE,
  evaluateModelHardwareFit,
  LOCAL_UNCENSORED_MODEL_CATALOG,
  recommendLocalModelsForHardware,
  type HostHardwareSpec,
} from "./local-model-hardware-advisor";

describe("local-model-hardware-advisor", () => {
  it("exports exact detected Acer Nitro AN515-55 hardware specifications with D:\\Omnia\\models storage", () => {
    expect(DETECTED_ACER_NITRO_HARDWARE).toEqual({
      machineModel: "Acer Nitro AN515-55",
      cpuName: "Intel(R) Core(TM) i5-10300H CPU @ 2.50GHz",
      cpuCores: 4,
      cpuThreads: 8,
      systemRamGb: 16,
      gpuName: "NVIDIA GeForce GTX 1650 Ti",
      gpuVramMiB: 4096,
      preferredModelStorageDir: "D:\\Omnia\\models",
    });
  });

  it("exports the 6 uncensored / abliterated open-weight models in LOCAL_UNCENSORED_MODEL_CATALOG", () => {
    expect(LOCAL_UNCENSORED_MODEL_CATALOG).toHaveLength(6);
    const ids = LOCAL_UNCENSORED_MODEL_CATALOG.map((m) => m.id);
    expect(ids).toEqual([
      "huihui-qwen2.5-coder-7b-abliterated-q4km",
      "huihui-qwen3-4b-abliterated-q5km",
      "dolphin3-llama3.1-8b-q4km",
      "huihui-deepseek-r1-8b-abliterated-q4km",
      "nous-hermes-3-llama3.1-8b-q4km",
      "huihui-qwen2.5-14b-abliterated-q3km",
    ]);
  });

  it("evaluates hardware fit accurately for full-gpu-vram, hybrid-gpu-ram-sweetspot, and cpu-heavy-hybrid tiers", () => {
    const qwenCoder7b = LOCAL_UNCENSORED_MODEL_CATALOG[0]!;
    const qwen3_4b = LOCAL_UNCENSORED_MODEL_CATALOG[1]!;
    const qwen14b = LOCAL_UNCENSORED_MODEL_CATALOG[5]!;

    const fit4b = evaluateModelHardwareFit(qwen3_4b, DETECTED_ACER_NITRO_HARDWARE);
    expect(fit4b.executionTier).toBe("full-gpu-vram");
    expect(fit4b.gpuOffloadLayers).toBe(36);
    expect(fit4b.cpuOffloadLayers).toBe(0);
    expect(fit4b.estimatedTokPerSec).toBeGreaterThanOrEqual(55);
    expect(fit4b.fitScore).toBeGreaterThanOrEqual(95);

    const fit7b = evaluateModelHardwareFit(qwenCoder7b, DETECTED_ACER_NITRO_HARDWARE);
    expect(fit7b.executionTier).toBe("hybrid-gpu-ram-sweetspot");
    expect(fit7b.gpuOffloadLayers).toBe(21);
    expect(fit7b.cpuOffloadLayers).toBe(7);
    expect(fit7b.vramAllocatedMiB).toBeLessThanOrEqual(4096);
    expect(fit7b.fitScore).toBe(99);

    const fit14b = evaluateModelHardwareFit(qwen14b, DETECTED_ACER_NITRO_HARDWARE);
    expect(fit14b.executionTier).toBe("cpu-heavy-hybrid");
    expect(fit14b.gpuOffloadLayers).toBe(25);
    expect(fit14b.cpuOffloadLayers).toBe(23);
    expect(fit14b.fitScore).toBeLessThan(fit7b.fitScore);
  });

  it("ranks Qwen2.5-Coder-7B-Abliterated #1 and Qwen3-4B-Abliterated #2 for the Acer Nitro GTX 1650 Ti", () => {
    const ranked = recommendLocalModelsForHardware(DETECTED_ACER_NITRO_HARDWARE);
    expect(ranked).toHaveLength(6);
    expect(ranked[0]?.model.id).toBe("huihui-qwen2.5-coder-7b-abliterated-q4km");
    expect(ranked[1]?.model.id).toBe("huihui-qwen3-4b-abliterated-q5km");
    expect(ranked[0]!.fitScore).toBeGreaterThan(ranked[1]!.fitScore);
  });

  it("penalizes fitScore when system RAM is constrained", () => {
    const lowRamHw: HostHardwareSpec = {
      ...DETECTED_ACER_NITRO_HARDWARE,
      gpuVramMiB: 2048,
      systemRamGb: 4,
    };
    const qwen14b = LOCAL_UNCENSORED_MODEL_CATALOG[5]!;
    const constrainedFit = evaluateModelHardwareFit(qwen14b, lowRamHw);
    expect(constrainedFit.fitScore).toBeLessThan(60);
  });

  it("builds a complete Direct Sovereign Custom Provider blueprint with Modelfile, PowerShell script, llama-server CLI, and JSON config", () => {
    const qwenCoder7b = LOCAL_UNCENSORED_MODEL_CATALOG[0]!;
    const blueprint = buildDirectSovereignCustomProviderBlueprint(
      qwenCoder7b,
      DETECTED_ACER_NITRO_HARDWARE,
    );

    expect(blueprint.sovereignModelAlias).toBe(
      "omnia-sovereign-huihui-qwen2.5-coder-7b-abliterated-q4km",
    );
    expect(blueprint.systemDirective).toBe(DEFAULT_SOVEREIGN_DIRECT_SYSTEM_DIRECTIVE);
    expect(blueprint.ollamaModelfile).toContain(
      "FROM huihui_ai/qwen2.5-coder-abliterated:7b-instruct-q4_K_M",
    );
    expect(blueprint.ollamaModelfile).toContain("PARAMETER num_gpu 21");
    expect(blueprint.ollamaModelfile).toContain("PARAMETER num_thread 8");
    expect(blueprint.ollamaModelfile).toContain("PARAMETER num_ctx 8192");

    expect(blueprint.powershellInstallAndRunScript).toContain(
      '$env:OLLAMA_MODELS = "D:\\Omnia\\models"',
    );
    expect(blueprint.powershellInstallAndRunScript).toContain("winget install --id Ollama.Ollama");
    expect(blueprint.powershellInstallAndRunScript).toContain(
      "ollama pull huihui_ai/qwen2.5-coder-abliterated:7b-instruct-q4_K_M",
    );

    expect(blueprint.llamaCppServerCommand).toContain("llama-server.exe");
    expect(blueprint.llamaCppServerCommand).toContain("--n-gpu-layers 21");
    expect(blueprint.llamaCppServerCommand).toContain("--threads 8");
    expect(blueprint.llamaCppServerCommand).toContain("--flash-attn");

    const parsedJson = JSON.parse(blueprint.customProviderConfigJson);
    expect(parsedJson.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(parsedJson.tcpNoDelay).toBe(true);
    expect(parsedJson.sseChunkCoalescing).toBe(true);
    expect(parsedJson.directRawPassThrough).toBe(true);
    expect(parsedJson.stripRefusalPreambles).toBe(true);
    expect(parsedJson.injectSafetyDisclaimer).toBe(false);
  });
});
