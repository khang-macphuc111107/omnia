import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initialProjects } from "./mock-data";
import { ConversationStartDialog } from "./conversation-start-dialog";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();

describe("ConversationStartDialog", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("opens a configured renderer conversation with title, mode, and starter draft", async () => {
    const onClose = vi.fn();
    useWorkspaceStore.setState({
      conversations: [],
      projects: initialProjects,
      providers: [],
      modelProfileId: "auto",
      composerMode: "ask",
      activeConversationId: "",
    });

    render(<ConversationStartDialog projectId="project-omnia" onClose={onClose} />);

    fireEvent.click(screen.getByRole("radio", { name: /Create/i }));
    fireEvent.change(screen.getByLabelText(/Chat title/i), { target: { value: "UI kickoff" } });
    fireEvent.change(screen.getByPlaceholderText(/Optional: leave a draft/i), {
      target: { value: "Outline the next Omnia UI phase." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Open Chat/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const state = useWorkspaceStore.getState();
    const conversation = state.conversations.find((item) => item.id === state.activeConversationId);
    expect(conversation).toMatchObject({
      title: "UI kickoff",
      projectId: "project-omnia",
      projectName: "Omnia Desktop",
      draft: "Outline the next Omnia UI phase.",
      hasDraft: true,
    });
    expect(state.composerMode).toBe("create");
    expect(screen.queryByText("Preview-only setup")).toBeInTheDocument();
  });

  it("keeps a selected temporary retention marker on the opened renderer Chat", async () => {
    const onClose = vi.fn();
    useWorkspaceStore.setState({
      conversations: [],
      projects: initialProjects,
      providers: [],
      modelProfileId: "auto",
      composerMode: "ask",
      activeConversationId: "",
    });

    render(<ConversationStartDialog onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("Retention"), { target: { value: "temporary" } });
    fireEvent.click(screen.getByRole("button", { name: /Open Chat/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const state = useWorkspaceStore.getState();
    const conversation = state.conversations.find((item) => item.id === state.activeConversationId);
    expect(conversation).toMatchObject({ temporary: true });
    expect(screen.getByText("Temporary preview selected")).toBeInTheDocument();
  });

  it("exposes context and temporary retention as explicit preview choices", () => {
    useWorkspaceStore.setState({ projects: initialProjects, providers: [] });
    render(<ConversationStartDialog onClose={vi.fn()} />);

    expect(screen.getByText(/Context, memory, and temporary retention choices/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Retention"), { target: { value: "temporary" } });
    expect(screen.getByText("Native temporary-chat metadata is planned.")).toBeInTheDocument();
    expect(screen.getByText("Temporary preview selected")).toBeInTheDocument();
  });

  it("reviews a Plan task draft before explicitly creating a Chat in the source Project", async () => {
    const onClose = vi.fn();
    useWorkspaceStore.setState({ conversations: [], projects: initialProjects, providers: [], activeConversationId: "" });
    render(<ConversationStartDialog
      projectId="project-omnia"
      planDraft={{ projectId: "project-omnia", taskId: "task-scope", taskTitle: "Map scope", text: "Task: Map scope\nAcceptance: Review the output." }}
      onClose={onClose}
    />);
    expect(screen.getByRole("combobox", { name: "Project" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Starter Chat draft" })).toHaveValue("Task: Map scope\nAcceptance: Review the output.");
    const operationPreview = screen.getByRole("region", { name: "Plan to Chat operation preview" });
    expect(operationPreview).toHaveTextContent(/Ready for confirmation/i);
    expect(screen.getByRole("status", { name: "Plan to Chat preflight" })).toHaveTextContent(/Ready for preview confirmation/i);
    expect(screen.getByRole("status", { name: "Plan to Chat preflight" })).toHaveTextContent(/Editable draft matches/i);
    expect(operationPreview).toHaveTextContent(/Expected scope.*project-omnia/i);
    expect(operationPreview).toHaveTextContent(/Retry key \(preview only\).*plan-chat-key-/i);
    expect(operationPreview).toHaveTextContent(/Atomic plan.*create-chat.*stage-draft.*planned/i);
    expect(operationPreview).toHaveTextContent(/Native transaction.*Planned.*not observed/i);
    expect(operationPreview).toHaveTextContent(/Replay guard.*Same-key duplicate submissions blocked for this setup session only/i);
    expect(operationPreview).toHaveTextContent(/Preconditions.*same-project.*empty-only/i);
    expect(operationPreview).toHaveTextContent(/Failure policy.*retain chat report draft failure/i);
    expect(operationPreview).toHaveTextContent(/Renderer-local operation preview only/i);
    expect(useWorkspaceStore.getState().conversations).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /Open Chat/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const state = useWorkspaceStore.getState();
    expect(state.conversations.find((chat) => chat.id === state.activeConversationId)).toMatchObject({
      projectId: "project-omnia", title: "Task: Map scope", draft: "Task: Map scope\nAcceptance: Review the output.", hasDraft: true,
    });
  });

  it("blocks a stale or mismatched Project plan draft before Chat creation", () => {
    const before = useWorkspaceStore.getState().conversations.length;
    render(<ConversationStartDialog
      projectId="project-omnia"
      planDraft={{ projectId: "different-project", taskId: "task-other", taskTitle: "Wrong scope", text: "Keep this scoped" }}
      onClose={vi.fn()}
    />);
    expect(screen.getByRole("button", { name: /Open Chat/i })).toBeDisabled();
    expect(useWorkspaceStore.getState().conversations).toHaveLength(before);
  });

  it("requires an independently supplied task id instead of self-validating the operation id", () => {
    useWorkspaceStore.setState({ conversations: [], projects: initialProjects, providers: [], activeConversationId: "" });
    render(<ConversationStartDialog
      projectId="project-omnia"
      planDraft={{ projectId: "project-omnia", taskTitle: "Unbound task", text: "Review this task." }}
      onClose={vi.fn()}
    />);

    const preflight = screen.getByRole("status", { name: "Plan to Chat preflight" });
    expect(preflight).toHaveTextContent(/Review required/i);
    expect(preflight).toHaveTextContent(/source task identity/i);
    expect(screen.getByRole("button", { name: /Open Chat/i })).toBeDisabled();
    expect(useWorkspaceStore.getState().conversations).toHaveLength(0);
  });

  it("refreshes the preview retry identity when the editable task draft changes", async () => {
    useWorkspaceStore.setState({ conversations: [], projects: initialProjects, providers: [], activeConversationId: "" });
    render(<ConversationStartDialog
      projectId="project-omnia"
      planDraft={{ projectId: "project-omnia", taskId: "task-scope", taskTitle: "Map scope", text: "Task: Map scope\nAcceptance: Review the output." }}
      onClose={vi.fn()}
    />);
    const operationPreview = screen.getByRole("region", { name: "Plan to Chat operation preview" });
    const initialRetryKey = within(operationPreview).getAllByRole("code")[1]?.textContent;
    fireEvent.change(screen.getByRole("textbox", { name: "Starter Chat draft" }), {
      target: { value: "Task: Map scope\nAcceptance: Review the output and risks." },
    });
    await waitFor(() => {
      const nextRetryKey = within(operationPreview).getAllByRole("code")[1]?.textContent;
      expect(nextRetryKey).toBeTruthy();
      expect(nextRetryKey).not.toBe(initialRetryKey);
    });
    expect(operationPreview).toHaveTextContent(/Draft fingerprint/);
    expect(operationPreview).toHaveTextContent(/Draft revision.*Edited draft 1/i);
  });

  it("does not keep a stale Plan operation envelope after the editable draft is cleared", async () => {
    useWorkspaceStore.setState({ conversations: [], projects: initialProjects, providers: [], activeConversationId: "" });
    render(<ConversationStartDialog
      projectId="project-omnia"
      planDraft={{ projectId: "project-omnia", taskId: "task-scope", taskTitle: "Map scope", text: "Task: Map scope" }}
      onClose={vi.fn()}
    />);
    expect(screen.getByRole("region", { name: "Plan to Chat operation preview" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Starter Chat draft" }), { target: { value: "" } });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Plan to Chat operation preview" })).toBeNull());
  });

  it("blocks a same-key double submission before a second Chat creation starts", async () => {
    let resolveCreate!: (conversationId: string) => void;
    const createConversation = vi.fn((_projectId?: string) => new Promise<string>((resolve) => {
      resolveCreate = resolve;
    }));
    const onClose = vi.fn();
    useWorkspaceStore.setState({
      conversations: [],
      projects: initialProjects,
      providers: [],
      activeConversationId: "",
      createConversation,
    });
    render(<ConversationStartDialog
      projectId="project-omnia"
      planDraft={{ projectId: "project-omnia", taskId: "task-scope", taskTitle: "Map scope", text: "Task: Map scope" }}
      onClose={onClose}
    />);

    const openButton = screen.getByRole("button", { name: /Open Chat/i });
    act(() => {
      openButton.click();
      openButton.click();
    });

    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent(/Duplicate creation was blocked/i);
    expect(screen.getByRole("region", { name: "Plan to Chat operation preview" })).toHaveTextContent(/Same-key duplicate submissions blocked/i);

    resolveCreate("preview-only-chat-id");
    await waitFor(() => expect(screen.getByRole("status", { name: "Plan to Chat preflight" })).toHaveTextContent(/Blocked/i));
    expect(onClose).not.toHaveBeenCalled();
  });

});
