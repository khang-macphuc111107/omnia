import { SettingsNestedLazySurface } from "./settings-nested-lazy-surface";

const loadAppearancePreviewDeck = () =>
  import("./appearance-preview-deck").then(({ AppearancePreviewDeck }) => ({
    default: AppearancePreviewDeck,
  }));

const loadWorkspacePresetLab = () =>
  import("./workspace-preset-lab").then(({ default: WorkspacePresetLab }) => ({
    default: WorkspacePresetLab,
  }));

const loadThemePresetStudio = () =>
  import("./theme-preset-studio").then(({ default: ThemePresetStudio }) => ({
    default: ThemePresetStudio,
  }));

export default function SettingsAppearanceSurface() {
  return <>
    <SettingsNestedLazySurface
      label="Appearance preview deck"
      load={loadAppearancePreviewDeck}
      props={{}}
    />
    <SettingsNestedLazySurface
      label="Workspace preset lab"
      load={loadWorkspacePresetLab}
      props={{}}
    />
    <SettingsNestedLazySurface
      label="Theme preset studio"
      load={loadThemePresetStudio}
      props={{}}
    />
  </>;
}
