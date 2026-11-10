export type AgentJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentJob = {
  readonly id: string;
  readonly label: string;
  readonly dependencies: readonly string[];
  readonly capabilities: readonly string[];
  readonly status: AgentJobStatus;
  readonly workerId?: string;
  readonly error?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type AgentScheduler = {
  readonly version: 1;
  readonly jobs: readonly AgentJob[];
  readonly concurrency: number;
};

/** Read-side scheduler projection used by dispatchers and status surfaces. */
export type AgentSchedulerStats = {
  readonly total: number;
  readonly pending: number;
  readonly ready: number;
  readonly blocked: number;
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly concurrency: number;
  readonly availableSlots: number;
};

const statuses: readonly AgentJobStatus[] = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function stamp(): string {
  return new Date().toISOString();
}

function makeId(existingIds: ReadonlySet<string>): string {
  // A scheduler-local collision check keeps persistence/import and rapid
  // enqueue calls safe even when the clock/random source repeats.
  let id = "";
  do {
    id = `job_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 10)}`;
  } while (existingIds.has(id));
  return id;
}

function normalizeConcurrency(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function assertIsoTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be a valid ISO timestamp.`);
  }
}

function assertTimestampOrder(createdAt: string, updatedAt: string): void {
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error("Agent job updatedAt cannot precede createdAt.");
  }
}

function assertForwardTimestamp(previous: string, next: string): void {
  assertIsoTimestamp(next, "Agent job update time");
  if (Date.parse(next) < Date.parse(previous)) {
    throw new Error("Agent job update time cannot move backwards.");
  }
}

function normalizeText(value: string, field: string, fallback?: string): string {
  if (!isString(value)) throw new Error(`${field} must be a string.`);
  const normalized = value.trim();
  if (normalized.length === 0) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${field} must not be blank.`);
  }
  return normalized;
}

function normalizeStringList(
  values: readonly string[],
  field: string,
): readonly string[] {
  if (!Array.isArray(values)) throw new Error(`${field} must be an array.`);
  const normalized = values.map((value) => normalizeText(value, field));
  return [...new Set(normalized)];
}

function assertJobInvariant(job: AgentJob): void {
  if (!isString(job.id) || job.id.trim().length === 0) {
    throw new Error("Agent job ID must not be blank.");
  }
  if (!isString(job.label) || job.label.trim().length === 0) {
    throw new Error("Agent job label must not be blank.");
  }
  if (!Array.isArray(job.dependencies)) {
    throw new Error("Agent job dependencies must be an array.");
  }
  if (!Array.isArray(job.capabilities)) {
    throw new Error("Agent job capabilities must be an array.");
  }
  if (!isOneOf(statuses, job.status)) {
    throw new Error("Agent job status is invalid.");
  }
  assertIsoTimestamp(job.createdAt, "Agent job creation time");
  assertIsoTimestamp(job.updatedAt, "Agent job update time");
  assertTimestampOrder(job.createdAt, job.updatedAt);

  const dependencies = normalizeStringList(job.dependencies, "Agent job dependencies");
  if (new Set(dependencies).size !== job.dependencies.length) {
    throw new Error("Agent job dependencies must be unique.");
  }
  if (dependencies.includes(job.id)) {
    throw new Error("An agent job cannot depend on itself.");
  }

  const capabilities = normalizeStringList(job.capabilities, "Agent job capabilities");
  if (new Set(capabilities).size !== job.capabilities.length) {
    throw new Error("Agent job capabilities must be unique.");
  }

  if (job.workerId !== undefined && normalizeText(job.workerId, "Agent job worker ID") !== job.workerId) {
    throw new Error("Agent job worker ID must be trimmed.");
  }
  if (job.error !== undefined && normalizeText(job.error, "Agent job error") !== job.error) {
    throw new Error("Agent job error must be trimmed.");
  }
  if (job.status === "running" && job.workerId === undefined) {
    throw new Error("Running agent jobs require a worker ID.");
  }
}

