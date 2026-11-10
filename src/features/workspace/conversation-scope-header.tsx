import {
  Check,
  ChevronDown,
  ExternalLink,
  Folder,
  MessageSquareText,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { useWorkspaceStore } from "./store";
import type { ConversationView } from "./types";

interface ConversationScopeHeaderProps {
  conversation: ConversationView;
}

/**
 * Renderer-first Project -> Chat scope control.
 *
 * The header keeps the two primary Omnia surfaces visible at the point where
 * a user is working. Selecting a Chat is live in the renderer projection;
 * opening a Project routes to its overview surface. Native scope persistence
 * remains outside this preview and is intentionally not implied by the UI.
 */
export function ConversationScopeHeader({
  conversation,
}: ConversationScopeHeaderProps) {
  const projects = useWorkspaceStore((state) => state.projects);
  const conversations = useWorkspaceStore((state) => state.conversations);
  const selectConversation = useWorkspaceStore((state) => state.selectConversation);
  const selectProject = useWorkspaceStore((state) => state.selectProject);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  };

  const project = useMemo(
    () =>
      conversation.projectId
        ? projects.find((candidate) => candidate.id === conversation.projectId) ?? null
        : null,
    [conversation.projectId, projects],
  );

  const scopedChats = useMemo(
    () =>
      conversations
        .filter((candidate) => candidate.archived === false)
        .filter((candidate) =>
          project
            ? candidate.projectId === project.id
            : candidate.projectId === null,
        )
        .slice(0, 8),
    [conversations, project],
  );
  useEffect(() => {
    if (!open) return;

    window.dispatchEvent(
      new CustomEvent("omnia:close-floating-menus", { detail: { source: "conversation-scope-header" } }),
    );
    const onCloseFloating = (event: Event) => {
      const detail = (event as CustomEvent<{ source?: string }>).detail;
      if (detail?.source !== "conversation-scope-header") {
        closeMenu();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !rootRef.current?.contains(target)) {
        // The pointer is already moving to another control. Do not steal
        // focus back to the scope trigger while dismissing the popover.
        closeMenu();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu(true);
      }
    };

    window.addEventListener("omnia:close-floating-menus", onCloseFloating);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("omnia:close-floating-menus", onCloseFloating);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const firstItem = rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    firstItem?.focus({ preventScroll: true });
  }, [open]);

  const handleMenuItemKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const items = rootRef.current
      ? Array.from(rootRef.current.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      : [];
    const currentIndex = items.indexOf(event.currentTarget);
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (currentIndex < 0 || items.length === 0) return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = (currentIndex + 1) % items.length;
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + items.length) % items.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex]?.focus({ preventScroll: true });
  };

  const scopeName = project?.name ?? conversation.projectName ?? "Inbox";

  return (
    <div className="conversation-toolbar__title conversation-scope-header conversation-scope-header--review" ref={rootRef}>
      <div className="conversation-scope-header__breadcrumb" aria-label="Chat location">
        <div className="scope-switcher">
          <button
            type="button"
            ref={triggerRef}
            className={
              open
                ? "scope-switcher__trigger scope-switcher__trigger--open"
                : "scope-switcher__trigger"
            }
            aria-label="Change Project or Chat scope"
            title="Switch project or chat"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls="scope-switcher-menu"
            onClick={() => setOpen((current) => !current)}
          >
            <Folder size={15} strokeWidth={1.75} aria-hidden="true" />
            <span className="scope-switcher__breadcrumb-name">{scopeName}</span>
            <ChevronDown className="scope-switcher__breadcrumb-chevron" size={12} strokeWidth={1.75} aria-hidden="true" />
          </button>

          {open ? (
            <div
              id="scope-switcher-menu"
              className="scope-switcher__panel"
              role="menu"
              aria-label="Switch Project or Chat scope"
            >
              <header className="scope-switcher__panel-header">
                <div>
                  <strong>{scopeName}</strong>
                </div>
              </header>

              <div className="scope-switcher__section">
                <span className="scope-switcher__section-label">
                  {project ? "Project chats" : "Chats"}
                </span>
                {scopedChats.length > 0 ? (
                  <div className="scope-switcher__chat-list">
                    {scopedChats.map((candidate) => {
                      const current = candidate.id === conversation.id;
                      return (
                        <button
                          key={candidate.id}
                          type="button"
                          role="menuitem"
                          title={current ? `Current Chat: ${candidate.title}` : `Switch to Chat: ${candidate.title}`}
                          className={
                            current
                              ? "scope-switcher__chat scope-switcher__chat--current"
                              : "scope-switcher__chat"
                          }
                          onKeyDown={handleMenuItemKeyDown}
                          onClick={() => {
                            selectConversation(candidate.id);
                            closeMenu(true);
                          }}
                        >
                          <span className="scope-switcher__chat-icon">
                            <MessageSquareText size={13} strokeWidth={1.75} aria-hidden="true" />
                          </span>
                          <span className="scope-switcher__chat-copy">
                            <strong>{candidate.title}</strong>
                            <small>{candidate.updatedLabel}</small>
                          </span>
                          {current ? <Check size={14} aria-label="Current Chat" /> : null}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <span className="scope-switcher__empty">No other Chat is available in this scope.</span>
                )}
              </div>

              <div className="scope-switcher__section scope-switcher__section--projects">
                <span className="scope-switcher__section-label">Projects</span>
                <div className="scope-switcher__project-list">
                  {projects.slice(0, 8).map((candidate) => {
                    const current = candidate.id === project?.id;
                    return (
                      <button
                        key={candidate.id}
                        type="button"
                        role="menuitem"
                        title={current ? `Current Project: ${candidate.name}` : `Switch to Project: ${candidate.name}`}
                        className={
                          current
                            ? "scope-switcher__project scope-switcher__project--current"
                            : "scope-switcher__project"
                        }
                        onKeyDown={handleMenuItemKeyDown}
                        onClick={() => {
                          selectProject(candidate.id);
                          closeMenu(true);
                        }}
                      >
                        <span className="scope-switcher__project-mark">
                          <Folder size={14} strokeWidth={1.75} aria-hidden="true" />
                        </span>
                        <span className="scope-switcher__project-copy">
                          <strong>{candidate.name}</strong>
                          <small>{candidate.conversationCount} {candidate.conversationCount === 1 ? "chat" : "chats"}</small>
                        </span>
                        <span className="scope-switcher__project-action">
                          <span>{current ? "Current" : "Switch"}</span>
                          {current ? <Check size={14} aria-hidden="true" /> : <ExternalLink size={13} aria-hidden="true" />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

            </div>
          ) : null}
        </div>
        <span className="conversation-scope-header__breadcrumb-separator" aria-hidden="true">/</span>
        <h1 className="conversation-scope-header__breadcrumb-title" title={conversation.title}>{conversation.title}</h1>
      </div>
    </div>
  );
}
