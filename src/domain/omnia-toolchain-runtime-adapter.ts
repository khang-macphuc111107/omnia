import { assertDomain, isDomainError } from "./errors";
import { assertNonBlank, type IsoTimestamp } from "./shared";

/**
 * Renderer/native-safe toolchain runtime contract.
 *
 * The compiler preview can use the catalog and command planner without having
 * shell authority.  A native implementation is supplied through `port`; the
 * default browser adapter intentionally returns a typed unavailable result.
 */
export const TOOLCHAIN_RUNTIME_SCHEMA_VERSION = 1 as const;

export const TOOLCHAIN_RUNTIME_IDS = Object.freeze([
  "node",
  "python",
  "rust",
  "cpp",
  "go",
  "java",
  "dotnet",
  "julia",
  "r",
  "fortran",
  "cuda",
  "swift",
  "sql",
] as const);
export type ToolchainRuntimeId = (typeof TOOLCHAIN_RUNTIME_IDS)[number];

export const TOOLCHAIN_RUNTIME_TARGETS = Object.freeze(["dev", "test", "build", "lint"] as const);
export type ToolchainRuntimeTarget = (typeof TOOLCHAIN_RUNTIME_TARGETS)[number];

export const TOOLCHAIN_RUNTIME_PROFILES = Object.freeze(["debug", "release", "research"] as const);
export type ToolchainRuntimeProfile = (typeof TOOLCHAIN_RUNTIME_PROFILES)[number];

export type ToolchainRuntimeErrorCode =
  | "toolchain_runtime_unavailable"
  | "invalid_plan"
  | "not_found"
  | "permission_denied"
  | "unsupported"
  | "native_error";

export type ToolchainRuntimeFailure = {
  readonly ok: false;
  readonly code: ToolchainRuntimeErrorCode;
  readonly reason: string;
};

export type ToolchainRuntimeResult<T> =
  | { readonly ok: true; readonly value: T }
  | ToolchainRuntimeFailure;

export type ToolchainRuntimeDescriptor = {
  readonly id: ToolchainRuntimeId;
  readonly label: string;
  readonly executable: string;
  readonly family: string;
  readonly defaultArgs: Readonly<Record<ToolchainRuntimeTarget, readonly string[]>>;
};

const descriptor = (
  id: ToolchainRuntimeId,
  label: string,
  executable: string,
  family: string,
  defaultArgs: Readonly<Record<ToolchainRuntimeTarget, readonly string[]>>,
): ToolchainRuntimeDescriptor => Object.freeze({
  id,
  label,
  executable,
  family,
  defaultArgs: Object.freeze(Object.fromEntries(
    Object.entries(defaultArgs).map(([target, args]) => [target, Object.freeze([...args])]),
  ) as Record<ToolchainRuntimeTarget, readonly string[]>),
});

