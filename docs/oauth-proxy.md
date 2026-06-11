# OAuth Authorization-Server Proxy

Rock MCP is the authorization server MCP connectors (claude.ai, ChatGPT, local
CLIs) talk to. It delegates login and token issuance to Auth0 through **one
dedicated confidential application**, so the Auth0 tenant config never changes
at runtime and **no Auth0 Management API credentials are needed**.

## Flow

```
Connector ── POST /oauth/register ──────▶ Redis registration (per-connector mcp_* client_id)
Connector ── GET  /oauth/authorize ─────▶ validate client_id + exact redirect_uri,
                                          store txn (state, PKCE S256), 302 → Auth0 /authorize
Auth0     ── GET  /oauth/callback ──────▶ look up txn, exchange code with AUTH0_CLIENT_SECRET,
                                          store Auth0 token set under one-time proxy code (60s),
                                          302 → connector redirect_uri (?code + original state)
Connector ── POST /oauth/token ─────────▶ verify PKCE code_verifier, consume proxy code,
                                          return Auth0 access+refresh tokens verbatim
Connector ── MCP calls (Bearer JWT) ────▶ verified against Auth0 JWKS, forwarded to Rock v1
```

Because tokens are pass-through Auth0 JWTs, the existing verifier
(`src/http/oauth.ts`) and Rock Bearer forwarding (`UserJwtStrategy`) are
unchanged: Rock enforces the **logged-in person's own permissions**.

## One-time Auth0 setup

In the same tenant Rock's login uses, create a **Regular Web Application**
("Rock MCP"):

1. Allowed Callback URLs: `https://<MCP_PUBLIC_URL>/oauth/callback` (one entry, never grows)
2. Grant types: Authorization Code, Refresh Token
3. Refresh token rotation per your policy; `offline_access` is always requested
4. Authorize the app for the API identified by `AUTH0_AUDIENCE`
5. Put its credentials in env as `AUTH0_CLIENT_ID` / `AUTH0_CLIENT_SECRET`

## Environment

See `.env.target` for the canonical minimal set:
`AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`,
`MCP_PUBLIC_URL`, `ROCK_PUBLIC_URL`/`ROCK_API_URL`, Upstash Redis vars.

Removed: `AUTH0_MANAGEMENT_CLIENT_ID`, `AUTH0_MANAGEMENT_CLIENT_SECRET`,
`ROCK_API_KEY` (RSR admin detection now uses the user's own token and fails
closed to read-only).

Redis is **required** in serverless deployments — the authorize → callback →
token hops may land on different instances and share state through Redis. The
in-memory fallback is for single-instance local dev only.

## Security invariants

- `redirect_uri` is matched **exactly** (string equality) against the
  registered URIs at register/authorize/token. HTTPS only, except loopback
  hosts (`localhost`, `127.0.0.1`, `[::1]`) over HTTP for CLI flows.
- PKCE S256 is mandatory; `plain` is rejected.
- Proxy `state` is crypto-random, single-use, 10-minute TTL. The connector's
  own `state` is passed back untouched.
- Proxy authorization codes are single-use (`GETDEL`), 60-second TTL, and bound
  to the requesting `client_id` and PKCE challenge.
- Token responses carry `Cache-Control: no-store`.

## Rock-side requirements (Bearer JWT)

Rock v1 (`/api/...`) must accept the Auth0 access token via Rock's
**“JSON Web Token Configuration”** defined type (issuer/JWKS + person mapping
through a Person Search Key matching the token's `sub`). If a person cannot be
mapped, MCP returns the "no Rock person" error and no Rock data is accessible.

## Migration note

Connectors registered under the old shared-client flow hold Auth0-issued
client_ids that this proxy does not recognize. **Reconnect the integration**
(delete + re-add the connector); it will re-register via `/oauth/register`
automatically.
