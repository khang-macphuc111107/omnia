import { ChevronDown, File, FileCode2, FileImage, FileSpreadsheet, FileText, Globe2, Plus, RotateCcw, Send, Sparkles, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import {
  applyComposerSlashCommand,
  collectCrossAgentPromptHistory,
  findComposerSlashCommands,
  getComposerSlashContext,
  type ComposerSlashCommand,
  type ComposerSlashContext,
} from "./composer-slash-commands";
import "../../styles/review-composer.css";

export interface AiPanelComposerAttachment {
  id: string;
  label: string;
  kind?: "file" | "tab";
  lineRange?: string;
  onRemove?: () => void;
}

export interface ComposerChoice {
  id: string;
  label: string;
}

export const DEFAULT_COMPOSER_PROVIDERS: readonly ComposerChoice[] = Object.freeze([
  { id: "auto", label: "Auto Route" },
  { id: "anthropic", label: "Anthropic Claude" },
  { id: "openai", label: "OpenAI Codex" },
  { id: "google", label: "Google Gemini" },
  { id: "openrouter", label: "OpenRouter / Local" },
]);

export const DEFAULT_COMPOSER_EFFORTS: readonly ComposerChoice[] = Object.freeze([
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "xHigh" },
  { id: "max", label: "Max" },
]);

export function enhanceDraftPromptText(
  rawDraft: string,
  context?: { providerLabel?: string | undefined; modelLabel?: string | undefined; effortLabel?: string | undefined },
): string {
  const trimmed = rawDraft.trim();
  const target =
    trimmed.length > 0
      ? trimmed
      : "Audit the active workspace state, identify the highest-impact engineering or UI defects, and implement verified fixes.";
  // Avoid double-wrapping if already enhanced
  if (target.includes("[Constraints & Verification]")) {
    return target;
  }
  const routeNote = [context?.providerLabel, context?.modelLabel, context?.effortLabel]
    .filter(Boolean)
    .join(" · ");
  return [
    target,
    "",
    `[Constraints & Verification${routeNote ? ` — ${routeNote}` : ""}]:`,
    "1. Read relevant source files and tests before editing; preserve existing public contracts.",
    "2. Implement complete, production-grade changes with zero placeholder stubs or AI filler.",
    "3. Verify with typecheck and targeted unit/integration tests and report exact outcomes.",
  ].join("\n");
}

export function buildLivePromptSuggestions(rawDraft: string): readonly string[] {
  const trimmed = rawDraft.trim();
  if (!trimmed) {
    return [
      "Inspect active file & run targeted tests",
      "Trace root cause & propose minimal patch",
      "Explain architecture & key trade-offs",
    ];
  }
  if (trimmed.startsWith("/")) {
    return [
      "/plan Draft a step-by-step implementation plan",
      "/compact Summarize conversation context",
      "/review Audit active diff and test coverage",
    ];
  }
  return [
    `${trimmed} — verify with unit tests and cite exact file lines`,
    `${trimmed} — keep changes surgical and preserve existing types`,
    `${trimmed} — explain trade-offs and edge cases concisely`,
  ];
}

export interface ComposerPromptAssistBarProps {
  value: string;
  onChange: (nextValue: string) => void;
  disabled?: boolean | undefined;
  providers?: readonly ComposerChoice[] | undefined;
  providerId?: string | undefined;
  providerLabel?: string | undefined;
  onProviderChange?: ((id: string) => void) | undefined;
  modelLabel?: string | undefined;
  effortLabel?: string | undefined;
  testIdPrefix?: string | undefined;
}

