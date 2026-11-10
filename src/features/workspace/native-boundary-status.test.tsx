import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { CoreRuntimeInfo } from "@/lib/core-protocol";
import type { AppRuntimeInfo } from "@/lib/desktop";

import { NativeBoundaryStatus } from "./native-boundary-status";

const browserRuntime: AppRuntimeInfo = {
  appName: "Omnia",
  appVersion: "0.1.0",
  platform: "web",
  tauri: false,
  debug: true,
};

const desktopRuntime: AppRuntimeInfo = {
  ...browserRuntime,
  platform: "windows",
  tauri: true,
};

const nativeCore: CoreRuntimeInfo = {
  protocolVersion: "1.0",
  serverInfo: { name: "omnia-core", title: "Omnia Core", version: "0.1.0" },
  capabilities: ["run.stream.v1", "project.v1", "workspace.read.v1"],
  unavailableCapabilities: ["process.execute", "browser.control"],
  sessionToken: "a".repeat(64),
  sessionEpoch: 4,
};

describe("NativeBoundaryStatus", () => {
  it("keeps browser preview separate from a native core session", () => {
    render(<NativeBoundaryStatus runtime={browserRuntime} />);

    const region = screen.getByRole("region", { name: "Native boundary status" });
    expect(region).toHaveTextContent("Browser preview");
    expect(region).toHaveTextContent("No native core session is connected");
    expect(region).toHaveTextContent("Preview fallback only");
    expect(region).toHaveTextContent("no native storage");
    expect(region).not.toHaveTextContent("Session token negotiated");
  });

  it("reports negotiated capabilities and keeps unavailable work explicit", () => {
    render(<NativeBoundaryStatus runtime={desktopRuntime} coreRuntime={nativeCore} />);

    const region = screen.getByRole("region", { name: "Native boundary status" });
    expect(region).toHaveTextContent("Native core negotiated");
    expect(region).toHaveTextContent("Protocol 1.0");
    expect(region).toHaveTextContent("Session token negotiated");
    expect(region).toHaveTextContent("3 advertised capabilities");
    expect(region).toHaveTextContent("run.stream.v1 available");
    expect(region).toHaveTextContent("2 unavailable by negotiation");
    fireEvent.click(screen.getByText("Unavailable capability details"));
    expect(region).toHaveTextContent("Process execution");
    expect(region).toHaveTextContent(/packaged-app/i);
  });

  it("does not claim a successful native session when the desktop handshake is missing", () => {
    render(<NativeBoundaryStatus runtime={desktopRuntime} />);

    const region = screen.getByRole("region", { name: "Native boundary status" });
    expect(region).toHaveTextContent("Native status unknown");
    expect(region).toHaveTextContent("No valid session evidence");
    expect(region).toHaveTextContent("No capability evidence");
    expect(region).not.toHaveTextContent("Native core negotiated");
  });

  it("keeps a partial desktop snapshot at an incomplete-handshake boundary", () => {
    render(
      <NativeBoundaryStatus
        runtime={desktopRuntime}
        coreRuntime={{ ...nativeCore, sessionToken: null, sessionEpoch: null }}
      />,
    );

    const region = screen.getByRole("region", { name: "Native boundary status" });
    expect(region).toHaveTextContent("Native handshake incomplete");
    expect(region).toHaveTextContent("no valid IPC session token and epoch");
    expect(region).not.toHaveTextContent("Native core negotiated");
  });

  it("does not treat a valid session with a missing required capability as compatible", () => {
    render(
      <NativeBoundaryStatus
        runtime={desktopRuntime}
        coreRuntime={{ ...nativeCore, capabilities: ["project.v1"] }}
      />,
    );

    const region = screen.getByRole("region", { name: "Native boundary status" });
    expect(region).toHaveTextContent("Native core incompatible");
    expect(region).toHaveTextContent("required capability run.stream.v1");
    expect(region).toHaveTextContent("run.stream.v1 not advertised");
  });

  it("fails closed when the core protocol version is incompatible", () => {
    render(
      <NativeBoundaryStatus
        runtime={desktopRuntime}
        coreRuntime={{ ...nativeCore, protocolVersion: "2.0" }}
      />,
    );

    const region = screen.getByRole("region", { name: "Native boundary status" });
    expect(region).toHaveTextContent("Native protocol mismatch");
    expect(region).toHaveTextContent("core advertises protocol 2.0");
    expect(region).toHaveTextContent("requires 1.0");
    expect(region).toHaveTextContent("Session not accepted: protocol mismatch");
    expect(region).toHaveTextContent("Not accepted: protocol mismatch");
    expect(region).not.toHaveTextContent("run.stream.v1 available");
    expect(region).not.toHaveTextContent("Native core negotiated");
  });

  it("keeps the advertised capability list inspectable without implying execution authority", () => {
    render(<NativeBoundaryStatus runtime={desktopRuntime} coreRuntime={nativeCore} />);

    const region = screen.getByRole("region", { name: "Native boundary status" });
    fireEvent.click(screen.getByText("Advertised capability details"));
    expect(region).toHaveTextContent("Run streaming");
    expect(region).toHaveTextContent("Projects");
    expect(region).toHaveTextContent("Read-only workspace access");
    expect(region).toHaveTextContent(/provider HTTP/i);
  });
});
