import { describe, expect, it } from "vitest";

import { desktop, isDesktopRuntime } from "./desktop";

describe("desktop bridge", () => {
  it("uses a safe browser fallback outside Tauri", async () => {
    expect(isDesktopRuntime()).toBe(false);
    const info = await desktop.runtimeInfo();
    expect(info.appName).toBe("Omnia");
    expect(info.platform).toBe("web");
    expect(info.tauri).toBe(false);
  });

  it("does not emulate privileged native services in a browser", async () => {
    await expect(desktop.listProjects()).rejects.toThrow("requires the Tauri desktop runtime");
    await expect(desktop.pickWorkspaceFolder()).rejects.toThrow(
      "requires the Tauri desktop runtime",
    );
    await expect(desktop.pickAttachments({
      conversationId: "conversation_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      branchId: "branch_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    })).rejects.toThrow("requires the Tauri desktop runtime");
    await expect(
      desktop.getAttachmentDraft("attachment_draft_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ).rejects.toThrow("requires the Tauri desktop runtime");
    await expect(desktop.listAttachments()).rejects.toThrow(
      "requires the Tauri desktop runtime",
    );
    await expect(desktop.readAttachmentBinaryPreview({
      attachmentId: "attachment_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    })).rejects.toThrow("requires the Tauri desktop runtime");
    await expect(
      desktop.saveProviderProfile({
        providerType: "openai_compatible",
        displayName: "Never persisted",
        baseUrl: "https://example.com/v1",
        secret: "not-written",
      }),
    ).rejects.toThrow("requires the Tauri desktop runtime");
  });

  it("fails closed for isolated input and broker-fed downloads in a browser", async () => {
    const desktopOnlyMessage = "requires the Tauri desktop runtime";

    await expect(desktop.isolatedInputCapabilities()).rejects.toThrow(desktopOnlyMessage);
    await expect(
      desktop.createIsolatedInputSession({
        targetKind: "window",
        targetRef: "window-preview",
        mode: "visible",
        leaseMs: 5_000,
        userAuthorized: true,
        authorizationReceiptId: "auth-preview",
      }),
    ).rejects.toThrow(desktopOnlyMessage);
    await expect(
      desktop.readIsolatedInputSession({ sessionId: "session-preview" }),
    ).rejects.toThrow(desktopOnlyMessage);
    await expect(
      desktop.stopIsolatedInputSession({ sessionId: "session-preview" }),
    ).rejects.toThrow(desktopOnlyMessage);
    await expect(
      desktop.attachIsolatedInputChannel({ sessionId: "session-preview" }),
    ).rejects.toThrow(desktopOnlyMessage);
    await expect(
      desktop.detachIsolatedInputChannel({ channelId: "channel-preview" }),
    ).rejects.toThrow(desktopOnlyMessage);
    await expect(
      desktop.sendIsolatedInputEvent({
        channelId: "channel-preview",
        event: {
          kind: "keyboard",
          phase: "text",
          code: "KeyA",
          key: "a",
          text: "a",
        },
      }),
    ).rejects.toThrow(desktopOnlyMessage);

    await expect(
      desktop.createDownloadJob({
        sourceReceiptId: "source-preview",
        outputFilename: "preview.bin",
        mediaType: "application/octet-stream",
      }),
    ).rejects.toThrow(desktopOnlyMessage);
    await expect(desktop.startDownloadJob({ jobId: "download-preview" })).rejects.toThrow(
      desktopOnlyMessage,
    );
    await expect(desktop.pauseDownloadJob({ jobId: "download-preview" })).rejects.toThrow(
      desktopOnlyMessage,
    );
    await expect(desktop.resumeDownloadJob({ jobId: "download-preview" })).rejects.toThrow(
      desktopOnlyMessage,
    );
    await expect(desktop.cancelDownloadJob({ jobId: "download-preview" })).rejects.toThrow(
      desktopOnlyMessage,
    );
    await expect(
      desktop.appendDownloadChunk({ jobId: "download-preview", chunk: [1, 2, 3] }),
    ).rejects.toThrow(desktopOnlyMessage);
    await expect(desktop.completeDownloadJob({ jobId: "download-preview" })).rejects.toThrow(
      desktopOnlyMessage,
    );
    await expect(desktop.getDownloadJob({ jobId: "download-preview" })).rejects.toThrow(
      desktopOnlyMessage,
    );
    await expect(desktop.listDownloadJobs()).rejects.toThrow(desktopOnlyMessage);
  });

  it("does not emulate authoritative task or starter-workflow services in a browser", async () => {
    const desktopOnlyMessage = "requires the Tauri desktop runtime";

    await expect(desktop.runtimeOperationAppend({
      operationId: "runtime_operation_preview_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      targetKind: "goal",
      targetId: "goal_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      operationKind: "queue",
      effectClass: "reversible_write",
      expectedHeadVersion: 0,
      idempotencyKey: "runtime-preview",
      payloadJson: "{}",
    })).rejects.toThrow(desktopOnlyMessage);
    await expect(
      desktop.readRuntimeOutbox("runtime_operation_preview_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ).rejects.toThrow(desktopOnlyMessage);

    await expect(desktop.createTask({
      goalId: "goal_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      title: "Preview task",
      idempotencyKey: "task-create-preview",
    })).rejects.toThrow(desktopOnlyMessage);
    await expect(desktop.readTask({
      taskId: "task_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    })).rejects.toThrow(desktopOnlyMessage);
    await expect(desktop.listTasks()).rejects.toThrow(desktopOnlyMessage);
    await expect(desktop.readTaskRevision({
      taskId: "task_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      revisionId: "task_revision_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    })).rejects.toThrow(desktopOnlyMessage);
    await expect(desktop.createTaskRevision({
      taskId: "task_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      payloadJson: "{}",
      idempotencyKey: "task-revision-preview",
    })).rejects.toThrow(desktopOnlyMessage);
    await expect(desktop.updateTaskStatus({
      taskId: "task_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      status: "ready",
      idempotencyKey: "task-status-preview",
    })).rejects.toThrow(desktopOnlyMessage);
    await expect(desktop.createTaskDependency({
      fromTaskId: "task_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      toTaskId: "task_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      dependencyKind: "blocks",
    })).rejects.toThrow(desktopOnlyMessage);
    await expect(desktop.listTaskDependencies({
      taskId: "task_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    })).rejects.toThrow(desktopOnlyMessage);

    await expect(desktop.createStarterWorkflow({
      name: "preview-workflow",
      title: "Preview workflow",
      definitionJson: "{}",
      idempotencyKey: "workflow-create-preview",
    })).rejects.toThrow(desktopOnlyMessage);
    await expect(desktop.readStarterWorkflow({
      starterWorkflowId: "starter_workflow_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    })).rejects.toThrow(desktopOnlyMessage);
    await expect(desktop.listStarterWorkflows()).rejects.toThrow(desktopOnlyMessage);
    await expect(desktop.readStarterWorkflowRevision({
      starterWorkflowId: "starter_workflow_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      revisionId: "starter_workflow_revision_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    })).rejects.toThrow(desktopOnlyMessage);
    await expect(desktop.createStarterWorkflowRevision({
      starterWorkflowId: "starter_workflow_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      definitionJson: "{}",
      idempotencyKey: "workflow-revision-preview",
    })).rejects.toThrow(desktopOnlyMessage);
    await expect(desktop.updateStarterWorkflowStatus({
      starterWorkflowId: "starter_workflow_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      status: "active",
      idempotencyKey: "workflow-status-preview",
    })).rejects.toThrow(desktopOnlyMessage);
    await expect(desktop.updateStarterWorkflowEnabled({
      starterWorkflowId: "starter_workflow_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      enabled: true,
      idempotencyKey: "workflow-enabled-preview",
    })).rejects.toThrow(desktopOnlyMessage);
  });

  it("validates BYOK connection policy without persisting browser-preview credentials", async () => {
    const result = await desktop.preflightProviderConnection({
      providerType: "openai_compatible",
      displayName: "Preview provider",
      baseUrl: "https://example.com/v1",
      authScheme: "bearer",
      secret: "preview-only",
    });
    expect(result.healthy).toBe(true);
    expect(result.normalizedBaseUrl).toBe("https://example.com/v1");
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.warning).toContain("Preview validation");
  });

  it("requires an explicit local-network grant for local providers", async () => {
    await expect(
      desktop.preflightProviderConnection({
        providerType: "openai_compatible",
        displayName: "Local",
        baseUrl: "http://127.0.0.1:11434/v1",
        authScheme: "none",
      }),
    ).rejects.toThrow("explicit grant");
  });

  it.each([
    ["azure_openai", "Azure OpenAI"],
    ["custom_adapter", "Custom adapters"],
  ])("does not fabricate preview support for %s", async (providerType, label) => {
    await expect(
      desktop.preflightProviderConnection({
        providerType,
        displayName: label,
        baseUrl: "https://example.com/v1",
        authScheme: "bearer",
        secret: "preview-only",
      }),
    ).rejects.toThrow(/planned and unavailable/i);
  });
});
