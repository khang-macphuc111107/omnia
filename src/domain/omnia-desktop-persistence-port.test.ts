import { beforeEach, describe, expect, it, vi } from "vitest";

const desktopMock = vi.hoisted(() => ({
  loadAppStateSnapshot: vi.fn(),
  saveAppStateSnapshot: vi.fn(),
  exportAppStateTransfer: vi.fn(),
  importAppStateTransfer: vi.fn(),
  appStatePersistenceHealth: vi.fn(),
}));

vi.mock("@/lib/desktop", () => ({ desktop: desktopMock }));

import { createOmniaDesktopPersistencePort } from "./omnia-desktop-persistence-port";

describe("Omnia desktop persistence port", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards snapshot load/save requests without changing their IPC shape", async () => {
    desktopMock.loadAppStateSnapshot.mockResolvedValue({
      status: "empty",
      receiptId: "native:load:1",
    });
    desktopMock.saveAppStateSnapshot.mockResolvedValue({
      status: "saved",
      revision: 3,
      receiptId: "native:save:1",
    });

    const port = createOmniaDesktopPersistencePort();

    await expect(port.loadSnapshot({ minimumRevision: 2 })).resolves.toEqual({
      status: "empty",
      receiptId: "native:load:1",
    });
    expect(desktopMock.loadAppStateSnapshot).toHaveBeenCalledWith({ minimumRevision: 2 });

    await expect(
      port.saveSnapshot({ snapshot: '{"revision":3}', expectedRevision: 2 }),
    ).resolves.toEqual({
      status: "saved",
      revision: 3,
      receiptId: "native:save:1",
    });
    expect(desktopMock.saveAppStateSnapshot).toHaveBeenCalledWith({
      snapshot: '{"revision":3}',
      expectedRevision: 2,
    });
  });

  it("preserves transfer receipts and payloads on export/import", async () => {
    desktopMock.exportAppStateTransfer.mockResolvedValue({
      status: "exported",
      bundle: '{"format":"omnia.transfer"}',
      receiptId: "native:transfer-export:1",
    });
    desktopMock.importAppStateTransfer.mockResolvedValue({
      status: "imported",
      bundle: '{"format":"omnia.transfer"}',
      receiptId: "native:transfer-import:1",
    });

    const port = createOmniaDesktopPersistencePort();

    await expect(port.exportBundle?.({ bundle: '{"format":"omnia.transfer"}' })).resolves.toEqual({
      status: "exported",
      bundle: '{"format":"omnia.transfer"}',
      receiptId: "native:transfer-export:1",
    });
    expect(desktopMock.exportAppStateTransfer).toHaveBeenCalledWith({
      bundle: '{"format":"omnia.transfer"}',
    });

    await expect(port.importBundle?.({ bundle: '{"format":"omnia.transfer"}' })).resolves.toEqual({
      status: "imported",
      bundle: '{"format":"omnia.transfer"}',
      receiptId: "native:transfer-import:1",
    });
    expect(desktopMock.importAppStateTransfer).toHaveBeenCalledWith({
      bundle: '{"format":"omnia.transfer"}',
    });
  });

  it("fails closed when native transfer commands return an unexpected status", async () => {
    desktopMock.exportAppStateTransfer.mockResolvedValue({
      status: "imported",
      bundle: "{}",
    });
    desktopMock.importAppStateTransfer.mockResolvedValue({
      status: "exported",
      bundle: "{}",
    });

    const port = createOmniaDesktopPersistencePort();

    await expect(port.exportBundle?.({ bundle: "{}" })).rejects.toThrow(
      "Unexpected app-state transfer status: imported",
    );
    await expect(port.importBundle?.({ bundle: "{}" })).rejects.toThrow(
      "Unexpected app-state transfer status: exported",
    );
  });

  it("forwards native persistence health metadata", async () => {
    desktopMock.appStatePersistenceHealth.mockResolvedValue({
      status: "available",
      backend: "native",
      durable: true,
      schemaVersion: 1,
    });

    const port = createOmniaDesktopPersistencePort();

    await expect(port.health?.()).resolves.toEqual({
      status: "available",
      backend: "native",
      durable: true,
      schemaVersion: 1,
    });
    expect(desktopMock.appStatePersistenceHealth).toHaveBeenCalledTimes(1);
  });
});
