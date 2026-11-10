import { ArrowDownToLine, Clipboard, FilePlus2, Link2, MessageSquareQuote, MoreHorizontal, Save, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { useWorkspaceStore } from "./store";
import { createRendererDeepLinkPreview } from "./conversation-navigation-model";
import { recordMessageAction } from "./message-action-history-session";

type MessageActionsMenuProps = {
  content: string;
  messageKind: "user" | "assistant";
  /** Optional hydrated identity used to create a renderer-only message link. */
  conversationId?: string | null;
  projectId?: string | null;
  branchId?: string | null;
  messageId?: string | null;
  messageRevisionId?: string | null;
  runId?: string | null;
};

type MessageActionPopoverPosition = CSSProperties & {
  position: "fixed";
};

const MESSAGE_ACTION_PORTAL_ID = "omnia-message-actions-portal";

function getMessageActionPortalHost(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const existing = document.getElementById(MESSAGE_ACTION_PORTAL_ID);
  if (existing) return existing;
  const host = document.createElement("div");
  host.id = MESSAGE_ACTION_PORTAL_ID;
  /* Keep the host as one stable child so clearing `body.innerHTML` in a
     renderer test removes the host only after React has unmounted its portal
     children.  The production app uses the document root to stay independent
     of body overflow; jsdom needs the host under body for screen queries. */
  const isJsdom = typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent);
  (isJsdom ? document.body : document.documentElement).appendChild(host);
  return host;
}

