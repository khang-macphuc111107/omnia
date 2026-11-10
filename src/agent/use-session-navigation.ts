import { useCallback, useEffect, useMemo, useState } from "react";

import { isDesktopRuntime } from "@/lib/desktop";
import { agentApi, errorMessage } from "./agent-api";
import { useAgentStore } from "./agent-store";
import { createBrowserSessionNavigationPort, SessionNavigationClient, type SessionNavigationSnapshot } from "./session-navigation";

function browserNavigationPort() {
  try {
    const storage = window.localStorage;
    return createBrowserSessionNavigationPort({
      getItem: (key) => storage.getItem(key),
      setItem: (key, value) => storage.setItem(key, value),
    });
  } catch {
    const values = new Map<string, string>();
    return createBrowserSessionNavigationPort({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
    });
  }
}

/** Native tab ordering hydrates independently of transcript loading. */
export function useSessionNavigation(ready: boolean, sessionIds: readonly string[], activeId: string | null) {
  const client = useMemo(() => new SessionNavigationClient(isDesktopRuntime() ? {
    load: () => agentApi.navigationLoad(),
    save: (request) => agentApi.navigationSave(request),
  } : browserNavigationPort(), (error) => useAgentStore.setState({ notice: `Session tabs could not be saved. ${errorMessage(error)}` })), []);
  const [snapshot, setSnapshot] = useState<SessionNavigationSnapshot>(client.snapshot);
  const sessionIdsKey = sessionIds.join("\u0000");

  useEffect(() => client.subscribe(setSnapshot), [client]);
  // Retain the normal home view at launch. Restoring open tabs does not
  // implicitly load a transcript or resume a provider run.
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    client.select(activeId);
  }, [activeId, client]);
  useEffect(() => {
    // The durable ordering contract is native-owned. Browser preview keeps
    // the local operation projection for this mounted window but does not
    // pretend that localStorage is an authoritative session database.
    if (!ready || !isDesktopRuntime()) return;
    client.prune(new Set(sessionIdsKey ? sessionIdsKey.split("\u0000") : []));
    void client.start().catch((error: unknown) => {
      useAgentStore.setState({ notice: `Session tabs could not be restored. ${errorMessage(error)}` });
    });
  }, [ready, sessionIdsKey, client]);

  const open = useCallback((id: string) => client.select(id), [client]);
  const close = useCallback((id: string) => {
    client.close(id);
    return client.snapshot.activeId;
  }, [client]);
  return { openIds: snapshot.openIds, open, close };
}
