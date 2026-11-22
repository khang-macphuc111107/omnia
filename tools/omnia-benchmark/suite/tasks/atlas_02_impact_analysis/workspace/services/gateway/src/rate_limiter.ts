/**
 * Per-tenant token-bucket rate limiter backed by Redis counters.
 */

import {
  GatewayMiddleware,
  GatewayRequest,
  GatewayResponse,
  NextFunction,
  TenantTier,
} from "../../../shared/protocol/types";
import {
  RateLimitExceededError,
  RedisBackendUnavailableError,
} from "./error_mapper";

export interface RedisCounterStore {
  incrementWindow(key: string, windowSec: number): Promise<number>;
}

export const TIER_DEFAULT_RPM: Readonly<Record<string, number>> = {
  [TenantTier.FREE]: 60,
  [TenantTier.PRO]: 600,
  [TenantTier.ENTERPRISE]: 6000,
};

export class TokenBucketLimiter {
  private readonly store: RedisCounterStore;
  private readonly rpmByTier: Record<string, number>;
  private readonly windowSec: number;

  constructor(
    store: RedisCounterStore,
    rpmByTier: Record<string, number> = { ...TIER_DEFAULT_RPM },
    windowSec = 60,
  ) {
    this.store = store;
    this.rpmByTier = rpmByTier;
    this.windowSec = windowSec;
  }

  getLimitForTier(tier: string): number {
    return this.rpmByTier[tier] ?? 60;
  }

  async consume(
    tenantId: string,
    tier: string,
  ): Promise<{ allowed: boolean; remaining: number; retryAfterSec: number }> {
    const limit = this.getLimitForTier(tier);
    const bucketKey = `nimbus:rl:${tenantId}:${tier}`;

    let currentCount: number;
    try {
      currentCount = await this.store.incrementWindow(bucketKey, this.windowSec);
    } catch (err) {
      throw new RedisBackendUnavailableError(
        `Redis rate-limit store unavailable for ${tenantId}`,
      );
    }

    if (currentCount > limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec: this.windowSec,
      };
    }

    return {
      allowed: true,
      remaining: Math.max(0, limit - currentCount),
      retryAfterSec: 0,
    };
  }
}

export function createTierRateLimitMiddleware(
  limiter: TokenBucketLimiter,
): GatewayMiddleware {
  return async function tierRateLimitMiddleware(
    req: GatewayRequest,
    next: NextFunction,
  ): Promise<GatewayResponse> {
    const tenantId = req.context.claims?.tenant_id ?? "anonymous_webhook";
    const tier = req.context.tenantTier ?? TenantTier.FREE;

    const decision = await limiter.consume(tenantId, tier);
    if (!decision.allowed) {
      throw new RateLimitExceededError(
        `Tenant ${tenantId} exceeded quota for tier ${tier}`,
        decision.retryAfterSec,
      );
    }

    req.context.rateLimitRemaining = decision.remaining;
    const response = await next();
    response.headers["x-ratelimit-remaining"] = String(decision.remaining);
    return response;
  };
}
