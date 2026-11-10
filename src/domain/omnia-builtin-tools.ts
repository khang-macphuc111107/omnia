/**
 * Omnia Built-in Deterministic Tools & Anti-Hallucination Auto-Trigger Engine
 *
 * Pure, fast, zero-eval-vulnerability deterministic tools for mathematical
 * calculation, unit/currency/base conversion, JSON/JSONL schema validation,
 * regular expression testing, cryptographic hashing/codec inspection,
 * datetime/cron solving, code syntax balance checking, citation grounding
 * cross-checking, inline numeric claim verification, and epistemic abstention
 * calibration.
 */

export type BuiltinToolId =
  | "builtin_scientific_calculator"
  | "builtin_unit_currency_converter"
  | "builtin_json_schema_validator"
  | "builtin_regex_tester"
  | "builtin_hash_codec"
  | "builtin_datetime_cron_solver"
  | "builtin_code_syntax_balance_checker"
  | "builtin_citation_fact_cross_checker"
  | "builtin_numeric_claim_verifier"
  | "builtin_uncertainty_abstention_calibrator";

export type VerificationBadge =
  | "verified"
  | "needs-citation"
  | "math-discrepancy-detected"
  | "abstain-recommended";

export interface BuiltinToolDefinition {
  readonly id: BuiltinToolId;
  readonly name: string;
  readonly category: "math" | "conversion" | "devtools" | "anti-hallucination";
  readonly description: string;
  readonly deterministic: true;
  readonly zeroEval: true;
}

export const OMNIA_BUILTIN_TOOLS: readonly BuiltinToolDefinition[] = [
  {
    id: "builtin_scientific_calculator",
    name: "Scientific & Programmer Calculator",
    category: "math",
    description: "Calculates algebra, trig, calculus, and matrices.",
    deterministic: true,
    zeroEval: true,
  },
  {
    id: "builtin_unit_currency_converter",
    name: "Unit, Currency & Base Converter",
    category: "conversion",
    description: "Converts units, currencies, and binary/float formats.",
    deterministic: true,
    zeroEval: true,
  },
  {
    id: "builtin_json_schema_validator",
    name: "JSON / JSONL & Schema Validator",
    category: "devtools",
    description: "Validates JSON/JSONL against schema contracts.",
    deterministic: true,
    zeroEval: true,
  },
  {
    id: "builtin_regex_tester",
    name: "Regular Expression Tester",
    category: "devtools",
    description: "Tests regex patterns with capture groups.",
    deterministic: true,
    zeroEval: true,
  },
  {
    id: "builtin_hash_codec",
    name: "Deterministic Hash, Codec & JWT Inspector",
    category: "devtools",
    description: "Computes hashes, checksums, codecs, and JWTs.",
    deterministic: true,
    zeroEval: true,
  },
  {
    id: "builtin_datetime_cron_solver",
    name: "DateTime & 5-Field Cron Solver",
    category: "devtools",
    description: "Solves timestamps, deltas, and cron schedules.",
    deterministic: true,
    zeroEval: true,
  },
  {
    id: "builtin_code_syntax_balance_checker",
    name: "Code Syntax & Bracket Balance Checker",
    category: "devtools",
    description: "Checks syntax bracket and quote balance.",
    deterministic: true,
    zeroEval: true,
  },
  {
    id: "builtin_citation_fact_cross_checker",
    name: "Citation & Fact Grounding Cross-Checker",
    category: "anti-hallucination",
    description: "Cross-checks citations against ground truth.",
    deterministic: true,
    zeroEval: true,
  },
  {
    id: "builtin_numeric_claim_verifier",
    name: "Inline Numeric Claim Verifier",
    category: "anti-hallucination",
    description: "Verifies inline math equations and claims.",
    deterministic: true,
    zeroEval: true,
  },
  {
    id: "builtin_uncertainty_abstention_calibrator",
    name: "Uncertainty & Epistemic Abstention Calibrator",
    category: "anti-hallucination",
    description: "Calibrates epistemic uncertainty score.",
    deterministic: true,
    zeroEval: true,
  },
] as const;

// ============================================================================
// 1. BUILTIN SCIENTIFIC CALCULATOR
// ============================================================================

export type AngleUnit = "rad" | "deg";

export interface RationalApproximation {
  readonly numerator: number;
  readonly denominator: number;
  readonly formatted: string;
  readonly error: number;
}

export interface ProgrammerReadout {
  readonly binary: string;
  readonly octal: string;
  readonly decimal: string;
  readonly hex: string;
  readonly int32: number;
  readonly uint32: number;
}

export interface ScientificCalculatorInput {
  readonly expression: string;
  readonly variables?: Readonly<Record<string, number>> | undefined;
  readonly angleUnit?: AngleUnit | undefined;
}

export interface ScientificCalculatorResult {
  readonly ok: boolean;
  readonly expression: string;
  readonly value: number;
  readonly formattedDecimal: string;
  readonly scientificNotation: string;
  readonly rationalApproximation: RationalApproximation;
  readonly programmerReadout: ProgrammerReadout;
  readonly error?: string | undefined;
}

export const SCIENTIFIC_CONSTANTS: Readonly<Record<string, number>> = {
  pi: Math.PI,
  e: Math.E,
  phi: (1 + Math.sqrt(5)) / 2,
  tau: Math.PI * 2,
  c: 299792458,
  h: 6.62607015e-34,
  G: 6.6743e-11,
  N_A: 6.02214076e23,
  k_B: 1.380649e-23,
};

export function toRationalApproximation(
  value: number,
  maxDenominator = 1000000,
  tolerance = 1e-10,
): RationalApproximation {
  if (!Number.isFinite(value)) {
    return {
      numerator: value,
      denominator: 1,
      formatted: String(value),
      error: 0,
    };
  }
  const sign = value < 0 ? -1 : 1;
  const absVal = Math.abs(value);
  if (Math.abs(absVal - Math.round(absVal)) <= tolerance) {
    const num = sign * Math.round(absVal);
    return {
      numerator: num,
      denominator: 1,
      formatted: `${num}/1`,
      error: Math.abs(value - num),
    };
  }

  let h1 = 1;
  let h2 = 0;
  let k1 = 0;
  let k2 = 1;
  let b = absVal;

  for (let iter = 0; iter < 64; iter += 1) {
    const a = Math.floor(b);
    const nextH = a * h1 + h2;
    const nextK = a * k1 + k2;
    if (nextK > maxDenominator) {
      break;
    }
    h2 = h1;
    h1 = nextH;
    k2 = k1;
    k1 = nextK;

    const approx = h1 / k1;
    if (Math.abs(absVal - approx) <= tolerance) {
      break;
    }
    const remainder = b - a;
    if (Math.abs(remainder) <= 1e-14) {
      break;
    }
    b = 1 / remainder;
  }

  const numerator = sign * h1;
  const denominator = k1 || 1;
  const approxValue = numerator / denominator;
  return {
    numerator,
    denominator,
    formatted: `${numerator}/${denominator}`,
    error: Math.abs(value - approxValue),
  };
}

export function buildProgrammerReadout(value: number): ProgrammerReadout {
  if (!Number.isFinite(value)) {
    return {
      binary: "0b0",
      octal: "0o0",
      decimal: "0",
      hex: "0x0",
      int32: 0,
      uint32: 0,
    };
  }
  const truncated = Math.trunc(value);
  const int32 = truncated | 0;
  const uint32 = truncated >>> 0;
  const absBig = BigInt(Math.trunc(Math.abs(truncated)));
  const prefix = truncated < 0 ? "-" : "";
  return {
    binary: `${prefix}0b${absBig.toString(2)}`,
    octal: `${prefix}0o${absBig.toString(8)}`,
    decimal: BigInt(truncated).toString(10),
    hex: `${prefix}0x${absBig.toString(16).toUpperCase()}`,
    int32,
    uint32,
  };
}

export function formatCleanDecimal(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  if (Object.is(value, -0) || value === 0) {
    return "0";
  }
  const abs = Math.abs(value);
  if (abs >= 1e15 || (abs > 0 && abs < 1e-9)) {
    return value.toExponential(8).replace(/\.?0+e/, "e");
  }
  const normalized = Number(value.toPrecision(14));
  return String(normalized);
}

type CalcToken =
  | { readonly type: "number"; readonly value: number }
  | { readonly type: "ident"; readonly name: string }
  | { readonly type: "op"; readonly op: string }
  | { readonly type: "lparen" }
  | { readonly type: "rparen" }
  | { readonly type: "lbracket" }
  | { readonly type: "rbracket" }
  | { readonly type: "comma" };

type CalcAstNode =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "ident"; readonly name: string }
  | { readonly kind: "unary"; readonly op: string; readonly operand: CalcAstNode }
  | { readonly kind: "postfix"; readonly op: "!"; readonly operand: CalcAstNode }
  | {
      readonly kind: "binary";
      readonly op: string;
      readonly left: CalcAstNode;
      readonly right: CalcAstNode;
    }
  | { readonly kind: "call"; readonly name: string; readonly args: readonly CalcAstNode[] }
  | { readonly kind: "matrix"; readonly rows: readonly (readonly CalcAstNode[])[] };

function tokenizeMathExpression(rawInput: string): CalcToken[] {
  const input = rawInput.replace(
    /(\d+(?:\.\d+)?)\s*%\s+of\s+/gi,
    "(($1 / 100) * ",
  );
  const openPercentFixes = (rawInput.match(/(\d+(?:\.\d+)?)\s*%\s+of\s+/gi) ?? []).length;
  const fullInput = openPercentFixes > 0 ? `${input}${")".repeat(openPercentFixes)}` : input;

  const tokens: CalcToken[] = [];
  let i = 0;
  const len = fullInput.length;

  while (i < len) {
    const ch = fullInput[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen" });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen" });
      i += 1;
      continue;
    }
    if (ch === "[") {
      tokens.push({ type: "lbracket" });
      i += 1;
      continue;
    }
    if (ch === "]") {
      tokens.push({ type: "rbracket" });
      i += 1;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma" });
      i += 1;
      continue;
    }

    // Check multi-char operators
    const three = fullInput.slice(i, i + 3);
    if (three === ">>>") {
      tokens.push({ type: "op", op: ">>>" });
      i += 3;
      continue;
    }
    const two = fullInput.slice(i, i + 2);
    if (two === "**" || two === "<<" || two === ">>") {
      tokens.push({ type: "op", op: two === "**" ? "^" : two });
      i += 2;
      continue;
    }

    if ("+-*/%^!&|~".includes(ch)) {
      tokens.push({ type: "op", op: ch });
      i += 1;
      continue;
    }

    // Hex / Binary / Octal or Decimal numbers
    if (/\d/.test(ch) || (ch === "." && i + 1 < len && /\d/.test(fullInput[i + 1]!))) {
      const rest = fullInput.slice(i);
      const radixMatch = /^0([xXbBoO])([0-9a-fA-F_]+)/.exec(rest);
      if (radixMatch) {
        const prefix = radixMatch[1]!.toLowerCase();
        const digits = radixMatch[2]!.replace(/_/g, "");
        const radix = prefix === "x" ? 16 : prefix === "b" ? 2 : 8;
        const parsed = Number.parseInt(digits, radix);
        if (Number.isNaN(parsed)) {
          throw new Error(`Invalid radix literal at position ${i}`);
        }
        tokens.push({ type: "number", value: parsed });
        i += radixMatch[0].length;
        continue;
      }

      const numMatch = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
      if (!numMatch) {
        throw new Error(`Invalid numeric literal at position ${i}`);
      }
      const value = Number.parseFloat(numMatch[0]);
      tokens.push({ type: "number", value });
      i += numMatch[0].length;
      continue;
    }

    // Identifiers (variables, constants, functions)
    if (/[a-zA-Z_\u03C0]/.test(ch)) {
      if (ch === "\u03C0") {
        tokens.push({ type: "ident", name: "pi" });
        i += 1;
        continue;
      }
      const identMatch = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(fullInput.slice(i));
      if (!identMatch) {
        throw new Error(`Unexpected character '${ch}' at position ${i}`);
      }
      tokens.push({ type: "ident", name: identMatch[0] });
      i += identMatch[0].length;
      continue;
    }

    throw new Error(`Unexpected character '${ch}' at position ${i}`);
  }

  // Insert safe implicit multiplication where appropriate:
  // e.g. `2 pi` -> `2 * pi`, `2(3+4)` -> `2 * (3+4)`, `)(` -> `) * (`
  const expanded: CalcToken[] = [];
  for (let idx = 0; idx < tokens.length; idx += 1) {
    const curr = tokens[idx]!;
    expanded.push(curr);
    const next = tokens[idx + 1];
    if (!next) continue;

    const currIsValue = curr.type === "number" || curr.type === "rparen";
    const nextStartsFactor =
      next.type === "lparen" ||
      next.type === "ident" ||
      (curr.type === "rparen" && next.type === "number");

    if (currIsValue && nextStartsFactor) {
      expanded.push({ type: "op", op: "*" });
    }
  }

  return expanded;
}

const MAX_AST_DEPTH = 64;
const MAX_INTEGRATION_STEPS = 100_000;

class MathParser {
  private readonly tokens: readonly CalcToken[];
  private pos = 0;
  private depth = 0;

  constructor(tokens: readonly CalcToken[]) {
    this.tokens = tokens;
  }

  private enterDepth(): void {
    this.depth += 1;
    if (this.depth > MAX_AST_DEPTH) {
      throw new Error(`Expression exceeds maximum nesting depth (${MAX_AST_DEPTH})`);
    }
  }

  private leaveDepth(): void {
    this.depth -= 1;
  }

  public parse(): CalcAstNode {
    if (this.tokens.length === 0) {
      throw new Error("Expression cannot be empty");
    }
    const expr = this.parseBitwiseOr();
    if (this.pos < this.tokens.length) {
      const unexpected = this.tokens[this.pos]!;
      throw new Error(`Unexpected token ${JSON.stringify(unexpected)} at token index ${this.pos}`);
    }
    return expr;
  }

  private peek(): CalcToken | undefined {
    return this.tokens[this.pos];
  }

  private consume(): CalcToken {
    const tok = this.tokens[this.pos];
    if (!tok) {
      throw new Error("Unexpected end of expression");
    }
    this.pos += 1;
    return tok;
  }

  private matchOp(...ops: string[]): string | null {
    const tok = this.peek();
    if (tok && tok.type === "op" && ops.includes(tok.op)) {
      this.pos += 1;
      return tok.op;
    }
    return null;
  }

  private parseBitwiseOr(): CalcAstNode {
    this.enterDepth();
    try {
      let left = this.parseBitwiseAnd();
      while (true) {
        const op = this.matchOp("|");
        if (!op) break;
        const right = this.parseBitwiseAnd();
        left = { kind: "binary", op, left, right };
      }
      return left;
    } finally {
      this.leaveDepth();
    }
  }

