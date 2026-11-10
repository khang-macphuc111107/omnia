import {
  Activity,
  AlertTriangle,
  ArrowLeftRight,
  Binary,
  Bot,
  Calculator,
  Check,
  ChevronRight,
  Clipboard,
  Code2,
  Cpu,
  FunctionSquare,
  History,
  Layers,
  LineChart,
  MessageSquarePlus,
  Palette,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Sigma,
  Sparkles,
  Terminal,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  autoTriggerBuiltinToolsForTurn,
  buildLlmBuiltinToolDeclarations,
  convertProgrammerBase,
  inspectIeee754Float,
  interceptAndExecuteLlmToolCalls,
  runBooleanSatSolver,
  runCodeSyntaxBalanceChecker,
  runDateTimeCronSolver,
  runHashCodec,
  runJsonSchemaValidator,
  runMatrixLinearAlgebra,
  runRegexTester,
  runScientificCalculator,
  runStatsAndQuantSolver,
  runSymbolicCasSolver,
  runUnitCurrencyConverter,
  sampleFunctionPlotPoints,
  type AngleUnit,
  type SupportedSyntaxLanguage,
  type UnitCategory,
  type WorkspaceGroundTruth,
} from "@/domain/omnia-builtin-tools";

import { useWorkspaceStore } from "./store";

export const CALC_HISTORY_STORAGE_KEY = "omnia.calc.history.v1";

export type BuiltinWorkbenchTabId =
  | "calculator"
  | "converter"
  | "swiss-army"
  | "anti-hallucination"
  | "verifier"
  | "cas-matrix"
  | "bitwise-sat"
  | "llm-mcp";

export type WorkbenchThemePreset = "auto" | "vscode-dark" | "linear-carbon" | "claude-warm";

export type CasSubTabId = "symbolic" | "grapher" | "matrix" | "quant";

export interface PaperTapeEntry {
  readonly id: string;
  readonly expression: string;
  readonly formattedDecimal: string;
  readonly rationalFormatted: string;
  readonly hex: string;
  readonly value: number;
}

interface PersistedCalculatorState {
  readonly history: readonly PaperTapeEntry[];
  readonly memoryValue: number;
}

const DEFAULT_PAPER_TAPE: readonly PaperTapeEntry[] = [
  {
    id: "tape-init-1",
    expression: "125 * 48",
    formattedDecimal: "6000",
    rationalFormatted: "6000/1",
    hex: "0x1770",
    value: 6000,
  },
];

