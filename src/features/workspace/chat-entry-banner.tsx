import { ArrowDown, Keyboard, MessageCircle, Sparkles } from "lucide-react";

export interface ChatEntryBannerProps {
  modelLabel?: string;
  messageCount: number;
  onFocusComposer?: () => void;
}

/**
 * A deliberately small orientation cue for the primary Chat surface.
 *
 * The surrounding workbench can expose routing, context, and run metadata,
 * but those surfaces are secondary to writing a message. This banner keeps
 * that hierarchy visible without making any native/provider claims.
 */
export function ChatEntryBanner({
  modelLabel = "Auto",
  messageCount,
  onFocusComposer,
}: ChatEntryBannerProps) {
  const focusComposer = () => {
    onFocusComposer?.();
    window.requestAnimationFrame(() => {
      const composer = document.querySelector<HTMLElement>('[aria-label="Message Omnia"]');
      if (!composer) return;
      composer.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
      composer.focus({ preventScroll: true });
    });
  };

  return (
    <section className="chat-entry-banner" aria-label="Start chatting with Omnia">
      <div className="chat-entry-banner__copy">
        <span className="chat-entry-banner__mark" aria-hidden="true">
          <MessageCircle size={18} />
        </span>
        <span className="chat-entry-banner__words">
          <span className="eyebrow">Primary workspace · Chat</span>
          <strong>Talk to Omnia</strong>
          <small>Ask a question, paste code, or turn a rough idea into a plan.</small>
        </span>
      </div>
      <div className="chat-entry-banner__actions">
        <span className="chat-entry-banner__ready">
          <Sparkles size={13} aria-hidden="true" />
          <span>{modelLabel} ready</span>
          <small>{messageCount} message{messageCount === 1 ? "" : "s"}</small>
        </span>
        <button type="button" className="chat-entry-banner__focus" onClick={focusComposer} aria-label="Jump to the message composer" title="Focus the message composer">
          <span>Jump to message box</span>
          <ArrowDown size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="chat-entry-banner__hint">
        <Keyboard size={13} aria-hidden="true" />
        <span>Enter to send</span>
        <span aria-hidden="true">·</span>
        <span>Shift + Enter for a new line</span>
      </div>
    </section>
  );
}
