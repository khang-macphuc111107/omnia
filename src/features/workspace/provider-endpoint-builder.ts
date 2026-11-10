export type EndpointBuilderProtocolFamily =
  | "openai-responses"
  | "openai-chat-completions"
  | "anthropic-messages"
  | "google-gemini"
  | "ollama-native"
  | "custom";

export type EndpointBuilderTransport = "http" | "sse" | "websocket" | "polling";
export type EndpointBuilderAuthScheme = "none" | "bearer" | "api-key-header" | "oauth2" | "custom";
export type EndpointBuilderOperationId =
  | "responses"
  | "chat-completions"
  | "messages"
  | "generate-content"
  | "stream-content"
  | "embeddings"
  | "models"
  | "files"
  | "batches"
  | "images"
  | "video"
  | "audio"
  | "custom";

export type EndpointBuilderInput = {
  readonly name: string;
  readonly protocolFamily: EndpointBuilderProtocolFamily;
  readonly apiVersion: string;
  readonly baseUrl: string;
  readonly transport: EndpointBuilderTransport;
  readonly authScheme: EndpointBuilderAuthScheme;
  readonly modelHint?: string;
  readonly operations: readonly EndpointBuilderOperationId[];
};

export type EndpointBuilderPreset = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly protocolFamily: EndpointBuilderProtocolFamily;
  readonly apiVersion: string;
  readonly baseUrl: string;
  readonly transport: EndpointBuilderTransport;
  readonly authScheme: EndpointBuilderAuthScheme;
  readonly operations: readonly EndpointBuilderOperationId[];
};

export type EndpointBuilderValidationIssue = {
  readonly field: "name" | "baseUrl" | "protocol" | "operations" | "modelHint" | "apiVersion";
  readonly severity: "error" | "warning";
  readonly message: string;
};

export type EndpointBuilderRoutePreview = {
  readonly operationId: EndpointBuilderOperationId;
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly absoluteUrl: string;
  readonly stream: boolean;
  readonly note: string;
};

export type EndpointBuilderValidation = {
  readonly normalizedBaseUrl: string;
  readonly issues: readonly EndpointBuilderValidationIssue[];
  readonly valid: boolean;
};

export const endpointBuilderPresets: readonly EndpointBuilderPreset[] = [
  {
    id: "openai-responses",
    label: "OpenAI Responses",
    description: "Responses API with streaming and model discovery.",
    protocolFamily: "openai-responses",
    apiVersion: "v1",
    baseUrl: "https://api.openai.com/v1",
    transport: "sse",
    authScheme: "bearer",
    operations: ["responses", "stream-content", "models"],
  },
  {
    id: "openai-chat-completions",
    label: "OpenAI Chat Completions",
    description: "Message-compatible OpenAI adapter surface.",
    protocolFamily: "openai-chat-completions",
    apiVersion: "v1",
    baseUrl: "https://api.openai.com/v1",
    transport: "sse",
    authScheme: "bearer",
    operations: ["chat-completions", "stream-content", "models"],
  },
  {
    id: "anthropic-messages",
    label: "Anthropic Messages",
    description: "Messages API with streamed content blocks.",
    protocolFamily: "anthropic-messages",
    apiVersion: "2023-06-01",
    baseUrl: "https://api.anthropic.com/v1",
    transport: "sse",
    authScheme: "api-key-header",
    operations: ["messages", "stream-content", "models"],
  },
  {
    id: "google-gemini",
    label: "Google Gemini",
    description: "Generate-content and model discovery routes.",
    protocolFamily: "google-gemini",
    apiVersion: "v1beta",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    transport: "sse",
    authScheme: "api-key-header",
    operations: ["generate-content", "stream-content", "models"],
  },
  {
    id: "ollama-local",
    label: "Ollama local",
    description: "Local HTTP endpoint with no secret in the renderer draft.",
    protocolFamily: "ollama-native",
    apiVersion: "v1",
    baseUrl: "http://127.0.0.1:11434",
    transport: "http",
    authScheme: "none",
    operations: ["chat-completions", "models"],
  },
  {
    id: "custom-adapter",
    label: "Custom adapter",
    description: "Start from a provider-neutral endpoint contract.",
    protocolFamily: "custom",
    apiVersion: "custom",
    baseUrl: "https://api.example.com/v1",
    transport: "http",
    authScheme: "bearer",
    operations: ["responses", "models"],
  },
];