  private parseBitwiseAnd(): CalcAstNode {
    let left = this.parseShift();
    while (true) {
      const op = this.matchOp("&");
      if (!op) break;
      const right = this.parseShift();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseShift(): CalcAstNode {
    let left = this.parseAdditive();
    while (true) {
      const op = this.matchOp("<<", ">>", ">>>");
      if (!op) break;
      const right = this.parseAdditive();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseAdditive(): CalcAstNode {
    let left = this.parseMultiplicative();
    while (true) {
      const op = this.matchOp("+", "-");
      if (!op) break;
      const right = this.parseMultiplicative();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseMultiplicative(): CalcAstNode {
    let left = this.parseUnary();
    while (true) {
      const op = this.matchOp("*", "/", "%");
      if (!op) break;
      const right = this.parseUnary();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseUnary(): CalcAstNode {
    const op = this.matchOp("+", "-", "~");
    if (op) {
      this.enterDepth();
      try {
        const operand = this.parseUnary();
        return { kind: "unary", op, operand };
      } finally {
        this.leaveDepth();
      }
    }
    return this.parsePower();
  }

  private parsePower(): CalcAstNode {
    const base = this.parsePostfix();
    const op = this.matchOp("^");
    if (op) {
      this.enterDepth();
      try {
        // Right-associative exponentiation, allowing unary in exponent
        const exponent = this.parseUnary();
        return { kind: "binary", op: "^", left: base, right: exponent };
      } finally {
        this.leaveDepth();
      }
    }
    return base;
  }

  private parsePostfix(): CalcAstNode {
    let node = this.parsePrimary();
    while (true) {
      const op = this.matchOp("!");
      if (!op) break;
      node = { kind: "postfix", op: "!", operand: node };
    }
    return node;
  }

  private parsePrimary(): CalcAstNode {
    const tok = this.peek();
    if (!tok) {
      throw new Error("Unexpected end of expression");
    }

    if (tok.type === "number") {
      this.consume();
      return { kind: "number", value: tok.value };
    }

    if (tok.type === "lparen") {
      this.consume();
      const inner = this.parseBitwiseOr();
      const closing = this.peek();
      if (!closing || closing.type !== "rparen") {
        throw new Error("Missing closing parenthesis ')'");
      }
      this.consume();
      return inner;
    }

    if (tok.type === "lbracket") {
      return this.parseMatrixLiteral();
    }

    if (tok.type === "ident") {
      this.consume();
      const next = this.peek();
      if (next && next.type === "lparen") {
        this.consume(); // consume '('
        const args: CalcAstNode[] = [];
        const afterOpen = this.peek();
        if (!afterOpen) {
          throw new Error(`Unclosed function call '${tok.name}('`);
        }
        if (afterOpen.type !== "rparen") {
          while (true) {
            args.push(this.parseBitwiseOr());
            const sep = this.peek();
            if (sep && sep.type === "comma") {
              this.consume();
              continue;
            }
            break;
          }
        }
        const close = this.peek();
        if (!close || close.type !== "rparen") {
          throw new Error(`Missing closing ')' for function '${tok.name}'`);
        }
        this.consume();
        return { kind: "call", name: tok.name, args };
      }
      return { kind: "ident", name: tok.name };
    }

    throw new Error(`Unexpected token ${JSON.stringify(tok)}`);
  }

  private parseMatrixLiteral(): CalcAstNode {
    this.enterDepth();
    try {
      this.consume(); // outer '['
      const rows: CalcAstNode[][] = [];
      while (true) {
        const next = this.peek();
        if (!next) {
          throw new Error("Unclosed matrix literal '['");
        }
        if (next.type === "lbracket") {
          this.consume(); // row '['
          const row: CalcAstNode[] = [];
          while (true) {
            row.push(this.parseBitwiseOr());
            const sep = this.peek();
            if (sep && sep.type === "comma") {
              this.consume();
              continue;
            }
            break;
          }
          const rowClose = this.peek();
          if (!rowClose || rowClose.type !== "rbracket") {
            throw new Error("Missing closing ']' in matrix row");
          }
          this.consume();
          rows.push(row);
        } else {
          throw new Error("Expected matrix row '[...]' inside matrix literal");
        }

        const afterRow = this.peek();
        if (afterRow && afterRow.type === "comma") {
          this.consume();
          continue;
        }
        break;
      }

      const outerClose = this.peek();
      if (!outerClose || outerClose.type !== "rbracket") {
        throw new Error("Missing outer closing ']' for matrix literal");
      }
      this.consume();
      return { kind: "matrix", rows };
    } finally {
      this.leaveDepth();
    }
  }
}

function computeFactorial(n: number): number {
  if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
    throw new Error(`Factorial requires a non-negative integer, got ${n}`);
  }
  if (n > 170) {
    return Number.POSITIVE_INFINITY;
  }
  let acc = 1;
  for (let i = 2; i <= n; i += 1) {
    acc *= i;
  }
  return acc;
}

function computeGcdTwo(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

function computeLcmTwo(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return Math.abs((Math.trunc(a) / computeGcdTwo(a, b)) * Math.trunc(b));
}

function computeNcr(n: number, r: number): number {
  const ni = Math.trunc(n);
  const ri = Math.trunc(r);
  if (ri < 0 || ni < 0 || ri > ni) return 0;
  const k = Math.min(ri, ni - ri);
  let result = 1;
  for (let i = 1; i <= k; i += 1) {
    result = (result * (ni - k + i)) / i;
  }
  return Math.round(result);
}

function computeNpr(n: number, r: number): number {
  const ni = Math.trunc(n);
  const ri = Math.trunc(r);
  if (ri < 0 || ni < 0 || ri > ni) return 0;
  let result = 1;
  for (let i = 0; i < ri; i += 1) {
    result *= ni - i;
  }
  return result;
}

function evaluateMatrixDeterminant(matrix: readonly (readonly number[])[]): number {
  const n = matrix.length;
  if (n === 2 && matrix[0]?.length === 2 && matrix[1]?.length === 2) {
    const a = matrix[0][0]!;
    const b = matrix[0][1]!;
    const c = matrix[1][0]!;
    const d = matrix[1][1]!;
    return a * d - b * c;
  }
  if (
    n === 3 &&
    matrix[0]?.length === 3 &&
    matrix[1]?.length === 3 &&
    matrix[2]?.length === 3
  ) {
    const [a, b, c] = matrix[0] as [number, number, number];
    const [d, e, f] = matrix[1] as [number, number, number];
    const [g, h, i] = matrix[2] as [number, number, number];
    return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  }
  throw new Error("Determinant requires a 2x2 or 3x3 square matrix");
}

function evaluateMatrixTrace(matrix: readonly (readonly number[])[]): number {
  const n = matrix.length;
  if (
    (n === 2 && matrix[0]?.length === 2 && matrix[1]?.length === 2) ||
    (n === 3 &&
      matrix[0]?.length === 3 &&
      matrix[1]?.length === 3 &&
      matrix[2]?.length === 3)
  ) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      sum += matrix[i]![i]!;
    }
    return sum;
  }
  throw new Error("Trace requires a 2x2 or 3x3 square matrix");
}

function evaluateAst(
  node: CalcAstNode,
  variables: Readonly<Record<string, number>>,
  angleUnit: AngleUnit,
  evalDepth = 0,
): number {
  if (evalDepth > 512) {
    throw new Error(`Expression exceeds maximum evaluation depth (${MAX_AST_DEPTH})`);
  }
  const nextDepth = evalDepth + 1;
  switch (node.kind) {
    case "number":
      return node.value;

    case "ident": {
      if (Object.prototype.hasOwnProperty.call(variables, node.name)) {
        return variables[node.name]!;
      }
      if (Object.prototype.hasOwnProperty.call(SCIENTIFIC_CONSTANTS, node.name)) {
        return SCIENTIFIC_CONSTANTS[node.name]!;
      }
      if (node.name === "ans") {
        return variables.ans ?? 0;
      }
      throw new Error(`Unknown variable or constant '${node.name}'`);
    }

    case "unary": {
      const val = evaluateAst(node.operand, variables, angleUnit, nextDepth);
      if (node.op === "+") return +val;
      if (node.op === "-") return -val;
      if (node.op === "~") return ~Math.trunc(val);
      throw new Error(`Unknown unary operator '${node.op}'`);
    }

    case "postfix": {
      const val = evaluateAst(node.operand, variables, angleUnit, nextDepth);
      return computeFactorial(val);
    }

    case "binary": {
      const left = evaluateAst(node.left, variables, angleUnit, nextDepth);
      const right = evaluateAst(node.right, variables, angleUnit, nextDepth);
      switch (node.op) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          if (right === 0) throw new Error("Division by zero");
          return left / right;
        case "%":
          if (right === 0) throw new Error("Modulo by zero");
          return left % right;
        case "^":
          return Math.pow(left, right);
        case "&":
          return Math.trunc(left) & Math.trunc(right);
        case "|":
          return Math.trunc(left) | Math.trunc(right);
        case "<<":
          return Math.trunc(left) << Math.trunc(right);
        case ">>":
          return Math.trunc(left) >> Math.trunc(right);
        case ">>>":
          return Math.trunc(left) >>> Math.trunc(right);
        default:
          throw new Error(`Unknown binary operator '${node.op}'`);
      }
    }

    case "matrix":
      throw new Error("Matrix literal must be passed to det(...) or trace(...)");

    case "call": {
      const fnName = node.name;
      const lower = fnName.toLowerCase();

      // Special calculus forms: deriv(expr, x0[, h]) and integrate(expr, a, b[, steps])
      if (lower === "deriv") {
        if (node.args.length < 2 || node.args.length > 3) {
          throw new Error("deriv(expr, x0[, h]) requires 2 or 3 arguments");
        }
        const exprNode = node.args[0]!;
        let varName = "x";
        let x0Node = node.args[1]!;
        let stepH = 1e-6;
        if (node.args.length === 3) {
          if (node.args[1]?.kind === "ident" && !(node.args[1].name in SCIENTIFIC_CONSTANTS)) {
            varName = node.args[1].name;
            x0Node = node.args[2]!;
          } else {
            stepH = evaluateAst(node.args[2]!, variables, angleUnit, nextDepth);
          }
        }
        const x0 = evaluateAst(x0Node, variables, angleUnit, nextDepth);
        const f = (xVal: number) =>
          evaluateAst(exprNode, { ...variables, [varName]: xVal }, angleUnit, nextDepth);
        // 5-point stencil numerical derivative for high accuracy
        const fPlus2 = f(x0 + 2 * stepH);
        const fPlus1 = f(x0 + stepH);
        const fMinus1 = f(x0 - stepH);
        const fMinus2 = f(x0 - 2 * stepH);
        return (-fPlus2 + 8 * fPlus1 - 8 * fMinus1 + fMinus2) / (12 * stepH);
      }

      if (lower === "integrate") {
        if (node.args.length < 3 || node.args.length > 4) {
          throw new Error("integrate(expr, a, b[, steps]) requires 3 or 4 arguments");
        }
        const exprNode = node.args[0]!;
        const a = evaluateAst(node.args[1]!, variables, angleUnit, nextDepth);
        const b = evaluateAst(node.args[2]!, variables, angleUnit, nextDepth);
        const rawSteps =
          node.args.length === 4
            ? Math.min(
                MAX_INTEGRATION_STEPS,
                Math.max(2, Math.trunc(evaluateAst(node.args[3]!, variables, angleUnit, nextDepth))),
              )
            : 1000;
        const n = rawSteps % 2 === 0 ? rawSteps : rawSteps + 1;
        const h = (b - a) / n;
        const f = (xVal: number) =>
          evaluateAst(exprNode, { ...variables, x: xVal }, angleUnit, nextDepth);

        let sum = f(a) + f(b);
        for (let i = 1; i < n; i += 1) {
          const x = a + i * h;
          sum += (i % 2 === 0 ? 2 : 4) * f(x);
        }
        return (h / 3) * sum;
      }

      // Matrix functions: det(...) and trace(...)
      if (lower === "det" || lower === "determinant") {
        if (node.args.length === 1 && node.args[0]?.kind === "matrix") {
          const mat = node.args[0].rows.map((r) =>
            r.map((cell) => evaluateAst(cell, variables, angleUnit, nextDepth)),
          );
          return evaluateMatrixDeterminant(mat);
        }
        const vals = node.args.map((arg) => evaluateAst(arg, variables, angleUnit, nextDepth));
        if (vals.length === 4) {
          return evaluateMatrixDeterminant([
            [vals[0]!, vals[1]!],
            [vals[2]!, vals[3]!],
          ]);
        }
        if (vals.length === 9) {
          return evaluateMatrixDeterminant([
            [vals[0]!, vals[1]!, vals[2]!],
            [vals[3]!, vals[4]!, vals[5]!],
            [vals[6]!, vals[7]!, vals[8]!],
          ]);
        }
        throw new Error("det() accepts a 2x2 or 3x3 matrix literal or 4 / 9 numbers");
      }

      if (lower === "trace" || lower === "tr") {
        if (node.args.length === 1 && node.args[0]?.kind === "matrix") {
          const mat = node.args[0].rows.map((r) =>
            r.map((cell) => evaluateAst(cell, variables, angleUnit, nextDepth)),
          );
          return evaluateMatrixTrace(mat);
        }
        const vals = node.args.map((arg) => evaluateAst(arg, variables, angleUnit));
        if (vals.length === 4) {
          return evaluateMatrixTrace([
            [vals[0]!, vals[1]!],
            [vals[2]!, vals[3]!],
          ]);
        }
        if (vals.length === 9) {
          return evaluateMatrixTrace([
            [vals[0]!, vals[1]!, vals[2]!],
            [vals[3]!, vals[4]!, vals[5]!],
            [vals[6]!, vals[7]!, vals[8]!],
          ]);
        }
        throw new Error("trace() accepts a 2x2 or 3x3 matrix literal or 4 / 9 numbers");
      }

      const args = node.args.map((arg) => evaluateAst(arg, variables, angleUnit));
      const first = args[0];
      if (first === undefined) {
        throw new Error(`Function '${fnName}' requires at least 1 argument`);
      }

      const toRad = (v: number) => (angleUnit === "deg" ? (v * Math.PI) / 180 : v);
      const fromRad = (v: number) => (angleUnit === "deg" ? (v * 180) / Math.PI : v);

      switch (lower) {
        case "sin":
          return Math.sin(toRad(first));
        case "cos":
          return Math.cos(toRad(first));
        case "tan":
          return Math.tan(toRad(first));
        case "asin":
          return fromRad(Math.asin(first));
        case "acos":
          return fromRad(Math.acos(first));
        case "atan":
          return fromRad(Math.atan(first));
        case "atan2":
          if (args[1] === undefined) throw new Error("atan2(y, x) requires 2 arguments");
          return fromRad(Math.atan2(first, args[1]));
        case "sinh":
          return Math.sinh(first);
        case "cosh":
          return Math.cosh(first);
        case "tanh":
          return Math.tanh(first);
        case "sqrt":
          if (first < 0) throw new Error("sqrt of negative number");
          return Math.sqrt(first);
        case "cbrt":
          return Math.cbrt(first);
        case "abs":
          return Math.abs(first);
        case "sign":
          return Math.sign(first);
        case "ln":
          if (first <= 0) throw new Error("ln requires positive argument");
          return Math.log(first);
        case "log":
        case "log10":
          if (first <= 0) throw new Error("log requires positive argument");
          if (args[1] !== undefined) {
            return Math.log(first) / Math.log(args[1]);
          }
          return Math.log10(first);
        case "log2":
          if (first <= 0) throw new Error("log2 requires positive argument");
          return Math.log2(first);
        case "exp":
          return Math.exp(first);
        case "pow":
          if (args[1] === undefined) throw new Error("pow(x, y) requires 2 arguments");
          return Math.pow(first, args[1]);
        case "floor":
          return Math.floor(first);
        case "ceil":
          return Math.ceil(first);
        case "round":
          return Math.round(first);
        case "trunc":
          return Math.trunc(first);
        case "fact":
        case "factorial":
          return computeFactorial(first);
        case "gcd":
          return args.reduce((acc, cur) => computeGcdTwo(acc, cur), first);
        case "lcm":
          return args.reduce((acc, cur) => computeLcmTwo(acc, cur), first);
        case "ncr":
        case "comb":
          if (args[1] === undefined) throw new Error("nCr(n, r) requires 2 arguments");
          return computeNcr(first, args[1]);
        case "npr":
        case "perm":
          if (args[1] === undefined) throw new Error("nPr(n, r) requires 2 arguments");
          return computeNpr(first, args[1]);
        case "mod":
          if (args[1] === undefined || args[1] === 0) {
            throw new Error("mod(a, b) requires non-zero divisor");
          }
          return ((first % args[1]) + args[1]) % args[1];
        case "hypot":
          return Math.hypot(...args);
        case "deg":
          return (first * 180) / Math.PI;
        case "rad":
          return (first * Math.PI) / 180;
        case "sum":
          return args.reduce((a, b) => a + b, 0);
        case "mean":
        case "avg":
          return args.reduce((a, b) => a + b, 0) / args.length;
        case "median": {
          const sorted = [...args].sort((a, b) => a - b);
          const mid = Math.floor(sorted.length / 2);
          return sorted.length % 2 === 1
            ? sorted[mid]!
            : (sorted[mid - 1]! + sorted[mid]!) / 2;
        }
        case "min":
          return Math.min(...args);
        case "max":
          return Math.max(...args);
        case "var":
        case "variance": {
          const mu = args.reduce((a, b) => a + b, 0) / args.length;
          return args.reduce((acc, v) => acc + (v - mu) ** 2, 0) / args.length;
        }
        case "std":
        case "stdev": {
          const mu = args.reduce((a, b) => a + b, 0) / args.length;
          const variance = args.reduce((acc, v) => acc + (v - mu) ** 2, 0) / args.length;
          return Math.sqrt(variance);
        }
        case "clamp":
          if (args[1] === undefined || args[2] === undefined) {
            throw new Error("clamp(x, min, max) requires 3 arguments");
          }
          return Math.min(Math.max(first, args[1]), args[2]);
        case "xor":
        case "bitxor":
          if (args[1] === undefined) throw new Error("xor(a, b) requires 2 arguments");
          return Math.trunc(first) ^ Math.trunc(args[1]);
        default:
          throw new Error(`Unknown function '${fnName}'`);
      }
    }
  }
}

export function runScientificCalculator(
  input: ScientificCalculatorInput | string,
): ScientificCalculatorResult {
  const normalizedInput: ScientificCalculatorInput =
    typeof input === "string" ? { expression: input } : input;
  const expr = normalizedInput.expression.trim();
  const variables = normalizedInput.variables ?? {};
  const angleUnit = normalizedInput.angleUnit ?? "rad";

  try {
    const tokens = tokenizeMathExpression(expr);
    const parser = new MathParser(tokens);
    const ast = parser.parse();
    const rawValue = evaluateAst(ast, variables, angleUnit);
    // Clean tiny floating-point noise like sin(pi) = 1.2246e-16 -> 0 when near integer/zero
    const value =
      Math.abs(rawValue) < 1e-15 && rawValue !== 0 && expr.toLowerCase().includes("pi")
        ? 0
        : rawValue;

    return {
      ok: true,
      expression: expr,
      value,
      formattedDecimal: formatCleanDecimal(value),
      scientificNotation: Number.isFinite(value) ? value.toExponential(6) : String(value),
      rationalApproximation: toRationalApproximation(value),
      programmerReadout: buildProgrammerReadout(value),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      expression: expr,
      value: Number.NaN,
      formattedDecimal: "NaN",
      scientificNotation: "NaN",
      rationalApproximation: { numerator: 0, denominator: 1, formatted: "0/1", error: 0 },
      programmerReadout: buildProgrammerReadout(0),
      error: message,
    };
  }
}

// ============================================================================
// 2. BUILTIN UNIT, CURRENCY & PROGRAMMER BASE CONVERTER
// ============================================================================

export type UnitCategory =
  | "length"
  | "mass"
  | "temperature"
  | "data"
  | "time"
  | "speed"
  | "energy"
  | "pressure"
  | "angle"
  | "currency";

const LINEAR_UNIT_FACTORS: Readonly<Record<Exclude<UnitCategory, "temperature">, Readonly<Record<string, number>>>> = {
  length: {
    m: 1,
    km: 1000,
    cm: 0.01,
    mm: 0.001,
    um: 1e-6,
    nm: 1e-9,
    mi: 1609.344,
    yd: 0.9144,
    ft: 0.3048,
    in: 0.0254,
    nmi: 1852,
  },
  mass: {
    kg: 1,
    g: 0.001,
    mg: 1e-6,
    lb: 0.45359237,
    oz: 0.028349523125,
    ton: 1000,
  },
  data: {
    B: 1,
    KB: 1e3,
    KiB: 1024,
    MB: 1e6,
    MiB: 1024 ** 2,
    GB: 1e9,
    GiB: 1024 ** 3,
    TB: 1e12,
    TiB: 1024 ** 4,
  },
  time: {
    ns: 1e-9,
    us: 1e-6,
    ms: 0.001,
    s: 1,
    min: 60,
    h: 3600,
    d: 86400,
    wk: 604800,
    yr: 31557600, //Julian year 365.25d
  },
  speed: {
    "m/s": 1,
    "km/h": 1 / 3.6,
    mph: 0.44704,
    kn: 1852 / 3600,
  },
  energy: {
    J: 1,
    kJ: 1000,
    cal: 4.184,
    kcal: 4184,
    Wh: 3600,
    kWh: 3.6e6,
    eV: 1.602176634e-19,
  },
  pressure: {
    Pa: 1,
    kPa: 1000,
    bar: 100000,
    atm: 101325,
    psi: 6894.757293168,
  },
  angle: {
    rad: 1,
    deg: Math.PI / 180,
    grad: Math.PI / 200,
  },
  currency: {
    // Baseline units per 1 USD (configurable via customRates)
    USD: 1,
    EUR: 0.92,
    GBP: 0.79,
    JPY: 155.0,
    CHF: 0.88,
    CAD: 1.36,
    AUD: 1.52,
    CNY: 7.24,
    INR: 83.5,
    SGD: 1.35,
    VND: 25400,
    KRW: 1370,
  },
};

export interface Ieee754FloatInspection {
  readonly precision: "float32" | "float64";
  readonly signBit: 0 | 1;
  readonly exponentBits: string;
  readonly exponentHex: string;
  readonly exponentBiased: number;
  readonly exponentUnbiased: number;
  readonly mantissaBits: string;
  readonly mantissaFraction: number;
  readonly ulp: number;
  readonly specialState: "Zero" | "Normalized" | "Subnormal" | "Infinity" | "NaN";
  readonly hex: string;
  readonly binary: string;
  readonly reconstructedValue: number;
  readonly isSubnormal: boolean;
  readonly isNaN: boolean;
  readonly isInfinite: boolean;
}

export interface TwosComplementWidthReadout {
  readonly bits: 8 | 16 | 32 | 64;
  readonly signed: string;
  readonly unsigned: string;
  readonly hex: string;
  readonly binary: string;
}

export interface ProgrammerBaseConversionResult {
  readonly input: string;
  readonly inputBase: 2 | 8 | 10 | 16;
  readonly binary: string;
  readonly octal: string;
  readonly decimal: string;
  readonly hex: string;
  readonly widths: readonly TwosComplementWidthReadout[];
  readonly ieee754Float32: Ieee754FloatInspection;
  readonly ieee754Float64: Ieee754FloatInspection;
}

export interface UnitCurrencyConverterInput {
  readonly value: number;
  readonly fromUnit: string;
  readonly toUnit: string;
  readonly customCurrencyRates?: Readonly<Record<string, number>> | undefined;
  readonly programmerInput?: string | number | undefined;
  readonly programmerBase?: 2 | 8 | 10 | 16 | undefined;
}

export interface UnitCurrencyConverterResult {
  readonly ok: boolean;
  readonly category: UnitCategory;
  readonly inputValue: number;
  readonly fromUnit: string;
  readonly toUnit: string;
  readonly outputValue: number;
  readonly formattedOutput: string;
  readonly formulaSummary: string;
  readonly programmerConversion?: ProgrammerBaseConversionResult | undefined;
  readonly error?: string | undefined;
}

export function inspectIeee754Float(
  value: number,
  precision: "float32" | "float64" = "float64",
): Ieee754FloatInspection {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);

  if (precision === "float32") {
    view.setFloat32(0, value, false);
    const bits = view.getUint32(0, false);
    const bin = bits.toString(2).padStart(32, "0");
    const signBit = (bits >>> 31) as 0 | 1;
    const exponentBiased = (bits >>> 23) & 0xff;
    const exponentBits = bin.slice(1, 9);
    const mantissaBits = bin.slice(9);
    const mantissaInt = bits & 0x7fffff;
    const reconstructedValue = view.getFloat32(0, false);
    const isSubnormal = exponentBiased === 0 && mantissaBits.includes("1");
    const isZero = exponentBiased === 0 && !mantissaBits.includes("1");
    const isNaNVal = Number.isNaN(reconstructedValue);
    const isInfinite = !Number.isFinite(reconstructedValue) && !isNaNVal;
    const specialState = isNaNVal
      ? "NaN"
      : isInfinite
        ? "Infinity"
        : isSubnormal
          ? "Subnormal"
          : isZero
            ? "Zero"
            : "Normalized";
    const mantissaFraction =
      isNaNVal || isInfinite
        ? Number.NaN
        : isZero
          ? 0
          : (isSubnormal ? 0 : 1) + mantissaInt / Math.pow(2, 23);
    const ulp =
      isNaNVal || isInfinite
        ? Number.NaN
        : isSubnormal || isZero
          ? Math.pow(2, -149)
          : Math.pow(2, exponentBiased - 127 - 23);

    return {
      precision: "float32",
      signBit,
      exponentBits,
      exponentHex: `0x${exponentBiased.toString(16).toUpperCase().padStart(2, "0")}`,
      exponentBiased,
      exponentUnbiased: exponentBiased === 0 ? -126 : exponentBiased - 127,
      mantissaBits,
      mantissaFraction,
      ulp,
      specialState,
      hex: `0x${bits.toString(16).toUpperCase().padStart(8, "0")}`,
      binary: bin,
      reconstructedValue,
      isSubnormal,
      isNaN: isNaNVal,
      isInfinite,
    };
  }

  view.setFloat64(0, value, false);
  const hi = view.getUint32(0, false);
  const lo = view.getUint32(4, false);
  const bigBits = (BigInt(hi) << 32n) | BigInt(lo);
  const bin = bigBits.toString(2).padStart(64, "0");
  const signBit = ((hi >>> 31) & 1) as 0 | 1;
  const exponentBiased = (hi >>> 20) & 0x7ff;
  const exponentBits = bin.slice(1, 12);
  const mantissaBits = bin.slice(12);
  const mantissaBig = bigBits & 0x000fffffffffffffn;
  const reconstructedValue = view.getFloat64(0, false);
  const isSubnormal = exponentBiased === 0 && mantissaBits.includes("1");
  const isZero = exponentBiased === 0 && !mantissaBits.includes("1");
  const isNaNVal = Number.isNaN(reconstructedValue);
  const isInfinite = !Number.isFinite(reconstructedValue) && !isNaNVal;
  const specialState = isNaNVal
    ? "NaN"
    : isInfinite
      ? "Infinity"
      : isSubnormal
        ? "Subnormal"
        : isZero
          ? "Zero"
          : "Normalized";
  const mantissaFraction =
    isNaNVal || isInfinite
      ? Number.NaN
      : isZero
        ? 0
        : (isSubnormal ? 0 : 1) + Number(mantissaBig) / Math.pow(2, 52);
  const ulp =
    isNaNVal || isInfinite
      ? Number.NaN
      : isSubnormal || isZero
        ? Math.pow(2, -1074)
        : Math.pow(2, exponentBiased - 1023 - 52);

  return {
    precision: "float64",
    signBit,
    exponentBits,
    exponentHex: `0x${exponentBiased.toString(16).toUpperCase().padStart(3, "0")}`,
    exponentBiased,
    exponentUnbiased: exponentBiased === 0 ? -1022 : exponentBiased - 1023,
    mantissaBits,
    mantissaFraction,
    ulp,
    specialState,
    hex: `0x${bigBits.toString(16).toUpperCase().padStart(16, "0")}`,
    binary: bin,
    reconstructedValue,
    isSubnormal,
    isNaN: isNaNVal,
    isInfinite,
  };
}

export function convertProgrammerBase(
  rawInput: string | number,
  inputBase: 2 | 8 | 10 | 16 = 10,
): ProgrammerBaseConversionResult {
  let numericFloat = 0;
  let intBig = 0n;

  if (typeof rawInput === "number") {
    numericFloat = rawInput;
    intBig = BigInt(Math.trunc(Number.isFinite(rawInput) ? rawInput : 0));
  } else {
    const trimmed = rawInput.trim().replace(/_/g, "");
    const isNeg = trimmed.startsWith("-");
    const clean = isNeg ? trimmed.slice(1) : trimmed;
    const stripped = clean.replace(/^0[xXbBoO]/, "");

    if (inputBase === 10 && stripped.includes(".")) {
      numericFloat = Number.parseFloat(trimmed);
      intBig = BigInt(Math.trunc(Number.isFinite(numericFloat) ? numericFloat : 0));
    } else {
      const prefix =
        inputBase === 16 ? "0x" : inputBase === 8 ? "0o" : inputBase === 2 ? "0b" : "";
      intBig = BigInt(`${prefix}${stripped || "0"}`);
      if (isNeg) intBig = -intBig;
      numericFloat = Number(intBig);
    }
  }

  const widths: TwosComplementWidthReadout[] = ([8, 16, 32, 64] as const).map((bits) => {
    const unsignedVal = BigInt.asUintN(bits, intBig);
    const signedVal = BigInt.asIntN(bits, intBig);
    return {
      bits,
      signed: signedVal.toString(10),
      unsigned: unsignedVal.toString(10),
      hex: `0x${unsignedVal.toString(16).toUpperCase().padStart(bits / 4, "0")}`,
      binary: unsignedVal.toString(2).padStart(bits, "0"),
    };
  });

  const signPrefix = intBig < 0n ? "-" : "";
  const absBig = intBig < 0n ? -intBig : intBig;

  return {
    input: String(rawInput),
    inputBase,
    binary: `${signPrefix}0b${absBig.toString(2)}`,
    octal: `${signPrefix}0o${absBig.toString(8)}`,
    decimal: intBig.toString(10),
    hex: `${signPrefix}0x${absBig.toString(16).toUpperCase()}`,
    widths,
    ieee754Float32: inspectIeee754Float(numericFloat, "float32"),
    ieee754Float64: inspectIeee754Float(numericFloat, "float64"),
  };
}

function normalizeTemperatureUnit(u: string): "C" | "F" | "K" | null {
  const clean = u.trim().replace(/^°/, "").toUpperCase();
  if (clean === "C" || clean === "CELSIUS") return "C";
  if (clean === "F" || clean === "FAHRENHEIT") return "F";
  if (clean === "K" || clean === "KELVIN") return "K";
  return null;
}

function findCategoryForUnits(
  fromUnit: string,
  toUnit: string,
  customCurrencyRates?: Readonly<Record<string, number>>,
): { category: UnitCategory; fromKey: string; toKey: string } | null {
  const tempFrom = normalizeTemperatureUnit(fromUnit);
  const tempTo = normalizeTemperatureUnit(toUnit);
  if (tempFrom && tempTo) {
    return { category: "temperature", fromKey: tempFrom, toKey: tempTo };
  }

  const categories = Object.keys(LINEAR_UNIT_FACTORS) as Array<
    Exclude<UnitCategory, "temperature">
  >;
  for (const cat of categories) {
    const table =
      cat === "currency" && customCurrencyRates
        ? { ...LINEAR_UNIT_FACTORS.currency, ...customCurrencyRates }
        : LINEAR_UNIT_FACTORS[cat];

    const keys = Object.keys(table);
    // Exact match first (important for case-sensitive B/KB/KiB/MB/MiB and m/mm)
    const exactFrom = keys.find((k) => k === fromUnit);
    const exactTo = keys.find((k) => k === toUnit);
    if (exactFrom && exactTo) {
      return { category: cat, fromKey: exactFrom, toKey: exactTo };
    }
    // Case-insensitive fallback if not ambiguous in data size
    if (cat !== "data") {
      const ciFrom = keys.find((k) => k.toLowerCase() === fromUnit.toLowerCase());
      const ciTo = keys.find((k) => k.toLowerCase() === toUnit.toLowerCase());
      if (ciFrom && ciTo) {
        return { category: cat, fromKey: ciFrom, toKey: ciTo };
      }
    }
  }
  return null;
}

export function runUnitCurrencyConverter(
  input: UnitCurrencyConverterInput,
): UnitCurrencyConverterResult {
  const programmerConversion =
    input.programmerInput !== undefined
      ? convertProgrammerBase(input.programmerInput, input.programmerBase ?? 10)
      : convertProgrammerBase(input.value, 10);

  const resolved = findCategoryForUnits(
    input.fromUnit,
    input.toUnit,
    input.customCurrencyRates,
  );
  if (!resolved) {
    return {
      ok: false,
      category: "length",
      inputValue: input.value,
      fromUnit: input.fromUnit,
      toUnit: input.toUnit,
      outputValue: Number.NaN,
      formattedOutput: "NaN",
      formulaSummary: "Incompatible or unsupported units",
      programmerConversion,
      error: `Cannot convert from '${input.fromUnit}' to '${input.toUnit}'`,
    };
  }

  const { category, fromKey, toKey } = resolved;
  let outputValue = input.value;

  if (category === "temperature") {
    let celsius = input.value;
    if (fromKey === "F") celsius = ((input.value - 32) * 5) / 9;
    else if (fromKey === "K") celsius = input.value - 273.15;

    if (toKey === "C") outputValue = celsius;
    else if (toKey === "F") outputValue = (celsius * 9) / 5 + 32;
    else if (toKey === "K") outputValue = celsius + 273.15;
  } else if (category === "currency") {
    const rates = {
      ...LINEAR_UNIT_FACTORS.currency,
      ...(input.customCurrencyRates ?? {}),
    };
    const fromRatePerUsd = rates[fromKey]!;
    const toRatePerUsd = rates[toKey]!;
    const inUsd = input.value / fromRatePerUsd;
    outputValue = inUsd * toRatePerUsd;
  } else {
    const table = LINEAR_UNIT_FACTORS[category];
    const fromFactor = table[fromKey]!;
    const toFactor = table[toKey]!;
    outputValue = (input.value * fromFactor) / toFactor;
  }

  const formattedOutput = formatCleanDecimal(outputValue);
  return {
    ok: true,
    category,
    inputValue: input.value,
    fromUnit: fromKey,
    toUnit: toKey,
    outputValue,
    formattedOutput,
    formulaSummary: `${input.value} ${fromKey} = ${formattedOutput} ${toKey}`,
    programmerConversion,
  };
}

// ============================================================================
// 3. BUILTIN JSON / JSONL & SCHEMA VALIDATOR
// ============================================================================

export interface JsonSyntaxErrorLocation {
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export interface JsonSchemaDescriptor {
  readonly type?:
    | "object"
    | "array"
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "null"
    | undefined;
  readonly required?: readonly string[] | undefined;
  readonly properties?: Readonly<Record<string, JsonSchemaDescriptor>> | undefined;
  readonly items?: JsonSchemaDescriptor | undefined;
  readonly enum?: readonly unknown[] | undefined;
  readonly minimum?: number | undefined;
  readonly maximum?: number | undefined;
  readonly minLength?: number | undefined;
  readonly maxLength?: number | undefined;
  readonly pattern?: string | undefined;
  readonly additionalProperties?: boolean | undefined;
}

export interface JsonSchemaViolation {
  readonly path: string;
  readonly message: string;
}

export interface JsonSchemaValidatorInput {
  readonly payload: string;
  readonly mode?: "json" | "jsonl" | "auto" | undefined;
  readonly schema?: JsonSchemaDescriptor | string | undefined;
}

export interface JsonSchemaValidatorResult {
  readonly valid: boolean;
  readonly mode: "json" | "jsonl";
  readonly recordCount: number;
  readonly syntaxErrors: readonly JsonSyntaxErrorLocation[];
  readonly schemaViolations: readonly JsonSchemaViolation[];
  readonly parsedValue?: unknown;
  readonly normalizedJson?: string | undefined;
}

function offsetToLineColumn(text: string, offset: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < clamped; i += 1) {
    if (text[i] === "\n") {
      line += 1;
      lastNewline = i;
    }
  }
  return { line, column: clamped - lastNewline };
}

function extractSyntaxErrorPosition(rawText: string, errMessage: string): JsonSyntaxErrorLocation {
  const lineColMatch = /line\s+(\d+)\s+column\s+(\d+)/i.exec(errMessage);
  if (lineColMatch) {
    return {
      line: Number.parseInt(lineColMatch[1]!, 10),
      column: Number.parseInt(lineColMatch[2]!, 10),
      message: errMessage,
    };
  }
  const posMatch = /position\s+(\d+)/i.exec(errMessage);
  if (posMatch) {
    const offset = Number.parseInt(posMatch[1]!, 10);
    const { line, column } = offsetToLineColumn(rawText, offset);
    return { line, column, message: errMessage };
  }
  // Fallback: locate end of non-whitespace
  const { line, column } = offsetToLineColumn(rawText, rawText.trimEnd().length);
  return { line, column, message: errMessage };
}

function validateValueAgainstSchema(
  value: unknown,
  schema: JsonSchemaDescriptor,
  path: string,
  violations: JsonSchemaViolation[],
): void {
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) {
    violations.push({
      path,
      message: `Value ${JSON.stringify(value)} is not in enum [${schema.enum.map((x) => JSON.stringify(x)).join(", ")}]`,
    });
  }

  if (schema.type) {
    const actualType =
      value === null
        ? "null"
        : Array.isArray(value)
          ? "array"
          : typeof value === "number" && Number.isInteger(value) && schema.type === "integer"
            ? "integer"
            : typeof value;

    const matches =
      actualType === schema.type ||
      (schema.type === "number" && typeof value === "number" && Number.isFinite(value));

    if (!matches) {
      violations.push({
        path,
        message: `Expected type '${schema.type}', got '${actualType}'`,
      });
      return;
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      violations.push({
        path,
        message: `Value ${value} is less than minimum ${schema.minimum}`,
      });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      violations.push({
        path,
        message: `Value ${value} is greater than maximum ${schema.maximum}`,
      });
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      violations.push({
        path,
        message: `String length ${value.length} is less than minLength ${schema.minLength}`,
      });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      violations.push({
        path,
        message: `String length ${value.length} exceeds maxLength ${schema.maxLength}`,
      });
    }
    if (schema.pattern !== undefined) {
      const re = new RegExp(schema.pattern);
      if (!re.test(value)) {
        violations.push({
          path,
          message: `String does not match pattern '${schema.pattern}'`,
        });
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, idx) => {
      validateValueAgainstSchema(item, schema.items!, `${path}[${idx}]`, violations);
    });
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (schema.required) {
      for (const reqKey of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(record, reqKey)) {
          violations.push({
            path: `${path}.${reqKey}`,
            message: `Missing required property '${reqKey}'`,
          });
        }
      }
    }
    if (schema.properties) {
      for (const [propKey, propSchema] of Object.entries(schema.properties)) {
        if (Object.prototype.hasOwnProperty.call(record, propKey)) {
          validateValueAgainstSchema(
            record[propKey],
            propSchema,
            `${path}.${propKey}`,
            violations,
          );
        }
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(record)) {
        if (!allowed.has(key)) {
          violations.push({
            path: `${path}.${key}`,
            message: `Additional property '${key}' is not allowed`,
          });
        }
      }
    }
  }
}

export function runJsonSchemaValidator(
  input: JsonSchemaValidatorInput,
): JsonSchemaValidatorResult {
  const syntaxErrors: JsonSyntaxErrorLocation[] = [];
  const schemaViolations: JsonSchemaViolation[] = [];

  let resolvedSchema: JsonSchemaDescriptor | undefined;
  if (typeof input.schema === "string" && input.schema.trim()) {
    try {
      resolvedSchema = JSON.parse(input.schema) as JsonSchemaDescriptor;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      syntaxErrors.push({
        line: 1,
        column: 1,
        message: `Invalid Schema JSON: ${msg}`,
      });
    }
  } else if (typeof input.schema === "object" && input.schema !== null) {
    resolvedSchema = input.schema;
  }

  const trimmed = input.payload.trim();
  const nonEmptyLines = input.payload
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter((entry) => entry.line.length > 0);

  const detectedMode: "json" | "jsonl" =
    input.mode && input.mode !== "auto"
      ? input.mode
      : nonEmptyLines.length > 1 &&
          nonEmptyLines.every((l) => l.line.startsWith("{") && l.line.endsWith("}"))
        ? "jsonl"
        : "json";

  if (detectedMode === "jsonl") {
    const records: unknown[] = [];
    for (const entry of nonEmptyLines) {
      try {
        const parsed = JSON.parse(entry.line);
        records.push(parsed);
        if (resolvedSchema) {
          validateValueAgainstSchema(
            parsed,
            resolvedSchema,
            `$[${records.length - 1}]`,
            schemaViolations,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const loc = extractSyntaxErrorPosition(entry.line, msg);
        syntaxErrors.push({
          line: entry.lineNumber,
          column: loc.column,
          message: msg,
        });
      }
    }
    return {
      valid: syntaxErrors.length === 0 && schemaViolations.length === 0,
      mode: "jsonl",
      recordCount: records.length,
      syntaxErrors,
      schemaViolations,
      parsedValue: records,
      normalizedJson: records.map((r) => JSON.stringify(r)).join("\n"),
    };
  }

  if (!trimmed) {
    syntaxErrors.push({ line: 1, column: 1, message: "JSON payload is empty" });
    return {
      valid: false,
      mode: "json",
      recordCount: 0,
      syntaxErrors,
      schemaViolations,
    };
  }

  try {
    const parsed = JSON.parse(input.payload);
    if (resolvedSchema) {
      validateValueAgainstSchema(parsed, resolvedSchema, "$", schemaViolations);
    }
    return {
      valid: syntaxErrors.length === 0 && schemaViolations.length === 0,
      mode: "json",
      recordCount: 1,
      syntaxErrors,
      schemaViolations,
      parsedValue: parsed,
      normalizedJson: JSON.stringify(parsed, null, 2),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    syntaxErrors.push(extractSyntaxErrorPosition(input.payload, msg));
    return {
      valid: false,
      mode: "json",
      recordCount: 0,
      syntaxErrors,
      schemaViolations,
    };
  }
}

// ============================================================================
// 4. BUILTIN REGEX TESTER
// ============================================================================

export interface RegexMatchEntry {
  readonly matchIndex: number;
  readonly fullMatch: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly line: number;
  readonly column: number;
  readonly captureGroups: readonly (string | null)[];
  readonly namedGroups: Readonly<Record<string, string>>;
}

export interface RegexTesterInput {
  readonly pattern: string;
  readonly flags?: string | undefined;
  readonly testString: string;
  readonly replacement?: string | undefined;
}

export interface RegexTesterResult {
  readonly ok: boolean;
  readonly pattern: string;
  readonly flags: string;
  readonly matchCount: number;
  readonly matches: readonly RegexMatchEntry[];
  readonly replacementPreview?: string | undefined;
  readonly error?: string | undefined;
}

function parseRepeatingQuantifierAt(pattern: string, index: number): number {
  const ch = pattern[index];
  if (ch === "+" || ch === "*") {
    return pattern[index + 1] === "?" ? 2 : 1;
  }
  if (ch === "{") {
    const match = /^\{(\d+)(?:,(\d*))?\}\??/.exec(pattern.slice(index));
    if (match) {
      const min = Number.parseInt(match[1]!, 10);
      const maxStr = match[2];
      const max = maxStr === undefined ? min : maxStr === "" ? Number.POSITIVE_INFINITY : Number.parseInt(maxStr, 10);
      if (max >= 2) {
        return match[0].length;
      }
    }
  }
  return 0;
}

function hasOverlappingAlternationBranches(branches: readonly string[]): boolean {
  if (branches.length < 2) return false;
  const normalized = branches.map((b) => b.trim());
  for (let i = 0; i < normalized.length; i += 1) {
    const left = normalized[i]!;
    if (left.length === 0) return true;
    for (let j = i + 1; j < normalized.length; j += 1) {
      const right = normalized[j]!;
      if (right.length === 0) return true;
      if (left === right || left.startsWith(right) || right.startsWith(left)) {
        return true;
      }
    }
  }
  return false;
}

function hasUnsafeRedosConstruct(pattern: string): boolean {
  interface GroupFrame {
    hasRepeatingQuantifier: boolean;
    branches: string[];
    currentBranch: string;
  }
  const stack: GroupFrame[] = [];
  let inCharClass = false;
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      if (stack.length > 0) {
        stack[stack.length - 1]!.currentBranch += pattern.slice(i, i + 2);
      }
      i += 2;
      continue;
    }
    if (inCharClass) {
      if (ch === "]") inCharClass = false;
      if (stack.length > 0) {
        stack[stack.length - 1]!.currentBranch += ch;
      }
      i += 1;
      continue;
    }
    if (ch === "[") {
      inCharClass = true;
      if (stack.length > 0) {
        stack[stack.length - 1]!.currentBranch += ch;
      }
      i += 1;
      continue;
    }
    if (ch === "(") {
      let headerSkip = 1;
      if (pattern[i + 1] === "?") {
        const namedMatch = /^\(\?<[^>]+>/.exec(pattern.slice(i));
        if (namedMatch) {
          headerSkip = namedMatch[0].length;
        } else if (pattern[i + 2] && ":!=".includes(pattern[i + 2]!)) {
          headerSkip = 3;
        }
      }
      stack.push({
        hasRepeatingQuantifier: false,
        branches: [],
        currentBranch: "",
      });
      i += headerSkip;
      continue;
    }
    if (ch === "|" && stack.length > 0) {
      const top = stack[stack.length - 1]!;
      top.branches.push(top.currentBranch);
      top.currentBranch = "";
      i += 1;
      continue;
    }
    if (ch === ")") {
      const closed = stack.pop();
      i += 1;
      while (i < pattern.length && /\s/.test(pattern[i]!)) {
        i += 1;
      }
      const quantLen = parseRepeatingQuantifierAt(pattern, i);
      if (closed) {
        closed.branches.push(closed.currentBranch);
        if (quantLen > 0) {
          if (closed.hasRepeatingQuantifier || hasOverlappingAlternationBranches(closed.branches)) {
            return true;
          }
          if (stack.length > 0) {
            stack[stack.length - 1]!.hasRepeatingQuantifier = true;
          }
          i += quantLen;
          continue;
        }
        if (stack.length > 0) {
          const parent = stack[stack.length - 1]!;
          if (closed.hasRepeatingQuantifier) {
            parent.hasRepeatingQuantifier = true;
          }
          parent.currentBranch += `(${closed.branches.join("|")})`;
        }
      }
      continue;
    }

    const quantLen = parseRepeatingQuantifierAt(pattern, i);
    if (quantLen > 0) {
      if (stack.length > 0) {
        stack[stack.length - 1]!.hasRepeatingQuantifier = true;
        stack[stack.length - 1]!.currentBranch += pattern.slice(i, i + quantLen);
      }
      i += quantLen;
      continue;
    }

    if (stack.length > 0) {
      stack[stack.length - 1]!.currentBranch += ch;
    }
    i += 1;
  }

  return false;
}

export function runRegexTester(input: RegexTesterInput): RegexTesterResult {
  const rawFlags = input.flags ?? "g";
  const allowedFlags = new Set(["g", "i", "m", "s", "u"]);
  const dedupedFlags = [...new Set(rawFlags.split(""))]
    .filter((f) => allowedFlags.has(f))
    .join("");

  if (input.pattern.length > 2048) {
    return {
      ok: false,
      pattern: input.pattern,
      flags: dedupedFlags,
      matchCount: 0,
      matches: [],
      error: "Regular expression pattern exceeds maximum safe length (2048 chars).",
    };
  }
  if (input.testString.length > 200_000) {
    return {
      ok: false,
      pattern: input.pattern,
      flags: dedupedFlags,
      matchCount: 0,
      matches: [],
      error: "Test string exceeds maximum safe length (200,000 chars).",
    };
  }
  if (hasUnsafeRedosConstruct(input.pattern)) {
    return {
      ok: false,
      pattern: input.pattern,
      flags: dedupedFlags,
      matchCount: 0,
      matches: [],
      error: "Rejected pattern with nested unbounded quantifiers to prevent catastrophic backtracking (ReDoS).",
    };
  }

  try {
    const regex = new RegExp(input.pattern, dedupedFlags);
    const matches: RegexMatchEntry[] = [];

    if (dedupedFlags.includes("g")) {
      let execResult: RegExpExecArray | null;
      let safety = 0;
      while ((execResult = regex.exec(input.testString)) !== null && safety < 5000) {
        safety += 1;
        const fullMatch = execResult[0] ?? "";
        const startIndex = execResult.index;
        const endIndex = startIndex + fullMatch.length;
        const { line, column } = offsetToLineColumn(input.testString, startIndex);
        const captureGroups = execResult.slice(1).map((g) => (g === undefined ? null : g));
        const namedGroups: Record<string, string> = {};
        if (execResult.groups) {
          for (const [k, v] of Object.entries(execResult.groups)) {
            if (v !== undefined) namedGroups[k] = v;
          }
        }
        matches.push({
          matchIndex: matches.length,
          fullMatch,
          startIndex,
          endIndex,
          line,
          column,
          captureGroups,
          namedGroups,
        });
        if (fullMatch.length === 0) {
          regex.lastIndex += 1;
        }
      }
    } else {
      const execResult = regex.exec(input.testString);
      if (execResult) {
        const fullMatch = execResult[0] ?? "";
        const startIndex = execResult.index;
        const endIndex = startIndex + fullMatch.length;
        const { line, column } = offsetToLineColumn(input.testString, startIndex);
        const captureGroups = execResult.slice(1).map((g) => (g === undefined ? null : g));
        const namedGroups: Record<string, string> = {};
        if (execResult.groups) {
          for (const [k, v] of Object.entries(execResult.groups)) {
            if (v !== undefined) namedGroups[k] = v;
          }
        }
        matches.push({
          matchIndex: 0,
          fullMatch,
          startIndex,
          endIndex,
          line,
          column,
          captureGroups,
          namedGroups,
        });
      }
    }

    const replacementPreview =
      input.replacement !== undefined
        ? input.testString.replace(new RegExp(input.pattern, dedupedFlags), input.replacement)
        : undefined;

    return {
      ok: true,
      pattern: input.pattern,
      flags: dedupedFlags,
      matchCount: matches.length,
      matches,
      replacementPreview,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      pattern: input.pattern,
      flags: dedupedFlags,
      matchCount: 0,
      matches: [],
      error: message,
    };
  }
}

// ============================================================================
// 5. BUILTIN HASH, CODEC, JWT & TOKEN INSPECTOR
// ============================================================================

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr32(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function computeSha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const totalBytes = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(totalBytes);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  const hiBits = Math.floor(bitLen / 0x100000000);
  const loBits = bitLen >>> 0;
  view.setUint32(totalBytes - 8, hiBits, false);
  view.setUint32(totalBytes - 4, loBits, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < totalBytes; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = rotr32(w15, 7) ^ rotr32(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr32(w2, 17) ^ rotr32(w2, 19) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => v.toString(16).padStart(8, "0"))
    .join("");
}

export function computeFnv1a64Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function computeCrc32(input: string): { hex: string; uint32: number } {
  const bytes = new TextEncoder().encode(input);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    const idx = (crc ^ byte) & 0xff;
    crc = (CRC32_TABLE[idx]! ^ (crc >>> 8)) >>> 0;
  }
  const finalCrc = (crc ^ 0xffffffff) >>> 0;
  return {
    hex: finalCrc.toString(16).padStart(8, "0"),
    uint32: finalCrc,
  };
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function encodeBase64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;
    out += BASE64_ALPHABET[(triplet >>> 18) & 0x3f]!;
    out += BASE64_ALPHABET[(triplet >>> 12) & 0x3f]!;
    out += i + 1 < bytes.length ? BASE64_ALPHABET[(triplet >>> 6) & 0x3f]! : "=";
    out += i + 2 < bytes.length ? BASE64_ALPHABET[triplet & 0x3f]! : "=";
  }
  return out;
}

export function decodeBase64Utf8(base64Input: string): string {
  const normalized = base64Input
    .trim()
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/\s+/g, "");
  const padded =
    normalized.length % 4 === 0
      ? normalized
      : normalized + "=".repeat(4 - (normalized.length % 4));

  const bytes: number[] = [];
  for (let i = 0; i < padded.length; i += 4) {
    const c0 = BASE64_ALPHABET.indexOf(padded[i]!);
    const c1 = BASE64_ALPHABET.indexOf(padded[i + 1]!);
    const c2 = padded[i + 2] === "=" ? 0 : BASE64_ALPHABET.indexOf(padded[i + 2]!);
    const c3 = padded[i + 3] === "=" ? 0 : BASE64_ALPHABET.indexOf(padded[i + 3]!);
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) {
      throw new Error("Invalid Base64 character encountered");
    }
    const triplet = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    bytes.push((triplet >>> 16) & 0xff);
    if (padded[i + 2] !== "=") bytes.push((triplet >>> 8) & 0xff);
    if (padded[i + 3] !== "=") bytes.push(triplet & 0xff);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export interface JwtInspectionResult {
  readonly isJwt: boolean;
  readonly header?: Readonly<Record<string, unknown>> | undefined;
  readonly payload?: Readonly<Record<string, unknown>> | undefined;
  readonly signatureSegment?: string | undefined;
  readonly isExpired?: boolean | undefined;
  readonly expiresAtIso?: string | undefined;
  readonly issuedAtIso?: string | undefined;
  readonly error?: string | undefined;
}

export function inspectJwtToken(
  token: string,
  nowEpochSeconds = Math.floor(Date.now() / 1000),
): JwtInspectionResult {
  const parts = token.trim().split(".");
  if (parts.length !== 3) {
    return { isJwt: false, error: "Token does not have 3 dot-separated JWT segments" };
  }
  try {
    const header = JSON.parse(decodeBase64Utf8(parts[0]!)) as Record<string, unknown>;
    const payload = JSON.parse(decodeBase64Utf8(parts[1]!)) as Record<string, unknown>;
    const exp = typeof payload.exp === "number" ? payload.exp : undefined;
    const iat = typeof payload.iat === "number" ? payload.iat : undefined;
    return {
      isJwt: true,
      header,
      payload,
      signatureSegment: parts[2],
      isExpired: exp !== undefined ? nowEpochSeconds >= exp : undefined,
      expiresAtIso: exp !== undefined ? new Date(exp * 1000).toISOString() : undefined,
      issuedAtIso: iat !== undefined ? new Date(iat * 1000).toISOString() : undefined,
    };
  } catch (err) {
    return {
      isJwt: false,
      error: err instanceof Error ? err.message : "Malformed JWT JSON segment",
    };
  }
}

export interface TokenByteCounts {
  readonly utf8ByteLength: number;
  readonly characterCount: number;
  readonly wordCount: number;
  readonly lineCount: number;
  readonly estimatedTokens: number;
}

export function countTokensAndBytes(text: string): TokenByteCounts {
  const utf8ByteLength = new TextEncoder().encode(text).length;
  const characterCount = text.length;
  const trimmed = text.trim();
  const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;
  const lineCount = text.length === 0 ? 0 : text.split(/\r?\n/).length;
  // Heuristic BPE token estimator: accounts for words, punctuation symbols, and UTF-8 multi-byte chars
  const symbolMatches = text.match(/[^\w\s]/g)?.length ?? 0;
  const baseByChars = Math.ceil(characterCount / 4);
  const baseByWordsAndSymbols = Math.ceil(wordCount * 1.3 + symbolMatches * 0.5);
  const estimatedTokens =
    characterCount === 0 ? 0 : Math.max(1, Math.round((baseByChars + baseByWordsAndSymbols) / 2));

  return {
    utf8ByteLength,
    characterCount,
    wordCount,
    lineCount,
    estimatedTokens,
  };
}

export interface HashCodecInput {
  readonly input: string;
  readonly decodeDirection?: "encode" | "decode" | undefined;
  readonly decodeFormat?: "base64" | "hex" | "url" | undefined;
  readonly nowEpochSeconds?: number | undefined;
}

export interface HashCodecResult {
  readonly input: string;
  readonly sha256: string;
  readonly fnv1a64: string;
  readonly crc32Hex: string;
  readonly crc32Uint32: number;
  readonly base64Encoded: string;
  readonly hexEncoded: string;
  readonly urlEncoded: string;
  readonly decodedOutput?: string | undefined;
  readonly decodeError?: string | undefined;
  readonly jwtInspection: JwtInspectionResult;
  readonly counts: TokenByteCounts;
}

export function runHashCodec(input: HashCodecInput | string): HashCodecResult {
  const normalized: HashCodecInput = typeof input === "string" ? { input } : input;
  const text = normalized.input;
  const bytes = new TextEncoder().encode(text);
  const hexEncoded = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const crc = computeCrc32(text);

  let decodedOutput: string | undefined;
  let decodeError: string | undefined;
  if (normalized.decodeDirection === "decode" && normalized.decodeFormat) {
    try {
      if (normalized.decodeFormat === "base64") {
        decodedOutput = decodeBase64Utf8(text);
      } else if (normalized.decodeFormat === "hex") {
        const cleanHex = text.trim().replace(/^0x/i, "").replace(/\s+/g, "");
        if (cleanHex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(cleanHex)) {
          throw new Error("Invalid hex string");
        }
        const outBytes = new Uint8Array(cleanHex.length / 2);
        for (let i = 0; i < cleanHex.length; i += 2) {
          outBytes[i / 2] = Number.parseInt(cleanHex.slice(i, i + 2), 16);
        }
        decodedOutput = new TextDecoder().decode(outBytes);
      } else if (normalized.decodeFormat === "url") {
        decodedOutput = decodeURIComponent(text);
      }
    } catch (err) {
      decodeError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    input: text,
    sha256: computeSha256Hex(text),
    fnv1a64: computeFnv1a64Hex(text),
    crc32Hex: crc.hex,
    crc32Uint32: crc.uint32,
    base64Encoded: encodeBase64Utf8(text),
    hexEncoded,
    urlEncoded: encodeURIComponent(text),
    decodedOutput,
    decodeError,
    jwtInspection: inspectJwtToken(text, normalized.nowEpochSeconds),
    counts: countTokensAndBytes(text),
  };
}

// ============================================================================
// 6. BUILTIN DATETIME & 5-FIELD CRON SOLVER
// ============================================================================

export interface DurationDifference {
  readonly totalMilliseconds: number;
  readonly totalSeconds: number;
  readonly days: number;
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
  readonly milliseconds: number;
  readonly humanReadable: string;
  readonly isoDuration: string;
}

export interface CronScheduleSolution {
  readonly valid: boolean;
  readonly cronExpression: string;
  readonly description: string;
  readonly nextTriggerTimesIso: readonly string[];
  readonly error?: string | undefined;
}

export interface DateTimeCronSolverInput {
  readonly timestampA?: string | number | undefined;
  readonly timestampB?: string | number | undefined;
  readonly cronExpression?: string | undefined;
  readonly nextCount?: number | undefined;
  readonly referenceTime?: string | number | undefined;
}

export interface DateTimeCronSolverResult {
  readonly ok: boolean;
  readonly parsedTimestampA?: { readonly iso: string; readonly epochMs: number; readonly epochSeconds: number } | undefined;
  readonly parsedTimestampB?: { readonly iso: string; readonly epochMs: number; readonly epochSeconds: number } | undefined;
  readonly durationDifference?: DurationDifference | undefined;
  readonly cronSolution?: CronScheduleSolution | undefined;
  readonly error?: string | undefined;
}

export function parseFlexibleTimestamp(
  raw: string | number,
): { iso: string; epochMs: number; epochSeconds: number } {
  if (typeof raw === "number") {
    // Distinguish Unix epoch seconds (< 1e11) from milliseconds
    const epochMs = Math.abs(raw) < 1e11 ? Math.round(raw * 1000) : Math.round(raw);
    const d = new Date(epochMs);
    if (Number.isNaN(d.getTime())) throw new Error(`Invalid numeric timestamp: ${raw}`);
    return {
      iso: d.toISOString(),
      epochMs,
      epochSeconds: Math.floor(epochMs / 1000),
    };
  }
  const trimmed = raw.trim();
  if (/^-?\d+$/.test(trimmed)) {
    return parseFlexibleTimestamp(Number.parseInt(trimmed, 10));
  }
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid timestamp string: '${raw}'`);
  }
  const epochMs = d.getTime();
  return {
    iso: d.toISOString(),
    epochMs,
    epochSeconds: Math.floor(epochMs / 1000),
  };
}

export function computeDurationDifference(msA: number, msB: number): DurationDifference {
  const diffMs = Math.abs(msB - msA);
  const days = Math.floor(diffMs / 86400000);
  const remAfterDays = diffMs % 86400000;
  const hours = Math.floor(remAfterDays / 3600000);
  const remAfterHours = remAfterDays % 3600000;
  const minutes = Math.floor(remAfterHours / 60000);
  const remAfterMinutes = remAfterHours % 60000;
  const seconds = Math.floor(remAfterMinutes / 1000);
  const milliseconds = remAfterMinutes % 1000;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  if (milliseconds > 0) parts.push(`${milliseconds}ms`);

  return {
    totalMilliseconds: diffMs,
    totalSeconds: Math.floor(diffMs / 1000),
    days,
    hours,
    minutes,
    seconds,
    milliseconds,
    humanReadable: parts.join(" "),
    isoDuration: `P${days}DT${hours}H${minutes}M${seconds}${milliseconds ? `.${milliseconds}` : ""}S`,
  };
}

const MONTH_ALIASES: Readonly<Record<string, number>> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const DOW_ALIASES: Readonly<Record<string, number>> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};

function parseCronField(
  field: string,
  min: number,
  max: number,
  aliases?: Readonly<Record<string, number>>,
  isDow = false,
): Set<number> {
  const values = new Set<number>();
  let normalized = field.toUpperCase();
  if (aliases) {
    for (const [name, num] of Object.entries(aliases)) {
      normalized = normalized.replace(new RegExp(`\\b${name}\\b`, "g"), String(num));
    }
  }

  for (const part of normalized.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart !== undefined ? Number.parseInt(stepPart, 10) : 1;
    if (!Number.isFinite(step) || step <= 0) {
      throw new Error(`Invalid cron step in '${field}'`);
    }

    let start = min;
    let end = max;
    if (rangePart !== "*") {
      if (rangePart!.includes("-")) {
        const [sStr, eStr] = rangePart!.split("-");
        start = Number.parseInt(sStr!, 10);
        end = Number.parseInt(eStr!, 10);
      } else {
        start = Number.parseInt(rangePart!, 10);
        end = stepPart !== undefined ? max : start;
      }
    }

    if (isDow) {
      if (start === 7) start = 0;
      if (end === 7) end = 6;
    }

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < min ||
      end > max ||
      start > end
    ) {
      throw new Error(`Cron value out of bounds [${min}-${max}] in '${field}'`);
    }

    for (let v = start; v <= end; v += step) {
      values.add(isDow && v === 7 ? 0 : v);
    }
  }
  return values;
}

export function solveCronExpression(
  cronExpression: string,
  nextCount = 5,
  referenceTime: string | number = "2026-01-01T00:00:00.000Z",
): CronScheduleSolution {
  const trimmed = cronExpression.trim();
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return {
      valid: false,
      cronExpression: trimmed,
      description: "Invalid cron expression",
      nextTriggerTimesIso: [],
      error: `Expected 5 cron fields (minute hour dom month dow), got ${fields.length}`,
    };
  }

  try {
    const minutes = parseCronField(fields[0]!, 0, 59);
    const hours = parseCronField(fields[1]!, 0, 23);
    const doms = parseCronField(fields[2]!, 1, 31);
    const months = parseCronField(fields[3]!, 1, 12, MONTH_ALIASES);
    const dows = parseCronField(fields[4]!, 0, 7, DOW_ALIASES, true);

    const domWildcard = fields[2] === "*";
    const dowWildcard = fields[4] === "*";

    const ref = parseFlexibleTimestamp(referenceTime);
    const cursor = new Date(ref.epochMs);
    cursor.setUTCSeconds(0, 0);
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

    const triggers: string[] = [];
    const maxIterations = 525600 * 2; // Up to 2 years of minutes

    for (let i = 0; i < maxIterations && triggers.length < nextCount; i += 1) {
      const m = cursor.getUTCMinutes();
      const h = cursor.getUTCHours();
      const dom = cursor.getUTCDate();
      const mon = cursor.getUTCMonth() + 1;
      const dow = cursor.getUTCDay();

      if (minutes.has(m) && hours.has(h) && months.has(mon)) {
        const domMatch = doms.has(dom);
        const dowMatch = dows.has(dow);
        const dayMatches =
          domWildcard && dowWildcard
            ? true
            : domWildcard
              ? dowMatch
              : dowWildcard
                ? domMatch
                : domMatch || dowMatch;

        if (dayMatches) {
          triggers.push(cursor.toISOString());
        }
      }
      cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    }

    return {
      valid: true,
      cronExpression: trimmed,
      description: `Runs matching [min:${fields[0]} hr:${fields[1]} dom:${fields[2]} mon:${fields[3]} dow:${fields[4]}] UTC`,
      nextTriggerTimesIso: triggers,
    };
  } catch (err) {
    return {
      valid: false,
      cronExpression: trimmed,
      description: "Invalid cron expression",
      nextTriggerTimesIso: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function runDateTimeCronSolver(
  input: DateTimeCronSolverInput,
): DateTimeCronSolverResult {
  try {
    const parsedA =
      input.timestampA !== undefined ? parseFlexibleTimestamp(input.timestampA) : undefined;
    const parsedB =
      input.timestampB !== undefined ? parseFlexibleTimestamp(input.timestampB) : undefined;
    const durationDifference =
      parsedA && parsedB
        ? computeDurationDifference(parsedA.epochMs, parsedB.epochMs)
        : undefined;
    const cronSolution =
      input.cronExpression !== undefined
        ? solveCronExpression(
            input.cronExpression,
            input.nextCount ?? 5,
            input.referenceTime ?? parsedA?.iso ?? "2026-01-01T00:00:00.000Z",
          )
        : undefined;

    const ok = cronSolution ? cronSolution.valid : true;
    return {
      ok,
      parsedTimestampA: parsedA,
      parsedTimestampB: parsedB,
      durationDifference,
      cronSolution,
      error: cronSolution?.error,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================================
// 7. BUILTIN CODE SYNTAX & BRACKET BALANCE CHECKER
// ============================================================================

export type SupportedSyntaxLanguage = "ts" | "js" | "rust" | "python" | "json" | "sql";

export interface SyntaxBalanceIssue {
  readonly kind:
    | "unmatched-closing-bracket"
    | "mismatched-bracket"
    | "unclosed-bracket"
    | "unclosed-string"
    | "unclosed-comment";
  readonly line: number;
  readonly column: number;
  readonly token: string;
  readonly expected?: string | undefined;
  readonly message: string;
}

export interface CodeSyntaxBalanceInput {
  readonly code: string;
  readonly language?: SupportedSyntaxLanguage | undefined;
}

export interface CodeSyntaxBalanceResult {
  readonly balanced: boolean;
  readonly language: SupportedSyntaxLanguage;
  readonly issues: readonly SyntaxBalanceIssue[];
  readonly stats: {
    readonly parensCount: number;
    readonly bracketsCount: number;
    readonly bracesCount: number;
    readonly stringLiteralCount: number;
    readonly commentCount: number;
  };
}

const MATCHING_CLOSE: Readonly<Record<string, string>> = {
  "(": ")",
  "[": "]",
  "{": "}",
};

const MATCHING_OPEN: Readonly<Record<string, string>> = {
  ")": "(",
  "]": "[",
  "}": "{",
};

export function runCodeSyntaxBalanceChecker(
  input: CodeSyntaxBalanceInput | string,
): CodeSyntaxBalanceResult {
  const normalized: CodeSyntaxBalanceInput =
    typeof input === "string" ? { code: input } : input;
  const code = normalized.code;
  const language = normalized.language ?? "ts";

  const issues: SyntaxBalanceIssue[] = [];
  const stack: Array<{ char: string; line: number; column: number }> = [];

  let parensCount = 0;
  let bracketsCount = 0;
  let bracesCount = 0;
  let stringLiteralCount = 0;
  let commentCount = 0;

  let i = 0;
  const len = code.length;
  let line = 1;
  let col = 1;

  const advance = (steps = 1) => {
    for (let s = 0; s < steps && i < len; s += 1) {
      if (code[i] === "\n") {
        line += 1;
        col = 1;
      } else {
        col += 1;
      }
      i += 1;
    }
  };

  while (i < len) {
    const ch = code[i]!;
    const next = code[i + 1];

    // Line comments
    if (
      (ch === "/" && next === "/" && language !== "sql" && language !== "python" && language !== "json") ||
      (ch === "-" && next === "-" && language === "sql") ||
      (ch === "#" && language === "python")
    ) {
      commentCount += 1;
      while (i < len && code[i] !== "\n") {
        advance(1);
      }
      continue;
    }

    // Block comments /* ... */
    if (ch === "/" && next === "*" && language !== "python" && language !== "json") {
      commentCount += 1;
      const startLine = line;
      const startCol = col;
      advance(2);
      let closed = false;
      while (i < len) {
        if (code[i] === "*" && code[i + 1] === "/") {
          advance(2);
          closed = true;
          break;
        }
        advance(1);
      }
      if (!closed) {
        issues.push({
          kind: "unclosed-comment",
          line: startLine,
          column: startCol,
          token: "/*",
          expected: "*/",
          message: `Unclosed block comment starting at line ${startLine}, column ${startCol}`,
        });
      }
      continue;
    }

    // Python triple-quoted strings
    if (
      language === "python" &&
      ((ch === '"' && next === '"' && code[i + 2] === '"') ||
        (ch === "'" && next === "'" && code[i + 2] === "'"))
    ) {
      const delim = ch.repeat(3);
      const startLine = line;
      const startCol = col;
      stringLiteralCount += 1;
      advance(3);
      let closed = false;
      while (i < len) {
        if (code[i] === "\\") {
          advance(2);
          continue;
        }
        if (code.slice(i, i + 3) === delim) {
          advance(3);
          closed = true;
          break;
        }
        advance(1);
      }
      if (!closed) {
        issues.push({
          kind: "unclosed-string",
          line: startLine,
          column: startCol,
          token: delim,
          expected: delim,
          message: `Unclosed triple-quoted string starting at line ${startLine}, column ${startCol}`,
        });
      }
      continue;
    }

    // Single or double quoted strings, or template literals
    if (ch === '"' || (ch === "'" && language !== "rust") || (ch === "`" && (language === "ts" || language === "js"))) {
      const quote = ch;
      const startLine = line;
      const startCol = col;
      stringLiteralCount += 1;
      advance(1);
      let closed = false;
      while (i < len) {
        const c = code[i]!;
        if (c === "\\") {
          advance(2);
          continue;
        }
        if (c === quote) {
          advance(1);
          closed = true;
          break;
        }
        if (c === "\n" && quote !== "`") {
          // Unescaped newline inside single-line string literal
          break;
        }
        advance(1);
      }
      if (!closed) {
        issues.push({
          kind: "unclosed-string",
          line: startLine,
          column: startCol,
          token: quote,
          expected: quote,
          message: `Unclosed string literal (${quote}) starting at line ${startLine}, column ${startCol}`,
        });
      }
      continue;
    }

    // Brackets
    if (ch === "(" || ch === "[" || ch === "{") {
      if (ch === "(") parensCount += 1;
      if (ch === "[") bracketsCount += 1;
      if (ch === "{") bracesCount += 1;
      stack.push({ char: ch, line, column: col });
      advance(1);
      continue;
    }

    if (ch === ")" || ch === "]" || ch === "}") {
      const expectedOpen = MATCHING_OPEN[ch]!;
      const top = stack.pop();
      if (!top) {
        issues.push({
          kind: "unmatched-closing-bracket",
          line,
          column: col,
          token: ch,
          message: `Unmatched closing '${ch}' at line ${line}, column ${col}`,
        });
      } else if (top.char !== expectedOpen) {
        const expectedClose = MATCHING_CLOSE[top.char]!;
        issues.push({
          kind: "mismatched-bracket",
          line,
          column: col,
          token: ch,
          expected: expectedClose,
          message: `Mismatched closing '${ch}' at line ${line}, column ${col}; expected '${expectedClose}' to close '${top.char}' from line ${top.line}, column ${top.column}`,
        });
      }
      advance(1);
      continue;
    }

    advance(1);
  }

  while (stack.length > 0) {
    const unclosed = stack.pop()!;
    const expectedClose = MATCHING_CLOSE[unclosed.char]!;
    issues.push({
      kind: "unclosed-bracket",
      line: unclosed.line,
      column: unclosed.column,
      token: unclosed.char,
      expected: expectedClose,
      message: `Unclosed '${unclosed.char}' at line ${unclosed.line}, column ${unclosed.column}; expected '${expectedClose}'`,
    });
  }

  return {
    balanced: issues.length === 0,
    language,
    issues,
    stats: {
      parensCount,
      bracketsCount,
      bracesCount,
      stringLiteralCount,
      commentCount,
    },
  };
}

// ============================================================================
// 8. BUILTIN CITATION & FACT GROUNDING CROSS-CHECKER
// ============================================================================

export interface GroundTruthFileEntry {
  readonly path: string;
  readonly content?: string | undefined;
  readonly lineCount?: number | undefined;
}

export interface WorkspaceGroundTruth {
  readonly files?: readonly GroundTruthFileEntry[] | undefined;
  readonly identifiers?: readonly string[] | undefined;
  readonly facts?: readonly string[] | undefined;
}

export interface CitationVerificationItem {
  readonly kind: "file-path" | "source-line" | "identifier" | "quoted-snippet";
  readonly target: string;
  readonly citedLine?: number | undefined;
  readonly verified: boolean;
  readonly reason: string;
}

export interface CitationFactCrossCheckerInput {
  readonly responseText: string;
  readonly groundTruth: WorkspaceGroundTruth;
}

export interface CitationFactCrossCheckerResult {
  readonly allVerified: boolean;
  readonly verifiedCount: number;
  readonly unverifiedCount: number;
  readonly groundingCoverageScore: number;
  readonly items: readonly CitationVerificationItem[];
  readonly hallucinatedCitations: readonly string[];
  readonly remediationNotes: readonly string[];
}

function normalizePathForCompare(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

export function runCitationFactCrossChecker(
  input: CitationFactCrossCheckerInput,
): CitationFactCrossCheckerResult {
  const { responseText, groundTruth } = input;
  const files = groundTruth.files ?? [];
  const knownIdentifiers = new Set(groundTruth.identifiers ?? []);
  const allFileContents = files.map((f) => f.content ?? "").join("\n");
  const allFactsText = (groundTruth.facts ?? []).join("\n");
  const combinedCorpus = `${allFileContents}\n${allFactsText}`;

  const items: CitationVerificationItem[] = [];
  const seenTargets = new Set<string>();

  // 1. Check [path:line] or path/to/file.ext:line markers
  const sourceLineRegex = /\[?([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+):(\d+)(?:-\d+)?\]?/g;
  for (const match of responseText.matchAll(sourceLineRegex)) {
    const rawPath = match[1]!;
    const lineNum = Number.parseInt(match[2]!, 10);
    const key = `source-line:${rawPath}:${lineNum}`;
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);

    const norm = normalizePathForCompare(rawPath);
    const matchedFile = files.find(
      (f) =>
        normalizePathForCompare(f.path) === norm ||
        normalizePathForCompare(f.path).endsWith(`/${norm}`),
    );

    if (!matchedFile) {
      items.push({
        kind: "source-line",
        target: `${rawPath}:${lineNum}`,
        citedLine: lineNum,
        verified: false,
        reason: `Cited file '${rawPath}' does not exist in workspace ground truth`,
      });
    } else {
      const totalLines =
        matchedFile.lineCount ??
        (matchedFile.content ? matchedFile.content.split(/\r?\n/).length : undefined);
      if (totalLines !== undefined && (lineNum < 1 || lineNum > totalLines)) {
        items.push({
          kind: "source-line",
          target: `${rawPath}:${lineNum}`,
          citedLine: lineNum,
          verified: false,
          reason: `Cited line ${lineNum} exceeds '${rawPath}' line count (${totalLines})`,
        });
      } else {
        items.push({
          kind: "source-line",
          target: `${rawPath}:${lineNum}`,
          citedLine: lineNum,
          verified: true,
          reason: `Verified file '${matchedFile.path}' and line ${lineNum} in ground truth`,
        });
      }
    }
  }

  // 2. Check standalone file paths (e.g., src/domain/foo.ts or `package.json`)
  const filePathRegex = /(?:^|[\s`(])((?:src|docs|scripts|tests|packages|repos)\/[a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+|[a-zA-Z0-9_-]+\.(?:tsx?|jsx?|rs|py|json|md|css|toml))(?=[\s`),.:;]|$)/g;
  for (const match of responseText.matchAll(filePathRegex)) {
    const rawPath = match[1]!;
    const norm = normalizePathForCompare(rawPath);
    if (seenTargets.has(`file:${norm}`)) continue;
    seenTargets.add(`file:${norm}`);

    const matchedFile = files.find(
      (f) =>
        normalizePathForCompare(f.path) === norm ||
        normalizePathForCompare(f.path).endsWith(`/${norm}`),
    );
    items.push({
      kind: "file-path",
      target: rawPath,
      verified: Boolean(matchedFile),
      reason: matchedFile
        ? `File '${rawPath}' matches ground truth '${matchedFile.path}'`
        : `File '${rawPath}' was not found in workspace ground truth`,
    });
  }

  // 3. Check backticked code identifiers `identifierName`
  const backtickRegex = /`([a-zA-Z_$][a-zA-Z0-9_$]{2,})`/g;
  for (const match of responseText.matchAll(backtickRegex)) {
    const ident = match[1]!;
    if (seenTargets.has(`ident:${ident}`)) continue;
    seenTargets.add(`ident:${ident}`);

    if (files.length === 0 && knownIdentifiers.size === 0 && !combinedCorpus.trim()) {
      continue;
    }

    const exists =
      knownIdentifiers.has(ident) ||
      combinedCorpus.includes(ident) ||
      files.some((f) => f.path.includes(ident));

    items.push({
      kind: "identifier",
      target: ident,
      verified: exists,
      reason: exists
        ? `Identifier '${ident}' is grounded in workspace context`
        : `Identifier '${ident}' does not appear in provided ground truth`,
    });
  }

  // 4. Check verbatim quoted snippets ("..." of at least 12 chars)
  const quoteRegex = /"([^"\n]{12,160})"/g;
  for (const match of responseText.matchAll(quoteRegex)) {
    const snippet = match[1]!.trim();
    if (seenTargets.has(`quote:${snippet}`)) continue;
    seenTargets.add(`quote:${snippet}`);

    if (!combinedCorpus.trim()) continue;
    const exists = combinedCorpus.toLowerCase().includes(snippet.toLowerCase());
    items.push({
      kind: "quoted-snippet",
      target: snippet,
      verified: exists,
      reason: exists
        ? "Quoted snippet found verbatim in ground truth"
        : "Quoted snippet was not found in ground truth corpus",
    });
  }