export const TOOLCHAIN_RUNTIME_CATALOG: readonly ToolchainRuntimeDescriptor[] = Object.freeze([
  descriptor("node", "Node.js", "npm", "JavaScript · TypeScript", {
    dev: ["run", "dev"], test: ["run", "test"], build: ["run", "build"], lint: ["run", "lint"],
  }),
  descriptor("python", "Python", "python", "Python · data · AI", {
    dev: ["-m", "http.server"], test: ["-m", "pytest"], build: ["-m", "compileall", "."], lint: ["-m", "compileall", "--quiet", "."],
  }),
  descriptor("rust", "Rust", "cargo", "Rust · Cargo · Tauri", {
    dev: ["run"], test: ["test"], build: ["build"], lint: ["fmt", "--", "--check"],
  }),
  descriptor("cpp", "C++ · CMake", "cmake", "C · C++ · systems", {
    dev: ["--build", "build"], test: ["--build", "build", "--target", "test"], build: ["--build", "build"], lint: ["--build", "build", "--target", "lint"],
  }),
  descriptor("go", "Go", "go", "Go · modules", {
    dev: ["run", "."], test: ["test", "./..."], build: ["build", "./..."], lint: ["vet", "./..."],
  }),
  descriptor("java", "Java · JDK", "java", "Java · JVM", {
    dev: ["-version"], test: ["-version"], build: ["-version"], lint: ["-version"],
  }),
  descriptor("dotnet", ".NET", "dotnet", "C# · F# · .NET", {
    dev: ["run"], test: ["test"], build: ["build"], lint: ["format", "--verify-no-changes"],
  }),
  descriptor("julia", "Julia", "julia", "Julia · scientific computing", {
    dev: ["--project", "-e", "using Pkg; Pkg.instantiate()"], test: ["--project", "-e", "using Pkg; Pkg.test()"], build: ["--project", "-e", "using Pkg; Pkg.precompile()"], lint: ["--version"],
  }),
  descriptor("r", "R", "Rscript", "R · statistics", {
    dev: ["--version"], test: ["-e", "if (requireNamespace('testthat', quietly=TRUE)) testthat::test_dir('tests')"], build: ["--version"], lint: ["--version"],
  }),
  descriptor("fortran", "Fortran", "cmake", "Fortran · HPC", {
    dev: ["--build", "build"], test: ["--build", "build", "--target", "test"], build: ["--build", "build"], lint: ["--build", "build", "--target", "lint"],
  }),
  descriptor("cuda", "CUDA Toolkit", "nvcc", "CUDA · GPU computing", {
    dev: ["--version"], test: ["--version"], build: ["--version"], lint: ["--version"],
  }),
  descriptor("swift", "Swift", "swift", "Swift · SwiftPM", {
    dev: ["run"], test: ["test"], build: ["build"], lint: ["package", "dump-package"],
  }),
  descriptor("sql", "SQL · notebooks", "jupyter", "SQL · DuckDB · notebooks", {
    dev: ["lab"], test: ["--version"], build: ["--version"], lint: ["--version"],
  }),
]);

export type ToolchainDiscoveryStatus = "detected" | "not-found" | "unsupported" | "permission-denied" | "error" | "unavailable";

export type ToolchainDiscovery = {
  readonly schemaVersion: typeof TOOLCHAIN_RUNTIME_SCHEMA_VERSION;
  readonly toolchainId: ToolchainRuntimeId;
  readonly status: ToolchainDiscoveryStatus;
  readonly checkedAt: IsoTimestamp;
  readonly executable?: string;
  readonly version?: string;
  readonly reason?: string;
};

export type ToolchainRuntimeCapabilities = {
  readonly schemaVersion: typeof TOOLCHAIN_RUNTIME_SCHEMA_VERSION;
  readonly processExecution: "available" | "unavailable";
  readonly compilerDiscovery: "available" | "unavailable";
  readonly filesystem: "native-port" | "renderer-only";
};

export type ToolchainCommandPlan = {
  readonly schemaVersion: typeof TOOLCHAIN_RUNTIME_SCHEMA_VERSION;
  readonly toolchainId: ToolchainRuntimeId;
  readonly target: ToolchainRuntimeTarget;
  readonly profile: ToolchainRuntimeProfile;
  /** Executable and arguments remain separate: no shell command is accepted. */
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly sandbox: boolean;
  readonly network: boolean;
  readonly cache: boolean;
  readonly watch: boolean;
};

export type PlanToolchainCommandInput = {
  readonly toolchainId: ToolchainRuntimeId;
  readonly target: ToolchainRuntimeTarget;
  readonly profile?: ToolchainRuntimeProfile;
  readonly cwd: string;
  readonly extraArgs?: readonly string[];
  readonly sandbox?: boolean;
  readonly network?: boolean;
  readonly cache?: boolean;
  readonly watch?: boolean;
};

export type ToolchainExecutionReceipt = {
  readonly schemaVersion: typeof TOOLCHAIN_RUNTIME_SCHEMA_VERSION;
  readonly status: "completed" | "failed" | "cancelled";
  readonly exitCode?: number | null;
  readonly durationMs?: number;
  readonly stdout?: string;
  readonly stderr?: string;
};

