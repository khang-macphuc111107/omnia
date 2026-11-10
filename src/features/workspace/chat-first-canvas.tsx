import {
  ArrowRight,
  ChevronDown,
  Command,
  MessageCircle,
  PanelRight,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { ConversationView } from "./types";
import { useWorkspaceStore } from "./store";

interface ChatFirstCanvasProps {
  readonly conversation: ConversationView;
  readonly inspectorOpen: boolean;
  readonly onToggleInspector: () => void;
}

const QUICK_PROMPTS = [
  { label: "Explain code", value: "Explain this code clearly, then show a small example.\n\n" },
  { label: "Plan a feature", value: "Help me plan this feature with milestones and trade-offs.\n\n" },
  { label: "Review a diff", value: "Review this change for correctness, maintainability, and edge cases.\n\n" },
] as const;

/**
 * A deliberately small, chat-first orientation row.
 *
 * The surrounding workbench still exists for advanced inspection, but this
 * surface makes the primary action unmistakable: click the composer, type a
 * request, and send it. Every action remains renderer-local in the browser
 * preview; it does not imply a provider request or a durable write.
 */
export function ChatFirstCanvas({
  conversation,
  inspectorOpen,
  onToggleInspector,
}: ChatFirstCanvasProps) {
  const updateDraft = useWorkspaceStore((state) => state.updateDraft);
  const [startersOpen, setStartersOpen] = useState(false);
  const messageCount = conversation.messages.length;

  const focusComposer = () => {
    window.requestAnimationFrame(() => {
      const composer = document.querySelector<HTMLElement>('[aria-label="Message Omnia"]');
      composer?.focus();
    });
  };

  useEffect(() => {
    const handleComposerShortcut = (event: KeyboardEvent) => {
      if (
        event.key !== "Enter" ||
        !event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return;
      }

      event.preventDefault();
      focusComposer();
    };

    window.addEventListener("keydown", handleComposerShortcut);
    return () => window.removeEventListener("keydown", handleComposerShortcut);
  }, []);

  useEffect(() => {
    setStartersOpen(false);
  }, [conversation.id]);

  const applyPrompt = (value: string) => {
    updateDraft(value);
    focusComposer();
  };

  // Once a conversation has started, the transcript and composer provide the
  // necessary orientation. Repeating the large starter rail above every
  // response consumes reading space and duplicates controls already present
  // in the composer/header. Keep the keyboard shortcut active via the effect
  // above, while showing these starter actions only in an empty Chat.
  if (messageCount > 0) return null;

  return (
    <section className="chat-first-canvas" aria-label="Chat entry">
      <div className="chat-first-canvas__identity">
        <span className="chat-first-canvas__mark" aria-hidden="true">
          <MessageCircle size={16} />
        </span>
        <div className="chat-first-canvas__copy">
          <div className="chat-first-canvas__eyebrow">
            <span>CHAT</span>
            <span className="chat-first-canvas__status"><i aria-hidden="true" /> Ready to write</span>
          </div>
          <strong>Ask Omnia anything</strong>
          <span>Type below to explain, build, review, or brainstorm.</span>
        </div>
      </div>

      <div className="chat-first-canvas__actions">
        <button
          type="button"
          className="chat-first-canvas__start"
          title="Focus the message composer"
          aria-label="Start a message"
          onClick={focusComposer}
        >
          <Sparkles size={14} aria-hidden="true" />
          Start a message
          <ArrowRight size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="chat-first-canvas__tool"
          title={startersOpen ? "Hide starter prompts" : "Choose a starter prompt to insert into the composer"}
          aria-label={startersOpen ? "Hide starter prompts" : "Show starter prompts"}
          aria-expanded={startersOpen}
          aria-controls="chat-starter-prompts"
          onClick={() => setStartersOpen((open) => !open)}
        >
          <WandSparkles size={13} aria-hidden="true" />
          Prompts
          <ChevronDown className={startersOpen ? "is-open" : undefined} size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={inspectorOpen ? "chat-first-canvas__tool is-active" : "chat-first-canvas__tool"}
          onClick={onToggleInspector}
          title={inspectorOpen ? "Close the inspector tools" : "Open the inspector tools"}
          aria-label={inspectorOpen ? "Close inspector tools" : "Open inspector tools"}
          aria-expanded={inspectorOpen}
          aria-controls="context-inspector"
        >
          <PanelRight size={13} aria-hidden="true" />
          {inspectorOpen ? "Inspector" : "Tools"}
        </button>
        <button
          type="button"
          className="chat-first-canvas__shortcut"
          title="Focus the message composer"
          aria-label="Focus the message composer: Alt plus Enter"
          aria-keyshortcuts="Alt+Enter"
          onClick={focusComposer}
        >
          <Command size={11} aria-hidden="true" />
          <kbd>Alt</kbd><kbd>Enter</kbd>
        </button>
      </div>
      {startersOpen ? (
        <div id="chat-starter-prompts" className="chat-first-canvas__prompts" role="toolbar" aria-label="Chat starter prompts">
          {QUICK_PROMPTS.map((prompt) => (
            <button
              key={prompt.label}
              type="button"
              className="chat-first-canvas__prompt"
              title={`Insert starter: ${prompt.label}`}
              aria-label={`Insert chat starter: ${prompt.label}`}
              onClick={() => applyPrompt(prompt.value)}
            >
              <WandSparkles size={12} aria-hidden="true" />
              {prompt.label}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