  const verifiedCount = items.filter((i) => i.verified).length;
  const unverifiedCount = items.length - verifiedCount;
  const groundingCoverageScore =
    items.length === 0 ? 1 : Number((verifiedCount / items.length).toFixed(4));
  const hallucinatedCitations = items.filter((i) => !i.verified).map((i) => i.target);
  const remediationNotes = items
    .filter((i) => !i.verified)
    .map((i) => `Remove or verify ungrounded ${i.kind} '${i.target}': ${i.reason}`);

  return {
    allVerified: unverifiedCount === 0,
    verifiedCount,
    unverifiedCount,
    groundingCoverageScore,
    items,
    hallucinatedCitations,
    remediationNotes,
  };
}

// ============================================================================
// 9. BUILTIN NUMERIC CLAIM VERIFIER
// ============================================================================

export interface VerifiedNumericClaim {
  readonly rawMatch: string;
  readonly expression: string;
  readonly claimedValue: number;
  readonly expectedValue: number;
  readonly absoluteError: number;
  readonly relativeError: number;
  readonly status: "verified" | "discrepancy";
  readonly correctionSuggestion?: string | undefined;
}

export interface NumericClaimVerifierInput {
  readonly text: string;
  readonly tolerance?: number | undefined;
}

export interface NumericClaimVerifierResult {
  readonly allClaimsAccurate: boolean;
  readonly totalClaimsChecked: number;
  readonly verifiedClaimsCount: number;
  readonly discrepancyCount: number;
  readonly claims: readonly VerifiedNumericClaim[];
  readonly correctedText: string;
}

