import { SettingsNestedLazySurface } from "./settings-nested-lazy-surface";

const loadWorkspaceSnapshotPreview = () =>
  import("./workspace-snapshot-preview").then(({ WorkspaceSnapshotPreview }) => ({
    default: WorkspaceSnapshotPreview,
  }));

const loadStorageHealthPreview = () =>
  import("./storage-health-preview").then(({ StorageHealthPreview }) => ({
    default: StorageHealthPreview,
  }));

const loadWorkspaceTransferHub = () =>
  import("./workspace-transfer-hub").then(({ default: WorkspaceTransferHub }) => ({
    default: WorkspaceTransferHub,
  }));

const loadWorkspacePresetLab = () =>
  import("./workspace-preset-lab").then(({ default: WorkspacePresetLab }) => ({
    default: WorkspacePresetLab,
  }));

const loadWorkspaceFileRootsPreview = () =>
  import("./workspace-file-roots-preview").then(({ default: WorkspaceFileRootsPreview }) => ({
    default: WorkspaceFileRootsPreview,
  }));

const loadWorkspaceFileBrowserPreview = () =>
  import("./workspace-file-browser-preview").then(({ default: WorkspaceFileBrowserPreview }) => ({
    default: WorkspaceFileBrowserPreview,
  }));

export default function SettingsStorageSurface() {
  return (
    <>
      <SettingsNestedLazySurface
        label="Workspace snapshot preview"
        load={loadWorkspaceSnapshotPreview}
        props={{}}
      />
      <SettingsNestedLazySurface
        label="Storage health preview"
        load={loadStorageHealthPreview}
        props={{}}
      />
      <SettingsNestedLazySurface
        label="Workspace transfer hub"
        load={loadWorkspaceTransferHub}
        props={{}}
      />
      <SettingsNestedLazySurface
        label="Workspace preset lab"
        load={loadWorkspacePresetLab}
        props={{}}
      />
      <SettingsNestedLazySurface
        label="Workspace file roots preview"
        load={loadWorkspaceFileRootsPreview}
        props={{}}
      />
      <SettingsNestedLazySurface
        label="Workspace file browser preview"
        load={loadWorkspaceFileBrowserPreview}
        props={{}}
      />
    </>
  );
}
