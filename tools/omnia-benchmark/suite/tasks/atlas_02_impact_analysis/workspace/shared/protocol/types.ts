/**
 * Shared TypeScript wire-protocol contracts for Nimbus Cloud gateway services.
 * Kept in lockstep with shared/protocol/schema.json and shared/protocol/models.py.
 */

export enum TenantTier {
  FREE = "free",
  PRO = "pro",
  ENTERPRISE = "enterprise",
}

export type SubscriptionState =
  | "trialing"
  | "active"
  | "past_due"
  | "suspended"
  | "canceled";

export const WEBHOOK_HMAC_HEADER = "X-Nimbus-Signature-V1";
export const WEBHOOK_TIMESTAMP_HEADER = "X-Nimbus-Timestamp";
export const REQUEST_ID_HEADER = "X-Request-Id";

export interface AuthTokenClaims {
  sub: string;
  tenant_id: string;
  tenant_tier: TenantTier;
  subscription_state: SubscriptionState;
  session_id: string;
  iat: number;
  exp: number;
}

export interface InvoiceDto {
  invoice_id: string;
  tenant_id: string;
  subscription_id: string;
  tenant_tier: TenantTier;
  amount_cents: number;
  currency: "USD" | "EUR" | "GBP";
  issued_at: string;
  status: "draft" | "open" | "paid" | "void" | "uncollectible";
}

export interface GatewayRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  rawBody: string;
  context: {
    requestId?: string;
    claims?: AuthTokenClaims;
    tenantTier?: TenantTier;
    webhookVerified?: boolean;
    rateLimitRemaining?: number;
  };
}

export interface GatewayResponse {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export type NextFunction = () => Promise<GatewayResponse>;
export type GatewayMiddleware = (
  req: GatewayRequest,
  next: NextFunction,
) => Promise<GatewayResponse>;

export const VALID_TENANT_TIERS: ReadonlySet<string> = new Set([
  TenantTier.FREE,
  TenantTier.PRO,
  TenantTier.ENTERPRISE,
]);

export function parseTenantTierStrict(raw: string): TenantTier {
  if (VALID_TENANT_TIERS.has(raw)) {
    return raw as TenantTier;
  }
  throw new Error(`Invalid tenant_tier value: ${raw}`);
}

export function serializeInvoiceForwardHeaders(
  invoice: InvoiceDto,
  signature: string,
  timestampSec: string,
): Record<string, string> {
  return {
    "content-type": "application/json",
    [WEBHOOK_HMAC_HEADER.toLowerCase()]: signature,
    [WEBHOOK_TIMESTAMP_HEADER.toLowerCase()]: timestampSec,
    "x-nimbus-tenant-tier": invoice.tenant_tier,
    "x-nimbus-invoice-cents": String(invoice.amount_cents),
  };
}

export function formatInvoiceWireJson(invoice: InvoiceDto): string {
  return JSON.stringify({
    invoice_id: invoice.invoice_id,
    tenant_id: invoice.tenant_id,
    subscription_id: invoice.subscription_id,
    tenant_tier: invoice.tenant_tier,
    amount_cents: invoice.amount_cents,
    currency: invoice.currency,
    issued_at: invoice.issued_at,
    status: invoice.status,
  });
}