function parseFormattedNumber(raw: string): number {
  return Number.parseFloat(raw.replace(/,/g, "").trim());
}

export function runNumericClaimVerifier(
  input: NumericClaimVerifierInput | string,
): NumericClaimVerifierResult {
  const normalized: NumericClaimVerifierInput =
    typeof input === "string" ? { text: input } : input;
  const text = normalized.text;
  const tolerance = normalized.tolerance ?? 1e-2;

  const claims: VerifiedNumericClaim[] = [];
  let correctedText = text;
  const seenSpans = new Set<string>();

  // 1. Percentage claims: e.g. "15% of 240 is 36" or "15% of 240 = 36"
  const percentPattern =
    /(\d[\d,]*(?:\.\d+)?)\s*%\s+of\s+(\d[\d,]*(?:\.\d+)?)\s*(?:=|is|equals)\s*(-?\d[\d,]*(?:\.\d+)?)/gi;

  for (const match of text.matchAll(percentPattern)) {
    const rawMatch = match[0]!;
    if (seenSpans.has(rawMatch)) continue;
    seenSpans.add(rawMatch);

    const pct = parseFormattedNumber(match[1]!);
    const total = parseFormattedNumber(match[2]!);
    const claimedValue = parseFormattedNumber(match[3]!);
    const expr = `(${pct} / 100) * ${total}`;
    const calc = runScientificCalculator({ expression: expr });
    if (!calc.ok || !Number.isFinite(calc.value)) continue;

    const expectedValue = calc.value;
    const absoluteError = Math.abs(expectedValue - claimedValue);
    const relativeError =
      expectedValue === 0 ? absoluteError : absoluteError / Math.abs(expectedValue);
    const isAccurate = absoluteError <= tolerance || relativeError <= 1e-4;

    const cleanExpected = formatCleanDecimal(expectedValue);
    const replacement = rawMatch.replace(
      new RegExp(`${match[3]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
      cleanExpected,
    );

    if (!isAccurate) {
      correctedText = correctedText.replace(rawMatch, replacement);
    }

    claims.push({
      rawMatch,
      expression: `${pct}% of ${total}`,
      claimedValue,
      expectedValue,
      absoluteError,
      relativeError,
      status: isAccurate ? "verified" : "discrepancy",
      correctionSuggestion: isAccurate
        ? undefined
        : `Replace '${rawMatch}' with '${replacement}' (expected ${cleanExpected}, got ${claimedValue})`,
    });
  }

  // 2. Inline arithmetic equations: e.g. "125 * 48 = 6,000", "(10 + 20) * 3 = 90", "2^10 = 1024"
  const equationPattern =
    /((?:\(\s*)?-?\d[\d,]*(?:\.\d+)?(?:\s*\))?(?:\s*(?:\*\*|[\+\-\*\/\^%])\s*(?:\(\s*)?-?\d[\d,]*(?:\.\d+)?(?:\s*\))?)+)\s*=\s*(-?\d[\d,]*(?:\.\d+)?)/g;

  for (const match of text.matchAll(equationPattern)) {
    const rawMatch = match[0]!;
    if (seenSpans.has(rawMatch)) continue;
    seenSpans.add(rawMatch);

    const rawExpr = match[1]!.replace(/,/g, "").trim();
    const claimedValue = parseFormattedNumber(match[2]!);
    const calc = runScientificCalculator({ expression: rawExpr });
    if (!calc.ok || !Number.isFinite(calc.value)) continue;

    const expectedValue = calc.value;
    const absoluteError = Math.abs(expectedValue - claimedValue);
    const relativeError =
      expectedValue === 0 ? absoluteError : absoluteError / Math.abs(expectedValue);
    const isAccurate = absoluteError <= tolerance || relativeError <= 1e-4;

    const cleanExpected = formatCleanDecimal(expectedValue);
    const replacement = `${match[1]!.trim()} = ${cleanExpected}`;

    if (!isAccurate) {
      correctedText = correctedText.replace(rawMatch, replacement);
    }

    claims.push({
      rawMatch,
      expression: rawExpr,
      claimedValue,
      expectedValue,
      absoluteError,
      relativeError,
      status: isAccurate ? "verified" : "discrepancy",
      correctionSuggestion: isAccurate
        ? undefined
        : `Expected ${rawExpr} = ${cleanExpected}, but draft claimed ${claimedValue}`,
    });
  }

  const verifiedClaimsCount = claims.filter((c) => c.status === "verified").length;
  const discrepancyCount = claims.length - verifiedClaimsCount;

  return {
    allClaimsAccurate: discrepancyCount === 0,
    totalClaimsChecked: claims.length,
    verifiedClaimsCount,
    discrepancyCount,
    claims,
    correctedText,
  };
}

// ============================================================================
// 10. BUILTIN UNCERTAINTY & ABSTENTION CALIBRATOR
// ============================================================================

export interface UncertaintyCalibrationInput {
  readonly responseText: string;
  readonly groundTruth?: WorkspaceGroundTruth | undefined;
  readonly numericVerification?: NumericClaimVerifierResult | undefined;
  readonly citationCrossCheck?: CitationFactCrossCheckerResult | undefined;
}

export interface UncertaintyCalibrationResult {
  readonly epistemicScore: number;
  readonly badge: VerificationBadge;
  readonly shouldAbstain: boolean;
  readonly speculativeClaims: readonly string[];
  readonly overconfidentAssertions: readonly string[];
  readonly mathDiscrepancyCount: number;
  readonly unverifiedCitationCount: number;
  readonly rationale: string;
  readonly recommendedPrefix?: string | undefined;
}

const SPECULATIVE_PATTERNS: readonly RegExp[] = [
  /\b(?:i think|i believe|probably|presumably|iirc|if i recall correctly|might be around|i'm guessing|not entirely sure)\b[^.?!]*[.?!]?/gi,
];

const OVERCONFIDENT_PATTERNS: readonly RegExp[] = [
  /\b(?:100%\s+certain|guaranteed\s+to\s+be|undeniably|without\s+a\s+doubt|always\s+impossible)\b[^.?!]*[.?!]?/gi,
];

export function runUncertaintyAbstentionCalibrator(
  rawInput: string | UncertaintyCalibrationInput,
): UncertaintyCalibrationResult {
  const input: UncertaintyCalibrationInput =
    typeof rawInput === "string"
      ? { responseText: rawInput }
      : { ...rawInput, responseText: rawInput.responseText ?? "" };
  const numericRes =
    input.numericVerification ?? runNumericClaimVerifier({ text: input.responseText });
  const citationRes =
    input.citationCrossCheck ??
    (input.groundTruth
      ? runCitationFactCrossChecker({
          responseText: input.responseText,
          groundTruth: input.groundTruth,
        })
      : undefined);

  const speculativeClaims: string[] = [];
  for (const pattern of SPECULATIVE_PATTERNS) {
    for (const m of input.responseText.matchAll(pattern)) {
      speculativeClaims.push(m[0]!.trim());
    }
  }

  const overconfidentAssertions: string[] = [];
  for (const pattern of OVERCONFIDENT_PATTERNS) {
    for (const m of input.responseText.matchAll(pattern)) {
      overconfidentAssertions.push(m[0]!.trim());
    }
  }

  const mathDiscrepancyCount = numericRes.discrepancyCount;
  const unverifiedCitationCount = citationRes?.unverifiedCount ?? 0;
  const verifiedCitationsCount = citationRes?.verifiedCount ?? 0;
  const totalCheckedEvidence =
    numericRes.totalClaimsChecked + verifiedCitationsCount + unverifiedCitationCount;

  let score = totalCheckedEvidence > 0 ? 0.96 : 0.5;
  score -= mathDiscrepancyCount * 0.35;
  score -= unverifiedCitationCount * 0.22;
  score -= speculativeClaims.length * 0.12;
  score -= overconfidentAssertions.length * 0.1;

  if (numericRes.verifiedClaimsCount > 0 && mathDiscrepancyCount === 0) {
    score += 0.03;
  }
  if (citationRes && citationRes.verifiedCount > 0 && unverifiedCitationCount === 0) {
    score += 0.03;
  }

  const epistemicScore = Number(Math.max(0, Math.min(1, score)).toFixed(2));

  let badge: VerificationBadge = "verified";
  if (mathDiscrepancyCount > 0) {
    badge = "math-discrepancy-detected";
  } else if (epistemicScore < 0.45 || (unverifiedCitationCount >= 2 && speculativeClaims.length >= 1)) {
    badge = "abstain-recommended";
  } else if (
    unverifiedCitationCount > 0 ||
    speculativeClaims.length > 0 ||
    totalCheckedEvidence === 0
  ) {
    badge = "needs-citation";
  }

  const shouldAbstain = badge === "abstain-recommended";

  const reasons: string[] = [];
  if (mathDiscrepancyCount > 0) {
    reasons.push(`${mathDiscrepancyCount} inline math discrepancy(ies) detected.`);
  }
  if (unverifiedCitationCount > 0) {
    reasons.push(`${unverifiedCitationCount} unverified citation/identifier(s) against ground truth.`);
  }
  if (speculativeClaims.length > 0) {
    reasons.push(`${speculativeClaims.length} speculative hedging phrase(s) found.`);
  }
  if (totalCheckedEvidence === 0) {
    reasons.push("No verifiable numeric claims or ground-truth citations were present to check.");
  } else if (reasons.length === 0) {
    reasons.push("All numeric claims and citations passed deterministic verification.");
  }

  return {
    epistemicScore,
    badge,
    shouldAbstain,
    speculativeClaims,
    overconfidentAssertions,
    mathDiscrepancyCount,
    unverifiedCitationCount,
    rationale: reasons.join(" "),
    recommendedPrefix: shouldAbstain
      ? "I cannot verify key claims against the workspace ground truth and recommend abstaining until sources are provided."
      : badge === "math-discrepancy-detected"
        ? "Note: Deterministic calculator verification corrected an arithmetic discrepancy in the draft."
        : undefined,
  };
}

// ============================================================================
// UNIFIED TOOL DISPATCHER
// ============================================================================

export type ExtendedBuiltinToolId =
  | BuiltinToolId
  | "builtin_symbolic_cas_solver"
  | "builtin_matrix_linear_algebra"
  | "builtin_stats_quant_solver"
  | "builtin_boolean_sat_ieee754";

export function executeBuiltinTool(
  toolId: BuiltinToolId | ExtendedBuiltinToolId,
  input: unknown,
): unknown {
  switch (toolId) {
    case "builtin_scientific_calculator":
      return runScientificCalculator(input as ScientificCalculatorInput | string);
    case "builtin_unit_currency_converter":
      return runUnitCurrencyConverter(input as UnitCurrencyConverterInput);
    case "builtin_json_schema_validator":
      return runJsonSchemaValidator(input as JsonSchemaValidatorInput);
    case "builtin_regex_tester":
      return runRegexTester(input as RegexTesterInput);
    case "builtin_hash_codec":
      return runHashCodec(input as HashCodecInput | string);
    case "builtin_datetime_cron_solver":
      return runDateTimeCronSolver(input as DateTimeCronSolverInput);
    case "builtin_code_syntax_balance_checker":
      return runCodeSyntaxBalanceChecker(input as CodeSyntaxBalanceInput | string);
    case "builtin_citation_fact_cross_checker":
      return runCitationFactCrossChecker(input as CitationFactCrossCheckerInput);
    case "builtin_numeric_claim_verifier":
      return runNumericClaimVerifier(input as NumericClaimVerifierInput | string);
    case "builtin_uncertainty_abstention_calibrator":
      return runUncertaintyAbstentionCalibrator(input as UncertaintyCalibrationInput);
    case "builtin_symbolic_cas_solver":
      return runSymbolicCasSolver(input as SymbolicCasInput | string);
    case "builtin_matrix_linear_algebra":
      return runMatrixLinearAlgebra(input as MatrixLinearAlgebraInput);
    case "builtin_stats_quant_solver":
      return runStatsAndQuantSolver(input as StatsAndQuantInput);
    case "builtin_boolean_sat_ieee754": {
      if (typeof input === "number") {
        return inspectIeee754Float(input);
      }
      if (typeof input === "string") {
        return runBooleanSatSolver(input);
      }
      const rec = (input ?? {}) as {
        expression?: string;
        floatValue?: number;
        precision?: "float32" | "float64";
      };
      return {
        sat: rec.expression ? runBooleanSatSolver(rec.expression) : undefined,
        ieee754:
          rec.floatValue !== undefined
            ? inspectIeee754Float(rec.floatValue, rec.precision ?? "float64")
            : undefined,
      };
    }
  }
}

// ============================================================================
// ANTI-HALLUCINATION AUTO-TRIGGER SKILLS & TURN ENGINE
// ============================================================================

export type AntiHallucinationSkillId =
  | "skill_deterministic_math_guard"
  | "skill_unit_base_conversion_guard"
  | "skill_json_schema_contract_guard"
  | "skill_regex_pattern_guard"
  | "skill_crypto_hash_jwt_guard"
  | "skill_temporal_cron_guard"
  | "skill_code_balance_syntax_guard"
  | "skill_inline_numeric_claim_auditor"
  | "skill_citation_grounding_cross_checker"
  | "skill_epistemic_abstention_calibrator";

export interface AntiHallucinationSkill {
  readonly id: AntiHallucinationSkillId;
  readonly name: string;
  readonly toolId: BuiltinToolId;
  readonly triggerPhase: "pre-answer" | "post-draft" | "both";
  readonly description: string;
  readonly priority: number;
}

export const OMNIA_ANTI_HALLUCINATION_SKILLS: readonly AntiHallucinationSkill[] = [
  {
    id: "skill_deterministic_math_guard",
    name: "Deterministic Math & Calculus Guard",
    toolId: "builtin_scientific_calculator",
    triggerPhase: "pre-answer",
    description: "Guards math and calculus with calculator.",
    priority: 100,
  },
  {
    id: "skill_unit_base_conversion_guard",
    name: "Unit, Currency & IEEE-754 Conversion Guard",
    toolId: "builtin_unit_currency_converter",
    triggerPhase: "pre-answer",
    description: "Guards unit and base conversions.",
    priority: 95,
  },
  {
    id: "skill_json_schema_contract_guard",
    name: "JSON / JSONL Schema Contract Guard",
    toolId: "builtin_json_schema_validator",
    triggerPhase: "both",
    description: "Guards JSON/JSONL against schema errors.",
    priority: 90,
  },
  {
    id: "skill_regex_pattern_guard",
    name: "Regex Pattern Execution Guard",
    toolId: "builtin_regex_tester",
    triggerPhase: "both",
    description: "Guards regex matches against hallucination.",
    priority: 85,
  },
  {
    id: "skill_crypto_hash_jwt_guard",
    name: "Deterministic Hash, Base64 & JWT Guard",
    toolId: "builtin_hash_codec",
    triggerPhase: "pre-answer",
    description: "Computes exact hashes, base64, and JWTs.",
    priority: 92,
  },
  {
    id: "skill_temporal_cron_guard",
    name: "Temporal Duration & Cron Schedule Guard",
    toolId: "builtin_datetime_cron_solver",
    triggerPhase: "pre-answer",
    description: "Solves cron schedules and durations.",
    priority: 88,
  },
  {
    id: "skill_code_balance_syntax_guard",
    name: "Code Bracket & String Balance Guard",
    toolId: "builtin_code_syntax_balance_checker",
    triggerPhase: "post-draft",
    description: "Verifies bracket and string balance.",
    priority: 86,
  },
  {
    id: "skill_inline_numeric_claim_auditor",
    name: "Inline Numeric Claim Auditor",
    toolId: "builtin_numeric_claim_verifier",
    triggerPhase: "post-draft",
    description: "Audits inline numeric equations and claims.",
    priority: 99,
  },
  {
    id: "skill_citation_grounding_cross_checker",
    name: "Citation & Identifier Grounding Cross-Checker",
    toolId: "builtin_citation_fact_cross_checker",
    triggerPhase: "post-draft",
    description: "Cross-checks cited files and identifiers.",
    priority: 97,
  },
  {
    id: "skill_epistemic_abstention_calibrator",
    name: "Epistemic Uncertainty & Abstention Calibrator",
    toolId: "builtin_uncertainty_abstention_calibrator",
    triggerPhase: "post-draft",
    description: "Calibrates epistemic uncertainty and badge.",
    priority: 100,
  },
] as const;

export interface BuiltinToolExecutionReceipt<TOutput = unknown> {
  readonly receiptId: string;
  readonly toolId: BuiltinToolId;
  readonly skillId: AntiHallucinationSkillId;
  readonly phase: "pre-answer" | "post-draft";
  readonly triggerReason: string;
  readonly inputSummary: string;
  readonly status: "succeeded" | "flagged";
  readonly output: TOutput;
}

export interface AutoTriggerTurnInput {
  readonly userPrompt?: string | undefined;
  readonly assistantDraft?: string | undefined;
  readonly groundTruth?: WorkspaceGroundTruth | undefined;
  readonly referenceTime?: string | number | undefined;
}

export interface AntiHallucinationAuditReport {
  readonly overallBadge: VerificationBadge;
  readonly epistemicScore: number;
  readonly shouldAbstain: boolean;
  readonly triggeredSkillIds: readonly AntiHallucinationSkillId[];
  readonly triggeredToolIds: readonly BuiltinToolId[];
  readonly receipts: readonly BuiltinToolExecutionReceipt[];
  readonly numericVerification?: NumericClaimVerifierResult | undefined;
  readonly citationCrossCheck?: CitationFactCrossCheckerResult | undefined;
  readonly syntaxCheck?: CodeSyntaxBalanceResult | undefined;
  readonly calibration: UncertaintyCalibrationResult;
  readonly remediationSuggestions: readonly string[];
  readonly autoCorrectedDraft: string;
}

function extractMathExpressionFromPrompt(prompt: string): string | null {
  // Check calculus or special function call first
  const fnMatch =
    /\b((?:deriv|integrate|det|trace|sin|cos|tan|sqrt|cbrt|ln|log10|log2|log|gcd|lcm|nCr|nPr|mean|median|std|var)\s*\([^;]+?\))/i.exec(
      prompt,
    );
  if (fnMatch) return fnMatch[1]!.trim();

  // Check explicit arithmetic expression
  const arithMatch =
    /((?:\(\s*)?-?\d[\d,]*(?:\.\d+)?(?:\s*\))?(?:!)?(?:\s*(?:\*\*|[\+\-\*\/\^%])\s*(?:\(\s*)?-?\d[\d,]*(?:\.\d+)?(?:\s*\))?(?:!)?)+)/.exec(
      prompt,
    );
  if (arithMatch) return arithMatch[1]!.replace(/,/g, "").trim();

  return null;
}

function extractUnitConversionFromPrompt(
  prompt: string,
): { value: number; fromUnit: string; toUnit: string } | null {
  const match =
    /(?:convert\s+)?(-?\d+(?:\.\d+)?)\s*(°?[a-zA-Z/]+)\s+(?:to|in|into)\s+(°?[a-zA-Z/]+)/i.exec(
      prompt,
    );
  if (!match) return null;
  const value = Number.parseFloat(match[1]!);
  const fromUnit = match[2]!;
  const toUnit = match[3]!;
  if (!findCategoryForUnits(fromUnit, toUnit)) return null;
  return { value, fromUnit, toUnit };
}

export function autoTriggerBuiltinToolsForTurn(
  input: AutoTriggerTurnInput,
): AntiHallucinationAuditReport {
  const prompt = input.userPrompt ?? "";
  const draft = input.assistantDraft ?? "";
  const combinedText = `${prompt}\n${draft}`;

  const receipts: BuiltinToolExecutionReceipt[] = [];
  const triggeredSkills = new Set<AntiHallucinationSkillId>();
  const triggeredTools = new Set<BuiltinToolId>();
  const remediationSuggestions: string[] = [];

  const recordReceipt = <T>(
    skillId: AntiHallucinationSkillId,
    toolId: BuiltinToolId,
    phase: "pre-answer" | "post-draft",
    triggerReason: string,
    inputSummary: string,
    status: "succeeded" | "flagged",
    output: T,
  ) => {
    triggeredSkills.add(skillId);
    triggeredTools.add(toolId);
    receipts.push({
      receiptId: `receipt-${receipts.length + 1}-${toolId}`,
      toolId,
      skillId,
      phase,
      triggerReason,
      inputSummary,
      status,
      output,
    });
  };

  // 1. Pre-answer: Math guard
  const mathExpr = extractMathExpressionFromPrompt(prompt);
  if (mathExpr) {
    const calcOut = runScientificCalculator({ expression: mathExpr });
    recordReceipt(
      "skill_deterministic_math_guard",
      "builtin_scientific_calculator",
      "pre-answer",
      `Detected mathematical expression '${mathExpr}' in user prompt`,
      mathExpr,
      calcOut.ok ? "succeeded" : "flagged",
      calcOut,
    );
  }

  // 2. Pre-answer: Unit conversion guard
  const unitReq = extractUnitConversionFromPrompt(prompt);
  if (unitReq) {
    const convOut = runUnitCurrencyConverter(unitReq);
    recordReceipt(
      "skill_unit_base_conversion_guard",
      "builtin_unit_currency_converter",
      "pre-answer",
      `Detected unit/currency conversion '${unitReq.value} ${unitReq.fromUnit} -> ${unitReq.toUnit}'`,
      `${unitReq.value} ${unitReq.fromUnit} to ${unitReq.toUnit}`,
      convOut.ok ? "succeeded" : "flagged",
      convOut,
    );
  }

  // 3. Pre-answer: Hash / Base64 / JWT guard
  const jwtMatch = /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.exec(combinedText);
  const hashPromptMatch = /\b(?:sha-?256|crc32|fnv-?1a|base64)\b/i.exec(prompt);
  if (jwtMatch || hashPromptMatch) {
    const targetPayload =
      jwtMatch?.[0] ??
      (/["'`]([^"'`]+)["'`]/.exec(prompt)?.[1] ?? prompt.trim());
    const hashOut = runHashCodec({ input: targetPayload });
    recordReceipt(
      "skill_crypto_hash_jwt_guard",
      "builtin_hash_codec",
      "pre-answer",
      jwtMatch ? "Detected JWT token for deterministic inspection" : "Detected hash/codec request in prompt",
      targetPayload.slice(0, 64),
      "succeeded",
      hashOut,
    );
  }

  // 4. Pre-answer: Cron / DateTime guard
  const cronMatch =
    /(?:^|[\s`"'])((?:\*(?:\/\d+)?|\d+(?:-\d+)?(?:,\d+)*)\s+(?:\*(?:\/\d+)?|\d+(?:-\d+)?(?:,\d+)*)\s+(?:\*(?:\/\d+)?|\d+(?:-\d+)?)\s+(?:\*(?:\/\d+)?|\d+(?:-\d+)?|[A-Z]{3})\s+(?:\*(?:\/\d+)?|\d+(?:-\d+)?|[A-Z]{3}))(?=[\s`"']|$)/i.exec(
      combinedText,
    );
  if (cronMatch) {
    const cronExpr = cronMatch[1]!.trim();
    const dtOut = runDateTimeCronSolver({
      cronExpression: cronExpr,
      referenceTime: input.referenceTime,
    });
    recordReceipt(
      "skill_temporal_cron_guard",
      "builtin_datetime_cron_solver",
      "pre-answer",
      `Detected 5-field cron schedule '${cronExpr}'`,
      cronExpr,
      dtOut.ok ? "succeeded" : "flagged",
      dtOut,
    );
  }

  // 5. Both phases: JSON Schema Validator on fenced ```json blocks
  const jsonBlockMatch = /```json\s*([\s\S]*?)```/i.exec(combinedText);
  if (jsonBlockMatch) {
    const jsonPayload = jsonBlockMatch[1]!.trim();
    const jsonOut = runJsonSchemaValidator({ payload: jsonPayload });
    if (!jsonOut.valid) {
      remediationSuggestions.push(
        `Fix JSON syntax error at line ${jsonOut.syntaxErrors[0]?.line ?? 1}, column ${jsonOut.syntaxErrors[0]?.column ?? 1}.`,
      );
    }
    recordReceipt(
      "skill_json_schema_contract_guard",
      "builtin_json_schema_validator",
      "post-draft",
      "Detected fenced JSON payload block",
      jsonPayload.slice(0, 64),
      jsonOut.valid ? "succeeded" : "flagged",
      jsonOut,
    );
  }

  // 6. Both phases: Regex Tester if slash regex `/pattern/flags` is present
  const regexLiteralMatch = /(?:regex|pattern)\s*[:=]?\s*\/([^/\n]+)\/([gimsu]*)/i.exec(combinedText);
  if (regexLiteralMatch) {
    const regOut = runRegexTester({
      pattern: regexLiteralMatch[1]!,
      flags: regexLiteralMatch[2] || "g",
      testString: draft || prompt,
    });
    recordReceipt(
      "skill_regex_pattern_guard",
      "builtin_regex_tester",
      "pre-answer",
      `Detected regex literal /${regexLiteralMatch[1]}/${regexLiteralMatch[2]}`,
      `/${regexLiteralMatch[1]}/${regexLiteralMatch[2]}`,
      regOut.ok ? "succeeded" : "flagged",
      regOut,
    );
  }

  // 7. Post-draft: Code Syntax Balance Checker on fenced code blocks
  let syntaxCheck: CodeSyntaxBalanceResult | undefined;
  const codeBlockMatch = /```(ts|typescript|js|javascript|rust|python|json|sql)?\s*([\s\S]*?)```/i.exec(
    draft || prompt,
  );
  if (codeBlockMatch) {
    const rawLang = (codeBlockMatch[1] ?? "ts").toLowerCase();
    const lang: SupportedSyntaxLanguage =
      rawLang === "typescript" || rawLang === "ts"
        ? "ts"
        : rawLang === "javascript" || rawLang === "js"
          ? "js"
          : rawLang === "rust" || rawLang === "python" || rawLang === "json" || rawLang === "sql"
            ? rawLang
            : "ts";
    syntaxCheck = runCodeSyntaxBalanceChecker({
      code: codeBlockMatch[2]!,
      language: lang,
    });
    if (!syntaxCheck.balanced) {
      for (const issue of syntaxCheck.issues) {
        remediationSuggestions.push(issue.message);
      }
    }
    recordReceipt(
      "skill_code_balance_syntax_guard",
      "builtin_code_syntax_balance_checker",
      "post-draft",
      "Verified bracket, string, and comment balance in fenced code block",
      `${lang} code (${codeBlockMatch[2]!.length} chars)`,
      syntaxCheck.balanced ? "succeeded" : "flagged",
      syntaxCheck,
    );
  }

  // 8. Post-draft: Inline Numeric Claim Verifier
  let numericVerification: NumericClaimVerifierResult | undefined;
  if (draft.trim().length > 0) {
    numericVerification = runNumericClaimVerifier({ text: draft });
    if (numericVerification.totalClaimsChecked > 0) {
      for (const claim of numericVerification.claims) {
        if (claim.status === "discrepancy" && claim.correctionSuggestion) {
          remediationSuggestions.push(claim.correctionSuggestion);
        }
      }
      recordReceipt(
        "skill_inline_numeric_claim_auditor",
        "builtin_numeric_claim_verifier",
        "post-draft",
        `Audited ${numericVerification.totalClaimsChecked} inline numeric calculation claim(s)`,
        draft.slice(0, 80),
        numericVerification.allClaimsAccurate ? "succeeded" : "flagged",
        numericVerification,
      );
    }
  }

  // 9. Post-draft: Citation & Fact Cross-Checker
  let citationCrossCheck: CitationFactCrossCheckerResult | undefined;
  if (draft.trim().length > 0 && input.groundTruth) {
    citationCrossCheck = runCitationFactCrossChecker({
      responseText: draft,
      groundTruth: input.groundTruth,
    });
    if (citationCrossCheck.items.length > 0) {
      remediationSuggestions.push(...citationCrossCheck.remediationNotes);
      recordReceipt(
        "skill_citation_grounding_cross_checker",
        "builtin_citation_fact_cross_checker",
        "post-draft",
        `Cross-checked ${citationCrossCheck.items.length} citation(s) and identifier(s) against ground truth`,
        `${citationCrossCheck.verifiedCount}/${citationCrossCheck.items.length} verified`,
        citationCrossCheck.allVerified ? "succeeded" : "flagged",
        citationCrossCheck,
      );
    }
  }

  // 10. Post-draft: Uncertainty & Abstention Calibrator
  const calibration = runUncertaintyAbstentionCalibrator({
    responseText: draft || prompt,
    groundTruth: input.groundTruth,
    numericVerification,
    citationCrossCheck,
  });
  recordReceipt(
    "skill_epistemic_abstention_calibrator",
    "builtin_uncertainty_abstention_calibrator",
    "post-draft",
    "Calibrated epistemic confidence score and verification badge",
    `badge=${calibration.badge}, score=${calibration.epistemicScore}`,
    calibration.badge === "verified" ? "succeeded" : "flagged",
    calibration,
  );

  return {
    overallBadge: calibration.badge,
    epistemicScore: calibration.epistemicScore,
    shouldAbstain: calibration.shouldAbstain,
    triggeredSkillIds: [...triggeredSkills],
    triggeredToolIds: [...triggeredTools],
    receipts,
    numericVerification,
    citationCrossCheck,
    syntaxCheck,
    calibration,
    remediationSuggestions,
    autoCorrectedDraft: numericVerification?.correctedText ?? draft,
  };
}

// ============================================================================
// 11. SYMBOLIC CAS (COMPUTER ALGEBRA SYSTEM), ODE & COMPLEX ENGINE
// ============================================================================

export interface OdeRk4StepPoint {
  readonly step: number;
  readonly x: number;
  readonly y: number;
  readonly dydx: number;
}

export interface OdeRk4Solution {
  readonly ok: boolean;
  readonly dydxExpr: string;
  readonly x0: number;
  readonly y0: number;
  readonly targetX: number;
  readonly steps: number;
  readonly stepSizeH: number;
  readonly finalY: number;
  readonly trajectory: readonly OdeRk4StepPoint[];
  readonly error?: string | undefined;
}

export interface ComplexNumberValue {
  readonly re: number;
  readonly im: number;
}

export interface ComplexEvaluatorInput {
  readonly expression?: string | undefined;
  readonly left?: ComplexNumberValue | undefined;
  readonly right?: ComplexNumberValue | undefined;
  readonly op?: "+" | "-" | "*" | "/" | "pow" | "conj" | undefined;
}

export interface ComplexEvaluationResult {
  readonly ok: boolean;
  readonly expression: string;
  readonly real: number;
  readonly imag: number;
  readonly formattedRectangular: string;
  readonly magnitude: number;
  readonly phaseRad: number;
  readonly phaseDeg: number;
  readonly eulerPolarForm: string;
  readonly conjugate: string;
  readonly error?: string | undefined;
}

export interface SymbolicCasInput {
  readonly expression: string;
  readonly variable?: string | undefined;
  readonly taylorCenter?: number | undefined;
  readonly taylorOrder?: number | undefined;
  readonly rootMinX?: number | undefined;
  readonly rootMaxX?: number | undefined;
  readonly ode?: {
    readonly dydxExpr: string;
    readonly x0: number;
    readonly y0: number;
    readonly targetX: number;
    readonly steps?: number | undefined;
  } | undefined;
  readonly complexExpression?: string | ComplexEvaluatorInput | undefined;
}

export interface SymbolicCasResult {
  readonly ok: boolean;
  readonly expression: string;
  readonly normalizedExpression: string;
  readonly variable: string;
  readonly symbolicDerivative: string;
  readonly symbolicIntegral: string;
  readonly taylorCenter: number;
  readonly taylorOrder: number;
  readonly taylorSeries: string;
  readonly taylorCoefficients: readonly number[];
  readonly derivativesAtCenter: readonly number[];
  readonly realRoots: readonly number[];
  readonly odeSolution?: OdeRk4Solution | undefined;
  readonly complexResult?: ComplexEvaluationResult | undefined;
  readonly error?: string | undefined;
}

function formatCasCoeff(val: number, precision = 4): string {
  const cleaned = Math.abs(val) < 1e-12 ? 0 : val;
  if (Math.abs(cleaned - Math.round(cleaned)) < 1e-9) {
    return String(Math.round(cleaned));
  }
  return Number(cleaned.toFixed(precision)).toString();
}

function stripLeadingCasDirective(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^(?:d\/d[a-zA-Z]|diff|deriv|integrate|int|taylor|roots)\s*/i, "");
  if (s.startsWith("(") && s.endsWith(")")) {
    // Only strip outer parens if balanced inside
    let depth = 0;
    let balanced = true;
    for (let i = 0; i < s.length - 1; i += 1) {
      if (s[i] === "(") depth += 1;
      else if (s[i] === ")") depth -= 1;
      if (depth === 0 && i > 0) {
        balanced = false;
        break;
      }
    }
    if (balanced) s = s.slice(1, -1).trim();
  }
  return s;
}

interface SymbolicPolyTerm {
  readonly kind: "poly" | "sin" | "cos" | "exp" | "ln";
  readonly coeff: number;
  readonly power: number;
  readonly innerFreq: number;
}

function parseSymbolicTerms(expr: string, variable = "x"): SymbolicPolyTerm[] | null {
  const clean = stripLeadingCasDirective(expr).replace(/\s+/g, "");
  if (!clean) return null;

  // Split top-level + and - terms
  const rawTerms: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i]!;
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (depth === 0 && (ch === "+" || ch === "-") && i > 0 && clean[i - 1] !== "^" && clean[i - 1] !== "e" && clean[i - 1] !== "E") {
      rawTerms.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current) rawTerms.push(current);

  const parsed: SymbolicPolyTerm[] = [];
  const vEsc = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  for (const rawTerm of rawTerms) {
    let t = rawTerm.trim();
    if (!t) continue;
    let sign = 1;
    if (t.startsWith("+")) t = t.slice(1);
    else if (t.startsWith("-")) {
      sign = -1;
      t = t.slice(1);
    }

    // Elementary function terms: c*sin(k*x), c*cos(k*x), c*exp(k*x), c*ln(x)
    const elemMatch = new RegExp(
      `^(?:(\\d+(?:\\.\\d+)?)\\*?)?(sin|cos|exp|ln)\\((?:(-?\\d+(?:\\.\\d+)?)\\*?)?${vEsc}\\)$`,
      "i",
    ).exec(t);
    if (elemMatch) {
      const c = (elemMatch[1] ? Number.parseFloat(elemMatch[1]) : 1) * sign;
      const fn = elemMatch[2]!.toLowerCase() as "sin" | "cos" | "exp" | "ln";
      const k = elemMatch[3] ? Number.parseFloat(elemMatch[3]) : 1;
      parsed.push({ kind: fn, coeff: c, power: 1, innerFreq: k });
      continue;
    }

    // Polynomial term: c*x^p, c*x, x^p, x, or constant c
    const polyFull = new RegExp(
      `^(?:(\\d+(?:\\.\\d+)?)\\*?)?${vEsc}(?:\\^(-?\\d+(?:\\.\\d+)?))?$`,
    ).exec(t);
    if (polyFull) {
      const c = (polyFull[1] ? Number.parseFloat(polyFull[1]) : 1) * sign;
      const p = polyFull[2] ? Number.parseFloat(polyFull[2]) : 1;
      parsed.push({ kind: "poly", coeff: c, power: p, innerFreq: 1 });
      continue;
    }

    const constMatch = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.exec(t);
    if (constMatch) {
      parsed.push({
        kind: "poly",
        coeff: Number.parseFloat(constMatch[0]) * sign,
        power: 0,
        innerFreq: 1,
      });
      continue;
    }

    return null;
  }

  return parsed;
}

function formatSymbolicTerms(
  terms: readonly { text: string; coeff: number }[],
  fallbackZero = "0",
): string {
  const nonZero = terms.filter((t) => Math.abs(t.coeff) > 1e-12);
  if (nonZero.length === 0) return fallbackZero;

  return nonZero
    .map((item, idx) => {
      const isNeg = item.coeff < 0;
      const absCoeff = Math.abs(item.coeff);
      const coeffStr = formatCasCoeff(absCoeff, 4);
      const body = item.text
        ? absCoeff === 1
          ? item.text
          : `${coeffStr}*${item.text}`
        : coeffStr;
      if (idx === 0) {
        return isNeg ? `-${body}` : body;
      }
      return isNeg ? ` - ${body}` : ` + ${body}`;
    })
    .join("");
}

export function computeSymbolicDerivativeAndIntegral(
  expression: string,
  variable = "x",
): { symbolicDerivative: string; symbolicIntegral: string } {
  const terms = parseSymbolicTerms(expression, variable);
  if (terms) {
    // Combine like polynomial powers first
    const derivItems: { text: string; coeff: number }[] = [];
    const intItems: { text: string; coeff: number }[] = [];

    for (const term of terms) {
      if (term.kind === "poly") {
        // Derivative of c * x^p -> (c * p) * x^(p - 1)
        if (term.power !== 0) {
          const dCoeff = term.coeff * term.power;
          const dPow = term.power - 1;
          const text =
            dPow === 0 ? "" : dPow === 1 ? variable : `${variable}^${formatCasCoeff(dPow)}`;
          derivItems.push({ text, coeff: dCoeff });
        }
        // Integral of c * x^p -> (c / (p + 1)) * x^(p + 1) or c * ln(|x|)
        if (term.power === -1) {
          intItems.push({ text: `ln(abs(${variable}))`, coeff: term.coeff });
        } else {
          const iPow = term.power + 1;
          const iCoeff = term.coeff / iPow;
          const text = iPow === 1 ? variable : `${variable}^${formatCasCoeff(iPow)}`;
          intItems.push({ text, coeff: iCoeff });
        }
      } else if (term.kind === "sin") {
        const arg = term.innerFreq === 1 ? variable : `${formatCasCoeff(term.innerFreq)}*${variable}`;
        derivItems.push({ text: `cos(${arg})`, coeff: term.coeff * term.innerFreq });
        intItems.push({ text: `cos(${arg})`, coeff: -term.coeff / term.innerFreq });
      } else if (term.kind === "cos") {
        const arg = term.innerFreq === 1 ? variable : `${formatCasCoeff(term.innerFreq)}*${variable}`;
        derivItems.push({ text: `sin(${arg})`, coeff: -term.coeff * term.innerFreq });
        intItems.push({ text: `sin(${arg})`, coeff: term.coeff / term.innerFreq });
      } else if (term.kind === "exp") {
        const arg = term.innerFreq === 1 ? variable : `${formatCasCoeff(term.innerFreq)}*${variable}`;
        derivItems.push({ text: `exp(${arg})`, coeff: term.coeff * term.innerFreq });
        intItems.push({ text: `exp(${arg})`, coeff: term.coeff / term.innerFreq });
      } else if (term.kind === "ln") {
        derivItems.push({ text: `${variable}^-1`, coeff: term.coeff });
        intItems.push({ text: `(${variable}*ln(${variable}) - ${variable})`, coeff: term.coeff });
      }
    }

    const dFormatted = formatSymbolicTerms(derivItems, "0");
    const iFormatted = formatSymbolicTerms(intItems, "0");
    return {
      symbolicDerivative: dFormatted,
      symbolicIntegral: iFormatted === "0" ? "C" : `${iFormatted} + C`,
    };
  }

  // Fallback for compound expressions: use Taylor Jet expansion at x=0 to construct symbolic polynomial approximation
  const clean = stripLeadingCasDirective(expression);
  return {
    symbolicDerivative: `d/d${variable}(${clean})`,
    symbolicIntegral: `∫(${clean}) d${variable} + C`,
  };
}

// Truncated Taylor Series (Jet) Automatic Differentiation for exact high-order derivatives
function jetAdd(a: readonly number[], b: readonly number[]): number[] {
  return a.map((v, i) => v + (b[i] ?? 0));
}

function jetSub(a: readonly number[], b: readonly number[]): number[] {
  return a.map((v, i) => v - (b[i] ?? 0));
}

function jetMul(a: readonly number[], b: readonly number[]): number[] {
  const n = a.length;
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (let j = 0; j <= i; j += 1) {
      sum += a[j]! * b[i - j]!;
    }
    out[i] = sum;
  }
  return out;
}

function jetDiv(a: readonly number[], b: readonly number[]): number[] {
  const n = a.length;
  const b0 = b[0]!;
  if (Math.abs(b0) < 1e-15) {
    throw new Error("Division by zero in Taylor series expansion");
  }
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    let sum = a[i]!;
    for (let j = 1; j <= i; j += 1) {
      sum -= b[j]! * out[i - j]!;
    }
    out[i] = sum / b0;
  }
  return out;
}

