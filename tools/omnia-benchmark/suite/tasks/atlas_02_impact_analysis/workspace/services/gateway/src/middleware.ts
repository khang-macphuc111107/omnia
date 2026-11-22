/**
 * Gateway security, correlation, and tenant-context middleware implementations.
 */

import * as crypto from "node:crypto";
import {
  AuthTokenClaims,
  GatewayMiddleware,
  GatewayRequest,
  GatewayResponse,
  NextFunction,
  REQUEST_ID_HEADER,
  TenantTier,
  VALID_TENANT_TIERS,
  WEBHOOK_HMAC_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "../../../shared/protocol/types";
import { AuthServiceTimeoutError } from "./error_mapper";

export interface AuthVerifierClient {
  verifyBearerToken(token: string): Promise<AuthTokenClaims | null>;
}

export interface SecurityMiddlewareOptions {
  webhookSecret: string;
  authClient: AuthVerifierClient;
}

export interface MiddlewareRegistrar {
  use(mw: GatewayMiddleware): void;
}

export async function requestIdMiddleware(
  req: GatewayRequest,
  next: NextFunction,
): Promise<GatewayResponse> {
  const headerKey = REQUEST_ID_HEADER.toLowerCase();
  const incoming = req.headers[headerKey];
  const reqId =
    incoming && incoming.trim().length > 0
      ? incoming.trim()
      : `req_${crypto.randomBytes(8).toString("hex")}`;
  req.context.requestId = reqId;
  const response = await next();
  response.headers[headerKey] = reqId;
  return response;
}

export function createHmacSignatureMiddleware(
  webhookSecret: string,
): GatewayMiddleware {
  return async function hmacSignatureMiddleware(
    req: GatewayRequest,
    next: NextFunction,
  ): Promise<GatewayResponse> {
    if (!req.path.startsWith("/webhooks/")) {
      return next();
    }

    const sigHeaderKey = WEBHOOK_HMAC_HEADER.toLowerCase();
    const tsHeaderKey = WEBHOOK_TIMESTAMP_HEADER.toLowerCase();
    const providedSig = req.headers[sigHeaderKey];
    const timestamp = req.headers[tsHeaderKey];

    if (!providedSig || !timestamp) {
      return {
        status: 401,
        headers: {},
        body: {
          error: "MISSING_WEBHOOK_SIGNATURE",
          expected_header: WEBHOOK_HMAC_HEADER,
        },
      };
    }

    const digest = crypto
      .createHmac("sha256", webhookSecret)
      .update(`${timestamp}.${req.rawBody}`)
      .digest("hex");
    const expected = `sha256=${digest}`;

    if (
      providedSig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(providedSig), Buffer.from(expected))
    ) {
      return {
        status: 401,
        headers: {},
        body: { error: "INVALID_WEBHOOK_SIGNATURE" },
      };
    }

    req.context.webhookVerified = true;
    return next();
  };
}

export function createJwtAuthMiddleware(
  authClient: AuthVerifierClient,
): GatewayMiddleware {
  return async function jwtAuthMiddleware(
    req: GatewayRequest,
    next: NextFunction,
  ): Promise<GatewayResponse> {
    if (req.path.startsWith("/webhooks/") && req.context.webhookVerified) {
      return next();
    }

    const authHeader = req.headers["authorization"] ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return {
        status: 401,
        headers: {},
        body: { error: "MISSING_BEARER_TOKEN" },
      };
    }

    const token = authHeader.slice("Bearer ".length).trim();
    let claims: AuthTokenClaims | null;
    try {
      claims = await authClient.verifyBearerToken(token);
    } catch (err) {
      throw new AuthServiceTimeoutError("Auth upstream verification timed out");
    }

    if (!claims) {
      return {
        status: 401,
        headers: {},
        body: { error: "INVALID_ACCESS_TOKEN" },
      };
    }

    if (
      claims.subscription_state === "suspended" ||
      claims.subscription_state === "canceled"
    ) {
      return {
        status: 403,
        headers: {},
        body: {
          error: "SUBSCRIPTION_INACTIVE",
          state: claims.subscription_state,
        },
      };
    }

    req.context.claims = claims;
    return next();
  };
}

export async function tenantTierContextMiddleware(
  req: GatewayRequest,
  next: NextFunction,
): Promise<GatewayResponse> {
  const claimTier = req.context.claims?.tenant_tier;
  const headerTier = req.headers["x-nimbus-tenant-tier"];
  const rawTier = String(claimTier ?? headerTier ?? "");

  // Normalize unrecognized tier labels to the baseline tier for safe downstream routing.
  const resolvedTier: TenantTier = VALID_TENANT_TIERS.has(rawTier)
    ? (rawTier as TenantTier)
    : TenantTier.FREE;

  req.context.tenantTier = resolvedTier;
  return next();
}

export function attachSecurityMiddlewares(
  app: MiddlewareRegistrar,
  options: SecurityMiddlewareOptions,
): void {
  app.use(createHmacSignatureMiddleware(options.webhookSecret));
  app.use(createJwtAuthMiddleware(options.authClient));
  app.use(tenantTierContextMiddleware);
}
