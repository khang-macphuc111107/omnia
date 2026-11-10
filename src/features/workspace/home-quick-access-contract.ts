export const HOME_QUICK_ACCESS_SCHEMA = "omnia.home-quick-access.preview.v1";
export const HOME_QUICK_ACCESS_IMPORT_LIMIT = 16 * 1024;

export const HOME_QUICK_ACCESS_ACTIONS = [
  "new-chat",
  "new-project",
  "workspace-search",
  "import-preview",
  "chats",
  "projects",
  "work",
  "library",
  "memory",
  "skills",
  "settings",
] as const;

export type HomeQuickAccessActionId = (typeof HOME_QUICK_ACCESS_ACTIONS)[number];

export interface HomeQuickAccessItem {
  readonly id: HomeQuickAccessActionId;
  readonly enabled: boolean;
  readonly favorite: boolean;
}

export interface HomeQuickAccessBundle {
  readonly schema: typeof HOME_QUICK_ACCESS_SCHEMA;
  readonly items: readonly HomeQuickAccessItem[];
}

export const DEFAULT_HOME_QUICK_ACCESS: readonly HomeQuickAccessItem[] = [
  { id: "new-chat", enabled: true, favorite: true },
  { id: "new-project", enabled: true, favorite: true },
  { id: "workspace-search", enabled: true, favorite: true },
  { id: "import-preview", enabled: true, favorite: false },
  { id: "chats", enabled: true, favorite: false },
  { id: "projects", enabled: true, favorite: false },
  { id: "work", enabled: true, favorite: false },
  { id: "library", enabled: true, favorite: false },
  { id: "memory", enabled: false, favorite: false },
  { id: "skills", enabled: false, favorite: false },
  { id: "settings", enabled: false, favorite: false },
];

const actionSet = new Set<string>(HOME_QUICK_ACCESS_ACTIONS);

export function buildHomeQuickAccessBundle(items: readonly HomeQuickAccessItem[]): HomeQuickAccessBundle {
  return {
    schema: HOME_QUICK_ACCESS_SCHEMA,
    items: items.map(({ id, enabled, favorite }) => ({ id, enabled, favorite })),
  };
}

export function parseHomeQuickAccessBundle(source: string): HomeQuickAccessItem[] {
  if (source.length > HOME_QUICK_ACCESS_IMPORT_LIMIT) {
    throw new Error(`Quick Access bundle exceeds ${HOME_QUICK_ACCESS_IMPORT_LIMIT} characters.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Quick Access bundle is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Quick Access bundle must be an object.");
  }
  const record = parsed as Record<string, unknown>;
  if (record.schema !== HOME_QUICK_ACCESS_SCHEMA || !Array.isArray(record.items)) {
    throw new Error("Quick Access bundle schema is not supported.");
  }
  if (record.items.length !== HOME_QUICK_ACCESS_ACTIONS.length) {
    throw new Error("Quick Access bundle must include every known action exactly once.");
  }
  const seen = new Set<string>();
  const items: HomeQuickAccessItem[] = [];
  for (const candidate of record.items) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("Quick Access bundle contains an invalid item.");
    }
    const item = candidate as Record<string, unknown>;
    if (typeof item.id !== "string" || !actionSet.has(item.id) || seen.has(item.id)) {
      throw new Error("Quick Access bundle contains an unknown or duplicate action.");
    }
    if (typeof item.enabled !== "boolean" || typeof item.favorite !== "boolean") {
      throw new Error(`Quick Access action ${item.id} has invalid settings.`);
    }
    seen.add(item.id);
    items.push({ id: item.id as HomeQuickAccessActionId, enabled: item.enabled, favorite: item.favorite });
  }
  return items;
}