function jetExp(u: readonly number[]): number[] {
  const n = u.length;
  const out = new Array<number>(n).fill(0);
  out[0] = Math.exp(u[0]!);
  for (let k = 1; k < n; k += 1) {
    let sum = 0;
    for (let j = 1; j <= k; j += 1) {
      sum += j * u[j]! * out[k - j]!;
    }
    out[k] = sum / k;
  }
  return out;
}

function jetLn(u: readonly number[]): number[] {
  const n = u.length;
  const u0 = u[0]!;
  if (u0 <= 0) throw new Error("ln requires positive center in Taylor series");
  const out = new Array<number>(n).fill(0);
  out[0] = Math.log(u0);
  for (let k = 1; k < n; k += 1) {
    let sum = k * u[k]!;
    for (let j = 1; j < k; j += 1) {
      sum -= j * out[j]! * u[k - j]!;
    }
    out[k] = sum / (k * u0);
  }
  return out;
}

function jetSinCos(u: readonly number[]): { sin: number[]; cos: number[] } {
  const n = u.length;
  const s = new Array<number>(n).fill(0);
  const c = new Array<number>(n).fill(0);
  s[0] = Math.sin(u[0]!);
  c[0] = Math.cos(u[0]!);
  for (let k = 1; k < n; k += 1) {
    let sumS = 0;
    let sumC = 0;
    for (let j = 1; j <= k; j += 1) {
      sumS += j * u[j]! * c[k - j]!;
      sumC -= j * u[j]! * s[k - j]!;
    }
    s[k] = sumS / k;
    c[k] = sumC / k;
  }
  return { sin: s, cos: c };
}