export function ComposerPromptAssistBar({
  value,
  onChange,
  disabled = false,
  providers = DEFAULT_COMPOSER_PROVIDERS,
  providerId,
  providerLabel,
  onProviderChange,
  modelLabel,
  effortLabel,
  testIdPrefix = "composer",
}: ComposerPromptAssistBarProps) {
  const [preEnhanceDraft, setPreEnhanceDraft] = useState<string | null>(null);
  const effectiveProviders = (() => {
    if (!providers || providers.length === 0) return DEFAULT_COMPOSER_PROVIDERS;
    const seen = new Set(providers.map((p) => p.id));
    return [...providers, ...DEFAULT_COMPOSER_PROVIDERS.filter((p) => !seen.has(p.id))];
  })();
  const [localProviderId, setLocalProviderId] = useState<string>(
    providerId || effectiveProviders[0]?.id || "anthropic",
  );
  const providerValue = providerId || localProviderId;
  const resolvedProviderLabel =
    providerLabel ||
    effectiveProviders.find((p) => p.id === providerValue)?.label ||
    effectiveProviders[0]?.label ||
    "Anthropic Claude";
  const suggestions = buildLivePromptSuggestions(value);

  const handleEnhance = () => {
    if (disabled) return;
    setPreEnhanceDraft(value);
    const enhanced = enhanceDraftPromptText(value, {
      providerLabel: resolvedProviderLabel,
      modelLabel,
      effortLabel,
    });
    onChange(enhanced);
  };

  const handleUndoEnhance = () => {
    if (disabled || preEnhanceDraft === null) return;
    onChange(preEnhanceDraft);
    setPreEnhanceDraft(null);
  };

  return (
    <div
      className="composer-prompt-assist-bar"
      data-testid={`${testIdPrefix}-prompt-assist-bar`}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "6px",
        flexWrap: "wrap",
        padding: "4px 8px",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        fontSize: "11px",
      }}
    >
      <div
        className="composer-live-suggestions"
        data-testid={`${testIdPrefix}-live-suggestions`}
        style={{ display: "flex", alignItems: "center", gap: "5px", flexWrap: "wrap", flex: 1, minWidth: 0 }}
      >
        <label
          className="review-composer-select review-composer-select--provider"
          title={resolvedProviderLabel ? `Provider (${resolvedProviderLabel})` : "Choose provider"}
          style={{ marginRight: "4px" }}
        >
          <select
            aria-label="Provider"
            data-testid="composer-provider-selector"
            value={providerValue}
            disabled={disabled}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setLocalProviderId(next);
              onProviderChange?.(next);
            }}
          >
            {effectiveProviders.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.label}
              </option>
            ))}
          </select>
          <ChevronDown size={11} strokeWidth={1.75} aria-hidden="true" />
        </label>
        <span style={{ color: "var(--text-tertiary, #94a3b8)", fontWeight: 600, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
          Suggestions
        </span>
        {suggestions.map((suggestion, idx) => (
          <button
            key={`${idx}-${suggestion}`}
            type="button"
            className="composer-live-suggestion-chip"
            data-testid={`${testIdPrefix}-live-suggestion-chip`}
            disabled={disabled}
            onClick={() => onChange(suggestion)}
            title={`Apply suggestion: ${suggestion} (or press Tab)`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              maxWidth: "240px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              padding: "2px 7px",
              borderRadius: "999px",
              border: "1px solid rgba(148, 163, 184, 0.22)",
              background: "rgba(15, 23, 42, 0.45)",
              color: "var(--text-secondary, #cbd5e1)",
              fontSize: "11px",
              cursor: disabled ? "not-allowed" : "pointer",
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{suggestion}</span>
          </button>
        ))}
      </div>
      <div style={{ display: "inline-flex", alignItems: "center", gap: "4px", flexShrink: 0 }}>
        <button
          type="button"
          className="composer-enhance-btn"
          data-testid={`${testIdPrefix}-enhance-prompt-btn`}
          aria-label="Enhance prompt"
          title="Rewrite and structure prompt with engineering constraints & verification steps"
          disabled={disabled}
          onClick={handleEnhance}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            padding: "2px 8px",
            borderRadius: "6px",
            border: "1px solid rgba(56, 189, 248, 0.35)",
            background: "rgba(56, 189, 248, 0.12)",
            color: "#38bdf8",
            fontSize: "11px",
            fontWeight: 600,
            cursor: disabled ? "not-allowed" : "pointer",
          }}
        >
          <Sparkles size={11} strokeWidth={1.9} aria-hidden="true" />
          <span>Enhance</span>
        </button>
        {preEnhanceDraft !== null ? (
          <button
            type="button"
            className="composer-undo-enhance-btn"
            data-testid={`${testIdPrefix}-undo-enhance-btn`}
            aria-label="Undo enhance prompt"
            title="Restore original prompt before enhancement"
            disabled={disabled}
            onClick={handleUndoEnhance}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "3px",
              padding: "2px 6px",
              borderRadius: "6px",
              border: "1px solid rgba(148, 163, 184, 0.28)",
              background: "rgba(30, 41, 59, 0.55)",
              color: "var(--text-secondary, #cbd5e1)",
              fontSize: "11px",
              cursor: disabled ? "not-allowed" : "pointer",
            }}
          >
            <RotateCcw size={10} strokeWidth={1.9} aria-hidden="true" />
            <span>Undo</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

export interface ComposerRouteControlsProps {
  disabled?: boolean | undefined;
  effortDisabled?: boolean | undefined;
  providers?: readonly ComposerChoice[] | undefined;
  providerId?: string | undefined;
  providerLabel?: string | undefined;
  onProviderChange?: ((id: string) => void) | undefined;
  modelLabel?: string | undefined;
  effortLabel?: string | undefined;
  models?: readonly ComposerChoice[] | undefined;
  modelId?: string | undefined;
  onModelChange?: ((id: string) => void) | undefined;
  efforts?: readonly ComposerChoice[] | undefined;
  effortId?: string | undefined;
  onEffortChange?: ((id: string) => void) | undefined;
}

/** A compact native selector bar for Model + Effort inside the composer footer. */
export function ComposerRouteControls({
  disabled = false,
  effortDisabled = false,
  modelLabel,
  effortLabel,
  models = [],
  modelId,
  onModelChange,
  efforts = [],
  effortId,
  onEffortChange,
}: ComposerRouteControlsProps) {
  const modelValue = modelId ?? models[0]?.id ?? "";
  const effortValue = effortId ?? efforts[0]?.id ?? "";
  return (
    <>
      <label className="review-composer-select" title="Choose model">
        <select
          aria-label="Model"
          data-testid="composer-model-selector"
          value={modelValue}
          disabled={disabled || (!onModelChange && models.length <= 1)}
          onChange={(event) => onModelChange?.(event.currentTarget.value)}
        >
          {models.length > 0 ? models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>) : <option value={modelValue}>{modelLabel ?? "No model"}</option>}
        </select>
        <ChevronDown size={11} strokeWidth={1.75} aria-hidden="true" />
      </label>
      <label className="review-composer-select review-composer-select--effort" title="Reasoning effort">
        <select
          aria-label="Reasoning effort"
          data-testid="composer-effort-selector"
          value={effortValue}
          disabled={disabled || effortDisabled || (!onEffortChange && efforts.length <= 1)}
          onChange={(event) => onEffortChange?.(event.currentTarget.value)}
        >
          {efforts.length > 0 ? efforts.map((effort) => <option key={effort.id} value={effort.id}>{effort.label}</option>) : <option value={effortValue}>{effortLabel ?? "Effort"}</option>}
        </select>
        <ChevronDown size={11} strokeWidth={1.75} aria-hidden="true" />
      </label>
    </>
  );
}

