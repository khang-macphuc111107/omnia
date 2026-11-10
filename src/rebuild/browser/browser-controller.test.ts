import { describe, expect, it } from "vitest";
import { boundsFromRect, createBrowserNativePort, emptyBrowserTab, resolveBrowserAddress, validBrowserUrl } from "./browser-controller";

describe("rebuild browser controller", () => {
  it("accepts public http(s) addresses and rejects privileged or credential URLs", () => {
    expect(validBrowserUrl("https://example.com/docs")).toBe("https://example.com/docs");
    expect(validBrowserUrl(" http://example.org/ ")).toBe("http://example.org/");
    expect(validBrowserUrl("file:///C:/secret.txt")).toBeNull();
    expect(validBrowserUrl("http://user:pass@example.com")).toBeNull();
    expect(validBrowserUrl("http://localhost:1420")).toBeNull();
    expect(validBrowserUrl("http://127.0.0.1:9000")).toBeNull();
    expect(validBrowserUrl("not a url")).toBeNull();
  });
  it("uses an explicit search provider for non-URL text", () => {
    expect(resolveBrowserAddress("rust async channels")).toBe("https://www.google.com/search?q=rust%20async%20channels");
    expect(resolveBrowserAddress("rust async channels", "bing")).toBe("https://www.bing.com/search?q=rust%20async%20channels");
    expect(resolveBrowserAddress("docs.rs")).toBe("https://docs.rs/");
  });
  it("keeps geometry finite, clamps negative coordinates and applies a display scale", () => {
    expect(boundsFromRect({ left: -12.4, top: 5.8, width: 400.3, height: 210.7 }, 2)).toEqual({ x: 0, y: 12, width: 776, height: 421 });
    expect(() => boundsFromRect({ left: 0, top: 0, width: 20, height: 20 }, 0)).toThrow("finite");
  });
  it("creates an honest unavailable port in browser preview", async () => {
    const port = createBrowserNativePort();
    expect(port.available).toBe(false);
    await expect(port.attach({ tabKey: "tab-1", url: "https://example.com/", bounds: { x: 0, y: 0, width: 200, height: 100 } })).rejects.toThrow("unavailable");
  });
  it("creates stable tab defaults without pretending that a lease exists", () => {
    expect(emptyBrowserTab("tab-1")).toMatchObject({ id: "tab-1", leaseId: null, status: "idle", zoomPercent: 100 });
  });
});
