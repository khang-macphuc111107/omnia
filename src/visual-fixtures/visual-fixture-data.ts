import {
  initialArtifacts,
  initialConversations,
  initialMemories,
  initialProjects,
  initialProviders,
  initialSkills,
} from "@/features/workspace/mock-data";
import type { CitationView, RunTimelineEventView } from "@/features/workspace/evidence-types";
import type {
  ActiveRunView,
  ArtifactView,
  AttachmentView,
  ConversationView,
  MemoryView,
  ProjectView,
  ProviderView,
  SkillView,
} from "@/features/workspace/types";

import type { VisualLocaleId, VisualStateId } from "./visual-scenario";

const FIXTURE_TIMESTAMP = "2026-08-13T08:45:00.000Z";
const FIXTURE_RUN_ID = "run-visual-fixture";
const FIXTURE_ASSISTANT_MESSAGE_ID = "message-visual-fixture-assistant";

const LONG_VIETNAMESE_ANSWER = `## Khung đánh giá có thể kiểm chứng

Một hệ thống chất lượng cao cần tách rõ **dữ kiện**, **suy luận**, **giới hạn**, và **bước kiểm chứng tiếp theo**. Phần giải thích không được làm mất điều kiện biên chỉ vì chúng nằm ở giữa ngữ cảnh dài.

1. Chụp yêu cầu hiện tại và mọi sửa đổi mới nhất thành dữ kiện có phiên bản.
2. Giữ nguyên nguồn gốc của từng đoạn tài liệu, công thức, đoạn mã, và kết quả thử nghiệm.
3. Ưu tiên nhóm phụ thuộc hoàn chỉnh thay vì giữ một câu trả lời nhưng bỏ câu hỏi hoặc bằng chứng tạo ra nó.
4. Đặt yêu cầu hiện tại ở phần cuối có chủ đích để giảm lost-in-the-middle.
5. Công bố phần bị lược bỏ, độ tin cậy, và lý do chưa thể xác minh.

Tên tệp dài để kiểm tra wrapping: \`bao-cao-nghien-cuu-khoa-hoc-va-thiet-ke-he-thong-omnia-phien-ban-kiem-thu-thi-giac-2026.md\`.

Chuỗi không ngắt để kiểm tra overflow: \`OMNIA_VISUAL_FIXTURE_SUPERCALIFRAGILISTICEXPIALIDOCIOUS_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ\`.

> Trạng thái phải luôn có nhãn văn bản, không phụ thuộc riêng vào màu sắc hoặc biểu tượng.`;

const RTL_TEST_ANSWER = `## اختبار اتجاه النص والمحتوى المختلط

هذا نص تجريبي طويل لاختبار الالتفاف، ترتيب التركيز، وعرض المراجع بجوار نص لاتيني مثل Omnia 0.1.0 و C++ و Python.

- يجب ألا يختفي عنوان المصدر عند توسيع النص.
- يجب أن تبقى أزرار الإجراءات قابلة للوصول بلوحة المفاتيح.
- Example identifier: \`fixture_run_2026_08_13\`.

הממשק צריך לשמור על היררכיה ברורה גם כאשר תוכן מימין לשמאל משולב עם קוד באנגלית.`;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function activeConversation(conversations: ConversationView[]): ConversationView {
  const conversation = conversations.find((candidate) => candidate.id === "conversation-harness");
  if (!conversation) throw new Error("The canonical visual conversation fixture is missing.");
  return conversation;
}

function mappedConversation(
  conversations: ConversationView[],
  map: (conversation: ConversationView) => ConversationView,
): ConversationView[] {
  return conversations.map((conversation) =>
    conversation.id === "conversation-harness" ? map(conversation) : conversation,
  );
}

function makeStreamingConversation(
  conversations: ConversationView[],
  partial: boolean,
): ConversationView[] {
  return mappedConversation(conversations, (conversation) => ({
    ...conversation,
    runState: "streaming",
    messages: [
      ...conversation.messages,
      {
        id: "message-visual-fixture-user",
        role: "user",
        content: "Audit this response for context fidelity, citations, and graceful recovery.",
        createdAt: FIXTURE_TIMESTAMP,
        status: "complete",
        modelLabel: null,
        runId: null,
        attachments: [],
        branchIndex: 1,
        branchCount: 1,
      },
      {
        id: FIXTURE_ASSISTANT_MESSAGE_ID,
        role: "assistant",
        content: partial
          ? "I have frozen the current request and selected the first complete evidence group. The provider stream is still writing the verification section…"
          : "",
        createdAt: FIXTURE_TIMESTAMP,
        status: "streaming",
        modelLabel: "Visual fixture · deterministic route",
        runId: FIXTURE_RUN_ID,
        attachments: [],
        branchIndex: 1,
        branchCount: 1,
      },
    ],
  }));
}

