import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChatComposer } from "./composer";
import { initialConversations, initialProviders } from "./mock-data";
import { useWorkspaceStore } from "./store";

function renderWithEditorTools() {
  const result = render(<ChatComposer />);
  fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Show more composer tools" }));
  return result;
}

const initialState = useWorkspaceStore.getState();

describe("composer mode selector", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("exposes Ask, Create, Research, and Discuss as explicit mode options", () => {
    const conversation = initialConversations[0]!;
    useWorkspaceStore.setState({ conversations: initialConversations, providers: initialProviders, activeConversationId: conversation.id, composerMode: "ask" });
    renderWithEditorTools();

    fireEvent.click(screen.getByRole("button", { name: "Choose composer mode" }));
    expect(screen.getByRole("menu", { name: "Composer modes" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /Ask Normal text conversation/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: /Create Drafting preview/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("menuitemradio", { name: /Discuss Multi-perspective preview/ })).toHaveAttribute("aria-checked", "false");
    const ask = screen.getByRole("menuitemradio", { name: /Ask Normal text conversation/ });
    const create = screen.getByRole("menuitemradio", { name: /Create Drafting preview/ });
    ask.focus();
    fireEvent.keyDown(ask, { key: "ArrowDown" });
    expect(create).toHaveFocus();
    fireEvent.keyDown(create, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Composer modes" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose composer mode" })).toHaveFocus();
  });

  it("keeps Discuss preview-only and exposes its round controls", () => {
    const conversation = { ...initialConversations[0]!, draft: "Compare these options" };
    useWorkspaceStore.setState({ conversations: [conversation], providers: initialProviders, activeConversationId: conversation.id, composerMode: "ask" });
    renderWithEditorTools();

    fireEvent.click(screen.getByRole("button", { name: "Choose composer mode" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Discuss Multi-perspective preview/ }));
    expect(useWorkspaceStore.getState().composerMode).toBe("discuss");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/renderer preview/i);

    fireEvent.click(screen.getByRole("button", { name: "Open mode controls" }));
    expect(screen.getByRole("region", { name: "Discuss mode controls" })).toBeInTheDocument();
    expect(screen.getByLabelText("Discussion rounds")).toHaveValue("3");
  });

  it("keeps non-Ask modes preview-only and blocks submission", () => {
    const conversation = { ...initialConversations[0]!, draft: "Draft a plan" };
    useWorkspaceStore.setState({ conversations: [conversation], providers: initialProviders, activeConversationId: conversation.id, composerMode: "ask" });
    renderWithEditorTools();

    fireEvent.click(screen.getByRole("button", { name: "Choose composer mode" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Research Research preview/ }));
    expect(useWorkspaceStore.getState().composerMode).toBe("research");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/renderer preview/i);

    fireEvent.keyDown(screen.getByRole("combobox", { name: "Message Omnia" }), { key: "Enter" });
    expect(useWorkspaceStore.getState().activeRun).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(/return to Ask to send/i);
  });

  it("opens renderer-local controls for the selected mode", () => {
    const conversation = initialConversations[0]!;
    useWorkspaceStore.setState({ conversations: initialConversations, providers: initialProviders, activeConversationId: conversation.id, composerMode: "create" });
    renderWithEditorTools();

    fireEvent.click(screen.getByRole("button", { name: "Open mode controls" }));
    expect(screen.getByRole("dialog", { name: "Composer mode controls" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Create mode controls" })).toBeInTheDocument();
    expect(within(screen.getByRole("dialog", { name: "Composer mode controls" })).getByRole("note")).toHaveTextContent(/not sent as native\/provider parameters/i);
    fireEvent.click(screen.getByRole("button", { name: "Open mode controls" }));
    expect(screen.queryByRole("dialog", { name: "Composer mode controls" })).not.toBeInTheDocument();
  });

  it("preserves mode-control selections and undo history when the popover is closed and reopened", () => {
    const conversation = initialConversations[0]!;
    useWorkspaceStore.setState({ conversations: initialConversations, providers: initialProviders, activeConversationId: conversation.id, composerMode: "create" });
    renderWithEditorTools();

    const toggleModeControls = () => fireEvent.click(screen.getByRole("button", { name: "Open mode controls" }));
    toggleModeControls();
    fireEvent.change(screen.getByLabelText("Artifact direction"), { target: { value: "code" } });
    toggleModeControls();
    expect(screen.queryByRole("dialog", { name: "Composer mode controls" })).not.toBeInTheDocument();

    toggleModeControls();
    expect(screen.getByLabelText("Artifact direction")).toHaveValue("code");
    fireEvent.click(screen.getByRole("button", { name: "Undo Create control change" }));
    expect(screen.getByLabelText("Artifact direction")).toHaveValue("document");
  });

  it("dismisses mode controls when focus moves outside the composer anchor", () => {
    const conversation = initialConversations[0]!;
    useWorkspaceStore.setState({ conversations: initialConversations, providers: initialProviders, activeConversationId: conversation.id, composerMode: "ask" });
    renderWithEditorTools();

    fireEvent.click(screen.getByRole("button", { name: "Open mode controls" }));
    expect(screen.getByRole("dialog", { name: "Composer mode controls" })).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Composer mode controls" })).not.toBeInTheDocument();
  });
});
