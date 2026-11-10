import {
  createDefaultCommandRegistry,
  dispatchCommand,
  resolveCommand,
  searchCommands,
  type OmniaCommandCategory,
  type OmniaCommandContext,
  type OmniaCommandDescriptor,
  type OmniaCommandDispatchResult,
  type OmniaCommandRegistry,
  type OmniaCommandScope,
  type OmniaCommandStatus,
} from "../../domain/omnia-command-registry";
import type { CommandId } from "../../domain/ids";

/**
 * Small renderer-facing projection of the domain command descriptor.
 *
 * The existing command palette owns UI-specific closures (navigation, store
 * updates, and overlays). This adapter deliberately does not replace those
 * closures. It gives a newer surface a stable, serializable command list and
 * one typed invocation boundary without importing React or native APIs.
 */
export type WorkspacePaletteCommand = Readonly<{
  id: CommandId;
  title: string;
  description: string;
  category: OmniaCommandCategory;
  scope: OmniaCommandScope;
  status: OmniaCommandStatus;
  shortcut?: string;
  keywords: readonly string[];
  aliases: readonly string[];
  effect: OmniaCommandDescriptor["effect"];
  requiresSelection: boolean;
  /** Dispatches a local intent or editor operation using the supplied context. */
  invoke: (context?: OmniaCommandContext) => OmniaCommandDispatchResult;
}>;

export type WorkspacePaletteCommandOptions = Readonly<{
  /** Keep preview commands visible; unavailable commands remain hidden by default. */
  statuses?: readonly OmniaCommandStatus[];
  category?: OmniaCommandCategory;
  scope?: OmniaCommandScope;
  limit?: number;
}>;

function projectCommand(
  registry: OmniaCommandRegistry,
  descriptor: OmniaCommandDescriptor,
): WorkspacePaletteCommand {
  return Object.freeze({
    id: descriptor.id,
    title: descriptor.label,
    description: descriptor.description,
    category: descriptor.category,
    scope: descriptor.scope,
    status: descriptor.status,
    ...(descriptor.shortcut === undefined ? {} : { shortcut: descriptor.shortcut }),
    keywords: descriptor.keywords,
    aliases: descriptor.aliases,
    effect: descriptor.effect,
    requiresSelection: descriptor.requiresSelection,
    invoke: (context: OmniaCommandContext = {}) => dispatchCommand(registry, descriptor.id, context),
  });
}

/**
 * Returns command palette items from a domain registry.
 *
 * The default status filter intentionally keeps `available` and `preview`
 * commands visible. Preview commands are useful for UI-first development and
 * dispatch to a typed intent; unavailable commands are only surfaced when a
 * caller explicitly requests them.
 */
export function createWorkspacePaletteCommands(
  registry: OmniaCommandRegistry = createDefaultCommandRegistry(),
  options: WorkspacePaletteCommandOptions = {},
): readonly WorkspacePaletteCommand[] {
  const statuses = options.statuses ?? ["available", "preview"];
  const commands = searchCommands(registry, "", {
    ...(options.category === undefined ? {} : { category: options.category }),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  }).filter((command) => statuses.includes(command.status));
  return Object.freeze(commands.map((command) => projectCommand(registry, command)));
}

/** Resolves and invokes a command without throwing for a missing palette entry. */
export function invokeWorkspacePaletteCommand(
  registry: OmniaCommandRegistry,
  query: CommandId | string,
  context: OmniaCommandContext = {},
): OmniaCommandDispatchResult | undefined {
  const command = resolveCommand(registry, query);
  return command === undefined ? undefined : dispatchCommand(registry, command.id, context);
}
