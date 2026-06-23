# Billing and Subscription Plan

## Status

Open Managed Agents already has the right lower-level shape for hosted billing:

- OSS/runtime records raw usage events through `packages/services/src/usage.ts`.
- `apps/main/src/routes/internal.ts` exposes `/v1/internal/usage_events` and `/v1/internal/usage_events/ack` behind `BILLING_INTERNAL_SECRET`.
- Console has a hosted-only plugin extension point in `apps/console/src/plugins/registry.ts`.
- Current quotas in `apps/main/src/quotas.ts` are abuse controls, not paid-plan entitlements.

The missing product layer is subscription checkout, customer lifecycle, usage-to-credit reconciliation, entitlement checks, and billing UI.

## Recommendation

Use a hybrid model:

- Monthly subscription for predictable customer pricing.
- Included usage credits per plan so agent compute, model tokens, browser runtime, and sandbox runtime stay economically bounded.
- Optional overage or top-up credits for teams that exceed included usage.
- Enterprise contracts for larger customers, custom limits, SSO, audit, support, and self-hosted or dedicated deployments.

Use Stripe Billing for the hosted SaaS unless there is a firm product decision to keep the existing hosted overlay on Polar. Stripe is the safer default for SaaS subscriptions because it covers checkout, billing portal, invoices, coupons, tax integrations, webhooks, customer management, and enterprise procurement better.

Keep money handling out of the OSS core. The OSS platform should continue to emit usage and enforce entitlements through clean interfaces. Hosted billing should live in a hosted-only service or overlay.

## Tiers

### Starter

Price: `$49/month` for the first year or early-access cohort.

Suggested scope:

- 1 workspace.
- Limited seats.
- Limited active agents and sessions.
- Included monthly compute credits.
- Basic integrations.
- Community or standard support.

### Team

Price: `$149/month`.

Suggested scope:

- More seats.
- More active agents, sessions, deployments, and memory stores.
- Higher included monthly compute credits.
- Scheduled jobs, webhooks, and production deployments.
- Shared credential vaults.
- Priority support.

### Enterprise

Price: custom.

Suggested scope:

- SSO/SAML.
- Audit logs.
- Dedicated limits and usage commitments.
- Dedicated model keys or customer-owned model keys.
- VPC, self-hosted, or dedicated deployment options.
- Contract invoicing, SLA, security review, and support.

## Billing Architecture

1. Hosted app records raw usage events.
2. Hosted billing worker pulls `/v1/internal/usage_events` with `BILLING_INTERNAL_SECRET`.
3. Billing worker converts usage into internal compute credits.
4. Billing worker writes a credit ledger and subscription entitlement state.
5. Billing worker acknowledges reconciled usage event IDs.
6. App checks entitlements before starting expensive work such as sessions, sandboxes, browser sessions, scheduled jobs, and deployment jobs.
7. Console billing plugin reads hosted billing state and opens Stripe checkout or portal.

Keep Stripe as the payment source of truth for payment state. Keep Open Managed Agents as the source of truth for product entitlements, credit ledger, and usage records.

## Usage Metering

Expose customer-friendly "compute credits" instead of raw tokens.

Recommended internal inputs:

- Model tokens, normalized by provider and model price.
- Sandbox active seconds.
- Browser active seconds.
- Session alive seconds.
- Storage and memory store size later.
- Webhook, scheduled job, and integration volume later.

Show customers a simple monthly usage bar and recent usage history. Avoid making users reason about exact token math unless they ask for detailed billing export.

## Entitlements And Enforcement

Add entitlement checks for:

- Workspace subscription status.
- Included credits remaining.
- Active session and sandbox concurrency.
- Agent count.
- Deployment count.
- Scheduled job and webhook availability.
- Vault and integration availability by tier if needed.

Enforcement should be graceful:

- Warn at 80 percent included usage.
- Warn again at 100 percent.
- Gate new expensive work when blocked.
- Avoid killing an active turn mid-response unless fraud or abuse is detected.
- Allow paid overage, top-up credits, or a short grace window for trusted customers.

## Implementation Tasks

- [ ] Decide final hosted billing provider: Stripe Billing by default, Polar only if the hosted overlay is already committed to it.
- [ ] Create hosted-only billing service or overlay, separate from OSS runtime money handling.
- [ ] Add billing schema for customer profile, subscription state, entitlements, credit ledger, reconciliation cursor, and webhook idempotency.
- [ ] Create Stripe products and prices for Starter `$49/month`, Team `$149/month`, annual variants, and Enterprise placeholder.
- [ ] Add checkout endpoint for plan purchase and upgrade.
- [ ] Add billing portal endpoint for payment method, invoices, cancellation, and plan changes.
- [ ] Add Stripe webhook handler for subscription lifecycle, invoice payment, failed payment, checkout completion, and customer updates.
- [ ] Reconcile `/v1/internal/usage_events` into the credit ledger and acknowledge processed events.
- [ ] Add entitlement API used by the app before starting sessions, sandboxes, browser runtime, deployments, scheduled jobs, and webhooks.
- [ ] Add hosted console billing plugin page for plan status, usage, invoices, portal link, checkout link, and upgrade prompts.
- [ ] Add admin override path for enterprise plans, trial extensions, and support debugging.
- [ ] Add tests for webhook idempotency, entitlement decisions, usage reconciliation, credit exhaustion, grace windows, and UI states.
- [ ] Add operational env vars and runbooks: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `BILLING_INTERNAL_SECRET`, `PUBLIC_BILLING_URL`, alerting, and reconciliation monitoring.

## Open Decisions

- Whether Starter is a permanent `$49/month` plan or a first-year founder plan with later migration.
- Whether to allow automatic overage billing or require top-up credits.
- Which tier gets scheduled jobs and webhooks by default.
- Whether hosted users can bring their own model keys to reduce platform cost exposure.
- Whether self-hosted users get billing disabled entirely or can optionally connect their own Stripe and Composio accounts.
