import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./agent-api", () => ({
  errorMessage: (cause: unknown) => String(cause),
  agentApi: { artifactsList: vi.fn(), artifactGet: vi.fn(), artifactExport: vi.fn(), artifactOpenBrowser: vi.fn(), artifactPreviewUrl: vi.fn() },
}));
import { agentApi } from "./agent-api";
import { ArtifactCard, artifactResult } from "./artifact-card";
import { ARTIFACT_CSP, artifactDocument, CSV_MAX_ROWS, parseCsv } from "./artifact-preview";
import { ArtifactsPanel } from "./artifacts-panel";
import { useAgentStore } from "./agent-store";
import type { ToolItem } from "./transcript";
import type { ArtifactContent, ArtifactMeta } from "./types";

const page: ArtifactMeta = { id: "page", sessionId: "s1", title: "Landing page", kind: "html", version: 2, versions: [1, 2], createdMs: 1, updatedMs: 2 };
const table: ArtifactMeta = { id: "tbl", sessionId: "s1", title: "Numbers", kind: "csv", version: 1, versions: [1], createdMs: 1, updatedMs: 1 };
const content = (meta: ArtifactMeta, version: number, text: string): ArtifactContent => ({ meta, version, content: text });

const api = vi.mocked(agentApi);
beforeEach(() => {
  vi.clearAllMocks();
  api.artifactPreviewUrl.mockImplementation(async (_s, id, version) => `http://omnia-artifact.localhost/tok-${id}-v${version}/`);
  api.artifactsList.mockResolvedValue([page, table]);
  api.artifactGet.mockImplementation(async (_s, id, version) => {
    if (id === "tbl") return content(table, 1, "name,qty\nbolt,3\n\"a,b\",4");
    return content(page, version ?? 2, version === 1 ? "<p>first</p>" : "<p>second</p>");
  });
});

describe("ArtifactsPanel", () => {
  it("lists artifacts and previews the selected one in a locked-down iframe", async () => {
    render(<ArtifactsPanel sessionId="s1" request={null} onClose={() => undefined} />);
    expect(await screen.findByRole("button", { name: /Landing page/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Numbers/ })).toBeTruthy();
    const frame = (await screen.findByTitle("Preview of Landing page")) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-popups");
    // Served from the dedicated scheme (own CSP via headers), never inline srcdoc.
    expect(frame.getAttribute("src")).toBe("http://omnia-artifact.localhost/tok-page-v2/");
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    expect(api.artifactPreviewUrl).toHaveBeenCalledWith("s1", "page", 2);
  });

  it("falls back to a CSP-wrapped srcdoc when no preview URL can be minted", async () => {
    api.artifactPreviewUrl.mockRejectedValue(new Error("no scheme"));
    render(<ArtifactsPanel sessionId="s1" request={null} onClose={() => undefined} />);
    const frame = (await screen.findByTitle("Preview of Landing page")) as HTMLIFrameElement;
    const srcdoc = frame.getAttribute("srcdoc") ?? "";
    expect(frame.hasAttribute("src")).toBe(false);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(srcdoc).toContain("connect-src 'none'");
    expect(srcdoc.indexOf("Content-Security-Policy")).toBeLessThan(srcdoc.indexOf("<p>second</p>"));
  });

  it("switches versions and shows source", async () => {
    render(<ArtifactsPanel sessionId="s1" request={null} onClose={() => undefined} />);
    await screen.findByTitle("Preview of Landing page");
    fireEvent.change(screen.getByLabelText("Version"), { target: { value: "1" } });
    await waitFor(() => expect(api.artifactGet).toHaveBeenLastCalledWith("s1", "page", 1));
    await waitFor(() => expect((screen.getByTitle("Preview of Landing page") as HTMLIFrameElement).getAttribute("src")).toBe("http://omnia-artifact.localhost/tok-page-v1/"));
    fireEvent.click(screen.getByRole("tab", { name: "Source" }));
    expect(screen.getByText("<p>first</p>")).toBeTruthy();
    expect(screen.queryByTitle("Preview of Landing page")).toBeNull();
  });

  it("renders csv as a table and wires export/open actions", async () => {
    render(<ArtifactsPanel sessionId="s1" request={null} onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: /Numbers/ }));
    expect(await screen.findByRole("columnheader", { name: "qty" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "a,b" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Open in browser/ })).toBeNull();
    api.artifactExport.mockResolvedValue("C:\\out\\Numbers.csv");
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    await waitFor(() => expect(api.artifactExport).toHaveBeenCalledWith("s1", "tbl", 1));
    expect(await screen.findByText(/Saved to C:\\out\\Numbers.csv/)).toBeTruthy();
  });

  it("offers open-in-browser for html and selects the requested artifact", async () => {
    render(<ArtifactsPanel sessionId="s1" request={{ sessionId: "s1", id: "page", reason: "created", n: 1 }} onClose={() => undefined} />);
    await screen.findByTitle("Preview of Landing page");
    api.artifactOpenBrowser.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: /Open in browser/ }));
    await waitFor(() => expect(api.artifactOpenBrowser).toHaveBeenCalledWith("s1", "page", 2));
  });

  it("shows an empty state", async () => {
    api.artifactsList.mockResolvedValue([]);
    render(<ArtifactsPanel sessionId="s1" request={null} onClose={() => undefined} />);
    expect(await screen.findByText(/No artifacts yet/)).toBeTruthy();
  });
});