function loadPersistedCalculatorState(): PersistedCalculatorState | null {
  try {
    if (typeof window === "undefined" || typeof window.localStorage?.getItem !== "function") {
      return null;
    }
    const raw = window.localStorage.getItem(CALC_HISTORY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedCalculatorState>;
    if (parsed && Array.isArray(parsed.history) && parsed.history.length > 0) {
      return {
        history: parsed.history,
        memoryValue:
          typeof parsed.memoryValue === "number" && Number.isFinite(parsed.memoryValue)
            ? parsed.memoryValue
            : 0,
      };
    }
  } catch {
    // Ignore storage read errors
  }
  return null;
}

function savePersistedCalculatorState(state: PersistedCalculatorState): void {
  try {
    if (typeof window === "undefined" || typeof window.localStorage?.setItem !== "function") {
      return;
    }
    window.localStorage.setItem(CALC_HISTORY_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage write errors
  }
}

const WORKBENCH_TABS: readonly {
  readonly id: Exclude<BuiltinWorkbenchTabId, "verifier">;
  readonly label: string;
  readonly shortLabel: string;
  readonly tooltip: string;
}[] = [
  {
    id: "calculator",
    label: "Scientific & Programmer Calculator",
    shortLabel: "Calc & Hex",
    tooltip: "Recursive-descent scientific, calculus & 64-bit programmer calculator",
  },
  {
    id: "cas-matrix",
    label: "Symbolic CAS, Matrix & Grapher",
    shortLabel: "CAS · Matrix · Plot",
    tooltip: "Symbolic differentiation/integration, Taylor series, RK4 ODE, SVG Grapher, N×N Matrix & Quant Finance",
  },
  {
    id: "bitwise-sat",
    label: "IEEE-754 & Boolean SAT",
    shortLabel: "IEEE-754 · SAT",
    tooltip: "Interactive 32-bit bit-toggle grid, IEEE-754 float64 layout/ULP inspector & Boolean SAT Truth-Table solver",
  },
  {
    id: "llm-mcp",
    label: "LLM Tool-Calls & Stream Interceptor",
    shortLabel: "LLM MCP Interceptor",
    tooltip: "Real-time <calc>/<cas>/<matrix> stream interceptor & 14 official OpenAI/Anthropic/MCP tool schemas",
  },
  {
    id: "converter",
    label: "Unit, Data Size & Base Converter",
    shortLabel: "Units & Base",
    tooltip: "Physical/digital units, configurable currencies, two's complement & radix conversion",
  },
  {
    id: "swiss-army",
    label: "OmniDev Swiss-Army Knife",
    shortLabel: "DevTools Knife",
    tooltip: "JSON/JSONL schema validator, regex tester, SHA-256/CRC32/JWT inspector, 5-field cron & syntax balance",
  },
  {
    id: "anti-hallucination",
    label: "Anti-Hallucination Live Verifier",
    shortLabel: "PRM Verifier",
    tooltip: "Process Reward Model (PRM) inline numeric claim auditor, citation cross-checker & epistemic calibrator",
  },
];

const UNIT_OPTIONS_BY_CATEGORY: Readonly<Record<UnitCategory, readonly string[]>> = {
  length: ["m", "km", "cm", "mm", "um", "nm", "mi", "yd", "ft", "in", "nmi"],
  mass: ["kg", "g", "mg", "lb", "oz", "ton"],
  temperature: ["C", "F", "K"],
  data: ["B", "KB", "KiB", "MB", "MiB", "GB", "GiB", "TB", "TiB"],
  time: ["ns", "us", "ms", "s", "min", "h", "d", "wk", "yr"],
  speed: ["m/s", "km/h", "mph", "kn"],
  energy: ["J", "kJ", "cal", "kcal", "Wh", "kWh", "eV"],
  pressure: ["Pa", "kPa", "bar", "atm", "psi"],
  angle: ["deg", "rad", "grad"],
  currency: ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "CNY", "INR", "SGD", "VND", "KRW"],
};

const SCIENTIFIC_KEYPAD_BUTTONS: readonly {
  readonly label: string;
  readonly insert: string;
  readonly title: string;
}[] = [
  { label: "sin", insert: "sin(", title: "Sine function" },
  { label: "cos", insert: "cos(", title: "Cosine function" },
  { label: "tan", insert: "tan(", title: "Tangent function" },
  { label: "ln", insert: "ln(", title: "Natural logarithm" },
  { label: "sqrt", insert: "sqrt(", title: "Square root" },
  { label: "^", insert: "^", title: "Exponentiation" },
  { label: "!", insert: "!", title: "Factorial" },
  { label: "pi", insert: "pi", title: "Archimedes constant pi" },
  { label: "e", insert: "e", title: "Euler number e" },
  { label: "nCr", insert: "nCr(10, 3)", title: "Combinations nCr(n, r)" },
  { label: "gcd", insert: "gcd(48, 18)", title: "Greatest common divisor" },
  { label: "deriv", insert: "deriv(x^3 + 2*x, 3)", title: "Numerical derivative d/dx at x0" },
  { label: "integrate", insert: "integrate(x^2, 0, 3)", title: "Definite integral via Simpson rule" },
  { label: "det", insert: "det([[1, 2], [3, 4]])", title: "2x2 or 3x3 matrix determinant" },
];

const DEFAULT_GROUND_TRUTH: WorkspaceGroundTruth = {
  files: [
    {
      path: "src/domain/omnia-builtin-tools.ts",
      lineCount: 6500,
      content:
        "export function runScientificCalculator() {}\nexport function autoTriggerBuiltinToolsForTurn() {}",
    },
    {
      path: "src/features/workspace/builtin-calculator-workbench.tsx",
      lineCount: 1500,
      content: "export function BuiltinCalculatorWorkbench() {}",
    },
  ],
  identifiers: [
    "runScientificCalculator",
    "autoTriggerBuiltinToolsForTurn",
    "BuiltinCalculatorWorkbench",
    "runNumericClaimVerifier",
  ],
  facts: ["Omnia deterministic tools execute with zero eval vulnerabilities."],
};

export interface BuiltinCalculatorWorkbenchProps {
  readonly initialTab?: BuiltinWorkbenchTabId | undefined;
}

export function BuiltinCalculatorWorkbench({
  initialTab = "calculator",
}: BuiltinCalculatorWorkbenchProps = {}) {
  const conversations = useWorkspaceStore((state) => state.conversations);
  const activeConversationId = useWorkspaceStore((state) => state.activeConversationId);
  const updateDraft = useWorkspaceStore((state) => state.updateDraft);

  const normalizedInitialTab = initialTab === "verifier" ? "anti-hallucination" : initialTab;
  const [activeTab, setActiveTab] = useState<Exclude<BuiltinWorkbenchTabId, "verifier">>(
    normalizedInitialTab,
  );
  const [themePreset, setThemePreset] = useState<WorkbenchThemePreset>("vscode-dark");
  const [llmAutoIntercept, setLlmAutoIntercept] = useState<boolean>(true);
  const [statusMessage, setStatusMessage] = useState(
    "Deterministic CAS & MCP Tool Server ready · Zero eval vulnerabilities · 14 tool schemas active.",
  );

  const llmToolDeclarations = useMemo(() => buildLlmBuiltinToolDeclarations(), []);

  // ==========================================================================
  // TAB 1 STATE: Scientific & Programmer Calculator
  // ==========================================================================
  const [expression, setExpression] = useState("125 * 48 + integrate(x^2, 0, 3)");
  const [angleUnit, setAngleUnit] = useState<AngleUnit>("rad");
  const [varX, setVarX] = useState<number>(3);
  const [varY, setVarY] = useState<number>(5);
  const [ansRegister, setAnsRegister] = useState<number>(0);
  const [memoryRegister, setMemoryRegister] = useState<number>(
    () => loadPersistedCalculatorState()?.memoryValue ?? 0,
  );
  const [paperTape, setPaperTape] = useState<readonly PaperTapeEntry[]>(
    () => loadPersistedCalculatorState()?.history ?? DEFAULT_PAPER_TAPE,
  );

  useEffect(() => {
    savePersistedCalculatorState({ history: paperTape, memoryValue: memoryRegister });
  }, [paperTape, memoryRegister]);

  const liveCalcResult = useMemo(
    () =>
      runScientificCalculator({
        expression,
        angleUnit,
        variables: { x: varX, y: varY, ans: ansRegister },
      }),
    [expression, angleUnit, varX, varY, ansRegister],
  );

  const commitCalculationToTape = () => {
    if (!liveCalcResult.ok || !Number.isFinite(liveCalcResult.value)) {
      setStatusMessage(
        `Calculation error: ${liveCalcResult.error ?? "Invalid expression"}`,
      );
      return;
    }
    setAnsRegister(liveCalcResult.value);
    const entry: PaperTapeEntry = {
      id: `tape-${Date.now()}-${paperTape.length + 1}`,
      expression: liveCalcResult.expression,
      formattedDecimal: liveCalcResult.formattedDecimal,
      rationalFormatted: liveCalcResult.rationalApproximation.formatted,
      hex: liveCalcResult.programmerReadout.hex,
      value: liveCalcResult.value,
    };
    const nextTape = [entry, ...paperTape.slice(0, 19)];
    setPaperTape(nextTape);
    savePersistedCalculatorState({ history: nextTape, memoryValue: memoryRegister });
    setStatusMessage(`Evaluated ${entry.expression} = ${entry.formattedDecimal}`);
  };

  const handleInsertResultIntoChat = () => {
    if (!liveCalcResult.ok || !Number.isFinite(liveCalcResult.value)) {
      setStatusMessage(
        `Calculation error: ${liveCalcResult.error ?? "Cannot insert invalid expression"}`,
      );
      return;
    }
    const storeState = useWorkspaceStore.getState();
    const targetId =
      activeConversationId || storeState.activeConversationId || storeState.conversations[0]?.id;
    if (!targetId) {
      setStatusMessage("No active conversation available to insert calculator result.");
      return;
    }
    const targetConv = storeState.conversations.find((c) => c.id === targetId);
    const existingDraft = targetConv?.draft ?? "";
    const snippet = `[Verified Calculation] ${liveCalcResult.expression} = ${liveCalcResult.formattedDecimal} (Rational: ${liveCalcResult.rationalApproximation.formatted}, HEX: ${liveCalcResult.programmerReadout.hex})`;
    const nextDraft = existingDraft.trim() ? `${existingDraft.trim()}\n${snippet}` : snippet;
    const updateDraftFn = storeState.updateDraft as unknown as (...args: string[]) => void;
    if (updateDraftFn.length >= 2) {
      updateDraftFn(targetId, nextDraft);
    } else {
      updateDraftFn(nextDraft);
      (updateDraft as unknown as (draft: string) => void)(nextDraft);
    }
    setStatusMessage(
      `Inserted ${liveCalcResult.expression} = ${liveCalcResult.formattedDecimal} into active chat draft (${targetId}).`,
    );
  };

  const handleKeypadInsert = (snippet: string) => {
    setExpression((curr) => (curr.trim() === "0" ? snippet : `${curr}${snippet}`));
  };

  const handleMemoryOp = (op: "MC" | "MR" | "M+" | "M-" | "Ans") => {
    if (op === "MC") {
      setMemoryRegister(0);
      savePersistedCalculatorState({ history: paperTape, memoryValue: 0 });
      setStatusMessage("Cleared calculator memory register (MC).");
    } else if (op === "MR") {
      setExpression((curr) => `${curr}${memoryRegister}`);
      setStatusMessage(`Recalled memory value ${memoryRegister} (MR).`);
    } else if (op === "M+") {
      const addVal =
        liveCalcResult.ok && Number.isFinite(liveCalcResult.value) ? liveCalcResult.value : 0;
      const next = memoryRegister + addVal;
      setMemoryRegister(next);
      savePersistedCalculatorState({ history: paperTape, memoryValue: next });
      setStatusMessage(`Added ${addVal} to memory -> ${next} (M+).`);
    } else if (op === "M-") {
      const subVal =
        liveCalcResult.ok && Number.isFinite(liveCalcResult.value) ? liveCalcResult.value : 0;
      const next = memoryRegister - subVal;
      setMemoryRegister(next);
      savePersistedCalculatorState({ history: paperTape, memoryValue: next });
      setStatusMessage(`Subtracted ${subVal} from memory -> ${next} (M-).`);
    } else if (op === "Ans") {
      setExpression((curr) => `${curr}ans`);
      setStatusMessage(`Inserted Ans (${ansRegister}) into expression.`);
    }
  };

  const copyTapeEntry = async (entry: PaperTapeEntry) => {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(entry.formattedDecimal);
      } catch {
        // Fallback in restricted environments
      }
    }
    setStatusMessage(`Copied ${entry.formattedDecimal} from paper tape.`);
  };

  // ==========================================================================
  // TAB 2 STATE: Unit, Data Size & Base Converter
  // ==========================================================================
  const [unitCategory, setUnitCategory] = useState<UnitCategory>("data");
  const [unitValue, setUnitValue] = useState<number>(4);
  const [fromUnit, setFromUnit] = useState<string>("GiB");
  const [toUnit, setToUnit] = useState<string>("MB");
  const [programmerInput, setProgrammerInput] = useState<string>("255");
  const [programmerBase, setProgrammerBase] = useState<2 | 8 | 10 | 16>(10);

  const handleCategoryChange = (nextCat: UnitCategory) => {
    setUnitCategory(nextCat);
    const units = UNIT_OPTIONS_BY_CATEGORY[nextCat];
    setFromUnit(units[0] ?? "m");
    setToUnit(units[1] ?? units[0] ?? "km");
  };

  const swapUnits = () => {
    setFromUnit(toUnit);
    setToUnit(fromUnit);
    setStatusMessage(`Swapped conversion direction: ${toUnit} -> ${fromUnit}.`);
  };

  const liveConversion = useMemo(
    () =>
      runUnitCurrencyConverter({
        value: unitValue,
        fromUnit,
        toUnit,
        programmerInput,
        programmerBase,
      }),
    [unitValue, fromUnit, toUnit, programmerInput, programmerBase],
  );

  const liveProgrammerConversion = useMemo(() => {
    try {
      return convertProgrammerBase(programmerInput, programmerBase);
    } catch {
      return convertProgrammerBase(0, 10);
    }
  }, [programmerInput, programmerBase]);

  // ==========================================================================
  // TAB 3 STATE: OmniDev Swiss-Army Knife
  // ==========================================================================
  const [jsonPayload, setJsonPayload] = useState(
    '{\n  "tool": "omnia_calculator",\n  "deterministic": true,\n  "precision": 14\n}',
  );
  const [jsonSchemaText, setJsonSchemaText] = useState(
    '{\n  "type": "object",\n  "required": ["tool", "deterministic"],\n  "properties": {\n    "tool": { "type": "string" },\n    "deterministic": { "type": "boolean" },\n    "precision": { "type": "integer", "minimum": 1 }\n  }\n}',
  );
  const [regexPattern, setRegexPattern] = useState("(?<num>\\d+)\\s*(?<unit>GB|GiB|MB)");
  const [regexFlags, setRegexFlags] = useState("gi");
  const [regexTestString, setRegexTestString] = useState(
    "Allocated 16 GiB RAM and 512 GB NVMe storage.",
  );
  const [regexReplacement, setRegexReplacement] = useState("$<num> [$<unit>]");
  const [hashInput, setHashInput] = useState("Omnia Deterministic Studio");
  const [cronInput, setCronInput] = useState("*/15 9-17 * * MON-FRI");
  const [timestampA, setTimestampA] = useState("2026-10-18T08:00:00.000Z");
  const [timestampB, setTimestampB] = useState("2026-10-19T14:45:30.000Z");
  const [syntaxCode, setSyntaxCode] = useState(
    "export function compute(x: number) {\n  const items = [1, 2, (x + 3)];\n  return items.length;\n}",
  );
  const [syntaxLanguage, setSyntaxLanguage] = useState<SupportedSyntaxLanguage>("ts");

  const jsonValidation = useMemo(
    () => runJsonSchemaValidator({ payload: jsonPayload, schema: jsonSchemaText }),
    [jsonPayload, jsonSchemaText],
  );

  const regexResult = useMemo(
    () =>
      runRegexTester({
        pattern: regexPattern,
        flags: regexFlags,
        testString: regexTestString,
        replacement: regexReplacement,
      }),
    [regexPattern, regexFlags, regexTestString, regexReplacement],
  );

  const hashResult = useMemo(() => runHashCodec({ input: hashInput }), [hashInput]);

  const cronResult = useMemo(
    () =>
      runDateTimeCronSolver({
        timestampA,
        timestampB,
        cronExpression: cronInput,
        nextCount: 4,
        referenceTime: timestampA,
      }),
    [timestampA, timestampB, cronInput],
  );

  const syntaxResult = useMemo(
    () => runCodeSyntaxBalanceChecker({ code: syntaxCode, language: syntaxLanguage }),
    [syntaxCode, syntaxLanguage],
  );

  // ==========================================================================
  // TAB 4 STATE: Anti-Hallucination Live Verifier & Auto-Trigger Inspector
  // ==========================================================================
  const [verifierPrompt, setVerifierPrompt] = useState(
    "Calculate 125 * 48 and check 15% of 240, then cite the calculator module.",
  );
  const [verifierDraft, setVerifierDraft] = useState(
    "According to [src/domain/omnia-builtin-tools.ts:25], `runScientificCalculator` shows that 125 * 48 = 5,800 and 15% of 240 is 36.",
  );

  const auditReport = useMemo(
    () =>
      autoTriggerBuiltinToolsForTurn({
        userPrompt: verifierPrompt,
        assistantDraft: verifierDraft,
        groundTruth: DEFAULT_GROUND_TRUTH,
      }),
    [verifierPrompt, verifierDraft],
  );

  const applyAutoCorrectedDraft = () => {
    setVerifierDraft(auditReport.autoCorrectedDraft);
    setStatusMessage("Applied deterministic math auto-correction to assistant draft.");
  };

  const handleLoadAndVerifyActiveChatTurn = () => {
    const storeState = useWorkspaceStore.getState();
    const targetId =
      activeConversationId ||
      storeState.activeConversationId ||
      conversations[0]?.id ||
      storeState.conversations[0]?.id;
    const targetConv =
      storeState.conversations.find((c) => c.id === targetId) ??
      conversations.find((c) => c.id === targetId) ??
      storeState.conversations[0];
    if (!targetConv) {
      setStatusMessage("No active conversation available to verify.");
      return;
    }

    const messages = Array.isArray(targetConv.messages) ? targetConv.messages : [];
    const latestUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const latestAssistantMsg = [...messages].reverse().find((m) => m.role === "assistant");

    const extractText = (msg: unknown): string => {
      if (!msg || typeof msg !== "object") return "";
      const record = msg as Record<string, unknown>;
      return typeof record.content === "string"
        ? record.content
        : typeof record.text === "string"
          ? record.text
          : "";
    };

    const nextPrompt = extractText(latestUserMsg).trim() || targetConv.title || verifierPrompt;
    const nextDraft =
      extractText(latestAssistantMsg).trim() || targetConv.draft?.trim() || verifierDraft;

    setVerifierPrompt(nextPrompt);
    setVerifierDraft(nextDraft);

    const liveAudit = autoTriggerBuiltinToolsForTurn({
      userPrompt: nextPrompt,
      assistantDraft: nextDraft,
      groundTruth: DEFAULT_GROUND_TRUTH,
    });

    setStatusMessage(
      `Loaded & verified active chat turn (${targetConv.id}): badge=${liveAudit.overallBadge}, claims=${liveAudit.numericVerification?.totalClaimsChecked ?? 0}, discrepancies=${liveAudit.numericVerification?.discrepancyCount ?? 0}.`,
    );
  };

  // ==========================================================================
  // TAB 5 STATE: Symbolic CAS, Matrix Linear Algebra, SVG Grapher & Quant
  // ==========================================================================
  const [casSubTab, setCasSubTab] = useState<CasSubTabId>("symbolic");
  const [casExpr, setCasExpr] = useState("3*x^3 - 5*x^2 + 4*x - 7");
  const [taylorCenter, setTaylorCenter] = useState<number>(0);
  const [taylorOrder, setTaylorOrder] = useState<number>(4);
  const [odeExpr, setOdeExpr] = useState("x + y");
  const [odeTargetX, setOdeTargetX] = useState<number>(1);
  const [complexExpr, setComplexExpr] = useState("(3 + 4i) * (1 - 2i)");

  const [graphExpr, setGraphExpr] = useState("x^3 - 3*x");
  const [graphXMin, setGraphXMin] = useState<number>(-3);
  const [graphXMax, setGraphXMax] = useState<number>(3);

  const [matrixJsonInput, setMatrixJsonInput] = useState(
    "[\n  [4, 2, 1],\n  [2, 5, 3],\n  [1, 3, 6]\n]",
  );

  const [spotPrice, setSpotPrice] = useState<number>(100);
  const [strikePrice, setStrikePrice] = useState<number>(100);
  const [volatility, setVolatility] = useState<number>(0.2);
  const [riskFreeRate, setRiskFreeRate] = useState<number>(0.05);

  const liveCasResult = useMemo(
    () =>
      runSymbolicCasSolver({
        expression: casExpr,
        taylorCenter,
        taylorOrder,
        rootMinX: -20,
        rootMaxX: 20,
        ode: { dydxExpr: odeExpr, x0: 0, y0: 1, targetX: odeTargetX, steps: 20 },
        complexExpression: complexExpr,
      }),
    [casExpr, taylorCenter, taylorOrder, odeExpr, odeTargetX, complexExpr],
  );

  const liveGraphSample = useMemo(
    () => sampleFunctionPlotPoints(graphExpr, graphXMin, graphXMax, 120),
    [graphExpr, graphXMin, graphXMax],
  );

  const liveMatrixResult = useMemo(() => {
    try {
      const parsed = JSON.parse(matrixJsonInput) as number[][];
      return runMatrixLinearAlgebra({ matrixA: parsed });
    } catch {
      return runMatrixLinearAlgebra({
        matrixA: [
          [1, 2],
          [3, 4],
        ],
      });
    }
  }, [matrixJsonInput]);

  const liveQuantResult = useMemo(
    () =>
      runStatsAndQuantSolver({
        normal: { x: 1.96, mean: 0, stdDev: 1 },
        binomial: { n: 10, k: 3, p: 0.5 },
        poisson: { lambda: 4, k: 2 },
        regression: { xValues: [1, 2, 3, 4, 5], yValues: [2.2, 4.1, 6.0, 8.1, 9.9] },
        entropyProbabilities: [0.5, 0.25, 0.125, 0.125],
        bayes: { priorA: 0.01, probBGivenA: 0.99, probBGivenNotA: 0.05 },
        finance: {
          discountRate: 0.1,
          cashFlows: [-1000, 350, 450, 550],
          beginValue: 1000,
          endValue: 1610.51,
          years: 5,
          blackScholes: {
            spotPrice,
            strikePrice,
            timeToMaturityYears: 1,
            riskFreeRate,
            volatility,
          },
        },
      }),
    [spotPrice, strikePrice, riskFreeRate, volatility],
  );

  // ==========================================================================
  // TAB 6 STATE: IEEE-754 Bitwise Toggle Grid & Boolean SAT Solver
  // ==========================================================================
  const [bitWord32, setBitWord32] = useState<number>(0x00001779);
  const [ieeeInputVal, setIeeeInputVal] = useState<number>(0.15625);
  const [booleanSatExpr, setBooleanSatExpr] = useState("(A && B) -> (!C || A)");

  const toggleBitAt = (bitIndex: number) => {
    setBitWord32((prev) => (prev ^ (1 << bitIndex)) >>> 0);
  };

  const liveIeee64 = useMemo(() => inspectIeee754Float(ieeeInputVal, "float64"), [ieeeInputVal]);
  const liveSatResult = useMemo(() => runBooleanSatSolver(booleanSatExpr), [booleanSatExpr]);

  // ==========================================================================
  // TAB 7 STATE: LLM Native Tool-Calls & Stream Interceptor
  // ==========================================================================
  const [llmStreamDraft, setLlmStreamDraft] = useState(
    "Cluster sizing: 48 nodes * 125 GiB = <calc>48 * 125</calc> GiB total RAM. Symbolic derivative <cas>3*x^3 - 5*x^2 + 4*x - 7</cas> and matrix check <matrix>[[4, 2], [1, 3]]</matrix>.",
  );

  const liveLlmInterception = useMemo(
    () =>
      interceptAndExecuteLlmToolCalls({
        streamText: llmStreamDraft,
        toolCalls: [
          {
            id: "call_mcp_demo_1",
            name: "builtin_scientific_calculator",
            arguments: { expression: "2^16 + 1024" },
          },
        ],
      }),
    [llmStreamDraft],
  );

  // Build SVG path for Function Grapher
  const svgGraphGeometry = useMemo(() => {
    const width = 560;
    const height = 210;
    const pad = 22;
    const { xMin, xMax, yMin, yMax, points } = liveGraphSample;
    const dx = xMax - xMin || 1;
    const dy = yMax - yMin || 1;
    const toSvgX = (x: number) => pad + ((x - xMin) / dx) * (width - 2 * pad);
    const toSvgY = (y: number) => height - pad - ((y - yMin) / dy) * (height - 2 * pad);

    const fSegments: string[] = [];
    const dfSegments: string[] = [];
    for (const pt of points) {
      if (pt.y !== null) {
        const sx = toSvgX(pt.x).toFixed(1);
        const sy = Math.max(pad, Math.min(height - pad, toSvgY(pt.y))).toFixed(1);
        fSegments.push(`${fSegments.length === 0 ? "M" : "L"}${sx},${sy}`);
      }
      if (pt.dy !== null) {
        const sx = toSvgX(pt.x).toFixed(1);
        const sy = Math.max(pad, Math.min(height - pad, toSvgY(pt.dy))).toFixed(1);
        dfSegments.push(`${dfSegments.length === 0 ? "M" : "L"}${sx},${sy}`);
      }
    }

    const zeroAxisY = Math.max(pad, Math.min(height - pad, toSvgY(0)));
    const zeroAxisX = Math.max(pad, Math.min(width - pad, toSvgX(0)));

    return {
      width,
      height,
      fPath: fSegments.join(" "),
      dfPath: dfSegments.join(" "),
      zeroAxisX,
      zeroAxisY,
      toSvgX,
      toSvgY,
    };
  }, [liveGraphSample]);

  return (
    <section
      className="builtin-calculator-workbench sw-workbench"
      data-theme-preset={themePreset}
      aria-label="Built-in Deterministic Tools & Anti-Hallucination Workbench"
      data-testid="builtin-calculator-workbench"
    >
      {/* ====================================================================
          LAYER 1: SINGLE-ROW 34px DEVTOOLS HEADER + TAB STRIP (.sw-topbar)
         ==================================================================== */}
      <header className="sw-topbar structured-io-workbench__header">
        <div className="sw-topbar__left structured-io-workbench__title">
          <span className="sw-topbar__icon structured-io-workbench__icon">
            <Calculator size={14} />
          </span>
          <h2
            className="sw-topbar__title"
            aria-label="Built-in Tools & Anti-Hallucination Studio — LLM CAS & Deterministic Verification Engine"
          >
            Symbolic CAS &amp; Math Engine
            <span className="sw-sr-only"> · Built-in Tools &amp; Anti-Hallucination Studio</span>
          </h2>
        </div>

        <div
          className="sw-tabstrip workbench-deck__tabs"
          role="tablist"
          aria-label="Deterministic workbench tabs"
        >
          {WORKBENCH_TABS.map((tab) => {
            const isSelected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                id={`builtin-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-label={tab.label}
                aria-selected={isSelected}
                aria-controls={`builtin-panel-${tab.id}`}
                data-tooltip={tab.tooltip}
                title={tab.tooltip}
                className={
                  isSelected
                    ? "sw-tab workbench-deck__tab workbench-deck__tab--active"
                    : "sw-tab workbench-deck__tab"
                }
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.id === "calculator" && <Calculator size={13} />}
                {tab.id === "cas-matrix" && <Sigma size={13} />}
                {tab.id === "bitwise-sat" && <Binary size={13} />}
                {tab.id === "llm-mcp" && <Terminal size={13} />}
                {tab.id === "converter" && <ArrowLeftRight size={13} />}
                {tab.id === "swiss-army" && <Wrench size={13} />}
                {tab.id === "anti-hallucination" && <ShieldCheck size={13} />}
                <span className="sw-tab__label">{tab.shortLabel}</span>
              </button>
            );
          })}
        </div>
      </header>

      {/* ====================================================================
          TAB 1: SCIENTIFIC & PROGRAMMER CALCULATOR (PROGRESSIVE LAYERED)
         ==================================================================== */}
      {activeTab === "calculator" ? (
        <div
          id="builtin-panel-calculator"
          role="tabpanel"
          aria-labelledby="builtin-tab-calculator"
          className="sw-panel workbench-deck__content"
          data-testid="panel-calculator"
        >
          {/* Compact Top Formula Bar + Inline Result Strip */}
          <div className="sw-formula-bar structured-io-workbench__controls">
            <label className="sw-formula-bar__input-wrap" style={{ flex: 3 }}>
              <span className="sw-label-mini">f(x, y)</span>
              <input
                aria-label="Calculator expression input"
                value={expression}
                onChange={(e) => setExpression(e.target.value)}
                placeholder="e.g. deriv(x^3, 2) + integrate(sin(x), 0, pi)"
              />
            </label>

            <div
              className="sw-live-strip structured-io-workbench__block-summary"
              role="region"
              aria-label="Calculator live readout"
            >
              <span className="sw-readout-pill">
                <small>DEC</small>
                <strong data-testid="calc-decimal-readout">
                  {liveCalcResult.ok ? liveCalcResult.formattedDecimal : "Error"}
                </strong>
                <em>{liveCalcResult.ok ? liveCalcResult.scientificNotation : liveCalcResult.error}</em>
              </span>
              <span className="sw-readout-pill">
                <small>Q</small>
                <strong data-testid="calc-rational-readout">
                  {liveCalcResult.rationalApproximation.formatted}
                </strong>
              </span>
              <span className="sw-readout-pill">
                <small>RADIX</small>
                <strong className="structured-io-workbench__mono" data-testid="calc-programmer-readout">
                  {liveCalcResult.programmerReadout.hex} · {liveCalcResult.programmerReadout.decimal} ·{" "}
                  {liveCalcResult.programmerReadout.octal} · {liveCalcResult.programmerReadout.binary}
                </strong>
              </span>
            </div>
          </div>

          {/* Compact Action & Memory Bar */}
          <div
            className="sw-toolbar structured-io-workbench__toolbar"
            role="toolbar"
            aria-label="Calculator memory and action controls"
          >
            <div className="sw-toolbar__group">
              {(["MC", "MR", "M+", "M-", "Ans"] as const).map((memOp) => (
                <button
                  key={memOp}
                  type="button"
                  className="sw-btn-chip button button--ghost"
                  onClick={() => handleMemoryOp(memOp)}
                  aria-label={`Memory ${memOp}`}
                >
                  {memOp}
                </button>
              ))}
              <span className="sw-meta-tag">
                M={memoryRegister} · Ans={ansRegister}
              </span>
            </div>

            <div className="sw-toolbar__group">
              <button
                type="button"
                className="sw-btn-chip button button--ghost"
                onClick={() => setExpression("")}
                aria-label="Clear calculator expression"
              >
                <RotateCcw size={12} /> Clear
              </button>
              <button
                type="button"
                className="sw-btn-chip sw-btn-chip--primary button button--secondary"
                onClick={commitCalculationToTape}
                aria-label="Evaluate and record to paper tape"
              >
                <Check size={12} /> Evaluate (=)
              </button>
              <button
                type="button"
                className="sw-btn-chip sw-btn-chip--accent button button--secondary"
                onClick={handleInsertResultIntoChat}
                data-testid="calc-insert-into-chat-btn"
              >
                <MessageSquarePlus size={12} /> Insert Result into Active Chat
              </button>
            </div>
          </div>

          {/* Progressive Disclosure Layer: Side-by-Side Collapsible Drawers */}
          <div className="sw-split-2col">
            <div className="sw-col-stack">
              <details className="sw-accordion">
                <summary className="sw-accordion__summary">
                  <ChevronRight size={13} />
                  <span>Variables (x, y) &amp; Angle Unit</span>
                  <small>
                    {angleUnit.toUpperCase()} · x={varX} · y={varY}
                  </small>
                </summary>
                <div className="sw-accordion__body structured-io-workbench__controls">
                  <label>
                    <span>Angle Mode</span>
                    <select
                      aria-label="Calculator angle unit"
                      value={angleUnit}
                      onChange={(e) => setAngleUnit(e.target.value as AngleUnit)}
                    >
                      <option value="rad">Radians (RAD)</option>
                      <option value="deg">Degrees (DEG)</option>
                    </select>
                  </label>
                  <label>
                    <span>Variable x</span>
                    <input
                      type="number"
                      aria-label="Variable x value"
                      value={varX}
                      onChange={(e) => setVarX(Number.parseFloat(e.target.value) || 0)}
                    />
                  </label>
                  <label>
                    <span>Variable y</span>
                    <input
                      type="number"
                      aria-label="Variable y value"
                      value={varY}
                      onChange={(e) => setVarY(Number.parseFloat(e.target.value) || 0)}
                    />
                  </label>
                </div>
              </details>

              <details className="sw-accordion" open>
                <summary className="sw-accordion__summary">
                  <ChevronRight size={13} />
                  <span>Scientific &amp; Calculus Function Palette</span>
                  <small>{SCIENTIFIC_KEYPAD_BUTTONS.length} operators</small>
                </summary>
                <div
                  className="sw-accordion__body sw-keypad-grid structured-io-workbench__preset-grid"
                  role="group"
                  aria-label="Scientific keypad"
                >
                  {SCIENTIFIC_KEYPAD_BUTTONS.map((btn) => (
                    <button
                      key={btn.label}
                      type="button"
                      className="sw-key-btn structured-io-workbench__preset"
                      onClick={() => handleKeypadInsert(btn.insert)}
                      title={btn.title}
                      aria-label={`Insert ${btn.label}`}
                    >
                      <strong>{btn.label}</strong>
                      <small>{btn.insert}</small>
                    </button>
                  ))}
                </div>
              </details>
            </div>

            <details
              className="sw-accordion structured-io-workbench__source"
              aria-label="Paper-tape calculation history"
              open
            >
              <summary className="sw-accordion__summary">
                <ChevronRight size={13} />
                <span>
                  <History size={13} /> Paper-Tape Calculation History
                </span>
                <small>{paperTape.length} entries</small>
              </summary>
              <ol
                className="sw-accordion__body sw-tape-list structured-io-workbench__source-lines"
                data-testid="paper-tape-list"
              >
                {paperTape.map((item) => (
                  <li key={item.id} className="sw-tape-item">
                    <span>
                      <code>{item.expression}</code> = <strong>{item.formattedDecimal}</strong> (
                      {item.rationalFormatted} · {item.hex})
                    </span>
                    <button
                      type="button"
                      className="sw-btn-chip button button--ghost"
                      onClick={() => void copyTapeEntry(item)}
                      aria-label={`Copy result ${item.formattedDecimal}`}
                    >
                      <Clipboard size={11} /> Copy
                    </button>
                  </li>
                ))}
              </ol>
            </details>
          </div>
        </div>
      ) : null}

      {/* ====================================================================
          TAB 5: SYMBOLIC CAS, MATRIX LINEAR ALGEBRA, GRAPHER & QUANT
         ==================================================================== */}
      {activeTab === "cas-matrix" ? (
        <div
          id="builtin-panel-cas-matrix"
          role="tabpanel"
          aria-labelledby="builtin-tab-cas-matrix"
          className="sw-panel workbench-deck__content"
          data-testid="panel-cas-matrix"
        >
          {/* Secondary Sub-Tab Bar */}
          <div className="sw-subtabs" role="tablist" aria-label="CAS and Linear Algebra sub-views">
            <button
              type="button"
              role="tab"
              aria-selected={casSubTab === "symbolic"}
              data-testid="cas-subtab-symbolic"
              className={casSubTab === "symbolic" ? "sw-subtab sw-subtab--active" : "sw-subtab"}
              onClick={() => setCasSubTab("symbolic")}
            >
              <FunctionSquare size={12} /> Symbolic Calculus &amp; ODE
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={casSubTab === "grapher"}
              data-testid="cas-subtab-grapher"
              className={casSubTab === "grapher" ? "sw-subtab sw-subtab--active" : "sw-subtab"}
              onClick={() => setCasSubTab("grapher")}
            >
              <LineChart size={12} /> Interactive SVG Function Grapher f(x)
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={casSubTab === "matrix"}
              data-testid="cas-subtab-matrix"
              className={casSubTab === "matrix" ? "sw-subtab sw-subtab--active" : "sw-subtab"}
              onClick={() => setCasSubTab("matrix")}
            >
              <Layers size={12} /> Matrix Linear Algebra (RREF/Inv/Eigen)
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={casSubTab === "quant"}
              data-testid="cas-subtab-quant"
              className={casSubTab === "quant" ? "sw-subtab sw-subtab--active" : "sw-subtab"}
              onClick={() => setCasSubTab("quant")}
            >
              <Activity size={12} /> Stats, Bayes &amp; Quant Finance
            </button>
          </div>

          {casSubTab === "symbolic" ? (
            <div className="sw-split-2col" data-testid="cas-symbolic-view">
              <div className="sw-card">
                <div className="sw-card__header">
                  <strong>Symbolic Differentiation, Integration, Taylor &amp; Real Roots</strong>
                </div>
                <div className="structured-io-workbench__controls">
                  <label style={{ flex: 2 }}>
                    <span>Polynomial / Elementary f(x)</span>
                    <input
                      aria-label="Symbolic CAS expression input"
                      value={casExpr}
                      onChange={(e) => setCasExpr(e.target.value)}
                    />
                  </label>
                  <label>
                    <span>Taylor Center x0</span>
                    <input
                      type="number"
                      aria-label="Taylor center x0"
                      value={taylorCenter}
                      onChange={(e) => setTaylorCenter(Number.parseFloat(e.target.value) || 0)}
                    />
                  </label>
                  <label>
                    <span>Order N</span>
                    <input
                      type="number"
                      aria-label="Taylor order N"
                      value={taylorOrder}
                      onChange={(e) =>
                        setTaylorOrder(Math.max(1, Math.min(8, Number.parseInt(e.target.value, 10) || 4)))
                      }
                    />
                  </label>
                </div>

                <div className="sw-kv-list">
                  <div className="sw-kv-row">
                    <span>Symbolic Derivative d/dx</span>
                    <code data-testid="cas-symbolic-derivative">{liveCasResult.symbolicDerivative}</code>
                  </div>
                  <div className="sw-kv-row">
                    <span>Indefinite Integral ∫f(x)dx</span>
                    <code data-testid="cas-symbolic-integral">{liveCasResult.symbolicIntegral}</code>
                  </div>
                  <div className="sw-kv-row">
                    <span>Taylor Expansion T_{taylorOrder}(x)</span>
                    <code data-testid="cas-taylor-series">{liveCasResult.taylorSeries}</code>
                  </div>
                  <div className="sw-kv-row">
                    <span>Real Roots f(x) = 0 in [-20, 20]</span>
                    <code data-testid="cas-real-roots">
                      {liveCasResult.realRoots.length > 0
                        ? liveCasResult.realRoots.join(", ")
                        : "No real roots in interval"}
                    </code>
                  </div>
                </div>
              </div>

              <div className="sw-col-stack">
                <div className="sw-card">
                  <div className="sw-card__header">
                    <strong>4th-Order Runge-Kutta (RK4) ODE Solver dy/dx = f(x, y)</strong>
                  </div>
                  <div className="structured-io-workbench__controls">
                    <label style={{ flex: 2 }}>
                      <span>dy/dx = f(x, y)</span>
                      <input
                        aria-label="ODE dy/dx expression"
                        value={odeExpr}
                        onChange={(e) => setOdeExpr(e.target.value)}
                      />
                    </label>
                    <label>
                      <span>Target x (from x0=0, y0=1)</span>
                      <input
                        type="number"
                        aria-label="ODE target x"
                        value={odeTargetX}
                        onChange={(e) => setOdeTargetX(Number.parseFloat(e.target.value) || 1)}
                      />
                    </label>
                  </div>
                  <div className="sw-kv-row">
                    <span>RK4 Solution y({odeTargetX})</span>
                    <code data-testid="cas-ode-final-y">
                      {liveCasResult.odeSolution?.ok ? liveCasResult.odeSolution.finalY : "Error"}
                    </code>
                  </div>
                </div>

                <div className="sw-card">
                  <div className="sw-card__header">
                    <strong>Complex Number &amp; Euler Polar Evaluator</strong>
                  </div>
                  <label className="structured-io-workbench__editor">
                    <span>Complex Expression</span>
                    <input
                      aria-label="Complex expression input"
                      value={complexExpr}
                      onChange={(e) => setComplexExpr(e.target.value)}
                    />
                  </label>
                  <div className="sw-kv-row" data-testid="cas-complex-readout">
                    <span>Rectangular / Polar</span>
                    <code>
                      {liveCasResult.complexResult?.formattedRectangular} · |z|=
                      {liveCasResult.complexResult?.magnitude} ·{" "}
                      {liveCasResult.complexResult?.eulerPolarForm}
                    </code>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {casSubTab === "grapher" ? (
            <div className="sw-card" data-testid="cas-grapher-view">
              <div className="structured-io-workbench__controls">
                <label style={{ flex: 2 }}>
                  <span>Function f(x) to Plot (with live derivative f&apos;(x))</span>
                  <input
                    aria-label="Grapher function expression"
                    value={graphExpr}
                    onChange={(e) => setGraphExpr(e.target.value)}
                  />
                </label>
                <label>
                  <span>xMin</span>
                  <input
                    type="number"
                    aria-label="Grapher xMin"
                    value={graphXMin}
                    onChange={(e) => setGraphXMin(Number.parseFloat(e.target.value) || -5)}
                  />
                </label>
                <label>
                  <span>xMax</span>
                  <input
                    type="number"
                    aria-label="Grapher xMax"
                    value={graphXMax}
                    onChange={(e) => setGraphXMax(Number.parseFloat(e.target.value) || 5)}
                  />
                </label>
              </div>

              <svg
                viewBox={`0 0 ${svgGraphGeometry.width} ${svgGraphGeometry.height}`}
                className="sw-svg-graph"
                data-testid="cas-function-svg-graph"
                role="img"
                aria-label={`Function plot for ${graphExpr}`}
              >
                <line
                  x1={0}
                  y1={svgGraphGeometry.zeroAxisY}
                  x2={svgGraphGeometry.width}
                  y2={svgGraphGeometry.zeroAxisY}
                  stroke="currentColor"
                  strokeOpacity={0.25}
                />
                <line
                  x1={svgGraphGeometry.zeroAxisX}
                  y1={0}
                  x2={svgGraphGeometry.zeroAxisX}
                  y2={svgGraphGeometry.height}
                  stroke="currentColor"
                  strokeOpacity={0.25}
                />
                {svgGraphGeometry.dfPath ? (
                  <path
                    d={svgGraphGeometry.dfPath}
                    fill="none"
                    stroke="#f59e0b"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                  />
                ) : null}
                {svgGraphGeometry.fPath ? (
                  <path
                    d={svgGraphGeometry.fPath}
                    fill="none"
                    stroke="#38bdf8"
                    strokeWidth={2.2}
                  />
                ) : null}
              </svg>

              <div className="sw-kv-row" data-testid="cas-graph-extrema-summary">
                <span>Detected Features</span>
                <code>
                  Zeros: {liveGraphSample.zeroCrossings.map((z) => z.x).join(", ") || "none"} ·
                  Local Min: {liveGraphSample.localMinima.map((m) => `(${m.x}, ${m.y})`).join(", ") || "none"} ·
                  Local Max: {liveGraphSample.localMaxima.map((m) => `(${m.x}, ${m.y})`).join(", ") || "none"}
                </code>
              </div>
            </div>
          ) : null}

          {casSubTab === "matrix" ? (
            <div className="sw-split-2col" data-testid="cas-matrix-view">
              <div className="sw-card">
                <div className="sw-card__header">
                  <strong>N×N Matrix A (JSON 2x2 / 3x3 / 4x4)</strong>
                </div>
                <textarea
                  aria-label="Matrix A JSON input"
                  value={matrixJsonInput}
                  onChange={(e) => setMatrixJsonInput(e.target.value)}
                  rows={5}
                />
                <div className="sw-kv-row" data-testid="matrix-det-trace-rank">
                  <span>Invariants</span>
                  <code>
                    det={liveMatrixResult.determinant ?? "N/A"} · trace={liveMatrixResult.trace ?? "N/A"} ·
                    rank={liveMatrixResult.rank} · ‖A‖_F={liveMatrixResult.frobeniusNorm}
                  </code>
                </div>
              </div>

              <div className="sw-card">
                <div className="sw-kv-list">
                  <div className="sw-kv-row">
                    <span>Reduced Row Echelon Form (RREF)</span>
                    <code data-testid="matrix-rref-output">
                      {JSON.stringify(liveMatrixResult.rref)}
                    </code>
                  </div>
                  <div className="sw-kv-row">
                    <span>Inverse Matrix A⁻¹</span>
                    <code data-testid="matrix-inverse-output">
                      {liveMatrixResult.inverse
                        ? JSON.stringify(liveMatrixResult.inverse)
                        : "Singular (non-invertible)"}
                    </code>
                  </div>
                  <div className="sw-kv-row">
                    <span>Characteristic Polynomial &amp; Eigenvalues</span>
                    <code data-testid="matrix-eigen-output">
                      {liveMatrixResult.characteristicPolynomial} → λ=[
                      {liveMatrixResult.eigenvalues.join(", ")}]
                    </code>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {casSubTab === "quant" ? (
            <div className="sw-split-2col" data-testid="cas-quant-view">
              <div className="sw-card">
                <div className="sw-card__header">
                  <strong>Black-Scholes Option Pricing + Greeks &amp; Corporate Finance</strong>
                </div>
                <div className="structured-io-workbench__controls">
                  <label>
                    <span>Spot Price S</span>
                    <input
                      type="number"
                      aria-label="Black-Scholes spot price"
                      value={spotPrice}
                      onChange={(e) => setSpotPrice(Number.parseFloat(e.target.value) || 100)}
                    />
                  </label>
                  <label>
                    <span>Strike K</span>
                    <input
                      type="number"
                      aria-label="Black-Scholes strike price"
                      value={strikePrice}
                      onChange={(e) => setStrikePrice(Number.parseFloat(e.target.value) || 100)}
                    />
                  </label>
                  <label>
                    <span>Volatility σ</span>
                    <input
                      type="number"
                      step="0.01"
                      aria-label="Black-Scholes volatility"
                      value={volatility}
                      onChange={(e) => setVolatility(Number.parseFloat(e.target.value) || 0.2)}
                    />
                  </label>
                  <label>
                    <span>Risk-Free r</span>
                    <input
                      type="number"
                      step="0.01"
                      aria-label="Black-Scholes risk-free rate"
                      value={riskFreeRate}
                      onChange={(e) => setRiskFreeRate(Number.parseFloat(e.target.value) || 0.05)}
                    />
                  </label>
                </div>
                <div className="sw-kv-list">
                  <div className="sw-kv-row" data-testid="quant-blackscholes-readout">
                    <span>Call / Put &amp; Greeks</span>
                    <code>
                      Call={liveQuantResult.financeResult?.blackScholes?.callPrice} · Put=
                      {liveQuantResult.financeResult?.blackScholes?.putPrice} · Δ=
                      {liveQuantResult.financeResult?.blackScholes?.deltaCall} · Γ=
                      {liveQuantResult.financeResult?.blackScholes?.gamma} · Vega=
                      {liveQuantResult.financeResult?.blackScholes?.vega}
                    </code>
                  </div>
                  <div className="sw-kv-row" data-testid="quant-npv-irr-readout">
                    <span>Cashflow NPV / IRR / CAGR</span>
                    <code>
                      NPV={liveQuantResult.financeResult?.npv} · IRR=
                      {liveQuantResult.financeResult?.irr} · CAGR=
                      {liveQuantResult.financeResult?.cagr}
                    </code>
                  </div>
                </div>
              </div>

              <div className="sw-card">
                <div className="sw-card__header">
                  <strong>Distributions, Linear Regression, Shannon Entropy &amp; Bayes</strong>
                </div>
                <div className="sw-kv-list">
                  <div className="sw-kv-row">
                    <span>Normal(z=1.96) / Binomial(10,3) / Poisson(4,2)</span>
                    <code>
                      Φ(1.96)={liveQuantResult.normalResult?.cdf} · Binom=
                      {liveQuantResult.binomialResult?.pmf} · Pois=
                      {liveQuantResult.poissonResult?.pmf}
                    </code>
                  </div>
                  <div className="sw-kv-row" data-testid="quant-regression-readout">
                    <span>Linear Regression (OLS)</span>
                    <code>
                      {liveQuantResult.regressionResult?.formula} (R²=
                      {liveQuantResult.regressionResult?.rSquared}, r=
                      {liveQuantResult.regressionResult?.rCorrelation})
                    </code>
                  </div>
                  <div className="sw-kv-row" data-testid="quant-bayes-entropy-readout">
                    <span>Bayes Posterior P(A|B) &amp; Shannon Entropy</span>
                    <code>
                      P(A|B)={liveQuantResult.bayesPosterior} · H(P)=
                      {liveQuantResult.shannonEntropyBits} bits
                    </code>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ====================================================================
          TAB 6: IEEE-754 FLOAT INSPECTOR & BOOLEAN SAT SOLVER
         ==================================================================== */}
      {activeTab === "bitwise-sat" ? (
        <div
          id="builtin-panel-bitwise-sat"
          role="tabpanel"
          aria-labelledby="builtin-tab-bitwise-sat"
          className="sw-panel workbench-deck__content"
          data-testid="panel-bitwise-sat"
        >
          <div className="sw-split-2col">
            <div className="sw-card">
              <div className="sw-card__header">
                <strong>Interactive 32-Bit Toggle Grid &amp; IEEE-754 64-Bit Float Layout</strong>
                <code data-testid="bitwise-word32-readout">
                  0x{bitWord32.toString(16).toUpperCase().padStart(8, "0")} ({bitWord32})
                </code>
              </div>

              <div
                className="sw-bit-grid"
                data-testid="bitwise-toggle-grid"
                role="group"
                aria-label="32-bit interactive bit toggle grid"
              >
                {Array.from({ length: 32 }, (_, idx) => {
                  const bitPos = 31 - idx;
                  const bitOn = ((bitWord32 >>> bitPos) & 1) === 1;
                  return (
                    <button
                      key={bitPos}
                      type="button"
                      data-testid={`bit-toggle-${bitPos}`}
                      aria-label={`Toggle bit ${bitPos}`}
                      className={bitOn ? "sw-bit-cell sw-bit-cell--on" : "sw-bit-cell"}
                      onClick={() => toggleBitAt(bitPos)}
                    >
                      <small>{bitPos}</small>
                      <strong>{bitOn ? "1" : "0"}</strong>
                    </button>
                  );
                })}
              </div>

              <div className="structured-io-workbench__controls">
                <label style={{ flex: 1 }}>
                  <span>IEEE-754 Float64 Value</span>
                  <input
                    type="number"
                    step="any"
                    aria-label="IEEE-754 float inspector input"
                    value={ieeeInputVal}
                    onChange={(e) => setIeeeInputVal(Number.parseFloat(e.target.value) || 0)}
                  />
                </label>
              </div>
              <div className="sw-kv-list">
                <div className="sw-kv-row" data-testid="ieee754-bit-layout">
                  <span>Sign (1b) · Biased Exp (11b) · Mantissa (52b)</span>
                  <code>
                    S={liveIeee64.signBit} · E={liveIeee64.exponentBits} ({liveIeee64.exponentHex},
                    unbiased={liveIeee64.exponentUnbiased}) · M=
                    {liveIeee64.mantissaBits.slice(0, 16)}…
                  </code>
                </div>
                <div className="sw-kv-row" data-testid="ieee754-ulp-state">
                  <span>State · Fraction · ULP</span>
                  <code>
                    {liveIeee64.specialState} · frac={liveIeee64.mantissaFraction} · ULP=
                    {liveIeee64.ulp.toExponential(4)} · HEX={liveIeee64.hex}
                  </code>
                </div>
              </div>
            </div>

            <div className="sw-card">
              <div className="sw-card__header">
                <strong>Boolean Logic Truth-Table &amp; SAT Solver (DNF / CNF)</strong>
                <span className="sw-badge sw-badge--accent" data-testid="sat-classification-badge">
                  {liveSatResult.classification}
                </span>
              </div>
              <label className="structured-io-workbench__editor">
                <span>Boolean Formula (!, &amp;&amp;, ||, ^, -&gt;, &lt;-&gt;)</span>
                <input
                  aria-label="Boolean SAT expression input"
                  value={booleanSatExpr}
                  onChange={(e) => setBooleanSatExpr(e.target.value)}
                />
              </label>
              <div className="sw-kv-list" data-testid="sat-canonical-forms">
                <div className="sw-kv-row">
                  <span>Canonical DNF</span>
                  <code>{liveSatResult.canonicalDnf || "N/A"}</code>
                </div>
                <div className="sw-kv-row">
                  <span>Canonical CNF</span>
                  <code>{liveSatResult.canonicalCnf || "N/A"}</code>
                </div>
              </div>
              <div className="sw-table-wrap" data-testid="sat-truth-table">
                <table className="sw-table">
                  <thead>
                    <tr>
                      {liveSatResult.variables.map((v) => (
                        <th key={v}>{v}</th>
                      ))}
                      <th>Out</th>
                    </tr>
                  </thead>
                  <tbody>
                    {liveSatResult.truthTable.slice(0, 16).map((row, idx) => (
                      <tr key={idx}>
                        {liveSatResult.variables.map((v) => (
                          <td key={v}>{row.assignment[v] ? "1" : "0"}</td>
                        ))}
                        <td>
                          <strong>{row.result ? "1 (T)" : "0 (F)"}</strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ====================================================================
          TAB 7: LLM TOOL-CALLS & STREAM INTERCEPTOR PLAYGROUND
         ==================================================================== */}
      {activeTab === "llm-mcp" ? (
        <div
          id="builtin-panel-llm-mcp"
          role="tabpanel"
          aria-labelledby="builtin-tab-llm-mcp"
          className="sw-panel workbench-deck__content"
          data-testid="panel-llm-mcp"
        >
          <div className="sw-split-2col">
            <details className="sw-accordion" open>
              <summary className="sw-accordion__summary">
                <ChevronRight size={13} />
                <span>LLM Stream &lt;calc&gt; / &lt;cas&gt; / &lt;matrix&gt; Auto-Interceptor</span>
                <small>{liveLlmInterception.interceptedCount} deterministic interceptions</small>
              </summary>
              <div className="sw-accordion__body">
                <label className="structured-io-workbench__editor">
                  <span>Simulated LLM Stream Output with Inline Calculation Tags</span>
                  <textarea
                    aria-label="LLM stream input with inline tags"
                    value={llmStreamDraft}
                    onChange={(e) => setLlmStreamDraft(e.target.value)}
                    rows={3}
                  />
                </label>
                <div className="sw-kv-row">
                  <span>Patched Deterministic Stream</span>
                  <code data-testid="llm-patched-stream-output">
                    {liveLlmInterception.patchedStreamText}
                  </code>
                </div>
              </div>
            </details>

            <div className="sw-col-stack">
              <details className="sw-accordion" open>
                <summary className="sw-accordion__summary">
                  <ChevronRight size={13} />
                  <span>Intercepted Tool Receipts &amp; Injected Tool Messages</span>
                  <small>{liveLlmInterception.toolReceipts.length} receipts</small>
                </summary>
                <ol className="sw-accordion__body sw-tape-list" data-testid="llm-intercepted-receipts">
                  {liveLlmInterception.toolReceipts.map((rec) => (
                    <li key={rec.callId} className="sw-tape-item">
                      <span>
                        <strong>[{rec.toolName}]</strong> ({rec.source}) →{" "}
                        <code>{rec.outputSummary}</code>
                      </span>
                      <small>{rec.latencyMs}ms</small>
                    </li>
                  ))}
                </ol>
              </details>

              <details className="sw-accordion">
                <summary className="sw-accordion__summary">
                  <ChevronRight size={13} />
                  <span>Official MCP / OpenAI / Anthropic Tool Schemas</span>
                  <small data-testid="llm-mcp-schema-count">
                    {llmToolDeclarations.length} schemas
                  </small>
                </summary>
                <pre className="sw-code-drawer sw-accordion__body" data-testid="llm-mcp-schema-json">
                  <code>
                    {JSON.stringify(
                      llmToolDeclarations.map((d) => d.mcpTool),
                      null,
                      2,
                    )}
                  </code>
                </pre>
              </details>
            </div>
          </div>
        </div>
      ) : null}

      {/* ====================================================================
          TAB 2: UNIT, DATA SIZE & BASE CONVERTER
         ==================================================================== */}
      {activeTab === "converter" ? (
        <div
          id="builtin-panel-converter"
          role="tabpanel"
          aria-labelledby="builtin-tab-converter"
          className="sw-panel workbench-deck__content"
          data-testid="panel-converter"
        >
          <div className="structured-io-workbench__controls">
            <label>
              <span>Unit Category</span>
              <select
                aria-label="Conversion category"
                value={unitCategory}
                onChange={(e) => handleCategoryChange(e.target.value as UnitCategory)}
              >
                {Object.keys(UNIT_OPTIONS_BY_CATEGORY).map((cat) => (
                  <option key={cat} value={cat}>
                    {cat.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Input Value</span>
              <input
                type="number"
                aria-label="Unit conversion input value"
                value={unitValue}
                onChange={(e) => setUnitValue(Number.parseFloat(e.target.value) || 0)}
              />
            </label>
            <label>
              <span>From Unit</span>
              <select
                aria-label="From unit"
                value={fromUnit}
                onChange={(e) => setFromUnit(e.target.value)}
              >
                {UNIT_OPTIONS_BY_CATEGORY[unitCategory].map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>To Unit</span>
              <select
                aria-label="To unit"
                value={toUnit}
                onChange={(e) => setToUnit(e.target.value)}
              >
                {UNIT_OPTIONS_BY_CATEGORY[unitCategory].map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="button button--ghost"
              onClick={swapUnits}
              aria-label="Swap conversion units"
            >
              <ArrowLeftRight size={14} /> Swap
            </button>
          </div>

          <div
            className="structured-io-workbench__block-summary"
            role="region"
            aria-label="Unit conversion result"
          >
            <span>
              <small>Converted Output</small>
              <strong data-testid="converter-output-value">
                {liveConversion.formattedOutput} {liveConversion.toUnit}
              </strong>
              <em>{liveConversion.formulaSummary}</em>
            </span>
          </div>

          {/* Programmer Base & IEEE-754 Float Inspector */}
          <section
            className="structured-io-workbench__block"
            aria-label="Programmer base and IEEE-754 inspector"
          >
            <div className="structured-io-workbench__section-heading">
              <span>
                <strong>Programmer Base &amp; IEEE-754 Bit Inspector</strong>
                <small>8/16/32/64-bit two&apos;s complement &amp; IEEE-754 float layout</small>
              </span>
              <Binary size={15} />
            </div>
            <div className="structured-io-workbench__controls">
              <label>
                <span>Integer / Float Literal</span>
                <input
                  aria-label="Programmer literal input"
                  value={programmerInput}
                  onChange={(e) => setProgrammerInput(e.target.value)}
                />
              </label>
              <label>
                <span>Input Base</span>
                <select
                  aria-label="Programmer input base"
                  value={programmerBase}
                  onChange={(e) =>
                    setProgrammerBase(Number.parseInt(e.target.value, 10) as 2 | 8 | 10 | 16)
                  }
                >
                  <option value={10}>DEC (10)</option>
                  <option value={16}>HEX (16)</option>
                  <option value={8}>OCT (8)</option>
                  <option value={2}>BIN (2)</option>
                </select>
              </label>
            </div>

            <div className="structured-io-workbench__block-summary">
              <span>
                <small>Radix Representations</small>
                <strong className="structured-io-workbench__mono" data-testid="prog-radix-summary">
                  HEX: {liveProgrammerConversion.hex} · DEC: {liveProgrammerConversion.decimal} ·
                  OCT: {liveProgrammerConversion.octal} · BIN: {liveProgrammerConversion.binary}
                </strong>
              </span>
              <span>
                <small>IEEE-754 Float32 / Float64</small>
                <strong className="structured-io-workbench__mono" data-testid="prog-ieee754-summary">
                  F32: {liveProgrammerConversion.ieee754Float32.hex} (exp:{" "}
                  {liveProgrammerConversion.ieee754Float32.exponentUnbiased}) · F64:{" "}
                  {liveProgrammerConversion.ieee754Float64.hex}
                </strong>
              </span>
            </div>

            <ul aria-label="Two's complement bit widths">
              {liveProgrammerConversion.widths.map((w) => (
                <li key={w.bits}>
                  <strong>{w.bits}-bit:</strong> signed={w.signed} · unsigned={w.unsigned} · hex=
                  <code>{w.hex}</code>
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : null}

      {/* ====================================================================
          TAB 3: OMNIDEV SWISS-ARMY KNIFE
         ==================================================================== */}
      {activeTab === "swiss-army" ? (
        <div
          id="builtin-panel-swiss-army"
          role="tabpanel"
          aria-labelledby="builtin-tab-swiss-army"
          className="sw-panel workbench-deck__content"
          data-testid="panel-swiss-army"
        >
          {/* 1. JSON & Schema Validator */}
          <section className="structured-io-workbench__block" aria-label="JSON and Schema Validator">
            <div className="structured-io-workbench__section-heading">
              <span>
                <strong>JSON / JSONL &amp; Schema Validator</strong>
                <small>
                  Status: {jsonValidation.valid ? "Valid" : "Invalid"} ({jsonValidation.recordCount}{" "}
                  record)
                </small>
              </span>
              <Wrench size={15} />
            </div>
            <div className="structured-io-workbench__editors">
              <label className="structured-io-workbench__editor">
                <span>JSON / JSONL Payload</span>
                <textarea
                  aria-label="Swiss-army JSON payload"
                  value={jsonPayload}
                  onChange={(e) => setJsonPayload(e.target.value)}
                  rows={4}
                />
              </label>
              <label className="structured-io-workbench__editor">
                <span>JSON Schema Descriptor</span>
                <textarea
                  aria-label="Swiss-army JSON schema"
                  value={jsonSchemaText}
                  onChange={(e) => setJsonSchemaText(e.target.value)}
                  rows={4}
                />
              </label>
            </div>
            <div data-testid="swiss-json-validation-output">
              {jsonValidation.valid ? (
                <p>
                  <Check size={13} /> JSON payload conforms to schema contract.
                </p>
              ) : (
                <ul>
                  {jsonValidation.syntaxErrors.map((err, i) => (
                    <li key={`syn-${i}`}>
                      Syntax error at line {err.line}, column {err.column}: {err.message}
                    </li>
                  ))}
                  {jsonValidation.schemaViolations.map((v, i) => (
                    <li key={`sch-${i}`}>
                      Schema violation at {v.path}: {v.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {/* 2. Regex Tester */}
          <section className="structured-io-workbench__block" aria-label="Regular Expression Tester">
            <div className="structured-io-workbench__section-heading">
              <span>
                <strong>Regex Pattern Tester &amp; Replacement Preview</strong>
                <small>{regexResult.matchCount} match(es)</small>
              </span>
            </div>
            <div className="structured-io-workbench__controls">
              <label>
                <span>Regex Pattern</span>
                <input
                  aria-label="Regex pattern input"
                  value={regexPattern}
                  onChange={(e) => setRegexPattern(e.target.value)}
                />
              </label>
              <label>
                <span>Flags</span>
                <input
                  aria-label="Regex flags input"
                  value={regexFlags}
                  onChange={(e) => setRegexFlags(e.target.value)}
                />
              </label>
              <label>
                <span>Replacement Template</span>
                <input
                  aria-label="Regex replacement input"
                  value={regexReplacement}
                  onChange={(e) => setRegexReplacement(e.target.value)}
                />
              </label>
            </div>
            <label className="structured-io-workbench__editor">
              <span>Test String</span>
              <textarea
                aria-label="Regex test string"
                value={regexTestString}
                onChange={(e) => setRegexTestString(e.target.value)}
                rows={2}
              />
            </label>
            <p data-testid="swiss-regex-replacement-preview">
              Replacement Preview: <code>{regexResult.replacementPreview}</code>
            </p>
          </section>

          {/* 3. Hash, Codec, JWT & Token Counter */}
          <section
            className="structured-io-workbench__block"
            aria-label="Deterministic Hash, Codec and JWT Inspector"
          >
            <div className="structured-io-workbench__section-heading">
              <span>
                <strong>SHA-256 / FNV-1a / CRC32 / Base64 / JWT &amp; Token Counter</strong>
                <small>
                  {hashResult.counts.utf8ByteLength} bytes · ~{hashResult.counts.estimatedTokens}{" "}
                  tokens
                </small>
              </span>
              <Cpu size={15} />
            </div>
            <label className="structured-io-workbench__editor">
              <span>Input Text or JWT Token</span>
              <textarea
                aria-label="Hash and codec input"
                value={hashInput}
                onChange={(e) => setHashInput(e.target.value)}
                rows={2}
              />
            </label>
            <div className="structured-io-workbench__block-summary" data-testid="swiss-hash-summary">
              <span>
                <small>SHA-256</small>
                <strong className="structured-io-workbench__mono">{hashResult.sha256}</strong>
              </span>
              <span>
                <small>FNV-1a 64-bit &amp; CRC32</small>
                <strong className="structured-io-workbench__mono">
                  FNV1a: {hashResult.fnv1a64} · CRC32: {hashResult.crc32Hex}
                </strong>
              </span>
              <span>
                <small>Base64 &amp; Hex</small>
                <strong className="structured-io-workbench__mono">
                  B64: {hashResult.base64Encoded}
                </strong>
              </span>
            </div>
            {hashResult.jwtInspection.isJwt ? (
              <pre data-testid="swiss-jwt-decoded">
                <code>{JSON.stringify(hashResult.jwtInspection.payload, null, 2)}</code>
              </pre>
            ) : null}
          </section>

          {/* 4. DateTime & Cron Solver + 5. Code Syntax Balance */}
          <div className="structured-io-workbench__editors">
            <section className="structured-io-workbench__block" aria-label="DateTime and Cron Solver">
              <strong>DateTime Duration &amp; 5-Field Cron Solver</strong>
              <label>
                <span>Cron Expression (5-field)</span>
                <input
                  aria-label="Cron expression input"
                  value={cronInput}
                  onChange={(e) => setCronInput(e.target.value)}
                />
              </label>
              <label>
                <span>Start Timestamp (ISO / Epoch)</span>
                <input
                  aria-label="Timestamp A input"
                  value={timestampA}
                  onChange={(e) => setTimestampA(e.target.value)}
                />
              </label>
              <label>
                <span>End Timestamp (ISO / Epoch)</span>
                <input
                  aria-label="Timestamp B input"
                  value={timestampB}
                  onChange={(e) => setTimestampB(e.target.value)}
                />
              </label>
              <p data-testid="swiss-cron-duration">
                Duration: <strong>{cronResult.durationDifference?.humanReadable ?? "N/A"}</strong> ·
                Next trigger:{" "}
                <code>{cronResult.cronSolution?.nextTriggerTimesIso[0] ?? "Invalid"}</code>
              </p>
            </section>

            <section
              className="structured-io-workbench__block"
              aria-label="Code Syntax Balance Checker"
            >
              <strong>
                <Code2 size={14} /> Code Syntax &amp; Bracket Balance Checker
              </strong>
              <label>
                <span>Language</span>
                <select
                  aria-label="Syntax checker language"
                  value={syntaxLanguage}
                  onChange={(e) => setSyntaxLanguage(e.target.value as SupportedSyntaxLanguage)}
                >
                  <option value="ts">TypeScript / JS</option>
                  <option value="rust">Rust</option>
                  <option value="python">Python</option>
                  <option value="json">JSON</option>
                  <option value="sql">SQL</option>
                </select>
              </label>
              <label>
                <span>Source Code</span>
                <textarea
                  aria-label="Syntax checker code input"
                  value={syntaxCode}
                  onChange={(e) => setSyntaxCode(e.target.value)}
                  rows={4}
                />
              </label>
              <p data-testid="swiss-syntax-status">
                {syntaxResult.balanced
                  ? `Balanced (parens: ${syntaxResult.stats.parensCount}, brackets: ${syntaxResult.stats.bracketsCount}, braces: ${syntaxResult.stats.bracesCount})`
                  : `Unbalanced: ${syntaxResult.issues[0]?.message}`}
              </p>
            </section>
          </div>
        </div>
      ) : null}

      {/* ====================================================================
          TAB 4: ANTI-HALLUCINATION LIVE VERIFIER & AUTO-TRIGGER INSPECTOR
         ==================================================================== */}
      {activeTab === "anti-hallucination" ? (
        <div
          id="builtin-panel-anti-hallucination"
          role="tabpanel"
          aria-labelledby="builtin-tab-anti-hallucination"
          className="sw-panel workbench-deck__content"
          data-testid="panel-anti-hallucination"
        >
          <div className="structured-io-workbench__toolbar">
            <button
              type="button"
              className="button button--secondary"
              onClick={handleLoadAndVerifyActiveChatTurn}
              data-testid="verifier-load-active-chat-btn"
            >
              <ShieldCheck size={13} /> Load &amp; Verify Active Chat Turn
            </button>
          </div>
          <div className="structured-io-workbench__editors">
            <label className="structured-io-workbench__editor">
              <span>
                <strong>User Prompt</strong>
                <small>Pre-answer auto-trigger scan</small>
              </span>
              <textarea
                aria-label="Anti-hallucination user prompt"
                value={verifierPrompt}
                onChange={(e) => setVerifierPrompt(e.target.value)}
                rows={3}
              />
            </label>
            <label className="structured-io-workbench__editor">
              <span>
                <strong>Assistant Draft Response</strong>
                <small>Post-draft numeric claim, citation &amp; uncertainty audit</small>
              </span>
              <textarea
                aria-label="Anti-hallucination assistant draft"
                value={verifierDraft}
                onChange={(e) => setVerifierDraft(e.target.value)}
                rows={3}
              />
            </label>
          </div>

          {/* Epistemic Score & Verification Badge Summary */}
          <div
            className="structured-io-workbench__block-summary"
            role="region"
            aria-label="Epistemic verification summary"
          >
            <span>
              <small>Verification Badge</small>
              <strong data-testid="verifier-badge">{auditReport.overallBadge}</strong>
              <em>{auditReport.shouldAbstain ? "Abstention recommended" : "Active verification"}</em>
            </span>
            <span>
              <small>Epistemic Grounding Score</small>
              <strong data-testid="verifier-epistemic-score">
                {auditReport.epistemicScore.toFixed(2)}
              </strong>
              <em>{auditReport.calibration.rationale}</em>
            </span>
            <span>
              <small>Auto-Triggered Skills &amp; Tools</small>
              <strong data-testid="verifier-triggered-count">
                {auditReport.triggeredSkillIds.length} skills · {auditReport.receipts.length}{" "}
                receipts
              </strong>
              <em>{auditReport.triggeredToolIds.join(", ")}</em>
            </span>
          </div>

          {/* Inline Numeric Claims Audit */}
          <section
            className="structured-io-workbench__validation"
            aria-label="Inline numeric claims verification"
          >
            <div className="structured-io-workbench__validation-head">
              <div>
                <strong>Inline Numeric Claim Verifier</strong>
                <small>
                  Checked {auditReport.numericVerification?.totalClaimsChecked ?? 0} equation(s) ·{" "}
                  {auditReport.numericVerification?.discrepancyCount ?? 0} discrepancy(ies)
                </small>
              </div>
              {(auditReport.numericVerification?.discrepancyCount ?? 0) > 0 ? (
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={applyAutoCorrectedDraft}
                  aria-label="Apply deterministic math correction"
                >
                  <Check size={13} /> Apply Auto-Corrected Draft
                </button>
              ) : null}
            </div>
            <ul data-testid="verifier-numeric-claims-list">
              {(auditReport.numericVerification?.claims ?? []).map((claim, idx) => (
                <li key={`${claim.rawMatch}-${idx}`}>
                  {claim.status === "verified" ? (
                    <Check size={13} />
                  ) : (
                    <AlertTriangle size={13} />
                  )}{" "}
                  <strong>{claim.rawMatch}</strong> → expected{" "}
                  <code>{claim.expectedValue}</code>, claimed <code>{claim.claimedValue}</code> (
                  {claim.status})
                </li>
              ))}
            </ul>
          </section>

          {/* Citation Grounding Cross-Check */}
          <section
            className="structured-io-workbench__block"
            aria-label="Citation grounding cross-check"
          >
            <strong>Citation &amp; Identifier Grounding Cross-Checker</strong>
            <ul data-testid="verifier-citations-list">
              {(auditReport.citationCrossCheck?.items ?? []).map((item, idx) => (
                <li key={`${item.target}-${idx}`}>
                  {item.verified ? <Check size={13} /> : <AlertTriangle size={13} />}{" "}
                  <strong>[{item.kind}]</strong> <code>{item.target}</code> — {item.reason}
                </li>
              ))}
            </ul>
          </section>

          {/* Auto-Trigger Execution Receipts */}
          <section
            className="structured-io-workbench__source"
            aria-label="Deterministic tool execution receipts"
          >
            <header>
              <div>
                <strong>Auto-Triggered Tool Execution Receipts</strong>
                <small>Deterministic pre-answer and post-draft verification trace</small>
              </div>
            </header>
            <ol className="structured-io-workbench__source-lines" data-testid="verifier-receipts-list">
              {auditReport.receipts.map((rec) => (
                <li key={rec.receiptId}>
                  <span>{rec.phase}</span>
                  <code>
                    [{rec.toolId}] ({rec.skillId}) — {rec.triggerReason} → {rec.status}
                  </code>
                </li>
              ))}
            </ol>
          </section>
        </div>
      ) : null}

      {/* ====================================================================
          LAYER 3: 24px BOTTOM STATUS BAR (.sw-statusbar)
         ==================================================================== */}
      <footer
        className="sw-statusbar structured-io-workbench__toolbar"
        role="status"
        aria-live="polite"
        data-testid="workbench-status-bar"
      >
        <div className="sw-statusbar__left">
          <Sparkles size={12} />
          <span>{statusMessage}</span>
        </div>
        <div className="sw-statusbar__right">
          <span className="sw-badge" data-testid="mcp-server-ready-badge">
            MCP Tool Server: Ready · {llmToolDeclarations.length} Tools
          </span>

          <label
            className="sw-toggle-pill"
            title="Automatically intercept <calc>, <cas>, <matrix>, <verify> & tool_calls in LLM streams"
          >
            <input
              type="checkbox"
              checked={llmAutoIntercept}
              onChange={(e) => setLlmAutoIntercept(e.target.checked)}
              aria-label="Auto-Intercept <calc> & tool_calls"
              data-testid="llm-auto-intercept-toggle"
            />
            <Bot size={12} />
            <span>Auto-Intercept &lt;calc&gt;</span>
          </label>

          <label className="sw-theme-picker" title="Select technical color theme">
            <Palette size={12} />
            <select
              aria-label="Workbench theme preset"
              data-testid="workbench-theme-selector"
              value={themePreset}
              onChange={(e) => setThemePreset(e.target.value as WorkbenchThemePreset)}
            >
              <option value="auto">Theme: Auto</option>
              <option value="vscode-dark">VS Code Dark</option>
              <option value="linear-carbon">Linear Carbon</option>
              <option value="claude-warm">Claude Warm</option>
            </select>
          </label>

          <span
            className="sw-readout-pill"
            data-testid="workbench-global-badge"
          >
            {auditReport.overallBadge === "verified" ? (
              <ShieldCheck size={12} />
            ) : (
              <ShieldAlert size={12} />
            )}
            {auditReport.overallBadge}
          </span>
        </div>
      </footer>
    </section>
  );
}

export default BuiltinCalculatorWorkbench;
