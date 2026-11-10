import type { ActivityScreenProps } from "../activity-registry";

const SETTINGS_SECTIONS = [
  "Providers and models",
  "Appearance",
  "Permissions",
  "Storage and backup",
  "Diagnostics",
] as const;

/**
 * Legacy Settings activity. Settings now open only from the shell rail's
 * bottom button (Ctrl+,) as a dialog; the id stays for store/palette
 * compatibility, so this screen only points there.
 */
export default function SettingsScreen(_props: Partial<ActivityScreenProps>) {
  return (
    <div className="screen-scroll">
      <h1 className="sr-only">Settings</h1>
      <p className="ws-section-label">
        Settings open from the Settings button at the bottom of the rail (Ctrl+,).
      </p>
      <div className="hit-target-control">
        <ul aria-label="Sections in the Settings dialog" className="hit-target-control">
          {SETTINGS_SECTIONS.map((section) => (
            <li key={section}>{section}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
