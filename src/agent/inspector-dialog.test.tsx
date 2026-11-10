import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./agent-api", () => ({
  errorMessage: (cause: unknown) => String(cause),
  agentApi: { inspectorList: vi.fn(), inspectorGet: vi.fn(), inspectorClear: vi.fn() },
}));
import { agentApi } from "./agent-api";
import { InspectorDialog, prettyBody } from "./inspector-dialog";
import inspectorStyles from "./inspector-dialog.css?raw";
import type { InspectorExchange, InspectorList } from "./types";

const summary = (id: number, model: string) => ({
  id, startedAtMs: 1_700_000_000_000 + id, provider: "anthropic", model, status: 200,
  durationMs: 420, requestBytes: 100, responseBytes: 2048, error: null, complete: true,
});
const list: InspectorList = {
  exchanges: [summary(2, "claude-b"), summary(1, "claude-a")],
  stats: { requests: 2, errors: 0, retries: 1, fallbacks: 0, completed: 2, averageLatencyMs: 410 },
};
const exchange = (id: number): InspectorExchange => ({
  ...summary(id, id === 2 ? "claude-b" : "claude-a"),
  url: "https://api.example/v1/messages",
  requestHeaders: [{ name: "x-api-key", value: "[REDACTED]" }],
  requestBody: '{"model":"claude-b","stream":true}',
  requestTruncated: false,
  responseHeaders: [{ name: "content-type", value: "text/event-stream" }],
  responseBody: "data: {}\n\n",
  responseTruncated: false,
});
const api = vi.mocked(agentApi);
beforeEach(() => {
  vi.clearAllMocks();
  api.inspectorList.mockResolvedValue(list);
  api.inspectorGet.mockImplementation(async (_s: string, id: number) => exchange(id));
  api.inspectorClear.mockResolvedValue(undefined);
});

describe("InspectorDialog", () => {
  it("lists exchanges with stats and pretty-prints the selected request", async () => {
    render(<InspectorDialog sessionId="s" onClose={vi.fn()} />);
    expect(await screen.findByText(/2 requests · 0 errors · 1 retries/)).toBeInTheDocument();
    await waitFor(() => expect(api.inspectorGet).toHaveBeenCalledWith("s", 2));
    const pre = await screen.findByLabelText("request content");
    await waitFor(() => expect(pre.textContent).toContain('"model": "claude-b"'));
    fireEvent.click(screen.getByRole("tab", { name: "Headers" }));
    expect(screen.getByLabelText("headers content").textContent).toContain("x-api-key: [REDACTED]");
    fireEvent.click(screen.getByRole("tab", { name: "Response" }));
    expect(screen.getByLabelText("response content").textContent).toContain("data: {}");
  });

  it("switches exchanges, copies the visible tab and clears", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<InspectorDialog sessionId="s" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /claude-a/ }));
    await waitFor(() => expect(api.inspectorGet).toHaveBeenCalledWith("s", 1));
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    api.inspectorList.mockResolvedValue({ exchanges: [], stats: list.stats });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(api.inspectorClear).toHaveBeenCalledWith("s"));
    expect(await screen.findByText("No requests recorded yet.")).toBeInTheDocument();
  });

  it("focuses Close, traps Tab in both directions and recovers outside focus", async () => {
    render(<InspectorDialog sessionId="s" onClose={vi.fn()} />);
    const close = screen.getByRole("button", { name: "Close" });
    await waitFor(() => expect(close).toHaveFocus());
    const first = await screen.findByRole("button", { name: /claude-b/ });
    const last = screen.getByRole("button", { name: "Refresh" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    document.body.focus();
    // An outside control can still receive programmatic focus; Tab returns inside.
    const outside = document.createElement("button");
    document.body.append(outside);
    try {
      outside.focus();
      fireEvent.keyDown(outside, { key: "Tab" });
      expect(first).toHaveFocus();
      outside.focus();
      fireEvent.keyDown(outside, { key: "Tab", shiftKey: true });
      expect(last).toHaveFocus();
    } finally {
      outside.remove();
    }
  });

  it("dismisses with Escape from content and restores the opener on unmount", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const { unmount } = render(<InspectorDialog sessionId="s" onClose={onClose} />);
    try {
      await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toHaveFocus());
      const content = screen.getByLabelText("request content");
      content.focus();
      fireEvent.keyDown(content, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
      unmount();
      expect(opener).toHaveFocus();
    } finally {
      unmount();
      opener.remove();
    }
  });

  it("traps focus when the exchange list is empty and skips disabled actions", async () => {
    api.inspectorList.mockResolvedValue({ exchanges: [], stats: list.stats });
    render(<InspectorDialog sessionId="s" onClose={vi.fn()} />);
    await screen.findByText("No requests recorded yet.");
    expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
    const first = screen.getByRole("tab", { name: "Request" });
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveFocus();
  });

  it("preserves long model names, headers, errors and raw bodies without truncating text", async () => {
    const long = "x".repeat(4096);
    api.inspectorList.mockResolvedValue({ ...list, exchanges: [summary(2, long)] });
    api.inspectorGet.mockResolvedValue({
      ...exchange(2), requestBody: long, responseBody: long,
      url: `https://example.test/${long}`, error: long,
      responseHeaders: [{ name: "x-long", value: long }],
    });
    render(<InspectorDialog sessionId="s" onClose={vi.fn()} />);
    expect(await screen.findByRole("button", { name: new RegExp(long) })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("request content").textContent).toBe(long));
    expect(screen.getByRole("alert")).toHaveTextContent(long);
    fireEvent.click(screen.getByRole("tab", { name: "Headers" }));
    expect(screen.getByLabelText("headers content").textContent).toContain(`x-long: ${long}`);
    fireEvent.click(screen.getByRole("tab", { name: "Response" }));
    expect(screen.getByLabelText("response content").textContent).toBe(long);
  });

  it("defines bounded, wrapping scroll regions and a single-column narrow layout", () => {
    // jsdom does not perform layout; assert the CSS contract, not pixel geometry.
    expect(inspectorStyles).toContain("width: min(900px, 100%)");
    expect(inspectorStyles).toContain("max-height: calc(100dvh - 32px)");
    expect(inspectorStyles).toContain("grid-template-columns: minmax(0, 260px) minmax(0, 1fr)");
    expect(inspectorStyles).toContain("@media (max-width: 640px)");
    expect(inspectorStyles).toContain("grid-template-columns: minmax(0, 1fr)");
    for (const selector of [".ag-dialog.ag-dialog--inspector", ".ag-dialog--inspector .ag-inspector__list", ".ag-dialog--inspector .ag-inspector__pre"]) {
      const rule = inspectorStyles.slice(inspectorStyles.indexOf(`${selector} {`)).split("}")[0];
      expect(rule).toContain("max-height:");
      expect(rule).toContain("overflow: auto");
    }
    expect(inspectorStyles).toContain("white-space: pre-wrap");
    expect(inspectorStyles).toContain("overflow-wrap: anywhere");
    expect(inspectorStyles).toContain("flex-wrap: wrap");
  });

  it("leaves non-JSON text untouched", () => {
    expect(prettyBody("data: x")).toBe("data: x");
    expect(prettyBody('{"a":1}')).toBe('{\n  "a": 1\n}');
  });
});
