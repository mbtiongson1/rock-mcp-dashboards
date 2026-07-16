---
id: logins-auth
title: Logins, Auth & Access
aliases: [login, logins, auth, oauth, auth0, jwt, access, sign in]
tags: [auth, security, oauth, logins, gateway]
---

## What it is

There are **two distinct login systems** at play around Favor's Rock instance.

### 1. Rock-side identity (UserLogins + JWT bridge)

Rock authenticates people via native **UserLogins**. To let external Auth0 tokens act *as* a Rock
person, Favor configured:

- **JSON Web Token Configuration** (DefinedType #82) — registers Auth0 as a trusted JWT issuer
  (JWKS + audience) so Rock's `GetCurrentPerson` accepts an Auth0 bearer token.
- **Person Search Keys** (DefinedType #70) — maps the Auth0 `sub` (and/or email) to a single Rock
  `Person`. A person without a backfilled search key fails to resolve.

### 2. The `rock-mcp` OAuth 2.0 gateway

An OAuth 2.0 authorization-server **proxy in front of Auth0**: untrusted MCP clients register
dynamically while the confidential Auth0 client secret stays server-side, then the gateway forwards
each caller's *own* JWT to Rock so Rock's per-user permissions remain authoritative.

Key properties: mandatory **PKCE S256**, single-use auth + proxy codes, JWT verified via JWKS
(issuer/audience/exp/sub), per-request user-scoped tokens, Redis-backed transaction state.

## Modes & scopes

- `/mcp/readonly` → read tools only.
- `/mcp` (auto) → readwrite only if `write` scope **and** (RSR-admin **or** active group leader); else fails
  closed to read-only. Group leaders get `rock_ministry`/`rock_roster` writes for the groups they lead only;
  `rock_people`/`rock_write`/workflow writes stay admin-only.
- Writes pass a fail-closed allowlist (model ▸ operation ▸ field; per-model tier: admin vs group-leader;
  bulk bounded).

## Best practice

- Diagnose "why am I read-only?" via `rock_usage` (no args) — its write-access diagnostics show
  endpoint, mode, scopes, write scope, RSR-admin, and resolved personId.
- If a user can't be resolved, check their **Person Search Key** backfill first.

## Related

`security-best-practices` · `campuses`
