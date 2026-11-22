/**
 * Edge API gateway bootstrap and middleware pipeline registration.
 * Coordinates security filters, per-tier throttling, and upstream billing/auth proxying.
 */

import {
  GatewayMiddleware,
  GatewayRequest,
  GatewayResponse,
  TenantTier,
  formatInvoiceWireJson,
  serializeInvoiceForwardHeaders,
  InvoiceDto,
} from "../../../shared/protocol/types";
import {
  attachSecurityMiddlewares,
  requestIdMiddleware,
  AuthVerifierClient,
} from "./middleware";
import { TokenBucketLimiter, createTierRateLimitMiddleware } from "./rate_limiter";
import {
  GatewayError,
  UpstreamProxyClient,
  createUpstreamProxyMiddleware,
  mapUpstreamErrorToHttp,
} from "./error_mapper";

export interface GatewayConfig {
  webhookSecret: string;
  rateLimitRpmByTier: Record<string, number>;
  upstreamTimeoutMs: number;
}

export class GatewayApp {
  private readonly middlewares: GatewayMiddleware[] = [];

  use(mw: GatewayMiddleware): void {
    this.middlewares.push(mw);
  }

  async handle(req: GatewayRequest): Promise<GatewayResponse> {
    let index = -1;

    const dispatch = async (cursor: number): Promise<GatewayResponse> => {
      if (cursor <= index) {
        throw new Error("Middleware called next() multiple times");
      }
      index = cursor;
      const fn = this.middlewares[cursor];
      if (!fn) {
        return {
          status: 404,
          headers: { "x-request-id": req.context.requestId ?? "" },
          body: { error: "ROUTE_NOT_FOUND" },
        };
      }
      return fn(req, () => dispatch(cursor + 1));
    };

    try {
      return await dispatch(0);
    } catch (err) {
      if (err instanceof GatewayError) {
        return mapUpstreamErrorToHttp(err, req.context.requestId ?? "");
      }
      return {
        status: 500,
        headers: { "x-request-id": req.context.requestId ?? "" },
        body: { error: "INTERNAL_GATEWAY_ERROR" },
      };
    }
  }
}

export function registerMiddlewarePipeline(
  app: GatewayApp,
  config: GatewayConfig,
  authClient: AuthVerifierClient,
  limiter: TokenBucketLimiter,
  upstreamClient: UpstreamProxyClient,
): void {
  // Step 1: Correlation ID tagging before any auth or logging runs.
  app.use(requestIdMiddleware);

  // Steps 2-4: Webhook HMAC check, JWT verification, and tenant_tier context resolution.
  attachSecurityMiddlewares(app, {
    webhookSecret: config.webhookSecret,
    authClient,
  });

  // Step 5: Per-tier Redis token-bucket rate limiter.
  app.use(createTierRateLimitMiddleware(limiter));

  // Step 6: Downstream dispatch to billing/auth upstreams with error-code translation.
  app.use(createUpstreamProxyMiddleware(upstreamClient));
}

export function isSubscriptionActiveForRead(req: GatewayRequest): boolean {
  const state = req.context.claims?.subscription_state;
  return state === "active" || state === "trialing" || state === "past_due";
}

export function buildBillingInvoiceDispatch(
  invoice: InvoiceDto,
  signature: string,
  timestampSec: string,
): { headers: Record<string, string>; body: string } {
  const headers = serializeInvoiceForwardHeaders(invoice, signature, timestampSec);
  const body = formatInvoiceWireJson(invoice);
  return { headers, body };
}

export function createProductionGateway(
  authClient: AuthVerifierClient,
  limiter: TokenBucketLimiter,
  upstreamClient: UpstreamProxyClient,
  webhookSecret: string,
): GatewayApp {
  const app = new GatewayApp();
  const config: GatewayConfig = {
    webhookSecret,
    rateLimitRpmByTier: {
      [TenantTier.FREE]: 30,
      [TenantTier.PRO]: 500,
      [TenantTier.ENTERPRISE]: 5000,
    },
    upstreamTimeoutMs: 2500,
  };
  registerMiddlewarePipeline(app, config, authClient, limiter, upstreamClient);
  return app;
}
