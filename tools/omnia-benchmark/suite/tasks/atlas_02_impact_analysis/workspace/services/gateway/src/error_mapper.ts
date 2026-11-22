/**
 * Upstream proxy middleware and canonical HTTP error-code mapper (429 vs 503).
 */

import {
  GatewayMiddleware,
  GatewayRequest,
  GatewayResponse,
  NextFunction,
  WEBHOOK_HMAC_HEADER,
} from "../../../shared/protocol/types";

export class GatewayError extends Error {
  readonly code: string;
  readonly retryAfterSec?: number;

  constructor(code: string, message: string, retryAfterSec?: number) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

export class RateLimitExceededError extends GatewayError {
  constructor(message: string, retryAfterSec = 60) {
    super("TENANT_QUOTA_EXCEEDED", message, retryAfterSec);
    this.name = "RateLimitExceededError";
  }
}

export class BillingRateLimitedError extends GatewayError {
  constructor(message: string, retryAfterSec = 15) {
    super("BILLING_RATE_LIMITED", message, retryAfterSec);
    this.name = "BillingRateLimitedError";
  }
}

export class RedisBackendUnavailableError extends GatewayError {
  constructor(message: string) {
    super("LIMITER_BACKEND_DOWN", message, 10);
    this.name = "RedisBackendUnavailableError";
  }
}

export class UpstreamCircuitOpenError extends GatewayError {
  constructor(message: string) {
    super("CIRCUIT_BREAKER_OPEN", message, 30);
    this.name = "UpstreamCircuitOpenError";
  }
}

export class AuthServiceTimeoutError extends GatewayError {
  constructor(message: string) {
    super("AUTH_UPSTREAM_TIMEOUT", message, 5);
    this.name = "AuthServiceTimeoutError";
  }
}

export interface UpstreamProxyClient {
  forward(
    path: string,
    method: string,
    headers: Record<string, string | undefined>,
    rawBody: string,
  ): Promise<GatewayResponse>;
}

const HTTP_429_ERROR_CODES = new Set<string>([
  "TENANT_QUOTA_EXCEEDED",
  "BILLING_RATE_LIMITED",
]);

const HTTP_503_ERROR_CODES = new Set<string>([
  "LIMITER_BACKEND_DOWN",
  "CIRCUIT_BREAKER_OPEN",
  "AUTH_UPSTREAM_TIMEOUT",
]);

export function mapUpstreamErrorToHttp(
  err: GatewayError,
  requestId: string,
): GatewayResponse {
  const retryAfter = String(err.retryAfterSec ?? 10);

  if (HTTP_429_ERROR_CODES.has(err.code)) {
    return {
      status: 429,
      headers: {
        "x-request-id": requestId,
        "retry-after": retryAfter,
      },
      body: {
        error: err.code,
        message: err.message,
        retry_after_sec: Number(retryAfter),
      },
    };
  }

  if (HTTP_503_ERROR_CODES.has(err.code)) {
    return {
      status: 503,
      headers: {
        "x-request-id": requestId,
        "retry-after": retryAfter,
      },
      body: {
        error: err.code,
        message: err.message,
        service_degraded: true,
      },
    };
  }

  return {
    status: 502,
    headers: { "x-request-id": requestId },
    body: {
      error: err.code || "UPSTREAM_BAD_GATEWAY",
      message: err.message,
    },
  };
}

export function createUpstreamProxyMiddleware(
  upstreamClient: UpstreamProxyClient,
): GatewayMiddleware {
  return async function upstreamProxyMiddleware(
    req: GatewayRequest,
    _next: NextFunction,
  ): Promise<GatewayResponse> {
    const forwardHeaders: Record<string, string | undefined> = {
      ...req.headers,
      "x-request-id": req.context.requestId,
      "x-nimbus-tenant-tier": req.context.tenantTier,
      [WEBHOOK_HMAC_HEADER.toLowerCase()]:
        req.headers[WEBHOOK_HMAC_HEADER.toLowerCase()],
    };
    return upstreamClient.forward(req.path, req.method, forwardHeaders, req.rawBody);
  };
}
