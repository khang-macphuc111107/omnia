import {
  Check,
  FileText,
  Folder,
  FolderOpen,
  Gauge,
  LayoutGrid,
  List,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { ProductIcon } from "@/components/product-icons";

import type { ActivityScreenProps } from "../activity-registry";
import { openWorkspaceOverlay } from "../overlay-store";
import { projectOverviewFromProject } from "../project-catalog";
import { buildProjectContextAvailabilityForProject } from "../project-context-availability-contract";
import { ProjectOverview } from "../project-overview";
import { ProjectControlDeck } from "../project-control-deck";
import { ScreenHeader } from "../screen-header";
import { useWorkspaceStore } from "../store";

type ProjectActionMenu =
  | { kind: "card" | "detail"; projectId: string }
  | { kind: "folder"; projectId: string; folderId: string };

function sameProjectActionMenu(left: ProjectActionMenu | null, right: ProjectActionMenu): boolean {
  if (!left || left.kind !== right.kind || left.projectId !== right.projectId) return false;
  return left.kind !== "folder"
    || (right.kind === "folder" && left.folderId === right.folderId);
}

export default function ProjectsScreen(_props: Partial<ActivityScreenProps>) {
  const projects = useWorkspaceStore((state) => state.projects);
  const activeProjectId = useWorkspaceStore((state) => state.activeProjectId);
  const selectProject = useWorkspaceStore((state) => state.selectProject);
  const selectConversation = useWorkspaceStore((state) => state.selectConversation);
  const setActivity = useWorkspaceStore((state) => state.setActivity);
  const openProjectSettings = useWorkspaceStore((state) => state.openProjectSettings);
  const conversations = useWorkspaceStore((state) => state.conversations);
  const memories = useWorkspaceStore((state) => state.memories);
  const skills = useWorkspaceStore((state) => state.skills);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [projectOverrides, setProjectOverrides] = useState<
    Record<string, { name?: string; pinned?: boolean }>
  >({});
  const [activeMenu, setActiveMenu] = useState<ProjectActionMenu | null>(null);
  const [renameProjectId, setRenameProjectId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const actionMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuInitialFocusRef = useRef<"first" | "last">("first");
  const renameTriggerRef = useRef<HTMLButtonElement | null>(null);
  const displayProjects = projects.map((item) => ({
    ...item,
    ...projectOverrides[item.id],
  }));
  const displayProjectsWithAvailability = displayProjects.map((item) => ({
    item,
    contextAvailability: buildProjectContextAvailabilityForProject(item),
  }));
  const project = displayProjects.find((item) => item.id === activeProjectId) ?? displayProjects[0];
  const sourceProject = project
    ? projects.find((item) => item.id === project.id) ?? project
    : null;
  const projectTitleOverride = project
    ? projectOverrides[project.id]?.name?.trim() || null
    : null;
  const projectOverview = project
    ? project.overview ?? projectOverviewFromProject(sourceProject ?? project)
    : null;
  const projectContextAvailability = project
    ? buildProjectContextAvailabilityForProject(project)
    : null;
  const projectChats = project
    ? conversations
        .filter((conversation) => conversation.projectId === project.id)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map((conversation) => ({
          id: conversation.id,
          title: conversation.title,
          excerpt: conversation.excerpt,
          updatedLabel: conversation.updatedLabel,
          archived: conversation.archived,
          unread: conversation.unread,
          hasDraft: conversation.hasDraft,
          runState: conversation.runState,
        }))
    : [];

  const closeActionMenu = useCallback((restoreFocus = true) => {
    setActiveMenu(null);
    if (restoreFocus && actionMenuTriggerRef.current?.isConnected) {
      actionMenuTriggerRef.current.focus({ preventScroll: true });
    }
  }, []);

  const toggleActionMenu = (next: ProjectActionMenu, trigger: HTMLButtonElement) => {
    menuInitialFocusRef.current = "first";
    actionMenuTriggerRef.current = trigger;
    setActiveMenu((current) => sameProjectActionMenu(current, next) ? null : next);
  };

  const onActionMenuTriggerKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    next: ProjectActionMenu,
  ) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    menuInitialFocusRef.current = event.key === "ArrowUp" ? "last" : "first";
    actionMenuTriggerRef.current = event.currentTarget;
    if (next.kind === "card") selectProject(next.projectId);
    setActiveMenu(next);
  };

  const beginRename = (target: { id: string; name: string }) => {
    renameTriggerRef.current = actionMenuTriggerRef.current;
    setRenameDraft(target.name);
    setRenameProjectId(target.id);
    closeActionMenu(false);
  };

  const closeRename = (restoreFocus = true) => {
    setRenameProjectId(null);
    setRenameDraft("");
    if (restoreFocus && renameTriggerRef.current?.isConnected) {
      renameTriggerRef.current.focus({ preventScroll: true });
    }
  };

  useEffect(() => {
    // A draft belongs to the project that opened it, never whichever project
    // becomes selected later. Keep a newly opened card menu only if it belongs
    // to the new selection in the same render.
    setActiveMenu((current) => current?.projectId === project?.id ? current : null);
    setRenameProjectId((current) => current === project?.id ? current : null);
  }, [project?.id]);

  useEffect(() => {
    if (!activeMenu) return;
    const enabledItems = () => Array.from(
      actionMenuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)") ?? [],
    );
    const initialItems = enabledItems();
    (menuInitialFocusRef.current === "last" ? initialItems.at(-1) : initialItems[0])
      ?.focus({ preventScroll: true });

    const dismissOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node
        && !actionMenuRef.current?.contains(target)
        && !actionMenuTriggerRef.current?.contains(target)) {
        closeActionMenu(false);
      }
    };
    const handleMenuKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeActionMenu();
        return;
      }
      if (!actionMenuRef.current?.contains(document.activeElement)) return;
      if (event.key === "Tab") {
        // Return to the trigger before normal Tab navigation continues; the
        // disappearing menu must not strand focus on the document body.
        closeActionMenu();
        return;
      }
      const items = enabledItems();
      if (items.length === 0) return;
      const currentIndex = items.findIndex((item) => item === document.activeElement);
      let nextIndex: number | null = null;
      if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % items.length;
      if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + items.length) % items.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = items.length - 1;
      if (nextIndex === null) return;
      event.preventDefault();
      items[nextIndex]?.focus({ preventScroll: true });
    };
    const dismissAfterFocusLeaves = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof Node
        && !actionMenuRef.current?.contains(target)
        && !actionMenuTriggerRef.current?.contains(target)) {
        closeActionMenu(false);
      }
    };

    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", handleMenuKeyDown);
    document.addEventListener("focusin", dismissAfterFocusLeaves);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", handleMenuKeyDown);
      document.removeEventListener("focusin", dismissAfterFocusLeaves);
    };
  }, [activeMenu, closeActionMenu]);

  return (
    <div className="screen-scroll projects-screen">
      <ScreenHeader
        title="Projects"
        action={
          // Empty catalog: the empty state owns the single "New project" entry point.
          projects.length === 0 ? undefined : (
          <>
            <div className="view-switcher" role="group" aria-label="Project view">
              <button
                type="button"
                className={view === "grid" ? "active" : ""}
                onClick={() => setView("grid")}
                aria-label="Grid view"
                title="Use grid view"
                aria-pressed={view === "grid"}
              >
                <LayoutGrid size={15} />
              </button>
              <button
                type="button"
                className={view === "list" ? "active" : ""}
                onClick={() => setView("list")}
                aria-label="List view"
                title="Use list view"
                aria-pressed={view === "list"}
              >
                <List size={15} />
              </button>
            </div>
            <button
              type="button"
              className="button button--primary"
              title="Create a new Project in the renderer preview"
              onClick={() => openWorkspaceOverlay({ kind: "create-project" })}
            >
              <Plus size={16} /> New project
            </button>
          </>
          )
        }
      />
      <div
        className={
          view === "grid" ? "project-card-grid" : "project-card-grid project-card-grid--list"
        }
      >
        {displayProjectsWithAvailability.map(({ item, contextAvailability }) => (
          <div key={item.id} className="project-card-shell">
            <button
              type="button"
              className={
                item.id === activeProjectId
                  ? "project-card project-card--active"
                  : "project-card"
              }
              aria-pressed={item.id === activeProjectId}
              aria-label={`Select ${item.name}`}
              title={`Select ${item.name}`}
              onClick={() => {
                closeActionMenu(false);
                selectProject(item.id);
              }}
            >
              <span className="project-card__mark" style={{ background: item.accent }}>
                {item.name.slice(0, 1)}
              </span>
              <span className="project-card__content">
                <strong>{item.name}</strong>
                <small>{item.description}</small>
              </span>
              {item.pinned ? (
                <Pin size={14} className="project-card__pin" fill="currentColor" />
              ) : null}
              <span className="project-card__footer">
                <span>{item.conversationCount} conversations</span>
                <span
                  className={`health health--${item.contextHealth}`}
                  title={contextAvailability.reason}
                >
                  {contextAvailability.label}
                </span>
              </span>
            </button>
            <button
              type="button"
              className="project-card__actions-trigger"
              title={`Open project library actions for ${item.name}`}
              aria-label={`Open project library actions for ${item.name}`}
              aria-haspopup="menu"
              aria-expanded={activeMenu?.kind === "card" && activeMenu.projectId === item.id}
              aria-controls={`project-card-actions-${item.id}`}
              onKeyDown={(event) => onActionMenuTriggerKeyDown(event, { kind: "card", projectId: item.id })}
              onClick={(event) => {
                selectProject(item.id);
                toggleActionMenu({ kind: "card", projectId: item.id }, event.currentTarget);
              }}
            >
              <MoreHorizontal size={16} />
            </button>
            {activeMenu?.kind === "card" && activeMenu.projectId === item.id ? (
              <div
                ref={actionMenuRef}
                id={`project-card-actions-${item.id}`}
                className="project-card-actions-menu"
                role="menu"
                aria-label={`Project library actions for ${item.name}`}
              >
                <div className="project-card-actions-menu__heading">
                  <span>Project actions</span>
                  <button
                    type="button"
                    className="icon-button icon-button--small"
                    aria-label="Close project library actions"
                    title="Close project library actions"
                    onClick={() => closeActionMenu()}
                  >
                    <X size={13} />
                  </button>
                </div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => beginRename(item)}
                >
                  <Pencil size={14} /> Rename in preview
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setProjectOverrides((previous) => ({
                      ...previous,
                      [item.id]: { ...previous[item.id], pinned: !item.pinned },
                    }));
                    closeActionMenu();
                  }}
                >
                  {item.pinned ? <PinOff size={14} /> : <Pin size={14} />} {item.pinned ? "Unpin" : "Pin"} in preview
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!projectOverrides[item.id]}
                  onClick={() => {
                    setProjectOverrides((previous) => {
                      const next = { ...previous };
                      delete next[item.id];
                      return next;
                    });
                    closeActionMenu();
                  }}
                >
                  <RotateCcw size={14} /> Reset preview changes
                </button>
                <small>Renderer-local only · no durable write</small>
              </div>
            ) : null}
          </div>
        ))}
        {projects.length === 0 ? (
          <div className="collection-empty-state collection-empty-state--wide">
            <FolderOpen size={27} />
            <h2>Create your first project</h2>
            <p>
              Create a local project for conversations, instructions, and read-only workspace
              grants. Memory, skills, indexing, and compiled context are not enabled in this
              preview.
            </p>
            <button
              type="button"
              className="button button--primary"
              title="Create a new Project in the renderer preview"
              onClick={() => openWorkspaceOverlay({ kind: "create-project" })}
            >
              <Plus size={15} /> New project
            </button>
          </div>
        ) : null}
      </div>
      {project ? (
        <section className="project-detail">
          <header className="project-detail__header">
            <span className="project-detail__mark" style={{ background: project.accent }}>
              {project.name.slice(0, 1)}
            </span>
            <div>
              <span className="eyebrow">Selected project</span>
              <h2>{project.name}</h2>
              <p>{project.instructions}</p>
            </div>
            <button
              type="button"
              className="button button--primary"
              title={`Start a new Chat in ${project.name}`}
              onClick={() => openWorkspaceOverlay({ kind: "start-conversation", projectId: project.id })}
            >
              <Plus size={15} /> New project chat
            </button>
            <div className="project-detail__actions">
              <button
                type="button"
                className="icon-button"
                title={`Open preview actions for ${project.name}`}
                aria-label={`Open preview actions for ${project.name}`}
                aria-haspopup="menu"
                aria-expanded={activeMenu?.kind === "detail" && activeMenu.projectId === project.id}
                aria-controls={`project-detail-actions-${project.id}`}
                onKeyDown={(event) => onActionMenuTriggerKeyDown(event, { kind: "detail", projectId: project.id })}
                onClick={(event) => toggleActionMenu({ kind: "detail", projectId: project.id }, event.currentTarget)}
              >
                <MoreHorizontal size={16} />
              </button>
              {activeMenu?.kind === "detail" && activeMenu.projectId === project.id ? (
                <div ref={actionMenuRef} id={`project-detail-actions-${project.id}`} className="project-actions-menu" role="menu" aria-label={`Project actions for ${project.name}`}>
                  <div className="project-actions-menu__heading">
                    <span>Project actions</span>
                    <button type="button" className="icon-button icon-button--small" aria-label="Close project actions" title="Close project actions" onClick={() => closeActionMenu()}>
                      <X size={13} />
                    </button>
                  </div>
                  <button type="button" role="menuitem" onClick={() => beginRename(project)}>
                    <Pencil size={14} /> Rename in preview
                  </button>
                  <button type="button" role="menuitem" onClick={() => { setProjectOverrides((previous) => ({ ...previous, [project.id]: { ...previous[project.id], pinned: !project.pinned } })); closeActionMenu(); }}>
                    {project.pinned ? <PinOff size={14} /> : <Pin size={14} />} {project.pinned ? "Unpin" : "Pin"} in preview
                  </button>
                  <button type="button" role="menuitem" disabled={!projectOverrides[project.id]} onClick={() => { setProjectOverrides((previous) => { const next = { ...previous }; delete next[project.id]; return next; }); closeActionMenu(); closeRename(false); }}>
                    <RotateCcw size={14} /> Reset preview changes
                  </button>
                  <small>Renderer-local only · no durable write</small>
                </div>
              ) : null}
            </div>
          </header>
          {renameProjectId === project.id ? (
            <form
              className="project-preview-rename"
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                closeRename();
              }}
              onSubmit={(event) => {
                event.preventDefault();
                const nextName = renameDraft.trim();
                if (!nextName) return;
                setProjectOverrides((previous) => ({ ...previous, [project.id]: { ...previous[project.id], name: nextName } }));
                closeRename();
              }}
            >
              <label htmlFor="project-preview-name">Rename project in preview</label>
              <input id="project-preview-name" value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} autoFocus />
              <button type="submit" className="button button--primary" disabled={!renameDraft.trim()}><Check size={14} /> Apply</button>
              <button type="button" className="button button--ghost" onClick={() => closeRename()}>Cancel</button>
              <small>Preview only; native project rename remains unavailable.</small>
            </form>
          ) : null}
          <ProjectOverview
            projectId={project.id}
            overview={projectOverview!}
            titleOverride={projectTitleOverride ? { value: projectTitleOverride, source: "renderer-local" } : null}
            contextHealth={project.contextHealth}
            folders={project.folders}
            recentChats={projectChats}
            onOpenChat={selectConversation}
            onOpenChatList={() => setActivity("chats")}
            onOpenOverviewTab={(tab, targetTab) => {
              if (tab === "settings") {
                openProjectSettings(project.id);
                return;
              }
              if (!targetTab) return;
              const target = document.getElementById(`project-control-deck-tab-${targetTab}`);
              target?.click();
              target?.scrollIntoView({ block: "nearest", behavior: "smooth" });
            }}
          />
          <ProjectControlDeck
            project={project}
            conversations={conversations}
            memories={memories}
            skills={skills}
            onOpenChat={selectConversation}
            onNewChat={() => openWorkspaceOverlay({ kind: "start-conversation", projectId: project.id })}
            onAddFolder={() => openWorkspaceOverlay({ kind: "grant-folder", projectId: project.id })}
            onOpenChatList={() => setActivity("chats")}
            onOpenProjectSettings={() => openProjectSettings(project.id)}
          />
          <div className="project-stats">
            <article>
              <FileText size={17} />
              <span>Conversations</span>
              <strong>{project.conversationCount}</strong>
            </article>
            <article>
              <Folder size={17} />
              <span>Workspace folders</span>
              <strong>{project.folders.length}</strong>
            </article>
            <article>
              <ProductIcon name="skill" size={17} />
              <span>Skills</span>
              <strong>Not enabled</strong>
            </article>
            <article>
              <Gauge size={17} />
              <span>Context compiler</span>
              <strong
                className={`health-text health-text--${project.contextHealth}`}
                title={projectContextAvailability?.reason}
              >
                {projectContextAvailability?.label}
              </strong>
            </article>
          </div>
          <section className="workspace-folders">
            <header className="section-heading">
              <div>
                <h3>Workspace folders</h3>
                <p>Read-only, explicitly granted local context</p>
              </div>
              <button
                type="button"
                className="button button--secondary"
                title={`Add a read-only workspace folder to ${project.name}`}
                onClick={() =>
                  openWorkspaceOverlay({ kind: "grant-folder", projectId: project.id })
                }
              >
                <FolderOpen size={15} /> Add folder
              </button>
            </header>
            {project.folders.length > 0 ? (
              project.folders.map((folder) => (
                <article key={folder.id} className="workspace-folder-row">
                  <span className="workspace-folder-row__icon">
                    <Folder size={20} />
                  </span>
                  <span>
                    <strong>{folder.displayName}</strong>
                    <small>{folder.canonicalPath}</small>
                  </span>
                  <span className={`folder-state folder-state--${folder.state}`}>
                    {folder.state}
                  </span>
                  <span className="folder-counts">
                    {folder.fileCount === null ? "Not indexed" : `${folder.fileCount} files`}
                    {folder.chunkCount === null
                      ? " · read-only grant"
                      : ` · ${folder.chunkCount} chunks`}
                  </span>
                  <button
                    type="button"
                    className="icon-button"
                    title={`Open workspace-grant preview actions for ${folder.displayName}`}
                    aria-label={`Open workspace-grant preview actions for ${folder.displayName}`}
                    aria-haspopup="menu"
                    aria-expanded={activeMenu?.kind === "folder" && activeMenu.projectId === project.id && activeMenu.folderId === folder.id}
                    aria-controls={`workspace-folder-actions-${folder.id}`}
                    onKeyDown={(event) => onActionMenuTriggerKeyDown(event, { kind: "folder", projectId: project.id, folderId: folder.id })}
                    onClick={(event) => toggleActionMenu({ kind: "folder", projectId: project.id, folderId: folder.id }, event.currentTarget)}
                  >
                    <MoreHorizontal size={15} />
                  </button>
                  {activeMenu?.kind === "folder" && activeMenu.projectId === project.id && activeMenu.folderId === folder.id ? (
                    <div ref={actionMenuRef} id={`workspace-folder-actions-${folder.id}`} className="workspace-folder-actions-menu" role="menu" aria-label={`Workspace-grant preview actions for ${folder.displayName}`}>
                      <button type="button" role="menuitem" onClick={() => {
                        const accessTab = document.getElementById("project-control-deck-tab-access");
                        closeActionMenu(false);
                        accessTab?.click();
                        accessTab?.focus({ preventScroll: true });
                      }}>
                        <FolderOpen size={14} /> Open Access preview
                      </button>
                      <small>Use the Access tab to edit scope, revoke, or undo this renderer-local grant preview.</small>
                      <small>Preview only · no durable write · source files are untouched.</small>
                    </div>
                  ) : null}
                </article>
              ))
            ) : (
              <div className="inline-empty-state">
                <FolderOpen size={23} />
                <div>
                  <strong>No workspace folder yet</strong>
                  <p>
                    Add a folder to grant read-only access. Search indexing is not enabled in
                    this preview.
                  </p>
                </div>
              </div>
            )}
          </section>
        </section>
      ) : null}
    </div>
  );
}
