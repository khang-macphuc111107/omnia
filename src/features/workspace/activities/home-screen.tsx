import type { ActivityScreenProps } from "../activity-registry";
import { useWorkspaceStore } from "../store";

/**
 * Legacy Home activity. Recent work and quick start moved to the shell's Home
 * start page (the single entry point); the id stays for store/palette
 * compatibility, so this screen only points there.
 */
export default function HomeScreen(_props: Partial<ActivityScreenProps>) {
  const setActivity = useWorkspaceStore((state) => state.setActivity);
  return (
    <div className="screen-scroll">
      <h1 className="sr-only">Home</h1>
      <p className="ws-section-label">Recent work and quick start now live on the Home start page.</p>
      <button type="button" className="button button--secondary" onClick={() => setActivity("chats")}>
        Open Home
      </button>
    </div>
  );
}