export function ComposerFileTypeIcon({ name, kind }: { name: string; kind?: "file" | "tab" | "code" | "image" | "document" | "data" | "audio" | "video" }) {
  const props = { size: 15, strokeWidth: 1.75, "aria-hidden": true as const };
  if (kind === "tab") return <Globe2 {...props} />;
  const clean = name.replace(/:[\d–-]+$/, "").toLowerCase();
  if (/\.[cm]?tsx?$/.test(clean)) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true" focusable="false" className="lucide-file-code-2 dev-file-icon dev-file-icon--ts">
        <rect x="1" y="1" width="14" height="14" rx="3" fill="#3178c6" stroke="none" />
        <path d="M4.2 6.2h4.4M6.4 6.2v5.6M12.7 7.1c-.3-.5-.9-.8-1.6-.8-.9 0-1.5.5-1.5 1.2 0 1.5 3.1.9 3.1 2.6 0 .8-.7 1.3-1.7 1.3-.8 0-1.4-.3-1.8-.9" stroke="#ffffff" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (/\.[cm]?jsx?$/.test(clean)) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true" focusable="false" className="lucide-file-code-2 dev-file-icon dev-file-icon--js">
        <rect x="1" y="1" width="14" height="14" rx="3" fill="#eab308" stroke="none" />
        <path d="M7.2 6.2v4.1c0 .9-.6 1.4-1.4 1.4-.6 0-1.1-.3-1.3-.8M12.7 7.1c-.3-.5-.9-.8-1.6-.8-.9 0-1.5.5-1.5 1.2 0 1.5 3.1.9 3.1 2.6 0 .8-.7 1.3-1.7 1.3-.8 0-1.4-.3-1.8-.9" stroke="#111318" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (/\.(?:md|mdx)$/.test(clean)) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true" focusable="false" className="lucide-file-text dev-file-icon dev-file-icon--md">
        <rect x="1" y="2" width="14" height="12" rx="2.5" fill="rgba(56, 189, 248, 0.16)" stroke="#38bdf8" strokeWidth="1.3" />
        <path d="M3.6 10.6V5.6l2 2.3 2-2.3v5M11.3 5.6v4.8m-1.6-1.6 1.6 1.8 1.6-1.8" stroke="#38bdf8" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (/\.rs$/.test(clean)) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true" focusable="false" className="lucide-file-code-2 dev-file-icon dev-file-icon--rs">
        <rect x="1" y="1" width="14" height="14" rx="3" fill="rgba(251, 146, 60, 0.18)" stroke="#fb923c" strokeWidth="1.3" />
        <circle cx="8" cy="8" r="3.2" stroke="#fb923c" strokeWidth="1.4" />
        <path d="M8 3.2v1.4M8 11.4v1.4M3.2 8h1.4M11.4 8h1.4" stroke="#fb923c" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (/\.(?:json|jsonc|jsonl|toml|yaml|yml)$/.test(clean)) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true" focusable="false" className="lucide-file-code-2 dev-file-icon dev-file-icon--json">
        <rect x="1" y="1" width="14" height="14" rx="3" fill="rgba(250, 204, 21, 0.15)" stroke="#facc15" strokeWidth="1.25" />
        <path d="M6.2 4.5c-1 0-1.4.5-1.4 1.3v1.1c0 .6-.4 1.1-1 1.1.6 0 1 .5 1 1.1v1.1c0 .8.4 1.3 1.4 1.3M9.8 4.5c1 0 1.4.5 1.4 1.3v1.1c0 .6.4 1.1 1 1.1-.6 0-1 .5-1 1.1v1.1c0 .8-.4 1.3-1.4 1.3" stroke="#facc15" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (/\.(?:css|scss|less)$/.test(clean)) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true" focusable="false" className="lucide-file-code-2 dev-file-icon dev-file-icon--css">
        <rect x="1" y="1" width="14" height="14" rx="3" fill="rgba(167, 139, 250, 0.16)" stroke="#a78bfa" strokeWidth="1.25" />
        <path d="M4.5 6.3h7M4.5 9.7h7M6.5 4.3l-.8 7.4M10.3 4.3l-.8 7.4" stroke="#a78bfa" strokeWidth="1.35" strokeLinecap="round" />
      </svg>
    );
  }
  if (/\.py$/.test(clean)) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true" focusable="false" className="lucide-file-code-2 dev-file-icon dev-file-icon--py">
        <rect x="1" y="1" width="14" height="14" rx="3" fill="rgba(96, 165, 250, 0.16)" stroke="#60a5fa" strokeWidth="1.25" />
        <path d="M5.5 7.5V5.6c0-.9.8-1.6 2.5-1.6s2.5.7 2.5 1.6v1.9c0 .8-.7 1.4-1.5 1.4H7c-.8 0-1.5.6-1.5 1.4v1.7" stroke="#60a5fa" strokeWidth="1.35" strokeLinecap="round" />
        <path d="M10.5 8.5v1.9c0 .9-.8 1.6-2.5 1.6" stroke="#facc15" strokeWidth="1.35" strokeLinecap="round" />
      </svg>
    );
  }
  if (/\.go$/.test(clean)) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true" focusable="false" className="lucide-file-code-2 dev-file-icon dev-file-icon--go">
        <rect x="1" y="1" width="14" height="14" rx="3" fill="rgba(34, 211, 238, 0.16)" stroke="#22d3ee" strokeWidth="1.25" />
        <path d="M6.8 6.2H4.9a1.8 1.8 0 1 0 0 3.6h1.9V8.1H5.6M10.5 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6Z" stroke="#22d3ee" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === "code" || /\.(?:java|c|h|cpp|hpp|cs|rb|php|swift|kt|sh|ps1|html|vue|svelte|sql)$/i.test(clean)) return <FileCode2 {...props} style={{ color: "#60a5fa" }} />;
  if (kind === "image" || /\.(?:png|jpe?g|webp|gif|svg|avif)$/i.test(clean)) return <FileImage {...props} style={{ color: "#34d399" }} />;
  if (kind === "data" || /\.(?:csv|xlsx?)$/i.test(clean)) return <FileSpreadsheet {...props} style={{ color: "#fbbf24" }} />;
  if (kind === "document" || /\.(?:txt|pdf|docx?)$/i.test(clean)) return <FileText {...props} style={{ color: "#93c5fd" }} />;
  return <File {...props} style={{ color: "#94a3b8" }} />;
}

