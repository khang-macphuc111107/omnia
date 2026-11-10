import {
  CheckCircle2,
  Copy,
  Cpu,
  Edit3,
  FolderPlus,
  FolderTree,
  GitCompareArrows,
  Link2,
  MessageSquarePlus,
  Network,
  PlusCircle,
  Search,
  ShieldCheck,
  Sliders,
  Sparkles,
  Terminal,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import {
  buildDirectSovereignCustomProviderBlueprint,
  DEFAULT_SOVEREIGN_DIRECT_SYSTEM_DIRECTIVE,
  DETECTED_ACER_NITRO_HARDWARE,
  LOCAL_UNCENSORED_MODEL_CATALOG,
  recommendLocalModelsForHardware,
  type LocalUncensoredModelDescriptor,
} from "@/domain/local-model-hardware-advisor";
import {
  createOfficialHarnessAdapterRegistry,
  listOfficialHarnessDescriptors,
  OFFICIAL_HARNESS_FAMILY_IDS,
  type OfficialHarnessDescriptor,
  type OfficialHarnessFamilyId,
} from "@/domain/omnia-official-harness-adapters";
import { queryHippoRagAssociativeGraph } from "@/domain/session-dfs-tree";

import { useWorkspaceStore } from "./store";

export type KnowledgeStudioTabId =
  | "ltst-tree"
  | "official-harnesses"
  | "uncensored-local-ai";

export type SovereignArtifactTabId =
  | "powershell"
  | "modelfile"
  | "llamacpp"
  | "provider-json";

export const LTST_KNOWLEDGE_STORAGE_KEY = "omnia.ltst.knowledge.v1";
export const HARNESS_CONFIG_STORAGE_KEY = "omnia.harnesses.config.v1";

export const LTST_CANONICAL_FOLDERS = Object.freeze([
  "/architecture",
  "/user-preferences",
  "/bug-postmortems",
  "/learned-skills",
  "/session-provenance",
] as const);

export const LTST_SEMANTIC_RELATIONS = Object.freeze([
  "supports",
  "contradicts",
  "derived-from",
  "supersedes",
] as const);

export type LtstSemanticRelation = (typeof LTST_SEMANTIC_RELATIONS)[number];

export interface LtstKnowledgeFolder {
  readonly id: string;
  readonly path: string;
  readonly label: string;
  readonly description: string;
}

export interface LtstSemanticLink {
  readonly id: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly relation: LtstSemanticRelation;
  readonly rationale: string;
}

export interface LtstKnowledgeNode {
  readonly id: string;
  readonly folderPath: string;
  readonly title: string;
  readonly summary: string;
  readonly content: string;
  readonly confidence: number;
  readonly provenanceUris: readonly string[];
  readonly harnessId: OfficialHarnessFamilyId;
  readonly updatedAt: string;
}

export interface HarnessRuntimeConfig {
  readonly harnessId: OfficialHarnessFamilyId;
  readonly kvCacheBreakpointsEnabled: boolean;
  readonly ltstTokenBudget: number;
  readonly autoDistillSkills: boolean;
}

export interface KnowledgeTreeExplorerProps {
  readonly initialFolders?: readonly LtstKnowledgeFolder[];
  readonly initialNodes?: readonly LtstKnowledgeNode[];
  readonly initialLinks?: readonly LtstSemanticLink[];
  readonly initialActiveHarnessId?: OfficialHarnessFamilyId;
  readonly onSelectHarness?: (harnessId: OfficialHarnessFamilyId, descriptor: OfficialHarnessDescriptor) => void;
  readonly onCreateFolder?: (folder: LtstKnowledgeFolder) => void;
  readonly onCreateNode?: (node: LtstKnowledgeNode) => void;
  readonly onUpdateNode?: (node: LtstKnowledgeNode) => void;
}

interface PersistedLtstKnowledgeTree {
  readonly folders: readonly LtstKnowledgeFolder[];
  readonly nodes: readonly LtstKnowledgeNode[];
  readonly semanticLinks: readonly LtstSemanticLink[];
}

interface PersistedHarnessStudioState {
  readonly selectedHarnessId: OfficialHarnessFamilyId;
  readonly harnessConfigs: Readonly<Record<OfficialHarnessFamilyId, HarnessRuntimeConfig>>;
}

function createDefaultHarnessConfigs(): Readonly<Record<OfficialHarnessFamilyId, HarnessRuntimeConfig>> {
  const initialMap = {} as Record<OfficialHarnessFamilyId, HarnessRuntimeConfig>;
  for (const id of OFFICIAL_HARNESS_FAMILY_IDS) {
    initialMap[id] = {
      harnessId: id,
      kvCacheBreakpointsEnabled: true,
      ltstTokenBudget: 4096,
      autoDistillSkills: true,
    };
  }
  return initialMap;
}

function loadPersistedLtstTree(): PersistedLtstKnowledgeTree | null {
  try {
    if (typeof window === "undefined" || typeof window.localStorage?.getItem !== "function") {
      return null;
    }
    const raw = window.localStorage.getItem(LTST_KNOWLEDGE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedLtstKnowledgeTree>;
    if (
      parsed &&
      Array.isArray(parsed.folders) &&
      parsed.folders.length > 0 &&
      Array.isArray(parsed.nodes) &&
      parsed.nodes.length > 0 &&
      Array.isArray(parsed.semanticLinks)
    ) {
      return {
        folders: parsed.folders,
        nodes: parsed.nodes,
        semanticLinks: parsed.semanticLinks,
      };
    }
  } catch {
    // Ignore storage read errors
  }
  return null;
}

function savePersistedLtstTree(tree: PersistedLtstKnowledgeTree): void {
  try {
    if (typeof window === "undefined" || typeof window.localStorage?.setItem !== "function") {
      return;
    }
    window.localStorage.setItem(LTST_KNOWLEDGE_STORAGE_KEY, JSON.stringify(tree));
  } catch {
    // Ignore storage write errors
  }
}

function loadPersistedHarnessStudioState(): PersistedHarnessStudioState | null {
  try {
    if (typeof window === "undefined" || typeof window.localStorage?.getItem !== "function") {
      return null;
    }
    const raw = window.localStorage.getItem(HARNESS_CONFIG_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedHarnessStudioState>;
    if (
      parsed &&
      typeof parsed.selectedHarnessId === "string" &&
      OFFICIAL_HARNESS_FAMILY_IDS.includes(parsed.selectedHarnessId as OfficialHarnessFamilyId) &&
      parsed.harnessConfigs &&
      typeof parsed.harnessConfigs === "object"
    ) {
      return {
        selectedHarnessId: parsed.selectedHarnessId as OfficialHarnessFamilyId,
        harnessConfigs: {
          ...createDefaultHarnessConfigs(),
          ...parsed.harnessConfigs,
        },
      };
    }
  } catch {
    // Ignore storage read errors
  }
  return null;
}

function savePersistedHarnessStudioState(state: PersistedHarnessStudioState): void {
  try {
    if (typeof window === "undefined" || typeof window.localStorage?.setItem !== "function") {
      return;
    }
    window.localStorage.setItem(HARNESS_CONFIG_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage write errors
  }
}

export function createDefaultLtstFolders(): readonly LtstKnowledgeFolder[] {
  return Object.freeze([
    {
      id: "folder-architecture",
      path: "/architecture",
      label: "Architecture",
      description: "Core system invariants, KV-cache prefix topology, and IPC contracts replacing flat MEMORY.md.",
    },
    {
      id: "folder-user-preferences",
      path: "/user-preferences",
      label: "User Preferences",
      description: "Verified workflow preferences, strict TypeScript standards, and UI ergonomics.",
    },
    {
      id: "folder-bug-postmortems",
      path: "/bug-postmortems",
      label: "Bug Postmortems",
      description: "Root-cause analyses, regression guards, and invalidated assumptions.",
    },
    {
      id: "folder-learned-skills",
      path: "/learned-skills",
      label: "Learned Skills",
      description: "Procedural skills distilled from Hermes, Codex, Claude Code, and OpenHands trajectories.",
    },
    {
      id: "folder-session-provenance",
      path: "/session-provenance",
      label: "Session Provenance",
      description: "Cross-session A -> B -> C DFS lineage and immutable audit anchors.",
    },
  ]);
}

export function createDefaultLtstNodes(): readonly LtstKnowledgeNode[] {
  return Object.freeze([
    {
      id: "node-arch-kv-prefix",
      folderPath: "/architecture",
      title: "Immutable Prefix KV-Cache Ring (150+ tok/s)",
      summary: "Keep system instructions, tool schemas, and LTST trunk frozen at prefix slot 0.",
      content:
        "Never mutate system prompt timestamps or reorder tool schemas mid-session. Append dynamic LTST retrieval blocks at the turn frontier to preserve >98% KV-cache hit rates.",
      confidence: 0.98,
      provenanceUris: ["omnia://sessions/session-a", "codex://threads/session-b1"],
      harnessId: "custom-cache-first",
      updatedAt: "2026-10-18T16:00:00Z",
    },
    {
      id: "node-pref-strict-ts",
      folderPath: "/user-preferences",
      title: "Strict TypeScript & Zero-Flat-Memory Policy",
      summary: "Enforce exactOptionalPropertyTypes and structured LTST nodes instead of flat MEMORY.md.",
      content:
        "All domain models use frozen records, explicit DomainError assertions, and hierarchical LTST folders rather than unstructured flat markdown dumps.",
      confidence: 0.95,
      provenanceUris: ["omnia://sessions/session-a"],
      harnessId: "openai-gpt-codex",
      updatedAt: "2026-10-18T16:01:00Z",
    },
    {
      id: "node-bug-flat-memory-drift",
      folderPath: "/bug-postmortems",
      title: "Postmortem: Flat MEMORY.md Context Pollution & Cache Busting",
      summary: "Rewriting a monolithic MEMORY.md invalidated prefix caches on every turn.",
      content:
        "Legacy flat MEMORY.md files grew unbounded and mutated the system prompt prefix on every turn, dropping throughput from 165 tok/s to 38 tok/s.",
      confidence: 0.92,
      provenanceUris: ["claude://sessions/session-c1"],
      harnessId: "anthropic-claude-code",
      updatedAt: "2026-10-18T16:02:00Z",
    },
    {
      id: "node-skill-dfs-synthesis",
      folderPath: "/learned-skills",
      title: "Skill: Recursive Pre-Order A->B->C Session Synthesis",
      summary: "Traverse childSessionIds and referencedSessionUris with cycle-safe pre-order DFS.",
      content:
        "When a parent session references codex://threads/B and B references claude://sessions/C, run pre-order DFS with visitedIds cycle guards to compile a deterministic digest.",
      confidence: 0.96,
      provenanceUris: ["codex://threads/session-b1", "agy://conversations/session-c2"],
      harnessId: "hermes-self-improving",
      updatedAt: "2026-10-18T16:03:00Z",
    },
    {
      id: "node-prov-dfs-root",
      folderPath: "/session-provenance",
      title: "Provenance Anchor: Session A -> B1 -> C1 -> C2 -> B2",
      summary: "Verified multi-harness lineage across Codex, Claude Code, AGY 2.0, and Custom Cache-First.",
      content:
        "Recorded deterministic pre-order traversal across 5 live sessions totaling 28,490 tokens with 1 back-edge cycle skipped.",
      confidence: 0.99,
      provenanceUris: [
        "omnia://sessions/session-a",
        "codex://threads/session-b1",
        "claude://sessions/session-c1",
        "agy://conversations/session-c2",
      ],
      harnessId: "strands-agent-graph",
      updatedAt: "2026-10-18T16:05:00Z",
    },
  ]);
}

export function createDefaultLtstSemanticLinks(): readonly LtstSemanticLink[] {
  return Object.freeze([
    {
      id: "link-1",
      sourceNodeId: "node-arch-kv-prefix",
      targetNodeId: "node-bug-flat-memory-drift",
      relation: "supersedes",
      rationale: "Immutable KV-cache prefix ring supersedes legacy flat MEMORY.md rewrite loop.",
    },
    {
      id: "link-2",
      sourceNodeId: "node-skill-dfs-synthesis",
      targetNodeId: "node-arch-kv-prefix",
      relation: "supports",
      rationale: "Pre-order DFS digest injects at the turn tail without mutating the cached prefix.",
    },
    {
      id: "link-3",
      sourceNodeId: "node-prov-dfs-root",
      targetNodeId: "node-skill-dfs-synthesis",
      relation: "derived-from",
      rationale: "Provenance anchor was generated by executing the DFS synthesis skill.",
    },
    {
      id: "link-4",
      sourceNodeId: "node-bug-flat-memory-drift",
      targetNodeId: "node-pref-strict-ts",
      relation: "contradicts",
      rationale: "Unstructured flat memory growth contradicts strict typed LTST governance.",
    },
  ]);
}

export function KnowledgeTreeExplorer({
  initialFolders,
  initialNodes,
  initialLinks,
  initialActiveHarnessId,
  onSelectHarness,
  onCreateFolder,
  onCreateNode,
  onUpdateNode,
}: KnowledgeTreeExplorerProps) {
  const activeConversationId = useWorkspaceStore((state) => state.activeConversationId);
  const updateDraft = useWorkspaceStore((state) => state.updateDraft);

  const harnessRegistry = useMemo(() => createOfficialHarnessAdapterRegistry(), []);
  const harnessDescriptors = useMemo(() => listOfficialHarnessDescriptors(), []);

  const [folders, setFolders] = useState<readonly LtstKnowledgeFolder[]>(
    () => initialFolders ?? loadPersistedLtstTree()?.folders ?? createDefaultLtstFolders(),
  );
  const [nodes, setNodes] = useState<readonly LtstKnowledgeNode[]>(
    () => initialNodes ?? loadPersistedLtstTree()?.nodes ?? createDefaultLtstNodes(),
  );
  const [semanticLinks, setSemanticLinks] = useState<readonly LtstSemanticLink[]>(
    () => initialLinks ?? loadPersistedLtstTree()?.semanticLinks ?? createDefaultLtstSemanticLinks(),
  );

  const [selectedFolderPath, setSelectedFolderPath] = useState<string>("ALL");
  const [selectedNodeId, setSelectedNodeId] = useState<string>(
    () => (initialNodes ?? loadPersistedLtstTree()?.nodes ?? createDefaultLtstNodes())[0]?.id ?? "node-arch-kv-prefix",
  );

  // Create Folder state
  const [newFolderPath, setNewFolderPath] = useState<string>("");
  const [newFolderDescription, setNewFolderDescription] = useState<string>("");

  // Create Node state
  const [newNodeFolder, setNewNodeFolder] = useState<string>("/architecture");
  const [newNodeTitle, setNewNodeTitle] = useState<string>("");
  const [newNodeContent, setNewNodeContent] = useState<string>("");
  const [newNodeConfidence, setNewNodeConfidence] = useState<number>(0.94);
  const [newNodeProvenanceUri, setNewNodeProvenanceUri] = useState<string>("omnia://sessions/session-a");

  // Edit Node state
  const [editingTitle, setEditingTitle] = useState<string>("");
  const [editingContent, setEditingContent] = useState<string>("");
  const [editingConfidence, setEditingConfidence] = useState<number>(0.95);
  const [isEditingNode, setIsEditingNode] = useState<boolean>(false);

  // Semantic Link builder state
  const [newLinkRelation, setNewLinkRelation] = useState<LtstSemanticRelation>("supports");
  const [newLinkTargetId, setNewLinkTargetId] = useState<string>("node-pref-strict-ts");
  const [newLinkRationale, setNewLinkRationale] = useState<string>("");

  // HippoRAG Multi-Hop Associative Query Bar state
  const [hippoRagQuery, setHippoRagQuery] = useState<string>("Immutable KV-Cache prefix ring");
  const [hippoRagMaxHops, setHippoRagMaxHops] = useState<number>(2);

  // Official Harness Studio state (all 9 official harnesses)
  const [activeHarnessId, setActiveHarnessId] = useState<OfficialHarnessFamilyId>(
    () => initialActiveHarnessId ?? loadPersistedHarnessStudioState()?.selectedHarnessId ?? "openai-gpt-codex",
  );
  const [harnessConfigs, setHarnessConfigs] = useState<Readonly<Record<OfficialHarnessFamilyId, HarnessRuntimeConfig>>>(
    () => loadPersistedHarnessStudioState()?.harnessConfigs ?? createDefaultHarnessConfigs(),
  );

  // Studio Tab & Local Uncensored AI Hardware Advisor state
  const [activeStudioTab, setActiveStudioTab] = useState<KnowledgeStudioTabId>("ltst-tree");
  const [activeSovereignArtifactTab, setActiveSovereignArtifactTab] =
    useState<SovereignArtifactTabId>("modelfile");

  const rankedUncensoredEvaluations = useMemo(
    () => recommendLocalModelsForHardware(DETECTED_ACER_NITRO_HARDWARE),
    [],
  );
  const [selectedUncensoredModelId, setSelectedUncensoredModelId] = useState<string>(
    () => rankedUncensoredEvaluations[0]?.model.id ?? "huihui-qwen2.5-coder-7b-abliterated-q4km",
  );
  const [sovereignSystemDirective, setSovereignSystemDirective] = useState<string>(
    DEFAULT_SOVEREIGN_DIRECT_SYSTEM_DIRECTIVE,
  );

  const selectedUncensoredModel: LocalUncensoredModelDescriptor = useMemo(
    () =>
      LOCAL_UNCENSORED_MODEL_CATALOG.find((m) => m.id === selectedUncensoredModelId) ??
      LOCAL_UNCENSORED_MODEL_CATALOG[0]!,
    [selectedUncensoredModelId],
  );

  const activeSovereignBlueprint = useMemo(
    () =>
      buildDirectSovereignCustomProviderBlueprint(
        selectedUncensoredModel,
        DETECTED_ACER_NITRO_HARDWARE,
        sovereignSystemDirective,
      ),
    [selectedUncensoredModel, sovereignSystemDirective],
  );

  const [statusBanner, setStatusBanner] = useState<string | null>(null);

  useEffect(() => {
    savePersistedLtstTree({ folders, nodes, semanticLinks });
  }, [folders, nodes, semanticLinks]);

  useEffect(() => {
    savePersistedHarnessStudioState({ selectedHarnessId: activeHarnessId, harnessConfigs });
  }, [activeHarnessId, harnessConfigs]);

  const filteredNodes = useMemo(
    () =>
      selectedFolderPath === "ALL"
        ? nodes
        : nodes.filter((node) => node.folderPath === selectedFolderPath),
    [nodes, selectedFolderPath],
  );

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? filteredNodes[0] ?? nodes[0],
    [nodes, selectedNodeId, filteredNodes],
  );

  const selectedNodeLinks = useMemo(() => {
    if (!selectedNode) return [];
    return semanticLinks.filter(
      (link) => link.sourceNodeId === selectedNode.id || link.targetNodeId === selectedNode.id,
    );
  }, [semanticLinks, selectedNode]);

  const hippoRagResult = useMemo(
    () =>
      queryHippoRagAssociativeGraph({
        query: hippoRagQuery,
        nodes,
        edges: semanticLinks,
        maxHops: hippoRagMaxHops,
        topK: 4,
      }),
    [hippoRagQuery, nodes, semanticLinks, hippoRagMaxHops],
  );

  const activeHarnessDescriptor = useMemo(
    () => harnessRegistry.resolve(activeHarnessId).descriptor(),
    [harnessRegistry, activeHarnessId],
  );

  const activeHarnessConfig = harnessConfigs[activeHarnessId];

  function handleCopyCodeArtifact(text: string, label: string): void {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).catch(() => undefined);
    }
    setStatusBanner(`Copied ${label} to clipboard.`);
  }

  function handleCreateFolder(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const rawPath = newFolderPath.trim();
    if (!rawPath) return;
    const normalizedPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    if (folders.some((f) => f.path === normalizedPath)) {
      setStatusBanner(`Folder ${normalizedPath} already exists.`);
      return;
    }
    const created: LtstKnowledgeFolder = {
      id: `folder-${normalizedPath.slice(1).replaceAll("/", "-")}`,
      path: normalizedPath,
      label: normalizedPath.slice(1),
      description: newFolderDescription.trim() || `Custom LTST knowledge folder at ${normalizedPath}`,
    };
    setFolders((prev) => [...prev, created]);
    setSelectedFolderPath(normalizedPath);
    setNewNodeFolder(normalizedPath);
    setNewFolderPath("");
    setNewFolderDescription("");
    setStatusBanner(`Created LTST folder ${normalizedPath}.`);
    onCreateFolder?.(created);
  }

  function handleCreateNode(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const title = newNodeTitle.trim();
    if (!title) return;
    const content = newNodeContent.trim() || title;
    const id = `node-${Date.now()}-${nodes.length + 1}`;
    const clampedConfidence = Math.min(1, Math.max(0, newNodeConfidence));
    const created: LtstKnowledgeNode = {
      id,
      folderPath: newNodeFolder,
      title,
      summary: content.slice(0, 120),
      content,
      confidence: clampedConfidence,
      provenanceUris: newNodeProvenanceUri.trim() ? [newNodeProvenanceUri.trim()] : ["omnia://sessions/session-a"],
      harnessId: activeHarnessId,
      updatedAt: "2026-10-18T16:15:00Z",
    };
    setNodes((prev) => [...prev, created]);
    setSelectedNodeId(created.id);
    setNewNodeTitle("");
    setNewNodeContent("");
    setStatusBanner(`Created LTST knowledge node "${created.title}" in ${created.folderPath}.`);
    onCreateNode?.(created);
  }

  function startEditingSelectedNode(node: LtstKnowledgeNode): void {
    setIsEditingNode(true);
    setEditingTitle(node.title);
    setEditingContent(node.content);
    setEditingConfidence(node.confidence);
  }

  function handleSaveNodeEdit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!selectedNode) return;
    const updated: LtstKnowledgeNode = {
      ...selectedNode,
      title: editingTitle.trim() || selectedNode.title,
      summary: (editingContent.trim() || selectedNode.content).slice(0, 120),
      content: editingContent.trim() || selectedNode.content,
      confidence: Math.min(1, Math.max(0, editingConfidence)),
      updatedAt: "2026-10-18T16:20:00Z",
    };
    setNodes((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    setIsEditingNode(false);
    setStatusBanner(`Updated LTST knowledge node "${updated.title}".`);
    onUpdateNode?.(updated);
  }

  function handleAddSemanticLink(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!selectedNode || !newLinkTargetId || selectedNode.id === newLinkTargetId) return;
    const createdLink: LtstSemanticLink = {
      id: `link-${semanticLinks.length + 1}`,
      sourceNodeId: selectedNode.id,
      targetNodeId: newLinkTargetId,
      relation: newLinkRelation,
      rationale:
        newLinkRationale.trim() ||
        `${selectedNode.title} ${newLinkRelation} ${newLinkTargetId}`,
    };
    setSemanticLinks((prev) => [...prev, createdLink]);
    setNewLinkRationale("");
    setStatusBanner(`Added semantic link (${createdLink.relation}) from ${selectedNode.id} to ${newLinkTargetId}.`);
  }

  function handleActivateHarness(harnessId: OfficialHarnessFamilyId): void {
    setActiveHarnessId(harnessId);
    const descriptor = harnessRegistry.resolve(harnessId).descriptor();
    setStatusBanner(`Activated official harness: ${descriptor.displayName} (${harnessId}).`);
    onSelectHarness?.(harnessId, descriptor);
  }

  function handleUpdateHarnessConfig(patch: Partial<HarnessRuntimeConfig>): void {
    setHarnessConfigs((prev) => ({
      ...prev,
      [activeHarnessId]: {
        ...prev[activeHarnessId],
        ...patch,
      },
    }));
    setStatusBanner(`Updated runtime configuration for ${activeHarnessId}.`);
  }

  function handleInjectNodeIntoChat(node: LtstKnowledgeNode): void {
    const storeState = useWorkspaceStore.getState();
    const targetId =
      activeConversationId || storeState.activeConversationId || storeState.conversations[0]?.id;
    if (!targetId) {
      setStatusBanner("No active conversation available for LTST node injection.");
      return;
    }
    const targetConv = storeState.conversations.find((c) => c.id === targetId);
    const existingDraft = targetConv?.draft ?? "";
    const formattedBlock = [
      `[LTST Knowledge Node: ${node.title}]`,
      `Folder: ${node.folderPath} | Confidence: ${Math.round(node.confidence * 100)}% | Harness: ${node.harnessId}`,
      `Summary: ${node.summary}`,
      `Content: ${node.content}`,
      `Provenance: ${node.provenanceUris.join(", ")}`,
    ].join("\n");
    const nextDraft = existingDraft.trim()
      ? `${existingDraft.trim()}\n\n${formattedBlock}`
      : formattedBlock;
    const updateDraftFn = storeState.updateDraft as unknown as (...args: string[]) => void;
    if (updateDraftFn.length >= 2) {
      updateDraftFn(targetId, nextDraft);
    } else {
      updateDraftFn(nextDraft);
      (updateDraft as unknown as (draft: string) => void)(nextDraft);
    }
    setStatusBanner(`Injected LTST node "${node.title}" into active chat draft (${targetId}).`);
  }

  function handleSelectUncensoredModel(modelId: string): void {
    setSelectedUncensoredModelId(modelId);
    const found = LOCAL_UNCENSORED_MODEL_CATALOG.find((m) => m.id === modelId);
    if (found) {
      setStatusBanner(
        `Selected uncensored local model: ${found.name} (${found.quantization}, ${found.fileSizeGb} GB) for ${DETECTED_ACER_NITRO_HARDWARE.gpuName}.`,
      );
    }
  }

  function handleApplyUncensoredProviderToChat(): void {
    const storeState = useWorkspaceStore.getState();
    const targetId =
      activeConversationId || storeState.activeConversationId || storeState.conversations[0]?.id;
    if (!targetId) {
      setStatusBanner("No active conversation available for custom provider blueprint injection.");
      return;
    }
    const targetConv = storeState.conversations.find((c) => c.id === targetId);
    const existingDraft = targetConv?.draft ?? "";
    const bp = activeSovereignBlueprint;
    const formattedBlock = [
      `[Direct Sovereign Uncensored Custom Provider: ${bp.model.name} (${bp.model.quantization})]`,
      `Host Hardware: ${bp.hardware.machineModel} · ${bp.hardware.cpuName} (${bp.hardware.cpuCores}C/${bp.hardware.cpuThreads}T) · ${bp.hardware.systemRamGb} GB DDR4 · ${bp.hardware.gpuName} (${bp.hardware.gpuVramMiB} MiB VRAM)`,
      `Storage Path: ${bp.hardware.preferredModelStorageDir} | Endpoint: ${bp.customProviderConfig.baseUrl} | Alias: ${bp.sovereignModelAlias}`,
      `Hardware Fit: ${bp.fit.fitScore}/100 (${bp.fit.executionTier}) | GPU Offload: ${bp.fit.gpuOffloadLayers}/${bp.fit.totalLayers} layers | Speed: ~${bp.fit.estimatedTokPerSec} tok/s`,
      `Ollama Pull: ollama run ${bp.model.ollamaPullTag}`,
      `Sovereign System Directive: ${bp.systemDirective}`,
      `Gateway Config: ${bp.customProviderConfigJson}`,
    ].join("\n");
    const nextDraft = existingDraft.trim()
      ? `${existingDraft.trim()}\n\n${formattedBlock}`
      : formattedBlock;
    const updateDraftFn = storeState.updateDraft as unknown as (...args: string[]) => void;
    if (updateDraftFn.length >= 2) {
      updateDraftFn(targetId, nextDraft);
    } else {
      updateDraftFn(nextDraft);
      (updateDraft as unknown as (draft: string) => void)(nextDraft);
    }
    setStatusBanner(
      `Applied Direct Sovereign Custom Provider "${bp.model.name}" (${bp.sovereignModelAlias}) to active chat draft (${targetId}).`,
    );
  }

  return (
    <section
      className="knowledge-tree-explorer sw-devtools-shell"
      aria-label="LTST Hierarchical Knowledge Tree & Official Harness Studio"
      data-testid="knowledge-tree-explorer"
      data-active-studio-tab={activeStudioTab}
    >
      {/* Top 32px Single-Line Studio Tab Strip & Active Harness Badge (.sw-topbar) */}
      <header className="knowledge-tree-explorer__header sw-topbar">
        <div className="sw-topbar__left">
          <nav
            className="knowledge-tree-explorer__studio-tabs sw-tabstrip"
            role="tablist"
            aria-label="Knowledge, Harness & Local Uncensored AI Studios"
            data-testid="knowledge-studio-tabs"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeStudioTab === "ltst-tree"}
              aria-pressed={activeStudioTab === "ltst-tree"}
              className={`sw-tabstrip__btn ${activeStudioTab === "ltst-tree" ? "is-active" : ""}`}
              onClick={() => setActiveStudioTab("ltst-tree")}
              data-tooltip="Hierarchical LTST Folders, Nodes & Semantic Graph"
              data-testid="tab-ltst-tree"
            >
              <FolderTree size={13} /> <span>LTST Hierarchical Knowledge Tree</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeStudioTab === "official-harnesses"}
              aria-pressed={activeStudioTab === "official-harnesses"}
              className={`sw-tabstrip__btn ${activeStudioTab === "official-harnesses" ? "is-active" : ""}`}
              onClick={() => setActiveStudioTab("official-harnesses")}
              data-tooltip="Configure All 9 Official Harness Adapters"
              data-testid="tab-official-harnesses"
            >
              <Sliders size={13} /> <span>9 Official Harness Adapters Studio</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeStudioTab === "uncensored-local-ai"}
              aria-pressed={activeStudioTab === "uncensored-local-ai"}
              className={`sw-tabstrip__btn ${activeStudioTab === "uncensored-local-ai" ? "is-active" : ""}`}
              onClick={() => setActiveStudioTab("uncensored-local-ai")}
              data-tooltip="Acer Nitro GTX 1650 Ti (4096 MiB VRAM) Uncensored Local AI Advisor"
              data-testid="tab-uncensored-local-ai"
            >
              <Cpu size={13} /> <span>Local Uncensored AI &amp; Hardware Studio (GTX 1650 Ti)</span>
            </button>
          </nav>
        </div>

        <div className="knowledge-tree-explorer__summary sw-topbar__telemetry">
          <span className="sr-only" data-testid="ltst-folder-count">{folders.length} Folders</span>
          <span className="sr-only" data-testid="ltst-node-count">{nodes.length} Knowledge Nodes</span>
          <span className="sr-only" data-testid="ltst-link-count">{semanticLinks.length} Semantic Links</span>
          <span className="sw-badge" data-testid="active-harness-badge" data-tooltip="Currently Active Harness Adapter">
            <Cpu size={12} /> <code>{activeHarnessId}</code>
          </span>
        </div>
      </header>

      {/* HippoRAG Multi-Hop Associative Query Bar (Collapsible Drawer so main studio is uncluttered) */}
      <details
        className="knowledge-tree-explorer__hipporag-bar sw-accordion"
        data-testid="hipporag-query-bar"
        role="region"
        aria-label="HippoRAG Multi-Hop Associative Memory Query Bar"
      >
        <summary className="sw-accordion__summary" data-tooltip="HippoRAG 2 Personalized PageRank Associative Recall">
          <div className="sw-hipporag-controls">
            <span>
              <Network size={13} /> <strong>HippoRAG Associative Search</strong>
            </span>
            <span className="sw-hipporag-summary" data-testid="hipporag-ppr-summary">
              <Search size={12} /> {hippoRagResult.multiHopEdgesTraversed} edges · Top PPR:{" "}
              <code>{hippoRagResult.rankedNodes[0]?.nodeId ?? "none"}</code> (
              {hippoRagResult.rankedNodes[0]?.pprScore.toFixed(2) ?? "0.00"})
            </span>
          </div>
        </summary>

        <div className="sw-accordion__body">
          <div className="sw-hipporag-controls">
            <label htmlFor="hipporag-query-input" className="sr-only">
              HippoRAG Associative Recall
            </label>
            <input
              id="hipporag-query-input"
              type="text"
              placeholder="Query LTST graph with multi-hop Personalized PageRank..."
              value={hippoRagQuery}
              onChange={(e) => setHippoRagQuery(e.target.value)}
              data-testid="hipporag-query-input"
              style={{ flex: "1 1 240px" }}
            />
            <label data-tooltip="Maximum Associative PageRank Hops">
              Hops
              <select
                aria-label="HippoRAG Max Hops"
                value={hippoRagMaxHops}
                onChange={(e) => setHippoRagMaxHops(Number(e.target.value) || 2)}
                data-testid="hipporag-hops-select"
              >
                <option value={1}>1-Hop</option>
                <option value={2}>2-Hop PPR</option>
                <option value={3}>3-Hop Deep</option>
              </select>
            </label>
          </div>

          <div className="sw-hipporag-pills" data-testid="hipporag-results-list">
            {hippoRagResult.rankedNodes.map((ranked) => (
              <button
                key={ranked.nodeId}
                type="button"
                onClick={() => {
                  setSelectedNodeId(ranked.nodeId);
                  setIsEditingNode(false);
                }}
                className="sw-hipporag-pill"
                data-tooltip={`Path: ${ranked.associativePath.join(" -> ")} (${ranked.hopDistance} hop)`}
                data-testid={`hipporag-result-btn-${ranked.nodeId}`}
              >
                <code>{ranked.folderPath}</code> <strong>{ranked.title}</strong>{" "}
                <span>PPR {ranked.pprScore.toFixed(2)}</span>
              </button>
            ))}
          </div>
        </div>
      </details>

      {statusBanner ? (
        <div role="status" className="knowledge-tree-explorer__status-banner sw-status-banner" data-testid="ltst-status-banner">
          <CheckCircle2 size={14} /> {statusBanner}
        </div>
      ) : null}

      {/* STUDIO 1: Clean 3-Column IDE Split (200px Folders | 300px Nodes | Flexible Node Inspector & Semantic Graph) */}
      <div
        className={`knowledge-tree-explorer__main-grid sw-layer-section ${activeStudioTab === "ltst-tree" ? "is-active-studio" : ""}`}
      >
        {/* Column 1 (200px): Folder Tree + Collapsible Create Folder Drawer */}
        <aside className="knowledge-tree-explorer__folders" data-testid="ltst-folder-tree">
          <h3>
            <FolderTree size={14} /> LTST Folders
          </h3>
          <ul role="tree" aria-label="LTST Knowledge Folders">
            <li>
              <button
                type="button"
                onClick={() => setSelectedFolderPath("ALL")}
                data-testid="folder-filter-all"
                aria-pressed={selectedFolderPath === "ALL"}
              >
                All Folders ({nodes.length})
              </button>
            </li>
            {folders.map((folder) => {
              const count = nodes.filter((n) => n.folderPath === folder.path).length;
              const isSelected = selectedFolderPath === folder.path;
              return (
                <li key={folder.id} role="treeitem" aria-selected={isSelected}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedFolderPath(folder.path);
                      setNewNodeFolder(folder.path);
                    }}
                    data-tooltip={folder.description}
                    data-testid={`folder-item-${folder.path}`}
                  >
                    <code>{folder.path}</code> ({count})
                  </button>
                </li>
              );
            })}
          </ul>

          <details className="sw-accordion">
            <summary className="sw-accordion__summary" data-tooltip="Create New Hierarchical LTST Folder">
              <FolderPlus size={13} /> <span>+ New Folder</span>
            </summary>
            <form onSubmit={handleCreateFolder} data-testid="create-folder-form" className="sw-accordion__body">
              <label htmlFor="new-ltst-folder-path">Folder Path</label>
              <input
                id="new-ltst-folder-path"
                type="text"
                placeholder="/architecture/kv-cache"
                value={newFolderPath}
                onChange={(event) => setNewFolderPath(event.target.value)}
                data-testid="new-folder-path-input"
              />
              <label htmlFor="new-ltst-folder-desc">Description</label>
              <input
                id="new-ltst-folder-desc"
                type="text"
                placeholder="Folder description"
                value={newFolderDescription}
                onChange={(event) => setNewFolderDescription(event.target.value)}
                data-testid="new-folder-desc-input"
              />
              <button type="submit" data-testid="create-folder-btn">
                Create Folder
              </button>
            </form>
          </details>
        </aside>

        {/* Column 2 (300px): Knowledge Node List + Collapsible Create Node Drawer */}
        <div className="knowledge-tree-explorer__nodes" data-testid="ltst-node-list">
          <h3>Knowledge Nodes ({filteredNodes.length})</h3>
          <ul>
            {filteredNodes.map((node) => {
              const confidencePct = Math.round(node.confidence * 100);
              const isSelected = selectedNode?.id === node.id;
              return (
                <li
                  key={node.id}
                  className={`knowledge-tree-explorer__node-card ${isSelected ? "is-selected" : ""}`}
                  data-testid={`knowledge-node-card-${node.id}`}
                >
                  <div className="knowledge-tree-explorer__node-card-header">
                    <code>{node.folderPath}</code>
                    <strong>{node.title}</strong>
                    <span data-testid={`node-confidence-label-${node.id}`}>{confidencePct}% confidence</span>
                  </div>

                  <div
                    role="progressbar"
                    aria-label={`Confidence score for ${node.title}`}
                    aria-valuenow={confidencePct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className="knowledge-tree-explorer__confidence-bar"
                    data-testid={`node-confidence-bar-${node.id}`}
                  >
                    <div
                      className="knowledge-tree-explorer__confidence-fill"
                      style={{ width: `${confidencePct}%` }}
                    />
                  </div>

                  <p>{node.summary}</p>

                  <div className="knowledge-tree-explorer__node-card-footer">
                    <span>Harness: <code>{node.harnessId}</code></span>
                    <span>Provenance: {node.provenanceUris.join(", ")}</span>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedNodeId(node.id);
                        setIsEditingNode(false);
                      }}
                      data-testid={`select-node-btn-${node.id}`}
                    >
                      Inspect Node
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          <details className="sw-accordion">
            <summary className="sw-accordion__summary" data-tooltip="Create Typed LTST Knowledge Node">
              <PlusCircle size={13} /> <span>+ New Knowledge Node</span>
            </summary>
            <form onSubmit={handleCreateNode} data-testid="create-node-form" className="sw-accordion__body">
              <label htmlFor="new-node-folder-select">Target Folder</label>
              <select
                id="new-node-folder-select"
                value={newNodeFolder}
                onChange={(event) => setNewNodeFolder(event.target.value)}
                data-testid="new-node-folder-select"
              >
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.path}>
                    {folder.path}
                  </option>
                ))}
              </select>

              <label htmlFor="new-node-title-input">Node Title</label>
              <input
                id="new-node-title-input"
                type="text"
                placeholder="e.g. Zero-Copy Prefix Breakpoint Policy"
                value={newNodeTitle}
                onChange={(event) => setNewNodeTitle(event.target.value)}
                data-testid="new-node-title-input"
              />

              <label htmlFor="new-node-content-input">Node Content</label>
              <textarea
                id="new-node-content-input"
                placeholder="Detailed semantic knowledge content..."
                value={newNodeContent}
                onChange={(event) => setNewNodeContent(event.target.value)}
                data-testid="new-node-content-input"
              />

              <label htmlFor="new-node-confidence-input">Confidence (0.0 - 1.0)</label>
              <input
                id="new-node-confidence-input"
                type="number"
                step="0.01"
                min="0"
                max="1"
                value={newNodeConfidence}
                onChange={(event) => setNewNodeConfidence(Number(event.target.value))}
                data-testid="new-node-confidence-input"
              />

              <label htmlFor="new-node-provenance-input">Provenance Session URI</label>
              <input
                id="new-node-provenance-input"
                type="text"
                value={newNodeProvenanceUri}
                onChange={(event) => setNewNodeProvenanceUri(event.target.value)}
                data-testid="new-node-provenance-input"
              />

              <button type="submit" data-testid="create-node-btn">
                Create Knowledge Node
              </button>
            </form>
          </details>
        </div>

        {/* Column 3 (Flexible): Selected Node Inspector, Editor, Provenance & Semantic Links */}
        <aside className="knowledge-tree-explorer__inspector" data-testid="ltst-node-inspector">
          {selectedNode ? (
            <div>
              <div className="knowledge-tree-explorer__inspector-header">
                <h3>Inspected LTST Node: {selectedNode.title}</h3>
                <div className="sw-inspector-actions">
                  <button
                    type="button"
                    onClick={() => startEditingSelectedNode(selectedNode)}
                    data-testid="edit-selected-node-btn"
                    data-tooltip="Edit Selected Knowledge Node"
                  >
                    <Edit3 size={13} /> Edit Node
                  </button>
                  <button
                    type="button"
                    onClick={() => handleInjectNodeIntoChat(selectedNode)}
                    data-testid="ltst-inject-node-into-chat-btn"
                    data-tooltip="Inject Knowledge Node into Active Chat Composer"
                  >
                    <MessageSquarePlus size={13} /> Inject Node into Active Chat
                  </button>
                </div>
              </div>

              <dl>
                <dt>Node ID</dt>
                <dd data-testid="inspected-ltst-node-id">{selectedNode.id}</dd>
                <dt>Folder Path</dt>
                <dd data-testid="inspected-ltst-node-folder">
                  <code>{selectedNode.folderPath}</code>
                </dd>
                <dt>Confidence Score</dt>
                <dd data-testid="inspected-ltst-node-confidence">
                  {Math.round(selectedNode.confidence * 100)}%
                </dd>
                <dt>Content</dt>
                <dd data-testid="inspected-ltst-node-content">{selectedNode.content}</dd>
              </dl>

              {isEditingNode ? (
                <form onSubmit={handleSaveNodeEdit} data-testid="edit-node-form">
                  <h4>Edit Knowledge Node</h4>
                  <label htmlFor="edit-node-title-input">Edit Title</label>
                  <input
                    id="edit-node-title-input"
                    type="text"
                    value={editingTitle}
                    onChange={(event) => setEditingTitle(event.target.value)}
                    data-testid="edit-node-title-input"
                  />
                  <label htmlFor="edit-node-content-input">Edit Content</label>
                  <textarea
                    id="edit-node-content-input"
                    value={editingContent}
                    onChange={(event) => setEditingContent(event.target.value)}
                    data-testid="edit-node-content-input"
                  />
                  <label htmlFor="edit-node-confidence-input">Edit Confidence</label>
                  <input
                    id="edit-node-confidence-input"
                    type="number"
                    step="0.01"
                    min="0"
                    max="1"
                    value={editingConfidence}
                    onChange={(event) => setEditingConfidence(Number(event.target.value))}
                    data-testid="edit-node-confidence-input"
                  />
                  <button type="submit" data-testid="save-node-edit-btn">
                    Save Node Changes
                  </button>
                </form>
              ) : null}

              <div className="knowledge-tree-explorer__provenance" data-testid="inspected-node-provenance">
                <h4>
                  <Link2 size={14} /> Session Provenance Links ({selectedNode.provenanceUris.length})
                </h4>
                <ul>
                  {selectedNode.provenanceUris.map((uri) => (
                    <li key={uri}>
                      <code>{uri}</code>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="knowledge-tree-explorer__semantic-links" data-testid="inspected-node-semantic-links">
                <h4>
                  <GitCompareArrows size={14} /> Semantic Links (<code>supports</code> · <code>contradicts</code> · <code>derived-from</code> · <code>supersedes</code>)
                </h4>
                <ul>
                  {selectedNodeLinks.map((link) => (
                    <li key={link.id} data-testid={`semantic-link-${link.id}`}>
                      <span className={`semantic-relation-badge relation-${link.relation}`}>
                        {link.relation}
                      </span>{" "}
                      <code>{link.sourceNodeId}</code> -&gt; <code>{link.targetNodeId}</code>
                      <p>{link.rationale}</p>
                    </li>
                  ))}
                </ul>

                <details className="sw-accordion">
                  <summary className="sw-accordion__summary" data-tooltip="Add Typed Semantic Edge Between LTST Nodes">
                    <GitCompareArrows size={13} /> <span>+ Add Semantic Link</span>
                  </summary>
                  <form onSubmit={handleAddSemanticLink} data-testid="add-semantic-link-form" className="sw-accordion__body">
                    <label htmlFor="semantic-relation-select">Relation</label>
                    <select
                      id="semantic-relation-select"
                      value={newLinkRelation}
                      onChange={(event) => setNewLinkRelation(event.target.value as LtstSemanticRelation)}
                      data-testid="semantic-relation-select"
                    >
                      {LTST_SEMANTIC_RELATIONS.map((rel) => (
                        <option key={rel} value={rel}>
                          {rel}
                        </option>
                      ))}
                    </select>

                    <label htmlFor="semantic-target-select">Target Node</label>
                    <select
                      id="semantic-target-select"
                      value={newLinkTargetId}
                      onChange={(event) => setNewLinkTargetId(event.target.value)}
                      data-testid="semantic-target-select"
                    >
                      {nodes
                        .filter((n) => n.id !== selectedNode.id)
                        .map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.title} ({n.id})
                          </option>
                        ))}
                    </select>

                    <input
                      type="text"
                      placeholder="Semantic link rationale"
                      value={newLinkRationale}
                      onChange={(event) => setNewLinkRationale(event.target.value)}
                      data-testid="semantic-rationale-input"
                    />

                    <button type="submit" data-testid="add-semantic-link-btn">
                      Add Semantic Link
                    </button>
                  </form>
                </details>
              </div>
            </div>
          ) : null}
        </aside>
      </div>

      {/* STUDIO 2: 9 Official Harnesses (Compact Selector Grid on Left + Focused Active Harness Inspector on Right) */}
      <section
        className={`knowledge-tree-explorer__harness-studio sw-layer-section ${activeStudioTab === "official-harnesses" ? "is-active-studio" : ""}`}
        aria-label="9 Official Harness Adapters Studio"
        data-testid="official-harness-studio"
      >
        <div className="sw-harness-split">
          <div className="knowledge-tree-explorer__harness-cards" data-testid="official-harness-catalog">
            {harnessDescriptors.map((descriptor) => {
              const familyId = descriptor.id as OfficialHarnessFamilyId;
              const isActive = familyId === activeHarnessId;
              return (
                <article
                  key={descriptor.id}
                  className={`knowledge-tree-explorer__harness-card ${isActive ? "is-active" : ""}`}
                  data-testid={`harness-card-${descriptor.id}`}
                >
                  <header>
                    <strong>{descriptor.displayName}</strong>
                    <code>{descriptor.id}</code>
                  </header>
                  <p>{descriptor.architectureSummary}</p>
                  <div className="knowledge-tree-explorer__harness-meta">
                    <span>Model: <code>{descriptor.defaultModelId}</code></span>
                    <span>Target: {descriptor.targetThroughputTokPerSec} tok/s</span>
                    <span>URI: <code>{descriptor.uriScheme}://</code></span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleActivateHarness(familyId)}
                    data-testid={`activate-harness-btn-${descriptor.id}`}
                    data-tooltip={`Activate ${descriptor.displayName}`}
                    aria-pressed={isActive}
                  >
                    {isActive ? "Active Harness" : "Activate Harness"}
                  </button>
                </article>
              );
            })}
          </div>

          <div
            className="knowledge-tree-explorer__active-harness-detail"
            data-testid="active-harness-detail"
          >
            <h4>
              <ShieldCheck size={15} /> Active Harness Configuration: {activeHarnessDescriptor.displayName} (
              <code>{activeHarnessDescriptor.id}</code>)
            </h4>
            <dl>
              <dt>Protocol Family</dt>
              <dd data-testid="active-harness-protocol">{activeHarnessDescriptor.protocolFamily}</dd>
              <dt>KV-Cache Strategy</dt>
              <dd data-testid="active-harness-kv-strategy">{activeHarnessDescriptor.kvCacheStrategy}</dd>
              <dt>Memory Integration Mode</dt>
              <dd data-testid="active-harness-memory-mode">{activeHarnessDescriptor.memoryIntegrationMode}</dd>
              <dt>Pinned Source Repository</dt>
              <dd data-testid="active-harness-source-repo">
                <code>{activeHarnessDescriptor.sources[0]?.repository}</code> @{" "}
                <code>{activeHarnessDescriptor.sources[0]?.revision.slice(0, 12)}</code>
              </dd>
            </dl>

            <div className="knowledge-tree-explorer__harness-controls">
              <label>
                <input
                  type="checkbox"
                  checked={activeHarnessConfig.kvCacheBreakpointsEnabled}
                  onChange={(event) =>
                    handleUpdateHarnessConfig({ kvCacheBreakpointsEnabled: event.target.checked })
                  }
                  data-testid="harness-kv-cache-toggle"
                />
                Enable Deterministic KV-Cache Prefix Breakpoints
              </label>

              <label>
                LTST Retrieval Token Budget
                <input
                  type="number"
                  min={512}
                  max={65536}
                  step={512}
                  value={activeHarnessConfig.ltstTokenBudget}
                  onChange={(event) =>
                    handleUpdateHarnessConfig({ ltstTokenBudget: Number(event.target.value) || 4096 })
                  }
                  data-testid="harness-ltst-budget-input"
                />
              </label>

              <label>
                <input
                  type="checkbox"
                  checked={activeHarnessConfig.autoDistillSkills}
                  onChange={(event) =>
                    handleUpdateHarnessConfig({ autoDistillSkills: event.target.checked })
                  }
                  data-testid="harness-auto-distill-toggle"
                />
                Auto-Distill Completed Trajectories into <code>/learned-skills</code>
              </label>
            </div>

            <details open className="sw-accordion">
              <summary className="sw-accordion__summary">
                <Sparkles size={13} />{" "}
                <span>
                  Verified Capabilities ({activeHarnessDescriptor.capabilities.filter((c) => c.available).length} enabled)
                </span>
              </summary>
              <ul className="sw-accordion__body">
                {activeHarnessDescriptor.capabilities.map((cap) => (
                  <li key={cap.capability}>
                    <code>{cap.capability}</code>: {cap.available ? "available" : "unavailable"} ({cap.evidence})
                  </li>
                ))}
              </ul>
            </details>
          </div>
        </div>
      </section>

      {/* STUDIO 3: Local Uncensored AI & Hardware Studio (GTX 1650 Ti · 4096 MiB VRAM · D:\Omnia\models) */}
      <section
        className={`knowledge-tree-explorer__uncensored-studio sw-layer-section ${activeStudioTab === "uncensored-local-ai" ? "is-active-studio" : ""}`}
        aria-label="Local Uncensored AI & Hardware Studio (GTX 1650 Ti)"
        data-testid="uncensored-local-ai-studio"
      >
        {/* Compact Hardware Telemetry Bar at Top */}
        <header className="knowledge-tree-explorer__uncensored-header sw-hardware-telemetry-bar">
          <div
            className="knowledge-tree-explorer__hardware-banner"
            data-testid="detected-host-hardware-banner"
          >
            <Cpu size={14} /> <strong>Host Hardware Telemetry:</strong>{" "}
            <span>
              {DETECTED_ACER_NITRO_HARDWARE.machineModel} · Intel i5-10300H (
              {DETECTED_ACER_NITRO_HARDWARE.cpuCores}C/{DETECTED_ACER_NITRO_HARDWARE.cpuThreads}T ·{" "}
              {DETECTED_ACER_NITRO_HARDWARE.cpuName}) · {DETECTED_ACER_NITRO_HARDWARE.systemRamGb} GB
              DDR4 · NVIDIA GTX 1650 Ti ({DETECTED_ACER_NITRO_HARDWARE.gpuName} ·{" "}
              {DETECTED_ACER_NITRO_HARDWARE.gpuVramMiB} MiB VRAM) ·{" "}
              <code>{DETECTED_ACER_NITRO_HARDWARE.preferredModelStorageDir}</code> (324.8 GB Free)
            </span>
          </div>
        </header>

        <div className="sw-uncensored-split">
          {/* Left Column: Clean 6-Model Comparison Cards */}
          <div
            className="knowledge-tree-explorer__uncensored-cards"
            data-testid="uncensored-model-catalog"
          >
            {rankedUncensoredEvaluations.map((evaluation, index) => {
              const { model } = evaluation;
              const isSelected = model.id === selectedUncensoredModel.id;
              return (
                <article
                  key={model.id}
                  className={`knowledge-tree-explorer__uncensored-card ${isSelected ? "is-selected" : ""}`}
                  data-testid={`uncensored-model-card-${model.id}`}
                >
                  <header>
                    <span>#{index + 1} Fit</span>
                    <strong>{model.name}</strong>
                    <code>
                      {model.quantization} · {model.fileSizeGb} GB
                    </code>
                  </header>
                  <p>{model.description}</p>
                  <div className="knowledge-tree-explorer__uncensored-metrics">
                    <span data-testid={`uncensored-model-fit-score-${model.id}`}>
                      Fit Score: <strong>{evaluation.fitScore}/100</strong> ({evaluation.executionTier})
                    </span>
                    <span data-testid={`uncensored-model-layers-${model.id}`}>
                      GPU Layers: <code>{evaluation.gpuOffloadLayers} / {evaluation.totalLayers}</code> (
                      {evaluation.vramAllocatedMiB} MiB VRAM + {evaluation.ramAllocatedMiB} MiB RAM)
                    </span>
                    <span data-testid={`uncensored-model-speed-${model.id}`}>
                      Est. Throughput: <strong>~{evaluation.estimatedTokPerSec} tok/s</strong>
                    </span>
                    <span>
                      Ollama Tag: <code>ollama run {model.ollamaPullTag}</code>
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleSelectUncensoredModel(model.id)}
                    data-testid={`select-uncensored-model-btn-${model.id}`}
                    aria-pressed={isSelected}
                  >
                    {isSelected ? "Selected Uncensored Model" : "Select Model & Build Blueprint"}
                  </button>
                </article>
              );
            })}
          </div>

          {/* Right Column: Sovereign Custom Provider Blueprint with Tabbed/Collapsible Code Drawers */}
          <div
            className="knowledge-tree-explorer__sovereign-blueprint"
            data-testid="sovereign-custom-provider-blueprint"
          >
            <div className="knowledge-tree-explorer__sovereign-blueprint-header">
              <h4>
                Direct Sovereign Custom Provider:{" "}
                <code>{activeSovereignBlueprint.sovereignModelAlias}</code> (Zero-Refusal Pass-Through)
              </h4>
              <button
                type="button"
                onClick={handleApplyUncensoredProviderToChat}
                data-testid="apply-uncensored-provider-to-chat-btn"
                data-tooltip="Inject Direct Custom Provider Blueprint into Active Chat"
              >
                <MessageSquarePlus size={14} /> Apply Direct Custom Provider to Active Chat
              </button>
            </div>

            <div className="knowledge-tree-explorer__sovereign-directive-editor">
              <label htmlFor="sovereign-system-directive-input">
                Sovereign Direct System Instruction (Injected into Modelfile &amp; Custom Provider Gateway)
              </label>
              <textarea
                id="sovereign-system-directive-input"
                rows={2}
                value={sovereignSystemDirective}
                onChange={(event) => setSovereignSystemDirective(event.target.value)}
                data-testid="sovereign-system-directive-input"
              />
            </div>

            {/* Artifact Switcher Tabstrip */}
            <div className="sw-tabstrip" role="tablist" aria-label="Sovereign Blueprint Code Artifacts">
              <button
                type="button"
                role="tab"
                aria-selected={activeSovereignArtifactTab === "powershell"}
                className={`sw-tabstrip__btn ${activeSovereignArtifactTab === "powershell" ? "is-active" : ""}`}
                onClick={() => setActiveSovereignArtifactTab("powershell")}
                data-tooltip="1-Click PowerShell Installer & Runner (D:\Omnia\models)"
              >
                <Terminal size={13} /> <span>1-Click PowerShell</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeSovereignArtifactTab === "modelfile"}
                className={`sw-tabstrip__btn ${activeSovereignArtifactTab === "modelfile" ? "is-active" : ""}`}
                onClick={() => setActiveSovereignArtifactTab("modelfile")}
                data-tooltip="Hardware-Tuned Ollama Modelfile"
              >
                <Cpu size={13} /> <span>Ollama Modelfile</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeSovereignArtifactTab === "llamacpp"}
                className={`sw-tabstrip__btn ${activeSovereignArtifactTab === "llamacpp" ? "is-active" : ""}`}
                onClick={() => setActiveSovereignArtifactTab("llamacpp")}
                data-tooltip="Direct llama-server.exe CLI Command"
              >
                <Sliders size={13} /> <span>llama-server CLI</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeSovereignArtifactTab === "provider-json"}
                className={`sw-tabstrip__btn ${activeSovereignArtifactTab === "provider-json" ? "is-active" : ""}`}
                onClick={() => setActiveSovereignArtifactTab("provider-json")}
                data-tooltip="Omnia Custom Provider Gateway JSON"
              >
                <ShieldCheck size={13} /> <span>Provider JSON</span>
              </button>
            </div>

            {/* Collapsible Code Drawers with 1-Click Copy (kept mounted in DOM for instant inspection) */}
            <div className="knowledge-tree-explorer__sovereign-code-grid">
              <details
                open={activeSovereignArtifactTab === "powershell"}
                className="sw-accordion"
              >
                <summary className="sw-accordion__summary">
                  <span>
                    1-Click PowerShell Installer &amp; Runner (<code>D:\Omnia\models</code>)
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      handleCopyCodeArtifact(
                        activeSovereignBlueprint.powershellInstallAndRunScript,
                        "PowerShell Installer Script",
                      );
                    }}
                    data-tooltip="Copy PowerShell Script"
                  >
                    <Copy size={12} /> Copy
                  </button>
                </summary>
                <pre data-testid="sovereign-powershell-script" className="sw-accordion__body">
                  {activeSovereignBlueprint.powershellInstallAndRunScript}
                </pre>
              </details>

              <details
                open={activeSovereignArtifactTab === "modelfile"}
                className="sw-accordion"
              >
                <summary className="sw-accordion__summary">
                  <span>
                    Hardware-Tuned Ollama <code>Modelfile</code> (
                    <code>num_gpu {activeSovereignBlueprint.fit.gpuOffloadLayers}</code> ·{" "}
                    <code>num_thread {activeSovereignBlueprint.hardware.cpuThreads}</code>)
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      handleCopyCodeArtifact(
                        activeSovereignBlueprint.ollamaModelfile,
                        "Ollama Modelfile",
                      );
                    }}
                    data-tooltip="Copy Ollama Modelfile"
                  >
                    <Copy size={12} /> Copy
                  </button>
                </summary>
                <pre data-testid="sovereign-ollama-modelfile" className="sw-accordion__body">
                  {activeSovereignBlueprint.ollamaModelfile}
                </pre>
              </details>

              <details
                open={activeSovereignArtifactTab === "llamacpp"}
                className="sw-accordion"
              >
                <summary className="sw-accordion__summary">
                  <span>
                    Direct <code>llama-server.exe</code> CLI Command (Flash Attention + GGUF Offload)
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      handleCopyCodeArtifact(
                        activeSovereignBlueprint.llamaCppServerCommand,
                        "llama-server.exe CLI Command",
                      );
                    }}
                    data-tooltip="Copy llama-server CLI Command"
                  >
                    <Copy size={12} /> Copy
                  </button>
                </summary>
                <pre data-testid="sovereign-llamacpp-command" className="sw-accordion__body">
                  {activeSovereignBlueprint.llamaCppServerCommand}
                </pre>
              </details>

              <details
                open={activeSovereignArtifactTab === "provider-json"}
                className="sw-accordion"
              >
                <summary className="sw-accordion__summary">
                  <span>Omnia Custom Provider Gateway Config (Raw Zero-Filter Pass-Through)</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      handleCopyCodeArtifact(
                        activeSovereignBlueprint.customProviderConfigJson,
                        "Custom Provider JSON",
                      );
                    }}
                    data-tooltip="Copy Custom Provider JSON"
                  >
                    <Copy size={12} /> Copy
                  </button>
                </summary>
                <pre data-testid="sovereign-provider-config-json" className="sw-accordion__body">
                  {activeSovereignBlueprint.customProviderConfigJson}
                </pre>
              </details>
            </div>
          </div>
        </div>
      </section>
    </section>
  );
}

export default KnowledgeTreeExplorer;
