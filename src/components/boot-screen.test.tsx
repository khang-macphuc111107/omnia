import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AppRuntimeInfo } from "@/lib/desktop";

import { BootScreen } from "./boot-screen";

const desktopRuntime: AppRuntimeInfo = {
  appName: "Omnia",
  appVersion: "0.1.0",
  platform: "windows",
  tauri: true,
  debug: true,
};

describe("BootScreen", () => {
  it("uses the shared product identity and a restrained loading status", () => {
    const { container } = render(<BootScreen runtime={null} error={null} />);

    expect(screen.getByRole("heading", { name: "Omnia" })).toBeInTheDocument();
    expect(screen.getByText("AI workbench")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Opening your workspace");
    expect(container.querySelector(".omnia-logo__aperture")).toBeInTheDocument();
    expect(container.querySelector("[style]")).not.toBeInTheDocument();
  });

  it("exposes a direct startup diagnostic without an animated progress state", () => {
    const { container } = render(
      <BootScreen runtime={desktopRuntime} error="Storage initialization failed." />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Omnia could not finish starting.");
    expect(alert).toHaveTextContent("Storage initialization failed.");
    expect(alert).toHaveTextContent("Omnia 0.1.0 · windows · desktop");
    expect(container.querySelector(".boot-screen__progress-track")).not.toBeInTheDocument();
  });
});
