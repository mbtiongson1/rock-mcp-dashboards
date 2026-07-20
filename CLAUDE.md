# CLAUDE.md

Guidance for Claude Code when working in this repository.

> **Do not read anything under `docs/` unless the task explicitly asks for it.**
> `docs/` is reference/history, not current source of truth. `docs/spec/ROCK_MCP_IMPLEMENTATION_PLAN.md`
> in particular is an early planning artifact and is now **out of date** — do not treat it as the
> current design or pull facts from it. To understand the system, read the code and this file.

## What this is

**rock-mcp** is a Model Context Protocol (MCP) server that exposes **Rock RMS** (a church
management system) to AI assistants. It is an OAuth-secured gateway: MCP clients authenticate
via an Auth0-backed OAuth 2.0 proxy, and the server forwards calls to the Rock REST API on the
authenticated user's behalf — with per-user permissions and read-only / read-write modes.

Deployed serverlessly to **Vercel** at `https://rock-mcp.favor.church`.

## Tech stack

- **TypeScript** (strict mode, ES2022, `module: esnext`)
- **Next.js 16** (App Router) — HTTP transport for the MCP server
- **@modelcontextprotocol/sdk** + **@modelcontextprotocol/ext-apps** (MCP Apps UI)
- **jose** — Auth0 JWT verification (JWKS)
- **@upstash/redis** — serverless caching (OAuth transactions, discovery, defined values)
- **zod** — schema validation
- **react** 19 — the report-viewer MCP App
- **pnpm** package manager, **webpack** build, **esbuild** for the report viewer
- **vitest** for tests, **ESLint** + typescript-eslint for linting

## Commands

Use **pnpm** (matches `pnpm-lock.yaml`).

| Command | Purpose |
|---|---|
| `pnpm dev` | Next.js dev server (port 3000), webpack |
| `pnpm dev:stdio` | Local CLI stdio MCP server (`tsx src/server.ts --stdio`), admin/readwrite |
| `pnpm build` | Build report viewer + Next.js production build |
| `pnpm build:apps` | Bundle `report-viewer.html` via esbuild |
| `pnpm build:server` | `tsc -p tsconfig.server.json` (compiles `src/`) |
| `pnpm start` | Next.js production server |
| `pnpm test` | Vitest (unit + integration) |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | TypeScript check (both tsconfigs) |

To validate changes quickly, prefer `pnpm lint` and `pnpm typecheck` over a full build.

## Architecture

Two entry paths share the same tool implementations:

- **HTTP (production):** `app/mcp/route.ts`, `app/mcp/readonly/route.ts`
  → `src/http/mcp-route.ts` (`handleMcpPost`). Validates the OAuth bearer token, resolves the
  mode, builds a per-request MCP server, dispatches the tool call.
- **CLI (local dev):** `src/server.ts` — stdio transport, in-memory dev context with admin rights.

### Layout

```
app/                     Next.js route handlers (MCP endpoints, OAuth, .well-known)
  oauth/                 authorize · callback · token · register  (OAuth 2.0 proxy)
src/
  server.ts              stdio entry point
  mcp/
    register-tools.ts    tool registration (always register via this — see below)
    modes.ts             readonly / readwrite / auto mode resolution
    apps.ts              MCP Apps (report viewer) registration
  tools/                 MCP tool implementations + types/formatter/schema-utils
  http/                  HTTP layer: mcp-route, oauth*, app-context (DI), server-override
  rock/                  Rock API client, auth strategies, OData query helpers, redis
  auth/                  write authorization, audit logging, OAuth→Rock person resolution
  discovery/             Rock capability discovery (group types, attributes, reports)
  apps/report-viewer/    React report viewer (bundled to a single HTML file)
tests/                   vitest unit + *.integration.test.ts
docs/                    reference/history only — do not auto-read (see note at top)
```

### MCP tools (`src/tools/`)

`rock_usage`, `rock_lookup`, `rock_entity`, `rock_people`, `rock_ministry`, `rock_report`,
`rock_workflow`, `rock_roster` (all read or read/write) and `rock_write` (read-write only). Each
implements the `GatewayTool` interface (`src/tools/types.ts`): `schemaForMode()` returns a Zod
schema or `null` to hide the tool in a given mode, and `handle()` runs with the injected
`OAuthRockContext`.

### Modes

Two endpoints:

