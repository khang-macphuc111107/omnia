import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Import production utilities and contracts directly from scripts/cross-session-bridge.mjs
// Keep the bridge's Node-only module behind Vitest's ESM loader. A static
// cross-runtime import is parsed as a browser transform on Windows and fails
// before this suite can collect; dynamic ESM import preserves the same module
// and exports while making the runtime boundary explicit.
let escapeXmlAttr: typeof import("../../scripts/cross-session-bridge.mjs").escapeXmlAttr;
let unescapeXmlAttr: typeof import("../../scripts/cross-session-bridge.mjs").unescapeXmlAttr;
let serializeCrossSessionMessage: typeof import("../../scripts/cross-session-bridge.mjs").serializeCrossSessionMessage;
let deserializeCrossSessionMessage: typeof import("../../scripts/cross-session-bridge.mjs").deserializeCrossSessionMessage;
let CrossSessionDispatcher: typeof import("../../scripts/cross-session-bridge.mjs").CrossSessionDispatcher;
let PIPE_NAME_PATTERN: typeof import("../../scripts/cross-session-bridge.mjs").PIPE_NAME_PATTERN;
let KNOWN_ENDPOINTS: typeof import("../../scripts/cross-session-bridge.mjs").DEFAULT_KNOWN_ENDPOINTS;
let isPipeFailureResponse: typeof import("../../scripts/cross-session-bridge.mjs").isPipeFailureResponse;

