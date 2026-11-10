import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatComposer } from "./composer";
import { useWorkspaceStore } from "./store";
import type { ConversationView } from "./types";
import type {
  VoiceRecognitionErrorEventLike,
  VoiceRecognitionLike,
  VoiceRecognitionResultEventLike,
} from "./voice-input";

class FakeRecognition implements VoiceRecognitionLike {
  static latest: FakeRecognition | null = null;

  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  onstart: (() => void) | null = null;
  onresult: ((event: VoiceRecognitionResultEventLike) => void) | null = null;
  onerror: ((event: VoiceRecognitionErrorEventLike) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn(() => this.onstart?.());
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn(() => this.onend?.());

  constructor() {
    FakeRecognition.latest = this;
  }
}

function renderWithEditorTools() {
  const result = render(<ChatComposer />);
  fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Show more composer tools" }));
  return result;
}

const initialState = useWorkspaceStore.getState();

function conversation(draft: string): ConversationView {
  return {
    id: "conversation_voice_component",
    activeBranchId: "branch_voice_component",
    title: "Voice input",
    excerpt: draft.slice(0, 90),
    updatedAt: "2026-09-12T00:00:00.000Z",
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
  useWorkspaceStore.setState({
    activeConversationId: "conversation_voice_component",
    conversations: [conversation("Hello")],
    activeRun: null,
    attachments: [],
    draftAttachmentIdsByConversation: {},
  });
  Object.defineProperty(globalThis, "SpeechRecognition", {
    configurable: true,
    value: FakeRecognition,
  });
});

afterEach(() => {
  useWorkspaceStore.setState(initialState, true);
  delete (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition;
  FakeRecognition.latest = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ChatComposer voice input", () => {
  it("shows visible listening state and merges a transcript into the draft", async () => {
    renderWithEditorTools();

    const voiceButton = screen.getByRole("button", { name: "Start voice input" });
    fireEvent.click(voiceButton);

    expect(screen.getByRole("status")).toHaveTextContent(/Listening/i);
    expect(screen.getByRole("button", { name: "Stop voice input" })).toBeInTheDocument();

    const recognition = FakeRecognition.latest;
    expect(recognition).not.toBeNull();
    recognition?.onresult?.({
      resultIndex: 0,
      results: [
        { isFinal: true, length: 1, 0: { transcript: "world" } },
      ],
    } as unknown as VoiceRecognitionResultEventLike);

    const textarea = screen.getByRole("combobox", { name: "Message Omnia" });
    await waitFor(() => expect(textarea).toHaveValue("Hello world"));

    // Browsers keep earlier final entries in `event.results` while adding an
    // interim/final suffix. The composer must replace the recognition suffix,
    // not append the complete list a second time.
    recognition?.onresult?.({
      resultIndex: 1,
      results: [
        { isFinal: true, length: 1, 0: { transcript: "world" } },
        { isFinal: false, length: 1, 0: { transcript: " again" } },
      ],
    } as unknown as VoiceRecognitionResultEventLike);
    await waitFor(() => expect(textarea).toHaveValue("Hello world again"));
    expect(textarea).toHaveAttribute("readonly");

    fireEvent.click(screen.getByRole("button", { name: "Stop voice input" }));
    expect(screen.getByRole("button", { name: "Start voice input" })).toBeInTheDocument();
  });

  it("surfaces a browser recognition error without hiding the typed composer", async () => {
    renderWithEditorTools();
    fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));

    FakeRecognition.latest?.onerror?.({ error: "not-allowed" } as VoiceRecognitionErrorEventLike);
    FakeRecognition.latest?.onend?.();

    expect(await screen.findByRole("alert")).toHaveTextContent(/permission was denied/i);
    expect(screen.getByRole("combobox", { name: "Message Omnia" })).not.toHaveAttribute("readonly");
  });

  it("keeps the draft and offers recovery when recognition ends without an error", async () => {
    renderWithEditorTools();
    fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));

    const recognition = FakeRecognition.latest;
    recognition?.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: true, length: 1, 0: { transcript: "kept locally" } }],
    } as unknown as VoiceRecognitionResultEventLike);
    recognition?.onend?.();

    expect(await screen.findByRole("alert")).toHaveTextContent(/transcript was kept in the draft/i);
    expect(screen.getByRole("combobox", { name: "Message Omnia" })).toHaveValue("Hello kept locally");
    expect(screen.getByRole("button", { name: "Start voice input" })).toBeInTheDocument();
  });

  it("can replace the existing draft from the voice options preview", async () => {
    renderWithEditorTools();

    fireEvent.click(screen.getByRole("button", { name: "Voice input options" }));
    fireEvent.change(screen.getByLabelText("Insert transcript"), { target: { value: "replace" } });
    fireEvent.change(screen.getByLabelText("Recognition language"), { target: { value: "en-US" } });
    fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));

    expect(FakeRecognition.latest?.lang).toBe("en-US");

    FakeRecognition.latest?.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: true, length: 1, 0: { transcript: "Only this" } }],
    } as unknown as VoiceRecognitionResultEventLike);

    const textarea = screen.getByRole("combobox", { name: "Message Omnia" });
    await waitFor(() => expect(textarea).toHaveValue("Only this"));
  });

  it("hides the optional voice control when the browser has no recognition API", () => {
    delete (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition;
    renderWithEditorTools();

    expect(screen.queryByRole("button", { name: "Start voice input" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Message Omnia" })).toBeInTheDocument();
  });
});
