import { useEffect, useState, type ReactNode } from "react";

import { useAgentStore, type SessionActivity } from "./agent-store";
import { contextUsage, formatTokens } from "./format";
import type { ShellView } from "./shell-view";
import type { LiveState } from "./transcript";
import { Popover } from "./ui";
import "./status-bar.css";

const MINUTE = 60_000;

/** "12s ago", "4m ago", "3h ago", "2d ago". */
export function agoLabel(thenMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** "0:42", "12:05", "1:02:03". */
export function clockLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

const absolute = (ms: number) => new Date(ms).toLocaleString();

/** Re-renders on a timer; `interval` null stops ticking. */
function useNow(interval: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (interval === null) return;
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

function Segment({ label, text, title, tone, priority, children }: {
  label: string;
  text: ReactNode;
  title?: string | undefined;
  tone?: "warn" | "danger" | "active" | undefined;
  /** 1 always shows; 2 and 3 hide first when the bar is narrow. */
  priority: 1 | 2 | 3;
  children: ReactNode;
}) {
  return (
    <span className={`ag-sb__seg ag-sb__seg--p${priority}`}>
      <Popover
        label={label}
        className={`ag-sb__btn${tone ? ` ag-sb__btn--${tone}` : ""}`}
        trigger={<span className="ag-sb__text" title={title}>{text}</span>}
      >
        {() => <dl className="ag-sb__details">{children}</dl>}
      </Popover>
    </span>
  );
}

const Row = ({ term, children }: { term: string; children: ReactNode }) => (
  <div className="ag-sb__row"><dt>{term}</dt><dd>{children}</dd></div>
);

/** `at` is the live request time; `fallbackAt` (last saved session activity) covers restarts before any new request. */
function LastRequest({ at, fallbackAt = null, activity, now }: { at: number | null; fallbackAt?: number | null; activity?: SessionActivity | undefined; now: number }) {
  const shown = at ?? fallbackAt;
  if (shown === null) {
    return (
      <Segment label="No requests yet" text="No requests yet" priority={1}>
        <Row term="Last request">None since the app started</Row>
      </Segment>
    );
  }
  return (
    <Segment label={`Last request ${agoLabel(shown, now)}, at ${absolute(shown)}`} text={`Last request ${agoLabel(shown, now)}`} title={absolute(shown)} priority={1}>
      <Row term="Last request">{absolute(shown)}</Row>
      {at === null ? <Row term="Source">Last saved session activity</Row> : null}
      <Row term="Elapsed">{agoLabel(shown, now)}</Row>
      {activity?.lastRunMs != null ? <Row term="Last run took">{clockLabel(activity.lastRunMs)}</Row> : null}
    </Segment>
  );
}

function tickInterval(running: boolean, lastRequestAt: number | null): number | null {
  if (running) return 1000;
  if (lastRequestAt === null) return null;
  return Date.now() - lastRequestAt < MINUTE ? 1000 : 30_000;
}

/** Always-visible ~24px bar at the bottom of the main area; session details in the agent view, global ones elsewhere. */
export function StatusBar({ view }: { view: ShellView }) {
  const activeId = useAgentStore((state) => state.activeId);
  const sessions = useAgentStore((state) => state.sessions);
  const live = useAgentStore((state) => (state.activeId ? state.live[state.activeId] : undefined));
  const activity = useAgentStore((state) => (state.activeId ? state.activity[state.activeId] : undefined));
  const globalLast = useAgentStore((state) => state.lastRequestAt);
  const allLive = useAgentStore((state) => state.live);
  const notice = useAgentStore((state) => state.notice);

  const session = view === "agent" && activeId ? sessions.find((entry) => entry.id === activeId) : undefined;
  const runningCount = sessions.filter((entry) => entry.running).length;
  const waitingCount = sessions.filter((entry) => (allLive[entry.id]?.approvals.length ?? 0) > 0).length;

  const running = session ? (live?.running ?? session.running) : runningCount > 0;
  const lastAt = session ? (activity?.lastRequestAt ?? null) : globalLast;
  const fallbackAt = session ? session.updatedAtMs : sessions.reduce<number | null>((latest, entry) => (latest === null || entry.updatedAtMs > latest ? entry.updatedAtMs : latest), null);
  // Ticks only while something is live: running timer, or a recent "Ns ago".
  const now = useNow(tickInterval(Boolean(session && running && activity?.runStartedAt != null), lastAt ?? fallbackAt));

  return (
    <footer className="ag-sb" aria-label="Status bar">
      {session ? (
        <SessionSegments session={session} live={live} activity={activity} notice={notice} now={now} />
      ) : (
        <>
          <Segment
            label={`${runningCount} running ${runningCount === 1 ? "session" : "sessions"}${waitingCount ? `, ${waitingCount} waiting for approval` : ""}`}
            text={waitingCount ? `${waitingCount} waiting for approval` : runningCount ? `${runningCount} running` : "Idle"}
            tone={waitingCount ? "warn" : runningCount ? "active" : undefined}
            priority={1}
          >
            <Row term="Running sessions">{runningCount}</Row>
            <Row term="Waiting for approval">{waitingCount}</Row>
            <Row term="Sessions">{sessions.length}</Row>
            {sessions.filter((entry) => entry.running).slice(0, 5).map((entry) => (
              <Row key={entry.id} term="Running">{entry.title || entry.id}</Row>
            ))}
          </Segment>
          <LastRequest at={lastAt} fallbackAt={fallbackAt} now={now} />
          {notice ? <NoticeSegment errors={[]} notice={notice} /> : null}
        </>
      )}
    </footer>
  );
}

function NoticeSegment({ errors, notice }: { errors: string[]; notice: string | null }) {
  const text = errors.length ? `${errors.length} ${errors.length === 1 ? "error" : "errors"}` : "1 notice";
  return (
    <Segment label={`${text}. Show details`} text={text} tone="danger" priority={1}>
      {notice ? <Row term="Notice">{notice}</Row> : null}
      {errors.slice(-5).map((message, index) => (
        <Row key={index} term="Error">{message.length > 240 ? `${message.slice(0, 237)}...` : message}</Row>
      ))}
      {errors.length > 5 ? <Row term="Earlier">{errors.length - 5} more in the transcript</Row> : null}
    </Segment>
  );
}

function SessionSegments({ session, live, activity, notice, now }: {
  session: { profileId: string; model: string; tokensUsed?: number; tokenBudget?: number | null; running: boolean; updatedAtMs: number };
  live: LiveState | undefined;
  activity: SessionActivity | undefined;
  notice: string | null;
  now: number;
}) {
  const waiting = (live?.approvals.length ?? 0) > 0;
  const running = live?.running ?? session.running;
  const started = activity?.runStartedAt ?? null;
  const stateText = waiting ? "Waiting for approval" : running ? (started !== null ? `Running ${clockLabel(now - started)}` : "Running") : "Idle";
  const model = live?.activeModel ?? session.model;
  const contextSource = live?.contextUsage ?? null;
  const ctx = contextSource ? contextUsage(contextSource, model) : null;
  const usage = live?.usage ?? null;
  const budget = session.tokenBudget && session.tokenBudget > 0 && session.tokensUsed !== undefined
    ? Math.min(100, Math.round((session.tokensUsed / session.tokenBudget) * 100)) : null;
  const errors = (live?.items ?? []).flatMap((item) => (item.kind === "error" ? [item.message] : []));

  return (
    <>
      <Segment label={`Run state: ${stateText}`} text={stateText} tone={waiting ? "warn" : running ? "active" : undefined} priority={1}>
        <Row term="State">{stateText}</Row>
        {waiting ? <Row term="Pending approvals">{live?.approvals.length}</Row> : null}
        {started !== null ? <Row term="Started">{absolute(started)}</Row> : null}
        {activity?.lastRunMs != null ? <Row term="Last run took">{clockLabel(activity.lastRunMs)}</Row> : null}
        {live?.retry ? <Row term="Retrying">{`Attempt ${live.retry.attempt}: ${live.retry.message}`}</Row> : null}
      </Segment>
      <Segment label={`Model ${model}, profile ${session.profileId}`} text={model} priority={2}>
        <Row term="Profile">{session.profileId}</Row>
        <Row term="Model id">{model}</Row>
        {model !== session.model ? <Row term="Configured model">{session.model}</Row> : null}
      </Segment>
      {ctx ? (
        <Segment
          label={`Context ${formatTokens(ctx.used)} of ${formatTokens(ctx.window)}, ${ctx.percent}%`}
          text={`${formatTokens(ctx.used)} / ${formatTokens(ctx.window)} (${ctx.percent}%)`}
          tone={ctx.warn ? "warn" : undefined}
          priority={2}
        >
          <Row term="Context used">{ctx.used.toLocaleString()}</Row>
          <Row term="Context window">{ctx.window.toLocaleString()}</Row>
          <Row term="Input">{contextSource!.input_tokens.toLocaleString()}</Row>
          <Row term="Cache reads">{contextSource!.cache_read_tokens.toLocaleString()}</Row>
          <Row term="Cache writes">{contextSource!.cache_write_tokens.toLocaleString()}</Row>
          <Row term="Note">Latest completed prompt; estimated window and warning use model defaults. Configured limits may differ.</Row>
        </Segment>
      ) : null}
      {usage ? (
        <Segment
          label={`Last run tokens: ${formatTokens(usage.input_tokens)} in, ${formatTokens(usage.output_tokens)} out`}
          text={`${formatTokens(usage.input_tokens)} in · ${formatTokens(usage.output_tokens)} out`}
          priority={3}
        >
          <Row term="Input (last run)">{usage.input_tokens.toLocaleString()}</Row>
          <Row term="Output (last run)">{usage.output_tokens.toLocaleString()}</Row>
          <Row term="Cache reads">{usage.cache_read_tokens.toLocaleString()}</Row>
          <Row term="Cache writes">{usage.cache_write_tokens.toLocaleString()}</Row>
          <Row term="Scope">Completed main turns only; excludes summaries, subagents and interrupted calls.</Row>
          {session.tokensUsed !== undefined ? <Row term="Session total">{session.tokensUsed.toLocaleString()}</Row> : null}
        </Segment>
      ) : session.tokensUsed ? (
        <Segment label={`Session tokens: ${formatTokens(session.tokensUsed)}`} text={`${formatTokens(session.tokensUsed)} tokens`} priority={3}>
          <Row term="Session total">{session.tokensUsed.toLocaleString()}</Row>
        </Segment>
      ) : null}
      {budget !== null ? (
        <Segment label={`Token budget ${budget}% used`} text={`Budget ${budget}%`} tone={budget >= 80 ? "warn" : undefined} priority={3}>
          <Row term="Used">{session.tokensUsed!.toLocaleString()}</Row>
          <Row term="Budget">{session.tokenBudget!.toLocaleString()}</Row>
          <Row term="Updated">Saved session total; refreshes when the run finishes.</Row>
        </Segment>
      ) : null}
      <LastRequest at={activity?.lastRequestAt ?? null} fallbackAt={session.updatedAtMs} activity={activity} now={now} />
      {errors.length || notice ? <NoticeSegment errors={errors} notice={notice} /> : null}
    </>
  );
}
