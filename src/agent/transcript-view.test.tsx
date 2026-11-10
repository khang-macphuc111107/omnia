import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./agent-api", () => ({ errorMessage: String, agentApi: {} }));

import { useAgentStore } from "./agent-store";
import { ItemList } from "./transcript-view";
import { itemsFromMessages, reduceAgentEvent } from "./transcript";
import type { AgentMessage } from "./types";

describe("compacted transcript rewind controls", () => {
  it("removes old controls immediately and uses only the authoritative replacement index", () => {
    const rewind = vi.fn(async () => undefined);
    useAgentStore.setState({ activeId: "a", live: {}, rewind });
    const history: AgentMessage[] = Array.from({ length: 16 }, (_, index) => ({
      role: index === 2 || index === 14 ? "user" : "assistant",
      content: [{ type: "text", text: `message ${index}` }],
    }));
    const users = (items: typeof before.items) => items.filter((item) => item.kind === "user");
    const before = itemsFromMessages(history);
    const { rerender } = render(<ItemList items={users(before.items)} />);
    expect(screen.getAllByRole("button", { name: "Rewind to before this message" })).toHaveLength(2);

    const compacted = reduceAgentEvent(before, { type: "compacted", before: 16, after: 8 });
    rerender(<ItemList items={users(compacted.items)} />);
    expect(screen.queryByRole("button", { name: "Rewind to before this message" })).not.toBeInTheDocument();

    const authoritative: AgentMessage[] = Array.from({ length: 8 }, (_, index) => ({
      role: index === 2 || index === 6 ? "user" : "assistant",
      content: [{ type: "text", text: index === 6 ? "message 14" : `restored ${index}` }],
    }));
    const restored = itemsFromMessages(authoritative);
    rerender(<ItemList items={users(restored.items)} />);
    const replacementRewind = screen.getAllByRole("button", { name: "Rewind to before this message" })[1];
    expect(replacementRewind).toBeDefined();
    if (!replacementRewind) throw new Error("Expected replacement turn rewind control");
    fireEvent.click(replacementRewind);
    fireEvent.click(screen.getByRole("button", { name: "Rewind conversation and files" }));
    expect(rewind).toHaveBeenCalledExactlyOnceWith("a", 6, true);
  });
});
