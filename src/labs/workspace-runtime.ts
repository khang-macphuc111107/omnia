import { useCallback, useEffect, useState } from "react";

import { conversationsFromNativeSnapshots } from "@/features/workspace/conversation-catalog";
import {
  attachmentViewsFromDesktopRecords,
  openDraftAttachmentIds,
} from "@/features/workspace/attachment-catalog";
import { providerFromNativeProfile } from "@/features/workspace/provider-catalog";
import { projectsFromNativeRecords } from "@/features/workspace/project-catalog";
import { useWorkspaceStore } from "@/features/workspace/store";
import { replayRunJournalIntoStore } from "@/features/workspace/run-journal-sync";
import { startRunEventJournalBuffer } from "@/features/workspace/run-event-broker";
import type { CoreRuntimeInfo } from "@/lib/core-protocol";
import { desktop, type AppRuntimeInfo } from "@/lib/desktop";
import { createOmniaRuntimeBridge, type OmniaRuntimeBridge } from "@/runtime/omnia-runtime-bridge";

/**
 * Hydrates the renderer projection from native-owned workspace state.
 *
 * Exported for a focused startup regression test (re-exported from
 * `labs-app`). The function still remains an internal application boundary:
 * callers must treat native snapshots and attachment metadata as
 * authoritative and must not persist renderer-only selections back into the
 * native catalog from here.
 */
export async function hydrateNativeWorkspace(): Promise<void> {
  try {
    const [records, grants, snapshots, profiles, nativeAttachmentRecords] = await Promise.all([
      desktop.listProjects(),
      desktop.listWorkspaceGrants(),
      desktop.listConversations(),
      desktop.listProviderProfiles(),
      desktop.listAttachments(),
    ]);
    const resolvedSnapshots = snapshots.length > 0 ? snapshots : [await desktop.createConversation()];
    const providers = profiles.map(providerFromNativeProfile);
    const hydratedAttachments = attachmentViewsFromDesktopRecords(nativeAttachmentRecords);
    const {
      replaceConversations,
      replaceAttachments,
      replaceProjects,
      replaceProviders,
      hydrateDraftAttachmentSelections,
    } = useWorkspaceStore.getState();
    replaceProviders(providers);
    replaceAttachments(hydratedAttachments);
    const conversations = conversationsFromNativeSnapshots(
      resolvedSnapshots,
      records,
      providers,
      hydratedAttachments,
    );
    replaceConversations(conversations);
    replaceProjects(projectsFromNativeRecords(records, grants, conversations));

    // Draft attachments are durable native selections, not renderer
    // preferences. Rehydrate only open drafts pinned to each conversation's
    // active branch; terminal or foreign-branch drafts remain unavailable.
    const draftSelections = await Promise.all(
      resolvedSnapshots.map(async (snapshot) => {
        const scope = {
          conversationId: snapshot.conversation.id,
          branchId: snapshot.conversation.activeBranchId,
        };
        try {
          const drafts = await desktop.listAttachmentDrafts({
            ...scope,
            includeTerminal: false,
          });
          return {
            ...scope,
            attachmentIds: openDraftAttachmentIds(drafts, scope),
          };
        } catch {
          // A failed metadata read must not fabricate a selection. The
          // conversation still hydrates, while the composer stays fail-closed.
          return { ...scope, attachmentIds: [] };
        }
      }),
    );
    hydrateDraftAttachmentSelections(draftSelections);

    // Rehydrate the inspector from the native journal without replaying text
    // deltas into the already materialized conversation projection. This makes
    // missed renderer notifications recoverable after reconnect/restart while
    // keeping the SQLite message projection authoritative. The replay helper
    // pins a fixed watermark and follows all pages, rather than only reading
    // the first page of a large journal.
    const runIds = resolvedSnapshots
      .flatMap((snapshot) => snapshot.runs.slice(-8).map((run) => run.id))
      .slice(-64);
    useWorkspaceStore.getState().replaceRunTimelineEvents([]);
    await Promise.all(runIds.map((runId) => replayRunJournalIntoStore(runId, { baseline: true })));
  } catch {
    useWorkspaceStore.getState().replaceConversations([]);
    // Do not leave a stale attachment catalog or draft selection visible when
    // the native startup snapshot cannot be trusted. Attachment metadata is
    // native-owned, so the safe recovery state is an empty catalog rather
    // than a renderer-side copy from a previous session.
    useWorkspaceStore.getState().replaceAttachments([]);
    useWorkspaceStore.getState().replaceProjects([]);
    useWorkspaceStore.getState().replaceProviders([]);
    useWorkspaceStore.getState().replaceRunTimelineEvents([]);
  }
}

