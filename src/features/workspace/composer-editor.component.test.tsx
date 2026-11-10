import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChatComposer } from "./composer";
import { initialProviders } from "./mock-data";
import { useWorkspaceStore } from "./store";
import type { ConversationView } from "./types";

function renderWithEditorTools() {
  const result = render(<ChatComposer />);
  fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Show more composer tools" }));
  return result;
}

const initialState = useWorkspaceStore.getState();

function conversation(draft: string): ConversationView {
  return {
    id: "conversation_composer_editor_component",
    activeBranchId: "branch_composer_editor_component",
    title: "Composer editor",
    excerpt: draft,
    updatedAt: "2026-09-17T00:00:00.000Z",
    updatedLabel: "Now",
    projectId: null,
    projectName: null,
    pinned: false,
    archived: false,
    hasDraft: draft.length > 0,
    unread: false,
    runState: null,
    draft,
    messages: [],
  };
}

beforeEach(() => {
  const activeConversation = conversation("- first item");
  useWorkspaceStore.setState({
    activeConversationId: activeConversation.id,
    conversations: [activeConversation],
    activeRun: null,
    attachments: [],
    draftAttachmentIdsByConversation: {},
  });
});

afterEach(() => {
  useWorkspaceStore.setState(initialState, true);
  document.body.innerHTML = "";
});

