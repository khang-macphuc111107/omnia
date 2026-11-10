import {
  FolderKanban,
  Home,
  Library,
  MessageSquareText,
  Settings,
  type LucideIcon,
} from "lucide-react";
import type { ComponentType, ReactElement } from "react";

import { ProductIcon, type ProductIconName } from "@/components/product-icons";
import type { CoreRuntimeInfo } from "@/lib/core-protocol";
import type { AppRuntimeInfo } from "@/lib/desktop";

export const ACTIVITY_IDS = [
  "home",
  "chats",
  "projects",
  "work",
  "library",
  "memory",
  "skills",
  "settings",
] as const;

export type ActivityId = (typeof ACTIVITY_IDS)[number];
export type NonChatActivityId = Exclude<ActivityId, "chats">;
export type ActivityPlacement = "primary" | "secondary";
export type ActivitySidebarMode = "conversations" | "projects" | "context";

export interface ActivityScreenProps {
  runtime: AppRuntimeInfo;
  coreRuntime?: CoreRuntimeInfo | null | undefined;
}

export interface ActivityScreenModule {
  default: ComponentType<ActivityScreenProps>;
}

export type ActivityIconDescriptor =
  | { kind: "lucide"; icon: LucideIcon }
  | { kind: "product"; icon: ProductIconName };

export interface ActivityDescriptor {
  id: ActivityId;
  label: string;
  /**
   * Optional renderer shortcut used by the rail, command palette, and the
   * global navigation handler. The native desktop registration boundary is
   * still separate from this preview metadata.
   */
  shortcut?: string;
  placement: ActivityPlacement;
  icon: ActivityIconDescriptor;
  sidebar:
    | { mode: "conversations" }
    | { mode: "projects" }
    | { mode: "context"; description: string };
  command: {
    title: string;
    description: string;
    keywords: string;
  };
  screen:
    | { kind: "conversation" }
    | { kind: "lazy"; load: () => Promise<ActivityScreenModule> };
}

const ACTIVITY_DEFINITIONS = [
  {
    id: "home",
    label: "Home",
    shortcut: "Alt+1",
    placement: "primary",
    icon: { kind: "lucide", icon: Home },
    sidebar: {
      mode: "context",
      description: "Continue recent work and start something useful.",
    },
    command: {
      title: "Open home",
      description: "Continue recent work and start something useful",
      keywords: "home start recent overview",
    },
    screen: { kind: "lazy", load: () => import("./activities/home-screen") },
  },
  {
    id: "chats",
    label: "Chats",
    shortcut: "Alt+2",
    placement: "primary",
    icon: { kind: "lucide", icon: MessageSquareText },
    sidebar: { mode: "conversations" },
    command: {
      title: "Open chats",
      description: "Open the active conversation workspace",
      keywords: "chat conversation messages",
    },
    screen: { kind: "conversation" },
  },
  {
    id: "projects",
    label: "Projects",
    shortcut: "Alt+3",
    placement: "primary",
    icon: { kind: "lucide", icon: FolderKanban },
    sidebar: { mode: "projects" },
    command: {
      title: "Open projects",
      description: "Open project metadata and read-only folder grants",
      keywords: "projects folders workspace",
    },
    screen: { kind: "lazy", load: () => import("./activities/projects-screen") },
  },
  {
    id: "work",
    label: "Background work",
    shortcut: "Alt+4",
    placement: "primary",
    icon: { kind: "product", icon: "agent" },
    sidebar: {
      mode: "context",
      description: "Inspect active runs, replayed timeline facts, and attention items without mutating work.",
    },
    command: {
      title: "Open Background Work",
      description: "Inspect active, queued, completed, and attention work projections",
      keywords: "background work tasks agents runs queue attention timeline",
    },
    screen: { kind: "lazy", load: () => import("./activities/background-work-screen") },
  },
  {
    id: "library",
    label: "Library",
    shortcut: "Alt+5",
    placement: "primary",
    icon: { kind: "lucide", icon: Library },
    sidebar: {
      mode: "context",
      description: "Browse durable artifacts and attached knowledge with visible provenance.",
    },
    command: {
      title: "Open library",
      description: "Browse attached sources and immutable artifacts",
      keywords: "library files attachments artifacts content",
    },
    screen: { kind: "lazy", load: () => import("./activities/library-activity-screen") },
  },
  {
    id: "memory",
    label: "Memory",
    shortcut: "Alt+6",
    placement: "primary",
    icon: { kind: "product", icon: "memory" },
    sidebar: {
      mode: "context",
      description: "Inspect memory proposals, scope, provenance, and renderer-local policy previews.",
    },
    command: {
      title: "Open Memory Studio",
      description: "Inspect memory entries, provenance, policies, and the learning lifecycle preview",
      keywords: "memory remember review",
    },
    screen: { kind: "lazy", load: () => import("./activities/memory-screen") },
  },
  {
    id: "skills",
    label: "Skills",
    shortcut: "Alt+7",
    placement: "primary",
    icon: { kind: "product", icon: "skill" },
    sidebar: {
      mode: "context",
      description: "Browse skills, permissions, trust, scope, and loading policy previews.",
    },
    command: {
      title: "Open Skills Studio",
      description: "Browse the skill catalog, permission inventory, and loading pipeline preview",
      keywords: "skills prompts workflows",
    },
    screen: { kind: "lazy", load: () => import("./activities/skills-screen") },
  },
  {
    id: "settings",
    label: "Settings",
    shortcut: "Alt+8",
    placement: "secondary",
    icon: { kind: "lucide", icon: Settings },
    sidebar: {
      mode: "context",
      description: "Providers, appearance, and a reversible Control Center preview for desktop policy.",
    },
    command: {
      title: "Open Omnia Control Center",
      description: "Provider connections, appearance, privacy, storage, network, desktop, and diagnostics",
      keywords: "settings control center configuration providers byok privacy storage network desktop diagnostics",
    },
    screen: { kind: "lazy", load: () => import("./activities/settings-screen") },
  },
] as const satisfies readonly ActivityDescriptor[];

