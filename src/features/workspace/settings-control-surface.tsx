import {
  SettingsControlCenter,
  type SettingsControlSection,
} from "./settings-control-center";
import type { AppRuntimeInfo } from "@/lib/desktop";

export default function SettingsControlSurface({
  section,
  runtime,
}: {
  section: SettingsControlSection;
  runtime?: AppRuntimeInfo;
}) {
  return <SettingsControlCenter section={section} {...(runtime === undefined ? {} : { runtime })} />;
}
