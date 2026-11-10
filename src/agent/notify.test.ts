import { afterEach, describe, expect, it, vi } from "vitest";

import { maybeNotify, notificationFor, shouldNotify } from "./notify";

const base = { focused: true, visible: true, selectedId: "a", sessionId: "a", enabled: true };

describe("shouldNotify", () => {
  it("stays quiet when watching the session", () => {
    expect(shouldNotify(base)).toBe(false);
  });
  it("notifies when unfocused, hidden or another session is open", () => {
    expect(shouldNotify({ ...base, focused: false })).toBe(true);
    expect(shouldNotify({ ...base, visible: false })).toBe(true);
    expect(shouldNotify({ ...base, selectedId: "b" })).toBe(true);
    expect(shouldNotify({ ...base, selectedId: null })).toBe(true);
  });
  it("respects the enabled pref", () => {
    expect(shouldNotify({ ...base, focused: false, enabled: false })).toBe(false);
  });
});

describe("notificationFor", () => {
  it("maps events to bodies", () => {
    expect(notificationFor({ type: "run_finished", status: "completed" }, "T")).toEqual({ title: "T", body: "Finished" });
    expect(notificationFor({ type: "run_finished", status: "failed", message: "boom" }, "T")?.body).toBe("Failed: boom");
    expect(notificationFor({ type: "run_finished", status: "interrupted" }, "T")).toBeNull();
    expect(notificationFor({ type: "turn_started", turn: 1 }, "T")).toBeNull();
  });
  it("truncates long failure messages", () => {
    const body = notificationFor({ type: "run_finished", status: "failed", message: "x".repeat(500) }, "T")?.body ?? "";
    expect(body.length).toBeLessThan(160);
    expect(body.endsWith("…")).toBe(true);
  });
  it("announces approvals", () => {
    const event = { type: "approval_requested", request: {} } as never;
    expect(notificationFor(event, "T")?.body).toBe("Waiting for your approval");
  });
});

describe("maybeNotify", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("constructs a notification on run_finished when unfocused and selects on click", () => {
    const created: Array<{ title: string; body?: string; onclick?: () => void; close: () => void }> = [];
    class FakeNotification {
      static permission = "granted";
      static requestPermission = vi.fn();
      onclick?: () => void;
      close = vi.fn();
      constructor(public title: string, options?: { body?: string }) {
        if (options?.body !== undefined) this.body = options.body;
        created.push(this);
      }
      body?: string;
    }
    vi.stubGlobal("Notification", FakeNotification);
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const select = vi.fn();
    const focus = vi.spyOn(window, "focus").mockImplementation(() => undefined);

    maybeNotify("s1", { type: "run_finished", status: "completed" }, { title: "My session", selectedId: "s1", select });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ title: "My session", body: "Finished" });
    created[0]?.onclick?.();
    expect(focus).toHaveBeenCalled();
    expect(select).toHaveBeenCalledWith("s1");
  });

  it("does not throw when Notification is undefined", () => {
    vi.stubGlobal("Notification", undefined);
    expect(() =>
      maybeNotify("s1", { type: "run_finished", status: "completed" }, { title: "t", selectedId: null, select: vi.fn() }),
    ).not.toThrow();
  });
});