export interface WorkspaceRuntime {
  runtime: AppRuntimeInfo;
  coreRuntime: CoreRuntimeInfo;
}

export function describeStartupError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return "Unknown startup error";
}

let pending: Promise<WorkspaceRuntime> | null = null;
let resolved: WorkspaceRuntime | null = null;
// The bridge lives for the process once negotiation succeeds; the workspace
// screens are mounted/unmounted freely by the agent shell and must not tear
// down (and re-negotiate) the runtime on every view switch.
let bridge: OmniaRuntimeBridge | null = null;

async function initializeWorkspaceRuntime(): Promise<WorkspaceRuntime> {
  const nextBridge = createOmniaRuntimeBridge();
  try {
    const { snapshot } = await nextBridge.initialize();
    // The bridge is the renderer composition boundary for runtime
    // negotiation. Keep the native workspace hydration below on its
    // existing authoritative path; the bridge only decides which host
    // capabilities are available and does not persist browser state.
    const info = snapshot.runtimeInfo;
    const coreInfo = snapshot.core;
    if (!info || !coreInfo) {
      throw new Error("Omnia runtime negotiation returned no runtime metadata.");
    }
    if (info.tauri) {
      useWorkspaceStore.getState().prepareDesktopPreview();
      // Install the one process-wide advisory listener before reading any
      // finite journal watermark. Native replay remains authoritative;
      // the listener only retains durable records that arrive during the
      // renderer handoff window.
      await startRunEventJournalBuffer();
      await hydrateNativeWorkspace();
    }
    bridge = nextBridge;
    return { runtime: info, coreRuntime: coreInfo };
  } catch (cause) {
    void nextBridge.dispose();
    throw cause;
  }
}

/**
 * Negotiates the workspace runtime and hydrates native state once per
 * process. Concurrent callers share one in-flight promise; a failure clears
 * the memo so a later call (retry) starts a fresh attempt.
 */
export function ensureWorkspaceRuntime(): Promise<WorkspaceRuntime> {
  if (!pending) {
    pending = initializeWorkspaceRuntime().then(
      (value) => {
        resolved = value;
        return value;
      },
      (cause: unknown) => {
        pending = null;
        throw cause;
      },
    );
  }
  return pending;
}

/** Test-only: forget the memoized runtime so each test starts cold. */
export function resetWorkspaceRuntimeForTests(): void {
  const current = bridge;
  pending = null;
  resolved = null;
  bridge = null;
  if (current) void current.dispose();
}

export interface WorkspaceRuntimeState {
  runtime: AppRuntimeInfo | null;
  coreRuntime: CoreRuntimeInfo | null;
  error: string | null;
  retry: () => void;
}

export function useWorkspaceRuntime(): WorkspaceRuntimeState {
  const [value, setValue] = useState<WorkspaceRuntime | null>(() => resolved);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (value) return;
    let mounted = true;
    ensureWorkspaceRuntime().then(
      (next) => {
        if (mounted) setValue(next);
      },
      (cause: unknown) => {
        if (mounted) setError(describeStartupError(cause));
      },
    );
    return () => {
      mounted = false;
    };
  }, [attempt, value]);

  const retry = useCallback(() => {
    setError(null);
    setAttempt((current) => current + 1);
  }, []);

  return {
    runtime: value?.runtime ?? null,
    coreRuntime: value?.coreRuntime ?? null,
    error,
    retry,
  };
}
