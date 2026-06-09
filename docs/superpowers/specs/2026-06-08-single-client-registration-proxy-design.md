# Single-Client OAuth Registration Proxy — Design

**Date:** 2026-06-08
**Status:** Draft for review
**Repo:** `rock-mcp`

## Problem

MCP clients (Claude.ai, Codex, Gemini, …) connect to this server and perform OAuth
Dynamic Client Registration (DCR) **directly against Auth0**, because the server's
`/.well-known/oauth-authorization-server` metadata advertises Auth0's native
`registration_endpoint`. Every connection creates a **new third-party (`tpc_`) Auth0
client**, so clients pile up (we already see multiple `'Claude'` / `'Rock MCP'`
`tpc_` clients). This clutters the tenant and complicates auditing.

## Goal

All agents share **one** pre-registered Auth0 application. The server:

1. Exposes its **own** `POST /oauth/register` route and advertises it as the
   `registration_endpoint` (instead of Auth0's).
2. Returns a **fixed** `client_id` for every registration request — RFC 7591-compliant,
   public PKCE client. Result: exactly one client, forever.
3. **Auto-merges** any new `redirect_uri` from a registration request into that client's
   `callbacks` via the Auth0 Management API, so a brand-new agent works with no manual
   dashboard edit (agent-agnostic).

## Non-goals (YAGNI)

- No changes to Auth0 Actions / triggers / tenant policies.
- No client secrets handled by the proxy (the shared client is public, `token_endpoint_auth_method: "none"`).
- No user authn / authz logic — real authorization stays **Rock-side** (person resolution + `isRsrAdmin`).
- No per-agent client isolation (explicitly traded away — see Trade-offs).
- No allowlist-based registration in v1 (revisit if abuse appears).

## Prerequisites (Auth0-side — already done, except the two new apps)

- ✅ Tenant `default_audience = https://rock-mcp.favor.church`.
- ✅ Rock MCP API: `allow_offline_access = true`, RBAC disabled (`enforce_policies = false`, `token_dialect = access_token`).
- ⬜ **Shared public client** "Rock MCP" — a **new first-party public PKCE client**
  (`token_endpoint_auth_method: "none"`, `grant_types: ["authorization_code","refresh_token"]`,
  `response_types: ["code"]`). Its `client_id` becomes `AUTH0_CLIENT_ID`.
  **Do NOT reuse a `tpc_` DCR client** — those are third-party and DCR-managed; a purpose-created
  first-party client is stable and avoids the third-party userinfo/consent quirks.
- ⬜ **Dedicated M2M app** "Rock MCP Server Management" with **least-privilege** Management API
  scopes `read:clients`, `update:clients` only. Its credentials become
  `AUTH0_MANAGEMENT_CLIENT_ID` / `AUTH0_MANAGEMENT_CLIENT_SECRET`. (Replaces ad-hoc use of the
  all-scopes "API Explorer Application".)

## Architecture

### New files

- **`src/http/auth0-management.ts`** — `Auth0ManagementClient`: mint + cache M2M token (Redis),
  `getClient()`, `mergeCallbacks(uris)`. Dependency-injectable (`fetchFn`, `redis`).
- **`src/http/auth0-management.test.ts`** — unit tests (mock fetch + in-memory redis).
- **`app/oauth/register/route.ts`** — RFC 7591 `POST /oauth/register` handler + `OPTIONS`.
- **`app/oauth/register/route.test.ts`** — route tests via the `CreateAppContextOptions` DI seam.

### Modified files

- **`src/http/oauth.ts`** — add env-key arrays (`AUTH0_CLIENT_ID_KEYS`,
  `AUTH0_MANAGEMENT_CLIENT_ID_KEYS`, `AUTH0_MANAGEMENT_CLIENT_SECRET_KEYS`) + `loadAuth0ManagementConfig(env)`
  following the existing `firstEnvValue` pattern.
- **`src/http/app-context.ts`** — add `managementClient: Auth0ManagementClient` to `AppContext`;
  build it in `buildAppContext()`; extend `CreateAppContextOptions` with a `managementClientDeps?`
  seam for tests. Keep the cached-singleton behavior.
- **`app/.well-known/oauth-authorization-server/route.ts`** — override `registration_endpoint`
  to the proxy route.

## `/oauth/register` contract (RFC 7591)

**Request** (fields we read): `redirect_uris` (required, ≥1). All other fields
(`client_name`, `grant_types`, `token_endpoint_auth_method`, `jwks_uri`, `client_secret`, …) are
**accepted and ignored**.

**Response** (`201`, fixed): the shared client, echoing the merged callback set —
```jsonc
{
  "client_id": "<AUTH0_CLIENT_ID>",         // constant, non-tpc_ first-party public client
  "client_name": "Rock MCP",
  "redirect_uris": ["…all current callbacks…"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
  // no client_secret (public client)
}
```
Spec-compliant and PKCE-compatible; the constant `client_id` is allowed by RFC 7591 (the
server may return any registration it chooses).

## Metadata override

In `app/.well-known/oauth-authorization-server/route.ts`, spread `app.oauthMetadata` and replace
`registration_endpoint`. `resourceServerUrl.href` ends in `/`, so build carefully to avoid a
double slash:

```ts
const base = app.oauthConfig.resourceServerUrl.href.replace(/\/$/, '');
return jsonCors({ ...app.oauthMetadata, registration_endpoint: `${base}/oauth/register` });
```
`oauth-protected-resource` metadata is unchanged.

## `Auth0ManagementClient`

```ts
export interface Auth0ManagementClientDeps {
  redis?: RedisLike | null;
  fetchFn?: (url: URL, init?: RequestInit) => Promise<Response>;
}

export class Auth0ManagementClient {
  constructor(config: Auth0OAuthConfig, mgmtClientId: string, mgmtClientSecret: string,
              sharedClientId: string, deps?: Auth0ManagementClientDeps);
  // private getAccessToken(): mint via client_credentials, audience `${issuer}api/v2/`; cache in Redis
  getClient(): Promise<{ client_id: string; callbacks: string[] }>;
  mergeCallbacks(newUris: string[]): Promise<string[]>; // returns the full merged set; idempotent
}
```

- **Token cache:** Redis key namespaced via the existing prefix helper; store
  `{ access_token, expires_at }`; treat as expired ~30s early; re-mint on miss/expiry. If Redis is
  absent, fall back to minting per call (matches the codebase's optional-Redis pattern).
- **Merge:** `GET` current `callbacks` → union with guarded new URIs → `PATCH` only if changed.

## Security

Guards on incoming `redirect_uris` before merge:
1. **HTTPS-only**, except loopback `http://localhost|127.0.0.1|[::1]` for local dev — reuse the
   scheme logic already in `oauth.ts` (`assertAllowedUrlScheme`).
2. **Cap** total callbacks on the shared client (e.g. 50) — reject the merge past the cap.
3. **Idempotent** union — never duplicate.

**Residual risk:** the endpoint is unauthenticated (per the DCR model), so anyone can merge an
HTTPS callback into the shared client. The guards bound this (HTTPS-only, capped). Because the
real authorization is Rock-side and the client is public+PKCE, the practical exposure is limited
to callback-set pollution, mitigated by: logging every merge, and periodic review of the shared
client's `callbacks`. An allowlist is the v2 hardening if abuse is observed. This residual is the
accepted cost of the single-shared-client model.

## Error handling

- Invalid JSON / missing `redirect_uris` → `400 invalid_client_metadata` (RFC 7591 error shape).
- Guard failure (non-HTTPS, over cap) → `400 invalid_redirect_uri`.
- Management API failure → `500 server_error`, generic body, details logged server-side only
  (never leak tokens/secrets). Reuse `jsonCors`; add `OPTIONS` for CORS preflight.

## Concurrency note

Auth0 `PATCH /clients/{id}` **replaces** the `callbacks` array, so two parallel merges can clobber
each other (last-write-wins, dropping a URI). Mitigation for v1: keep the authoritative merged set
in Redis and union against it (not just the GET result); accept rare eventual-consistency since a
dropped URI self-heals on the agent's next registration. A Redis lock is v2 if it proves necessary.

## Test plan (vitest, DI style)

`auth0-management.test.ts`: token mint+cache set; cache hit (no re-mint); expiry → re-mint; API 401
→ typed error; `mergeCallbacks` idempotent; merge skips PATCH when unchanged.

`route.test.ts`: happy path returns fixed `client_id`; new URI merged; duplicate not re-added;
non-HTTPS rejected (400); loopback http allowed; over-cap rejected; missing `redirect_uris` (400);
mgmt-token cache hit across two calls; metadata route advertises `/oauth/register` with no double slash.

## Rollout & cleanup ("start fresh")

1. Create the shared public client + dedicated M2M app in Auth0; capture the three new env values.
2. Add `AUTH0_CLIENT_ID`, `AUTH0_MANAGEMENT_CLIENT_ID`, `AUTH0_MANAGEMENT_CLIENT_SECRET` to `.env`
   (local) and Vercel **production**.
3. Ship the code; verify `/.well-known/oauth-authorization-server` advertises `/oauth/register`.
4. Reconnect each agent (Claude, Codex) → confirm they all receive the single shared `client_id`
   and `tools/list` works.
5. Delete the stale `tpc_` clients from Auth0. Watch for ~1–2 weeks that no new `tpc_` clients appear.

## Ordered implementation steps (TDD)

1. `oauth.ts`: env keys + `loadAuth0ManagementConfig` (+ test).
2. `auth0-management.ts`: token mint/cache, `getClient`, `mergeCallbacks` (+ tests).
3. `app-context.ts`: wire `managementClient` into `AppContext` + DI seam.
4. `app/oauth/register/route.ts`: handler + guards + RFC 7591 response (+ tests).
5. `oauth-authorization-server/route.ts`: override `registration_endpoint` (+ test).
6. Lint (per AGENTS.md: lint only for Next.js — no full build).

## Trade-offs

- **One shared client** → no per-agent revoke/audit, one callback list, shared consent. Acceptable
  because authorization is Rock-side (we already disabled Auth0 RBAC for that reason).
- **Single point of failure** → if the shared client is deleted/misconfigured, all agents break.
  Mitigate with monitoring; the client is long-lived and rarely touched.