export function ComposerContextChip({ attachment, disabled = false }: { attachment: AiPanelComposerAttachment; disabled?: boolean }) {
  const match = attachment.kind !== "tab" ? /^(.*?)(:\d+(?:[–-]\d+)?)$/.exec(attachment.label) : null;
  const filename = match?.[1] ?? attachment.label;
  const range = attachment.lineRange ?? match?.[2];
  return (
    <span className="review-composer-chip" title={attachment.label}>
      <ComposerFileTypeIcon name={filename} kind={attachment.kind ?? "file"} />
      <span className="review-composer-chip__name">{filename}</span>
      {range ? <span className="review-composer-chip__lines">{range.startsWith(":") ? range : `:${range}`}</span> : null}
      {attachment.onRemove ? (
        <button type="button" className="review-composer-chip__remove" title={`Remove ${filename}`} aria-label={`Remove ${filename}`} disabled={disabled} onClick={attachment.onRemove}>
          <X size={12} strokeWidth={1.75} aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}

export interface AiPanelComposerProps extends ComposerRouteControlsProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  pending?: boolean;
  attachments?: readonly AiPanelComposerAttachment[];
  onAttach?: () => void;
  inputLabel?: string;
  inputTestId?: string;
  sendTestId?: string;
  promptHistory?: readonly string[];
}

/** Shared controlled composer. Sending and attachments stay owned by the caller. */
export function AiPanelComposer({
  value,
  onChange,
  onSend,
  disabled = false,
  pending = false,
  attachments = [],
  onAttach,
  inputLabel = "Message AI",
  inputTestId,
  sendTestId,
  providers,
  providerId,
  providerLabel,
  onProviderChange,
  promptHistory = [],
  ...routeControls
}: AiPanelComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const menuId = useId();
  const [context, setContext] = useState<ComposerSlashContext | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [savedDraftBeforeHistory, setSavedDraftBeforeHistory] = useState<string>("");
  const slashSelectionRef = useRef<{ value: string; start: number; end: number } | null>(null);
  const commands = context ? findComposerSlashCommands(context.query, { includeExtended: true }) : [];
  const menuOpen = commands.length > 0;
  const activeCommand = commands[Math.min(activeIndex, commands.length - 1)];

  useEffect(() => {
    if (!menuOpen) return;
    window.dispatchEvent(new CustomEvent("omnia:close-floating-menus", { detail: { source: menuId } }));
  }, [menuOpen, menuId]);

  useEffect(() => {
    const handleCloseFloating = (event: Event) => {
      const detail = (event as CustomEvent<{ source?: string }>).detail;
      if (detail?.source !== menuId) {
        setContext(null);
      }
    };
    window.addEventListener("omnia:close-floating-menus", handleCloseFloating);
    return () => window.removeEventListener("omnia:close-floating-menus", handleCloseFloating);
  }, [menuId]);

  useEffect(() => {
    if (!activeCommand) return;
    document.getElementById(`${menuId}-${activeCommand.id}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeCommand, menuId]);
  const syncMenu = (input: HTMLTextAreaElement) => {
    const previous = slashSelectionRef.current;
    if (previous?.value === input.value && previous.start === input.selectionStart && previous.end === input.selectionEnd) return;
    slashSelectionRef.current = { value: input.value, start: input.selectionStart, end: input.selectionEnd };
    setContext(getComposerSlashContext(input.value, input.selectionStart, input.selectionEnd));
    setActiveIndex(0);
  };
  const selectCommand = (command: ComposerSlashCommand) => {
    if (!context) return;
    const change = applyComposerSlashCommand(value, context.slashEnd, context.slashEnd, command.id);
    onChange(change.value);
    setContext(null);
    setActiveIndex(0);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(change.selectionStart, change.selectionEnd);
    });
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (menuOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        setContext(null);
        setActiveIndex(0);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((index) => (index + delta + commands.length) % commands.length);
        return;
      }
      if ((event.key === "Tab" && !event.shiftKey) || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        if (activeCommand) selectCommand(activeCommand);
        return;
      }
    }
    if (!menuOpen && event.key === "Tab" && !event.shiftKey && value.trim().length > 0) {
      const topSuggestion = buildLivePromptSuggestions(value)[0];
      if (topSuggestion && topSuggestion !== value) {
        event.preventDefault();
        onChange(topSuggestion);
        return;
      }
    }
    if (!menuOpen && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      const effectiveHistory = collectCrossAgentPromptHistory([], promptHistory);
      if (effectiveHistory.length > 0) {
        if (event.key === "ArrowUp" && (value.trim() === "" || historyIndex !== -1)) {
          event.preventDefault();
          const nextIdx = historyIndex === -1 ? effectiveHistory.length - 1 : Math.max(0, historyIndex - 1);
          if (historyIndex === -1) setSavedDraftBeforeHistory(value);
          setHistoryIndex(nextIdx);
          onChange(effectiveHistory[nextIdx] ?? value);
          return;
        }
        if (event.key === "ArrowDown" && historyIndex !== -1) {
          event.preventDefault();
          if (historyIndex >= effectiveHistory.length - 1) {
            setHistoryIndex(-1);
            onChange(savedDraftBeforeHistory);
          } else {
            const nextIdx = historyIndex + 1;
            setHistoryIndex(nextIdx);
            onChange(effectiveHistory[nextIdx] ?? savedDraftBeforeHistory);
          }
          return;
        }
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!disabled && !pending && value.trim()) {
        setHistoryIndex(-1);
        onSend();
      }
    }
  };
  return (
    <div className="ai-panel-composer" aria-label="AI message composer">
      {attachments.length > 0 ? (
        <div className="review-composer-chips" aria-label="Message context">
          {attachments.map((attachment) => <ComposerContextChip key={attachment.id} attachment={attachment} disabled={disabled || pending} />)}
        </div>
      ) : null}
      <div className="ai-panel-composer__input">
        <textarea
          ref={inputRef}
          aria-label={inputLabel}
          data-testid={inputTestId}
          placeholder="Ask anything..."
          value={value}
          disabled={disabled || pending}
          rows={2}
          aria-autocomplete="list"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          aria-activedescendant={menuOpen && activeCommand ? `${menuId}-${activeCommand.id}` : undefined}
          onChange={(event) => { setHistoryIndex(-1); onChange(event.currentTarget.value); syncMenu(event.currentTarget); }}
          onSelect={(event) => syncMenu(event.currentTarget)}
          onBlur={() => { setContext(null); slashSelectionRef.current = null; }}
          onKeyDown={handleKeyDown}
        />
        {menuOpen ? (
          <div id={menuId} className="review-slash-popover" role="listbox" aria-label="Slash commands">
            <div className="review-slash-popover__header"><span>Commands</span><kbd>Tab ↵</kbd></div>
            {commands.map((command, index) => (
              <div
                key={command.id}
                id={`${menuId}-${command.id}`}
                role="option"
                aria-selected={index === activeIndex}
                className={index === activeIndex ? "review-slash-option review-slash-option--active" : "review-slash-option"}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectCommand(command)}
              >
                <span className="review-slash-option__command">{command.command}</span>
                <span><strong>{command.label}</strong><small>{command.description}</small></span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <ComposerPromptAssistBar
        value={value}
        onChange={onChange}
        disabled={disabled || pending}
        providers={providers}
        providerId={providerId}
        providerLabel={providerLabel}
        onProviderChange={onProviderChange}
        modelLabel={routeControls.modelLabel}
        effortLabel={routeControls.effortLabel}
        testIdPrefix="ai-panel"
      />
      <div className="review-composer-footer">
        <div className="review-composer-footer__left">
          <button type="button" className="review-composer-icon" title="Attach files" aria-label="Attach files" disabled={disabled || pending || !onAttach} onClick={onAttach}>
            <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <ComposerRouteControls
            {...routeControls}
            providers={providers}
            providerId={providerId}
            providerLabel={providerLabel}
            onProviderChange={onProviderChange}
            disabled={disabled || pending}
          />
        </div>
        <button type="button" className="review-composer-send" title="Send" aria-label="Send" data-testid={sendTestId} disabled={disabled || pending || !value.trim()} aria-busy={pending} onClick={onSend}>
          <Send size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>Send</span>
        </button>
      </div>
    </div>
  );
}