- `/mcp/readonly` → read-only tools only.
- `/mcp` → auto: read-write if the token holds the `write` scope **and** the resolved Rock person
  is either an RSR admin **or** leads at least one group (`ledGroupIds.length > 0`); otherwise
  read-only. Fails closed to read-only on any person-resolution failure.

Write authorization is tiered within read-write mode: a non-admin group leader may use
`rock_ministry`/`rock_roster` writes only for groups they lead; `rock_people` writes, `rock_write`,
and workflow/connection writes stay **admin-only**. Leader-only callers (not staff/admin) also get
a restricted read surface: `rock_report` is hidden and `rock_entity` blocks financial models
(`FORBIDDEN_MODEL`).

### Auth flow

OAuth 2.0 proxy passing through to Auth0. Clients register (`/oauth/register`, PKCE S256),
authorize (`/oauth/authorize`), and exchange the proxy code for an Auth0 JWT (`/oauth/token`).
Bearer tokens are verified via Auth0 JWKS in `src/http/oauth.ts`. The Auth0 `sub` is mapped to a
Rock person in `src/auth/rock-user-resolver.ts`; the user's own JWT is forwarded to Rock
(`UserJwtStrategy` in `src/rock/auth-strategy.ts`). (`docs/oauth-proxy.md` documents this design,
but read it only if explicitly asked — see the note at the top of this file.)

## Conventions

- Source files and tests: **kebab-case** (`rock-entity.ts`, `rock-people.test.ts`).
- Strict TypeScript: `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`,
  `noFallthroughCasesInSwitch`. Prefix intentionally-unused args with `_`.
- `@typescript-eslint/no-explicit-any` is a **warning**; `no-unused-vars` is an **error**.
- Path alias `@/*` → repo root. No Prettier — rely on ESLint.
- Always register tools through `registerGatewayTools` in `src/mcp/register-tools.ts`. Registering
  `z.discriminatedUnion`-rooted tools directly advertises an **empty** schema to clients.

## Known Rock API quirks

- Use the **v1** REST API; v2 endpoints return 401.
- Bearer-JWT auth to Rock needs a JWT Config defined value and a search-key backfill from the
  `AUTH0_*` UserLogins on the Rock side.
- `Reports/run` can 404; use `$select=Id` when you only need counts.
- **v1 OData pagination:** `$skip` requires a preceding `$orderby`, or Rock 500s
  (*"The method 'Skip' is only supported for sorted input… 'OrderBy' must be
  called before the method 'Skip'"*). Build paginated v1 queries via
  `odataPagination()` in `src/rock/query.ts`, which always emits `$orderby`
  (default `Id`) before `$skip`.
- Never compare an enum (e.g. `GroupMemberStatus`) to an integer in a v1 OData
  `$filter` — the EDM type is string and Rock 400s (*"incompatible types
  'Edm.String' and 'Edm.Int32'"*). Filter by ids only and check the enum
  client-side, accepting both representations (`1` and `'Active'`). This also applies to
  `RSVP`/`ScheduledToAttend` below — never put either in a `$filter`.
- **Group Scheduler / roster** (`rock_roster`): rostering = assigning a volunteer to a serving
  role (a `Location`) for a service (a `Schedule`) on a date. It is persisted as an
  `AttendanceOccurrence` (keyed on `GroupId`+`LocationId`+`ScheduleId`+`OccurrenceDate`) plus an
  `Attendance` (`PersonAliasId`, `ScheduledToAttend=true`, `RSVP`). `SundayDate` is omitted on
  occurrence create — Rock computes it. RSVP enum: `No=0`, `Yes=1`, `Maybe=2`, `Unknown=3`;
  `schedule` uses `Unknown` for a pending assignment and `Yes` once confirmed.

## Environment

No `.env.example`; `.env` (Rock preview) and `.env.production` (production Rock) exist locally.
Expected vars: `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`,
`MCP_PUBLIC_URL`, `ROCK_API_URL`, `ROCK_PUBLIC_URL`, and the Upstash Redis URL/token
(`UPSTASH_KV_REST_API_URL` / `UPSTASH_KV_REST_API_TOKEN`). Redis falls back to in-memory locally.

## Codebase knowledge graph

`graphify-out/` (gitignored) holds a graphify knowledge graph of this repo — `GRAPH_REPORT.md`
(communities, god nodes, surprising connections), `graph.html` (interactive), and `graph.json`.
Rebuild with `/graphify .` or `/graphify . --update` after structural changes.