const operationLabels: Readonly<Record<EndpointBuilderOperationId, string>> = {
  responses: "Responses",
  "chat-completions": "Chat completions",
  messages: "Messages",
  "generate-content": "Generate content",
  "stream-content": "Streaming content",
  embeddings: "Embeddings",
  models: "Model discovery",
  files: "Files & uploads",
  batches: "Batch jobs",
  images: "Image generation",
  video: "Video generation",
  audio: "Audio",
  custom: "Custom operation",
};

const protocolRoutes: Readonly<
  Record<EndpointBuilderProtocolFamily, Partial<Record<EndpointBuilderOperationId, Omit<EndpointBuilderRoutePreview, "operationId" | "absoluteUrl">>>>
> = {
  "openai-responses": {
    responses: { method: "POST", path: "/responses", stream: false, note: "Unified response payload." },
    "chat-completions": { method: "POST", path: "/chat/completions", stream: false, note: "Compatibility route." },
    "stream-content": { method: "POST", path: "/responses?stream=true", stream: true, note: "SSE response events." },
    embeddings: { method: "POST", path: "/embeddings", stream: false, note: "Vector representation request." },
    models: { method: "GET", path: "/models", stream: false, note: "Catalog discovery." },
    files: { method: "POST", path: "/files", stream: false, note: "Provider file handle request." },
    batches: { method: "POST", path: "/batches", stream: false, note: "Asynchronous batch job." },
    images: { method: "POST", path: "/images/generations", stream: false, note: "Image generation route." },
    audio: { method: "POST", path: "/audio/transcriptions", stream: false, note: "Audio transcription route." },
  },
  "openai-chat-completions": {
    responses: { method: "POST", path: "/responses", stream: false, note: "Compatibility route." },
    "chat-completions": { method: "POST", path: "/chat/completions", stream: false, note: "Message-oriented generation." },
    "stream-content": { method: "POST", path: "/chat/completions?stream=true", stream: true, note: "SSE delta events." },
    embeddings: { method: "POST", path: "/embeddings", stream: false, note: "Vector representation request." },
    models: { method: "GET", path: "/models", stream: false, note: "Catalog discovery." },
    files: { method: "POST", path: "/files", stream: false, note: "Provider file handle request." },
    batches: { method: "POST", path: "/batches", stream: false, note: "Asynchronous batch job." },
    images: { method: "POST", path: "/images/generations", stream: false, note: "Image generation route." },
    audio: { method: "POST", path: "/audio/transcriptions", stream: false, note: "Audio transcription route." },
  },
  "anthropic-messages": {
    messages: { method: "POST", path: "/messages", stream: false, note: "Content-block message request." },
    "stream-content": { method: "POST", path: "/messages?stream=true", stream: true, note: "Message event stream." },
    models: { method: "GET", path: "/models", stream: false, note: "Catalog discovery when supported." },
    files: { method: "POST", path: "/files", stream: false, note: "Provider file handle request." },
  },
  "google-gemini": {
    "generate-content": { method: "POST", path: "/models/:model:generateContent", stream: false, note: "Model-scoped content generation." },
    "stream-content": { method: "POST", path: "/models/:model:streamGenerateContent", stream: true, note: "Model-scoped event stream." },
    models: { method: "GET", path: "/models", stream: false, note: "Catalog discovery." },
    embeddings: { method: "POST", path: "/models/:model:embedContent", stream: false, note: "Model-scoped embedding route." },
    files: { method: "POST", path: "/upload/v1beta/files", stream: false, note: "Upload route requires provider policy." },
  },
  "ollama-native": {
    "chat-completions": { method: "POST", path: "/api/chat", stream: true, note: "Local Ollama chat stream." },
    "stream-content": { method: "POST", path: "/api/chat", stream: true, note: "Local newline-delimited stream." },
    models: { method: "GET", path: "/api/tags", stream: false, note: "Local model tags." },
    embeddings: { method: "POST", path: "/api/embed", stream: false, note: "Local embedding route." },
    files: { method: "POST", path: "/api/blobs", stream: false, note: "Local blob route; policy still required." },
  },
  custom: {
    custom: { method: "POST", path: "/operations/custom", stream: false, note: "Declarative adapter operation." },
    models: { method: "GET", path: "/models", stream: false, note: "Manual discovery mapping." },
    responses: { method: "POST", path: "/responses", stream: false, note: "User-defined compatibility mapping." },
    "stream-content": { method: "POST", path: "/responses?stream=true", stream: true, note: "User-defined stream mapping." },
  },
};

