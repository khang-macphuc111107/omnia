import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { invokeCore } from "@/lib/desktop";

export const UPDATE_EVENT = "omnia-update";

export interface UpdateSettings {
  feedUrl: string;
  autoCheck: boolean;
  currentVersion: string;
  /** A valid release-signing public key is compiled in. Says nothing about any particular release. */
  keyConfigured: boolean;
  /** A key is compiled in but malformed: updates are refused. */
  keyInvalid: boolean;
  /** First 16 hex chars of SHA-256 of the compiled-in key (null when none/invalid). */
  keyFingerprint: string | null;
  /** User explicitly trusts this feed without signatures (only effective with no key). */
  allowUnsigned: boolean;
  /** Unsigned updates are explicitly allowed and effective (no key compiled in). */
  unsignedAllowed: boolean;
  availableVersion: string | null;
  /** Id of the pending candidate (events about other candidates are ignored). */
  availableCandidate: number | null;
  /** Set only on a save response: the backend dropped its pending release; return to the check state. */
  pendingReset: boolean;
  generation: number;
  platform: string;
}

export interface UpdateCheckResult {
  current: string;
  latest: string;
  available: boolean;
  notes: string;
  size: number;
  /** This release's signature was verified against the built-in key. */
  signatureVerified: boolean;
  candidate: number;
  generation: number;
  pubDate: string | null;
}

export interface UpdateEventPayload {
  kind: "available" | "progress" | "ready" | "error";
  received: number;
  total: number;
  version?: string;
  message?: string;
  /** Missing identity is never accepted as a current download event. */
  candidate?: number;
  generation: number;
  operationId?: string;
}

export const updateApi = {
  getSettings: () => invokeCore<UpdateSettings>("update_get_settings"),
  /** `allowUnsigned` omitted keeps the stored value; a changed feed always resets it to off. */
  setSettings: (feedUrl: string, autoCheck: boolean, allowUnsigned?: boolean) =>
    invokeCore<UpdateSettings>("update_set_settings", {
      request: allowUnsigned === undefined ? { feedUrl, autoCheck } : { feedUrl, autoCheck, allowUnsigned },
    }),
  check: () => invokeCore<UpdateCheckResult>("update_check"),
  download: (expectedCandidateId: number, generation: number, operationId: string) =>
    invokeCore<void>("update_download", { expectedCandidateId, generation, operationId }),
  install: (expectedCandidateId: number) => invokeCore<void>("update_install", { expectedCandidateId }),
  onEvent(handler: (payload: UpdateEventPayload) => void): Promise<UnlistenFn> {
    return listen<UpdateEventPayload>(UPDATE_EVENT, (event) => handler(event.payload));
  },
};
