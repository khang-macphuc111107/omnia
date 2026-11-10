import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import BuiltinCalculatorWorkbenchDefault, {
  BuiltinCalculatorWorkbench,
  CALC_HISTORY_STORAGE_KEY,
} from "./builtin-calculator-workbench";
import { useWorkspaceStore } from "./store";

const initialWorkspaceState = useWorkspaceStore.getState();

describe("BuiltinCalculatorWorkbench", () => {
  beforeEach(() => {
    if (typeof window !== "undefined" && typeof window.localStorage?.removeItem === "function") {
      window.localStorage.removeItem(CALC_HISTORY_STORAGE_KEY);
    }
    useWorkspaceStore.setState(initialWorkspaceState, true);
  });

  afterEach(() => {
    if (typeof window !== "undefined" && typeof window.localStorage?.removeItem === "function") {
      window.localStorage.removeItem(CALC_HISTORY_STORAGE_KEY);
    }
    useWorkspaceStore.setState(initialWorkspaceState, true);
  });

  it("exports both named BuiltinCalculatorWorkbench and default export", () => {
    expect(BuiltinCalculatorWorkbench).toBeDefined();
    expect(BuiltinCalculatorWorkbenchDefault).toBe(BuiltinCalculatorWorkbench);
  });

  it("evaluates scientific expressions, memory registers, keypad insertions, and paper-tape history in Tab 1", () => {
    render(<BuiltinCalculatorWorkbench />);

    expect(
      screen.getByRole("heading", { name: /Built-in Tools & Anti-Hallucination Studio/i }),
    ).toBeInTheDocument();

    // Default expression: "125 * 48 + integrate(x^2, 0, 3)" = 6000 + 9 = 6009
    expect(screen.getByTestId("calc-decimal-readout")).toHaveTextContent("6009");
    expect(screen.getByTestId("calc-rational-readout")).toHaveTextContent("6009/1");
    expect(screen.getByTestId("calc-programmer-readout")).toHaveTextContent("0x1779");

    // Record to paper tape
    fireEvent.click(screen.getByRole("button", { name: "Evaluate and record to paper tape" }));
    expect(screen.getByTestId("paper-tape-list")).toHaveTextContent("6009");

    // Memory M+, Clear, MR
    fireEvent.click(screen.getByRole("button", { name: "Memory M+" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear calculator expression" }));
    fireEvent.click(screen.getByRole("button", { name: "Memory MR" }));
    expect(screen.getByTestId("calc-decimal-readout")).toHaveTextContent("6009");

    // Scientific keypad insertion
    fireEvent.click(screen.getByRole("button", { name: "Clear calculator expression" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert nCr" }));
    expect(screen.getByTestId("calc-decimal-readout")).toHaveTextContent("120");
  });

  it("converts physical/digital units and inspects programmer bases & IEEE-754 floats in Tab 2", () => {
    render(<BuiltinCalculatorWorkbench initialTab="converter" />);

    expect(screen.getByTestId("panel-converter")).toBeInTheDocument();
    expect(screen.getByTestId("converter-output-value")).toHaveTextContent(/4294\.967296 MB/);

    // Swap units
    fireEvent.click(screen.getByRole("button", { name: "Swap conversion units" }));
    expect(screen.getByTestId("converter-output-value")).toHaveTextContent(/GiB/);

    // Switch category to temperature
    fireEvent.change(screen.getByRole("combobox", { name: "Conversion category" }), {
      target: { value: "temperature" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Unit conversion input value" }), {
      target: { value: "100" },
    });
    expect(screen.getByTestId("converter-output-value")).toHaveTextContent("212 F");

    // Programmer base readout
    expect(screen.getByTestId("prog-radix-summary")).toHaveTextContent("HEX: 0xFF");
    expect(screen.getByTestId("prog-ieee754-summary")).toHaveTextContent("F32:");
  });

  it("validates JSON, tests regexes, computes SHA-256/CRC32, solves cron, and checks syntax balance in Tab 3", () => {
    render(<BuiltinCalculatorWorkbench initialTab="swiss-army" />);

    expect(screen.getByTestId("panel-swiss-army")).toBeInTheDocument();
    expect(screen.getByTestId("swiss-json-validation-output")).toHaveTextContent(
      /JSON payload conforms to schema contract/i,
    );
    expect(screen.getByTestId("swiss-regex-replacement-preview")).toHaveTextContent(
      "Allocated 16 [GiB] RAM and 512 [GB] NVMe storage.",
    );
    expect(screen.getByTestId("swiss-hash-summary")).toHaveTextContent(/FNV1a:/);
    expect(screen.getByTestId("swiss-cron-duration")).toHaveTextContent("1d 6h 45m 30s");
    expect(screen.getByTestId("swiss-syntax-status")).toHaveTextContent(/Balanced/);

    // Introduce syntax imbalance
    fireEvent.change(screen.getByRole("textbox", { name: "Syntax checker code input" }), {
      target: { value: "function broken( { return [1, 2); }" },
    });
    expect(screen.getByTestId("swiss-syntax-status")).toHaveTextContent(/Unbalanced/);
  });

  it("detects inline math hallucinations, cross-checks citations, and auto-corrects drafts in Tab 4", () => {
    render(<BuiltinCalculatorWorkbench initialTab="anti-hallucination" />);

    expect(screen.getByTestId("panel-anti-hallucination")).toBeInTheDocument();
    expect(screen.getByTestId("verifier-badge")).toHaveTextContent("math-discrepancy-detected");
    expect(screen.getByTestId("verifier-numeric-claims-list")).toHaveTextContent("125 * 48 = 5,800");
    expect(screen.getByTestId("verifier-citations-list")).toHaveTextContent(
      "src/domain/omnia-builtin-tools.ts:25",
    );
    expect(screen.getByTestId("verifier-receipts-list")).toHaveTextContent(
      "builtin_numeric_claim_verifier",
    );

    // Click 1-click Auto-Corrected Draft button
    fireEvent.click(
      screen.getByRole("button", { name: "Apply deterministic math correction" }),
    );
    expect(screen.getByTestId("verifier-badge")).toHaveTextContent("verified");
    expect(
      (screen.getByRole("textbox", { name: "Anti-hallucination assistant draft" }) as HTMLTextAreaElement)
        .value,
    ).toContain("125 * 48 = 6000");
  });

  it("inserts verified calculation result into active chat draft in Tab 1 and loads & verifies active chat turn in Tab 4", () => {
    const baseConv = useWorkspaceStore.getState().conversations[0]!;
    useWorkspaceStore.setState({
      activeConversationId: baseConv.id,
      conversations: [
        {
          ...baseConv,
          draft: "Calculation summary:",
          messages: [
            {
              id: "msg-user-calc-1",
              role: "user",
              content: "What is 14 * 15 and cite src/domain/omnia-builtin-tools.ts:12?",
              createdAt: "2026-10-18T18:10:00Z",
              status: "complete",
              modelLabel: null,
              runId: null,
              attachments: [],
              branchIndex: 1,
              branchCount: 1,
            },
            {
              id: "msg-asst-calc-1",
              role: "assistant",
              content:
                "According to [src/domain/omnia-builtin-tools.ts:12], `runScientificCalculator` confirms that 14 * 15 = 199.",
              createdAt: "2026-10-18T18:10:05Z",
              status: "complete",
              modelLabel: null,
              runId: null,
              attachments: [],
              branchIndex: 1,
              branchCount: 1,
            },
          ],
        },
      ],
    });

    render(<BuiltinCalculatorWorkbench />);

    // 1. Insert result into active chat draft from Tab 1
    fireEvent.click(screen.getByTestId("calc-insert-into-chat-btn"));
    const afterInsertConv = useWorkspaceStore
      .getState()
      .conversations.find((c) => c.id === baseConv.id);
    expect(afterInsertConv?.draft).toContain("Calculation summary:");
    expect(afterInsertConv?.draft).toContain("= 6009");

    // 2. Switch to Tab 4 and click Load & Verify Active Chat Turn
    fireEvent.click(screen.getByRole("tab", { name: "Anti-Hallucination Live Verifier" }));
    fireEvent.click(screen.getByTestId("verifier-load-active-chat-btn"));

    expect(screen.getByTestId("verifier-badge")).toHaveTextContent("math-discrepancy-detected");
    expect(screen.getByTestId("verifier-numeric-claims-list")).toHaveTextContent("14 * 15 = 199");

    if (typeof window !== "undefined" && typeof window.localStorage?.getItem === "function") {
      expect(window.localStorage.getItem(CALC_HISTORY_STORAGE_KEY)).toBeTruthy();
    }
  });

  it("renders Symbolic CAS, SVG Function Grapher, Matrix Linear Algebra, and Quant Finance sub-tabs in cas-matrix tab", () => {
    render(<BuiltinCalculatorWorkbench initialTab="cas-matrix" />);

    expect(screen.getByTestId("panel-cas-matrix")).toBeInTheDocument();
    expect(screen.getByTestId("cas-symbolic-derivative")).toHaveTextContent("9*x^2 - 10*x + 4");
    expect(screen.getByTestId("cas-symbolic-integral")).toHaveTextContent(
      "0.75*x^4 - 1.6667*x^3 + 2*x^2 - 7*x + C",
    );

    // Switch to Grapher sub-tab
    fireEvent.click(screen.getByTestId("cas-subtab-grapher"));
    expect(screen.getByTestId("cas-function-svg-graph")).toBeInTheDocument();
    expect(screen.getByTestId("cas-graph-extrema-summary")).toHaveTextContent(/Local Min:/);

    // Switch to Matrix sub-tab
    fireEvent.click(screen.getByTestId("cas-subtab-matrix"));
    expect(screen.getByTestId("matrix-det-trace-rank")).toHaveTextContent("rank=3");
    expect(screen.getByTestId("matrix-rref-output")).toHaveTextContent("[[1,0,0],[0,1,0],[0,0,1]]");

    // Switch to Quant sub-tab
    fireEvent.click(screen.getByTestId("cas-subtab-quant"));
    expect(screen.getByTestId("quant-blackscholes-readout")).toHaveTextContent("Call=");
    expect(screen.getByTestId("quant-npv-irr-readout")).toHaveTextContent("NPV=");
  });

  it("toggles 32-bit bits, inspects IEEE-754 float64 layout/ULP, and solves Boolean SAT truth tables in bitwise-sat tab", () => {
    render(<BuiltinCalculatorWorkbench initialTab="bitwise-sat" />);

    expect(screen.getByTestId("panel-bitwise-sat")).toBeInTheDocument();
    expect(screen.getByTestId("bitwise-word32-readout")).toHaveTextContent("0x00001779");
    fireEvent.click(screen.getByTestId("bit-toggle-0"));
    expect(screen.getByTestId("bitwise-word32-readout")).toHaveTextContent("0x00001778");

    expect(screen.getByTestId("ieee754-ulp-state")).toHaveTextContent("Normalized");
    expect(screen.getByTestId("sat-classification-badge")).toHaveTextContent("Tautology");

    fireEvent.change(screen.getByRole("textbox", { name: "Boolean SAT expression input" }), {
      target: { value: "A ^ B" },
    });
    expect(screen.getByTestId("sat-classification-badge")).toHaveTextContent("Satisfiable (SAT)");
  });

  it("intercepts <calc>, <cas>, and <matrix> tags in LLM streams and exposes 14 MCP tool schemas in llm-mcp tab", () => {
    render(<BuiltinCalculatorWorkbench initialTab="llm-mcp" />);

    expect(screen.getByTestId("panel-llm-mcp")).toBeInTheDocument();
    expect(screen.getByTestId("mcp-server-ready-badge")).toHaveTextContent("14 Tools");
    expect(screen.getByTestId("llm-patched-stream-output")).toHaveTextContent("6000");
    expect(screen.getByTestId("llm-patched-stream-output")).toHaveTextContent("9*x^2 - 10*x + 4");
    expect(screen.getByTestId("llm-patched-stream-output")).toHaveTextContent("det=10");
    expect(screen.getByTestId("llm-mcp-schema-count")).toHaveTextContent("14 schemas");

    // Theme preset selector & auto-intercept toggle
    fireEvent.change(screen.getByTestId("workbench-theme-selector"), {
      target: { value: "linear-carbon" },
    });
    expect(screen.getByTestId("builtin-calculator-workbench")).toHaveAttribute(
      "data-theme-preset",
      "linear-carbon",
    );
  });
});

