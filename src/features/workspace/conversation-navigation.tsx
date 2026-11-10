import {
  AlertTriangle,
  Check,
  CircleDot,
  ChevronLeft,
  ChevronRight,
  Copy,
  ListTree,
  MessageSquareText,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import {
  buildNavigationProjection,
  createRendererDeepLinkPreview,
  filterNavigationMarkers,
  parseRendererDeepLinkPreview,
  resolveRendererDeepLinkPreview,
  type NavigationFacet,
  type NavigationMarker,
  type NavigationProjection,
} from "./conversation-navigation-model";
import type { ChatMessage } from "./types";

export interface ConversationNavigationProps {
  readonly messages: readonly ChatMessage[];
  readonly currentMessageId: string | null;
  readonly onNavigate: (messageId: string) => void;
  readonly onCurrentMessageChange?: (messageId: string) => void;
  /** Stable identity is optional because the browser preview can render a chat without native scope metadata. */
  readonly conversationId?: string | null;
  readonly projectId?: string | null;
  readonly branchId?: string | null;
  readonly sourceRevision?: string | null;
}

function targetElement(messageId: string): HTMLElement | null {
  if (typeof document === "undefined") return null;
  // Message ids are opaque native values and may contain selector-significant
  // characters. Resolve the renderer-owned id directly instead of building a
  // CSS selector from untrusted/persisted text.
  return document.getElementById(`message-${messageId}`);
}

function markerIcon(marker: NavigationMarker) {
  if (marker.kind === "issue") return <AlertTriangle size={13} aria-hidden="true" />;
  if (marker.kind === "prompt") return <MessageSquareText size={13} aria-hidden="true" />;
  return <CircleDot size={13} aria-hidden="true" />;
}

function markerClassName(marker: NavigationMarker, active: boolean, unavailable: boolean): string {
  return [
    "conversation-navigation__marker",
    active ? "conversation-navigation__marker--active" : "",
    marker.kind === "issue" ? "conversation-navigation__marker--issue" : "",
    marker.status === "streaming" ? "conversation-navigation__marker--streaming" : "",
    unavailable ? "conversation-navigation__marker--unavailable" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function targetAvailability(projection: NavigationProjection): Set<string> {
  const unavailable = new Set<string>();
  for (const marker of projection.markers) {
    if (!targetElement(marker.messageId)) unavailable.add(marker.messageId);
  }
  return unavailable;
}

/**
 * A compact, renderer-local map for the active conversation. It deliberately
 * says "local" and "preview" so users can distinguish it from durable native
 * Jump Target persistence, which is not available in this renderer slice.
 */
export function ConversationNavigation({
  messages,
  currentMessageId,
  onNavigate,
  onCurrentMessageChange,
  conversationId = null,
  projectId = null,
  branchId = null,
  sourceRevision = null,
}: ConversationNavigationProps) {
  const projection = useMemo(() => buildNavigationProjection(messages), [messages]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [facet, setFacet] = useState<NavigationFacet>("all");
  // Keep the filters discoverable on first open, but let the slider control
  // collapse them after the user has chosen a facet. The previous control
  // only focused the search field, which made a visible filter affordance
  // look like a dead dropdown in the compact Chat toolbar.
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [unavailableMessageIds, setUnavailableMessageIds] = useState<Set<string>>(new Set());
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null);
  const [deepLinkStatus, setDeepLinkStatus] = useState("");
  const [historyItems, setHistoryItems] = useState<string[]>(() => (currentMessageId ? [currentMessageId] : []));
  const [historyIndex, setHistoryIndex] = useState(() => (currentMessageId ? 0 : -1));
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const markerButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const historyRef = useRef<string[]>(currentMessageId ? [currentMessageId] : []);
  const historyIndexRef = useRef(currentMessageId ? 0 : -1);

  const closePanel = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  };

  const filteredMarkers = useMemo(
    () => filterNavigationMarkers(projection.markers, { query, facet }),
    [facet, projection.markers, query],
  );
  const deepLinkPreview = useMemo(
    () => createRendererDeepLinkPreview({ conversationId: conversationId ?? "", projectId, branchId, messageId: currentMessageId, sourceRevision }),
    [branchId, conversationId, currentMessageId, projectId, sourceRevision],
  );
  const parsedDeepLink = useMemo(
    () => (deepLinkPreview ? parseRendererDeepLinkPreview(deepLinkPreview) : null),
    [deepLinkPreview],
  );
  const deepLinkResolution = useMemo(() => {
    if (!parsedDeepLink?.target) return null;
    const messageIds = projection.markers.map((marker) => marker.messageId);
    const runIds = projection.markers.flatMap((marker) => marker.runId ? [marker.runId] : []);
    return resolveRendererDeepLinkPreview(parsedDeepLink.target, {
      conversationId,
      projectId,
      branchId,
      sourceRevision,
      messageIds,
      runIds,
    });
  }, [branchId, conversationId, parsedDeepLink, projectId, projection.markers, sourceRevision]);

  useEffect(() => {
    const seed = currentMessageId ? [currentMessageId] : [];
    historyRef.current = seed;
    historyIndexRef.current = seed.length > 0 ? 0 : -1;
    setHistoryItems(seed);
    setHistoryIndex(historyIndexRef.current);
    setDeepLinkStatus("");
  }, [conversationId]);

  useEffect(() => {
    if (!open) return;
    const active = filteredMarkers.find((marker) => marker.messageId === currentMessageId);
    setFocusedMessageId(active?.messageId ?? filteredMarkers[0]?.messageId ?? null);
  }, [currentMessageId, filteredMarkers, open]);

  useEffect(() => {
    if (!open) return;
    const updateAvailability = () => setUnavailableMessageIds(targetAvailability(projection));
    updateAvailability();
    // The transcript and toolbar are committed together, but a frame gives
    // the browser a chance to finish mounting anchors before we inspect them.
    const timeout = window.setTimeout(updateAvailability, 0);
    return () => window.clearTimeout(timeout);
  }, [open, projection]);

  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(
      new CustomEvent("omnia:close-floating-menus", { detail: { source: "conversation-navigation" } }),
    );
    const onCloseFloating = (event: Event) => {
      const detail = (event as CustomEvent<{ source?: string }>).detail;
      if (detail?.source !== "conversation-navigation") {
        closePanel();
      }
    };
    // Focus immediately for keyboard users; the frame retry covers a browser
    // commit where the input is mounted one paint after the panel shell.
    searchRef.current?.focus({ preventScroll: true });
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePanel(true);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !rootRef.current?.contains(target)) {
        // The pointer is already moving to another control. Dismiss without
        // pulling focus back to the map trigger.
        closePanel();
      }
    };
    window.addEventListener("omnia:close-floating-menus", onCloseFloating);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("omnia:close-floating-menus", onCloseFloating);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const navigate = (marker: NavigationMarker) => {
    if (unavailableMessageIds.has(marker.messageId)) {
      setDeepLinkStatus("This target is stale in the current transcript; no unrelated message was opened.");
      return;
    }
    const currentIndex = historyIndexRef.current;
    const nextItems = historyRef.current.slice(0, currentIndex + 1);
    if (nextItems[nextItems.length - 1] !== marker.messageId) nextItems.push(marker.messageId);
    historyRef.current = nextItems;
    historyIndexRef.current = nextItems.length - 1;
    setHistoryItems(nextItems);
    setHistoryIndex(historyIndexRef.current);
    onCurrentMessageChange?.(marker.messageId);
    onNavigate(marker.messageId);
    closePanel();
  };

  const moveHistory = (direction: -1 | 1) => {
    const nextIndex = historyIndexRef.current + direction;
    const nextMessageId = historyRef.current[nextIndex];
    if (nextMessageId === undefined) return;
    historyIndexRef.current = nextIndex;
    setHistoryIndex(nextIndex);
    onCurrentMessageChange?.(nextMessageId);
    onNavigate(nextMessageId);
  };

  const copyDeepLink = async () => {
    if (!deepLinkPreview) {
      setDeepLinkStatus("Stable conversation identity is unavailable in this preview; nothing was copied.");
      return;
    }
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setDeepLinkStatus("Clipboard access is unavailable; no deep link was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(deepLinkPreview);
      setDeepLinkStatus("Copied a renderer-local deep-link preview.");
    } catch {
      setDeepLinkStatus("Clipboard access was denied; no deep link was copied.");
    }
  };

  const focusFilteredMarker = (index: number) => {
    const marker = filteredMarkers[index];
    if (!marker) return;
    setFocusedMessageId(marker.messageId);
    markerButtonRefs.current.get(marker.messageId)?.focus({ preventScroll: true });
  };

  const handleMarkerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, marker: NavigationMarker) => {
    const index = filteredMarkers.findIndex((item) => item.messageId === marker.messageId);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusFilteredMarker(Math.min(filteredMarkers.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusFilteredMarker(Math.max(0, index - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      focusFilteredMarker(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusFilteredMarker(filteredMarkers.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      navigate(marker);
    }
  };

  const activeMarker = projection.markers.find((marker) => marker.messageId === currentMessageId) ?? null;
  const activeLabel = activeMarker ? activeMarker.label : "No message selected";
  const promptLabel = projection.promptCount === 1 ? "prompt" : "prompts";
  const outputLabel = projection.outputCount === 1 ? "output" : "outputs";
  const issueLabel = projection.issueCount === 1 ? "issue" : "issues";

  return (
    <div className="conversation-navigation" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={open ? "conversation-navigation__trigger conversation-navigation__trigger--active" : "conversation-navigation__trigger"}
        aria-label="Open local conversation map"
        aria-controls="conversation-navigation-panel"
        aria-expanded={open}
        title="Conversation map"
        onClick={() => setOpen((value) => !value)}
      >
        <ListTree size={15} strokeWidth={1.75} aria-hidden="true" />
      </button>

      {open ? (
        <section
          id="conversation-navigation-panel"
          className="conversation-navigation__panel"
          role="dialog"
          aria-label="Local conversation map"
          aria-modal="false"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <header className="conversation-navigation__header">
            <div>
              <span className="eyebrow">Preview navigation</span>
              <h2>Conversation map</h2>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="Close conversation map"
              title="Close conversation map"
              onClick={() => {
                closePanel(true);
              }}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </header>

          <div className="conversation-navigation__search-row">
            <Search size={14} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search messages, model, run…"
              aria-label="Search conversation targets"
              aria-controls="conversation-navigation-markers"
            />
            <button
              type="button"
              className="conversation-navigation__filter-icon"
              title={filtersOpen ? "Hide conversation target filters" : "Show conversation target filters"}
              aria-label="Conversation target filters"
              aria-expanded={filtersOpen}
              aria-controls="conversation-navigation-filter-list"
              onClick={() => setFiltersOpen((value) => !value)}
            >
              <SlidersHorizontal size={14} aria-hidden="true" />
            </button>
          </div>

          {filtersOpen ? (
            <div id="conversation-navigation-filter-list" className="conversation-navigation__filters" role="group" aria-label="Conversation target filters">
              {([
                ["all", "All"],
                ["prompt", "Prompts"],
                ["output", "Outputs"],
                ["issue", "Issues"],
                ["active", "Active"],
                ["branched", "Branches"],
                ["attached", "Attachments"],
                ["with-run", "Runs"],
                ["with-model", "Models"],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={facet === value ? "conversation-navigation__filter conversation-navigation__filter--active" : "conversation-navigation__filter"}
                  aria-pressed={facet === value}
                  onClick={(event) => {
                    event.stopPropagation();
                    setFacet(value);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}

          <div className="conversation-navigation__summary" role="status" aria-live="polite">
            <span>{projection.promptCount} {promptLabel}</span>
            <span>{projection.outputCount} {outputLabel}</span>
            {projection.issueCount > 0 ? <span className="conversation-navigation__summary--issue">{projection.issueCount} {issueLabel}</span> : null}
            <span>{filteredMarkers.length}/{projection.markers.length} shown</span>
          </div>

          {projection.markers.length === 0 ? (
            <p className="conversation-navigation__empty">No messages in this conversation yet.</p>
          ) : filteredMarkers.length === 0 ? (
            <p className="conversation-navigation__empty">No targets match this search or filter.</p>
          ) : (
            <div id="conversation-navigation-markers" className="conversation-navigation__markers" role="list" aria-label="Message targets">
              {filteredMarkers.map((marker, markerIndex) => {
                const unavailable = unavailableMessageIds.has(marker.messageId);
                const active = marker.messageId === currentMessageId;
                return (
                  <div key={marker.messageId} role="listitem">
                    <button
                      ref={(element) => {
                        if (element) markerButtonRefs.current.set(marker.messageId, element);
                        else markerButtonRefs.current.delete(marker.messageId);
                      }}
                      type="button"
                      className={markerClassName(marker, active, unavailable)}
                      id={`conversation-navigation-marker-${marker.messageId}`}
                      tabIndex={focusedMessageId === marker.messageId || (focusedMessageId === null && markerIndex === 0) ? 0 : -1}
                      aria-current={active ? "true" : undefined}
                      aria-label={unavailable ? `${marker.label} · target unavailable in this preview` : marker.label}
                      title={unavailable ? "Target unavailable in the current transcript" : marker.label}
                      onFocus={() => setFocusedMessageId(marker.messageId)}
                      onKeyDown={(event) => handleMarkerKeyDown(event, marker)}
                      onClick={() => navigate(marker)}
                    >
                      <span className="conversation-navigation__marker-icon">{markerIcon(marker)}</span>
                      <span className="conversation-navigation__marker-copy">
                        <strong>{marker.label.split(": ", 1)[0]}</strong>
                        <span>{marker.excerpt}</span>
                      </span>
                      {marker.branchCount > 1 ? (
                        <small className="conversation-navigation__branch">{marker.branchIndex}/{marker.branchCount}</small>
                      ) : null}
                      {unavailable ? <small className="conversation-navigation__unavailable">Unavailable</small> : null}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <footer className="conversation-navigation__footer">
            <div className="conversation-navigation__footer-main">
              <span className="conversation-navigation__active" title={activeLabel}>
                <span className="conversation-navigation__active-dot" aria-hidden="true" />
                {activeMarker ? activeMarker.excerpt : "Select a message to jump"}
              </span>
              <div className="conversation-navigation__history" role="group" aria-label="Local navigation history">
                <button type="button" title="Previous local target" aria-label="Previous local target" disabled={historyIndex <= 0} onClick={() => moveHistory(-1)}><ChevronLeft size={14} /></button>
                <button type="button" title="Next local target" aria-label="Next local target" disabled={historyIndex < 0 || historyIndex >= historyItems.length - 1} onClick={() => moveHistory(1)}><ChevronRight size={14} /></button>
              </div>
            </div>
            <div className="conversation-navigation__footer-actions">
              <button type="button" className="conversation-navigation__copy-link" disabled={!deepLinkPreview} onClick={() => void copyDeepLink()} title={deepLinkPreview || "Stable conversation identity unavailable"}>
                {deepLinkStatus.includes("Copied") ? <Check size={13} /> : <Copy size={13} />}
                <span>Copy link</span>
              </button>
              <span className="conversation-navigation__hint">Esc · arrows · local preview</span>
            </div>
            {deepLinkPreview ? (
              <p className="conversation-navigation__deep-link-target" aria-live="polite">
                {parsedDeepLink?.status !== "valid" || !deepLinkResolution
                  ? "Typed deep-link preview could not be resolved in this renderer."
                  : `${deepLinkResolution.label} · nearest safe ancestor: ${deepLinkResolution.nearestAncestor}.`}
              </p>
            ) : null}
            {deepLinkStatus ? <p className="conversation-navigation__status" role="status" aria-live="polite">{deepLinkStatus}</p> : null}
          </footer>
        </section>
      ) : null}
    </div>
  );
}