function assertSchedulerInvariant(scheduler: AgentScheduler): void {
  if (!isRecord(scheduler) || scheduler.version !== 1) {
    throw new Error("Invalid agent scheduler version.");
  }
  if (!Array.isArray(scheduler.jobs)) {
    throw new Error("Agent scheduler jobs must be an array.");
  }
  if (!Number.isInteger(scheduler.concurrency) || scheduler.concurrency < 1) {
    throw new Error("Agent scheduler concurrency must be a positive integer.");
  }

  const ids = new Set<string>();
  for (const job of scheduler.jobs) {
    assertJobInvariant(job);
    if (ids.has(job.id)) throw new Error(`Duplicate agent job ID: ${job.id}`);
    ids.add(job.id);
  }

  // Validate references after all IDs are known, then reject dependency cycles
  // so an imported snapshot cannot permanently strand its queue.
  const byId = new Map(scheduler.jobs.map((job) => [job.id, job]));
  for (const job of scheduler.jobs) {
    for (const dependency of job.dependencies) {
      if (!byId.has(dependency)) {
        throw new Error(`Unknown agent job dependency: ${dependency}`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error("Agent scheduler dependencies contain a cycle.");
    visiting.add(id);
    const job = byId.get(id);
    if (job !== undefined) {
      for (const dependency of job.dependencies) visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const job of scheduler.jobs) visit(job.id);

  // Only enforce creation ordering after cycle detection so malformed cyclic
  // snapshots report the actionable graph error rather than an incidental
  // timestamp mismatch.
  for (const job of scheduler.jobs) {
    for (const dependency of job.dependencies) {
      const dependencyJob = byId.get(dependency);
      if (dependencyJob !== undefined && Date.parse(dependencyJob.createdAt) > Date.parse(job.createdAt)) {
        throw new Error("Agent job dependencies cannot be created after their dependent job.");
      }
    }
  }
}

function requireJob(scheduler: AgentScheduler, jobId: string): AgentJob {
  const normalizedId = normalizeText(jobId, "Agent job ID");
  const job = scheduler.jobs.find((candidate) => candidate.id === normalizedId);
  if (job === undefined) throw new Error(`Agent job was not found: ${normalizedId}`);
  return job;
}

function updateJob(
  scheduler: AgentScheduler,
  jobId: string,
  update: (job: AgentJob) => AgentJob,
): AgentScheduler {
  return {
    ...scheduler,
    jobs: scheduler.jobs.map((candidate) =>
      candidate.id === jobId ? update(candidate) : candidate,
    ),
  };
}

export function createAgentScheduler(concurrency = 1): AgentScheduler {
  const normalized = normalizeConcurrency(concurrency);
  return { version: 1, jobs: [], concurrency: normalized };
}

export function addAgentJob(
  scheduler: AgentScheduler,
  label: string,
  dependencies: readonly string[] = [],
  capabilities: readonly string[] = [],
  now = stamp(),
): AgentScheduler {
  assertSchedulerInvariant(scheduler);
  assertIsoTimestamp(now, "Agent job creation time");
  const normalizedDependencies = normalizeStringList(
    dependencies,
    "Agent job dependencies",
  );
  const knownIds = new Set(scheduler.jobs.map((job) => job.id));
  if (normalizedDependencies.some((dependency) => !knownIds.has(dependency))) {
    throw new Error("Agent job dependencies must reference existing jobs.");
  }
  const id = makeId(knownIds);
  if (normalizedDependencies.includes(id)) {
    throw new Error("An agent job cannot depend on itself.");
  }
  const job: AgentJob = {
    id,
    label: normalizeText(label, "Agent job label", "Untitled job"),
    dependencies: normalizedDependencies,
    capabilities: normalizeStringList(capabilities, "Agent job capabilities"),
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  const next = { ...scheduler, jobs: [...scheduler.jobs, job] };
  assertSchedulerInvariant(next);
  return next;
}

export function getReadyAgentJobs(
  scheduler: AgentScheduler,
): readonly AgentJob[] {
  assertSchedulerInvariant(scheduler);
  const completed = new Set(
    scheduler.jobs
      .filter((job) => job.status === "completed")
      .map((job) => job.id),
  );
  const running = scheduler.jobs.filter((job) => job.status === "running").length;
  const available = scheduler.concurrency - running;
  if (available <= 0) return [];
  return scheduler.jobs
    .filter(
      (job) =>
        job.status === "pending" &&
        job.dependencies.every((dependency) => completed.has(dependency)),
    )
    .slice(0, available);
}

/** Return one job by ID after validating the scheduler snapshot. */
export function getAgentJob(
  scheduler: AgentScheduler,
  jobId: string,
): AgentJob | undefined {
  assertSchedulerInvariant(scheduler);
  const normalizedId = normalizeText(jobId, "Agent job ID");
  return scheduler.jobs.find((job) => job.id === normalizedId);
}

/** Return pending jobs that are waiting for one or more dependencies. */
export function getBlockedAgentJobs(
  scheduler: AgentScheduler,
): readonly AgentJob[] {
  assertSchedulerInvariant(scheduler);
  const completed = new Set(
    scheduler.jobs
      .filter((job) => job.status === "completed")
      .map((job) => job.id),
  );
  return scheduler.jobs.filter(
    (job) =>
      job.status === "pending" &&
      !job.dependencies.every((dependency) => completed.has(dependency)),
  );
}

/** Calculate queue counts without exposing mutable scheduler internals. */
export function getAgentSchedulerStats(
  scheduler: AgentScheduler,
): AgentSchedulerStats {
  assertSchedulerInvariant(scheduler);
  const running = scheduler.jobs.filter((job) => job.status === "running").length;
  const pending = scheduler.jobs.filter((job) => job.status === "pending");
  const completed = new Set(
    scheduler.jobs
      .filter((job) => job.status === "completed")
      .map((job) => job.id),
  );
  const ready = pending.filter((job) =>
    job.dependencies.every((dependency) => completed.has(dependency)),
  ).length;
  const counts = {
    pending: pending.length,
    running,
    completed: scheduler.jobs.filter((job) => job.status === "completed").length,
    failed: scheduler.jobs.filter((job) => job.status === "failed").length,
    cancelled: scheduler.jobs.filter((job) => job.status === "cancelled").length,
  };
  return {
    total: scheduler.jobs.length,
    ...counts,
    ready,
    blocked: pending.length - ready,
    concurrency: scheduler.concurrency,
    availableSlots: Math.max(0, scheduler.concurrency - running),
  };
}

/** Public validation entry point for hydration/import boundaries. */
export function validateAgentScheduler(scheduler: AgentScheduler): AgentScheduler {
  assertSchedulerInvariant(scheduler);
  return scheduler;
}

function assertWorkerFence(job: AgentJob, workerId: string | undefined): void {
  if (workerId === undefined) return;
  const normalizedWorkerId = normalizeText(workerId, "Agent worker ID");
  if (job.workerId !== normalizedWorkerId) {
    throw new Error(`Agent job worker fence rejected: ${job.id}`);
  }
}

export function claimAgentJob(
  scheduler: AgentScheduler,
  jobId: string,
  workerId: string,
  now = stamp(),
): AgentScheduler {
  assertSchedulerInvariant(scheduler);
  const job = requireJob(scheduler, jobId);
  const normalizedWorkerId = normalizeText(workerId, "Agent worker ID");
  assertForwardTimestamp(job.updatedAt, now);
  const running = scheduler.jobs.filter((candidate) => candidate.status === "running").length;
  if (running >= scheduler.concurrency) {
    throw new Error("Scheduler concurrency limit reached.");
  }
  const completed = new Set(
    scheduler.jobs
      .filter((candidate) => candidate.status === "completed")
      .map((candidate) => candidate.id),
  );
  if (
    job.status !== "pending" ||
    !job.dependencies.every((dependency) => completed.has(dependency))
  ) {
    throw new Error(`Agent job is not ready: ${job.id}`);
  }
  // Do not use getReadyAgentJobs() here: that function intentionally returns
  // only a capacity-sized preview, while an explicit claim may target any
  // ready job in the queue.
  return updateJob(scheduler, job.id, (candidate) => ({
    ...candidate,
    status: "running",
    workerId: normalizedWorkerId,
    updatedAt: now,
  }));
}

export function completeAgentJob(
  scheduler: AgentScheduler,
  jobId: string,
  now = stamp(),
  workerId?: string,
): AgentScheduler {
  assertSchedulerInvariant(scheduler);
  const job = requireJob(scheduler, jobId);
  if (job.status !== "running") {
    throw new Error(`Only running agent jobs can complete: ${job.id}`);
  }
  assertWorkerFence(job, workerId);
  assertForwardTimestamp(job.updatedAt, now);
  return updateJob(scheduler, job.id, (candidate) => ({
    ...candidate,
    status: "completed",
    updatedAt: now,
  }));
}

export function failAgentJob(
  scheduler: AgentScheduler,
  jobId: string,
  error: string,
  now = stamp(),
  workerId?: string,
): AgentScheduler {
  assertSchedulerInvariant(scheduler);
  const job = requireJob(scheduler, jobId);
  if (job.status !== "running") {
    throw new Error(`Only running agent jobs can fail: ${job.id}`);
  }
  assertWorkerFence(job, workerId);
  assertForwardTimestamp(job.updatedAt, now);
  return updateJob(scheduler, job.id, (candidate) => ({
    ...candidate,
    status: "failed",
    error: normalizeText(error, "Agent job error"),
    updatedAt: now,
  }));
}

/** Return an active lease to the queue without retaining stale worker state. */
export function releaseAgentJob(
  scheduler: AgentScheduler,
  jobId: string,
  now = stamp(),
  workerId?: string,
): AgentScheduler {
  assertSchedulerInvariant(scheduler);
  const job = requireJob(scheduler, jobId);
  if (job.status !== "running") {
    throw new Error(`Only running agent jobs can be released: ${job.id}`);
  }
  assertWorkerFence(job, workerId);
  assertForwardTimestamp(job.updatedAt, now);
  return updateJob(scheduler, job.id, (candidate) => {
    const { workerId: _workerId, error: _error, ...released } = candidate;
    return {
      ...released,
      status: "pending",
      updatedAt: now,
    };
  });
}

/** Retry a failed job explicitly; release remains reserved for active leases. */
export function retryAgentJob(
  scheduler: AgentScheduler,
  jobId: string,
  now = stamp(),
): AgentScheduler {
  assertSchedulerInvariant(scheduler);
  const job = requireJob(scheduler, jobId);
  if (job.status !== "failed") {
    throw new Error(`Only failed agent jobs can be retried: ${job.id}`);
  }
  assertForwardTimestamp(job.updatedAt, now);
  return updateJob(scheduler, job.id, (candidate) => {
    const { workerId: _workerId, error: _error, ...retried } = candidate;
    return {
      ...retried,
      status: "pending",
      updatedAt: now,
    };
  });
}

export function cancelAgentJob(
  scheduler: AgentScheduler,
  jobId: string,
  now = stamp(),
): AgentScheduler {
  assertSchedulerInvariant(scheduler);
  const job = requireJob(scheduler, jobId);
  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    throw new Error(`Terminal agent jobs cannot be cancelled: ${job.id}`);
  }
  assertForwardTimestamp(job.updatedAt, now);
  return updateJob(scheduler, job.id, (candidate) => ({
    ...candidate,
    status: "cancelled",
    updatedAt: now,
  }));
}

function parseJob(value: unknown): AgentJob {
  if (
    !isRecord(value) ||
    !isString(value.id) ||
    !isString(value.label) ||
    !Array.isArray(value.dependencies) ||
    !value.dependencies.every(isString) ||
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every(isString) ||
    !isOneOf(statuses, value.status) ||
    !isString(value.createdAt) ||
    !isString(value.updatedAt) ||
    (value.workerId !== undefined && !isString(value.workerId)) ||
    (value.error !== undefined && !isString(value.error))
  ) {
    throw new Error("Invalid agent job.");
  }
  const job: AgentJob = {
    id: value.id,
    label: value.label,
    dependencies: [...value.dependencies],
    capabilities: [...value.capabilities],
    status: value.status,
    ...(value.workerId === undefined ? {} : { workerId: value.workerId }),
    ...(value.error === undefined ? {} : { error: value.error }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  assertJobInvariant(job);
  return job;
}

export function deserializeAgentScheduler(
  input: string | unknown,
): AgentScheduler {
  let value: unknown;
  try {
    value = typeof input === "string" ? (JSON.parse(input) as unknown) : input;
  } catch (error) {
    throw new Error("Invalid agent scheduler JSON.", { cause: error });
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.jobs) ||
    typeof value.concurrency !== "number" ||
    !Number.isInteger(value.concurrency) ||
    value.concurrency < 1
  ) {
    throw new Error("Invalid agent scheduler.");
  }
  const scheduler: AgentScheduler = {
    version: 1,
    jobs: value.jobs.map(parseJob),
    concurrency: value.concurrency,
  };
  assertSchedulerInvariant(scheduler);
  return scheduler;
}

export function serializeAgentScheduler(scheduler: AgentScheduler): string {
  assertSchedulerInvariant(scheduler);
  return JSON.stringify(scheduler, null, 2);
}