function makeFailureConversation(
  conversations: ConversationView[],
  state: "denied" | "error",
): ConversationView[] {
  return mappedConversation(conversations, (conversation) => ({
    ...conversation,
    runState: "failed",
    messages: [
      ...conversation.messages,
      {
        id: FIXTURE_ASSISTANT_MESSAGE_ID,
        role: "assistant",
        content:
          state === "denied"
            ? "This run was blocked before dispatch because the requested capability was not approved. No provider request or machine operation was started."
            : "The provider stream ended without valid terminal evidence. Omnia preserved the partial projection and marked the outcome for review instead of claiming success.",
        createdAt: FIXTURE_TIMESTAMP,
        status: "failed",
        modelLabel: "Visual fixture · guarded route",
        runId: FIXTURE_RUN_ID,
        attachments: [],
        branchIndex: 1,
        branchCount: 1,
      },
    ],
  }));
}

function makeLongConversation(
  conversations: ConversationView[],
  locale: VisualLocaleId,
): ConversationView[] {
  return mappedConversation(conversations, (conversation) => ({
    ...conversation,
    title:
      locale === "vi"
        ? "Đánh giá độ trung thực của ngữ cảnh dài và khả năng truy vết nguồn"
        : "Long-context fidelity, source provenance, and layout resilience",
    excerpt: "Long Vietnamese, RTL, code, citations, and unbroken content for visual QA.",
    messages: [
      ...conversation.messages,
      {
        id: FIXTURE_ASSISTANT_MESSAGE_ID,
        role: "assistant",
        content: locale === "rtl-test" ? RTL_TEST_ANSWER : LONG_VIETNAMESE_ANSWER,
        createdAt: FIXTURE_TIMESTAMP,
        status: "complete",
        modelLabel: "Visual fixture · long-context route",
        runId: FIXTURE_RUN_ID,
        attachments: [],
        branchIndex: 1,
        branchCount: 1,
      },
    ],
  }));
}

function makeOfflineProjects(projects: ProjectView[]): ProjectView[] {
  return projects.map((project, projectIndex) => ({
    ...project,
    contextHealth: projectIndex === 0 ? "missing-access" : project.contextHealth,
    folders: project.folders.map((folder, folderIndex) => ({
      ...folder,
      state: folderIndex === 0 ? "offline" : folder.state,
      fileCount: folderIndex === 0 ? null : folder.fileCount,
      chunkCount: folderIndex === 0 ? null : folder.chunkCount,
      lastIndexedAt: folderIndex === 0 ? null : folder.lastIndexedAt,
    })),
  }));
}

function makeOfflineProviders(providers: ProviderView[]): ProviderView[] {
  return providers.map((provider) => ({
    ...provider,
    state: "error",
    latencyMs: null,
    errorMessage: "Connection unavailable in the deterministic offline fixture.",
    models: provider.models.map((model) => ({ ...model, status: "unavailable" })),
  }));
}

function makeLongProjects(projects: ProjectView[], locale: VisualLocaleId): ProjectView[] {
  return projects.map((project, index) =>
    index === 0
      ? {
          ...project,
          name:
            locale === "vi"
              ? "Nghiên cứu Omnia, học máy, thuật toán thi đấu và báo cáo khoa học"
              : "Omnia research, machine learning, competitive programming, and scientific reports",
          description:
            "A deliberately expanded project description covering provenance, long-context evaluation, source synchronization, accessibility, localization, and durable recovery behavior.",
          folders: project.folders.map((folder) => ({
            ...folder,
            displayName:
              "bao-cao-nghien-cuu-va-kho-du-lieu-thuc-nghiem-cuc-ky-dai-de-kiem-tra-wrap",
          })),
        }
      : project,
  );
}

function fixtureCitations(): CitationView[] {
  return [
    {
      id: "citation-visual-fixture",
      messageId: FIXTURE_ASSISTANT_MESSAGE_ID,
      runId: FIXTURE_RUN_ID,
      sourceId: "source-visual-fixture",
      snapshotId: "snapshot-visual-fixture",
      displayIndex: 1,
      title: "Context compiler architecture and verification ledger",
      sourceType: "attachment",
      locatorLabel: "pp. 42–43",
      uri: null,
      excerpt: "The current request remains the final semantic unit and superseded facts are excluded.",
      retrievedAt: FIXTURE_TIMESTAMP,
      sourceContentHash: "a".repeat(64),
      sourceStart: 120,
      sourceEnd: 211,
      sourceAvailableInSnapshot: true,
      answerStart: 0,
      answerEnd: 52,
      verificationState: "verified",
    },
  ];
}

