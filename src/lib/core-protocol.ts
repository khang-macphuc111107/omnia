export const OMNIA_PROTOCOL_VERSION = "1.0" as const;

export const OMNIA_CLIENT_CAPABILITIES = ["run.stream.v1"] as const;

export interface CoreInitializeRequest {
  protocolVersion: typeof OMNIA_PROTOCOL_VERSION;
  clientInfo: {
    name: string;
    title: string;
    version: string;
  };
  capabilities: readonly string[];
}

export interface CoreRuntimeInfo {
  protocolVersion: string;
  serverInfo: {
    name: string;
    title: string;
    version: string;
  };
  capabilities: string[];
  unavailableCapabilities: string[];
  sessionToken: string | null;
  sessionEpoch: number | null;
}

/**
 * Stable envelope for every future core event. The monotonically increasing
 * cursor makes reconnection replayable; eventId makes reducers idempotent.
 */
export interface CoreEventEnvelope<TType extends string, TPayload> {
  protocolVersion: typeof OMNIA_PROTOCOL_VERSION;
  cursor: number;
  eventId: string;
  occurredAt: string;
  type: TType;
  projectId?: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  runId?: string;
  payload: TPayload;
}

export function createDesktopInitializeRequest(appVersion: string): CoreInitializeRequest {
  return {
    protocolVersion: OMNIA_PROTOCOL_VERSION,
    clientInfo: {
      name: "omnia-desktop",
      title: "Omnia Desktop",
      version: appVersion,
    },
    capabilities: OMNIA_CLIENT_CAPABILITIES,
  };
}

export function assertCompatibleCore(response: CoreRuntimeInfo): void {
  if (response.protocolVersion !== OMNIA_PROTOCOL_VERSION) {
    throw new Error(
      `Omnia Core protocol ${response.protocolVersion} is incompatible with desktop protocol ${OMNIA_PROTOCOL_VERSION}.`,
    );
  }

  for (const capability of OMNIA_CLIENT_CAPABILITIES) {
    if (!response.capabilities.includes(capability)) {
      throw new Error(`Omnia Core is missing required capability ${capability}.`);
    }
  }
}

export function assertCompatibleNativeCore(
  response: CoreRuntimeInfo,
): asserts response is CoreRuntimeInfo & { sessionToken: string; sessionEpoch: number } {
  assertCompatibleCore(response);
  if (!response.sessionToken || !/^[0-9a-f]{64}$/.test(response.sessionToken)) {
    throw new Error("Omnia Core returned an invalid IPC session token.");
  }
  if (
    response.sessionEpoch === null
    || !Number.isSafeInteger(response.sessionEpoch)
    || response.sessionEpoch <= 0
  ) {
    throw new Error("Omnia Core returned an invalid IPC session epoch.");
  }
}