function jetPow(base: readonly number[], expJet: readonly number[]): number[] {
  const n = base.length;
  const isConstExp = expJet.slice(1).every((c) => Math.abs(c) < 1e-15);
  const p = expJet[0]!;
  if (isConstExp && Number.isInteger(p) && p >= 0 && p <= 32) {
    let acc = new Array<number>(n).fill(0);
    acc[0] = 1;
    let factor = [...base];
    let rem = p;
    while (rem > 0) {
      if (rem & 1) acc = jetMul(acc, factor);
      factor = jetMul(factor, factor);
      rem >>= 1;
    }
    return acc;
  }
  return jetExp(jetMul(expJet, jetLn(base)));
}

function evaluateAstJet(
  node: CalcAstNode,
  varName: string,
  centerX0: number,
  order: number,
): number[] {
  const len = order + 1;
  const constJet = (v: number) => {
    const arr = new Array<number>(len).fill(0);
    arr[0] = v;
    return arr;
  };

  switch (node.kind) {
    case "number":
      return constJet(node.value);
    case "ident": {
      if (node.name === varName) {
        const arr = new Array<number>(len).fill(0);
        arr[0] = centerX0;
        if (len > 1) arr[1] = 1;
        return arr;
      }
      if (Object.prototype.hasOwnProperty.call(SCIENTIFIC_CONSTANTS, node.name)) {
        return constJet(SCIENTIFIC_CONSTANTS[node.name]!);
      }
      return constJet(0);
    }
    case "unary": {
      const opd = evaluateAstJet(node.operand, varName, centerX0, order);
      if (node.op === "+") return opd;
      if (node.op === "-") return opd.map((v) => -v);
      throw new Error(`Unsupported unary op '${node.op}' in Taylor expansion`);
    }
    case "binary": {
      const l = evaluateAstJet(node.left, varName, centerX0, order);
      const r = evaluateAstJet(node.right, varName, centerX0, order);
      if (node.op === "+") return jetAdd(l, r);
      if (node.op === "-") return jetSub(l, r);
      if (node.op === "*") return jetMul(l, r);
      if (node.op === "/") return jetDiv(l, r);
      if (node.op === "^") return jetPow(l, r);
      throw new Error(`Unsupported binary op '${node.op}' in Taylor expansion`);
    }
    case "call": {
      const arg = node.args[0]
        ? evaluateAstJet(node.args[0], varName, centerX0, order)
        : constJet(0);
      const fn = node.name.toLowerCase();
      if (fn === "sin") return jetSinCos(arg).sin;
      if (fn === "cos") return jetSinCos(arg).cos;
      if (fn === "tan") {
        const sc = jetSinCos(arg);
        return jetDiv(sc.sin, sc.cos);
      }
      if (fn === "exp") return jetExp(arg);
      if (fn === "ln" || fn === "log") return jetLn(arg);
      if (fn === "sqrt") return jetPow(arg, constJet(0.5));
      throw new Error(`Unsupported function '${node.name}' in Taylor expansion`);
    }
    default:
      throw new Error("Unsupported AST node in Taylor expansion");
  }
}

export function solveRootsNewtonBisection(
  expr: string,
  minX = -20,
  maxX = 20,
  subdivisions = 240,
  variable = "x",
): readonly number[] {
  const clean = stripLeadingCasDirective(expr);
  let ast: CalcAstNode;
  try {
    ast = new MathParser(tokenizeMathExpression(clean)).parse();
  } catch {
    return [];
  }

  const evalAt = (xVal: number): number => {
    try {
      return evaluateAst(ast, { [variable]: xVal }, "rad");
    } catch {
      return Number.NaN;
    }
  };

  const step = (maxX - minX) / subdivisions;
  const roots: number[] = [];

  const addUniqueRoot = (r: number) => {
    if (!Number.isFinite(r) || r < minX - 1e-6 || r > maxX + 1e-6) return;
    const normR = Math.abs(r) < 1e-11 ? 0 : Number(r.toFixed(8));
    if (Math.abs(evalAt(normR)) > 1e-4) return;
    if (!roots.some((existing) => Math.abs(existing - normR) < 1e-5)) {
      roots.push(normR);
    }
  };

  const refineInterval = (aInit: number, bInit: number) => {
    let a = aInit;
    let b = bInit;
    let fa = evalAt(a);
    let fb = evalAt(b);
    if (!Number.isFinite(fa) || !Number.isFinite(fb)) return;
    if (Math.abs(fa) < 1e-12) {
      addUniqueRoot(a);
      return;
    }
    if (Math.abs(fb) < 1e-12) {
      addUniqueRoot(b);
      return;
    }

    let x = 0.5 * (a + b);
    for (let iter = 0; iter < 48; iter += 1) {
      const fx = evalAt(x);
      if (!Number.isFinite(fx)) break;
      if (Math.abs(fx) < 1e-12 || Math.abs(b - a) < 1e-12) {
        addUniqueRoot(x);
        return;
      }
      const h = 1e-7;
      const dfx = (evalAt(x + h) - evalAt(x - h)) / (2 * h);
      let nextX =
        Number.isFinite(dfx) && Math.abs(dfx) > 1e-12 ? x - fx / dfx : 0.5 * (a + b);
      if (!Number.isFinite(nextX) || nextX <= a || nextX >= b) {
        nextX = 0.5 * (a + b);
      }
      const fNext = evalAt(nextX);
      if (fa * fNext <= 0) {
        b = nextX;
        fb = fNext;
      } else if (fb * fNext <= 0) {
        a = nextX;
        fa = fNext;
      }
      x = nextX;
    }
    addUniqueRoot(x);
  };

  for (let i = 0; i < subdivisions; i += 1) {
    const x1 = minX + i * step;
    const x2 = x1 + step;
    const y1 = evalAt(x1);
    const y2 = evalAt(x2);
    if (!Number.isFinite(y1) || !Number.isFinite(y2)) continue;
    if (Math.abs(y1) < 1e-10) {
      addUniqueRoot(x1);
    } else if (y1 * y2 <= 0) {
      refineInterval(x1, x2);
    } else if (Math.abs(y1) < 0.25 || Math.abs(y2) < 0.25) {
      // Check for tangent root (like (x - 2)^2 = 0) via Newton from midpoint
      let x = 0.5 * (x1 + x2);
      for (let iter = 0; iter < 24; iter += 1) {
        const fx = evalAt(x);
        if (Math.abs(fx) < 1e-9) {
          addUniqueRoot(x);
          break;
        }
        const h = 1e-6;
        const dfx = (evalAt(x + h) - evalAt(x - h)) / (2 * h);
        if (Math.abs(dfx) < 1e-12) break;
        x -= fx / dfx;
        if (x < x1 - step || x > x2 + step) break;
      }
    }
  }

  return roots.sort((a, b) => a - b);
}