beforeAll(async () => {
  // Vite's SSR transform prepends export wrappers before a Node shebang in
  // this bridge, making the transformed source invalid (`#!` is only legal at
  // byte zero). Load the same source through Node's native data URL loader
  // after removing that interpreter marker; no production source is changed.
  const bridgeSource = readFileSync(resolve(process.cwd(), "scripts/cross-session-bridge.mjs"), "utf8")
    .replace(/^#![^\r\n]*(?:\r?\n|$)/, "");
  const bridge = await import(`data:text/javascript;base64,${Buffer.from(bridgeSource).toString("base64")}`);
  escapeXmlAttr = bridge.escapeXmlAttr;
  unescapeXmlAttr = bridge.unescapeXmlAttr;
  serializeCrossSessionMessage = bridge.serializeCrossSessionMessage;
  deserializeCrossSessionMessage = bridge.deserializeCrossSessionMessage;
  CrossSessionDispatcher = bridge.CrossSessionDispatcher;
  PIPE_NAME_PATTERN = bridge.PIPE_NAME_PATTERN;
  KNOWN_ENDPOINTS = bridge.DEFAULT_KNOWN_ENDPOINTS;
  isPipeFailureResponse = bridge.isPipeFailureResponse;
});

interface CrossSessionMessage {
  from: string;
  fromSession?: string;
  fromName?: string;
  fromMode?: string;
  hopChain?: string;
  content: string;
}

interface SendMessagePayload {
  to: string;
  summary: string;
  message: string;
  type?: string;
  recipient?: string;
  recipient_kind?: string;
  content?: string;
}

interface DeliveryReceipt {
  success: boolean;
  message: string;
  msg_id: string;
  display?: string;
}

// ============================================================================
// Test Suite
// ============================================================================

describe("Cross-Session Named Pipe IPC Integration (M5/M6)", () => {
  describe("Named Pipe address resolution & validation", () => {
    it("validates canonical Windows Named Pipe paths", () => {
      expect(PIPE_NAME_PATTERN.test("\\\\.\\pipe\\LOCAL\\cc-msg-6b30a19473ba23a166426cfe78b4198d")).toBe(true);
      expect(PIPE_NAME_PATTERN.test("uds:\\\\.\\pipe\\LOCAL\\cc-msg-040eb6ddd2094ac27e1fe338a08b1368")).toBe(true);
      expect(PIPE_NAME_PATTERN.test("\\\\.\\pipe\\LOCAL\\cc-msg-97447116ef7b3545ba5a19d2e698de97")).toBe(true);
    });

    it("rejects non-canonical or malformed pipe paths", () => {
      expect(PIPE_NAME_PATTERN.test("/tmp/cc-msg-6b30a19473ba23a166426cfe78b4198d")).toBe(false);
      expect(PIPE_NAME_PATTERN.test("\\\\.\\pipe\\other-subsystem")).toBe(false);
      expect(PIPE_NAME_PATTERN.test("\\\\.\\pipe\\LOCAL\\cc-msg-short")).toBe(false);
    });

    it("resolves external session aliases e4bb6ce7 and 8a74eb55", () => {
      const dispatcher = new CrossSessionDispatcher();
      expect(dispatcher.resolveEndpoint("e4bb6ce7")).toBe(KNOWN_ENDPOINTS.desktop.pipe);
      expect(dispatcher.resolveEndpoint("8a74eb55")).toBe(KNOWN_ENDPOINTS.cli.pipe);
      expect(dispatcher.resolveEndpoint("desktop")).toBe(KNOWN_ENDPOINTS.desktop.pipe);
      expect(dispatcher.resolveEndpoint("cli")).toBe(KNOWN_ENDPOINTS.cli.pipe);
    });

    it("throws on unresolvable target identifier", () => {
      const dispatcher = new CrossSessionDispatcher();
      expect(() => dispatcher.resolveEndpoint("unknown-session-abc")).toThrow(/Unresolvable endpoint/);
    });
  });

  describe("Protocol serialization and wire framing", () => {
    it("serializes and deserializes <cross-session-message> wire envelope", () => {
      const original: CrossSessionMessage = {
        from: "uds:\\\\.\\pipe\\LOCAL\\cc-msg-040eb6ddd2094ac27e1fe338a08b1368",
        fromSession: "8a74eb55-710f-47e2-bc43-cc689aad7c05",
        fromName: "Điều phối subagent liên tục",
        fromMode: "bypass",
        hopChain: "4aeed45def0bb9646e9b11a2",
        content: "Task: Bundle size check and vitest verification.",
      };

      const serialized = serializeCrossSessionMessage(original);
      expect(serialized).toContain("<cross-session-message ");
      expect(serialized).toContain('from-name="Điều phối subagent liên tục"');
      expect(serialized).toContain("</cross-session-message>");

      const deserialized = deserializeCrossSessionMessage(serialized);
      expect(deserialized).toEqual(original);
    });

    it("escapes and preserves XML meta-characters, quotes and Vietnamese unicode", () => {
      const adversarial: CrossSessionMessage = {
        from: "uds:\\\\.\\pipe\\LOCAL\\cc-msg-test\"&<>'",
        fromName: 'Agent "Turbo" & <Bypass>',
        fromMode: "bypass",
        content: "Line 1: Special <chars> & \"quotes\"\nLine 2: Mũi tên > và v\nLine 3: {\"json\": true}",
      };

      const serialized = serializeCrossSessionMessage(adversarial);
      expect(serialized).toContain("&quot;");
      expect(serialized).toContain("&amp;");
      expect(serialized).toContain("&lt;");
      expect(serialized).toContain("&gt;");

      const deserialized = deserializeCrossSessionMessage(serialized);
      expect(deserialized).toEqual(adversarial);
    });

    it("preserves embedded </cross-session-message> tags without premature truncation", () => {
      const nested: CrossSessionMessage = {
        from: "uds:\\\\.\\pipe\\LOCAL\\cc-msg-test",
        fromName: "Nested Validator",
        fromMode: "bypass",
        content: "Line 1\nExample: </cross-session-message>\nLine 2 (Critical instruction)",
      };

      const serialized = serializeCrossSessionMessage(nested);
      const deserialized = deserializeCrossSessionMessage(serialized);
      expect(deserialized.content).toBe(nested.content);
    });

    it("rejects malformed wire framing or missing 'from' attribute", () => {
      expect(() => deserializeCrossSessionMessage("plain text without tags")).toThrow(/Malformed wire framing/);
      expect(() => deserializeCrossSessionMessage("<cross-session-message missing='true'>hi</cross-session-message>")).toThrow(/Missing 'from' attribute/);
    });
  });

  describe("Task instruction dispatch & delivery acknowledgment", () => {
    it("dispatches task instructions to Claude Desktop (e4bb6ce7) and captures receipt", async () => {
      const dispatcher = new CrossSessionDispatcher();
      const mockTransport = async (ep: string, payload: SendMessagePayload): Promise<DeliveryReceipt> => {
        expect(ep).toBe(KNOWN_ENDPOINTS.desktop.pipe);
        expect(payload.summary).toBe("Slice B: Bundle Gate");
        expect(payload.message).toContain("check-bundle-budget.mjs");
        return {
          success: true,
          message: `“${payload.summary}” → Omnia Claude Code Harness; in session inbox`,
          msg_id: "rec-desk-1234",
        };
      };

      const receipt = await dispatcher.dispatch(
        "e4bb6ce7",
        "Run check-bundle-budget.mjs and optimize heavy chunk imports.",
        "Slice B: Bundle Gate",
        mockTransport,
      );

      expect(receipt.success).toBe(true);
      expect(receipt.msg_id).toBe("rec-desk-1234");
      expect(receipt.message).toContain("in session inbox");
      expect(dispatcher.fallbackQueue).toHaveLength(0);
    });

    it("dispatches task instructions to Claude CLI (8a74eb55) and captures receipt", async () => {
      const dispatcher = new CrossSessionDispatcher();
      const mockTransport = async (ep: string, payload: SendMessagePayload): Promise<DeliveryReceipt> => {
        expect(ep).toBe(KNOWN_ENDPOINTS.cli.pipe);
        expect(payload.summary).toBe("Git Consolidation");
        return {
          success: true,
          message: `“${payload.summary}” → Điều phối subagent liên tục; in session inbox`,
          msg_id: "rec-cli-5678",
        };
      };

      const receipt = await dispatcher.dispatch(
        "8a74eb55",
        "Reconcile modified files and commit on branch omnia/m0-snapshot.",
        "Git Consolidation",
        mockTransport,
      );

      expect(receipt.success).toBe(true);
      expect(receipt.msg_id).toBe("rec-cli-5678");
      expect(dispatcher.fallbackQueue).toHaveLength(0);
    });
  });

  describe("Timeout handling, connection reset, and fallback routing", () => {
    it("enqueues instructions into fallback buffer when transport times out", async () => {
      const dispatcher = new CrossSessionDispatcher();
      const timeoutTransport = async (): Promise<DeliveryReceipt> => {
        throw new Error("Connection timed out after 1500ms");
      };

      const receipt = await dispatcher.dispatch(
        "e4bb6ce7",
        "Perform background build audit",
        "Build Audit",
        timeoutTransport,
      );

      expect(receipt.success).toBe(false);
      expect(receipt.message).toContain("routed to fallback buffer");
      expect(dispatcher.fallbackQueue).toHaveLength(1);

      const queued = dispatcher.fallbackQueue[0];
      expect(queued.endpoint).toBe(KNOWN_ENDPOINTS.desktop.pipe);
      expect(queued.error).toContain("timed out");
      expect(queued.payload.summary).toBe("Build Audit");
    });

    it("handles socket reset / ECONNRESET and enqueues into fallback buffer", async () => {
      const dispatcher = new CrossSessionDispatcher();
      const resetTransport = async (): Promise<DeliveryReceipt> => {
        throw new Error("read ECONNRESET - peer closed pipe abruptly");
      };

      const receipt = await dispatcher.dispatch(
        "8a74eb55",
        "Check subagent health",
        "Health Check",
        resetTransport,
      );

      expect(receipt.success).toBe(false);
      expect(receipt.message).toContain("routed to fallback buffer");
      expect(dispatcher.fallbackQueue).toHaveLength(1);
      expect(dispatcher.fallbackQueue[0].error).toContain("ECONNRESET");
    });

    it("drains and delivers queued items when pipe recovers", async () => {
      const dispatcher = new CrossSessionDispatcher();

      // Enqueue failed dispatch
      await dispatcher.dispatch(
        "e4bb6ce7",
        "Retryable task instruction",
        "Retry Task",
        async () => { throw new Error("Temporary network glitch"); },
      );
      expect(dispatcher.fallbackQueue).toHaveLength(1);

      // Drain queue
      const processed: Array<{ endpoint: string; summary: string }> = [];
      dispatcher.drain((item) => {
        processed.push({
          endpoint: item.endpoint,
          summary: item.payload.summary,
        });
      });

      expect(dispatcher.fallbackQueue).toHaveLength(0);
      expect(processed).toEqual([
        {
          endpoint: KNOWN_ENDPOINTS.desktop.pipe,
          summary: "Retry Task",
        },
      ]);
    });

    it("detects peer error and unauthorized responses via isPipeFailureResponse", () => {
      expect(isPipeFailureResponse('{"type":"error","error":"unauthorized"}')).toBe(true);
      expect(isPipeFailureResponse('{"status":"error","message":"invalid token"}')).toBe(true);
      expect(isPipeFailureResponse('{"ok":false}')).toBe(true);
      expect(isPipeFailureResponse('{"success":false}')).toBe(true);
      expect(isPipeFailureResponse("ERR: bad frame")).toBe(true);
      expect(isPipeFailureResponse('{"success":true,"msg_id":"123"}')).toBe(false);
      expect(isPipeFailureResponse("")).toBe(false);
    });
  });
});