export interface ToolchainRuntimePort {
  readonly inspectCapabilities?: () => Promise<ToolchainRuntimeResult<ToolchainRuntimeCapabilities>>;
  readonly discover?: (toolchainId: ToolchainRuntimeId) => Promise<ToolchainRuntimeResult<ToolchainDiscovery>>;
  readonly execute?: (plan: ToolchainCommandPlan) => Promise<ToolchainRuntimeResult<ToolchainExecutionReceipt>>;
}

export type OmniaToolchainRuntimeAdapterOptions = {
  readonly port?: ToolchainRuntimePort;
  readonly now?: () => IsoTimestamp;
};

const MAX_ARGS = 32;
const MAX_ARG_LENGTH = 256;
const MAX_CWD_LENGTH = 1024;

function isToolchainId(value: string): value is ToolchainRuntimeId {
  return (TOOLCHAIN_RUNTIME_IDS as readonly string[]).includes(value);
}

function isTarget(value: string): value is ToolchainRuntimeTarget {
  return (TOOLCHAIN_RUNTIME_TARGETS as readonly string[]).includes(value);
}

function isProfile(value: string): value is ToolchainRuntimeProfile {
  return (TOOLCHAIN_RUNTIME_PROFILES as readonly string[]).includes(value);
}

function assertSafeArg(value: string, label: string): string {
  const normalized = assertNonBlank(value, label, MAX_ARG_LENGTH);
  assertDomain(!/[\u0000-\u001f\u007f]/.test(normalized), "invalid_argument", `${label} contains a control character.`);
  return normalized;
}

function failureFrom(error: unknown): ToolchainRuntimeFailure {
  if (isDomainError(error)) {
    const code: ToolchainRuntimeErrorCode = error.code === "permission_denied" ? "permission_denied" : "invalid_plan";
    return { ok: false, code, reason: error.message };
  }
  return {
    ok: false,
    code: "native_error",
    reason: error instanceof Error && error.message.trim() ? error.message : "Toolchain runtime operation failed.",
  };
}

function unavailable(reason: string): ToolchainRuntimeFailure {
  return { ok: false, code: "toolchain_runtime_unavailable", reason };
}

export function getToolchainRuntimeDescriptor(toolchainId: ToolchainRuntimeId): ToolchainRuntimeDescriptor {
  return TOOLCHAIN_RUNTIME_CATALOG.find((entry) => entry.id === toolchainId) ?? TOOLCHAIN_RUNTIME_CATALOG[0]!;
}

export function validateToolchainCommandPlan(plan: ToolchainCommandPlan): ToolchainCommandPlan {
  assertDomain(plan.schemaVersion === TOOLCHAIN_RUNTIME_SCHEMA_VERSION, "invalid_argument", "Unsupported toolchain command plan schema.");
  assertDomain(isToolchainId(plan.toolchainId), "invalid_argument", "Unknown toolchain ID.");
  assertDomain(isTarget(plan.target), "invalid_argument", "Unknown toolchain target.");
  assertDomain(isProfile(plan.profile), "invalid_argument", "Unknown toolchain build profile.");
  assertSafeArg(plan.executable, "Toolchain executable");
  assertDomain(Array.isArray(plan.args), "invalid_argument", "Toolchain args must be an array.");
  assertDomain(plan.args.length <= MAX_ARGS, "invalid_argument", `Toolchain args cannot exceed ${MAX_ARGS} entries.`);
  plan.args.forEach((arg, index) => assertSafeArg(arg, `Toolchain arg ${index + 1}`));
  assertSafeArg(plan.cwd, "Toolchain working directory");
  assertDomain(plan.cwd.length <= MAX_CWD_LENGTH, "invalid_argument", `Toolchain working directory cannot exceed ${MAX_CWD_LENGTH} characters.`);
  return Object.freeze({ ...plan, args: Object.freeze([...plan.args]) });
}