describe("ChatComposer smart Markdown editor", () => {
  it("uses real model and reasoning selectors without reopening a Chat inspector", () => {
    useWorkspaceStore.setState({ providers: initialProviders, modelProfileId: "quality", inspectorOpen: false, inspectorTab: "context" });
    render(<ChatComposer />);

    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "balanced" } });
    expect(useWorkspaceStore.getState().modelProfileId).toBe("balanced");
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "quality" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Reasoning effort" }), { target: { value: "max" } });
    expect(useWorkspaceStore.getState().parameters.reasoningEffort).toBe("max");
    expect(useWorkspaceStore.getState().inspectorOpen).toBe(false);
    expect(useWorkspaceStore.getState().inspectorTab).toBe("context");
  });

  it("keeps the default composer clean and reveals optional tools deliberately", () => {
    const { container } = render(<ChatComposer />);
    expect(screen.getByRole("combobox", { name: "Message Omnia" })).toHaveAttribute("placeholder", "Ask anything...");
    expect(screen.queryByRole("toolbar", { name: "Formatting tools" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Choose composer mode" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Context scope:/ })).not.toBeInTheDocument();
    const footer = container.querySelector(".composer-toolbar") as HTMLElement;
    expect(footer.querySelectorAll("button")).toHaveLength(2);
    expect(footer.querySelectorAll("select")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Send message" })).toHaveTextContent("Send");
    expect(screen.getByRole("button", { name: "Attach files" })).toHaveAttribute("title", "Attach files");

    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show more composer tools" }));
    expect(screen.getByRole("toolbar", { name: "Formatting tools" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose composer mode" })).toBeInTheDocument();
  });

  it("does not invent a reasoning capability when there is no configured provider", () => {
    useWorkspaceStore.setState({ providers: [], modelProfileId: "auto" });
    render(<ChatComposer />);
    expect(screen.getByRole("combobox", { name: "Reasoning effort" })).toBeDisabled();
    expect(screen.queryByRole("option", { name: "Max" })).not.toBeInTheDocument();
    expect(screen.queryByText("gpt-6.1-sol")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open or close advanced parameters" })).not.toBeInTheDocument();
  });

  it("continues a list before considering Enter-to-send", () => {
    renderWithEditorTools();
    const textarea = screen.getByRole("combobox", { name: "Message Omnia" }) as HTMLTextAreaElement;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(textarea).toHaveValue("- first item\n- ");
    expect(useWorkspaceStore.getState().activeRun).toBeNull();
  });

  it("keeps Enter inside a fenced code block as an indented draft newline", async () => {
    const draft = "```ts\n  const answer = 42;\n```";
    const activeConversation = conversation(draft);
    useWorkspaceStore.setState({ conversations: [activeConversation] });
    renderWithEditorTools();
    const textarea = screen.getByRole("combobox", { name: "Message Omnia" }) as HTMLTextAreaElement;
    const cursor = draft.indexOf("42;") + 3;
    textarea.setSelectionRange(cursor, cursor);

    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(textarea).toHaveValue("```ts\n  const answer = 42;\n  \n```"));
    expect(useWorkspaceStore.getState().activeRun).toBeNull();
  });

  it("opens a split source and preview workspace without leaving the renderer boundary", async () => {
    const activeConversation = conversation("# Split note\n\n- preview me");
    useWorkspaceStore.setState({ conversations: [activeConversation] });
    renderWithEditorTools();

    fireEvent.click(screen.getByRole("tab", { name: "Split" }));

    expect(screen.getByRole("tab", { name: "Split" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Split" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Message Omnia" })).toHaveValue("# Split note\n\n- preview me");
    expect(screen.getByRole("region", { name: "Live split preview" })).toBeInTheDocument();
    expect(screen.getByText(/Preview only · no file read/i)).toBeInTheDocument();
  });

  it("jumps from the preview outline back to the selected source block", async () => {
    const activeConversation = conversation("# First section\n\nParagraph\n\n## Second section");
    useWorkspaceStore.setState({ conversations: [activeConversation] });
    renderWithEditorTools();

    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    fireEvent.click(screen.getByRole("tab", { name: "Outline" }));
    fireEvent.click(screen.getByRole("button", { name: /Jump to block 3: Second section/i }));

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Write" })).toHaveAttribute("aria-selected", "true");
      const textarea = screen.getByRole("combobox", { name: "Message Omnia" }) as HTMLTextAreaElement;
      expect(textarea.selectionStart).toBe(activeConversation.draft.indexOf("## Second section"));
      expect(textarea.selectionEnd).toBe(activeConversation.draft.length);
    });
  });

  it("applies an edited preview block to the composer draft with undo available", async () => {
    const activeConversation = conversation("# Draft title\n\nA paragraph to keep.");
    useWorkspaceStore.setState({ conversations: [activeConversation] });
    renderWithEditorTools();

    // Draft Studio is intentionally behind the compact More tools disclosure
    // in the primary chat composer. Open it before asserting its controls.
    fireEvent.click(screen.getByRole("button", { name: "Expand Draft Studio" }));

    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    fireEvent.click(screen.getByRole("tab", { name: "Blocks" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit block 1 source" }), { target: { value: "# Revised title" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));

    await waitFor(() => {
      expect(useWorkspaceStore.getState().conversations[0]?.draft).toBe("# Revised title\n\nA paragraph to keep.");
    });
    expect(screen.getByRole("button", { name: "Undo draft change" })).toBeEnabled();
  });

  it("exits an empty list item and supports Tab / Shift+Tab block indentation", () => {
    const activeConversation = conversation("- first item\n- ");
    useWorkspaceStore.setState({ conversations: [activeConversation] });
    renderWithEditorTools();
    const textarea = screen.getByRole("combobox", { name: "Message Omnia" }) as HTMLTextAreaElement;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea).toHaveValue("- first item\n");

    textarea.setSelectionRange(0, textarea.value.length);
    fireEvent.keyDown(textarea, { key: "Tab" });
    // A selection ending immediately after the trailing line break contains
    // the first list line, not the empty line after it.
    expect(textarea).toHaveValue("  - first item\n");

    textarea.setSelectionRange(0, textarea.value.length);
    fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true });
    expect(textarea).toHaveValue("- first item\n");
  });

  it("continues alphabetic Markdown lists and exposes rich list/indent toolbar actions", async () => {
    const activeConversation = conversation("a. first item");
    useWorkspaceStore.setState({ conversations: [activeConversation] });
    renderWithEditorTools();
    const textarea = screen.getByRole("combobox", { name: "Message Omnia" }) as HTMLTextAreaElement;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea).toHaveValue("a. first item\nb. ");

    textarea.setSelectionRange(0, textarea.value.length);
    const numberedListButton = screen.getByRole("button", { name: "Numbered list" });
    fireEvent.mouseDown(numberedListButton);
    fireEvent.click(numberedListButton);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Message Omnia" })).toHaveValue("1. a. first item\nb. "));
    const updatedTextarea = screen.getByRole("combobox", { name: "Message Omnia" }) as HTMLTextAreaElement;
    updatedTextarea.setSelectionRange(0, updatedTextarea.value.length);
    const checklistButton = screen.getByRole("button", { name: "Checklist" });
    fireEvent.mouseDown(checklistButton);
    fireEvent.click(checklistButton);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Message Omnia" })).toHaveValue("- [ ] 1. a. first item\nb. "));
    expect(screen.getByRole("button", { name: "Lettered list" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Indent selection" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Outdent selection" })).toBeInTheDocument();
  });

  it("toggles selected lines between plain text and a bullet list", async () => {
    const activeConversation = conversation("first line\nsecond line");
    useWorkspaceStore.setState({ conversations: [activeConversation] });
    renderWithEditorTools();
    const textarea = screen.getByRole("combobox", { name: "Message Omnia" }) as HTMLTextAreaElement;
    textarea.setSelectionRange(0, textarea.value.length);

    const bulletButton = screen.getByRole("button", { name: "Bullet list" });
    fireEvent.mouseDown(bulletButton);
    fireEvent.click(bulletButton);
    await waitFor(() => expect(textarea).toHaveValue("- first line\n- second line"));
    expect(bulletButton).toHaveAttribute("aria-pressed", "true");

    textarea.setSelectionRange(0, textarea.value.length);
    fireEvent.mouseDown(bulletButton);
    fireEvent.click(bulletButton);
    await waitFor(() => expect(textarea).toHaveValue("first line\nsecond line"));
    expect(bulletButton).toHaveAttribute("aria-pressed", "false");
  });

  it("exposes inline strike, blockquote, and table/divider Markdown tools", async () => {
    const activeConversation = conversation("select me");
    useWorkspaceStore.setState({ conversations: [activeConversation] });
    renderWithEditorTools();
    const textarea = screen.getByRole("combobox", { name: "Message Omnia" }) as HTMLTextAreaElement;
    textarea.setSelectionRange(0, textarea.value.length);

    fireEvent.mouseDown(screen.getByRole("button", { name: "Strikethrough" }));
    fireEvent.click(screen.getByRole("button", { name: "Strikethrough" }));
    await waitFor(() => expect(textarea).toHaveValue("~~select me~~"));

    textarea.setSelectionRange(0, textarea.value.length);
    fireEvent.mouseDown(screen.getByRole("button", { name: "Blockquote" }));
    fireEvent.click(screen.getByRole("button", { name: "Blockquote" }));
    await waitFor(() => expect(textarea).toHaveValue("> ~~select me~~"));

    fireEvent.mouseDown(screen.getByRole("button", { name: "More formatting" }));
    fireEvent.click(screen.getByRole("button", { name: "More formatting" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Table starter/i }));
    await waitFor(() => expect(textarea.value).toContain("| Column | Value |"));
    expect(screen.queryByRole("menuitem", { name: /Horizontal rule/i })).not.toBeInTheDocument();
  });

  it("labels the two overflow formatter triggers so their purpose is clear", () => {
    renderWithEditorTools();

    expect(screen.getByRole("button", { name: "More formatting" })).toHaveTextContent("More");
    expect(screen.getByRole("button", { name: "Block insert studio" })).toHaveTextContent("Blocks");
  });

  it("reflects the active blockquote state and toggles it off", async () => {
    const activeConversation = conversation("> quoted line\n> another line");
    useWorkspaceStore.setState({ conversations: [activeConversation] });
    renderWithEditorTools();
    const textarea = screen.getByRole("combobox", { name: "Message Omnia" }) as HTMLTextAreaElement;
    textarea.setSelectionRange(0, textarea.value.length);
    fireEvent.select(textarea);

    const blockquoteButton = screen.getByRole("button", { name: "Blockquote" });
    await waitFor(() => expect(blockquoteButton).toHaveAttribute("aria-pressed", "true"));
    fireEvent.mouseDown(blockquoteButton);
    fireEvent.click(blockquoteButton);
    await waitFor(() => expect(textarea).toHaveValue("quoted line\nanother line"));
    expect(blockquoteButton).toHaveAttribute("aria-pressed", "false");
  });

  it("applies a selected heading level and leaves the URL placeholder ready to edit", async () => {
    const activeConversation = conversation("first line\nsecond line");
    useWorkspaceStore.setState({ conversations: [activeConversation] });
    renderWithEditorTools();
    const textarea = screen.getByRole("combobox", { name: "Message Omnia" }) as HTMLTextAreaElement;
    textarea.setSelectionRange(0, textarea.value.length);
    fireEvent.select(textarea);

    fireEvent.mouseDown(screen.getByRole("button", { name: "More formatting" }));
    fireEvent.click(screen.getByRole("button", { name: "More formatting" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Heading 2" }));

    await waitFor(() => expect(textarea).toHaveValue("## first line\n## second line"));
    expect(screen.getByRole("status")).toHaveTextContent(/Heading 2 applied/i);

    textarea.setSelectionRange(3, 8);
    fireEvent.mouseDown(screen.getByRole("button", { name: "Insert link" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert link" }));

    await waitFor(() => expect(textarea).toHaveValue("## [first](https://) line\n## second line"));
    expect(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)).toBe("https://");
  });

  it("reflects active inline Markdown markers through toolbar state", async () => {
    const activeConversation = conversation("**bold** and *italic*");
    useWorkspaceStore.setState({ conversations: [activeConversation] });
    renderWithEditorTools();
    const textarea = screen.getByRole("combobox", { name: "Message Omnia" }) as HTMLTextAreaElement;

    textarea.setSelectionRange(2, 6);
    fireEvent.select(textarea);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "Italic" })).toHaveAttribute("aria-pressed", "false");
    });

    textarea.setSelectionRange(14, 20);
    fireEvent.select(textarea);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "false");
      expect(screen.getByRole("button", { name: "Italic" })).toHaveAttribute("aria-pressed", "true");
    });
  });

  it("maps Ctrl/Cmd+B and Ctrl/Cmd+I to inline Markdown formatting", async () => {
    const activeConversation = conversation("shortcut text");
    useWorkspaceStore.setState({ conversations: [activeConversation] });
    renderWithEditorTools();
    const textarea = screen.getByRole("combobox", { name: "Message Omnia" }) as HTMLTextAreaElement;
    textarea.setSelectionRange(0, textarea.value.length);

    fireEvent.keyDown(textarea, { key: "b", ctrlKey: true });
    await waitFor(() => expect(textarea).toHaveValue("**shortcut text**"));

    useWorkspaceStore.setState({ conversations: [conversation("italic text")] });
    await waitFor(() => expect(textarea).toHaveValue("italic text"));
    textarea.setSelectionRange(0, textarea.value.length);
    fireEvent.keyDown(textarea, { key: "i", metaKey: true });
    await waitFor(() => expect(textarea).toHaveValue("*italic text*"));

    useWorkspaceStore.setState({ conversations: [conversation("strike text")] });
    await waitFor(() => expect(textarea).toHaveValue("strike text"));
    textarea.setSelectionRange(0, textarea.value.length);
    fireEvent.keyDown(textarea, { key: "x", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(textarea).toHaveValue("~~strike text~~"));
  });

  it("supports renderer-session draft undo and redo shortcuts", async () => {
    const activeConversation = conversation("base draft");
    useWorkspaceStore.setState({ conversations: [activeConversation] });
    renderWithEditorTools();
    const textarea = screen.getByRole("combobox", { name: "Message Omnia" }) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "base draft plus edit" } });
    await waitFor(() => expect(textarea).toHaveValue("base draft plus edit"));

    fireEvent.keyDown(textarea, { key: "z", ctrlKey: true });
    await waitFor(() => expect(textarea).toHaveValue("base draft"));
    expect(screen.getByRole("status")).toHaveTextContent(/Undo applied/i);

    fireEvent.keyDown(textarea, { key: "y", ctrlKey: true });
    await waitFor(() => expect(textarea).toHaveValue("base draft plus edit"));
    expect(screen.getByRole("status")).toHaveTextContent(/Redo applied/i);

    fireEvent.keyDown(textarea, { key: "z", metaKey: true, shiftKey: true });
    await waitFor(() => expect(textarea).toHaveValue("base draft plus edit"));

    fireEvent.keyDown(textarea, { key: "z", ctrlKey: true });
    await waitFor(() => expect(textarea).toHaveValue("base draft"));
  });

  it("keeps toolbar media buttons and the media preview queue in sync", async () => {
    renderWithEditorTools();

    // Media presets live in the optional tools tray so the default composer
    // remains compact; expand that tray before querying both surfaces.

    const imageButtons = screen.getAllByRole("button", { name: "Image input preview" });
    expect(imageButtons).toHaveLength(2);
    const toolbarImageButton = imageButtons[imageButtons.length - 1]!;
    const draftImageButton = imageButtons[0]!;
    fireEvent.click(toolbarImageButton);

    await waitFor(() => {
      expect(toolbarImageButton).toHaveAttribute("aria-pressed", "true");
      expect(draftImageButton).toHaveAttribute("aria-pressed", "true");
    });
    expect(screen.getByText("Image input")).toBeInTheDocument();
    expect(screen.getByText(/No file was read or uploaded/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove image media preview" }));
    await waitFor(() => {
      expect(toolbarImageButton).toHaveAttribute("aria-pressed", "false");
      expect(imageButtons[0]).toHaveAttribute("aria-pressed", "false");
    });
  });

  it("opens Skills Studio from the enabled skills composer control", () => {
    renderWithEditorTools();

    fireEvent.click(screen.getByRole("button", { name: /enabled skills$/i }));

    expect(useWorkspaceStore.getState().activeActivity).toBe("skills");
  });

  it("opens a slash command palette and inserts the selected renderer shortcut", async () => {
    const activeConversation = conversation("");
    useWorkspaceStore.setState({ conversations: [activeConversation] });
    renderWithEditorTools();
    const textarea = screen.getByRole("combobox", { name: "Message Omnia" }) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/check" } });
    textarea.setSelectionRange(6, 6);
    fireEvent.select(textarea);

    expect(screen.getByRole("listbox", { name: "Draft commands" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /\/checklist/i })).toBeInTheDocument();

    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

    await waitFor(() => expect(textarea).toHaveValue("- [ ] "));
    expect(useWorkspaceStore.getState().activeRun).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(/Checklist inserted/i);
  });

  it("preserves keyboard command selection through unchanged browser select events", () => {
    const activeConversation = conversation("");
    useWorkspaceStore.setState({ conversations: [activeConversation] });
    render(<ChatComposer />);
    const input = screen.getByRole("combobox", { name: "Message Omnia" });
    fireEvent.change(input, { target: { value: "/", selectionStart: 1, selectionEnd: 1 } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyUp(input, { key: "ArrowDown" });
    fireEvent.select(input);
    const options = screen.getAllByRole("option").filter((option) => option.tagName !== "OPTION");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.keyUp(input, { key: "Escape" });
    fireEvent.select(input);
    expect(screen.queryByRole("listbox", { name: "Draft commands" })).not.toBeInTheDocument();
    expect(useWorkspaceStore.getState().activeRun).toBeNull();
  });
});
