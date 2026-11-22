-- Nimbus Cloud Billing Database Schema (PostgreSQL 16)
-- Owned by services/billing; accessed by services/billing and services/worker.

CREATE TABLE tenants (
    tenant_id           VARCHAR(64) PRIMARY KEY,
    display_name        TEXT NOT NULL,
    tenant_tier         VARCHAR(32) NOT NULL
                        CHECK (tenant_tier IN ('free', 'pro', 'enterprise')),
    webhook_url         TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE subscriptions (
    id                  VARCHAR(64) PRIMARY KEY,
    tenant_id           VARCHAR(64) NOT NULL REFERENCES tenants(tenant_id),
    plan_tier           VARCHAR(32) NOT NULL
                        CHECK (plan_tier IN ('free', 'pro', 'enterprise')),
    subscription_state  VARCHAR(32) NOT NULL
                        CHECK (subscription_state IN (
                            'trialing',
                            'active',
                            'past_due',
                            'suspended',
                            'canceled'
                        )),
    current_period_end  TIMESTAMPTZ NOT NULL,
    grace_expires_at    TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_subscriptions_tenant_state
    ON subscriptions (tenant_id, subscription_state);

CREATE INDEX idx_subscriptions_grace_expiry
    ON subscriptions (subscription_state, grace_expires_at)
    WHERE subscription_state = 'past_due';

CREATE TABLE invoices (
    invoice_id          VARCHAR(64) PRIMARY KEY,
    tenant_id           VARCHAR(64) NOT NULL REFERENCES tenants(tenant_id),
    subscription_id     VARCHAR(64) NOT NULL REFERENCES subscriptions(id),
    tenant_tier         VARCHAR(32) NOT NULL
                        CHECK (tenant_tier IN ('free', 'pro', 'enterprise')),
    amount_cents        BIGINT NOT NULL CHECK (amount_cents >= 0),
    currency            CHAR(3) NOT NULL CHECK (currency IN ('USD', 'EUR', 'GBP')),
    status              VARCHAR(32) NOT NULL
                        CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
    issued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at             TIMESTAMPTZ
);

CREATE INDEX idx_invoices_tenant_issued
    ON invoices (tenant_id, issued_at DESC);

CREATE TABLE webhook_deliveries (
    delivery_id         VARCHAR(64) PRIMARY KEY,
    tenant_id           VARCHAR(64) NOT NULL REFERENCES tenants(tenant_id),
    event_type          VARCHAR(64) NOT NULL,
    hmac_header_name    VARCHAR(64) NOT NULL DEFAULT 'X-Nimbus-Signature-V1',
    payload_json        JSONB NOT NULL,
    http_status         INTEGER,
    attempt_count       INTEGER NOT NULL DEFAULT 0,
    last_attempt_at     TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE subscription_audit_log (
    audit_id            BIGSERIAL PRIMARY KEY,
    subscription_id     VARCHAR(64) NOT NULL REFERENCES subscriptions(id),
    previous_state      VARCHAR(32),
    new_state           VARCHAR(32) NOT NULL,
    reason              TEXT NOT NULL,
    actor_service       VARCHAR(64) NOT NULL,
    recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