function fixtureTimeline(state: VisualStateId): RunTimelineEventView[] {
  if (!["streaming", "partial", "denied", "error"].includes(state)) return [];
  const failed = state === "denied" || state === "error";
  return [
    {
      id: "event-visual-1",
      runId: FIXTURE_RUN_ID,
      parentEventId: null,
      sequence: 1,
      type: "context.snapshot_frozen",
      stage: "context",
      status: "complete",
      summary: "Frozen context snapshot created",
      detail: "The fixture uses immutable, repository-authored QA data.",
      startedAt: FIXTURE_TIMESTAMP,
      endedAt: FIXTURE_TIMESTAMP,
      source: "harness",
      providerLabel: null,
      attemptOrdinal: null,
      citationIds: [],
    },
    {
      id: "event-visual-2",
      runId: FIXTURE_RUN_ID,
      parentEventId: "event-visual-1",
      sequence: 2,
      type: failed ? "attempt.blocked" : "attempt.streaming",
      stage: failed ? "policy" : "provider",
      status: failed ? "failed" : "running",
      summary: failed ? "Run stopped before a successful terminal fact" : "Provider stream active",
      detail: failed
        ? "The fixture intentionally exercises an explicit failure state."
        : "Text projection is intentionally partial for screenshot coverage.",
      startedAt: FIXTURE_TIMESTAMP,
      endedAt: failed ? FIXTURE_TIMESTAMP : null,
      source: failed ? "harness" : "provider",
      providerLabel: "Visual fixture provider",
      attemptOrdinal: 1,
      citationIds: [],
    },
  ];
}

export interface VisualFixtureState {
  activeConversationId: string;
  activeProjectId: string;
  conversations: ConversationView[];
  attachments: AttachmentView[];
  draftAttachmentIdsByConversation: Record<string, string[]>;
  projects: ProjectView[];
  memories: MemoryView[];
  skills: SkillView[];
  artifacts: ArtifactView[];
  citations: CitationView[];
  runTimelineEvents: RunTimelineEventView[];
  providers: ProviderView[];
  activeRun: ActiveRunView | null;
}

export function createVisualFixtureState(
  state: VisualStateId,
  locale: VisualLocaleId,
): VisualFixtureState {
  let conversations = clone(initialConversations);
  let projects = clone(initialProjects);
  let providers = clone(initialProviders);
  let memories = clone(initialMemories);
  let skills = clone(initialSkills);
  let artifacts = clone(initialArtifacts);
  let activeRun: ActiveRunView | null = null;
  let citations: CitationView[] = [];

  if (state === "empty") {
    conversations = [
      {
        ...activeConversation(conversations),
        id: "conversation-visual-empty",
        activeBranchId: "branch-visual-empty",
        title: "Untitled conversation",
        excerpt: "Start a new conversation",
        projectId: null,
        projectName: null,
        messages: [],
        draft: "",
      },
    ];
    projects = [];
    memories = [];
    skills = [];
    artifacts = [];
  } else if (state === "loading" || state === "streaming" || state === "partial") {
    conversations = makeStreamingConversation(conversations, state === "partial");
    activeRun = {
      id: FIXTURE_RUN_ID,
      conversationId: "conversation-harness",
      assistantMessageId: FIXTURE_ASSISTANT_MESSAGE_ID,
      stage: state === "partial" ? "writing" : "requesting",
      startedAt: FIXTURE_TIMESTAMP,
    };
  } else if (state === "denied" || state === "error") {
    conversations = makeFailureConversation(conversations, state);
  } else if (state === "offline") {
    projects = makeOfflineProjects(projects);
    providers = makeOfflineProviders(providers);
  } else if (state === "long-content") {
    conversations = makeLongConversation(conversations, locale);
    projects = makeLongProjects(projects, locale);
    citations = fixtureCitations();
  }

  const activeConversationId = conversations[0]?.id ?? "";
  const activeProjectId = projects[0]?.id ?? "";
  const attachments = conversations.flatMap((conversation) =>
    conversation.messages.flatMap((message) => message.attachments),
  );

  return {
    activeConversationId,
    activeProjectId,
    conversations,
    attachments,
    draftAttachmentIdsByConversation: {},
    projects,
    memories,
    skills,
    artifacts,
    citations,
    runTimelineEvents: fixtureTimeline(state),
    providers,
    activeRun,
  };
}
