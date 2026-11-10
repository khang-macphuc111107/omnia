import {
  desktop,
  isDesktopRuntime,
  type SettingsPermissionsSnapshotLoadResponse,
  type SettingsPermissionsSnapshotSaveResponse,
} from "./desktop";
import {
  createInMemorySettingsPermissionsAdapter,
  OmniaSettingsPermissionsAdapter,
  type OmniaSettingsPermissionsSnapshot,
  type SettingsPermissionsLoadRequest,
  type SettingsPermissionsSaveRequest,
  type SettingsPermissionsPort,
} from "@/domain/omnia-settings-permissions-adapter";

/**
 * Connects the strict settings/permission domain adapter to the Tauri
 * snapshot commands.  The adapter still owns JSON/policy validation and CAS
 * error mapping; this port only translates the desktop IPC envelope.
 */
export function createDesktopSettingsPermissionsAdapter(): OmniaSettingsPermissionsAdapter {
  const port: SettingsPermissionsPort = {
    backend: "native",
    durable: true,
    load: async (request: SettingsPermissionsLoadRequest = {}) => {
      const response: SettingsPermissionsSnapshotLoadResponse =
        await desktop.loadSettingsPermissionsSnapshot({
          ...(request.minimumRevision === undefined
            ? {}
            : { minimumRevision: request.minimumRevision }),
        });
      return response;
    },
    save: async (request: SettingsPermissionsSaveRequest) => {
      const response: SettingsPermissionsSnapshotSaveResponse =
        await desktop.saveSettingsPermissionsSnapshot({
          snapshot: request.snapshot,
          ...(request.expectedRevision === undefined
            ? {}
            : { expectedRevision: request.expectedRevision }),
        });
      return response;
    },
  };
  return new OmniaSettingsPermissionsAdapter(port);
}

/**
 * Creates the settings/permissions adapter appropriate for the current host.
 *
 * The desktop build uses the durable native document; browser previews keep a
 * bounded in-memory document so the same settings surface can render without
 * pretending that a web session has native persistence.
 */
export function createSettingsPermissionsAdapter(
  initial?: OmniaSettingsPermissionsSnapshot,
): OmniaSettingsPermissionsAdapter {
  return isDesktopRuntime()
    ? createDesktopSettingsPermissionsAdapter()
    : createInMemorySettingsPermissionsAdapter(initial);
}
