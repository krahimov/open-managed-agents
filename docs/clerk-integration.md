# Clerk integration (auth, user sync to the app DB, billing)

Opt-in overlay for hosted deployments that keep their user store in Clerk
and their app database in Postgres (Neon). better-auth remains the OSS
default; both run side by side — cookie sessions resolve first, then
Clerk session JWTs.

**Verified 2026-07-01** end-to-end against a live main-node: signed
webhook → `clerk_users` + tenant + membership rows; `Authorization:
Bearer <session JWT>` → 200 on /v1 APIs under the user's tenant; free
plan at cap → 402 `payment_required`; `subscriptionItem.active` (pro) →
unblocked; `subscriptionItem.canceled` → capped again; token `pla` claim
→ plan sync. The store also round-trips against Neon Postgres (dialect-
aware DDL/upserts, tested live).

## Env

```
CLERK_ISSUER=https://your-app.clerk.accounts.dev   # or CLERK_PUBLISHABLE_KEY (issuer derived)
CLERK_WEBHOOK_SIGNING_SECRET=whsec_...             # Dashboard → Webhooks
CLERK_AUTHORIZED_PARTIES=https://app.example.com   # optional azp allowlist
CLERK_BILLING_ENFORCE=1                            # optional plan gating
CLERK_FREE_PLAN_ACTIVE_SESSION_LIMIT=3
CLERK_SECRET_KEY=sk_...                            # reserved for Backend API calls (not required)
```

## How it works

- **Auth** (`apps/main-node/src/lib/clerk.ts`, wired into packages/auth's
  `resolveSession`): RS256 verification against the instance JWKS
  (`{issuer}/.well-known/jwks.json`, 5-min cache + kid-rotation refetch),
  issuer pinned, exp/nbf with 60s skew, optional azp allowlist. On first
  sight of a user, a tenant + membership are provisioned through the same
  `ensureTenant` helper better-auth signups use, so agents/sessions/
  vaults work unchanged. API keys keep using `x-api-key` — no collision
  with the Bearer header.
- **User sync** (`POST /clerk/webhook`, svix-verified, public route):
  `user.created` / `user.updated` upsert `clerk_users` (id, tenant,
  primary email, name, avatar); `user.deleted` soft-deletes. Events are
  idempotent by svix id (`clerk_webhook_events` also serves as an audit
  log). Configure the endpoint in Clerk Dashboard → Webhooks with the
  user.* and billing event catalogs, pointing at
  `https://<your-host>/clerk/webhook`.
- **Billing**: two inputs, one state. Billing webhooks
  (`subscription.*`, `subscriptionItem.*`, `paymentAttempt.*`) fold into
  `clerk_users.plan` / `billing_status`; v2 session-token claims
  (`pla: "u:pro"`, `fea: "u:a,o:b"`) sync opportunistically on request —
  but only when the token actually carries billing claims (absent claims
  never clobber webhook state). Enforcement is a
  `SessionLifecycleHooks.preCreateGate`: free-plan tenants are capped at
  N concurrent non-archived sessions (402 with an upgrade message), paid
  plans pass, and tenants Clerk has never seen (better-auth users,
  api-key service tenants) fail open.

## Clerk Dashboard checklist

1. Create the app → copy the publishable key (or the issuer URL).
2. Billing → enable, define plans (slugs other than `free*` count as
   paid here).
3. Webhooks → add endpoint `https://<host>/clerk/webhook`, subscribe to
   `user.created`, `user.updated`, `user.deleted` and the billing events
   (subscription / subscriptionItem / paymentAttempt); copy the signing
   secret.
4. Frontend: use Clerk's components; call the OMA API with
   `Authorization: Bearer ${await session.getToken()}`.

## Console sign-in (Clerk mode)

Build the console with `VITE_CLERK_PUBLISHABLE_KEY=pk_…` and it flips to
Clerk end-to-end: `/login` renders Clerk's `<SignIn/>`, the auth context
maps Clerk's user, and every `api()` call + SSE stream carries
`Authorization: Bearer <session token>` (SSE resolves a fresh token on
every reconnect — Clerk tokens live ~60s). Without the env var the
classic better-auth screens render unchanged.

## Organizations

`organization.*` and `organizationMembership.*` webhooks map each Clerk
org to its own tenant (`clerk_orgs`), with members added to the tenant's
membership (org:admin → owner). A session token with an active org (`o`
claim) routes API requests to the org's tenant (membership-validated),
and org-payer billing events gate that tenant by the org's plan.

Billing events follow Clerk's published catalog: `subscription.created|
updated|active|pastDue`, `subscriptionItem.updated|active|canceled|
upcoming|ended|abandoned|incomplete|pastDue|freeTrialEnding`,
`paymentAttempt.created|updated`. Plan-clearing: canceled/ended/pastDue/
incomplete. Status-only (never move the plan): abandoned (describes the
OLD item on a plan switch), upcoming, freeTrialEnding, paymentAttempt.*.

## Known limits / next steps

- Exact billing payload field shapes are still parsed defensively
  (payer/plan.slug/status); Clerk's billing SKILL.md would let us pin
  them precisely.
- Sign-out UI in Clerk mode uses Clerk's components; the sidebar's
  better-auth sign-out button is a no-op for Clerk sessions (follow-up).
- Real-dashboard E2E needs CLERK_ISSUER + CLERK_WEBHOOK_SIGNING_SECRET
  (+ VITE_CLERK_PUBLISHABLE_KEY for the console build) from your Clerk
  app.
