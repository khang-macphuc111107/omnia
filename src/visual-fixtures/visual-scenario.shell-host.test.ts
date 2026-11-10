import { describe, expect, it } from "vitest";

import { parseShellHostView, SHELL_HOST_VIEWS } from "./visual-scenario";

describe("parseShellHostView", () => {
  it("returns null when the shell host is not requested", () => {
    expect(parseShellHostView("")).toBeNull();
    expect(parseShellHostView("?view=memory")).toBeNull();
    expect(parseShellHostView("?host=labs&view=memory")).toBeNull();
  });

  it("falls back to home for unknown or missing views", () => {
    expect(parseShellHostView("?host=shell")).toBe("home");
    expect(parseShellHostView("?host=shell&view=chat")).toBe("home");
    expect(parseShellHostView("?host=shell&view=MEMORY")).toBe("home");
  });

  it("accepts every hostable view, with or without a leading question mark", () => {
    for (const view of SHELL_HOST_VIEWS) {
      expect(parseShellHostView(`?host=shell&view=${view}&state=long-content`)).toBe(view);
      expect(parseShellHostView(`host=shell&view=${view}`)).toBe(view);
    }
  });
});
