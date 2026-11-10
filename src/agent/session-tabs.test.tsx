import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SessionTabs } from "./session-tabs";
import type { AgentSessionListItem } from "./types";

const session = (id: string, title: string): AgentSessionListItem => ({ id, title, cwd: `C:/work/${id}`, profileId: "local", model: "demo", permissionMode: "ask_writes", messageCount: 0, createdAtMs: 1, updatedAtMs: 1, running: false });

describe("SessionTabs", () => {
  it("renders active tabs and exposes close/new actions", () => {
    const onOpen = vi.fn();
    const onNew = vi.fn();
    const onClose = vi.fn();
    render(<SessionTabs sessions={[session("a", "Alpha"), session("b", "Beta")]} openIds={["a", "b"]} activeId="b" onOpen={onOpen} onNew={onNew} onClose={onClose} />);
    expect(screen.getByRole("tab", { name: /Beta/ })).toHaveAttribute("aria-selected", "true");
    screen.getByRole("button", { name: "Close Alpha tab" }).click();
    screen.getByRole("button", { name: "New session tab" }).click();
    expect(onClose).toHaveBeenCalledWith("a");
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("tab", { name: /Beta/ })).toHaveAttribute("aria-controls", "session-panel-b");
    expect(screen.getByRole("tab", { name: /Alpha/ })).not.toHaveAttribute("aria-controls");
  });

  it("keeps the tab strip keyboard reachable when the last view closes", () => {
    const onClose = vi.fn();
    render(<SessionTabs sessions={[session("a", "Alpha")]} openIds={["a"]} activeId="a" onOpen={vi.fn()} onNew={vi.fn()} onClose={onClose} />);
    const tab = screen.getByRole("tab", { name: /Alpha/ });
    fireEvent.keyDown(tab, { key: "Delete" });
    expect(onClose).toHaveBeenCalledWith("a");
    expect(screen.getByRole("button", { name: "New session tab" })).toHaveFocus();
  });
});
