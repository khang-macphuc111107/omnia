import {
  Archive,
  Check,
  ChevronDown,
  Copy,
  Folder,
  FolderInput,
  MessageSquare,
  Plus,
  Pin,
  PinOff,
  Pencil,
  RotateCcw,
  Search,
  Tag,
  Trash2,
  Undo2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { useWorkspaceStore } from "./store";
import type { ConversationView } from "./types";

type ConversationLibraryFilter = "active" | "archived" | "deleted" | "all";
type ConversationFolderFilter = "all" | "none" | string;
export type ConversationSearchMode = "contains" | "all-terms" | "exact-phrase";
export type ConversationSearchScope = "all" | "title" | "messages" | "project" | "attachments";
export type ConversationSearchSort = "recent" | "relevance" | "title";

type ConversationOrganization = {
  folder: string | null;
  tags: string[];
};

type SavedConversationCollection = {
  id: string;
  name: string;
  filter: ConversationLibraryFilter;
  query: string;
  folder: ConversationFolderFilter;
  tag: string;
  searchMode: ConversationSearchMode;
  searchScope: ConversationSearchScope;
  searchSort: ConversationSearchSort;
};

type ConversationUndo = {
  label: string;
  undo: () => void;
};

type LibraryMoveDestination = {
  id: string;
  projectId: string | null;
  label: string;
  description: string;
  recent: boolean;
  available: boolean;
  unavailableReason?: string;
};

function conversationDateValue(conversation: ConversationView): number {
  const timestamp = Date.parse(conversation.updatedAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function makePreviewId(conversationId: string): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().slice(0, 8)
    : `${Date.now()}`;
  return `${conversationId}-duplicate-preview-${random}`;
}

function cloneConversationForPreview(conversation: ConversationView): ConversationView {
  const id = makePreviewId(conversation.id);
  const branchId = `${id}-branch`;
  return {
    ...conversation,
    id,
    activeBranchId: branchId,
    title: `${conversation.title} copy`,
    excerpt: conversation.excerpt,
    updatedAt: new Date().toISOString(),
    updatedLabel: "Now",
    pinned: false,
    archived: false,
    unread: false,
    hasDraft: conversation.hasDraft,
    messages: conversation.messages.map((message, index) => ({
      ...message,
      id: `${id}-message-${index + 1}`,
      attachments: message.attachments.map((attachment) => ({
        ...attachment,
        id: `${id}-${attachment.id}`,
      })),
    })),
  };
}

function filterLabel(filter: ConversationLibraryFilter): string {
  if (filter === "active") return "Active";
  if (filter === "archived") return "Archived";
  if (filter === "deleted") return "Deleted preview";
  return "All";
}

function normalizedSearchText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function searchTokens(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function conversationSearchCorpus(
  conversation: ConversationView,
  metadata: ConversationOrganization,
  scope: ConversationSearchScope,
): string {
  const title = conversation.title;
  const messages = conversation.messages
    .flatMap((message) => [
      message.content,
      message.modelLabel ?? "",
      ...message.attachments.flatMap((attachment) => [attachment.name, attachment.mediaType ?? ""]),
    ])
    .concat(conversation.excerpt)
    .join(" ");
  const project = [conversation.projectName ?? "Standalone", metadata.folder ?? "", ...metadata.tags].join(" ");
  const attachments = conversation.messages
    .flatMap((message) => message.attachments.flatMap((attachment) => [attachment.name, attachment.mediaType ?? ""]))
    .join(" ");

  if (scope === "title") return title;
  if (scope === "messages") return messages;
  if (scope === "project") return project;
  if (scope === "attachments") return attachments;
  return [title, messages, project, attachments].join(" ");
}

/** Renderer-local search predicate used by the Conversation Library preview. */
export function conversationMatchesLibrarySearch(
  conversation: ConversationView,
  metadata: ConversationOrganization,
  query: string,
  mode: ConversationSearchMode = "contains",
  scope: ConversationSearchScope = "all",
): boolean {
  const normalizedQuery = normalizedSearchText(query);
  if (!normalizedQuery) return true;
  const corpus = normalizedSearchText(conversationSearchCorpus(conversation, metadata, scope));
  if (mode === "exact-phrase") {
    const phrase = searchTokens(normalizedQuery);
    const tokens = searchTokens(corpus);
    return phrase.length > 0 && tokens.some((_, index) =>
      phrase.every((token, offset) => tokens[index + offset] === token),
    );
  }
  if (mode === "all-terms") return normalizedQuery.split(" ").every((term) => corpus.includes(term));
  return corpus.includes(normalizedQuery);
}

/** Stable renderer-local ranking. Higher scores indicate a stronger title/project hit. */
export function conversationLibrarySearchScore(
  conversation: ConversationView,
  metadata: ConversationOrganization,
  query: string,
): number {
  const normalizedQuery = normalizedSearchText(query);
  if (!normalizedQuery) return 0;
  const title = normalizedSearchText(conversation.title);
  const project = normalizedSearchText([conversation.projectName ?? "", metadata.folder ?? "", ...metadata.tags].join(" "));
  const messages = normalizedSearchText(conversation.messages.map((message) => message.content).join(" "));
  let score = 0;
  if (title === normalizedQuery) score += 100;
  else if (title.includes(normalizedQuery)) score += 60;
  if (project.includes(normalizedQuery)) score += 25;
  if (messages.includes(normalizedQuery)) score += 10;
  if (conversation.pinned) score += 2;
  return score;
}

const defaultFolders = ["Inbox", "Research", "Code", "Review"];

/**
 * Renderer-only conversation library lifecycle preview.
 *
 * This deliberately sits above the native library contract. Rename/pin/
 * archive/move use the existing renderer store actions so the UI is useful
 * during design review; soft-delete and duplicate are local preview records.
 * Durable receipts, conflict handling and native persistence remain planned.
 */
export function LibraryConversationCrudPreview() {
  const conversations = useWorkspaceStore((state) => state.conversations);
  const projects = useWorkspaceStore((state) => state.projects);
  const selectConversation = useWorkspaceStore((state) => state.selectConversation);
  const renameConversation = useWorkspaceStore((state) => state.renameConversation);
  const toggleConversationPinned = useWorkspaceStore((state) => state.toggleConversationPinned);
  const setConversationArchived = useWorkspaceStore((state) => state.setConversationArchived);
  const moveConversationToProject = useWorkspaceStore((state) => state.moveConversationToProject);

  const [filter, setFilter] = useState<ConversationLibraryFilter>("active");
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<ConversationSearchMode>("contains");
  const [searchScope, setSearchScope] = useState<ConversationSearchScope>("all");
  const [searchSort, setSearchSort] = useState<ConversationSearchSort>("recent");
  const [folderFilter, setFolderFilter] = useState<ConversationFolderFilter>("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [organization, setOrganization] = useState<Record<string, ConversationOrganization>>({});
  const [tagDrafts, setTagDrafts] = useState<Record<string, string>>({});
  const [savedCollections, setSavedCollections] = useState<SavedConversationCollection[]>([]);
  const [activeSavedCollectionId, setActiveSavedCollectionId] = useState<string | null>(null);
  const [savedCollectionName, setSavedCollectionName] = useState("");
  const [savedCollectionStatus, setSavedCollectionStatus] = useState("Smart collections stay in this renderer session.");
  const [previewDuplicates, setPreviewDuplicates] = useState<ConversationView[]>([]);
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [status, setStatus] = useState("Actions are renderer-local until native receipts are connected.");
  const [undoAction, setUndoAction] = useState<ConversationUndo | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [moveConversationId, setMoveConversationId] = useState<string | null>(null);
  const [moveQuery, setMoveQuery] = useState("");
  const [selectedMoveProjectId, setSelectedMoveProjectId] = useState<string | null>(null);
  const [moveActiveIndex, setMoveActiveIndex] = useState(0);
  const moveDestinationRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const moveTriggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const deletedSet = useMemo(() => new Set(deletedIds), [deletedIds]);
  const previewDuplicateIds = useMemo(
    () => new Set(previewDuplicates.map((conversation) => conversation.id)),
    [previewDuplicates],
  );
  const allConversations = useMemo(
    () => [...previewDuplicates, ...conversations],
    [conversations, previewDuplicates],
  );

  const getOrganization = (conversationId: string): ConversationOrganization => organization[conversationId] ?? { folder: null, tags: [] };

  const availableFolders = useMemo(() => {
    const folders = new Set(defaultFolders);
    Object.values(organization).forEach((entry) => {
      if (entry.folder) folders.add(entry.folder);
    });
    return [...folders].sort((left, right) => left.localeCompare(right));
  }, [organization]);

  const availableTags = useMemo(() => {
    const tags = new Set<string>();
    Object.values(organization).forEach((entry) => entry.tags.forEach((tag) => tags.add(tag)));
    return [...tags].sort((left, right) => left.localeCompare(right));
  }, [organization]);

  const visibleConversations = useMemo(() => {
    return [...allConversations]
      .filter((conversation) => {
        const isDeleted = deletedSet.has(conversation.id);
        const metadata = getOrganization(conversation.id);
        if (filter === "deleted" && !isDeleted) return false;
        if (filter !== "deleted" && isDeleted) return false;
        if (filter === "active" && conversation.archived) return false;
        if (filter === "archived" && !conversation.archived) return false;
        if (folderFilter === "none" && metadata.folder !== null) return false;
        if (folderFilter !== "all" && folderFilter !== "none" && metadata.folder !== folderFilter) return false;
        if (tagFilter !== "all" && !metadata.tags.includes(tagFilter)) return false;
        return conversationMatchesLibrarySearch(conversation, metadata, query, searchMode, searchScope);
      })
      .sort((left, right) => {
        if (searchSort === "title") return left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
        if (searchSort === "relevance") {
          const leftScore = conversationLibrarySearchScore(left, getOrganization(left.id), query);
          const rightScore = conversationLibrarySearchScore(right, getOrganization(right.id), query);
          if (leftScore !== rightScore) return rightScore - leftScore;
        }
        if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
        return conversationDateValue(right) - conversationDateValue(left);
      });
  }, [allConversations, deletedSet, filter, folderFilter, organization, query, searchMode, searchScope, searchSort, tagFilter]);

  const activeCount = allConversations.filter((conversation) => !conversation.archived && !deletedSet.has(conversation.id)).length;
  const archivedCount = allConversations.filter((conversation) => conversation.archived && !deletedSet.has(conversation.id)).length;

  const setUndo = (label: string, undo: () => void) => setUndoAction({ label, undo });

  const markManualCollection = () => {
    setActiveSavedCollectionId(null);
    setSavedCollectionStatus("Manual conversation filters are active.");
  };

  const startRename = (conversation: ConversationView) => {
    setEditingId(conversation.id);
    setEditingTitle(conversation.title);
    setStatus(`Editing “${conversation.title}”.`);
  };

  const cancelRename = () => {
    setEditingId(null);
    setEditingTitle("");
    setStatus("Rename cancelled.");
  };

  const commitRename = (conversation: ConversationView) => {
    const nextTitle = editingTitle.trim();
    if (!nextTitle) {
      setStatus("Enter a title before saving the conversation rename.");
      return;
    }
    renameConversation(conversation.id, nextTitle);
    setUndo(`Rename “${conversation.title}”`, () => renameConversation(conversation.id, conversation.title));
    setEditingId(null);
    setEditingTitle("");
    setStatus(`Renamed conversation to “${nextTitle}” in this renderer preview.`);
  };

  const togglePin = (conversation: ConversationView) => {
    toggleConversationPinned(conversation.id);
    setUndo(`${conversation.pinned ? "Unpin" : "Pin"} “${conversation.title}”`, () => toggleConversationPinned(conversation.id));
    setStatus(`${conversation.pinned ? "Unpinned" : "Pinned"} “${conversation.title}” in this renderer preview.`);
  };

  const toggleArchive = (conversation: ConversationView) => {
    if (!conversation.archived && conversation.runState === "streaming") {
      setStatus("A streaming conversation cannot be archived until its run stops.");
      return;
    }
    setConversationArchived(conversation.id, !conversation.archived);
    setUndo(`${conversation.archived ? "Restore" : "Archive"} “${conversation.title}”`, () => setConversationArchived(conversation.id, conversation.archived));
    setStatus(`${conversation.archived ? "Restored" : "Archived"} “${conversation.title}” in this renderer preview.`);
  };

  const openMovePicker = (conversation: ConversationView) => {
    setMoveConversationId(conversation.id);
    setSelectedMoveProjectId(conversation.projectId);
    setMoveQuery("");
    setMoveActiveIndex(0);
    setStatus(`Choose a destination for “${conversation.title}”; ownership stays unchanged until you confirm.`);
  };

  const closeMovePicker = () => {
    const previousConversationId = moveConversationId;
    setMoveConversationId(null);
    setMoveQuery("");
    setSelectedMoveProjectId(null);
    setMoveActiveIndex(0);
    moveDestinationRefs.current = [];
    if (previousConversationId) {
      moveTriggerRefs.current[previousConversationId]?.focus({ preventScroll: true });
    }
  };

  const confirmMove = (conversation: ConversationView) => {
    if (selectedMoveProjectId === conversation.projectId) {
      setStatus("Choose a different destination before confirming the Chat move.");
      return;
    }

    const currentProjects = useWorkspaceStore.getState().projects;
    if (selectedMoveProjectId !== null && !currentProjects.some((project) => project.id === selectedMoveProjectId)) {
      setSelectedMoveProjectId(conversation.projectId);
      setStatus(`The selected Project is no longer available. “${conversation.title}” stayed in ${conversation.projectName ?? "Standalone"}; no ownership change was applied.`);
      return;
    }

    const selectedProject = selectedMoveProjectId === null
      ? null
      : currentProjects.find((project) => project.id === selectedMoveProjectId);
    if (selectedProject?.archived === true) {
      setStatus(`The selected Project is archived and cannot receive Chat ownership. “${conversation.title}” stayed in ${conversation.projectName ?? "Standalone"}; no ownership change was applied.`);
      return;
    }
    if (selectedProject?.contextHealth === "missing-access") {
      setStatus(`The selected Project is unavailable because workspace access is missing. “${conversation.title}” stayed in ${conversation.projectName ?? "Standalone"}; no ownership change was applied.`);
      return;
    }

    const previousProjectId = conversation.projectId;
    const previousLabel = conversation.projectName ?? "Standalone";
    const destination = selectedProject?.name ?? "Standalone";
    moveConversationToProject(conversation.id, selectedMoveProjectId);
    setUndo(`Move “${conversation.title}”`, () => moveConversationToProject(conversation.id, previousProjectId));
    closeMovePicker();
    setStatus(`Moved “${conversation.title}” from ${previousLabel} to ${destination} in this renderer preview. History, branches, artifacts, and run receipts stayed attached.`);
  };

  const moveConversation = allConversations.find((conversation) => conversation.id === moveConversationId) ?? null;
  const moveDestinations = useMemo<LibraryMoveDestination[]>(() => {
    if (!moveConversation) return [];
    const normalizedQuery = moveQuery.trim().toLowerCase();
    const standalone = {
      id: "__standalone__",
      projectId: null as string | null,
      label: "Standalone / Inbox",
      description: "Keep this Chat outside a Project",
      recent: moveConversation.projectId === null,
      available: true,
    };
    const projectDestinations = projects
      .map((project) => ({
        id: project.id,
        projectId: project.id,
        label: project.name,
        description: project.archived
          ? `${project.description || "Project Chat destination"} · Project is archived`
          : project.contextHealth === "missing-access"
            ? `${project.description || "Project Chat destination"} · workspace access unavailable`
            : project.description || "Project Chat destination",
        recent: project.id === moveConversation.projectId || project.pinned,
        available: project.contextHealth !== "missing-access" && project.archived !== true,
        ...(project.archived
          ? { unavailableReason: "This Project is archived and cannot receive Chat ownership." }
          : project.contextHealth === "missing-access"
            ? { unavailableReason: "Workspace access is unavailable for this Project." }
            : {}),
      }))
      .sort((left, right) => {
        if (left.recent !== right.recent) return left.recent ? -1 : 1;
        return left.label.localeCompare(right.label);
      });
    const destinations = [standalone, ...projectDestinations];
    if (!normalizedQuery) return destinations;
    return destinations.filter((destination) => `${destination.label} ${destination.description}`.toLowerCase().includes(normalizedQuery));
  }, [moveConversation, moveQuery, projects]);

  useEffect(() => {
    if (!moveConversationId) return;
    const selectedIndex = moveDestinations.findIndex((destination) => destination.projectId === selectedMoveProjectId);
    setMoveActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [moveConversationId, moveDestinations, selectedMoveProjectId]);

  useEffect(() => {
    if (!moveConversationId) return;
    moveDestinationRefs.current[moveActiveIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [moveActiveIndex, moveConversationId]);

  const moveDestinationKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMovePicker();
      return;
    }
    if (moveDestinations.length === 0) return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = (index + 1) % moveDestinations.length;
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = (index - 1 + moveDestinations.length) % moveDestinations.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = moveDestinations.length - 1;
    if (nextIndex !== null) {
      event.preventDefault();
      setMoveActiveIndex(nextIndex);
      moveDestinationRefs.current[nextIndex]?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const destination = moveDestinations[index];
      if (!destination) return;
      if (!destination.available) {
        setStatus(`${destination.label} is unavailable. ${destination.unavailableReason ?? "Choose another destination."}`);
        return;
      }
      setSelectedMoveProjectId(destination.projectId);
    }
  };

  const softDelete = (conversation: ConversationView) => {
    setDeletedIds((current) => current.includes(conversation.id) ? current : [...current, conversation.id]);
    setFilter("deleted");
    setExpandedId(conversation.id);
    setUndoAction({
      label: `Delete “${conversation.title}”`,
      undo: () => setDeletedIds((current) => current.filter((id) => id !== conversation.id)),
    });
    setStatus(`Soft-deleted “${conversation.title}” in this renderer preview. Native tombstone receipt is planned.`);
  };

  const restoreDeleted = (conversation: ConversationView) => {
    setDeletedIds((current) => current.filter((id) => id !== conversation.id));
    setFilter(conversation.archived ? "archived" : "active");
    setExpandedId(conversation.id);
    setUndoAction({
      label: `Restore “${conversation.title}”`,
      undo: () => setDeletedIds((current) => [...current, conversation.id]),
    });
    setStatus(`Restored “${conversation.title}” in this renderer preview.`);
  };

  const duplicatePreview = (conversation: ConversationView) => {
    const duplicate = cloneConversationForPreview(conversation);
    const sourceOrganization = getOrganization(conversation.id);
    setPreviewDuplicates((current) => [duplicate, ...current]);
    if (sourceOrganization.folder || sourceOrganization.tags.length > 0) {
      setOrganization((current) => ({ ...current, [duplicate.id]: { ...sourceOrganization, tags: [...sourceOrganization.tags] } }));
    }
    setUndo(`Duplicate “${conversation.title}”`, () => {
      setPreviewDuplicates((current) => current.filter((item) => item.id !== duplicate.id));
      setOrganization((current) => {
        const next = { ...current };
        delete next[duplicate.id];
        return next;
      });
    });
    setStatus(`Created “${duplicate.title}” as a renderer-local duplicate preview.`);
  };

  const updateOrganization = (conversation: ConversationView, patch: Partial<ConversationOrganization>, message: string) => {
    const previous = getOrganization(conversation.id);
    setOrganization((current) => ({
      ...current,
      [conversation.id]: { ...previous, ...patch },
    }));
    setUndo(message, () => setOrganization((current) => ({ ...current, [conversation.id]: previous })));
  };

  const setConversationFolder = (conversation: ConversationView, folder: string) => {
    const nextFolder = folder || null;
    updateOrganization(conversation, { folder: nextFolder }, `Change folder for “${conversation.title}”`);
    setStatus(`${nextFolder ? `Moved “${conversation.title}” to folder ${nextFolder}` : `Removed “${conversation.title}” from its folder`} in this renderer preview.`);
  };

  const addConversationTag = (conversation: ConversationView) => {
    const draft = (tagDrafts[conversation.id] ?? "").trim().replace(/\s+/g, " ");
    if (!draft) {
      setStatus("Enter a tag before adding it.");
      return;
    }
    const previous = getOrganization(conversation.id);
    if (previous.tags.some((tag) => tag.toLowerCase() === draft.toLowerCase())) {
      setStatus(`Tag “${draft}” is already assigned to “${conversation.title}”.`);
      return;
    }
    updateOrganization(conversation, { tags: [...previous.tags, draft] }, `Add tag to “${conversation.title}”`);
    setTagDrafts((current) => ({ ...current, [conversation.id]: "" }));
    setStatus(`Added tag “${draft}” to “${conversation.title}” in this renderer preview.`);
  };

  const removeConversationTag = (conversation: ConversationView, tag: string) => {
    const previous = getOrganization(conversation.id);
    updateOrganization(conversation, { tags: previous.tags.filter((candidate) => candidate !== tag) }, `Remove tag from “${conversation.title}”`);
    setStatus(`Removed tag “${tag}” from “${conversation.title}” in this renderer preview.`);
  };

  const saveCollection = () => {
    const name = savedCollectionName.trim();
    if (!name) {
      setSavedCollectionStatus("Enter a name before saving this smart collection.");
      return;
    }
    const collection: SavedConversationCollection = {
      id: `conversation-collection-${Date.now()}`,
      name,
      filter,
      query,
      folder: folderFilter,
      tag: tagFilter,
      searchMode,
      searchScope,
      searchSort,
    };
    setSavedCollections((current) => [...current.filter((item) => item.name.toLowerCase() !== name.toLowerCase()), collection]);
    setActiveSavedCollectionId(collection.id);
    setSavedCollectionName("");
    setSavedCollectionStatus(`Saved “${name}” in this renderer preview.`);
  };

  const applyCollection = (collectionId: string) => {
    if (collectionId === "manual") {
      setActiveSavedCollectionId(null);
      setSavedCollectionStatus("Manual conversation filters are active.");
      return;
    }
    const collection = savedCollections.find((item) => item.id === collectionId);
    if (!collection) return;
    setFilter(collection.filter);
    setQuery(collection.query);
    setFolderFilter(collection.folder);
    setTagFilter(collection.tag);
    setSearchMode(collection.searchMode);
    setSearchScope(collection.searchScope);
    setSearchSort(collection.searchSort);
    setActiveSavedCollectionId(collection.id);
    setSavedCollectionStatus(`Applied “${collection.name}” in this renderer preview.`);
  };

  const deleteCollection = () => {
    if (!activeSavedCollectionId) return;
    const collection = savedCollections.find((item) => item.id === activeSavedCollectionId);
    setSavedCollections((current) => current.filter((item) => item.id !== activeSavedCollectionId));
    setActiveSavedCollectionId(null);
    setSavedCollectionStatus(collection ? `Deleted “${collection.name}” from this renderer session.` : "Deleted the selected renderer-local collection.");
  };

  const undo = () => {
    if (!undoAction) return;
    undoAction.undo();
    setStatus(`Undid ${undoAction.label}.`);
    setUndoAction(null);
  };

  return (
    <section className="library-conversation-crud" aria-label="Conversation library CRUD preview">
      <header className="library-conversation-crud__header">
        <div>
          <span className="eyebrow"><MessageSquare size={13} /> Conversation library</span>
          <h2>Manage chats like a real workspace</h2>
          <p>Rename, pin, move and archive from one preview surface. Delete and duplicate stay reversible until native receipts exist.</p>
        </div>
        <span className="library-conversation-crud__boundary">Preview · renderer-local · no durable write</span>
      </header>

      <div className="library-conversation-crud__toolbar">
        <label className="library-conversation-crud__search">
          <Search size={14} />
          <input value={query} onChange={(event) => { setQuery(event.target.value); markManualCollection(); }} placeholder="Search chats, projects, tags, or folders" aria-label="Search conversation library" />
        </label>
        <select value={searchMode} onChange={(event) => { setSearchMode(event.target.value as ConversationSearchMode); markManualCollection(); }} aria-label="Conversation search mode">
          <option value="contains">Smart contains</option>
          <option value="all-terms">All terms</option>
          <option value="exact-phrase">Exact phrase</option>
        </select>
        <select value={searchScope} onChange={(event) => { setSearchScope(event.target.value as ConversationSearchScope); markManualCollection(); }} aria-label="Conversation search scope">
          <option value="all">Everything</option>
          <option value="title">Titles</option>
          <option value="messages">Messages</option>
          <option value="project">Projects, folders, tags</option>
          <option value="attachments">Attachments</option>
        </select>
        <select value={searchSort} onChange={(event) => { setSearchSort(event.target.value as ConversationSearchSort); markManualCollection(); }} aria-label="Conversation search sort">
          <option value="recent">Pinned &amp; recent</option>
          <option value="relevance">Best match</option>
          <option value="title">Title A–Z</option>
        </select>
        <div className="library-conversation-crud__filters" role="group" aria-label="Conversation library filter">
          {(["active", "archived", "deleted", "all"] as const).map((value) => (
            <button key={value} type="button" className={filter === value ? "active" : ""} onClick={() => { setFilter(value); markManualCollection(); }} aria-pressed={filter === value}>
              {filterLabel(value)}
              <small>{value === "active" ? activeCount : value === "archived" ? archivedCount : value === "deleted" ? deletedIds.length : allConversations.length}</small>
            </button>
          ))}
        </div>
        <select value={folderFilter} onChange={(event) => { setFolderFilter(event.target.value); markManualCollection(); }} aria-label="Filter conversations by folder">
          <option value="all">Every folder</option>
          <option value="none">No folder</option>
          {availableFolders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}
        </select>
        <select value={tagFilter} onChange={(event) => { setTagFilter(event.target.value); markManualCollection(); }} aria-label="Filter conversations by tag">
          <option value="all">Every tag</option>
          {availableTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
        </select>
        {undoAction ? <button type="button" className="button button--ghost" onClick={undo}><Undo2 size={13} /> Undo</button> : null}
      </div>

      <div className="library-conversation-crud__collections" aria-label="Saved conversation collections">
        <label>
          <span><Folder size={13} /> Smart collection</span>
          <select value={activeSavedCollectionId ?? "manual"} onChange={(event) => applyCollection(event.target.value)} aria-label="Saved conversation collection">
            <option value="manual">Manual current filters</option>
            {savedCollections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}
          </select>
        </label>
        <input value={savedCollectionName} onChange={(event) => setSavedCollectionName(event.target.value)} placeholder="Name this collection" aria-label="New saved conversation collection name" />
        <button type="button" className="button button--ghost" onClick={saveCollection}><Check size={13} /> Save collection</button>
        <button type="button" className="button button--ghost" onClick={deleteCollection} disabled={!activeSavedCollectionId} aria-label="Delete saved conversation collection" title={activeSavedCollectionId ? "Delete the selected saved conversation collection" : "Choose a saved conversation collection before deleting it"}><Trash2 size={13} /></button>
        <span className="library-conversation-crud__collection-status" role="status" aria-live="polite">{savedCollectionStatus}</span>
      </div>

      <div className="library-conversation-crud__status" role="status" aria-live="polite">{status}</div>

      {visibleConversations.length === 0 ? (
        <div className="library-conversation-crud__empty" role="status">
          <MessageSquare size={18} />
          <span>No conversations match this preview filter.</span>
        </div>
      ) : (
        <div className="library-conversation-crud__list">
          {visibleConversations.map((conversation) => {
            const isDeleted = deletedSet.has(conversation.id);
            const isPreviewOnly = previewDuplicateIds.has(conversation.id);
            const isExpanded = expandedId === conversation.id;
            const metadata = getOrganization(conversation.id);
            return (
              <article key={conversation.id} className={isExpanded ? "library-conversation-crud__row library-conversation-crud__row--expanded" : "library-conversation-crud__row"}>
                <button type="button" className="library-conversation-crud__row-main" onClick={() => setExpandedId(isExpanded ? null : conversation.id)} aria-expanded={isExpanded} aria-label={`Expand conversation ${conversation.title}`}>
                  <span className="library-conversation-crud__row-icon"><MessageSquare size={15} /></span>
                  <span className="library-conversation-crud__row-copy">
                    <strong>{conversation.title}</strong>
                    <small>{conversation.projectName ?? "Standalone"} · {conversation.updatedLabel} · {conversation.messages.length} {conversation.messages.length === 1 ? "message" : "messages"}</small>
                  </span>
                  <span className="library-conversation-crud__row-badges">
                    {conversation.pinned ? <small className="library-conversation-crud__badge library-conversation-crud__badge--pinned"><Pin size={10} /> Pinned</small> : null}
                    {conversation.archived ? <small className="library-conversation-crud__badge">Archived</small> : null}
                    {isDeleted ? <small className="library-conversation-crud__badge library-conversation-crud__badge--danger">Deleted preview</small> : null}
                    {isPreviewOnly ? <small className="library-conversation-crud__badge">Local copy</small> : null}
                    {metadata.folder ? <small className="library-conversation-crud__badge"><Folder size={10} /> {metadata.folder}</small> : null}
                    {metadata.tags.map((tag) => <small key={tag} className="library-conversation-crud__badge library-conversation-crud__badge--tag"><Tag size={10} /> {tag}</small>)}
                  </span>
                  <ChevronDown size={15} className={isExpanded ? "library-conversation-crud__chevron library-conversation-crud__chevron--open" : "library-conversation-crud__chevron"} />
                </button>
                {isExpanded ? (
                  <div className="library-conversation-crud__actions">
                    <div className="library-conversation-crud__action-row">
                      <button type="button" className="button button--primary" onClick={() => selectConversation(conversation.id)} disabled={isDeleted || isPreviewOnly} title={isPreviewOnly ? "This duplicate exists only in the renderer preview" : undefined}><MessageSquare size={13} /> Open chat</button>
                      <button type="button" className="button button--ghost" onClick={() => startRename(conversation)} disabled={isDeleted || isPreviewOnly}><Pencil size={13} /> Rename</button>
                      <button type="button" className="button button--ghost" onClick={() => togglePin(conversation)} disabled={isDeleted || isPreviewOnly}>{conversation.pinned ? <PinOff size={13} /> : <Pin size={13} />} {conversation.pinned ? "Unpin" : "Pin"}</button>
                      <button type="button" className="button button--ghost" onClick={() => toggleArchive(conversation)} disabled={isDeleted || isPreviewOnly}><Archive size={13} /> {conversation.archived ? "Restore" : "Archive"}</button>
                    </div>
                    {editingId === conversation.id ? (
                      <div className="library-conversation-crud__rename">
                        <input value={editingTitle} onChange={(event) => setEditingTitle(event.target.value)} aria-label={`Rename conversation ${conversation.title}`} autoFocus />
                        <button type="button" className="button button--primary" onClick={() => commitRename(conversation)}><Check size={13} /> Save title</button>
                        <button type="button" className="button button--ghost" onClick={cancelRename}>Cancel</button>
                      </div>
                    ) : null}
                    <div className="library-conversation-crud__secondary-row">
                      <button
                        type="button"
                        className="button button--ghost library-conversation-crud__move-trigger"
                        onClick={() => openMovePicker(conversation)}
                        ref={(element) => {
                          moveTriggerRefs.current[conversation.id] = element;
                        }}
                        disabled={isDeleted || isPreviewOnly}
                        aria-expanded={moveConversationId === conversation.id}
                        aria-controls={moveConversationId === conversation.id ? `library-move-panel-${conversation.id}` : undefined}
                        aria-label={`Move ${conversation.title} to project`}
                      >
                        <FolderInput size={13} /> Move to project…
                      </button>
                      <button type="button" className="button button--ghost" onClick={() => duplicatePreview(conversation)} disabled={isDeleted || isPreviewOnly} title="Duplicate receipt is renderer-local in this preview"><Copy size={13} /> Duplicate preview</button>
                      {isDeleted ? (
                        <button type="button" className="button button--secondary" onClick={() => restoreDeleted(conversation)}><RotateCcw size={13} /> Restore preview</button>
                      ) : (
                        <button type="button" className="button button--ghost" onClick={() => softDelete(conversation)} title="Native tombstone and permanent delete are planned"><Trash2 size={13} /> Delete preview</button>
                      )}
                    </div>
                    {moveConversationId === conversation.id ? (
                      <div id={`library-move-panel-${conversation.id}`} className="library-conversation-crud__move-panel" role="group" aria-label={`Move ${conversation.title} destination picker`}>
                        <div className="library-conversation-crud__move-heading">
                          <div>
                            <strong>Choose destination</strong>
                            <small>Ownership stays unchanged until you confirm.</small>
                          </div>
                          <button type="button" className="button button--ghost" onClick={closeMovePicker}>Cancel</button>
                        </div>
                        <label className="library-conversation-crud__move-search">
                          <Search size={13} aria-hidden="true" />
                          <input
                            value={moveQuery}
                            onChange={(event) => setMoveQuery(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                event.preventDefault();
                                closeMovePicker();
                                return;
                              }
                              if (event.key === "ArrowDown" && moveDestinations.length > 0) {
                                event.preventDefault();
                                const nextIndex = Math.min(moveActiveIndex, moveDestinations.length - 1);
                                setMoveActiveIndex(nextIndex);
                                moveDestinationRefs.current[nextIndex]?.focus({ preventScroll: true });
                              }
                            }}
                            placeholder="Search Projects"
                            aria-label={`Search destinations for ${conversation.title}`}
                            aria-controls={`library-move-destinations-${conversation.id}`}
                            aria-expanded="true"
                            autoFocus
                          />
                        </label>
                        <div id={`library-move-destinations-${conversation.id}`} className="library-conversation-crud__move-destinations" role="listbox" aria-label={`Destinations for ${conversation.title}`} aria-orientation="vertical">
                          {moveDestinations.length > 0 ? moveDestinations.map((destination) => {
                            const destinationIndex = moveDestinations.indexOf(destination);
                            const selected = selectedMoveProjectId === destination.projectId;
                            return (
                              <button
                                key={destination.id}
                                type="button"
                                role="option"
                                aria-selected={selected}
                                aria-disabled={!destination.available}
                                aria-posinset={destinationIndex + 1}
                                aria-setsize={moveDestinations.length}
                                tabIndex={destinationIndex === moveActiveIndex ? 0 : -1}
                                ref={(element) => {
                                  moveDestinationRefs.current[destinationIndex] = element;
                                }}
                                className={selected ? "library-conversation-crud__move-destination is-selected" : "library-conversation-crud__move-destination"}
                                onFocus={() => setMoveActiveIndex(destinationIndex)}
                                onKeyDown={(event) => moveDestinationKeyDown(event, destinationIndex)}
                                onClick={() => {
                                  if (!destination.available) {
                                    setStatus(`${destination.label} is unavailable. ${destination.unavailableReason ?? "Choose another destination."}`);
                                    return;
                                  }
                                  setSelectedMoveProjectId(destination.projectId);
                                  setMoveActiveIndex(destinationIndex);
                                }}
                              >
                                <span><strong>{destination.label}</strong><small>{destination.description}</small></span>
                                <span className="library-conversation-crud__move-badges">
                                  {destination.recent ? <small>Recent</small> : null}
                                  {!destination.available ? <small>Unavailable</small> : null}
                                  {selected ? <small>Selected</small> : null}
                                </span>
                              </button>
                            );
                          }) : <span className="library-conversation-crud__move-empty">No destinations match “{moveQuery}”.</span>}
                        </div>
                        <div id={`library-move-summary-${conversation.id}`} className="library-conversation-crud__move-summary" role="status" aria-live="polite">
                          <span>From <strong>{conversation.projectName ?? "Standalone"}</strong></span>
                          <span aria-hidden="true">→</span>
                          <span>To <strong>{selectedMoveProjectId ? projects.find((project) => project.id === selectedMoveProjectId)?.name ?? "Unavailable project" : "Standalone"}</strong></span>
                        </div>
                        <div className="library-conversation-crud__move-diff">
                          <div><strong>Changes</strong><span>Project instructions, memory, skills, and model defaults recalculate.</span></div>
                          <div><strong>Unchanged</strong><span>History, branches, artifacts, and run receipts stay attached.</span></div>
                        </div>
                        <p id={`library-move-boundary-${conversation.id}`} className="library-conversation-crud__move-boundary">Preview only · renderer-local · no durable write.</p>
                        <button
                          type="button"
                          className="button button--primary"
                          onClick={() => confirmMove(conversation)}
                          disabled={selectedMoveProjectId === conversation.projectId}
                          aria-describedby={`library-move-summary-${conversation.id} library-move-boundary-${conversation.id}`}
                        >
                          Confirm move
                        </button>
                      </div>
                    ) : null}
                    <div className="library-conversation-crud__organization-row">
                      <label>
                        <Folder size={13} />
                        <span className="sr-only">Folder for {conversation.title}</span>
                        <select value={metadata.folder ?? ""} onChange={(event) => setConversationFolder(conversation, event.target.value)} disabled={isDeleted || isPreviewOnly} aria-label={`Folder for ${conversation.title}`}>
                          <option value="">No folder</option>
                          {availableFolders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}
                        </select>
                      </label>
                      <div className="library-conversation-crud__tag-editor">
                        <Tag size={13} />
                        {metadata.tags.map((tag) => <button key={tag} type="button" className="library-conversation-crud__tag" onClick={() => removeConversationTag(conversation, tag)} disabled={isDeleted || isPreviewOnly} aria-label={`Remove tag ${tag} from ${conversation.title}`}>{tag} ×</button>)}
                        <input value={tagDrafts[conversation.id] ?? ""} onChange={(event) => setTagDrafts((current) => ({ ...current, [conversation.id]: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addConversationTag(conversation); } }} placeholder="Add tag" aria-label={`Tag name for ${conversation.title}`} disabled={isDeleted || isPreviewOnly} />
                        <button type="button" className="button button--ghost" onClick={() => addConversationTag(conversation)} disabled={isDeleted || isPreviewOnly} aria-label={`Add tag to ${conversation.title}`}><Plus size={13} /></button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
      <footer className="library-conversation-crud__footer"><FolderInput size={13} /> Project moves, tags, folders, smart collections, native receipts, and policy-controlled permanent delete remain renderer-preview only; durable library CRUD is Planned.</footer>
    </section>
  );
}