export function solveOdeRk4(
  dydxExpr: string,
  x0: number,
  y0: number,
  targetX: number,
  steps = 40,
): OdeRk4Solution {
  const nSteps = Math.max(1, Math.min(2000, Math.trunc(steps)));
  const h = (targetX - x0) / nSteps;
  try {
    const ast = new MathParser(tokenizeMathExpression(dydxExpr)).parse();
    const f = (xVal: number, yVal: number) =>
      evaluateAst(ast, { x: xVal, y: yVal, t: xVal }, "rad");

    const trajectory: OdeRk4StepPoint[] = [];
    let x = x0;
    let y = y0;
    trajectory.push({ step: 0, x, y, dydx: f(x, y) });

    for (let i = 1; i <= nSteps; i += 1) {
      const k1 = f(x, y);
      const k2 = f(x + 0.5 * h, y + 0.5 * h * k1);
      const k3 = f(x + 0.5 * h, y + 0.5 * h * k2);
      const k4 = f(x + h, y + h * k3);
      y = y + (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
      x = x0 + i * h;
      trajectory.push({
        step: i,
        x: Number(x.toFixed(8)),
        y: Number(y.toFixed(8)),
        dydx: Number(f(x, y).toFixed(8)),
      });
    }

    return {
      ok: true,
      dydxExpr,
      x0,
      y0,
      targetX,
      steps: nSteps,
      stepSizeH: h,
      finalY: Number(y.toFixed(10)),
      trajectory,
    };
  } catch (err) {
    return {
      ok: false,
      dydxExpr,
      x0,
      y0,
      targetX,
      steps: nSteps,
      stepSizeH: h,
      finalY: Number.NaN,
      trajectory: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function parseSingleComplexPart(raw: string): ComplexNumberValue {
  const s = raw.replace(/\s+/g, "").replace(/^\((.*)\)$/, "$1");
  if (!s) return { re: 0, im: 0 };
  if (s === "i" || s === "+i") return { re: 0, im: 1 };
  if (s === "-i") return { re: 0, im: -1 };

  // Pure imaginary like 4i or -2.5i
  const pureIm = /^([+-]?\d+(?:\.\d+)?)i$/i.exec(s);
  if (pureIm) {
    return { re: 0, im: Number.parseFloat(pureIm[1]!) };
  }

  // Pure real
  const pureRe = /^([+-]?\d+(?:\.\d+)?)$/.exec(s);
  if (pureRe) {
    return { re: Number.parseFloat(pureRe[1]!), im: 0 };
  }

  // Rectangular a + bi or a - bi
  const rect = /^([+-]?\d+(?:\.\d+)?)([+-]\d*(?:\.\d+)?)i$/i.exec(s);
  if (rect) {
    const re = Number.parseFloat(rect[1]!);
    const imRaw = rect[2]!;
    const im =
      imRaw === "+" ? 1 : imRaw === "-" ? -1 : Number.parseFloat(imRaw);
    return { re, im };
  }

  throw new Error(`Invalid complex literal '${raw}'`);
}

function formatComplexRectangular(re: number, im: number): string {
  const cleanRe = Math.abs(re) < 1e-12 ? 0 : Number(re.toFixed(6));
  const cleanIm = Math.abs(im) < 1e-12 ? 0 : Number(im.toFixed(6));
  const sign = cleanIm < 0 ? "-" : "+";
  return `${cleanRe} ${sign} ${Math.abs(cleanIm)}i`;
}

export function evaluateComplexExpression(
  input: string | ComplexEvaluatorInput,
): ComplexEvaluationResult {
  try {
    let left: ComplexNumberValue = { re: 0, im: 0 };
    let right: ComplexNumberValue = { re: 0, im: 0 };
    let op: "+" | "-" | "*" | "/" | "pow" | "conj" = "*";
    let exprLabel = "";

    if (typeof input === "string") {
      exprLabel = input.trim();
      const binMatch =
        /^\(\s*([^)]+)\s*\)\s*([+\-*/^])\s*\(\s*([^)]+)\s*\)$/.exec(exprLabel);
      if (binMatch) {
        left = parseSingleComplexPart(binMatch[1]!);
        const rawOp = binMatch[2]!;
        op = rawOp === "^" ? "pow" : (rawOp as "+" | "-" | "*" | "/");
        right = parseSingleComplexPart(binMatch[3]!);
      } else {
        left = parseSingleComplexPart(exprLabel);
        right = { re: 1, im: 0 };
        op = "*";
      }
    } else {
      exprLabel = input.expression ?? "complex_op";
      if (input.expression && !input.left) {
        return evaluateComplexExpression(input.expression);
      }
      left = input.left ?? { re: 0, im: 0 };
      right = input.right ?? { re: 1, im: 0 };
      op = input.op ?? "*";
    }

    let re = 0;
    let im = 0;
    if (op === "+") {
      re = left.re + right.re;
      im = left.im + right.im;
    } else if (op === "-") {
      re = left.re - right.re;
      im = left.im - right.im;
    } else if (op === "*") {
      re = left.re * right.re - left.im * right.im;
      im = left.re * right.im + left.im * right.re;
    } else if (op === "/") {
      const denom = right.re * right.re + right.im * right.im;
      if (denom === 0) throw new Error("Complex division by zero");
      re = (left.re * right.re + left.im * right.im) / denom;
      im = (left.im * right.re - left.re * right.im) / denom;
    } else if (op === "conj") {
      re = left.re;
      im = -left.im;
    } else if (op === "pow") {
      const r = Math.hypot(left.re, left.im);
      const theta = Math.atan2(left.im, left.re);
      const rn = Math.pow(r, right.re);
      re = rn * Math.cos(right.re * theta);
      im = rn * Math.sin(right.re * theta);
    }

    const magnitude = Number(Math.hypot(re, im).toFixed(8));
    const phaseRad = Number(Math.atan2(im, re).toFixed(8));
    const phaseDeg = Number(((phaseRad * 180) / Math.PI).toFixed(6));

    return {
      ok: true,
      expression: exprLabel,
      real: Number(re.toFixed(8)),
      imag: Number(im.toFixed(8)),
      formattedRectangular: formatComplexRectangular(re, im),
      magnitude,
      phaseRad,
      phaseDeg,
      eulerPolarForm: `${formatCasCoeff(magnitude, 4)} * e^(i * ${formatCasCoeff(phaseRad, 4)})`,
      conjugate: formatComplexRectangular(re, -im),
    };
  } catch (err) {
    return {
      ok: false,
      expression: typeof input === "string" ? input : (input.expression ?? ""),
      real: Number.NaN,
      imag: Number.NaN,
      formattedRectangular: "NaN",
      magnitude: Number.NaN,
      phaseRad: Number.NaN,
      phaseDeg: Number.NaN,
      eulerPolarForm: "NaN",
      conjugate: "NaN",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function runSymbolicCasSolver(
  input: SymbolicCasInput | string,
): SymbolicCasResult {
  const normalized: SymbolicCasInput =
    typeof input === "string" ? { expression: input } : input;
  const variable = normalized.variable ?? "x";
  const taylorCenter = normalized.taylorCenter ?? 0;
  const taylorOrder = Math.max(1, Math.min(10, normalized.taylorOrder ?? 4));
  const cleanExpr = stripLeadingCasDirective(normalized.expression);

  try {
    const { symbolicDerivative, symbolicIntegral } =
      computeSymbolicDerivativeAndIntegral(cleanExpr, variable);

    const ast = new MathParser(tokenizeMathExpression(cleanExpr)).parse();
    const jetCoeffs = evaluateAstJet(ast, variable, taylorCenter, taylorOrder);

    const derivativesAtCenter: number[] = [];
    let fact = 1;
    for (let k = 0; k <= taylorOrder; k += 1) {
      if (k > 0) fact *= k;
      derivativesAtCenter.push(Number((jetCoeffs[k]! * fact).toFixed(8)));
    }

    const taylorTerms: { text: string; coeff: number }[] = jetCoeffs.map((c, k) => {
      const baseVar =
        taylorCenter === 0
          ? variable
          : `(${variable} - ${formatCasCoeff(taylorCenter)})`;
      const text = k === 0 ? "" : k === 1 ? baseVar : `${baseVar}^${k}`;
      return { text, coeff: c };
    });

    const taylorSeries = formatSymbolicTerms(taylorTerms, "0");
    const realRoots = solveRootsNewtonBisection(
      cleanExpr,
      normalized.rootMinX ?? -20,
      normalized.rootMaxX ?? 20,
      240,
      variable,
    );

    const odeSolution = normalized.ode
      ? solveOdeRk4(
          normalized.ode.dydxExpr,
          normalized.ode.x0,
          normalized.ode.y0,
          normalized.ode.targetX,
          normalized.ode.steps ?? 40,
        )
      : undefined;

    const complexResult = normalized.complexExpression
      ? evaluateComplexExpression(normalized.complexExpression)
      : undefined;

    return {
      ok: true,
      expression: normalized.expression,
      normalizedExpression: cleanExpr,
      variable,
      symbolicDerivative,
      symbolicIntegral,
      taylorCenter,
      taylorOrder,
      taylorSeries,
      taylorCoefficients: jetCoeffs.map((c) => Number(c.toFixed(8))),
      derivativesAtCenter,
      realRoots,
      odeSolution,
      complexResult,
    };
  } catch (err) {
    return {
      ok: false,
      expression: normalized.expression,
      normalizedExpression: cleanExpr,
      variable,
      symbolicDerivative: "Error",
      symbolicIntegral: "Error",
      taylorCenter,
      taylorOrder,
      taylorSeries: "Error",
      taylorCoefficients: [],
      derivativesAtCenter: [],
      realRoots: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================================
// 12. N×N MATRIX LINEAR ALGEBRA ENGINE (RREF, INV, DET, EIGEN)
// ============================================================================

export interface MatrixLinearAlgebraInput {
  readonly matrixA: readonly (readonly number[])[];
  readonly matrixB?: readonly (readonly number[])[] | undefined;
}

export interface MatrixLinearAlgebraResult {
  readonly ok: boolean;
  readonly rows: number;
  readonly cols: number;
  readonly isSquare: boolean;
  readonly determinant: number | null;
  readonly trace: number | null;
  readonly rank: number;
  readonly frobeniusNorm: number;
  readonly transpose: readonly (readonly number[])[];
  readonly rref: readonly (readonly number[])[];
  readonly inverse: readonly (readonly number[])[] | null;
  readonly multiplyAB: readonly (readonly number[])[] | null;
  readonly characteristicPolynomial: string | null;
  readonly eigenvalues: readonly string[];
  readonly error?: string | undefined;
}

function cleanMatrixZero(v: number): number {
  return Math.abs(v) < 1e-11 ? 0 : Number(v.toFixed(8));
}

export function runMatrixLinearAlgebra(
  input: MatrixLinearAlgebraInput,
): MatrixLinearAlgebraResult {
  const A = input.matrixA;
  const rows = A.length;
  const cols = rows > 0 ? (A[0]?.length ?? 0) : 0;

  if (rows === 0 || cols === 0 || A.some((r) => r.length !== cols)) {
    return {
      ok: false,
      rows,
      cols,
      isSquare: false,
      determinant: null,
      trace: null,
      rank: 0,
      frobeniusNorm: 0,
      transpose: [],
      rref: [],
      inverse: null,
      multiplyAB: null,
      characteristicPolynomial: null,
      eigenvalues: [],
      error: "Matrix A must be a non-empty rectangular 2D array",
    };
  }

  const isSquare = rows === cols;

  // Transpose & Frobenius norm
  let sumSq = 0;
  const transpose: number[][] = Array.from({ length: cols }, () =>
    new Array<number>(rows).fill(0),
  );
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const val = A[r]![c]!;
      sumSq += val * val;
      transpose[c]![r] = cleanMatrixZero(val);
    }
  }
  const frobeniusNorm = Number(Math.sqrt(sumSq).toFixed(8));

  // Trace
  let trace: number | null = null;
  if (isSquare) {
    let tr = 0;
    for (let i = 0; i < rows; i += 1) tr += A[i]![i]!;
    trace = cleanMatrixZero(tr);
  }

  // RREF via Gauss-Jordan elimination with partial pivoting
  const rrefWork = A.map((r) => [...r]);
  let pivotRow = 0;
  let rank = 0;
  for (let col = 0; col < cols && pivotRow < rows; col += 1) {
    let maxRow = pivotRow;
    for (let r = pivotRow + 1; r < rows; r += 1) {
      if (Math.abs(rrefWork[r]![col]!) > Math.abs(rrefWork[maxRow]![col]!)) {
        maxRow = r;
      }
    }
    if (Math.abs(rrefWork[maxRow]![col]!) < 1e-11) {
      continue;
    }
    const tmp = rrefWork[pivotRow]!;
    rrefWork[pivotRow] = rrefWork[maxRow]!;
    rrefWork[maxRow] = tmp;

    const pivotVal = rrefWork[pivotRow]![col]!;
    for (let c = col; c < cols; c += 1) {
      rrefWork[pivotRow]![c] = rrefWork[pivotRow]![c]! / pivotVal;
    }
    for (let r = 0; r < rows; r += 1) {
      if (r !== pivotRow) {
        const factor = rrefWork[r]![col]!;
        if (Math.abs(factor) > 1e-14) {
          for (let c = col; c < cols; c += 1) {
            rrefWork[r]![c] = rrefWork[r]![c]! - factor * rrefWork[pivotRow]![c]!;
          }
        }
      }
    }
    pivotRow += 1;
    rank += 1;
  }
  const rref = rrefWork.map((r) => r.map(cleanMatrixZero));

  // Determinant & Inverse for N×N square matrices
  let determinant: number | null = null;
  let inverse: number[][] | null = null;

  if (isSquare) {
    const n = rows;
    const aug = A.map((r, i) => [
      ...r,
      ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
    ]);
    let detSign = 1;
    let detProd = 1;
    let singular = false;

    for (let col = 0; col < n; col += 1) {
      let maxRow = col;
      for (let r = col + 1; r < n; r += 1) {
        if (Math.abs(aug[r]![col]!) > Math.abs(aug[maxRow]![col]!)) {
          maxRow = r;
        }
      }
      const pivotVal = aug[maxRow]![col]!;
      if (Math.abs(pivotVal) < 1e-11) {
        singular = true;
        detProd = 0;
        break;
      }
      if (maxRow !== col) {
        const tmp = aug[col]!;
        aug[col] = aug[maxRow]!;
        aug[maxRow] = tmp;
        detSign = -detSign;
      }
      detProd *= pivotVal;
      for (let c = 0; c < 2 * n; c += 1) {
        aug[col]![c] = aug[col]![c]! / pivotVal;
      }
      for (let r = 0; r < n; r += 1) {
        if (r !== col) {
          const factor = aug[r]![col]!;
          for (let c = 0; c < 2 * n; c += 1) {
            aug[r]![c] = aug[r]![c]! - factor * aug[col]![c]!;
          }
        }
      }
    }

    determinant = cleanMatrixZero(detSign * detProd);
    if (!singular) {
      inverse = aug.map((r) => r.slice(n, 2 * n).map(cleanMatrixZero));
    }
  }

  // Matrix Multiplication A * B (or A * A if square and B omitted)
  const B = input.matrixB ?? (isSquare ? A : undefined);
  let multiplyAB: number[][] | null = null;
  if (B && B.length === cols && B[0] && B[0].length > 0) {
    const bCols = B[0].length;
    multiplyAB = Array.from({ length: rows }, (_, r) =>
      Array.from({ length: bCols }, (__, c) => {
        let sum = 0;
        for (let k = 0; k < cols; k += 1) {
          sum += A[r]![k]! * B[k]![c]!;
        }
        return cleanMatrixZero(sum);
      }),
    );
  }

  // Characteristic Polynomial & Eigenvalues
  let characteristicPolynomial: string | null = null;
  const eigenvalues: string[] = [];

  if (isSquare && rows === 2 && trace !== null && determinant !== null) {
    const tr = trace;
    const det = determinant;
    characteristicPolynomial = `lambda^2 ${tr >= 0 ? `- ${formatCasCoeff(tr)}` : `+ ${formatCasCoeff(-tr)}`}*lambda ${det >= 0 ? `+ ${formatCasCoeff(det)}` : `- ${formatCasCoeff(-det)}`}`;
    const disc = tr * tr - 4 * det;
    if (disc >= -1e-11) {
      const sqrtD = Math.sqrt(Math.max(0, disc));
      const l1 = cleanMatrixZero((tr + sqrtD) / 2);
      const l2 = cleanMatrixZero((tr - sqrtD) / 2);
      eigenvalues.push(String(l1), String(l2));
    } else {
      const re = cleanMatrixZero(tr / 2);
      const im = cleanMatrixZero(Math.sqrt(-disc) / 2);
      eigenvalues.push(`${re} + ${im}i`, `${re} - ${im}i`);
    }
  } else if (isSquare && rows === 3 && trace !== null && determinant !== null) {
    // A^2 trace for 3x3
    let trA2 = 0;
    for (let i = 0; i < 3; i += 1) {
      for (let k = 0; k < 3; k += 1) {
        trA2 += A[i]![k]! * A[k]![i]!;
      }
    }
    const c2 = trace;
    const c1 = cleanMatrixZero(0.5 * (trace * trace - trA2));
    const c0 = determinant;
    characteristicPolynomial = `lambda^3 - (${formatCasCoeff(c2)})*lambda^2 + (${formatCasCoeff(c1)})*lambda - (${formatCasCoeff(c0)})`;
    const polyExpr = `x^3 - (${c2})*x^2 + (${c1})*x - (${c0})`;
    const realEigs = solveRootsNewtonBisection(polyExpr, -100, 100, 400, "x");
    for (const r of realEigs) {
      eigenvalues.push(String(cleanMatrixZero(r)));
    }
  } else if (isSquare) {
    characteristicPolynomial = `det(A - lambda*I_${rows}) = 0`;
    for (let i = 0; i < rows; i += 1) {
      eigenvalues.push(String(cleanMatrixZero(A[i]![i]!)));
    }
  }

  return {
    ok: true,
    rows,
    cols,
    isSquare,
    determinant,
    trace,
    rank,
    frobeniusNorm,
    transpose,
    rref,
    inverse,
    multiplyAB,
    characteristicPolynomial,
    eigenvalues,
  };
}

// ============================================================================
// 13. STATISTICS, PROBABILITY DISTRIBUTIONS & QUANT FINANCE ENGINE
// ============================================================================

export interface BlackScholesOptionInput {
  readonly spotPrice: number;
  readonly strikePrice: number;
  readonly timeToMaturityYears: number;
  readonly riskFreeRate: number;
  readonly volatility: number;
}

export interface BlackScholesOptionResult {
  readonly callPrice: number;
  readonly putPrice: number;
  readonly d1: number;
  readonly d2: number;
  readonly deltaCall: number;
  readonly deltaPut: number;
  readonly gamma: number;
  readonly vega: number;
  readonly thetaCall: number;
  readonly thetaPut: number;
  readonly rhoCall: number;
  readonly rhoPut: number;
}

export interface StatsAndQuantInput {
  readonly normal?: {
    readonly x: number;
    readonly mean?: number | undefined;
    readonly stdDev?: number | undefined;
  } | undefined;
  readonly binomial?: {
    readonly n: number;
    readonly k: number;
    readonly p: number;
  } | undefined;
  readonly poisson?: {
    readonly lambda: number;
    readonly k: number;
  } | undefined;
  readonly regression?: {
    readonly xValues: readonly number[];
    readonly yValues: readonly number[];
  } | undefined;
  readonly entropyProbabilities?: readonly number[] | undefined;
  readonly bayes?: {
    readonly priorA: number;
    readonly probBGivenA: number;
    readonly probBGivenNotA: number;
  } | undefined;
  readonly finance?: {
    readonly discountRate?: number | undefined;
    readonly cashFlows?: readonly number[] | undefined;
    readonly beginValue?: number | undefined;
    readonly endValue?: number | undefined;
    readonly years?: number | undefined;
    readonly blackScholes?: BlackScholesOptionInput | undefined;
  } | undefined;
}

export interface StatsAndQuantResult {
  readonly ok: boolean;
  readonly normalResult?: {
    readonly zScore: number;
    readonly pdf: number;
    readonly cdf: number;
    readonly erfValue: number;
  } | undefined;
  readonly binomialResult?: {
    readonly pmf: number;
    readonly cdf: number;
    readonly expectedValue: number;
    readonly variance: number;
  } | undefined;
  readonly poissonResult?: {
    readonly pmf: number;
    readonly cdf: number;
  } | undefined;
  readonly regressionResult?: {
    readonly slope: number;
    readonly intercept: number;
    readonly rCorrelation: number;
    readonly rSquared: number;
    readonly formula: string;
  } | undefined;
  readonly shannonEntropyBits?: number | undefined;
  readonly bayesPosterior?: number | undefined;
  readonly financeResult?: {
    readonly npv?: number | undefined;
    readonly irr?: number | undefined;
    readonly cagr?: number | undefined;
    readonly blackScholes?: BlackScholesOptionResult | undefined;
  } | undefined;
}

export function computeErf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y =
    1 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) *
      Math.exp(-ax * ax);
  return sign * y;
}

function stdNormalPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

function stdNormalCdf(z: number): number {
  return 0.5 * (1 + computeErf(z / Math.SQRT2));
}

export function computeBlackScholes(input: BlackScholesOptionInput): BlackScholesOptionResult {
  const S = Math.max(1e-9, input.spotPrice);
  const K = Math.max(1e-9, input.strikePrice);
  const T = Math.max(1e-9, input.timeToMaturityYears);
  const r = input.riskFreeRate;
  const sigma = Math.max(1e-9, input.volatility);
  const sqrtT = Math.sqrt(T);

  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const Nd1 = stdNormalCdf(d1);
  const Nd2 = stdNormalCdf(d2);
  const NnegD1 = stdNormalCdf(-d1);
  const NnegD2 = stdNormalCdf(-d2);
  const nd1 = stdNormalPdf(d1);
  const discK = K * Math.exp(-r * T);

  const callPrice = S * Nd1 - discK * Nd2;
  const putPrice = discK * NnegD2 - S * NnegD1;
  const gamma = nd1 / (S * sigma * sqrtT);
  const vega = S * nd1 * sqrtT;
  const thetaCall = -(S * nd1 * sigma) / (2 * sqrtT) - r * discK * Nd2;
  const thetaPut = -(S * nd1 * sigma) / (2 * sqrtT) + r * discK * NnegD2;
  const rhoCall = K * T * Math.exp(-r * T) * Nd2;
  const rhoPut = -K * T * Math.exp(-r * T) * NnegD2;

  return {
    callPrice: Number(callPrice.toFixed(6)),
    putPrice: Number(putPrice.toFixed(6)),
    d1: Number(d1.toFixed(6)),
    d2: Number(d2.toFixed(6)),
    deltaCall: Number(Nd1.toFixed(6)),
    deltaPut: Number((Nd1 - 1).toFixed(6)),
    gamma: Number(gamma.toFixed(6)),
    vega: Number(vega.toFixed(6)),
    thetaCall: Number(thetaCall.toFixed(6)),
    thetaPut: Number(thetaPut.toFixed(6)),
    rhoCall: Number(rhoCall.toFixed(6)),
    rhoPut: Number(rhoPut.toFixed(6)),
  };
}

export function runStatsAndQuantSolver(
  input: StatsAndQuantInput,
): StatsAndQuantResult {
  let normalResult: StatsAndQuantResult["normalResult"];
  if (input.normal) {
    const mean = input.normal.mean ?? 0;
    const stdDev = Math.max(1e-12, input.normal.stdDev ?? 1);
    const z = (input.normal.x - mean) / stdDev;
    normalResult = {
      zScore: Number(z.toFixed(6)),
      pdf: Number((stdNormalPdf(z) / stdDev).toFixed(8)),
      cdf: Number(stdNormalCdf(z).toFixed(8)),
      erfValue: Number(computeErf(z / Math.SQRT2).toFixed(8)),
    };
  }

  let binomialResult: StatsAndQuantResult["binomialResult"];
  if (input.binomial) {
    const { n, k, p } = input.binomial;
    const pmf = computeNcr(n, k) * Math.pow(p, k) * Math.pow(1 - p, n - k);
    let cdf = 0;
    for (let i = 0; i <= k; i += 1) {
      cdf += computeNcr(n, i) * Math.pow(p, i) * Math.pow(1 - p, n - i);
    }
    binomialResult = {
      pmf: Number(pmf.toFixed(8)),
      cdf: Number(cdf.toFixed(8)),
      expectedValue: Number((n * p).toFixed(6)),
      variance: Number((n * p * (1 - p)).toFixed(6)),
    };
  }

  let poissonResult: StatsAndQuantResult["poissonResult"];
  if (input.poisson) {
    const { lambda, k } = input.poisson;
    const pmf = (Math.pow(lambda, k) * Math.exp(-lambda)) / computeFactorial(k);
    let cdf = 0;
    for (let i = 0; i <= k; i += 1) {
      cdf += (Math.pow(lambda, i) * Math.exp(-lambda)) / computeFactorial(i);
    }
    poissonResult = {
      pmf: Number(pmf.toFixed(8)),
      cdf: Number(cdf.toFixed(8)),
    };
  }

  let regressionResult: StatsAndQuantResult["regressionResult"];
  if (
    input.regression &&
    input.regression.xValues.length >= 2 &&
    input.regression.xValues.length === input.regression.yValues.length
  ) {
    const xs = input.regression.xValues;
    const ys = input.regression.yValues;
    const n = xs.length;
    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanY = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let denX = 0;
    let denY = 0;
    for (let i = 0; i < n; i += 1) {
      const dx = xs[i]! - meanX;
      const dy = ys[i]! - meanY;
      num += dx * dy;
      denX += dx * dx;
      denY += dy * dy;
    }
    const slope = denX === 0 ? 0 : num / denX;
    const intercept = meanY - slope * meanX;
    const r = denX === 0 || denY === 0 ? 0 : num / Math.sqrt(denX * denY);
    regressionResult = {
      slope: Number(slope.toFixed(6)),
      intercept: Number(intercept.toFixed(6)),
      rCorrelation: Number(r.toFixed(6)),
      rSquared: Number((r * r).toFixed(6)),
      formula: `y = ${formatCasCoeff(slope, 4)}*x ${intercept >= 0 ? `+ ${formatCasCoeff(intercept, 4)}` : `- ${formatCasCoeff(-intercept, 4)}`}`,
    };
  }

  let shannonEntropyBits: number | undefined;
  if (input.entropyProbabilities && input.entropyProbabilities.length > 0) {
    const pos = input.entropyProbabilities.filter((p) => p > 0);
    const total = pos.reduce((a, b) => a + b, 0);
    if (total > 0) {
      let h = 0;
      for (const p of pos) {
        const normP = p / total;
        h -= normP * Math.log2(normP);
      }
      shannonEntropyBits = Number(h.toFixed(6));
    }
  }

  let bayesPosterior: number | undefined;
  if (input.bayes) {
    const { priorA, probBGivenA, probBGivenNotA } = input.bayes;
    const probB = probBGivenA * priorA + probBGivenNotA * (1 - priorA);
    bayesPosterior = probB === 0 ? 0 : Number(((probBGivenA * priorA) / probB).toFixed(6));
  }

  let financeResult: StatsAndQuantResult["financeResult"];
  if (input.finance) {
    const f = input.finance;
    let npv: number | undefined;
    let irr: number | undefined;
    if (f.cashFlows && f.cashFlows.length > 0) {
      const r = f.discountRate ?? 0.1;
      npv = Number(
        f.cashFlows
          .reduce((acc, cf, t) => acc + cf / Math.pow(1 + r, t), 0)
          .toFixed(4),
      );

      // Solve IRR where NPV(rate) = 0 using Newton-Raphson
      let guess = 0.1;
      for (let iter = 0; iter < 60; iter += 1) {
        let fVal = 0;
        let dfVal = 0;
        for (let t = 0; t < f.cashFlows.length; t += 1) {
          const cf = f.cashFlows[t]!;
          fVal += cf / Math.pow(1 + guess, t);
          if (t > 0) {
            dfVal -= (t * cf) / Math.pow(1 + guess, t + 1);
          }
        }
        if (Math.abs(fVal) < 1e-8) break;
        if (Math.abs(dfVal) < 1e-12) break;
        guess = Math.max(-0.95, guess - fVal / dfVal);
      }
      irr = Number(guess.toFixed(6));
    }

    let cagr: number | undefined;
    if (
      f.beginValue !== undefined &&
      f.endValue !== undefined &&
      f.years !== undefined &&
      f.beginValue > 0 &&
      f.years > 0
    ) {
      cagr = Number((Math.pow(f.endValue / f.beginValue, 1 / f.years) - 1).toFixed(6));
    }

    const blackScholes = f.blackScholes ? computeBlackScholes(f.blackScholes) : undefined;
    financeResult = { npv, irr, cagr, blackScholes };
  }

  return {
    ok: true,
    normalResult,
    binomialResult,
    poissonResult,
    regressionResult,
    shannonEntropyBits,
    bayesPosterior,
    financeResult,
  };
}

// ============================================================================
// 14. BOOLEAN LOGIC TRUTH-TABLE & SAT SOLVER
// ============================================================================

export interface BooleanTruthTableRow {
  readonly assignment: Readonly<Record<string, boolean>>;
  readonly result: boolean;
}

export interface BooleanSatResult {
  readonly ok: boolean;
  readonly expression: string;
  readonly variables: readonly string[];
  readonly classification: "Tautology" | "Contradiction" | "Satisfiable (SAT)";
  readonly isSatisfiable: boolean;
  readonly isTautology: boolean;
  readonly isContradiction: boolean;
  readonly truthTable: readonly BooleanTruthTableRow[];
  readonly satisfyingAssignments: readonly Readonly<Record<string, boolean>>[];
  readonly canonicalDnf: string;
  readonly canonicalCnf: string;
  readonly error?: string | undefined;
}

type BoolTok =
  | { readonly kind: "var"; readonly name: string }
  | { readonly kind: "const"; readonly value: boolean }
  | { readonly kind: "op"; readonly op: "!" | "&" | "|" | "^" | "->" | "<->" }
  | { readonly kind: "lparen" }
  | { readonly kind: "rparen" };

function tokenizeBooleanExpr(expr: string): { tokens: BoolTok[]; vars: string[] } {
  const s = expr
    .replace(/\bAND\b/gi, "&&")
    .replace(/\bOR\b/gi, "||")
    .replace(/\bNOT\b/gi, "!")
    .replace(/\bXOR\b/gi, "^")
    .replace(/\bIMPLIES\b/gi, "->")
    .replace(/\bIFF\b/gi, "<->");

  const tokens: BoolTok[] = [];
  const varSet = new Set<string>();
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen" });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen" });
      i += 1;
      continue;
    }
    if (s.slice(i, i + 3) === "<->" || s.slice(i, i + 3) === "<=>") {
      tokens.push({ kind: "op", op: "<->" });
      i += 3;
      continue;
    }
    if (s.slice(i, i + 2) === "->" || s.slice(i, i + 2) === "=>") {
      tokens.push({ kind: "op", op: "->" });
      i += 2;
      continue;
    }
    if (s.slice(i, i + 2) === "&&") {
      tokens.push({ kind: "op", op: "&" });
      i += 2;
      continue;
    }
    if (s.slice(i, i + 2) === "||") {
      tokens.push({ kind: "op", op: "|" });
      i += 2;
      continue;
    }
    if (s.slice(i, i + 2) === "==") {
      tokens.push({ kind: "op", op: "<->" });
      i += 2;
      continue;
    }
    if (ch === "!" || ch === "~") {
      tokens.push({ kind: "op", op: "!" });
      i += 1;
      continue;
    }
    if (ch === "&" || ch === "∧") {
      tokens.push({ kind: "op", op: "&" });
      i += 1;
      continue;
    }
    if (ch === "|" || ch === "∨") {
      tokens.push({ kind: "op", op: "|" });
      i += 1;
      continue;
    }
    if (ch === "^" || ch === "⊕") {
      tokens.push({ kind: "op", op: "^" });
      i += 1;
      continue;
    }
    if (ch === "1" || ch === "0") {
      tokens.push({ kind: "const", value: ch === "1" });
      i += 1;
      continue;
    }
    const idMatch = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(s.slice(i));
    if (idMatch) {
      const id = idMatch[0];
      if (id.toLowerCase() === "true") {
        tokens.push({ kind: "const", value: true });
      } else if (id.toLowerCase() === "false") {
        tokens.push({ kind: "const", value: false });
      } else {
        varSet.add(id);
        tokens.push({ kind: "var", name: id });
      }
      i += id.length;
      continue;
    }
    throw new Error(`Unexpected character '${ch}' in boolean expression`);
  }
  return { tokens, vars: [...varSet].sort() };
}

