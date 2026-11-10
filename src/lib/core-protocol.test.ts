import { describe, expect, it } from "vitest";

import {
  assertCompatibleCore,
  assertCompatibleNativeCore,
  createDesktopInitializeRequest,
  OMNIA_CLIENT_CAPABILITIES,
  OMNIA_PROTOCOL_VERSION,
  type CoreRuntimeInfo,
} from "./core-protocol";

function compatibleCore(): CoreRuntimeInfo {
  return {
    protocolVersion: OMNIA_PROTOCOL_VERSION,
    serverInfo: { name: "omnia-core", title: "Omnia Core", version: "0.1.0" },
    capabilities: [...OMNIA_CLIENT_CAPABILITIES, "workspace.read.v1"],
    unavailableCapabilities: ["workspace.write", "process.execute"],
    sessionToken: "a".repeat(64),
    sessionEpoch: 1,
  };
}

describe("core protocol", () => {
  it("builds an explicit capability handshake", () => {
    expect(createDesktopInitializeRequest("0.1.0")).toEqual({
      protocolVersion: "1.0",
      clientInfo: {
        name: "omnia-desktop",
        title: "Omnia Desktop",
        version: "0.1.0",
      },
      capabilities: ["run.stream.v1"],
    });
  });

  it("accepts a compatible native core", () => {
    expect(() => assertCompatibleCore(compatibleCore())).not.toThrow();
  });

  it("fails closed on protocol or capability drift", () => {
    expect(() =>
      assertCompatibleCore({ ...compatibleCore(), protocolVersion: "2.0" }),
    ).toThrow("incompatible");
    expect(() =>
      assertCompatibleCore({ ...compatibleCore(), capabilities: [] }),
    ).toThrow("run.stream.v1");
  });

  it("fails closed on malformed native session metadata", () => {
    expect(() =>
      assertCompatibleNativeCore({ ...compatibleCore(), sessionToken: "not-a-token" }),
    ).toThrow("session token");
    expect(() =>
      assertCompatibleNativeCore({ ...compatibleCore(), sessionEpoch: 0 }),
    ).toThrow("session epoch");
  });
});
