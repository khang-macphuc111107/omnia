import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  buildProjectOverviewActions,
  ProjectOverviewActionCenter,
} from "./project-overview-action-center";
import type { ProjectOverviewChat } from "./project-overview";
import type { ProjectOverviewView } from "./types";

function overview(overrides: Partial<ProjectOverviewView> = {}): ProjectOverviewView {
  return {
    overviewRevisionId: null,
    projectTwinRevisionId: null,
    sourceEventWatermark: null,
    status: "unknown",
    title: "Project preview",
    subtitle: null,
    summary: "Renderer-local overview.",
    goal: null,
    nonGoals: [],
    phase: "UI wave",
    milestone: null,
    nextTask: "Inspect the action center",
    activeBranch: null,
    workspaceRootCount: 0,
    repositoryBranch: null,
    worktree: null,
    verifiedEvidence: [],
    staleNodeCount: null,
    runtimeLabel: null,
    modelProfileId: null,
    contextRevisionId: null,
    budgetLabel: null,
    backgroundWorkLabel: null,
    approvalsLabel: null,
    attentionItems: ["Confirm native receipt coverage"],
    recentChanges: [],
    ...overrides,
  };
}

function chat(overrides: Partial<ProjectOverviewChat> = {}): ProjectOverviewChat {
  return {
    id: "chat-1",
    title: "Latest project Chat",
    excerpt: "Continue the visible work.",
    updatedLabel: "just now",
    archived: false,
    unread: true,
    hasDraft: false,
    runState: null,
    ...overrides,
  };
}

describe("ProjectOverviewActionCenter", () => {
  it("derives bounded actions from overview facts and keeps host gaps planned", () => {
    const actions = buildProjectOverviewActions({
      overview: overview(),
      contextHealth: "missing-access",
      recentChats: [chat()],
    });

    expect(actions.map((action) => action.id)).toEqual([
      "overview-refresh-candidate",
      "overview-context-readiness",
      "overview-attention-items",
      "overview-next-task",
      "overview-evidence-gap",
      "overview-latest-chat",
    ]);
    expect(actions.find((action) => action.id === "overview-context-readiness")).toMatchObject({
      status: "planned",
      targetTab: "context",
    });
    expect(actions.find((action) => action.id === "overview-latest-chat")).toMatchObject({
      status: "planned",
      chatId: "chat-1",
    });
  });

  it("stages refresh, canonical navigation, and Chat callbacks without native claims", () => {
    const onRefresh = vi.fn();
    const onOpenChat = vi.fn();
    const onOpenOverviewTab = vi.fn();
    const queue = render(
      <ProjectOverviewActionCenter
        overview={overview({ attentionItems: [] })}
        contextHealth="ready"
        recentChats={[chat()]}
        onRefresh={onRefresh}
        onOpenChat={onOpenChat}
        onOpenOverviewTab={onOpenOverviewTab}
      />,
    );
    const region = screen.getByRole("region", { name: /Overview action center/i });
    expect(within(region).getByText(/Actions are derived from visible overview facts/i)).toBeInTheDocument();
    expect(within(region).getByText(/No provider request, filesystem read/i)).toBeInTheDocument();

    fireEvent.click(within(region).getByRole("button", { name: /Stage Review an overview refresh candidate/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    fireEvent.click(within(region).getByRole("button", { name: /Stage Inspect context readiness/i }));
    expect(onOpenOverviewTab).toHaveBeenCalledWith("context", "context");
    fireEvent.click(within(region).getByRole("button", { name: /Stage Continue latest Chat/i }));
    expect(onOpenChat).toHaveBeenCalledWith("chat-1");
    expect(within(region).getByText(/no native write was performed/i)).toBeInTheDocument();

    queue.unmount();
  });

  it("filters staged actions and can reopen them in the same renderer session", () => {
    const onRefresh = vi.fn();
    render(
      <ProjectOverviewActionCenter
        overview={overview({ attentionItems: [] })}
        contextHealth="ready"
        recentChats={[]}
        onRefresh={onRefresh}
        onOpenChatList={vi.fn()}
      />,
    );
    const region = screen.getByRole("region", { name: /Overview action center/i });
    const firstRow = within(region).getAllByRole("article")[0]!;
    const firstStage = within(firstRow).getByRole("button", { name: /^Stage Review an overview refresh candidate/i });
    fireEvent.click(firstStage);
    expect(within(firstRow).getByRole("button", { name: /Reopen/i })).toBeInTheDocument();
    fireEvent.change(within(region).getByRole("combobox", { name: "Filter Project Overview actions" }), { target: { value: "staged" } });
    expect(within(region).getAllByRole("article")).toHaveLength(1);
    fireEvent.click(within(region).getByRole("button", { name: /Reopen/i }));
    expect(within(region).getByText(/Reopened/i)).toBeInTheDocument();
  });
});
