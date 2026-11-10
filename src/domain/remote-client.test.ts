import { describe, expect, it } from "vitest";

import { DomainError } from "./errors";
import {
  acquireRemoteControlLease,
  authorizeRemoteCommand,
  createRemoteClientSession,
  createRemoteDeviceGrant,
  reauthenticateRemoteClientSession,
  releaseRemoteControlLease,
  type RemoteClientSession,
  type RemoteCommandDescriptor,
  type RemoteCommandEnvelope,
  type RemoteDeviceGrant,
} from "./remote-client";

const t0 = "2026-08-13T00:00:00.000Z";
const t1 = "2026-08-13T00:01:00.000Z";
const t2 = "2026-08-13T00:02:00.000Z";
const t2b = "2026-08-13T00:02:30.000Z";
const t3 = "2026-08-13T00:03:00.000Z";
const t4 = "2026-08-13T00:04:00.000Z";
const t10 = "2026-08-13T00:10:00.000Z";

function hash(character: string): string {
  return character.repeat(64);
}

function grant(overrides: Partial<RemoteDeviceGrant> = {}): RemoteDeviceGrant {
  return {
    schemaVersion: 1,
    id: "device-grant-1",
    revision: 1,
    revisionHash: hash("a"),
    hostId: "host-1",
    profileId: "profile-1",
    deviceId: "device-1",
    clientKind: "android",
    displayName: "Khang phone",
    permissions: [
      "projection.read",
      "run.start",
      "approval.read",
      "approval.respond",
      "screen.view",
      "screen.input",
      "terminal.view",
      "terminal.input",
    ],
    userVerificationPermissions: [
      "approval.respond",
      "screen.input",
      "terminal.input",
    ],
    scope: {
      kind: "restricted",
      projectIds: ["project-1"],
      conversationIds: ["conversation-standalone"],
      environmentIds: ["environment-1"],
    },
    sessionPolicy: {
      maximumConcurrentSessions: 2,
      maximumSessionDurationMs: 24 * 60 * 60 * 1_000,
      idleTimeoutMs: 30 * 60 * 1_000,
      commandLifetimeMs: 60_000,
      maximumClockSkewMs: 30_000,
      userVerificationWindowMs: 5 * 60 * 1_000,
    },
    createdAt: t0,
    expiresAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

function session(deviceGrant = grant()): RemoteClientSession {
  return createRemoteClientSession(deviceGrant, {
    id: "session-1",
    connectionEpoch: 1,
    authenticationStrength: "device-key",
    authenticatedAt: t1,
    expiresAt: "2026-08-13T12:00:00.000Z",
    existingSessions: [],
  });
}

function envelope(overrides: Partial<RemoteCommandEnvelope> = {}): RemoteCommandEnvelope {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    hostId: "host-1",
    profileId: "profile-1",
    deviceId: "device-1",
    connectionEpoch: 1,
    counter: 1,
    commandId: "command-1",
    commandType: "run.start",
    commandHash: hash("b"),
    issuedAt: t2,
    expiresAt: t3,
    ...overrides,
  };
}

const startRunDescriptor: RemoteCommandDescriptor = {
  commandType: "run.start",
  permission: "run.start",
  allowedTargetKinds: ["conversation"],
  requiresUserVerification: false,
};

describe("remote client trust boundary", () => {
  it("requires prerequisite permissions and fresh verification for high-impact grants", () => {
    expect(() =>
      createRemoteDeviceGrant(
        grant({
          permissions: ["screen.input"],
          userVerificationPermissions: ["screen.input"],
        }),
      ),
    ).toThrowError(DomainError);

    expect(() =>
      createRemoteDeviceGrant(
        grant({
          userVerificationPermissions: ["approval.respond", "terminal.input"],
        }),
      ),
    ).toThrowError(DomainError);
  });

  it("rejects an expired or revoked grant before a session is issued", () => {
    expect(() =>
      createRemoteClientSession(grant({ revokedAt: t1 }), {
        id: "session-1",
        connectionEpoch: 1,
        authenticationStrength: "device-key",
        authenticatedAt: t2,
        expiresAt: t10,
        existingSessions: [],
      }),
    ).toThrowError(DomainError);
  });

  it("binds commands to the exact host, device, session, grant revision, and connection epoch", () => {
    const deviceGrant = grant();
    const activeSession = session(deviceGrant);
    expect(() =>
      authorizeRemoteCommand({
        grant: deviceGrant,
        session: activeSession,
        envelope: envelope({ connectionEpoch: 2 }),
        descriptor: startRunDescriptor,
        resolvedScope: {
          kind: "conversation",
          profileId: "profile-1",
          conversationId: "conversation-standalone",
        },
        acceptedCommands: [],
        now: t2,
      }),
    ).toThrowError(DomainError);

    expect(() =>
      authorizeRemoteCommand({
        grant: grant({ revision: 2, revisionHash: hash("c") }),
        session: activeSession,
        envelope: envelope(),
        descriptor: startRunDescriptor,
        resolvedScope: {
          kind: "conversation",
          profileId: "profile-1",
          conversationId: "conversation-standalone",
        },
        acceptedCommands: [],
        now: t2,
      }),
    ).toThrowError(DomainError);
  });

  it("authorizes only repository-resolved lineage inside the grant scope", () => {
    const deviceGrant = grant();
    const activeSession = session(deviceGrant);
    const allowed = authorizeRemoteCommand({
      grant: deviceGrant,
      session: activeSession,
      envelope: envelope(),
      descriptor: startRunDescriptor,
      resolvedScope: {
        kind: "conversation",
        profileId: "profile-1",
        projectId: "project-1",
        conversationId: "conversation-in-project",
      },
      acceptedCommands: [],
      now: t2,
    });
    expect(allowed.outcome).toBe("accepted");

    expect(() =>
      authorizeRemoteCommand({
        grant: deviceGrant,
        session: activeSession,
        envelope: envelope(),
        descriptor: startRunDescriptor,
        resolvedScope: {
          kind: "conversation",
          profileId: "profile-1",
          projectId: "project-2",
          conversationId: "conversation-2",
        },
        acceptedCommands: [],
        now: t2,
      }),
    ).toThrowError(DomainError);
  });

  it("accepts a lost-response retry only when the command ID and canonical fact are identical", () => {
    const deviceGrant = grant();
    const activeSession = session(deviceGrant);
    const first = authorizeRemoteCommand({
      grant: deviceGrant,
      session: activeSession,
      envelope: envelope(),
      descriptor: startRunDescriptor,
      resolvedScope: {
        kind: "conversation",
        profileId: "profile-1",
        conversationId: "conversation-standalone",
      },
      acceptedCommands: [],
      now: t2,
    });
    const replay = authorizeRemoteCommand({
      grant: deviceGrant,
      session: first.session,
      envelope: envelope(),
      descriptor: startRunDescriptor,
      resolvedScope: {
        kind: "conversation",
        profileId: "profile-1",
        conversationId: "conversation-standalone",
      },
      acceptedCommands: [first.command],
      now: t2b,
    });
    expect(replay.outcome).toBe("idempotent-replay");
    expect(replay.session.lastAcceptedCounter).toBe(1);

    expect(() =>
      authorizeRemoteCommand({
        grant: deviceGrant,
        session: first.session,
        envelope: envelope({ commandHash: hash("c") }),
        descriptor: startRunDescriptor,
        resolvedScope: {
          kind: "conversation",
          profileId: "profile-1",
          conversationId: "conversation-standalone",
        },
        acceptedCommands: [first.command],
        now: t2b,
      }),
    ).toThrowError(DomainError);
  });

  it("rejects a skipped or stale command counter without a matching idempotency receipt", () => {
    const deviceGrant = grant();
    const activeSession = session(deviceGrant);
    expect(() =>
      authorizeRemoteCommand({
        grant: deviceGrant,
        session: activeSession,
        envelope: envelope({ counter: 2 }),
        descriptor: startRunDescriptor,
        resolvedScope: {
          kind: "conversation",
          profileId: "profile-1",
          conversationId: "conversation-standalone",
        },
        acceptedCommands: [],
        now: t2,
      }),
    ).toThrowError(DomainError);
  });

  it("requires recent user verification before approval or direct-input commands", () => {
    const deviceGrant = grant();
    const deviceKeySession = session(deviceGrant);
    const descriptor: RemoteCommandDescriptor = {
      commandType: "approval.respond",
      permission: "approval.respond",
      allowedTargetKinds: ["run"],
      requiresUserVerification: true,
    };
    const approvalEnvelope = envelope({
      commandType: "approval.respond",
      commandId: "approval-command",
    });
    const scope = {
      kind: "run" as const,
      profileId: "profile-1",
      runId: "run-1",
      conversationId: "conversation-standalone",
    };
    expect(() =>
      authorizeRemoteCommand({
        grant: deviceGrant,
        session: deviceKeySession,
        envelope: approvalEnvelope,
        descriptor,
        resolvedScope: scope,
        acceptedCommands: [],
        now: t2,
      }),
    ).toThrowError(DomainError);

    const verified = reauthenticateRemoteClientSession(deviceKeySession, t2);
    expect(
      authorizeRemoteCommand({
        grant: deviceGrant,
        session: verified,
        envelope: approvalEnvelope,
        descriptor,
        resolvedScope: scope,
        acceptedCommands: [],
        now: t2,
      }).outcome,
    ).toBe("accepted");
  });

  it("permits one input controller per screen or terminal resource", () => {
    const firstSession = reauthenticateRemoteClientSession(session(), t2);
    const firstLease = acquireRemoteControlLease([], {
      id: "lease-1",
      session: firstSession,
      environmentId: "environment-1",
      resourceId: "display-1",
      surface: "screen-input",
      now: t2,
      expiresAt: t4,
    });
    const secondSession = {
      ...firstSession,
      id: "session-2",
      deviceId: "device-2",
    };
    expect(() =>
      acquireRemoteControlLease([firstLease], {
        id: "lease-2",
        session: secondSession,
        environmentId: "environment-1",
        resourceId: "display-1",
        surface: "screen-input",
        now: t3,
        expiresAt: t4,
      }),
    ).toThrowError(DomainError);

    const released = releaseRemoteControlLease(firstLease, firstSession, t3);
    expect(
      acquireRemoteControlLease([released], {
        id: "lease-2",
        session: secondSession,
        environmentId: "environment-1",
        resourceId: "display-1",
        surface: "screen-input",
        now: t3,
        expiresAt: t4,
      }).sessionId,
    ).toBe("session-2");
  });
});
