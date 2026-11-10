export interface PortableSessionMessage { role: "user" | "assistant" | "tool"; content: string; createdAtMs?: number; }
export interface PortableSession { schemaVersion: 1; id: string; title: string; cwd?: string; model?: string; messages: PortableSessionMessage[]; exportedAtMs: number; }

const secretPattern = /(api[_ -]?key|token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi;
export function redactSecrets(value: string): string { return value.replace(secretPattern, (_match, label: string) => `${label}: [redacted]`); }
export function normalizePortableSession(value: unknown): PortableSession {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  const session: PortableSession = {
    schemaVersion: 1,
    id: typeof raw.id === "string" ? raw.id : "imported",
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "Imported session",
    messages: messages.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as Record<string, unknown>;
      const role = item.role === "assistant" || item.role === "tool" ? item.role : "user";
      return [{ role, content: redactSecrets(typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? "")), ...(typeof item.createdAtMs === "number" ? { createdAtMs: item.createdAtMs } : {}) }];
    }),
    exportedAtMs: typeof raw.exportedAtMs === "number" ? raw.exportedAtMs : Date.now(),
  };
  if (typeof raw.cwd === "string") session.cwd = raw.cwd;
  if (typeof raw.model === "string") session.model = raw.model;
  return session;
}
export function exportSessionJson(session: PortableSession): string { return JSON.stringify(normalizePortableSession(session), null, 2); }
export function exportSessionMarkdown(session: PortableSession): string { const normalized = normalizePortableSession(session); return [`# ${normalized.title}`, ``, `- Session: \`${normalized.id}\``, normalized.cwd ? `- Folder: \`${normalized.cwd}\`` : "", normalized.model ? `- Model: \`${normalized.model}\`` : "", ``, ...normalized.messages.map((message) => `## ${message.role}\n\n${message.content}`)].filter(Boolean).join("\n"); }
