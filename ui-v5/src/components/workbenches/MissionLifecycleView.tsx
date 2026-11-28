import { For, Show, createEffect, createMemo, createSignal, onMount } from 'solid-js';
import {
  BookMarked,
  Brain,
  CheckCircle2,
  CheckSquare,
  Compass,
  FileCheck2,
  GitBranch,
  GraduationCap,
  Link2,
  Plus,
  Radar,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Sparkles,
  Square,
} from 'lucide-solid';
import { api } from '@/api/client';
import { activeSessionId, flashNotice, lifecycleRefreshSeq, privacyMask } from '@/state/studio';
import { renderRichMarkdown } from '@/utils/markdown';
import { maskJson, maskText } from '@/utils/privacy';

const ARTIFACT_KINDS = [
  'goal',
  'spec',
  'blueprint',
  'plan',
  'todo',
  'progress',
  'dod',
  'handoff',
  'checkpoint',
  'memory',
  'lesson',
  'skill',
] as const;

type LifecycleSubTab = 'artifacts' | 'todo_dod' | 'handoff' | 'learn' | 'think';

export function MissionLifecycleView() {
  const [subTab, setSubTab] = createSignal<LifecycleSubTab>('artifacts');
  const [kindFilter, setKindFilter] = createSignal<string>('all');
  const [artifacts, setArtifacts] = createSignal<Array<Record<string, unknown>>>([]);
  const [links, setLinks] = createSignal<Array<Record<string, unknown>>>([]);
  const [superState, setSuperState] = createSignal<Record<string, unknown> | null>(null);
  const [superStatus, setSuperStatus] = createSignal<Record<string, unknown> | null>(null);
  const [superCaps, setSuperCaps] = createSignal<Record<string, unknown> | null>(null);
  const [superGoalInput, setSuperGoalInput] = createSignal('');
  const [proceedPolicy, setProceedPolicy] = createSignal<'off' | 'standard' | 'full'>('standard');
  const [superActionBusy, setSuperActionBusy] = createSignal(false);
  const [lessons, setLessons] = createSignal<Array<Record<string, unknown>>>([]);
  const [gapRadar, setGapRadar] = createSignal<Record<string, unknown> | null>(null);
  const [thinkSessions, setThinkSessions] = createSignal<Array<Record<string, unknown>>>([]);
  const [selectedArt, setSelectedArt] = createSignal<Record<string, unknown> | null>(null);
  const [verifyReport, setVerifyReport] = createSignal<Record<string, unknown> | null>(null);
  const [citationReport, setCitationReport] = createSignal<Record<string, unknown> | null>(null);
  const [citationVerifyBusy, setCitationVerifyBusy] = createSignal(false);
  const [globalSyncBusy, setGlobalSyncBusy] = createSignal(false);
  const [globalSyncReceipt, setGlobalSyncReceipt] = createSignal<Record<string, unknown> | null>(null);
  const [statusNote, setStatusNote] = createSignal('');

  // Artifact upsert form
  const [artKind, setArtKind] = createSignal<string>('goal');
  const [artTitle, setArtTitle] = createSignal('');
  const [artContent, setArtContent] = createSignal('');
  const [linkFrom, setLinkFrom] = createSignal('');
  const [linkTo, setLinkTo] = createSignal('');
  const [linkRel, setLinkRel] = createSignal('satisfies');

  // Handoff form
  const [handoffSummary, setHandoffSummary] = createSignal('');
  const [handoffNext, setHandoffNext] = createSignal('');
  const [handoffNotes, setHandoffNotes] = createSignal('');

  // Learn / Crystallize form
  const [lessonTitle, setLessonTitle] = createSignal('');
  const [lessonBody, setLessonBody] = createSignal('');
  const [lessonScope, setLessonScope] = createSignal<'project' | 'global'>('project');
  const [promoteSlug, setPromoteSlug] = createSignal('');
  const [promoteTrigger, setPromoteTrigger] = createSignal('Use when ');

  // Deep Think form
  const [thinkProblem, setThinkProblem] = createSignal('');
  const [branchLabel, setBranchLabel] = createSignal('Branch B (SOTA)');
  const [branchHyp, setBranchHyp] = createSignal('');
  const [activeThinkId, setActiveThinkId] = createSignal('');

  const loadAll = async () => {
    const [artRes, superRes, liveSuperStatusRes, liveSuperCapsRes, proceedRes, lesRes, gapRes, thinkRes] =
      await Promise.all([
        api.listLifecycleArtifacts(),
        api.getSuperWorkflowState(),
        api.safeJson<Record<string, unknown>>('/api/v5/super/status'),
        api.safeJson<Record<string, unknown>>('/api/v5/super/capabilities'),
        api.safeJson<Record<string, unknown>>('/api/v5/super/proceed'),
        api.listLearnLessons(),
        api.getLearnGapRadar(),
        api.listThinkSessions(),
      ]);
    if (artRes.ok) {
      const list = (artRes.data.artifacts ?? []) as Array<Record<string, unknown>>;
      setArtifacts(Array.isArray(list) ? list : []);
      const lnk = (artRes.data.links ?? []) as Array<Record<string, unknown>>;
      setLinks(Array.isArray(lnk) ? lnk : []);
      if (Array.isArray(list) && list.length > 0 && !selectedArt()) setSelectedArt(list[0]);
    }
    if (superRes.ok) setSuperState(superRes.data);
    if (liveSuperStatusRes.ok) {
      setSuperStatus(liveSuperStatusRes.data);
      const rawPol = String(
        liveSuperStatusRes.data.autoProceed ?? liveSuperStatusRes.data.auto_proceed ?? '',
      ).toLowerCase();
      if (rawPol === 'off' || rawPol === 'standard' || rawPol === 'full') setProceedPolicy(rawPol);
    }
    if (liveSuperCapsRes.ok) setSuperCaps(liveSuperCapsRes.data);
    if (proceedRes.ok) {
      const rawPol = String(
        proceedRes.data.policy ?? proceedRes.data.autoProceed ?? proceedRes.data.auto_proceed ?? '',
      ).toLowerCase();
      if (rawPol === 'off' || rawPol === 'standard' || rawPol === 'full') setProceedPolicy(rawPol);
    }
    if (lesRes.ok) {
      const list = (lesRes.data.lessons ?? []) as Array<Record<string, unknown>>;
      setLessons(Array.isArray(list) ? list : []);
    }
    if (gapRes.ok) setGapRadar(gapRes.data);
    if (thinkRes.ok) {
      const list = (thinkRes.data.sessions ?? []) as Array<Record<string, unknown>>;
      setThinkSessions(Array.isArray(list) ? list : []);
      if (Array.isArray(list) && list.length > 0 && !activeThinkId()) {
        setActiveThinkId(String(list[0].id ?? list[0].thinkId ?? ''));
      }
    }
  };

  const handleLaunchSuperPlan = async () => {
    if (superActionBusy()) return;
    const goal =
      superGoalInput().trim() ||
      String(superStatus()?.activeGoal ?? superStatus()?.active_goal ?? '').trim() ||
      'Unified /super-plan mission architecture';
    setSuperActionBusy(true);
    const res = await api.safeJson<Record<string, unknown>>('/api/v5/super/plan', {
      method: 'POST',
      body: JSON.stringify({
        goal,
        prompt: goal,
        sessionId: activeSessionId(),
        autoProceed: 'off',
        goalPersistence: false,
        tokenBudget: null,
      }),
    });
    setSuperActionBusy(false);
    setProceedPolicy('off');
    if (res.ok) {
      setSuperStatus(res.data);
      const rid = String(res.data.runId ?? res.data.run_id ?? 'super-plan');
      const msg = `Launched /super-plan (${rid}) · autoProceed: off · Spec-Oracle hydrated`;
      setStatusNote(msg);
      flashNotice(msg);
      await loadAll();
    } else {
      setStatusNote(`/super-plan (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleLaunchSuperRun = async () => {
    if (superActionBusy()) return;
    const goal =
      superGoalInput().trim() ||
      String(superStatus()?.activeGoal ?? superStatus()?.active_goal ?? '').trim() ||
      'Autonomous /super-run execution with 3/3 cleanroom audit gate';
    setSuperActionBusy(true);
    const res = await api.safeJson<Record<string, unknown>>('/api/v5/super/run', {
      method: 'POST',
      body: JSON.stringify({
        goal,
        prompt: goal,
        sessionId: activeSessionId(),
        autoProceed: 'full',
        goalPersistence: true,
        approvalMode: 'yolo',
        tokenBudget: null,
        boost: true,
      }),
    });
    setSuperActionBusy(false);
    setProceedPolicy('full');
    if (res.ok) {
      setSuperStatus(res.data);
      const rid = String(res.data.runId ?? res.data.run_id ?? 'super-run');
      const msg = `Launched /super-run (${rid}) · autoProceed: full · YOLO · Swarm 32-Cap · tokenBudget: null`;
      setStatusNote(msg);
      flashNotice(msg);
      await loadAll();
    } else {
      setStatusNote(`/super-run (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleSetProceedPolicy = async (next: 'off' | 'standard' | 'full') => {
    if (superActionBusy()) return;
    setProceedPolicy(next);
    setSuperActionBusy(true);
    const res = await api.safeJson<Record<string, unknown>>('/api/v5/super/proceed', {
      method: 'POST',
      body: JSON.stringify({
        policy: next,
        autoProceed: next,
        sessionId: activeSessionId(),
      }),
    });
    setSuperActionBusy(false);
    if (res.ok) {
      const msg = `AutoProceedPolicy -> ${next.toUpperCase()}`;
      setStatusNote(msg);
      flashNotice(msg);
      await loadAll();
    } else {
      setStatusNote(`AutoProceedPolicy (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleCancelSuperRun = async () => {
    if (superActionBusy()) return;
    const runId = String(superStatus()?.runId ?? superStatus()?.run_id ?? '').trim() || undefined;
    setSuperActionBusy(true);
    const res = await api.safeJson<Record<string, unknown>>('/api/v5/super/cancel', {
      method: 'POST',
      body: JSON.stringify({ runId, sessionId: activeSessionId() }),
    });
    setSuperActionBusy(false);
    if (res.ok) {
      setSuperStatus(res.data);
      const marker = String(res.data.marker ?? '<!-- GOAL_CANCELLED -->');
      const msg = `Active Super run cancelled ${marker}`;
      setStatusNote(msg);
      flashNotice(msg);
      await loadAll();
    } else {
      setStatusNote(`Cancel Super run (${res.error.code}): ${res.error.message}`);
    }
  };

  const superSummary = createMemo(() => {
    const st = superStatus() ?? superState() ?? {};
    const caps = superCaps() ?? {};
    const mode = String(st.mode ?? st.state ?? 'ready');
    const phase = String(st.phase ?? 'idle');
    const runId = String(st.runId ?? st.run_id ?? '');
    const auditStreak = Number(st.auditStreak ?? st.audit_streak ?? 0) || 0;
    const goalPersistence = Boolean(st.goalPersistence ?? st.goal_persistence ?? mode.toLowerCase().includes('run'));
    const activeGoal = String(st.activeGoal ?? st.active_goal ?? st.goal ?? '');
    const crates = Number(caps.crates ?? 18) || 18;
    const agentTools = Number(caps.agentTools ?? caps.agent_tools ?? 42) || 42;
    const computerTools = Number(caps.computerTools ?? caps.computer_tools ?? 21) || 21;
    const rawSkills = caps.skills;
    let skillsLabel = '22 + 1,001 Vault';
    if (rawSkills && typeof rawSkills === 'object' && !Array.isArray(rawSkills)) {
      const sk = rawSkills as Record<string, unknown>;
      const wsCount = Number(sk.workspaceCount ?? sk.workspace_count ?? 0) || 0;
      const vaultCount = Number(sk.coldVaultCount ?? sk.cold_vault_count ?? 0) || 0;
      const plugSkills = Number(sk.pluginSkillCount ?? sk.plugin_skill_count ?? 0) || 0;
      const total = Number(sk.totalCount ?? sk.total_count ?? wsCount + vaultCount + plugSkills) || 0;
      const m2v = sk.m2vEnabled === true ? ' · M2V' : '';
      skillsLabel =
        wsCount > 0 || vaultCount > 0
          ? `${wsCount}+${vaultCount.toLocaleString()} Skills${plugSkills > 0 ? ` (+${plugSkills} plug)` : ''}${m2v}`
          : total > 0
            ? `${total.toLocaleString()} Skills${m2v}`
            : '22 + 1,001 Vault';
    } else if (typeof rawSkills === 'number') {
      skillsLabel = `${rawSkills} active + 1,001 Vault`;
    } else if (typeof rawSkills === 'string' && rawSkills.trim()) {
      skillsLabel = rawSkills;
    }
    const rawMcp = caps.mcpServers ?? caps.mcp_servers;
    const mcpSummary =
      caps.mcpSummary && typeof caps.mcpSummary === 'object' && !Array.isArray(caps.mcpSummary)
        ? (caps.mcpSummary as Record<string, unknown>)
        : null;
    const mcpCount = Array.isArray(rawMcp)
      ? rawMcp.length
      : Number(mcpSummary?.discoveredCount ?? mcpSummary?.connectedCount ?? rawMcp ?? 0) || 0;
    const pluginCount = Array.isArray(caps.plugins)
      ? caps.plugins.length
      : Number(caps.plugins ?? 0) || 0;
    const rawAgy = caps.agyFast ?? caps.agy_fast;
    const agyFast =
      typeof rawAgy === 'string' && rawAgy.trim()
        ? rawAgy
        : rawAgy && typeof rawAgy === 'object' && !Array.isArray(rawAgy)
          ? String(
              (rawAgy as Record<string, unknown>).status ??
                ((rawAgy as Record<string, unknown>).available ? 'available' : 'bridged'),
            )
          : 'bridged';
    const lanes = Array.isArray(caps.lanes) ? (caps.lanes as string[]) : [];
    const steers = Array.isArray(st.steers) ? st.steers.length : Number(st.steers ?? 0) || 0;
    return {
      mode,
      phase,
      runId,
      auditStreak,
      goalPersistence,
      activeGoal,
      crates,
      agentTools,
      computerTools,
      skillsLabel,
      mcpCount,
      pluginCount,
      agyFast,
      lanes,
      steers,
    };
  });

  onMount(() => {
    void loadAll();
  });

  createEffect(() => {
    lifecycleRefreshSeq();
    void loadAll();
  });

  const filteredArtifacts = createMemo(() => {
    const f = kindFilter();
    if (f === 'all') return artifacts();
    return artifacts().filter((a) => String(a.kind ?? '').toLowerCase() === f);
  });

  const todoArtifacts = createMemo(() =>
    artifacts().filter((a) => String(a.kind ?? '').toLowerCase() === 'todo'),
  );
  const dodArtifacts = createMemo(() =>
    artifacts().filter((a) => String(a.kind ?? '').toLowerCase() === 'dod'),
  );

  const handleUpsertArtifact = async () => {
    if (!artTitle().trim()) return;
    const res = await api.upsertLifecycleArtifact({
      kind: artKind(),
      title: artTitle().trim(),
      content: artContent().trim() || `# ${artTitle().trim()}\n`,
      projectToDisk: true,
    });
    if (res.ok) {
      setArtTitle('');
      setArtContent('');
      setStatusNote(`Saved ${artKind()} artifact (SQLite WAL + atomic LF)`);
      await loadAll();
    } else {
      setStatusNote(`Upsert error (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleLinkArtifacts = async () => {
    if (!linkFrom().trim() || !linkTo().trim()) return;
    const res = await api.linkLifecycleArtifacts(linkFrom().trim(), linkTo().trim(), linkRel());
    setStatusNote(res.ok ? `Linked ${linkFrom()} -[${linkRel()}]-> ${linkTo()}` : `Link error (${res.error.code})`);
    await loadAll();
  };

  const handleVerifySelected = async () => {
    const art = selectedArt();
    if (!art) return;
    const res = await api.verifyLifecycleArtifact(
      String(art.content ?? art.body ?? ''),
      `${String(art.kind ?? 'artifact')}.md`,
    );
    setVerifyReport(res.ok ? res.data : { error: res.error.code, message: res.error.message });
    setStatusNote(res.ok ? 'Deterministic artifact verification complete' : `Verify (${res.error.code})`);
  };

  const handleVerifyCitations = async () => {
    const art = selectedArt();
    if (!art || citationVerifyBusy()) return;
    const text = String(art.content ?? art.body ?? '').trim();
    if (!text) return;
    setCitationVerifyBusy(true);
    const res = await api.safeJson<Record<string, unknown>>('/api/v5/research/verify-citations', {
      method: 'POST',
      body: JSON.stringify({ draft: text, text, strict: true }),
    });
    setCitationVerifyBusy(false);
    if (res.ok) {
      setCitationReport(res.data);
      const isValid = res.data.valid === true || res.data.ok === true;
      setStatusNote(
        isValid
          ? '4-Layer EN+VN citation verification passed'
          : '4-Layer citation verification flagged unverified claims',
      );
    } else {
      setCitationReport({ ok: false, error: res.error.code, message: res.error.message });
      setStatusNote(`Citation verify (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleSyncGlobalLessons = async () => {
    if (globalSyncBusy()) return;
    setGlobalSyncBusy(true);
    const res = await api.safeJson<Record<string, unknown>>('/api/v5/learn/sync-global', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    setGlobalSyncBusy(false);
    if (res.ok) {
      setGlobalSyncReceipt(res.data);
      const count = res.data.syncedCount ?? res.data.synced ?? res.data.total ?? '';
      const msg = `Global Lessons synced${count !== '' ? ` (${String(count)} entries)` : ''}`;
      setStatusNote(msg);
      flashNotice(msg);
      await loadAll();
    } else {
      setGlobalSyncReceipt({ ok: false, error: res.error.code, message: res.error.message });
      setStatusNote(`Global lessons sync (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleCaptureLesson = async () => {
    if (!lessonTitle().trim() || !lessonBody().trim()) return;
    const res = await api.captureLearnLesson({
      title: lessonTitle().trim(),
      lesson: lessonBody().trim(),
      scope: lessonScope(),
    });
    if (res.ok) {
      setLessonTitle('');
      setLessonBody('');
      setStatusNote(`Captured ${lessonScope()} lesson`);
      await loadAll();
    } else {
      setStatusNote(`Learn error (${res.error.code}): ${res.error.message}`);
    }
  };

  const handlePromoteLesson = async (lessonId: string) => {
    const slug = promoteSlug().trim() || `omnia-lesson-${lessonId.slice(0, 8)}`;
    const trigger = promoteTrigger().trim().startsWith('Use when')
      ? promoteTrigger().trim()
      : `Use when ${promoteTrigger().trim() || 'applying this verified engineering pattern'}`;
    const res = await api.promoteLessonToSkill(lessonId, slug, trigger);
    setStatusNote(res.ok ? `Crystallized lesson -> skill "${slug}"` : `Promote error (${res.error.code}): ${res.error.message}`);
    flashNotice(res.ok ? `Crystallized skill ${slug}` : `Promote note: ${res.error.message}`);
    await loadAll();
  };

  const handleStartThink = async () => {
    if (!thinkProblem().trim()) return;
    const res = await api.startThinkSession(activeSessionId(), thinkProblem().trim(), 'max');
    if (res.ok) {
      setThinkProblem('');
      const tid = String((res.data.session as Record<string, unknown> | undefined)?.id ?? res.data.thinkId ?? '');
      if (tid) setActiveThinkId(tid);
      setStatusNote('Started multi-hypothesis Deep Think session');
      await loadAll();
    } else {
      setStatusNote(`Think error (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleAddBranch = async () => {
    if (!activeThinkId() || !branchHyp().trim()) return;
    const res = await api.addThinkBranch(activeThinkId(), branchLabel().trim(), branchHyp().trim());
    if (res.ok) {
      setBranchHyp('');
      setStatusNote(`Added hypothesis branch "${branchLabel()}"`);
      await loadAll();
    } else {
      setStatusNote(`Branch error (${res.error.code}): ${res.error.message}`);
    }
  };

  return (
    <div data-testid="lifecycle-workbench" class="flex-1 min-h-0 flex flex-col overflow-hidden bg-[var(--bg-canvas)]">
      {/* Header Bar */}
      <div class="px-4 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <Compass class="w-4 h-4 text-[var(--accent-cyan)]" />
          <span class="font-bold text-[13.5px]">Mission Lifecycle OS (12 Artifacts · Learn · Deep Think)</span>
          <span class="omnia-badge font-mono-num text-[var(--status-emerald)]">
            {artifacts().length} artifacts · {links().length} links
          </span>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <div class="omp-segmented text-[11.5px]">
            {(
              [
                { id: 'artifacts', label: '12 Artifacts' },
                { id: 'todo_dod', label: 'Todo & DoD' },
                { id: 'handoff', label: 'Handoff & Super' },
                { id: 'learn', label: 'Learn & Lessons' },
                { id: 'think', label: 'Deep Think Lab' },
              ] as const
            ).map((t) => (
              <button type="button" aria-pressed={subTab() === t.id} onClick={() => setSubTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            data-testid="lifecycle-sync-global-header-btn"
            disabled={globalSyncBusy()}
            class="omnia-btn text-[11px]"
            title="Mirror Global Lessons (D:\\OmniaData\\memory\\global_lessons.md <-> Antigravity)"
            onClick={() => void handleSyncGlobalLessons()}
          >
            <GraduationCap class="w-3.5 h-3.5 text-[var(--status-emerald)]" />
            <span>{globalSyncBusy() ? 'Syncing...' : 'Sync Global Lessons'}</span>
          </button>
          <button type="button" class="omnia-btn text-[11px]" onClick={() => void loadAll()}>
            <RefreshCw class="w-3.5 h-3.5" />
            <span>Sync</span>
          </button>
        </div>
      </div>

      <Show when={statusNote()}>
        <div class="px-4 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--accent-dim)] text-[11.5px] font-mono-num text-[var(--accent-cyan)]">
          {maskText(statusNote(), privacyMask())}
        </div>
      </Show>

      <div class="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Unified /super-plan & /super-run Command Center */}
        <section
          data-testid="super-command-center"
          class="omnia-surface-panel rounded-lg p-3.5 space-y-3 border-[var(--border-accent)] min-w-0"
        >
          <div class="flex flex-wrap items-center justify-between gap-2 min-w-0">
            <div class="flex flex-wrap items-center gap-2 min-w-0">
              <Rocket class="w-4 h-4 text-[var(--accent-cyan)] shrink-0" />
              <span class="font-bold text-[13px] text-[var(--ink-primary)]">
                Unified /super-plan &amp; /super-run Command Center
              </span>
              <span
                data-testid="super-mode-badge"
                class="omnia-badge font-mono-num uppercase text-[10px]"
                classList={{
                  'text-[var(--status-emerald)]': superSummary().mode.toLowerCase().includes('run'),
                  'text-[var(--accent-cyan)]': superSummary().mode.toLowerCase().includes('plan'),
                  'text-[var(--ink-secondary)]':
                    !superSummary().mode.toLowerCase().includes('run') &&
                    !superSummary().mode.toLowerCase().includes('plan'),
                }}
              >
                {superSummary().mode} · {superSummary().phase}
              </span>
              <Show when={superSummary().runId}>
                <span class="omnia-badge font-mono-num text-[10px] text-[var(--ink-secondary)]">
                  run:{superSummary().runId}
                </span>
              </Show>
            </div>
            <div class="flex flex-wrap items-center gap-1.5 shrink-0 font-mono-num text-[10.5px]">
              <span
                data-testid="super-audit-streak"
                class="omnia-badge"
                classList={{
                  'text-[var(--status-emerald)]': superSummary().auditStreak >= 3,
                  'text-[var(--accent-amber)]': superSummary().auditStreak < 3,
                }}
                title="3 consecutive zero-finding Cleanroom Audits required for whole-goal completion"
              >
                Audit Streak: {superSummary().auditStreak}/3
              </span>
              <span class="omnia-badge text-[var(--accent-cyan)]">tokenBudget: null</span>
              <span class="omnia-badge text-[var(--ink-secondary)]">
                Steers: {superSummary().steers}
              </span>
            </div>
          </div>

          {/* Full Omnia Architecture Capability Pills */}
          <div
            data-testid="super-capability-pills"
            class="flex flex-wrap items-center gap-1.5 text-[10.5px] font-mono-num min-w-0"
          >
            <span class="omnia-badge text-[var(--accent-cyan)]">{superSummary().crates} Rust Crates</span>
            <span class="omnia-badge text-[var(--status-emerald)]">
              {superSummary().agentTools}+{superSummary().computerTools} Tools (Agent+CU)
            </span>
            <span class="omnia-badge text-[var(--accent-amber)]">{superSummary().skillsLabel}</span>
            <span class="omnia-badge text-[var(--ink-secondary)]">
              MCP: {superSummary().mcpCount > 0 ? superSummary().mcpCount : 'auto-discovered'}
            </span>
            <span class="omnia-badge text-[var(--ink-secondary)]">
              Plugins: {superSummary().pluginCount > 0 ? superSummary().pluginCount : 'auto-discovered'}
            </span>
            <span class="omnia-badge text-[var(--accent-cyan)]">agy-fast: {superSummary().agyFast}</span>
            <span class="omnia-badge text-[var(--status-emerald)]">Swarm 32-Cap · Boost</span>
            <span class="omnia-badge text-[var(--ink-secondary)]">
              Goal Persist: {superSummary().goalPersistence ? 'ON' : 'STANDBY'}
            </span>
          </div>

          <Show when={superSummary().activeGoal}>
            <div class="px-2.5 py-1.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[11.5px] font-mono-num text-[var(--ink-secondary)] truncate">
              Active Goal: <span class="text-[var(--ink-primary)]">{maskText(superSummary().activeGoal, privacyMask())}</span>
            </div>
          </Show>

          {/* Interactive Goal Launcher + AutoProceedPolicy + Cancel Run */}
          <div class="flex flex-wrap items-center gap-2 min-w-0">
            <input
              type="text"
              data-testid="super-goal-input"
              placeholder="Enter mission goal for /super-plan or /super-run..."
              value={superGoalInput()}
              onInput={(e) => setSuperGoalInput(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.isComposing || e.keyCode === 229 || e.key === 'Process') return;
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void handleLaunchSuperRun();
                }
              }}
              class="flex-1 min-w-[200px] rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-[12px] text-[var(--ink-primary)]"
            />
            <button
              type="button"
              data-testid="super-launch-plan-btn"
              disabled={superActionBusy()}
              class="omnia-btn text-[11.5px] shrink-0"
              title="POST /api/v5/super/plan (autoProceed: off, goalPersistence: false, Spec-Oracle hydrated)"
              onClick={() => void handleLaunchSuperPlan()}
            >
              <Sparkles class="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
              <span>Launch /super-plan</span>
            </button>
            <button
              type="button"
              data-testid="super-launch-run-btn"
              disabled={superActionBusy()}
              class="omnia-btn omnia-btn-primary text-[11.5px] shrink-0"
              title="POST /api/v5/super/run (autoProceed: full, YOLO, Swarm 32-Cap, Boost, tokenBudget: null)"
              onClick={() => void handleLaunchSuperRun()}
            >
              <Rocket class="w-3.5 h-3.5" />
              <span>Launch /super-run</span>
            </button>

            {/* AutoProceedPolicy Selector */}
            <div
              data-testid="super-proceed-selector"
              class="omp-segmented text-[11px] shrink-0"
              title="POST /api/v5/super/proceed — AutoProceedPolicy"
            >
              {(['off', 'standard', 'full'] as const).map((pol) => (
                <button
                  type="button"
                  data-proceed-policy={pol}
                  aria-pressed={proceedPolicy() === pol}
                  disabled={superActionBusy()}
                  onClick={() => void handleSetProceedPolicy(pol)}
                >
                  {pol === 'off' ? 'Off' : pol === 'standard' ? 'Standard' : 'Full'}
                </button>
              ))}
            </div>

            <button
              type="button"
              data-testid="super-cancel-run-btn"
              disabled={superActionBusy()}
              class="omnia-btn omnia-btn-danger text-[11.5px] shrink-0"
              title="POST /api/v5/super/cancel (<!-- GOAL_CANCELLED -->)"
              onClick={() => void handleCancelSuperRun()}
            >
              <Square class="w-3.5 h-3.5" />
              <span>Cancel Active Run</span>
            </button>
          </div>
        </section>

        {/* 1. 12-Artifact Cross-Linked Graph */}
        <Show when={subTab() === 'artifacts'}>
          <div class="flex flex-wrap gap-1.5 text-[11px] font-mono-num">
            <button
              type="button"
              onClick={() => setKindFilter('all')}
              class="px-2 py-0.5 rounded border cursor-pointer"
              classList={{
                'border-[var(--border-accent)] bg-[var(--accent-dim)] text-[var(--accent-cyan)] font-bold': kindFilter() === 'all',
                'border-[var(--border-subtle)] bg-[var(--bg-panel)] text-[var(--ink-muted)]': kindFilter() !== 'all',
              }}
            >
              all ({artifacts().length})
            </button>
            {ARTIFACT_KINDS.map((k) => {
              const cnt = () => artifacts().filter((a) => String(a.kind ?? '').toLowerCase() === k).length;
              return (
                <button
                  type="button"
                  onClick={() => setKindFilter(k)}
                  class="px-2 py-0.5 rounded border cursor-pointer uppercase"
                  classList={{
                    'border-[var(--border-accent)] bg-[var(--accent-dim)] text-[var(--accent-cyan)] font-bold': kindFilter() === k,
                    'border-[var(--border-subtle)] bg-[var(--bg-panel)] text-[var(--ink-muted)]': kindFilter() !== k,
                  }}
                >
                  {k} ({cnt()})
                </button>
              );
            })}
          </div>

          <div class="grid grid-cols-1 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-4">
            <div class="space-y-3 min-w-0">
              {/* Create / Update Artifact */}
              <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2 text-[12px] min-w-0">
                <div class="font-bold text-[12.5px] flex items-center gap-1.5">
                  <BookMarked class="w-4 h-4 text-[var(--accent-amber)]" />
                  <span>Create / Update Cross-Linked Artifact (SQLite WAL + Atomic LF)</span>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-[150px_minmax(0,1fr)] gap-2">
                  <select
                    aria-label="Artifact Kind"
                    value={artKind()}
                    onChange={(e) => setArtKind(e.currentTarget.value)}
                    class="min-w-0 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1.5 uppercase font-mono-num text-[11.5px]"
                  >
                    {ARTIFACT_KINDS.map((k) => (
                      <option value={k}>{k}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    placeholder="Title (e.g. GOAL-01 Deep Research Default-ON)"
                    value={artTitle()}
                    onInput={(e) => setArtTitle(e.currentTarget.value)}
                    class="min-w-0 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5"
                  />
                </div>
                <textarea
                  rows={3}
                  placeholder="Markdown content (supports [[wiki-links]], AC-1..N, and 6-state receipts)..."
                  value={artContent()}
                  onInput={(e) => setArtContent(e.currentTarget.value)}
                  class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5 font-mono-num text-[11.5px]"
                />
                <div class="flex justify-end">
                  <button type="button" class="omnia-btn omnia-btn-primary text-[11.5px]" onClick={() => void handleUpsertArtifact()}>
                    <Plus class="w-3.5 h-3.5" />
                    <span>Save Artifact</span>
                  </button>
                </div>
              </div>

              {/* Artifacts Inventory */}
              <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2">
                <div class="font-bold text-[12.5px]">Artifacts ({filteredArtifacts().length})</div>
                <div class="space-y-1.5 max-h-80 overflow-y-auto">
                  <Show
                    when={filteredArtifacts().length > 0}
                    fallback={
                      <div class="p-3 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[11.5px] font-mono-num text-[var(--ink-muted)]">
                        No artifacts match this filter yet. Create a Goal, Spec, Blueprint, Plan, Todo, or DoD gate above.
                      </div>
                    }
                  >
                    <For each={filteredArtifacts()}>
                      {(art) => (
                        <button
                          type="button"
                          onClick={() => setSelectedArt(art)}
                          class="w-full p-2.5 rounded border text-left cursor-pointer flex items-center justify-between gap-2 text-[12px]"
                          classList={{
                            'bg-[var(--bg-elevated)] border-[var(--border-accent)]': selectedArt() === art,
                            'bg-[var(--bg-canvas)] border-[var(--border-subtle)]': selectedArt() !== art,
                          }}
                        >
                          <div class="min-w-0">
                            <div class="flex items-center gap-1.5">
                              <span class="omnia-badge uppercase font-mono-num text-[10px] text-[var(--accent-cyan)]">
                                {String(art.kind ?? 'artifact')}
                              </span>
                              <span class="font-semibold truncate">{maskText(String(art.title ?? art.id ?? 'Untitled'), privacyMask())}</span>
                            </div>
                            <div class="text-[10.5px] font-mono-num text-[var(--ink-muted)] truncate mt-0.5">
                              id:{String(art.id ?? '')} · status:{String(art.status ?? 'active')}
                            </div>
                          </div>
                          <span class="omnia-badge text-[10px] shrink-0 text-[var(--status-emerald)]">
                            {String(art.receiptState ?? art.status ?? 'active')}
                          </span>
                        </button>
                      )}
                    </For>
                  </Show>
                </div>
              </div>
            </div>

            {/* Right Inspector: Selected Artifact + Deterministic Verifier + Cross-Links */}
            <div class="space-y-3 min-w-0">
              <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2.5 min-w-0">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span class="font-bold text-[12.5px] flex items-center gap-1.5">
                    <FileCheck2 class="w-4 h-4 text-[var(--status-emerald)]" />
                    <span>Artifact Preview &amp; Deterministic Gate</span>
                  </span>
                  <div class="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      data-testid="lifecycle-verify-citations-btn"
                      disabled={citationVerifyBusy() || !selectedArt()}
                      class="omnia-btn text-[11px]"
                      title="Run 4-Layer EN+VN ResearchVault citation verifier on selected artifact"
                      onClick={() => void handleVerifyCitations()}
                    >
                      <Sparkles class="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
                      <span>{citationVerifyBusy() ? 'Checking...' : 'Verify Citations (4-Layer)'}</span>
                    </button>
                    <button type="button" class="omnia-btn text-[11px]" onClick={() => void handleVerifySelected()}>
                      <ShieldCheck class="w-3.5 h-3.5 text-[var(--status-emerald)]" />
                      <span>Verify Artifact</span>
                    </button>
                  </div>
                </div>
                <Show
                  when={selectedArt()}
                  fallback={<div class="text-[11.5px] text-[var(--ink-muted)]">Select an artifact to inspect.</div>}
                >
                  {(art) => (
                    <div
                      class="omnia-prose p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] max-h-60 overflow-y-auto text-[12.5px]"
                      innerHTML={renderRichMarkdown(maskText(String(art().content ?? art().body ?? ''), privacyMask()))}
                    />
                  )}
                </Show>
                <Show when={verifyReport()}>
                  <pre class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[10.5px] font-mono-num max-h-36 overflow-auto">
                    {JSON.stringify(maskJson(verifyReport(), privacyMask()), null, 2)}
                  </pre>
                </Show>
                <Show when={citationReport()}>
                  {(rep) => (
                    <div
                      data-testid="lifecycle-citation-report"
                      class="space-y-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] p-2.5"
                    >
                      <div class="flex items-center justify-between text-[10.5px] font-mono-num">
                        <span class="font-semibold text-[var(--accent-cyan)]">4-Layer Citation Audit</span>
                        <span
                          class="omnia-badge text-[10px]"
                          classList={{
                            'text-[var(--status-emerald)]': rep().valid === true,
                            'text-[var(--status-coral)]': rep().valid !== true,
                          }}
                        >
                          {rep().valid === true ? 'VERIFIED' : 'NEEDS REVIEW'}
                        </span>
                      </div>
                      <pre class="text-[10.5px] font-mono-num max-h-36 overflow-auto m-0">
                        {JSON.stringify(maskJson(rep(), privacyMask()), null, 2)}
                      </pre>
                    </div>
                  )}
                </Show>
              </div>

              <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2 text-[11.5px] min-w-0 overflow-hidden">
                <div class="font-bold text-[12.5px] flex items-center gap-1.5">
                  <Link2 class="w-4 h-4 text-[var(--accent-cyan)]" />
                  <span>Bidirectional Artifact Links ({links().length})</span>
                </div>
                <div class="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] gap-1.5 items-center">
                  <input
                    type="text"
                    placeholder="from_id"
                    value={linkFrom()}
                    onInput={(e) => setLinkFrom(e.currentTarget.value)}
                    class="min-w-0 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 font-mono-num"
                  />
                  <select
                    value={linkRel()}
                    onChange={(e) => setLinkRel(e.currentTarget.value)}
                    class="shrink-0 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-1.5 py-1 font-mono-num"
                  >
                    <option value="satisfies">satisfies</option>
                    <option value="blocks">blocks</option>
                    <option value="derived_from">derived_from</option>
                    <option value="supersedes">supersedes</option>
                    <option value="learned_from">learned_from</option>
                    <option value="cites">cites</option>
                  </select>
                  <input
                    type="text"
                    placeholder="to_id"
                    value={linkTo()}
                    onInput={(e) => setLinkTo(e.currentTarget.value)}
                    class="min-w-0 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 font-mono-num"
                  />
                  <button
                    type="button"
                    data-testid="lifecycle-link-btn"
                    class="omnia-btn shrink-0 px-2 py-1"
                    onClick={() => void handleLinkArtifacts()}
                  >
                    Link
                  </button>
                </div>
                <div class="space-y-1 max-h-36 overflow-y-auto font-mono-num text-[11px]">
                  <For each={links()}>
                    {(l) => (
                      <div class="px-2 py-1 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] flex justify-between gap-2">
                        <span class="text-[var(--accent-cyan)] truncate">{String(l.fromId ?? l.from_id)}</span>
                        <span class="text-[var(--accent-amber)]">[{String(l.relation)}]</span>
                        <span class="text-[var(--status-emerald)] truncate">{String(l.toId ?? l.to_id)}</span>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </div>
        </Show>

        {/* 2. Interactive Todo Checklist & Receipt-Gated DoD Ledger */}
        <Show when={subTab() === 'todo_dod'}>
          <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div class="omnia-surface-panel rounded-lg p-4 space-y-2.5">
              <div class="font-bold text-[13px] flex items-center gap-2">
                <CheckSquare class="w-4 h-4 text-[var(--accent-cyan)]" />
                <span>Interactive Todo Checklist ({todoArtifacts().length})</span>
              </div>
              <div class="space-y-1.5">
                <Show
                  when={todoArtifacts().length > 0}
                  fallback={<div class="text-[11.5px] font-mono-num text-[var(--ink-muted)]">Create a `todo` artifact in Tab 1 to manage live checklist items.</div>}
                >
                  <For each={todoArtifacts()}>
                    {(t) => {
                      const tid = String(t.id ?? '');
                      const st = String(t.status ?? 'pending');
                      return (
                        <div class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] flex items-center justify-between gap-2 text-[12px]">
                          <span class="font-medium truncate">{String(t.title ?? tid)}</span>
                          <div class="flex gap-1 shrink-0">
                            {(['pending', 'in_progress', 'done'] as const).map((nextSt) => (
                              <button
                                type="button"
                                class="omnia-btn px-2 py-0.5 text-[10px]"
                                classList={{ 'border-[var(--border-accent)] text-[var(--accent-cyan)]': st === nextSt }}
                                onClick={async () => {
                                  const r = await api.updateLifecycleTodo(tid, nextSt);
                                  setStatusNote(r.ok ? `Todo ${tid} -> ${nextSt}` : `Todo (${r.error.code})`);
                                  await loadAll();
                                }}
                              >
                                {nextSt}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    }}
                  </For>
                </Show>
              </div>
            </div>

            <div class="omnia-surface-panel rounded-lg p-4 space-y-2.5">
              <div class="font-bold text-[13px] flex items-center gap-2">
                <CheckCircle2 class="w-4 h-4 text-[var(--status-emerald)]" />
                <span>Receipt-Gated Definition of Done (DoD) ({dodArtifacts().length})</span>
              </div>
              <div class="space-y-1.5">
                <Show
                  when={dodArtifacts().length > 0}
                  fallback={<div class="text-[11.5px] font-mono-num text-[var(--ink-muted)]">No DoD gates stored yet. Every Verified gate requires an execution receipt.</div>}
                >
                  <For each={dodArtifacts()}>
                    {(g) => {
                      const gid = String(g.id ?? '');
                      return (
                        <div class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] flex items-center justify-between gap-2 text-[12px]">
                          <div class="min-w-0">
                            <div class="font-semibold truncate">{String(g.title ?? gid)}</div>
                            <div class="text-[10.5px] font-mono-num text-[var(--ink-muted)]">
                              status: {String(g.status ?? 'pending')}
                            </div>
                          </div>
                          <button
                            type="button"
                            class="omnia-btn px-2 py-0.5 text-[10.5px]"
                            onClick={async () => {
                              const r = await api.updateLifecycleDod(gid, 'verified', `verified-ui-${Date.now()}`);
                              setStatusNote(r.ok ? `DoD gate ${gid} verified with receipt` : `DoD (${r.error.code})`);
                              await loadAll();
                            }}
                          >
                            Mark Verified
                          </button>
                        </div>
                      );
                    }}
                  </For>
                </Show>
              </div>
            </div>
          </div>
        </Show>

        {/* 3. Handoff (AGENT_NOTES Preserved) & Super Workflow State */}
        <Show when={subTab() === 'handoff'}>
          <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div class="omnia-surface-panel rounded-lg p-4 space-y-2.5 text-[12px]">
              <div class="font-bold text-[13px] flex items-center gap-2">
                <GitBranch class="w-4 h-4 text-[var(--accent-amber)]" />
                <span>Atomic Handoff &amp; Checkpoint Writer (Preserves AGENT_NOTES)</span>
              </div>
              <textarea
                rows={3}
                placeholder="Completed verified summary..."
                value={handoffSummary()}
                onInput={(e) => setHandoffSummary(e.currentTarget.value)}
                class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5"
              />
              <input
                type="text"
                placeholder="Next executable atomic action..."
                value={handoffNext()}
                onInput={(e) => setHandoffNext(e.currentTarget.value)}
                class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5"
              />
              <textarea
                rows={2}
                placeholder="Optional AGENT_NOTES_START..END persistent notes..."
                value={handoffNotes()}
                onInput={(e) => setHandoffNotes(e.currentTarget.value)}
                class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5 font-mono-num text-[11px]"
              />
              <button
                type="button"
                class="omnia-btn omnia-btn-primary text-[11.5px]"
                onClick={async () => {
                  const r = await api.writeLifecycleHandoff(
                    handoffSummary().trim() || 'Checkpoint updated',
                    handoffNext().trim() || 'Resume remaining open gates',
                    handoffNotes().trim() || undefined,
                  );
                  setStatusNote(r.ok ? 'Handoff checkpoint written atomically' : `Handoff (${r.error.code}): ${r.error.message}`);
                  await loadAll();
                }}
              >
                Write Atomic Handoff
              </button>
            </div>

            <div class="omnia-surface-panel rounded-lg p-4 space-y-2">
              <div class="font-bold text-[13px] flex items-center gap-2">
                <Sparkles class="w-4 h-4 text-[var(--accent-cyan)]" />
                <span>Super-Plan / Super-Run Wave &amp; 3-Strike State</span>
              </div>
              <pre class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11px] font-mono-num max-h-72 overflow-auto whitespace-pre-wrap">
                {JSON.stringify(
                  maskJson(
                    {
                      superStatus: superStatus() ?? { mode: 'ready', autoProceed: proceedPolicy(), tokenBudget: null },
                      capabilities: superCaps() ?? { crates: 18, agentTools: 42, computerTools: 21 },
                      workflowState: superState() ?? { state: 'ready', tokenBudget: null },
                    },
                    privacyMask(),
                  ),
                  null,
                  2,
                )}
              </pre>
            </div>
          </div>
        </Show>

        {/* 4. 2-Tier Learn, Lessons & Crystallize -> Skill + Gap Radar */}
        <Show when={subTab() === 'learn'}>
          <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div class="omnia-surface-panel rounded-lg p-4 space-y-2.5 text-[12px] min-w-0">
              <div class="font-bold text-[13px] flex items-center gap-2">
                <GraduationCap class="w-4 h-4 text-[var(--status-emerald)]" />
                <span>2-Tier Auto-Learn &amp; Lessons ({lessons().length})</span>
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_130px] gap-2">
                <input
                  type="text"
                  placeholder="Lesson title..."
                  value={lessonTitle()}
                  onInput={(e) => setLessonTitle(e.currentTarget.value)}
                  class="min-w-0 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5"
                />
                <select
                  value={lessonScope()}
                  onChange={(e) => setLessonScope(e.currentTarget.value as 'project' | 'global')}
                  class="min-w-0 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1.5"
                >
                  <option value="project">Project Tier-1</option>
                  <option value="global">Global Tier-2</option>
                </select>
              </div>
              <textarea
                rows={2}
                placeholder="Reusable verified pitfall, invariant, or workflow lesson..."
                value={lessonBody()}
                onInput={(e) => setLessonBody(e.currentTarget.value)}
                class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5"
              />
              <div class="flex flex-wrap items-center gap-2">
                <button type="button" class="omnia-btn omnia-btn-primary text-[11.5px]" onClick={() => void handleCaptureLesson()}>
                  Capture Lesson
                </button>
                <button
                  type="button"
                  data-testid="lifecycle-sync-global-btn"
                  disabled={globalSyncBusy()}
                  class="omnia-btn text-[11.5px]"
                  title="Atomically mirror Global Tier-2 Lessons across OmniaData and Antigravity"
                  onClick={() => void handleSyncGlobalLessons()}
                >
                  <RefreshCw class="w-3.5 h-3.5 text-[var(--status-emerald)]" />
                  <span>{globalSyncBusy() ? 'Syncing Global...' : 'Sync Global Lessons'}</span>
                </button>
              </div>
              <Show when={globalSyncReceipt()}>
                <pre
                  data-testid="lifecycle-global-sync-receipt"
                  class="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[10.5px] font-mono-num max-h-28 overflow-auto"
                >
                  {JSON.stringify(maskJson(globalSyncReceipt(), privacyMask()), null, 2)}
                </pre>
              </Show>

              <div class="pt-2 border-t border-[var(--border-subtle)] grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-[11px]">
                <input
                  type="text"
                  placeholder="Target skill slug (e.g. win32-dpi-guard)"
                  value={promoteSlug()}
                  onInput={(e) => setPromoteSlug(e.currentTarget.value)}
                  class="min-w-0 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 font-mono-num"
                />
                <input
                  type="text"
                  placeholder="Use when ..."
                  value={promoteTrigger()}
                  onInput={(e) => setPromoteTrigger(e.currentTarget.value)}
                  class="min-w-0 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1"
                />
              </div>

              <div class="space-y-1.5 max-h-60 overflow-y-auto">
                <For each={lessons()}>
                  {(l) => {
                    const lid = String(l.id ?? '');
                    return (
                      <div class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] flex items-start justify-between gap-2">
                        <div class="min-w-0">
                          <div class="font-semibold text-[var(--ink-primary)]">{String(l.title ?? lid)}</div>
                          <div class="text-[11px] text-[var(--ink-secondary)] line-clamp-2">{String(l.lesson ?? l.content ?? '')}</div>
                        </div>
                        <button
                          type="button"
                          class="omnia-btn px-2 py-0.5 text-[10.5px] shrink-0"
                          onClick={() => void handlePromoteLesson(lid)}
                        >
                          Crystallize -&gt; Skill
                        </button>
                      </div>
                    );
                  }}
                </For>
              </div>
            </div>

            <div class="omnia-surface-panel rounded-lg p-4 space-y-2">
              <div class="font-bold text-[13px] flex items-center gap-2">
                <Radar class="w-4 h-4 text-[var(--accent-amber)]" />
                <span>Skill Gap Radar &amp; Semantic Overlap Telemetry</span>
              </div>
              <pre class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11px] font-mono-num max-h-80 overflow-auto whitespace-pre-wrap">
                {JSON.stringify(maskJson(gapRadar() ?? { gaps: [] }, privacyMask()), null, 2)}
              </pre>
            </div>
          </div>
        </Show>

        {/* 5. Deep Think Multi-Hypothesis Lab */}
        <Show when={subTab() === 'think'}>
          <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div class="omnia-surface-panel rounded-lg p-4 space-y-2.5 text-[12px] min-w-0">
              <div class="font-bold text-[13px] flex items-center gap-2">
                <Brain class="w-4 h-4 text-[var(--accent-amber)]" />
                <span>Deep Think Deliberation Engine (Hypotheses · Falsification · Red-Team)</span>
              </div>
              <div class="flex gap-2 min-w-0">
                <input
                  type="text"
                  placeholder="Frame complex engineering or math problem..."
                  value={thinkProblem()}
                  onInput={(e) => setThinkProblem(e.currentTarget.value)}
                  class="flex-1 min-w-0 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5"
                />
                <button type="button" class="omnia-btn omnia-btn-primary shrink-0 text-[11.5px]" onClick={() => void handleStartThink()}>
                  Start Think
                </button>
              </div>

              <Show when={activeThinkId()}>
                <div class="pt-2 border-t border-[var(--border-subtle)] space-y-1.5 min-w-0">
                  <div class="text-[11px] font-mono-num text-[var(--accent-cyan)]">Active Think ID: {activeThinkId()}</div>
                  <div class="grid grid-cols-[minmax(0,130px)_minmax(0,1fr)_auto] gap-1.5 items-center">
                    <input
                      type="text"
                      value={branchLabel()}
                      onInput={(e) => setBranchLabel(e.currentTarget.value)}
                      class="min-w-0 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11px]"
                    />
                    <input
                      type="text"
                      placeholder="Alternative hypothesis / contrarian design..."
                      value={branchHyp()}
                      onInput={(e) => setBranchHyp(e.currentTarget.value)}
                      class="min-w-0 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11px]"
                    />
                    <button type="button" class="omnia-btn shrink-0 px-2 py-1 text-[11px]" onClick={() => void handleAddBranch()}>
                      Add Branch
                    </button>
                  </div>
                </div>
              </Show>
            </div>

            <div class="omnia-surface-panel rounded-lg p-4 space-y-2">
              <div class="font-bold text-[13px]">Persisted Deep Think Sessions ({thinkSessions().length})</div>
              <div class="space-y-2 max-h-80 overflow-y-auto text-[11.5px] font-mono-num">
                <Show
                  when={thinkSessions().length > 0}
                  fallback={<div class="text-[var(--ink-muted)]">No Deep Think sessions recorded yet. Start one on the left or run a chat turn with Think: Auto/Deep.</div>}
                >
                  <For each={thinkSessions()}>
                    {(ts) => {
                      const tid = String(ts.id ?? ts.thinkId ?? '');
                      return (
                        <button
                          type="button"
                          onClick={() => setActiveThinkId(tid)}
                          class="w-full p-2.5 rounded border bg-[var(--bg-canvas)] text-left cursor-pointer space-y-1"
                          classList={{
                            'border-[var(--border-accent)]': activeThinkId() === tid,
                            'border-[var(--border-subtle)]': activeThinkId() !== tid,
                          }}
                        >
                          <div class="font-semibold text-[var(--ink-primary)]">{String(ts.problem ?? tid)}</div>
                          <div class="text-[10.5px] text-[var(--ink-muted)]">
                            stage:{String(ts.stage ?? 'active')} · branches:{Array.isArray(ts.branches) ? ts.branches.length : 0}
                          </div>
                        </button>
                      );
                    }}
                  </For>
                </Show>
              </div>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
