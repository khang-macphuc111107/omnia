import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./agent-api", () => ({
  errorMessage: (cause: unknown) => String(cause),
  agentApi: { workspaceDiff: vi.fn(), hunkStage: vi.fn(), hunkRevert: vi.fn() },
}));
import { agentApi } from "./agent-api";
import { DiffPane } from "./diff-pane";
import type { WorkspaceDiff } from "./types";

const diff: WorkspaceDiff = {
  git: true,
  truncated: false,
  error: null,
  files: [
    {
      path: "src/a.ts",
      status: "modified",
      untracked: false,
      binary: false,
      additions: 1,
      deletions: 1,
      hunks: [
        {
          id: "h1",
          header: "@@ -1,2 +1,2 @@",
          lines: [
            { kind: "ctx", oldNo: 1, newNo: 1, text: "keep" },
            { kind: "del", oldNo: 2, newNo: null, text: "old line" },
            { kind: "add", oldNo: null, newNo: 2, text: "new line" },
          ],
        },
      ],
    },
    {
      path: "fresh.txt",
      status: "added",
      untracked: true,
      binary: false,
      additions: 1,
      deletions: 0,
      hunks: [{ id: "h2", header: "@@ -0,0 +1,1 @@", lines: [{ kind: "add", oldNo: null, newNo: 1, text: "hello" }] }],
    },
  ],
};
const api = vi.mocked(agentApi);

beforeEach(() => {
  vi.clearAllMocks();
  api.workspaceDiff.mockResolvedValue(diff);
  api.hunkStage.mockResolvedValue({ ...diff, files: [] });
  api.hunkRevert.mockResolvedValue({ ...diff, files: [] });
});

describe("DiffPane", () => {
  it("renders files, counts and hunk lines", async () => {
    render(<DiffPane sessionId="s" running={false} onClose={vi.fn()} />);
    expect(await screen.findByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("fresh.txt")).toBeInTheDocument();
    expect(screen.getAllByText("+1")).toHaveLength(2);
    expect(screen.getByText("old line")).toBeInTheDocument();
    expect(screen.getByText("new line").closest("tr")).toHaveClass("ag-diff__line--add");
    expect(screen.getByText("old line").closest("tr")).toHaveClass("ag-diff__line--del");
    expect(api.workspaceDiff).toHaveBeenCalledWith("s");
  });

  it("collapses a file", async () => {
    render(<DiffPane sessionId="s" running={false} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText("src/a.ts"));
    expect(screen.queryByText("old line")).toBeNull();
  });

  it("stages a hunk through the api and shows the refreshed result", async () => {
    render(<DiffPane sessionId="s" running={false} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Stage hunk @@ -1,2 +1,2 @@ in src/a.ts" }));
    await waitFor(() => expect(api.hunkStage).toHaveBeenCalledWith("s", "src/a.ts", "h1"));
    expect(await screen.findByText("No changes")).toBeInTheDocument();
  });

  it("asks for confirmation before reverting, and not for new files", async () => {
    render(<DiffPane sessionId="s" running={false} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Revert hunk @@ -1,2 +1,2 @@ in src/a.ts" }));
    expect(api.hunkRevert).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.hunkRevert).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Revert hunk @@ -1,2 +1,2 @@ in src/a.ts" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm revert" }));
    await waitFor(() => expect(api.hunkRevert).toHaveBeenCalledWith("s", "src/a.ts", "h1"));
    expect(screen.queryByRole("button", { name: /Revert hunk @@ -0,0/ })).toBeNull();
  });

  it("disables revert while a run is active and refreshes when it ends", async () => {
    const { rerender } = render(<DiffPane sessionId="s" running={true} onClose={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Revert hunk @@ -1,2 +1,2 @@ in src/a.ts" })).toBeDisabled();
    expect(api.workspaceDiff).toHaveBeenCalledTimes(1);
    rerender(<DiffPane sessionId="s" running={false} onClose={vi.fn()} />);
    await waitFor(() => expect(api.workspaceDiff).toHaveBeenCalledTimes(2));
  });

  it("refreshes on demand and surfaces errors", async () => {
    render(<DiffPane sessionId="s" running={false} onClose={vi.fn()} />);
    await screen.findByText("src/a.ts");
    api.workspaceDiff.mockRejectedValueOnce("boom");
    fireEvent.click(screen.getByRole("button", { name: "Refresh changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });

  it("explains when the folder is not a git repository", async () => {
    api.workspaceDiff.mockResolvedValue({ git: false, files: [], truncated: false, error: null });
    render(<DiffPane sessionId="s" running={false} onClose={vi.fn()} />);
    expect(await screen.findByText(/not a git repository/)).toBeInTheDocument();
  });
});
