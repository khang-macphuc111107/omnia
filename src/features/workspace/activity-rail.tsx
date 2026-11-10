import { OmniaLogo } from "@/components/omnia-logo";

import {
  PRIMARY_ACTIVITIES,
  SECONDARY_ACTIVITIES,
  activityIcon,
} from "./activity-registry";
import { ProfileMenuPreview } from "./profile-menu-preview";
import { useWorkspaceStore } from "./store";

export function ActivityRail() {
  const activeActivity = useWorkspaceStore((state) => state.activeActivity);
  const setActivity = useWorkspaceStore((state) => state.setActivity);

  return (
    <aside className="activity-rail" aria-label="Primary navigation">
      <div className="activity-rail__mark">
        <OmniaLogo size={26} compact />
      </div>
      <nav>
        {PRIMARY_ACTIVITIES.map((activity) => (
          <button
            key={activity.id}
            type="button"
            className={activeActivity === activity.id ? "rail-button rail-button--active" : "rail-button"}
            aria-current={activeActivity === activity.id ? "page" : undefined}
            aria-label={activity.label}
            aria-keyshortcuts={activity.shortcut}
            title={activity.shortcut ? `${activity.label} · ${activity.shortcut}` : activity.label}
            onClick={() => setActivity(activity.id)}
          >
            <span aria-hidden="true">
              {cloneElement(activityIcon(activity) as ReactElement<{ strokeWidth: number }>, { strokeWidth: 1.75 })}
            </span>
          </button>
        ))}
      </nav>
      <div className="activity-rail__bottom">
        {SECONDARY_ACTIVITIES.map((activity) => (
          <button
            key={activity.id}
            type="button"
            className={activeActivity === activity.id ? "rail-button rail-button--active" : "rail-button"}
            aria-current={activeActivity === activity.id ? "page" : undefined}
            aria-label={activity.label}
            aria-keyshortcuts={activity.shortcut}
            title={activity.shortcut ? `${activity.label} · ${activity.shortcut}` : activity.label}
            onClick={() => setActivity(activity.id)}
          >
            <span aria-hidden="true">
              {cloneElement(activityIcon(activity) as ReactElement<{ strokeWidth: number }>, { strokeWidth: 1.75 })}
            </span>
          </button>
        ))}
        <ProfileMenuPreview />
      </div>
    </aside>
  );
}
import { cloneElement, type ReactElement } from "react";
