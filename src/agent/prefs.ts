/** Per-viewer conveniences kept in localStorage; every access is best-effort. */

const KEY = "omnia.agent.prefs.v1";

export interface AgentPrefs {
  recentFolders: string[];
  profileId?: string;
  model?: string;
  permissionMode?: string;
  sidebarOpen?: boolean;
  /** Sidebar: pinned session ids, collapsed project cwds, last-seen updatedAtMs per session. */
  pinnedSessions?: string[];
  collapsedProjects?: string[];
  lastSeen?: Record<string, number>;
  /** Desktop notification when a run finishes or needs approval while unfocused. Default true. */
  notifyOnFinish?: boolean;
  /** Split view: width share of the left pane (0.25-0.75). */
  splitRatio?: number;
  /** Appearance: theme, density and font-size scale (percent). */
  theme?: string;
  density?: string;
  fontScale?: number;
  /** Voice: dictation language tag ("" = Windows default), read-aloud voice URI ("" = default), rate and auto-read. */
  voiceLanguage?: string;
  speechVoiceURI?: string;
  speechRate?: number;
  autoRead?: boolean;
  /** Plan mode: the message sent when a plan is approved, and the mode approval switches to. */
  planApprovedMessage?: string;
  planApproveMode?: string;
}

export function readPrefs(): AgentPrefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") {
      const prefs = parsed as AgentPrefs;
      return { ...prefs, recentFolders: Array.isArray(prefs.recentFolders) ? prefs.recentFolders : [] };
    }
  } catch {
    /* storage unavailable or corrupt: fall through to defaults */
  }
  return { recentFolders: [] };
}

export function writePrefs(patch: Partial<AgentPrefs>): AgentPrefs {
  const next = { ...readPrefs(), ...patch };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

export function rememberFolder(path: string): string[] {
  const folders = [path, ...readPrefs().recentFolders.filter((folder) => folder !== path)].slice(0, 8);
  writePrefs({ recentFolders: folders });
  return folders;
}