function quoteMarkdown(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

export function MessageActionsMenu({
  content,
  messageKind,
  conversationId,
  projectId,
  branchId,
  messageId,
  messageRevisionId,
  runId,
}: MessageActionsMenuProps) {
  const updateDraft = useWorkspaceStore((state) => state.updateDraft);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const menuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  const [popoverPosition, setPopoverPosition] = useState<MessageActionPopoverPosition | null>(null);

  /*
   * Message actions sit inside a scrollable transcript.  An absolute menu
   * therefore gets clipped whenever it opens upward across the transcript's
   * top edge.  Position the menu against the viewport instead, while keeping
   * its horizontal edge aligned with the compact trigger.  The menu itself is
   * rendered through a body portal below so it can never be trapped by a
   * scroll-container stacking or overflow context.
   */
  const updatePopoverPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const gutter = 12;
    const gap = 7;
    const menuWidth = Math.min(300, Math.max(220, viewportWidth - gutter * 2));
    const right = Math.max(gutter, viewportWidth - rect.right);
    const roomAbove = rect.top - gap - gutter;
    const roomBelow = viewportHeight - rect.bottom - gap - gutter;
    const opensUpward = roomAbove >= 180 || roomAbove >= roomBelow;
    const maxHeight = Math.max(156, Math.min(460, (opensUpward ? roomAbove : roomBelow)));

    setPopoverPosition({
      position: "fixed",
      right,
      ...(opensUpward
        ? { bottom: Math.max(gutter, viewportHeight - rect.top + gap), top: "auto" }
        : { top: Math.max(gutter, rect.bottom + gap), bottom: "auto" }),
      width: menuWidth,
      maxHeight,
    });
  }, []);

  const focusMenuItem = (index: number) => {
    const items = menuItemRefs.current.filter(
      (item): item is HTMLButtonElement => item !== null && !item.disabled,
    );
    if (items.length === 0) return;
    items[Math.max(0, Math.min(index, items.length - 1))]?.focus({ preventScroll: true });
  };

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const items = menuItemRefs.current.filter(
      (item): item is HTMLButtonElement => item !== null && !item.disabled,
    );
    if (items.length === 0) return;
    const currentIndex = items.indexOf(event.currentTarget);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusMenuItem(currentIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusMenuItem(currentIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusMenuItem(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusMenuItem(items.length - 1);
    }
  };

  useEffect(() => {
    if (!open) {
      setPopoverPosition(null);
      return;
    }
    window.dispatchEvent(new CustomEvent("omnia:close-floating-menus", { detail: { source: menuId } }));
    updatePopoverPosition();
    const frame = window.requestAnimationFrame(() => {
      updatePopoverPosition();
      focusMenuItem(0);
    });
    const onCloseFloating = (event: Event) => {
      const detail = (event as CustomEvent<{ source?: string }>).detail;
      if (detail?.source !== menuId) setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("omnia:close-floating-menus", onCloseFloating);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", updatePopoverPosition);
    window.addEventListener("scroll", updatePopoverPosition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("omnia:close-floating-menus", onCloseFloating);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", updatePopoverPosition);
      window.removeEventListener("scroll", updatePopoverPosition, true);
      menuItemRefs.current = [];
    };
  }, [menuId, open, updatePopoverPosition]);

  const announce = (message: string) => {
    setStatus(message);
    window.setTimeout(() => setStatus(null), 2400);
  };

  const record = (action: Parameters<typeof recordMessageAction>[0]["action"], label: string) => {
    if (!conversationId || !messageId) return;
    recordMessageAction({ conversationId, messageId, role: messageKind, action, label });
  };

  const copyAsMarkdown = async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        announce("Clipboard access is unavailable in this renderer.");
        return;
      }
      await navigator.clipboard.writeText(content);
      record("copy", "Copied message as Markdown");
      announce("Copied as Markdown.");
    } catch {
      announce("Clipboard access was denied; nothing was copied.");
    }
  };

  const quoteIntoComposer = () => {
    const currentDraft = useWorkspaceStore.getState().conversations.find(
      (conversation) => conversation.id === useWorkspaceStore.getState().activeConversationId,
    )?.draft ?? "";
    const separator = currentDraft.trim() ? `${currentDraft.trimEnd()}\n\n` : "";
    updateDraft(`${separator}${quoteMarkdown(content)}\n\n`);
    record("quote", "Quoted into composer");
    announce("Quoted into the composer draft. Renderer-local only.");
  };

  const previewExcerpt = () => {
    record("excerpt", "Previewed message excerpt");
    announce("Excerpt previewed in this renderer session; durable artifact save remains planned.");
  };

  const copyMessageLink = async () => {
    const deepLink = conversationId && messageId
      ? createRendererDeepLinkPreview({
          conversationId,
          projectId: projectId ?? null,
          branchId: branchId ?? null,
          messageId,
          messageRevisionId: messageRevisionId ?? null,
          runId: runId ?? null,
          targetKind: "message",
        })
      : "";
    if (!deepLink) {
      announce("Stable message identity is unavailable in this preview; no link was copied.");
      return;
    }
    if (!navigator.clipboard?.writeText) {
      announce("Clipboard access is unavailable in this preview; no link was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(deepLink);
      record("copy-link", "Copied message link preview");
      announce("Copied a renderer-local message link preview.");
    } catch {
      announce("Clipboard access was denied; no message link was copied.");
    }
  };

  const popover = open && popoverPosition ? (
    <div
      ref={popoverRef}
      id={menuId}
      className="message-action-menu__popover"
      role="menu"
      aria-label="Message actions"
      aria-orientation="vertical"
      style={{ ...popoverPosition, zIndex: 1200 }}
    >
      <button ref={(element) => { menuItemRefs.current[0] = element; }} type="button" role="menuitem" title="Quote this message into the composer" onKeyDown={handleMenuKeyDown} onClick={quoteIntoComposer}>
        <MessageSquareQuote size={14} aria-hidden="true" />
        <span><strong>Quote into composer</strong><small>Append as a Markdown blockquote.</small></span>
      </button>
      <button ref={(element) => { menuItemRefs.current[1] = element; }} type="button" role="menuitem" title="Copy the complete message as Markdown" onKeyDown={handleMenuKeyDown} onClick={() => void copyAsMarkdown()}>
        <Clipboard size={14} aria-hidden="true" />
        <span><strong>Copy as Markdown</strong><small>Copy the complete message text.</small></span>
      </button>
      <button ref={(element) => { menuItemRefs.current[2] = element; }} type="button" role="menuitem" title="Preview an excerpt as a future artifact" onKeyDown={handleMenuKeyDown} onClick={previewExcerpt}>
        <Save size={14} aria-hidden="true" />
        <span><strong>Preview excerpt</strong><small>Durable artifact saving is planned.</small></span>
      </button>
      {conversationId && messageId ? (
        <button ref={(element) => { menuItemRefs.current[3] = element; }} type="button" role="menuitem" title="Copy a renderer-local identity link for this message" onKeyDown={handleMenuKeyDown} onClick={() => void copyMessageLink()}>
          <Link2 size={14} aria-hidden="true" />
          <span><strong>Copy message link (preview)</strong><small>Copy an identity-only renderer URI; no content is embedded.</small></span>
        </button>
      ) : null}
      {messageKind === "assistant" ? (
        <button
          ref={(element) => { menuItemRefs.current[conversationId && messageId ? 4 : 3] = element; }}
          type="button"
          role="menuitem"
          title="Prepare a continuation preview without sending a provider request"
          onKeyDown={handleMenuKeyDown}
          onClick={() => {
            record("continue", "Continuation preview prepared");
            announce("Continuation preview prepared. No provider request or continuation run was created.");
          }}
        >
          <ArrowDownToLine size={14} aria-hidden="true" />
          <span><strong>Continue response (preview)</strong><small>No provider request or continuation run is created.</small></span>
        </button>
      ) : null}
      {messageKind === "assistant" ? (
        <button ref={(element) => { menuItemRefs.current[conversationId && messageId ? 5 : 4] = element; }} type="button" role="menuitem" onKeyDown={handleMenuKeyDown} disabled title="Provider-bound regeneration is planned">
          <FilePlus2 size={14} aria-hidden="true" />
          <span><strong>Regenerate response</strong><small>Provider dispatch remains planned.</small></span>
        </button>
      ) : null}
    </div>
  ) : null;
  const portalHost = popover ? getMessageActionPortalHost() : null;

  return (
    <div ref={rootRef} className="message-action-menu">
      <button
        ref={triggerRef}
        type="button"
        aria-label={messageKind === "user" ? "More message actions" : "More response actions"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="Open renderer-local message actions"
        onClick={() => {
          setOpen((value) => !value);
          setStatus(null);
        }}
      >
        {open ? <X size={14} /> : <MoreHorizontal size={14} />}
      </button>
      {popover && portalHost ? createPortal(popover, portalHost) : null}
      {status ? <span className="message-action-menu__status" role="status" aria-live="polite">{status}</span> : null}
    </div>
  );
}
