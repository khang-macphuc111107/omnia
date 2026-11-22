# Nimbus Cloud Monorepo

Nimbus Cloud is a multi-tenant SaaS API platform composed of four runtime services,
a shared wire-protocol package, and layered environment configuration.

## Repository Layout

- `shared/protocol/` — Canonical JSON Schema (`schema.json`), TypeScript DTOs (`types.ts`), and Python protocol models (`models.py`).
- `config/` — Layered runtime configuration (`defaults.yaml`, `env_prod.yaml`, `tenants.json`).
- `services/gateway/` — Edge TypeScript HTTP gateway handling request correlation, webhook signature verification, JWT validation, tenant tier context, per-tier rate limiting, and upstream error translation.
- `services/auth/` — Python authentication and session service managing JWT issuance, refresh token rotation, and Redis-backed session TTL resolution.
- `services/billing/` — Python billing and subscription management service with PostgreSQL schema (`db/schema.sql`), subscription persistence (`subscription_repo.py`), and invoice/webhook orchestration (`invoice_service.py`).
- `services/worker/` — Python asynchronous worker handling dead-letter queue retry scheduling (`dlq_processor.py`) and nightly subscription/invoice reconciliation (`reconciler.py`).

## Runtime Data & Control Flows

1. **Client & Webhook Ingress (`gateway`)**
   - External API requests and payment webhooks enter `services/gateway/src/server.ts`.
   - `gateway` validates JWT access tokens minted by `services/auth`, resolves tenant tier context and rate-limit buckets, verifies webhook HMAC signatures, and forwards authenticated requests/webhooks downstream to `services/billing`.

2. **Identity & Sessions (`auth`)**
   - `services/auth/config_loader.py` merges layered YAML/JSON configuration to resolve tenant properties and Redis session TTLs.
   - `services/auth/token_service.py` mints JWT claims (including `tenant_tier` and `subscription_state`) and manages refresh-token rotation in Redis.

3. **Billing & Persistence (`billing` + `billing_db`)**
   - `services/billing/db/schema.sql` defines PostgreSQL tables `tenants`, `subscriptions`, `invoices`, `webhook_deliveries`, and `subscription_audit_log`.
   - `services/billing/subscription_repo.py` and `services/billing/invoice_service.py` manage billing state and publish serialized invoice and webhook-replay events to the worker queue.

4. **Asynchronous Workers (`worker`)**
   - `services/worker/dlq_processor.py` consumes failed billing/dunning/webhook jobs from the queue, applies retry backoff before dead-lettering, and enforces exhausted-dunning state updates.
   - `services/worker/reconciler.py` reconciles invoice totals against the database, verifies webhook callback receipts, and expires overdue subscriptions past their grace window.