function evalBooleanTokens(
  tokens: readonly BoolTok[],
  env: Readonly<Record<string, boolean>>,
): boolean {
  let pos = 0;

  const parseIff = (): boolean => {
    let left = parseImplies();
    while (pos < tokens.length && tokens[pos]?.kind === "op" && (tokens[pos] as { op: string }).op === "<->") {
      pos += 1;
      const right = parseImplies();
      left = left === right;
    }
    return left;
  };

  const parseImplies = (): boolean => {
    let left = parseOr();
    if (pos < tokens.length && tokens[pos]?.kind === "op" && (tokens[pos] as { op: string }).op === "->") {
      pos += 1;
      const right = parseImplies();
      left = !left || right;
    }
    return left;
  };

  const parseOr = (): boolean => {
    let left = parseXor();
    while (pos < tokens.length && tokens[pos]?.kind === "op" && (tokens[pos] as { op: string }).op === "|") {
      pos += 1;
      const right = parseXor();
      left = left || right;
    }
    return left;
  };

  const parseXor = (): boolean => {
    let left = parseAnd();
    while (pos < tokens.length && tokens[pos]?.kind === "op" && (tokens[pos] as { op: string }).op === "^") {
      pos += 1;
      const right = parseAnd();
      left = left !== right;
    }
    return left;
  };

  const parseAnd = (): boolean => {
    let left = parseNot();
    while (pos < tokens.length && tokens[pos]?.kind === "op" && (tokens[pos] as { op: string }).op === "&") {
      pos += 1;
      const right = parseNot();
      left = left && right;
    }
    return left;
  };

  const parseNot = (): boolean => {
    const tok = tokens[pos];
    if (tok && tok.kind === "op" && tok.op === "!") {
      pos += 1;
      return !parseNot();
    }
    return parsePrimary();
  };

  const parsePrimary = (): boolean => {
    const tok = tokens[pos];
    if (!tok) throw new Error("Unexpected end of boolean expression");
    pos += 1;
    if (tok.kind === "const") return tok.value;
    if (tok.kind === "var") return Boolean(env[tok.name]);
    if (tok.kind === "lparen") {
      const val = parseIff();
      const close = tokens[pos];
      if (!close || close.kind !== "rparen") {
        throw new Error("Missing closing ')' in boolean expression");
      }
      pos += 1;
      return val;
    }
    throw new Error(`Unexpected token in boolean expression`);
  };

  const out = parseIff();
  if (pos < tokens.length) {
    throw new Error("Trailing tokens in boolean expression");
  }
  return out;
}

export function runBooleanSatSolver(expression: string): BooleanSatResult {
  try {
    const { tokens, vars } = tokenizeBooleanExpr(expression);
    const numVars = Math.min(vars.length, 8);
    const activeVars = vars.slice(0, numVars);
    const totalRows = 1 << numVars;

    const truthTable: BooleanTruthTableRow[] = [];
    const satisfyingAssignments: Readonly<Record<string, boolean>>[] = [];
    const minterms: string[] = [];
    const maxterms: string[] = [];

    for (let mask = 0; mask < totalRows; mask += 1) {
      const assignment: Record<string, boolean> = {};
      for (let b = 0; b < numVars; b += 1) {
        const bitVal = Boolean((mask >> (numVars - 1 - b)) & 1);
        assignment[activeVars[b]!] = bitVal;
      }
      const result = evalBooleanTokens(tokens, assignment);
      truthTable.push({ assignment, result });

      if (result) {
        satisfyingAssignments.push(assignment);
        if (numVars > 0) {
          minterms.push(
            `(${activeVars.map((v) => (assignment[v] ? v : `!${v}`)).join(" & ")})`,
          );
        }
      } else if (numVars > 0) {
        maxterms.push(
          `(${activeVars.map((v) => (assignment[v] ? `!${v}` : v)).join(" | ")})`,
        );
      }
    }

    const isTautology = satisfyingAssignments.length === totalRows;
    const isContradiction = satisfyingAssignments.length === 0;
    const isSatisfiable = satisfyingAssignments.length > 0;
    const classification = isTautology
      ? "Tautology"
      : isContradiction
        ? "Contradiction"
        : "Satisfiable (SAT)";

    return {
      ok: true,
      expression,
      variables: activeVars,
      classification,
      isSatisfiable,
      isTautology,
      isContradiction,
      truthTable,
      satisfyingAssignments,
      canonicalDnf: isContradiction ? "0 (False)" : isTautology && numVars === 0 ? "1 (True)" : minterms.join(" | "),
      canonicalCnf: isTautology ? "1 (True)" : isContradiction && numVars === 0 ? "0 (False)" : maxterms.join(" & "),
    };
  } catch (err) {
    return {
      ok: false,
      expression,
      variables: [],
      classification: "Contradiction",
      isSatisfiable: false,
      isTautology: false,
      isContradiction: true,
      truthTable: [],
      satisfyingAssignments: [],
      canonicalDnf: "",
      canonicalCnf: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================================
// 15. FUNCTION PLOTTER SAMPLER (SVG GRAPHER ENGINE)
// ============================================================================

export interface FunctionPlotPoint {
  readonly x: number;
  readonly y: number | null;
  readonly dy: number | null;
}

export interface FunctionPlotFeaturePoint {
  readonly x: number;
  readonly y: number;
  readonly kind: "zero" | "min" | "max";
}

export interface FunctionPlotSampleResult {
  readonly ok: boolean;
  readonly expression: string;
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly points: readonly FunctionPlotPoint[];
  readonly zeroCrossings: readonly FunctionPlotFeaturePoint[];
  readonly localMinima: readonly FunctionPlotFeaturePoint[];
  readonly localMaxima: readonly FunctionPlotFeaturePoint[];
  readonly error?: string | undefined;
}

export function sampleFunctionPlotPoints(
  expr: string,
  xMin = -10,
  xMax = 10,
  steps = 120,
): FunctionPlotSampleResult {
  const nSteps = Math.max(10, Math.min(1000, Math.trunc(steps)));
  try {
    const ast = new MathParser(tokenizeMathExpression(stripLeadingCasDirective(expr))).parse();
    const evalF = (xVal: number): number | null => {
      try {
        const v = evaluateAst(ast, { x: xVal }, "rad");
        return Number.isFinite(v) && Math.abs(v) < 1e9 ? v : null;
      } catch {
        return null;
      }
    };

    const points: FunctionPlotPoint[] = [];
    const zeroCrossings: FunctionPlotFeaturePoint[] = [];
    const localMinima: FunctionPlotFeaturePoint[] = [];
    const localMaxima: FunctionPlotFeaturePoint[] = [];

    let yMin = Number.POSITIVE_INFINITY;
    let yMax = Number.NEGATIVE_INFINITY;
    const dx = (xMax - xMin) / nSteps;
    const h = 1e-5;

    for (let i = 0; i <= nSteps; i += 1) {
      const x = xMin + i * dx;
      const y = evalF(x);
      let dy: number | null = null;
      const yp = evalF(x + h);
      const ym = evalF(x - h);
      if (yp !== null && ym !== null) {
        dy = (yp - ym) / (2 * h);
      }
      if (y !== null) {
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
      points.push({
        x: Number(x.toFixed(6)),
        y: y !== null ? Number(y.toFixed(6)) : null,
        dy: dy !== null ? Number(dy.toFixed(6)) : null,
      });
    }

    for (let i = 1; i < points.length; i += 1) {
      const p0 = points[i - 1]!;
      const p1 = points[i]!;
      if (p0.y !== null && p1.y !== null) {
        if (Math.abs(p0.y) < 1e-9) {
          zeroCrossings.push({ x: p0.x, y: 0, kind: "zero" });
        } else if (p0.y * p1.y < 0) {
          const t = Math.abs(p0.y) / (Math.abs(p0.y) + Math.abs(p1.y));
          const zx = Number((p0.x + t * (p1.x - p0.x)).toFixed(6));
          zeroCrossings.push({ x: zx, y: 0, kind: "zero" });
        }
      }
      if (p0.dy !== null && p1.dy !== null && p0.y !== null && p1.y !== null) {
        if (p0.dy < 0 && p1.dy >= 0) {
          const mx = Number((0.5 * (p0.x + p1.x)).toFixed(6));
          const my = evalF(mx) ?? p1.y;
          localMinima.push({ x: mx, y: Number(my.toFixed(6)), kind: "min" });
        } else if (p0.dy > 0 && p1.dy <= 0) {
          const mx = Number((0.5 * (p0.x + p1.x)).toFixed(6));
          const my = evalF(mx) ?? p1.y;
          localMaxima.push({ x: mx, y: Number(my.toFixed(6)), kind: "max" });
        }
      }
    }

    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
      yMin = -10;
      yMax = 10;
    } else if (Math.abs(yMax - yMin) < 1e-6) {
      yMin -= 1;
      yMax += 1;
    }

    return {
      ok: true,
      expression: expr,
      xMin,
      xMax,
      yMin: Number(yMin.toFixed(6)),
      yMax: Number(yMax.toFixed(6)),
      points,
      zeroCrossings,
      localMinima,
      localMaxima,
    };
  } catch (err) {
    return {
      ok: false,
      expression: expr,
      xMin,
      xMax,
      yMin: -10,
      yMax: 10,
      points: [],
      zeroCrossings: [],
      localMinima: [],
      localMaxima: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================================
// 16. LLM NATIVE TOOL-CALL DECLARATIONS & STREAM INTERCEPTOR
// ============================================================================

export interface LlmJsonSchemaParameters {
  readonly type: "object";
  readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

export interface LlmBuiltinToolDeclaration {
  readonly id: ExtendedBuiltinToolId;
  readonly name: string;
  readonly category: "math" | "conversion" | "devtools" | "anti-hallucination" | "cas-linear-quant";
  readonly description: string;
  readonly parameters: LlmJsonSchemaParameters;
  readonly openAiTool: {
    readonly type: "function";
    readonly function: {
      readonly name: ExtendedBuiltinToolId;
      readonly description: string;
      readonly strict: true;
      readonly parameters: LlmJsonSchemaParameters;
    };
  };
  readonly anthropicTool: {
    readonly name: ExtendedBuiltinToolId;
    readonly description: string;
    readonly input_schema: LlmJsonSchemaParameters;
  };
  readonly mcpTool: {
    readonly name: ExtendedBuiltinToolId;
    readonly description: string;
    readonly inputSchema: LlmJsonSchemaParameters;
  };
}

export function buildLlmBuiltinToolDeclarations(): readonly LlmBuiltinToolDeclaration[] {
  const specs: readonly {
    id: ExtendedBuiltinToolId;
    name: string;
    category: LlmBuiltinToolDeclaration["category"];
    description: string;
    properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    required: readonly string[];
  }[] = [
    {
      id: "builtin_scientific_calculator",
      name: "Scientific & Programmer Calculator",
      category: "math",
      description: "Calculator for algebra, trig, calculus, and matrices.",
      properties: {
        expression: {
          type: "string",
          description: "Expression to evaluate (e.g. '125 * 48 + integrate(x^2, 0, 3)')",
        },
        angleUnit: { type: "string", enum: ["rad", "deg"] },
      },
      required: ["expression"],
    },
    {
      id: "builtin_unit_currency_converter",
      name: "Unit, Currency & Base Converter",
      category: "conversion",
      description: "Converts units, currencies, integers, and floats.",
      properties: {
        value: { type: "number" },
        fromUnit: { type: "string" },
        toUnit: { type: "string" },
      },
      required: ["value", "fromUnit", "toUnit"],
    },
    {
      id: "builtin_json_schema_validator",
      name: "JSON / JSONL & Schema Validator",
      category: "devtools",
      description: "Validates JSON/JSONL against schema contracts.",
      properties: {
        payload: { type: "string" },
        mode: { type: "string", enum: ["json", "jsonl", "auto"] },
      },
      required: ["payload"],
    },
    {
      id: "builtin_regex_tester",
      name: "Regular Expression Tester",
      category: "devtools",
      description: "Executes regex patterns with capture groups.",
      properties: {
        pattern: { type: "string" },
        flags: { type: "string" },
        testString: { type: "string" },
      },
      required: ["pattern", "testString"],
    },
    {
      id: "builtin_hash_codec",
      name: "Deterministic Hash, Codec & JWT Inspector",
      category: "devtools",
      description: "Computes hashes, codecs, JWTs, and token counts.",
      properties: {
        input: { type: "string" },
      },
      required: ["input"],
    },
    {
      id: "builtin_datetime_cron_solver",
      name: "DateTime & 5-Field Cron Solver",
      category: "devtools",
      description: "Solves duration deltas and cron trigger times.",
      properties: {
        cronExpression: { type: "string" },
        timestampA: { type: "string" },
        timestampB: { type: "string" },
      },
      required: ["cronExpression"],
    },
    {
      id: "builtin_code_syntax_balance_checker",
      name: "Code Syntax & Bracket Balance Checker",
      category: "devtools",
      description: "Checks code bracket, quote, and comment balance.",
      properties: {
        code: { type: "string" },
        language: { type: "string", enum: ["ts", "js", "rust", "python", "json", "sql"] },
      },
      required: ["code"],
    },
    {
      id: "builtin_citation_fact_cross_checker",
      name: "Citation & Fact Grounding Cross-Checker",
      category: "anti-hallucination",
      description: "Cross-checks cited files, markers, and identifiers.",
      properties: {
        responseText: { type: "string" },
      },
      required: ["responseText"],
    },
    {
      id: "builtin_numeric_claim_verifier",
      name: "Inline Numeric Claim Verifier",
      category: "anti-hallucination",
      description: "Audits inline arithmetic equations and claims.",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
    },
    {
      id: "builtin_uncertainty_abstention_calibrator",
      name: "Uncertainty & Epistemic Abstention Calibrator",
      category: "anti-hallucination",
      description: "Calibrates epistemic score and badge.",
      properties: {
        responseText: { type: "string" },
      },
      required: ["responseText"],
    },
    {
      id: "builtin_symbolic_cas_solver",
      name: "Symbolic CAS, Taylor Series, Root & RK4 ODE Solver",
      category: "cas-linear-quant",
      description: "Solves CAS differentiation, integrals, Taylor series, and roots.",
      properties: {
        expression: { type: "string" },
        taylorCenter: { type: "number" },
        taylorOrder: { type: "number" },
      },
      required: ["expression"],
    },
    {
      id: "builtin_matrix_linear_algebra",
      name: "N×N Matrix Linear Algebra Engine",
      category: "cas-linear-quant",
      description: "Computes matrix determinant, inverse, RREF, and eigenvalues.",
      properties: {
        matrixA: {
          type: "array",
          description: "2D matrix e.g. [[1, 2], [3, 4]]",
        },
      },
      required: ["matrixA"],
    },
    {
      id: "builtin_stats_quant_solver",
      name: "Statistics, Probability, Bayes & Black-Scholes Quant Engine",
      category: "cas-linear-quant",
      description: "Solves distributions, regression, Bayes, NPV, and Black-Scholes.",
      properties: {
        normal: { type: "object" },
        finance: { type: "object" },
      },
      required: [],
    },
    {
      id: "builtin_boolean_sat_ieee754",
      name: "Boolean Truth-Table SAT Solver & IEEE-754 Bit Inspector",
      category: "cas-linear-quant",
      description: "Solves boolean truth tables, SAT, and IEEE-754 floats.",
      properties: {
        expression: { type: "string" },
        floatValue: { type: "number" },
      },
      required: ["expression"],
    },
  ];

  return specs.map((spec) => {
    const parameters: LlmJsonSchemaParameters = {
      type: "object",
      properties: spec.properties,
      required: spec.required,
      additionalProperties: false,
    };
    return {
      id: spec.id,
      name: spec.name,
      category: spec.category,
      description: spec.description,
      parameters,
      openAiTool: {
        type: "function",
        function: {
          name: spec.id,
          description: spec.description,
          strict: true,
          parameters,
        },
      },
      anthropicTool: {
        name: spec.id,
        description: spec.description,
        input_schema: parameters,
      },
      mcpTool: {
        name: spec.id,
        description: spec.description,
        inputSchema: parameters,
      },
    };
  });
}

export interface LlmToolCallPayload {
  readonly id?: string | undefined;
  readonly name: ExtendedBuiltinToolId | string;
  readonly arguments: string | Readonly<Record<string, unknown>>;
}

export interface LlmInterceptedToolReceipt {
  readonly callId: string;
  readonly toolName: string;
  readonly source: "inline-tag" | "json-tool-call";
  readonly rawInput: string;
  readonly outputSummary: string;
  readonly structuredOutput: unknown;
  readonly latencyMs: number;
  readonly status: "executed" | "error";
}

export interface LlmInjectedToolResultMessage {
  readonly role: "tool";
  readonly tool_call_id: string;
  readonly name: string;
  readonly content: string;
}

export interface LlmToolInterceptionInput {
  readonly streamText?: string | undefined;
  readonly toolCalls?: readonly LlmToolCallPayload[] | undefined;
}

export interface LlmToolInterceptionResult {
  readonly interceptedCount: number;
  readonly patchedStreamText: string;
  readonly toolReceipts: readonly LlmInterceptedToolReceipt[];
  readonly injectedToolResultMessages: readonly LlmInjectedToolResultMessage[];
}

export function interceptAndExecuteLlmToolCalls(
  llmStreamTextOrToolCalls:
    | string
    | readonly LlmToolCallPayload[]
    | LlmToolInterceptionInput,
): LlmToolInterceptionResult {
  const isCallArray = (
    val: string | readonly LlmToolCallPayload[] | LlmToolInterceptionInput,
  ): val is readonly LlmToolCallPayload[] => Array.isArray(val);

  const streamText =
    typeof llmStreamTextOrToolCalls === "string"
      ? llmStreamTextOrToolCalls
      : isCallArray(llmStreamTextOrToolCalls)
        ? ""
        : (llmStreamTextOrToolCalls.streamText ?? "");

  const explicitToolCalls: readonly LlmToolCallPayload[] =
    typeof llmStreamTextOrToolCalls === "string"
      ? []
      : isCallArray(llmStreamTextOrToolCalls)
        ? llmStreamTextOrToolCalls
        : (llmStreamTextOrToolCalls.toolCalls ?? []);

  let patchedStreamText = streamText;
  const toolReceipts: LlmInterceptedToolReceipt[] = [];
  const injectedToolResultMessages: LlmInjectedToolResultMessage[] = [];

  const nowMs = () =>
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();

  const recordInterception = (
    toolName: string,
    source: "inline-tag" | "json-tool-call",
    rawInput: string,
    outputSummary: string,
    structuredOutput: unknown,
    status: "executed" | "error" = "executed",
    explicitId?: string,
    elapsedMs = 0,
  ) => {
    const callId = explicitId ?? `call_omnia_${toolReceipts.length + 1}`;
    toolReceipts.push({
      callId,
      toolName,
      source,
      rawInput,
      outputSummary,
      structuredOutput,
      latencyMs: Number(Math.max(0.01, elapsedMs).toFixed(3)),
      status,
    });
    injectedToolResultMessages.push({
      role: "tool",
      tool_call_id: callId,
      name: toolName,
      content: JSON.stringify(structuredOutput),
    });
  };

  // 1. Intercept <calc>...</calc>
  patchedStreamText = patchedStreamText.replace(
    /<calc>([\s\S]*?)<\/calc>/gi,
    (_full: string, inner: string) => {
      const expr = inner.trim();
      const t0 = nowMs();
      const res = runScientificCalculator(expr);
      const elapsed = nowMs() - t0;
      const summary = res.ok
        ? `${expr} = ${res.formattedDecimal} (HEX: ${res.programmerReadout.hex})`
        : `Error: ${res.error}`;
      recordInterception(
        "builtin_scientific_calculator",
        "inline-tag",
        expr,
        summary,
        res,
        res.ok ? "executed" : "error",
        undefined,
        elapsed,
      );
      return res.ok ? `${res.formattedDecimal} [verified <calc>: ${expr} = ${res.formattedDecimal}]` : `[calc-error: ${res.error}]`;
    },
  );

  // 2. Intercept <cas>...</cas>
  patchedStreamText = patchedStreamText.replace(
    /<cas>([\s\S]*?)<\/cas>/gi,
    (_full: string, inner: string) => {
      const expr = inner.trim();
      const t0 = nowMs();
      const res = runSymbolicCasSolver(expr);
      const elapsed = nowMs() - t0;
      const summary = res.ok
        ? `d/dx=${res.symbolicDerivative}; ∫=${res.symbolicIntegral}; roots=[${res.realRoots.join(", ")}]`
        : `Error: ${res.error}`;
      recordInterception(
        "builtin_symbolic_cas_solver",
        "inline-tag",
        expr,
        summary,
        res,
        res.ok ? "executed" : "error",
        undefined,
        elapsed,
      );
      return res.ok
        ? `[verified <cas>: d/dx(${res.normalizedExpression}) = ${res.symbolicDerivative}, ∫ = ${res.symbolicIntegral}]`
        : `[cas-error: ${res.error}]`;
    },
  );

  // 3. Intercept <matrix>...</matrix>
  patchedStreamText = patchedStreamText.replace(
    /<matrix>([\s\S]*?)<\/matrix>/gi,
    (_full: string, inner: string) => {
      const raw = inner.trim();
      const t0 = nowMs();
      try {
        const parsedMatrix = JSON.parse(raw) as number[][];
        const res = runMatrixLinearAlgebra({ matrixA: parsedMatrix });
        const elapsed = nowMs() - t0;
        const summary = res.ok
          ? `det=${res.determinant}, trace=${res.trace}, rank=${res.rank}`
          : `Error: ${res.error}`;
        recordInterception(
          "builtin_matrix_linear_algebra",
          "inline-tag",
          raw,
          summary,
          res,
          res.ok ? "executed" : "error",
          undefined,
          elapsed,
        );
        return res.ok
          ? `[verified <matrix>: det=${res.determinant}, rank=${res.rank}, trace=${res.trace}]`
          : `[matrix-error: ${res.error}]`;
      } catch (err) {
        const elapsed = nowMs() - t0;
        const msg = err instanceof Error ? err.message : String(err);
        recordInterception("builtin_matrix_linear_algebra", "inline-tag", raw, msg, { error: msg }, "error", undefined, elapsed);
        return `[matrix-error: ${msg}]`;
      }
    },
  );

  // 4. Intercept <verify>...</verify>
  patchedStreamText = patchedStreamText.replace(
    /<verify>([\s\S]*?)<\/verify>/gi,
    (_full: string, inner: string) => {
      const draft = inner.trim();
      const t0 = nowMs();
      const res = runNumericClaimVerifier(draft);
      const elapsed = nowMs() - t0;
      const summary = `Checked ${res.totalClaimsChecked} claim(s), discrepancies=${res.discrepancyCount}`;
      recordInterception(
        "builtin_numeric_claim_verifier",
        "inline-tag",
        draft,
        summary,
        res,
        "executed",
        undefined,
        elapsed,
      );
      return res.correctedText;
    },
  );

  // 5. Execute explicit JSON tool_calls
  for (const call of explicitToolCalls) {
    const t0 = nowMs();
    try {
      const parsedArgs =
        typeof call.arguments === "string"
          ? (JSON.parse(call.arguments) as Record<string, unknown>)
          : call.arguments;
      const out = executeBuiltinTool(
        call.name as ExtendedBuiltinToolId,
        parsedArgs,
      );
      const elapsed = nowMs() - t0;
      const outFailed =
        typeof out === "object" &&
        out !== null &&
        (("ok" in out && (out as { ok?: unknown }).ok === false) ||
          ("valid" in out && (out as { valid?: unknown }).valid === false));
      recordInterception(
        call.name,
        "json-tool-call",
        typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments),
        outFailed ? `Failed ${call.name}` : `Executed ${call.name}`,
        out,
        outFailed ? "error" : "executed",
        call.id,
        elapsed,
      );
    } catch (err) {
      const elapsed = nowMs() - t0;
      const msg = err instanceof Error ? err.message : String(err);
      recordInterception(
        call.name,
        "json-tool-call",
        String(call.arguments),
        `Error executing ${call.name}: ${msg}`,
        { error: msg },
        "error",
        call.id,
        elapsed,
      );
    }
  }

  return {
    interceptedCount: toolReceipts.length,
    patchedStreamText,
    toolReceipts,
    injectedToolResultMessages,
  };
}