export const ACTIVITY_REGISTRY: readonly ActivityDescriptor[] =
  ACTIVITY_DEFINITIONS;

export const PRIMARY_ACTIVITIES = ACTIVITY_REGISTRY.filter(
  (activity) => activity.placement === "primary",
);
export const SECONDARY_ACTIVITIES = ACTIVITY_REGISTRY.filter(
  (activity) => activity.placement === "secondary",
);
export const COMMAND_ACTIVITIES = ACTIVITY_REGISTRY;
export const LAZY_ACTIVITIES = ACTIVITY_REGISTRY.filter(
  (activity): activity is ActivityDescriptor & {
    screen: { kind: "lazy"; load: () => Promise<ActivityScreenModule> };
  } => activity.screen.kind === "lazy",
);

const registryById = new Map<ActivityId, ActivityDescriptor>(
  ACTIVITY_REGISTRY.map((activity) => [activity.id, activity]),
);

export function activityDescriptor(activityId: ActivityId): ActivityDescriptor {
  const descriptor = registryById.get(activityId);
  if (!descriptor) throw new Error(`Unknown activity: ${activityId}`);
  return descriptor;
}

export function loadActivityScreen(activityId: NonChatActivityId): Promise<ActivityScreenModule> {
  const screen = activityDescriptor(activityId).screen;
  if (screen.kind !== "lazy") {
    return Promise.reject(new Error(`Activity ${activityId} has no lazy screen loader.`));
  }
  return screen.load();
}

export function activityIcon(
  descriptor: Pick<ActivityDescriptor, "icon">,
  size = 19,
): ReactElement {
  if (descriptor.icon.kind === "product") {
    return <ProductIcon name={descriptor.icon.icon} size={size} strokeWidth={1.8} />;
  }
  const Icon = descriptor.icon.icon;
  return <Icon size={size} strokeWidth={1.8} />;
}

/**
 * Resolves the preview activity shortcut without claiming that a native
 * global hook has been installed. Keeping this mapping beside the activity
 * descriptors prevents the rail, palette, dialog, and key handler from
 * drifting apart.
 */
export function activityForShortcut(event: KeyboardEvent): ActivityId | null {
  if (event.ctrlKey || event.metaKey || !event.altKey || event.isComposing) return null;
  const shortcut = `Alt+${event.key}`;
  return (
    ACTIVITY_REGISTRY.find((activity) => activity.shortcut === shortcut)?.id ?? null
  );
}