export function normalizeEndpointBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isLocalHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "[::1]" || normalized === "::1";
}

function joinEndpointUrl(baseUrl: string, path: string): string {
  const normalizedBase = normalizeEndpointBaseUrl(baseUrl);
  if (!normalizedBase) return path;
  if (path.startsWith("/")) return `${normalizedBase}${path}`;
  return `${normalizedBase}/${path}`;
}

export function validateEndpointBuilder(input: EndpointBuilderInput): EndpointBuilderValidation {
  const issues: EndpointBuilderValidationIssue[] = [];
  const normalizedBaseUrl = normalizeEndpointBaseUrl(input.baseUrl);
  if (!input.name.trim()) issues.push({ field: "name", severity: "error", message: "Give this endpoint snapshot a name." });
  if (!input.apiVersion.trim()) issues.push({ field: "apiVersion", severity: "warning", message: "Record an API version or an explicit custom version." });
  if (input.operations.length === 0) issues.push({ field: "operations", severity: "error", message: "Select at least one operation before this snapshot can be reviewed." });
  if (!normalizedBaseUrl) {
    issues.push({ field: "baseUrl", severity: "error", message: "Base URL is required." });
  } else {
    try {
      const parsed = new URL(normalizedBaseUrl);
      if (parsed.username || parsed.password) {
        issues.push({ field: "baseUrl", severity: "error", message: "Credentials must never be embedded in the endpoint URL." });
      }
      if (parsed.search || parsed.hash) {
        issues.push({ field: "baseUrl", severity: "warning", message: "Query and hash fragments are omitted from the endpoint base URL." });
      }
      if (parsed.protocol !== "https:" && !isLocalHost(parsed.hostname)) {
        issues.push({ field: "baseUrl", severity: "error", message: "Use HTTPS for remote endpoints; HTTP is allowed only for an explicit local host." });
      }
    } catch {
      issues.push({ field: "baseUrl", severity: "error", message: "Enter an absolute endpoint URL such as https://api.example.com/v1." });
    }
  }
  if ((input.operations.includes("generate-content") || input.operations.includes("embeddings")) && !input.modelHint?.trim()) {
    issues.push({ field: "modelHint", severity: "warning", message: "A model ID hint helps model-scoped routes preview their final path." });
  }
  return { normalizedBaseUrl, issues, valid: issues.every((issue) => issue.severity !== "error") };
}

export function endpointRoutePreview(input: EndpointBuilderInput): EndpointBuilderRoutePreview[] {
  const routes = protocolRoutes[input.protocolFamily];
  return input.operations.flatMap((operationId) => {
    const route = routes[operationId] ?? protocolRoutes.custom[operationId] ?? {
      method: "POST" as const,
      path: `/operations/${operationId}`,
      stream: false,
      note: "Fallback adapter mapping; native conformance is not observed.",
    };
    const path = route.path.replace(":model", input.modelHint?.trim() || ":model");
    return [{ operationId, ...route, path, absoluteUrl: joinEndpointUrl(input.baseUrl, path) }];
  });
}

export function endpointOperationLabel(operationId: EndpointBuilderOperationId): string {
  return operationLabels[operationId];
}

