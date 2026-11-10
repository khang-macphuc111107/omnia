import { afterEach, describe, expect, it } from "vitest";

import {
  clearCommandHistory,
  getCommandHistory,
  recordCommandInvocation,
} from "./command-history-session";

afterEach(() => clearCommandHistory());

describe("renderer-session command history", () => {
  it("keeps the newest invocation first and de-duplicates repeated commands", () => {
    recordCommandInvocation({ id: "new-chat", title: "New Chat", group: "Commands" }, 10);
    recordCommandInvocation({ id: "open-settings", title: "Open Settings", group: "Commands" }, 20);
    recordCommandInvocation({ id: "new-chat", title: "New Chat", group: "Commands" }, 30);

    expect(getCommandHistory()).toEqual([
      { id: "new-chat", title: "New Chat", group: "Commands", invokedAt: 30 },
      { id: "open-settings", title: "Open Settings", group: "Commands", invokedAt: 20 },
    ]);
  });

  it("keeps a bounded tab-local history and returns defensive copies", () => {
    for (let index = 0; index < 20; index += 1) {
      recordCommandInvocation({ id: `command-${index}`, title: `Command ${index}`, group: "Commands" }, index);
    }

    const history = getCommandHistory();
    expect(history).toHaveLength(12);
    expect(history[0]?.id).toBe("command-19");
    expect(history.at(-1)?.id).toBe("command-8");

    const mutable = history.map((entry) => ({ ...entry }));
    mutable[0]!.title = "tampered";
    expect(getCommandHistory()[0]?.title).toBe("Command 19");
  });
});
