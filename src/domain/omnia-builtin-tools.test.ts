import { describe, expect, it } from "vitest";

import {
  OMNIA_ANTI_HALLUCINATION_SKILLS,
  OMNIA_BUILTIN_TOOLS,
  autoTriggerBuiltinToolsForTurn,
  buildLlmBuiltinToolDeclarations,
  convertProgrammerBase,
  evaluateComplexExpression,
  executeBuiltinTool,
  inspectIeee754Float,
  interceptAndExecuteLlmToolCalls,
  runBooleanSatSolver,
  runCitationFactCrossChecker,
  runCodeSyntaxBalanceChecker,
  runDateTimeCronSolver,
  runHashCodec,
  runJsonSchemaValidator,
  runMatrixLinearAlgebra,
  runNumericClaimVerifier,
  runRegexTester,
  runScientificCalculator,
  runStatsAndQuantSolver,
  runSymbolicCasSolver,
  runUncertaintyAbstentionCalibrator,
  runUnitCurrencyConverter,
  sampleFunctionPlotPoints,
  solveOdeRk4,
  solveRootsNewtonBisection,
  toRationalApproximation,
} from "./omnia-builtin-tools";

describe("Omnia Built-in Deterministic Tools Catalog", () => {
  it("exposes all 10 deterministic zero-eval built-in tools and 10 anti-hallucination skills", () => {
    expect(OMNIA_BUILTIN_TOOLS).toHaveLength(10);
    for (const tool of OMNIA_BUILTIN_TOOLS) {
      expect(tool.deterministic).toBe(true);
      expect(tool.zeroEval).toBe(true);
    }
    expect(OMNIA_ANTI_HALLUCINATION_SKILLS.length).toBeGreaterThanOrEqual(8);
  });

  it("evaluates arithmetic, precedence, factorial, bitwise, constants, and functions in builtin_scientific_calculator", () => {
    expect(runScientificCalculator("2 + 3 * 4").value).toBe(14);
    expect(runScientificCalculator("(2 + 3) * 4").value).toBe(20);
    expect(runScientificCalculator("2 ^ 3 ^ 2").value).toBe(512);
    expect(runScientificCalculator("5! + 0!").value).toBe(121);
    expect(runScientificCalculator("0xFF + 0b1010 + 0o10").value).toBe(255 + 10 + 8);
    expect(runScientificCalculator("(12 & 10) | (1 << 4)").value).toBe((12 & 10) | 16);
    expect(runScientificCalculator("xor(0b1100, 0b1010)").value).toBe(0b0110);

    // Constants & Variables
    const withVars = runScientificCalculator({
      expression: "2 * pi * r + ans",
      variables: { r: 10, ans: 5 },
    });
    expect(withVars.ok).toBe(true);
    expect(withVars.value).toBeCloseTo(2 * Math.PI * 10 + 5, 10);
    expect(runScientificCalculator("c").value).toBe(299792458);
    expect(runScientificCalculator("N_A").value).toBeCloseTo(6.02214076e23, 15);

    // Trig, logs, combinatorics, stats
    expect(runScientificCalculator({ expression: "sin(30) + cos(60)", angleUnit: "deg" }).value).toBeCloseTo(1, 10);
    expect(runScientificCalculator("ln(e^3) + log10(1000) + log2(64)").value).toBeCloseTo(3 + 3 + 6, 10);
    expect(runScientificCalculator("gcd(48, 18, 30)").value).toBe(6);
    expect(runScientificCalculator("lcm(12, 15, 20)").value).toBe(60);
    expect(runScientificCalculator("nCr(10, 3) + nPr(5, 2)").value).toBe(120 + 20);
    expect(runScientificCalculator("mean(10, 20, 30, 40) + median(1, 9, 3, 5)").value).toBe(25 + 4);
    expect(runScientificCalculator("std(2, 4, 4, 4, 5, 5, 7, 9)").value).toBeCloseTo(2, 10);
    expect(runScientificCalculator("var(2, 4, 4, 4, 5, 5, 7, 9)").value).toBeCloseTo(4, 10);
    expect(runScientificCalculator("clamp(150, 0, 100)").value).toBe(100);
  });

  it("computes numerical derivatives, Simpson's rule definite integrals, and 2x2/3x3 matrix operations", () => {
    const derivResult = runScientificCalculator("deriv(x^3 + 4*x^2 - 5*x + 1, 2)");
    // d/dx (x^3 + 4x^2 - 5x + 1) at x=2 is 3(4) + 8(2) - 5 = 23
    expect(derivResult.ok).toBe(true);
    expect(derivResult.value).toBeCloseTo(23, 6);

    const integralPoly = runScientificCalculator("integrate(x^2, 0, 3)");
    expect(integralPoly.ok).toBe(true);
    expect(integralPoly.value).toBeCloseTo(9, 8);

    const integralTrig = runScientificCalculator("integrate(sin(x), 0, pi)");
    expect(integralTrig.ok).toBe(true);
    expect(integralTrig.value).toBeCloseTo(2, 8);

    expect(runScientificCalculator("det([[1, 2], [3, 4]])").value).toBe(-2);
    expect(runScientificCalculator("det([[6, 1, 1], [4, -2, 5], [2, 8, 7]])").value).toBe(-306);
    expect(runScientificCalculator("trace([[1, 2, 3], [4, 5, 6], [7, 8, 9]])").value).toBe(15);

    const approx = toRationalApproximation(0.375);
    expect(approx.formatted).toBe("3/8");

    const calcReadout = runScientificCalculator("255");
    expect(calcReadout.programmerReadout.hex).toBe("0xFF");
    expect(calcReadout.programmerReadout.binary).toBe("0b11111111");
    expect(calcReadout.programmerReadout.octal).toBe("0o377");
  });

  it("converts across all physical/digital units, currencies, two's complement widths, and IEEE-754 floats", () => {
    expect(
      runUnitCurrencyConverter({ value: 5, fromUnit: "km", toUnit: "mi" }).outputValue,
    ).toBeCloseTo(3.10685596, 5);
    expect(
      runUnitCurrencyConverter({ value: 100, fromUnit: "C", toUnit: "F" }).outputValue,
    ).toBeCloseTo(212, 8);
    expect(
      runUnitCurrencyConverter({ value: 0, fromUnit: "C", toUnit: "K" }).outputValue,
    ).toBeCloseTo(273.15, 8);
    expect(
      runUnitCurrencyConverter({ value: 1, fromUnit: "GiB", toUnit: "MB" }).outputValue,
    ).toBeCloseTo(1073.741824, 5);
    expect(
      runUnitCurrencyConverter({ value: 2, fromUnit: "d", toUnit: "s" }).outputValue,
    ).toBe(172800);
    expect(
      runUnitCurrencyConverter({ value: 1, fromUnit: "atm", toUnit: "kPa" }).outputValue,
    ).toBeCloseTo(101.325, 5);
    expect(
      runUnitCurrencyConverter({
        value: 100,
        fromUnit: "USD",
        toUnit: "EUR",
        customCurrencyRates: { USD: 1, EUR: 0.9 },
      }).outputValue,
    ).toBeCloseTo(90, 6);

    const prog = convertProgrammerBase("-42", 10);
    expect(prog.widths.find((w) => w.bits === 8)?.hex).toBe("0xD6");
    expect(prog.widths.find((w) => w.bits === 8)?.unsigned).toBe("214");

    const f32 = inspectIeee754Float(1.5, "float32");
    expect(f32.hex).toBe("0x3FC00000");
    expect(f32.signBit).toBe(0);
    expect(f32.exponentBiased).toBe(127);
  });

  it("validates JSON and JSONL with schema descriptors and reports line/column syntax errors", () => {
    const validRes = runJsonSchemaValidator({
      payload: '{"name": "Omnia", "count": 3}',
      schema: {
        type: "object",
        required: ["name", "count"],
        properties: {
          name: { type: "string", minLength: 2 },
          count: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
    });
    expect(validRes.valid).toBe(true);
    expect(validRes.recordCount).toBe(1);

    const invalidSchemaRes = runJsonSchemaValidator({
      payload: '{"name": "O", "extra": true}',
      schema: {
        type: "object",
        required: ["name", "count"],
        properties: {
          name: { type: "string", minLength: 2 },
          count: { type: "integer" },
        },
        additionalProperties: false,
      },
    });
    expect(invalidSchemaRes.valid).toBe(false);
    expect(invalidSchemaRes.schemaViolations.length).toBeGreaterThanOrEqual(3);

    const jsonlRes = runJsonSchemaValidator({
      payload: '{"id": 1}\n{"id": 2}',
      mode: "jsonl",
    });
    expect(jsonlRes.valid).toBe(true);
    expect(jsonlRes.mode).toBe("jsonl");
    expect(jsonlRes.recordCount).toBe(2);

    const syntaxErrRes = runJsonSchemaValidator({
      payload: '{\n  "valid": 1,\n  "broken": \n}',
    });
    expect(syntaxErrRes.valid).toBe(false);
    expect(syntaxErrRes.syntaxErrors[0]?.line).toBeGreaterThanOrEqual(3);
  });

  it("executes regular expressions with capture groups, named groups, and replacement preview", () => {
    const res = runRegexTester({
      pattern: "(?<year>\\d{4})-(?<month>\\d{2})-(?<day>\\d{2})",
      flags: "g",
      testString: "Release dates: 2026-10-18 and 2027-01-05.",
      replacement: "$<day>/$<month>/$<year>",
    });
    expect(res.ok).toBe(true);
    expect(res.matchCount).toBe(2);
    expect(res.matches[0]?.namedGroups).toEqual({
      year: "2026",
      month: "10",
      day: "18",
    });
    expect(res.replacementPreview).toBe("Release dates: 18/10/2026 and 05/01/2027.");
  });

  it("computes deterministic SHA-256, FNV-1a 64-bit, CRC32, Base64, JWT inspection, and token counts", () => {
    const emptyHash = runHashCodec("");
    expect(emptyHash.sha256).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );

    const abcHash = runHashCodec("abc");
    expect(abcHash.sha256).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );

    const crcCheck = runHashCodec("123456789");
    expect(crcCheck.crc32Hex).toBe("cbf43926");
    expect(crcCheck.fnv1a64).toHaveLength(16);

    const decoded = runHashCodec({
      input: abcHash.base64Encoded,
      decodeDirection: "decode",
      decodeFormat: "base64",
    });
    expect(decoded.decodedOutput).toBe("abc");

    const sampleJwt =
      `${ runHashCodec('{"alg":"HS256","typ":"JWT"}').base64Encoded }.` +
      `${ runHashCodec('{"sub":"user-42","exp":2000000000,"iat":1700000000}').base64Encoded }.sig123`;
    const jwtCheck = runHashCodec({ input: sampleJwt, nowEpochSeconds: 1800000000 });
    expect(jwtCheck.jwtInspection.isJwt).toBe(true);
    expect(jwtCheck.jwtInspection.payload?.sub).toBe("user-42");
    expect(jwtCheck.jwtInspection.isExpired).toBe(false);
    expect(jwtCheck.counts.utf8ByteLength).toBe(sampleJwt.length);
  });

  it("parses timestamps, computes exact durations, and solves 5-field Cron expressions", () => {
    const res = runDateTimeCronSolver({
      timestampA: "2026-10-18T00:00:00.000Z",
      timestampB: "2026-10-20T03:30:45.000Z",
      cronExpression: "*/15 9-17 * * MON-FRI",
      nextCount: 3,
      referenceTime: "2026-10-19T08:50:00.000Z", // Monday
    });
    expect(res.ok).toBe(true);
    expect(res.durationDifference?.days).toBe(2);
    expect(res.durationDifference?.hours).toBe(3);
    expect(res.durationDifference?.minutes).toBe(30);
    expect(res.durationDifference?.seconds).toBe(45);
    expect(res.cronSolution?.valid).toBe(true);
    expect(res.cronSolution?.nextTriggerTimesIso).toEqual([
      "2026-10-19T09:00:00.000Z",
      "2026-10-19T09:15:00.000Z",
      "2026-10-19T09:30:00.000Z",
    ]);
  });

  it("checks code syntax balance for brackets, strings, and comments with exact line/column reporting", () => {
    const balanced = runCodeSyntaxBalanceChecker({
      language: "ts",
      code: `export function greet(name: string) {\n  // ignore ) in comment\n  return \`Hello \${name} (welcome!)\`;\n}`,
    });
    expect(balanced.balanced).toBe(true);
    expect(balanced.issues).toHaveLength(0);

    const unbalanced = runCodeSyntaxBalanceChecker({
      language: "ts",
      code: `function broken() {\n  const arr = [1, 2, (3 + 4];\n}`,
    });
    expect(unbalanced.balanced).toBe(false);
    expect(unbalanced.issues[0]?.kind).toBe("mismatched-bracket");
    expect(unbalanced.issues[0]?.line).toBe(2);
  });

  it("cross-checks citations, line numbers, identifiers, and quotes against ground truth", () => {
    const check = runCitationFactCrossChecker({
      responseText:
        'See `runScientificCalculator` in [src/domain/omnia-builtin-tools.ts:15] and `nonExistentSymbol` in [src/missing/file.ts:99]. Also note "local-first, provider-agnostic AI workspace".',
      groundTruth: {
        files: [
          {
            path: "src/domain/omnia-builtin-tools.ts",
            lineCount: 500,
            content: "export function runScientificCalculator() {}",
          },
        ],
        facts: ["A local-first, provider-agnostic AI workspace for Windows 11."],
      },
    });
    expect(check.verifiedCount).toBeGreaterThanOrEqual(3);
    expect(check.unverifiedCount).toBeGreaterThanOrEqual(2);
    expect(check.hallucinatedCitations).toContain("src/missing/file.ts:99");
    expect(check.hallucinatedCitations).toContain("nonExistentSymbol");
  });

  it("verifies inline numeric claims and flags arithmetic hallucinations", () => {
    const res = runNumericClaimVerifier(
      "The cluster processes 125 * 48 = 6,000 requests/min, and 15% of 240 is 36. However, if 35 * 12 = 450, that would be wrong.",
    );
    expect(res.totalClaimsChecked).toBe(3);
    expect(res.verifiedClaimsCount).toBe(2);
    expect(res.discrepancyCount).toBe(1);
    expect(res.allClaimsAccurate).toBe(false);
    expect(res.correctedText).toContain("35 * 12 = 420");
  });

  it("auto-triggers deterministic tools and calibrates epistemic abstention badges for a turn", () => {
    const report = autoTriggerBuiltinToolsForTurn({
      userPrompt: "Calculate 125 * 48 and convert 100 C to F.",
      assistantDraft:
        "According to [src/domain/omnia-builtin-tools.ts:10], 125 * 48 = 5,900 and 15% of 200 is 30.",
      groundTruth: {
        files: [{ path: "src/domain/omnia-builtin-tools.ts", lineCount: 100 }],
      },
    });

    expect(report.triggeredToolIds).toContain("builtin_scientific_calculator");
    expect(report.triggeredToolIds).toContain("builtin_unit_currency_converter");
    expect(report.triggeredToolIds).toContain("builtin_numeric_claim_verifier");
    expect(report.triggeredToolIds).toContain("builtin_citation_fact_cross_checker");
    expect(report.triggeredToolIds).toContain("builtin_uncertainty_abstention_calibrator");
    expect(report.overallBadge).toBe("math-discrepancy-detected");
    expect(report.autoCorrectedDraft).toContain("125 * 48 = 6000");

    // Verify unified dispatcher executeBuiltinTool
    const calcViaDispatcher = executeBuiltinTool("builtin_scientific_calculator", "7 * 8") as {
      value: number;
    };
    expect(calcViaDispatcher.value).toBe(56);

    // Verify abstain-recommended calibration when heavily speculative and ungrounded
    const abstainCal = runUncertaintyAbstentionCalibrator({
      responseText:
        "I think it might be around 500, and I'm guessing [src/fake1.ts:10] and [src/fake2.ts:20] probably handle it, if I recall correctly.",
      groundTruth: {
        files: [{ path: "src/real.ts", lineCount: 20 }],
      },
    });
    expect(abstainCal.badge).toBe("abstain-recommended");
    expect(abstainCal.shouldAbstain).toBe(true);
  });

  it("generates 14 official OpenAI/Anthropic/MCP tool declarations and intercepts inline <calc>/<cas>/<matrix>/<verify> tags and tool_calls", () => {
    const declarations = buildLlmBuiltinToolDeclarations();
    expect(declarations).toHaveLength(14);
    expect(declarations[0]?.openAiTool.type).toBe("function");
    expect(declarations[0]?.anthropicTool.input_schema.type).toBe("object");
    expect(declarations[0]?.mcpTool.inputSchema.type).toBe("object");

    const intercepted = interceptAndExecuteLlmToolCalls({
      streamText:
        "Memory = <calc>125 * 48</calc> MB. Derivative: <cas>3*x^3 - 5*x^2 + 4*x - 7</cas>. Matrix: <matrix>[[1, 2], [3, 4]]</matrix>. Audit: <verify>35 * 12 = 450</verify>",
      toolCalls: [
        {
          id: "call_1",
          name: "builtin_scientific_calculator",
          arguments: '{"expression": "2^10"}',
        },
      ],
    });

    expect(intercepted.interceptedCount).toBe(5);
    expect(intercepted.patchedStreamText).toContain("6000");
    expect(intercepted.patchedStreamText).toContain("9*x^2 - 10*x + 4");
    expect(intercepted.patchedStreamText).toContain("det=-2");
    expect(intercepted.patchedStreamText).toContain("35 * 12 = 420");
    expect(intercepted.injectedToolResultMessages).toHaveLength(5);
    expect(intercepted.injectedToolResultMessages[4]?.tool_call_id).toBe("call_1");
  });

  it("executes Symbolic CAS differentiation, integration, Taylor series, Newton-Bisection root finding, RK4 ODE, and complex numbers", () => {
    const cas = runSymbolicCasSolver({
      expression: "d/dx (3*x^3 - 5*x^2 + 4*x - 7)",
      taylorCenter: 0,
      taylorOrder: 3,
      ode: { dydxExpr: "y", x0: 0, y0: 1, targetX: 1, steps: 50 },
      complexExpression: "(3 + 4i) * (1 - 2i)",
    });

    expect(cas.ok).toBe(true);
    expect(cas.symbolicDerivative).toBe("9*x^2 - 10*x + 4");
    expect(cas.symbolicIntegral).toBe("0.75*x^4 - 1.6667*x^3 + 2*x^2 - 7*x + C");
    expect(cas.odeSolution?.finalY).toBeCloseTo(Math.E, 4);
    expect(cas.complexResult?.real).toBe(11);
    expect(cas.complexResult?.imag).toBe(-2);

    const roots = solveRootsNewtonBisection("x^2 - 5*x + 6", -10, 10);
    expect(roots).toEqual([2, 3]);

    const rk4 = solveOdeRk4("2*x", 0, 0, 3, 30);
    expect(rk4.finalY).toBeCloseTo(9, 5);

    const cplx = evaluateComplexExpression("(3 + 4i) * (1 + 0i)");
    expect(cplx.magnitude).toBeCloseTo(5, 6);
  });

  it("computes N×N Matrix determinant, inverse, RREF, trace, Frobenius norm, and eigenvalues", () => {
    const mat2 = runMatrixLinearAlgebra({
      matrixA: [
        [4, 2],
        [1, 3],
      ],
      matrixB: [
        [1, 0],
        [0, 1],
      ],
    });
    expect(mat2.ok).toBe(true);
    expect(mat2.determinant).toBe(10);
    expect(mat2.trace).toBe(7);
    expect(mat2.rank).toBe(2);
    expect(mat2.rref).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(mat2.inverse?.[0]?.[0]).toBeCloseTo(0.3, 6);
    expect(mat2.inverse?.[0]?.[1]).toBeCloseTo(-0.2, 6);
    expect(mat2.eigenvalues).toEqual(["5", "2"]);

    const mat4 = runMatrixLinearAlgebra({
      matrixA: [
        [2, 0, 0, 0],
        [0, 3, 0, 0],
        [0, 0, 4, 0],
        [0, 0, 0, 5],
      ],
    });
    expect(mat4.determinant).toBe(120);
    expect(mat4.trace).toBe(14);
    expect(mat4.rank).toBe(4);
  });

  it("computes statistics, Bayes posterior, Shannon entropy, NPV, IRR, CAGR, and Black-Scholes options + Greeks", () => {
    const sq = runStatsAndQuantSolver({
      normal: { x: 0, mean: 0, stdDev: 1 },
      binomial: { n: 4, k: 2, p: 0.5 },
      poisson: { lambda: 2, k: 2 },
      regression: { xValues: [1, 2, 3, 4], yValues: [3, 5, 7, 9] },
      entropyProbabilities: [0.5, 0.5],
      bayes: { priorA: 0.01, probBGivenA: 0.99, probBGivenNotA: 0.05 },
      finance: {
        discountRate: 0.1,
        cashFlows: [-1000, 500, 600],
        beginValue: 100,
        endValue: 121,
        years: 2,
        blackScholes: {
          spotPrice: 100,
          strikePrice: 100,
          timeToMaturityYears: 1,
          riskFreeRate: 0.05,
          volatility: 0.2,
        },
      },
    });

    expect(sq.ok).toBe(true);
    expect(sq.normalResult?.cdf).toBeCloseTo(0.5, 6);
    expect(sq.binomialResult?.pmf).toBeCloseTo(0.375, 6);
    expect(sq.regressionResult?.slope).toBeCloseTo(2, 6);
    expect(sq.regressionResult?.intercept).toBeCloseTo(1, 6);
    expect(sq.regressionResult?.rSquared).toBeCloseTo(1, 6);
    expect(sq.shannonEntropyBits).toBeCloseTo(1, 6);
    expect(sq.bayesPosterior).toBeCloseTo(0.166667, 4);
    expect(sq.financeResult?.cagr).toBeCloseTo(0.1, 5);
    expect(sq.financeResult?.blackScholes?.callPrice).toBeCloseTo(10.45058, 3);
    expect(sq.financeResult?.blackScholes?.deltaCall).toBeGreaterThan(0.5);
  });

  it("solves Boolean SAT truth tables, Tautology/Contradiction classification, IEEE-754 64-bit ULP, and function plot samples", () => {
    const sat = runBooleanSatSolver("(A && B) -> (!C || A)");
    expect(sat.ok).toBe(true);
    expect(sat.classification).toBe("Tautology");
    expect(sat.isTautology).toBe(true);
    expect(sat.truthTable).toHaveLength(8);

    const xorSat = runBooleanSatSolver("A ^ B");
    expect(xorSat.classification).toBe("Satisfiable (SAT)");
    expect(xorSat.satisfyingAssignments).toHaveLength(2);
    expect(xorSat.canonicalDnf).toContain("(!A & B)");

    const unsat = runBooleanSatSolver("A && !A");
    expect(unsat.classification).toBe("Contradiction");
    expect(unsat.isSatisfiable).toBe(false);

    const f64 = inspectIeee754Float(1.0);
    expect(f64.precision).toBe("float64");
    expect(f64.signBit).toBe(0);
    expect(f64.exponentBiased).toBe(1023);
    expect(f64.exponentUnbiased).toBe(0);
    expect(f64.specialState).toBe("Normalized");
    expect(f64.ulp).toBeCloseTo(Number.EPSILON, 20);

    const plot = sampleFunctionPlotPoints("x^2 - 4", -4, 4, 80);
    expect(plot.ok).toBe(true);
    expect(plot.zeroCrossings.length).toBeGreaterThanOrEqual(2);
    expect(plot.localMinima.length).toBeGreaterThanOrEqual(1);
  });

  it("enforces AST depth, integration step bounds, ReDoS regex guards, and non-verified calibration when zero claims are checked", () => {
    const boundaryValid = "(".repeat(63) + "1" + ")".repeat(63);
    const boundaryValidRes = runScientificCalculator(boundaryValid);
    expect(boundaryValidRes.ok).toBe(true);
    expect(boundaryValidRes.value).toBe(1);

    const deepNested = "(".repeat(64) + "1" + ")".repeat(64);
    const deepRes = runScientificCalculator(deepNested);
    expect(deepRes.ok).toBe(false);
    expect(deepRes.error).toMatch(/depth/i);

    const hugeFlatChain = Array.from({ length: 1000 }, () => "1").join("+");
    const flatChainRes = runScientificCalculator(hugeFlatChain);
    expect(flatChainRes.ok).toBe(false);
    expect(flatChainRes.error).toMatch(/depth/i);

    const hugeIntegral = runScientificCalculator("integrate(x^2, 0, 1, 500000)");
    expect(hugeIntegral.ok).toBe(true);
    expect(hugeIntegral.value).toBeCloseTo(1 / 3, 8);

    for (const pattern of ["(a+)+$", "((a+))+$", "(a{1,50})+$", "(a|a)+$", "(a|ab)+$"]) {
      const redosRegex = runRegexTester({
        pattern,
        flags: "g",
        testString: "aaaaaaaaaaaaaaaaaaaaaaaaaaaa!",
      });
      expect(redosRegex.ok).toBe(false);
      expect(redosRegex.error).toMatch(/nested|backtracking/i);
    }

    const zeroClaimCalib = runUncertaintyAbstentionCalibrator("Hello there, how can I help you today?");
    expect(zeroClaimCalib.badge).not.toBe("verified");
    expect(zeroClaimCalib.epistemicScore).toBeLessThanOrEqual(0.75);
  });
});

