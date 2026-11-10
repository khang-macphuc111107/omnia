import { assertDomain } from "./errors";
import type { ModelProfileId, ProfileId, ProviderConnectionId } from "./ids";
import { assertNonBlank, type IsoTimestamp, type JsonObject, type JsonValue } from "./shared";

export type ProviderType =
  | "openai"
  | "deepseek"
  | "anthropic"
  | "gemini"
  | "azure-openai"
  | "openai-compatible"
  | "custom-adapter";

export type AuthenticationScheme =
  | "none"
  | "bearer"
  | "api-key-header"
  | "query-parameter"
  | "oauth"
  | "azure-api-key"
  | "custom";

export type NetworkDestinationClass = "public-internet" | "loopback" | "private-network";

export interface ProviderEgressPolicy {
  readonly allowedHosts: readonly string[];
  readonly destinationClass: NetworkDestinationClass;
  readonly allowInsecureHttp: boolean;
  readonly allowCrossOriginRedirects: boolean;
  readonly localProviderGrant: boolean;
  readonly dataClasses: readonly string[];
}

export interface ProviderConnection {
  readonly id: ProviderConnectionId;
  readonly profileId: ProfileId;
  readonly type: ProviderType;
  readonly displayName: string;
  /** Normalized non-secret URL. User-info and sensitive query values are forbidden. */
  readonly baseUrl: string;
  readonly authScheme: AuthenticationScheme;
  /** Opaque operating-system vault handle. Never a raw credential. */
  readonly credentialRef?: string;
  readonly organizationId?: string;
  readonly remoteProjectId?: string;
  readonly enabled: boolean;
  readonly egressPolicy: ProviderEgressPolicy;
  readonly config: JsonObject;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export type CapabilitySource = "provider_live" | "provider_static" | "user_override" | "unknown";
export type CapabilityConfidence = "verified" | "declared" | "inferred" | "unknown";

export interface CapabilityValue<T> {
  readonly value: T;
  readonly source: CapabilitySource;
  readonly observedAt: IsoTimestamp;
  readonly confidence: CapabilityConfidence;
}

export type ModelModality = "text" | "image" | "audio" | "video" | "file";

export interface ModelCapabilities {
  readonly inputModalities: CapabilityValue<readonly ModelModality[]>;
  readonly outputModalities: CapabilityValue<readonly ModelModality[]>;
  readonly streaming: CapabilityValue<boolean>;
  readonly tools: CapabilityValue<boolean>;
  readonly parallelTools: CapabilityValue<boolean>;
  readonly structuredOutput: CapabilityValue<boolean>;
  readonly jsonSchema: CapabilityValue<boolean>;
  readonly reasoning: CapabilityValue<boolean>;
  readonly promptCaching: CapabilityValue<boolean>;
  readonly backgroundMode: CapabilityValue<boolean>;
  readonly contextWindowTokens: CapabilityValue<number | null>;
  readonly maxOutputTokens: CapabilityValue<number | null>;
  readonly supportedRoles: CapabilityValue<readonly string[]>;
  readonly native: Readonly<Record<string, CapabilityValue<JsonValue>>>;
}

export interface ModelPricing {
  readonly currency: string;
  readonly inputMicrounitsPerMillionTokens?: number;
  readonly cachedInputMicrounitsPerMillionTokens?: number;
  readonly outputMicrounitsPerMillionTokens?: number;
  readonly provenance: "provider" | "catalog" | "user" | "unknown";
  readonly observedAt: IsoTimestamp;
}

export interface ModelDescriptor {
  readonly id: ModelProfileId;
  readonly connectionId: ProviderConnectionId;
  readonly providerModelId: string;
  readonly displayName: string;
  readonly capabilities: ModelCapabilities;
  readonly pricing?: ModelPricing;
  readonly favorite: boolean;
  readonly hidden: boolean;
  readonly discoveredAt: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
  readonly extensions: JsonObject;
}

export interface CreateProviderConnectionInput {
  readonly id: ProviderConnectionId;
  readonly profileId: ProfileId;
  readonly type: ProviderType;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly authScheme: AuthenticationScheme;
  readonly credentialRef?: string;
  readonly organizationId?: string;
  readonly remoteProjectId?: string;
  readonly enabled?: boolean;
  readonly egressPolicy: ProviderEgressPolicy;
  readonly config?: JsonObject;
  readonly now: IsoTimestamp;
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function isLoopbackHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function isPrivateIpv4(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (match === null) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return false;
  const [first = -1, second = -1] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first === 0 ||
    first >= 224
  );
}

function containsSensitiveQueryKey(url: URL): boolean {
  const sensitive = /(?:^|[-_.])(api[-_]?key|token|secret|signature|credential|password|auth)(?:$|[-_.])/i;
  // Inspect the raw query so this security check does not depend on a complete
  // URLSearchParams implementation in an older Windows WebView or test DOM.
  const query = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  if (query.length === 0) return false;
  return query.split("&").some((pair) => {
    const separator = pair.indexOf("=");
    const encodedKey = separator < 0 ? pair : pair.slice(0, separator);
    let key = encodedKey.replace(/\+/g, " ");
    try {
      key = decodeURIComponent(key);
    } catch {
      // A malformed encoded key is still checked in its literal form. The URL
      // parser has already validated the surrounding URL shape.
    }
    return sensitive.test(key);
  });
}

export function normalizeProviderBaseUrl(
  value: string,
  policy: ProviderEgressPolicy,
): string {
  const url = URL.parse(value.trim());
  if (url === null) {
    assertDomain(false, "invalid_argument", "Provider base URL is invalid.");
  }
  assertDomain(
    url.protocol === "https:" || url.protocol === "http:",
    "invalid_argument",
    "Provider base URL must use HTTP or HTTPS.",
  );
  assertDomain(
    url.username.length === 0 && url.password.length === 0,
    "invalid_argument",
    "Provider base URL must not contain credentials.",
  );
  assertDomain(
    !containsSensitiveQueryKey(url),
    "invalid_argument",
    "Provider base URL must not contain sensitive query parameters.",
  );

  const hostname = normalizeHost(url.hostname);
  const loopback = isLoopbackHost(hostname);
  const privateNetwork = loopback || isPrivateIpv4(hostname) || hostname.endsWith(".local");
  const expectedClass: NetworkDestinationClass = loopback
    ? "loopback"
    : privateNetwork
      ? "private-network"
      : "public-internet";
  assertDomain(
    policy.destinationClass === expectedClass,
    "scope_violation",
    "Provider destination does not match its declared network class.",
    { expectedClass, declaredClass: policy.destinationClass },
  );
  assertDomain(
    expectedClass === "public-internet" || policy.localProviderGrant,
    "permission_denied",
    "A visible local-provider grant is required for loopback or private endpoints.",
    { destinationClass: expectedClass },
  );
  assertDomain(
    url.protocol === "https:" || (policy.allowInsecureHttp && policy.localProviderGrant),
    "permission_denied",
    "Credentials may not be sent over insecure HTTP without a local-provider grant.",
  );

  const allowedHosts = policy.allowedHosts.map(normalizeHost);
  assertDomain(
    allowedHosts.length > 0 && allowedHosts.includes(hostname),
    "scope_violation",
    "Provider hostname is outside the connection egress allowlist.",
    { hostname },
  );

  url.hash = "";
  url.hostname = hostname;
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  // href is consistently a primitive string in Chromium/WebView2 and in DOM
  // shims whose URL#toString implementation may be incomplete.
  return String(url.href).replace(/\/$/, "");
}

export function createProviderConnection(input: CreateProviderConnectionInput): ProviderConnection {
  const credentialRef = input.credentialRef?.trim();
  assertDomain(
    credentialRef === undefined || credentialRef.length > 0,
    "invalid_argument",
    "credentialRef cannot be blank.",
  );
  assertDomain(
    input.authScheme === "none" || credentialRef !== undefined,
    "invalid_argument",
    "An authenticated provider connection requires an opaque credential reference.",
    { authScheme: input.authScheme },
  );
  assertDomain(
    input.authScheme !== "none" || credentialRef === undefined,
    "invalid_argument",
    "A no-auth provider connection cannot retain a credential reference.",
    { authScheme: input.authScheme },
  );
  assertDomain(
    credentialRef === undefined || credentialRef.length <= 512,
    "invalid_argument",
    "credentialRef is too long to be an opaque vault handle.",
  );

  const egressPolicy: ProviderEgressPolicy = Object.freeze({
    ...input.egressPolicy,
    allowedHosts: Object.freeze([...new Set(input.egressPolicy.allowedHosts.map(normalizeHost))]),
    dataClasses: Object.freeze([...new Set(input.egressPolicy.dataClasses)]),
  });
  assertDomain(
    egressPolicy.allowedHosts.every((host) => host.length > 0),
    "invalid_argument",
    "Provider egress hosts cannot be blank.",
  );
  return Object.freeze({
    id: input.id,
    profileId: input.profileId,
    type: input.type,
    displayName: assertNonBlank(input.displayName, "provider display name", 120),
    baseUrl: normalizeProviderBaseUrl(input.baseUrl, egressPolicy),
    authScheme: input.authScheme,
    ...(credentialRef === undefined ? {} : { credentialRef }),
    ...(input.organizationId === undefined
      ? {}
      : { organizationId: assertNonBlank(input.organizationId, "organization ID", 240) }),
    ...(input.remoteProjectId === undefined
      ? {}
      : { remoteProjectId: assertNonBlank(input.remoteProjectId, "remote project ID", 240) }),
    enabled: input.enabled ?? true,
    egressPolicy,
    config: Object.freeze({ ...(input.config ?? {}) }),
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export function assertProviderRouteAllowed(
  connection: ProviderConnection,
  dataClasses: readonly string[],
  localOnly: boolean,
): void {
  assertDomain(connection.enabled, "invalid_state_transition", "Provider connection is disabled.", {
    connectionId: connection.id,
  });
  assertDomain(
    !localOnly || connection.egressPolicy.destinationClass !== "public-internet",
    "permission_denied",
    "Local-only mode blocks public provider egress.",
    { connectionId: connection.id },
  );
  const disallowed = dataClasses.filter(
    (dataClass) => !connection.egressPolicy.dataClasses.includes(dataClass),
  );
  assertDomain(disallowed.length === 0, "permission_denied", "Provider route disallows input data.", {
    connectionId: connection.id,
    disallowed,
  });
}

/** Allows user overrides only for descriptive metadata, never safety/auth claims. */
export function applyCapabilityOverride<T>(
  current: CapabilityValue<T>,
  value: T,
  observedAt: IsoTimestamp,
  kind: "descriptive" | "safety" | "authentication",
): CapabilityValue<T> {
  assertDomain(
    kind === "descriptive",
    "permission_denied",
    "User overrides cannot assert safety or authentication capabilities.",
    { kind },
  );
  return Object.freeze({ ...current, value, source: "user_override", observedAt, confidence: "declared" });
}
