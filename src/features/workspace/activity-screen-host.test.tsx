import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppRuntimeInfo } from "@/lib/desktop";

import type { NonChatActivityId } from "./activity-registry";
import { ActivityScreenHost } from "./activity-screen-host";

const runtime: AppRuntimeInfo = {
  appName: "Omnia",
  appVersion: "0.1.0",
  platform: "windows",
  tauri: true,
  debug: true,
};

describe("lazy activity screen host", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders an accessible loading state and then the loaded activity", async () => {
    let resolveModule: ((module: { default: () => React.JSX.Element }) => void) | undefined;
    const loadScreen = vi.fn(
      () =>
        new Promise<{ default: () => React.JSX.Element }>((resolve) => {
          resolveModule = resolve;
        }),
    );

    render(<ActivityScreenHost activity="library" runtime={runtime} loadScreen={loadScreen} />);
    expect(screen.getByRole("status")).toHaveTextContent("Opening Library");

    resolveModule?.({ default: () => <div>Loaded library activity</div> });
    expect(await screen.findByText("Loaded library activity")).toBeInTheDocument();
  });

  it("contains loader failures and retries with a new module request", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const loadScreen = vi
      .fn()
      .mockRejectedValueOnce(new Error("private-build-path"))
      .mockResolvedValueOnce({ default: () => <div>Recovered settings activity</div> });

    render(<ActivityScreenHost activity="settings" runtime={runtime} loadScreen={loadScreen} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Settings could not be opened");
    expect(alert).not.toHaveTextContent("private-build-path");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Recovered settings activity")).toBeInTheDocument();
    expect(loadScreen).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  it("clears a failed activity immediately when navigation selects another activity", async () => {
    const loadScreen = vi.fn((activity: NonChatActivityId) => {
      if (activity === "settings") {
        return Promise.reject(new Error("private-settings-loader-path"));
      }
      return Promise.resolve({ default: () => <div>Loaded library after navigation</div> });
    });

    const { rerender } = render(
      <ActivityScreenHost activity="settings" runtime={runtime} loadScreen={loadScreen} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Settings could not be opened",
    );

    rerender(
      <ActivityScreenHost activity="library" runtime={runtime} loadScreen={loadScreen} />,
    );

    expect(screen.queryByText("Settings could not be opened")).not.toBeInTheDocument();
    expect(await screen.findByText("Loaded library after navigation")).toBeInTheDocument();
    expect(loadScreen).toHaveBeenNthCalledWith(1, "settings");
    expect(loadScreen).toHaveBeenNthCalledWith(2, "library");
  });
});
