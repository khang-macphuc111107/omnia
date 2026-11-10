import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./agent-api", () => ({
  agentApi: { permissionRules: vi.fn(), setPermissionRules: vi.fn(), testPermissionRule: vi.fn() },
  errorMessage: (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
}));
import { agentApi } from "./agent-api";
import { PermissionRulesManager } from "./permission-rules";
import type { PermissionRulesListing } from "./types";

const api = vi.mocked(agentApi);
const listing = (global: PermissionRulesListing["global"]): PermissionRulesListing => ({ global, project: null, session: null, mode: null });

beforeEach(() => {
  vi.clearAllMocks();
  api.permissionRules.mockResolvedValue(
    listing([
      { tool: "shell", pattern: "git status*", action: "allow" },
      { tool: "shell", pattern: "re:rm\\s", action: "deny" },
    ]),
  );
  api.setPermissionRules.mockImplementation(async (_scope, rules) => listing(rules));
});

describe("PermissionRulesManager", () => {
  it("lists rules and adds a new one", async () => {
    render(<PermissionRulesManager scopes={["global"]} />);
    expect(await screen.findByText("shell (git status*)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    fireEvent.change(screen.getByLabelText("Rule tool"), { target: { value: "web_fetch" } });
    fireEvent.change(screen.getByLabelText("Rule action"), { target: { value: "ask" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    await waitFor(() =>
      expect(api.setPermissionRules).toHaveBeenCalledWith(
        "global",
        [
          { tool: "shell", pattern: "git status*", action: "allow" },
          { tool: "shell", pattern: "re:rm\\s", action: "deny" },
          { tool: "web_fetch", pattern: null, action: "ask" },
        ],
        expect.anything(),
      ),
    );
  });

  it("reorders and deletes", async () => {
    render(<PermissionRulesManager scopes={["global"]} />);
    await screen.findByText("shell (git status*)");
    fireEvent.click(screen.getByRole("button", { name: "Move rule 2 up" }));
    await waitFor(() => expect(api.setPermissionRules.mock.calls[0]?.[1][0]?.action).toBe("deny"));
    fireEvent.click(screen.getByRole("button", { name: "Delete rule 1" }));
    await waitFor(() => expect(api.setPermissionRules).toHaveBeenCalledTimes(2));
    expect(api.setPermissionRules.mock.calls[1]?.[1]).toHaveLength(1);
  });

  it("shows validation errors from the host", async () => {
    api.setPermissionRules.mockRejectedValue(new Error("invalid regex"));
    render(<PermissionRulesManager scopes={["global"]} />);
    await screen.findByText("shell (git status*)");
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    fireEvent.change(screen.getByLabelText("Rule tool"), { target: { value: "re:(" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    expect(await screen.findByText("invalid regex")).toBeInTheDocument();
  });

  it("tests a call and names the deciding rule", async () => {
    api.testPermissionRule.mockResolvedValue({
      decision: "deny",
      reason: "",
      rule: { scope: "global", index: 1, tool: "shell", pattern: "re:rm\\s", action: "deny" },
      mode: "ask_writes",
      effect: "execute_process",
      effectAssumed: false,
    });
    render(<PermissionRulesManager scopes={["global"]} />);
    await screen.findByText("shell (git status*)");
    fireEvent.keyDown(screen.getByLabelText("Test input (JSON)"), { key: "Enter" });
    expect(await screen.findByText(/Would be denied.*global rule 2/)).toBeInTheDocument();
    expect(api.testPermissionRule).toHaveBeenCalledWith(expect.objectContaining({ tool: "shell", input: { command: "ls" } }));
  });

  it("focuses the editor and returns focus on Escape without closing its parent", async () => {
    const parentKeyDown = vi.fn();
    render(<div onKeyDown={parentKeyDown}><PermissionRulesManager scopes={["global"]} /></div>);
    await screen.findByText("shell (git status*)");
    fireEvent.click(screen.getByRole("button", { name: "Edit rule 1" }));
    expect(screen.getByLabelText("Rule tool")).toHaveFocus();
    fireEvent.keyDown(screen.getByLabelText("Rule tool"), { key: "Escape" });
    expect(screen.queryByLabelText("Rule tool")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit rule 1" })).toHaveFocus();
    expect(parentKeyDown).not.toHaveBeenCalled();
    expect(api.setPermissionRules).not.toHaveBeenCalled();
  });

  it("saves with Enter and restores the Add rule focus", async () => {
    render(<PermissionRulesManager scopes={["global"]} />);
    await screen.findByText("shell (git status*)");
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    fireEvent.change(screen.getByLabelText("Rule tool"), { target: { value: "read_file" } });
    fireEvent.keyDown(screen.getByLabelText("Rule tool"), { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Add rule" })).toHaveFocus());
    expect(api.setPermissionRules).toHaveBeenCalledTimes(1);
  });

  it("restores a usable focus target after reordering and deleting", async () => {
    render(<PermissionRulesManager scopes={["global"]} />);
    await screen.findByText("shell (git status*)");
    fireEvent.click(screen.getByRole("button", { name: "Move rule 2 up" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Move rule 1 down" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Delete rule 1" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete rule 1" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Delete rule 1" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add rule" })).toHaveFocus());
  });

  it("renders long rule text intact with a separate wrapping controls group", async () => {
    const pattern = "very-long-path/".repeat(80);
    api.permissionRules.mockResolvedValue(listing([{ tool: "shell", pattern, action: "ask" }]));
    render(<PermissionRulesManager scopes={["global"]} />);
    expect(await screen.findByText(`shell (${pattern})`)).toHaveClass("ag-rules__rule");
    const controls = screen.getByRole("group", { name: "Rule 1 controls" });
    expect(controls.querySelectorAll("button")).toHaveLength(4);
  });

  it("rejects non-JSON test input without calling the host", async () => {
    render(<PermissionRulesManager scopes={["global"]} />);
    await screen.findByText("shell (git status*)");
    fireEvent.change(screen.getByLabelText("Test input (JSON)"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Test call" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(api.testPermissionRule).not.toHaveBeenCalled();
  });
});