/** Pure command planning; it never parses or concatenates shell command text. */
export function planToolchainCommand(input: PlanToolchainCommandInput): ToolchainRuntimeResult<ToolchainCommandPlan> {
  try {
    assertDomain(isToolchainId(input.toolchainId), "invalid_argument", "Unknown toolchain ID.");
    assertDomain(isTarget(input.target), "invalid_argument", "Unknown toolchain target.");
    const toolchain = getToolchainRuntimeDescriptor(input.toolchainId);
    const cwd = assertSafeArg(input.cwd, "Toolchain working directory");
    assertDomain(cwd.length <= MAX_CWD_LENGTH, "invalid_argument", `Toolchain working directory cannot exceed ${MAX_CWD_LENGTH} characters.`);
    const extraArgs = input.extraArgs ?? [];
    assertDomain(Array.isArray(extraArgs), "invalid_argument", "Toolchain extraArgs must be an array.");
    assertDomain(extraArgs.length + toolchain.defaultArgs[input.target].length <= MAX_ARGS, "invalid_argument", `Toolchain args cannot exceed ${MAX_ARGS} entries.`);
    const profile = input.profile ?? "debug";
    assertDomain(isProfile(profile), "invalid_argument", "Unknown toolchain build profile.");
    const args = [...toolchain.defaultArgs[input.target], ...extraArgs.map((arg, index) => assertSafeArg(arg, `Toolchain extra arg ${index + 1}`))];
    return {
      ok: true,
      value: validateToolchainCommandPlan({
        schemaVersion: TOOLCHAIN_RUNTIME_SCHEMA_VERSION,
        toolchainId: input.toolchainId,
        target: input.target,
        profile,
        executable: toolchain.executable,
        args,
        cwd,
        sandbox: input.sandbox ?? true,
        network: input.network ?? false,
        cache: input.cache ?? true,
        watch: input.watch ?? false,
      }),
    };
  } catch (error) {
    return failureFrom(error);
  }
}

export class OmniaToolchainRuntimeAdapter {
  private readonly port: ToolchainRuntimePort;
  private readonly now: () => IsoTimestamp;

  public constructor(options: OmniaToolchainRuntimeAdapterOptions = {}) {
    this.port = options.port ?? {};
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public getCatalog(): readonly ToolchainRuntimeDescriptor[] {
    return TOOLCHAIN_RUNTIME_CATALOG;
  }

  public plan(input: PlanToolchainCommandInput): ToolchainRuntimeResult<ToolchainCommandPlan> {
    return planToolchainCommand(input);
  }

  public async inspectCapabilities(): Promise<ToolchainRuntimeResult<ToolchainRuntimeCapabilities>> {
    if (!this.port.inspectCapabilities) {
      return unavailable("Toolchain capability inspection is not connected to a native runtime.");
    }
    try {
      return await this.port.inspectCapabilities();
    } catch (error) {
      return failureFrom(error);
    }
  }

  public async discover(toolchainId: ToolchainRuntimeId): Promise<ToolchainRuntimeResult<ToolchainDiscovery>> {
    if (!this.port.discover) {
      return unavailable("Compiler discovery is not connected to a native runtime.");
    }
    try {
      const result = await this.port.discover(toolchainId);
      if (!result.ok) return result;
      return { ok: true, value: Object.freeze({ ...result.value, checkedAt: result.value.checkedAt || this.now() }) };
    } catch (error) {
      return failureFrom(error);
    }
  }

  public async execute(plan: ToolchainCommandPlan): Promise<ToolchainRuntimeResult<ToolchainExecutionReceipt>> {
    try {
      const validated = validateToolchainCommandPlan(plan);
      if (!this.port.execute) {
        return unavailable("Toolchain process execution is not connected to a native runtime.");
      }
      return await this.port.execute(validated);
    } catch (error) {
      return failureFrom(error);
    }
  }
}

export function createOmniaToolchainRuntimeAdapter(options: OmniaToolchainRuntimeAdapterOptions = {}): OmniaToolchainRuntimeAdapter {
  return new OmniaToolchainRuntimeAdapter(options);
}
