import { desktop } from "@/lib/desktop";

import {
  createOmniaNativePersistenceAdapter,
  type NativeExportBundleRequest,
  type NativeExportBundleResponse,
  type NativeImportBundleRequest,
  type NativeImportBundleResponse,
  type NativeLoadSnapshotRequest,
  type NativeSaveSnapshotRequest,
  type OmniaNativePersistencePort,
  type OmniaNativePersistenceAdapter,
} from "./omnia-native-persistence-adapter";

/**
 * Production renderer port backed by the Tauri app-state IPC commands.
 *
 * The domain adapter remains independent from Tauri; this small composition
 * module is the only place that wires the desktop invoke facade to the
 * serialized persistence contract.  Browser preview callers should continue
 * using `createInMemoryOmniaPersistenceAdapter` instead.
 */
export function createOmniaDesktopPersistencePort(): OmniaNativePersistencePort {
  return {
    backend: "native",
    durable: true,
    loadSnapshot: (request: NativeLoadSnapshotRequest = {}) =>
      desktop.loadAppStateSnapshot({
        ...(request.minimumRevision === undefined ? {} : { minimumRevision: request.minimumRevision }),
      }),
    saveSnapshot: (request: NativeSaveSnapshotRequest) =>
      desktop.saveAppStateSnapshot({
        snapshot: request.snapshot,
        ...(request.expectedRevision === undefined ? {} : { expectedRevision: request.expectedRevision }),
      }),
    exportBundle: async (request: NativeExportBundleRequest): Promise<NativeExportBundleResponse> => {
      const response = await desktop.exportAppStateTransfer({ bundle: request.bundle });
      if (response.status !== "exported") {
        throw new Error(`Unexpected app-state transfer status: ${response.status}`);
      }
      return {
        status: "exported",
        bundle: response.bundle,
        ...(response.receiptId === undefined ? {} : { receiptId: response.receiptId }),
      };
    },
    importBundle: async (request: NativeImportBundleRequest): Promise<NativeImportBundleResponse> => {
      const response = await desktop.importAppStateTransfer({ bundle: request.bundle });
      if (response.status !== "imported") {
        throw new Error(`Unexpected app-state transfer status: ${response.status}`);
      }
      return {
        status: "imported",
        bundle: response.bundle,
        ...(response.receiptId === undefined ? {} : { receiptId: response.receiptId }),
      };
    },
    health: async () => desktop.appStatePersistenceHealth(),
  };
}

export function createOmniaDesktopPersistenceAdapter(): OmniaNativePersistenceAdapter {
  return createOmniaNativePersistenceAdapter(createOmniaDesktopPersistencePort());
}
