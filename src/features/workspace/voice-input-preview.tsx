import { ChevronDown, Globe2, Mic, MicOff, SlidersHorizontal } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

export type VoiceInputState = "idle" | "listening" | "error";
export type VoiceInsertMode = "append" | "replace";

export interface VoiceInputPreviewProps {
  readonly available: boolean;
  readonly state: VoiceInputState;
  readonly language: string;
  readonly insertMode: VoiceInsertMode;
  readonly error?: string | null;
  readonly onLanguageChange: (language: string) => void;
  readonly onInsertModeChange: (mode: VoiceInsertMode) => void;
  readonly onToggleListening: () => void;
}

/**
 * Renderer-local voice controls for the composer.
 *
 * The panel intentionally describes browser recognition as a preview. It does
 * not imply that microphone audio is uploaded, persisted, or dispatched to a
 * provider; the existing recognizer callback remains the only owner of those
 * boundaries.
 */
export function VoiceInputPreview({
  available,
  state,
  language,
  insertMode,
  error,
  onLanguageChange,
  onInsertModeChange,
  onToggleListening,
}: VoiceInputPreviewProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const optionsTriggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const listening = state === "listening";

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !rootRef.current?.contains(target)) {
        // The pointer is already moving to another control. Dismiss without
        // pulling focus back to the voice-options trigger.
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      optionsTriggerRef.current?.focus({ preventScroll: true });
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="voice-input-preview">
      <button
        type="button"
        className={`composer-tool${listening ? " composer-tool--active" : ""}`}
        title={listening ? "Stop voice input" : "Start voice input"}
        aria-label={listening ? "Stop voice input" : "Start voice input"}
        aria-pressed={listening}
        disabled={!available && !listening}
        onClick={onToggleListening}
      >
        {listening ? <MicOff size={17} /> : <Mic size={17} />}
      </button>
      <div className="popover-anchor">
        <button
          ref={optionsTriggerRef}
          type="button"
          className={`composer-tool voice-input-preview__options${open ? " composer-tool--active" : ""}`}
          title="Voice input options"
          aria-label="Voice input options"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => setOpen((current) => !current)}
        >
          <SlidersHorizontal size={15} />
          <ChevronDown size={11} />
        </button>
        {open ? (
          <div id={panelId} className="composer-popover voice-input-preview__panel" role="dialog" aria-label="Voice input options">
            <div className="voice-input-preview__heading" id={`${panelId}-heading`}>
              <span className="voice-input-preview__icon" aria-hidden="true"><Globe2 size={14} /></span>
              <span>
                <strong>Voice input</strong>
                <small>Browser preview · transcript stays in this draft</small>
              </span>
            </div>
            <label>
              <span>Recognition language</span>
              <select value={language} onChange={(event) => onLanguageChange(event.target.value)}>
                <option value="vi-VN">Vietnamese · vi-VN</option>
                <option value="en-US">English · en-US</option>
                <option value="ja-JP">Japanese · ja-JP</option>
                <option value="ko-KR">Korean · ko-KR</option>
              </select>
            </label>
            <label>
              <span>Insert transcript</span>
              <select value={insertMode} onChange={(event) => onInsertModeChange(event.target.value as VoiceInsertMode)}>
                <option value="append">Append to current draft</option>
                <option value="replace">Replace current draft</option>
              </select>
            </label>
            <p className="voice-input-preview__boundary">
              {available
                ? "Starting voice input is an explicit microphone-consent action. SpeechRecognition is available in this browser; this preview keeps the transcript in the draft and does not claim native audio upload or durable history."
                : "SpeechRecognition is unavailable here. Typed input remains available."}
            </p>
            {error ? <p className="voice-input-preview__error">{error}</p> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