describe("artifact preview helpers", () => {
  it("puts the CSP first and strips a leading doctype", () => {
    const doc = artifactDocument("html", "<!DOCTYPE html><html><body>x</body></html>");
    expect(doc.startsWith("<!doctype html><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
    expect(doc.match(/<!doctype/gi)).toHaveLength(1);
    expect(ARTIFACT_CSP).toContain("default-src 'none'");
    expect(ARTIFACT_CSP).toContain("connect-src 'none'");
  });

  it("renders svg without script permission", () => {
    const doc = artifactDocument("svg", "<svg onload=\"alert(1)\"/>");
    expect(doc).not.toContain("script-src");
  });

  it("caps csv rows", () => {
    const text = ["h", ...Array.from({ length: CSV_MAX_ROWS + 10 }, (_, i) => String(i))].join("\r\n");
    const parsed = parseCsv(text);
    expect(parsed.rows).toHaveLength(CSV_MAX_ROWS + 1);
    expect(parsed.hiddenRows).toBe(10);
    expect(parseCsv('a,"b ""q"" c"\n').rows).toEqual([["a", 'b "q" c']]);
  });
});

describe("ArtifactCard", () => {
  const tool = (patch: Partial<ToolItem>): ToolItem => ({
    key: "tool-1", kind: "tool", id: "t1", name: "artifact", input: {}, summary: "create artifact Demo", status: "ok",
    output: JSON.stringify({ ok: true, action: "create", id: "demo", version: 3, title: "Demo", kind: "html" }),
    progress: "", partialJson: "", sub: null, ...patch,
  });

  it("opens the panel via the store", () => {
    useAgentStore.setState({ artifactRequest: null });
    render(<ArtifactCard item={tool({})} sessionId="s1" />);
    expect(screen.getByText("Demo")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open artifact Demo" }));
    expect(useAgentStore.getState().artifactRequest).toMatchObject({ sessionId: "s1", id: "demo", version: 3, reason: "open" });
  });

  it("renders nothing for failures, deletes and other tools", () => {
    expect(artifactResult(tool({ status: "error" }))).toBeNull();
    expect(artifactResult(tool({ name: "shell" }))).toBeNull();
    expect(artifactResult(tool({ output: "not json" }))).toBeNull();
    expect(artifactResult(tool({ output: JSON.stringify({ id: "x", title: "T", version: 0, action: "delete" }) }))).toBeNull();
    const { container } = render(<ArtifactCard item={tool({ status: "error" })} sessionId="s1" />);
    expect(container.textContent).toBe("");
  });

  it("store turns agent artifact events into requests", () => {
    useAgentStore.setState({ artifactRequest: null });
    act(() => {
      useAgentStore.getState().applyEvent({
        sessionId: "s1",
        event: { type: "artifact", id: "demo", version: 1, title: "Demo", kind: "html", action: "create" },
      });
    });
    expect(useAgentStore.getState().artifactRequest).toMatchObject({ sessionId: "s1", id: "demo", reason: "created" });
  });
});
