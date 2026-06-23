# Rock MCP

Rock MCP is a Model Context Protocol server for Rock RMS at Favor Church Manila. It lets MCP-compatible clients query Rock, run reports, open an embedded report viewer, and perform tightly controlled write operations through an Auth0-backed OAuth proxy that resolves each caller to a Rock person before tools run.

## Tech Stack

- TypeScript, strict mode, ES modules
- Next.js App Router route handlers for HTTP MCP and OAuth endpoints
- `@modelcontextprotocol/sdk` and `@modelcontextprotocol/ext-apps`
- Auth0-compatible OAuth/OIDC metadata and JWT verification through `jose`
- Rock RMS REST v1 plus selected v2 model search endpoints
- Upstash Redis for OAuth transactions, discovery cache, and stored report datasets
- React 19 report-viewer MCP App bundled with esbuild
- Vitest, ESLint, TypeScript, GitHub Actions, CodeQL, and Gitleaks
- Vercel-oriented serverless deployment

## Architecture

Two transports share the same tool implementations:

- HTTP production path: `app/mcp/**/route.ts` calls `src/http/mcp-route.ts`, validates OAuth bearer tokens, resolves the endpoint mode, builds a per-request MCP server, registers tools, and delegates to the streamable HTTP transport.
- Local stdio path: `src/server.ts --stdio` starts an MCP server with API-key Rock credentials and an admin-like dev context for local inspection.

Top-level layout:

| Path | Purpose |
| --- | --- |
| `app/` | Next.js route handlers for `/mcp`, `/mcp/readonly`, `/mcp/readwrite`, `/oauth/*`, and OAuth metadata routes. |
| `src/http/` | Fetch-native HTTP layer, OAuth proxy, token validation, dynamic client registration, app context construction, and Rock server override checks. |
| `src/mcp/` | MCP mode resolution, guide text, tool registration, and MCP App resource registration. |
| `src/tools/` | Gateway tools for usage, lookup, entity access, people, ministry, reports, workflows, and writes. |
| `src/auth/` | Rock user resolution, write authorization, and audit logging. |
| `src/rock/` | Rock HTTP client, auth strategies, query helpers, defined values, and Redis setup. |
| `src/discovery/` | Runtime discovery and confidence scoring for campuses, group types, attributes, reports, workflows, and connection types. |
| `src/apps/report-viewer/` | React-powered MCP App source and HTML template. |
| `static/` | Markdown guide text and static assets bundled into the MCP server. |
| `scripts/` | Build, live-test, tool-dump, and Redis inspection helpers. |
| `tests/` | Vitest unit tests plus Rock-backed integration tests that skip when live Rock env vars are absent. |

See [ARCHITECTURE.md](ARCHITECTURE.md) for the request flows and security model.

## Local Setup

Prerequisites:

- Node.js 22
- `pnpm`
- Access to an Auth0 application/API and a Rock RMS instance for end-to-end testing
- Upstash Redis for deployed OAuth flows; local development can fall back to in-memory stores

Install dependencies:

```bash
pnpm install
```

Create a local `.env` file with placeholder values like these:

```env
AUTH0_DOMAIN=<your-auth0-domain>
AUTH0_AUDIENCE=<your-auth0-api-audience>
AUTH0_CLIENT_ID=<your-auth0-client-id>
AUTH0_CLIENT_SECRET=<your-auth0-client-secret>
MCP_PUBLIC_URL=http://localhost:3000
ROCK_PUBLIC_URL=<your-rock-base-url>
ROCK_API_URL=<your-rock-api-url>
ROCK_API_KEY=<your-local-rock-api-key>
UPSTASH_KV_REST_API_URL=<your-upstash-url>
UPSTASH_KV_REST_API_TOKEN=<your-upstash-token>
```

Run the HTTP server:

```bash
pnpm dev
```

Run the local stdio server:

```bash
pnpm dev:stdio
```

## Configuration

Environment variables are loaded by Next/Vercel for HTTP routes. `src/server.ts` and `vitest.config.ts` also try to load `.env` locally.

| Name | Purpose |
| --- | --- |
| `AUTH0_DOMAIN` or `AUTH0_ISSUER` | Required OAuth issuer. A bare Auth0 domain is normalized to `https://.../`; HTTPS is required. |
| `AUTH0_AUDIENCE` | Required OAuth API audience used when verifying access tokens and requesting Auth0 tokens. |
| `AUTH0_CLIENT_ID` | Required confidential Auth0 client ID used by this server's OAuth proxy. |
| `AUTH0_CLIENT_SECRET` | Required confidential Auth0 client secret used by this server's OAuth proxy. |
| `MCP_PUBLIC_URL` | Required public base URL for OAuth metadata and callback URLs; HTTPS is required except loopback HTTP for local development. |
| `OAUTH_ISSUER`, `OAUTH_DOMAIN`, `OAUTH_AUDIENCE`, `OAUTH_PUBLIC_URL`, `OAUTH_RESOURCE_SERVER_URL` | Compatibility aliases accepted by the OAuth config loader. Prefer the `AUTH0_*` and `MCP_PUBLIC_URL` names above. |
| `ROCK_PUBLIC_URL` | Default Rock base URL used by HTTP routes, local stdio mode, integration tests, discovery cache partitioning, and the landing page. |
| `ROCK_API_URL` | Fallback Rock base URL when `ROCK_PUBLIC_URL` is unset. |
| `ROCK_BASE_URL` | Discovery-only fallback used when both public/API Rock URLs are unset. |
| `ROCK_API_KEY` | Local stdio and live integration-test credential. HTTP production calls forward the user's bearer token instead. |
| `ROCK_ALLOWED_SERVERS` | Comma-separated extra HTTPS Rock hosts allowed for the `/mcp?server=` override. |
| `ROCK_MCP_BULK_WRITE_MAX` | Maximum item count for bulk write authorization; defaults to `25`. |
| `ROCK_MCP_DATASET_TTL_SECONDS` | TTL for stored report/ministry datasets; defaults to `900`. |
| `ROCK_MCP_DISCOVERY_TTL_SECONDS` | TTL for discovery maps; defaults to `900`. |
| `ROCK_MCP_REDIS_PREFIX` | Redis key prefix; defaults to `rock-mcp:prod:`. |
| `UPSTASH_KV_REST_API_URL` | Upstash Redis REST URL. If absent with the token, local in-memory stores are used. |
| `UPSTASH_KV_REST_API_TOKEN` | Upstash Redis REST token. Required with the URL for serverless-safe OAuth transactions and caches. |
| `OAUTH_REDIRECT_URI_ALLOWLIST` | Optional comma-separated redirect URI host suffix allowlist for dynamic client registration. |

Security-sensitive mode behavior:

- `/mcp/readonly` requires `read` and always exposes read-only tools.
- `/mcp/readwrite` requires `read` and `write`.
- `/mcp` requires `read` and upgrades to read-write only when the token has `write` and the resolved Rock person is an RSR admin.
- Person resolution failures fail closed before tools are registered.
- Mutating tools default to `dryRun: true`; persisted writes require `dryRun: false`, `commit: true`, and a non-empty `reason`.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Starts the Next.js development server with webpack. |
| `pnpm dev:stdio` | Starts `src/server.ts --stdio` through `tsx`. |
| `pnpm build` | Builds the report-viewer app and the Next.js production bundle. |
| `pnpm build:apps` | Bundles `src/apps/report-viewer/report-viewer.ts` into `dist/apps/report-viewer.html`. |
| `pnpm build:server` | Runs `tsc -p tsconfig.server.json`. |
| `pnpm start` | Starts the built Next.js server. |
| `pnpm start:stdio` | Starts `dist/server.js --stdio` after `pnpm build:server`. |
| `pnpm test` | Runs `vitest run`. |
| `pnpm lint` | Runs ESLint without autofix. |
| `pnpm typecheck` | Type-checks both the server and app TypeScript configs. |

## Testing And Validation

Fast local validation:

```bash
pnpm typecheck
pnpm test
pnpm lint
```

Rock-backed `*.integration.test.ts` files use `ROCK_PUBLIC_URL` and `ROCK_API_KEY` and skip cleanly when those variables are not set. CI installs with `pnpm install --frozen-lockfile`, runs `pnpm typecheck`, and runs `pnpm vitest run`; separate workflows run CodeQL and Gitleaks.

## Deployment

This app is designed to ship as a Vercel-hosted Next.js serverless project. `next.config.ts` traces `static/**/*` and `dist/apps/**/*` into the MCP route bundles so guide markdown and the report-viewer HTML are available at runtime. Configure the Auth0, Rock, and Upstash variables in the deployment environment before exposing OAuth or MCP endpoints.

Expected public endpoints:

| Endpoint | Purpose |
| --- | --- |
| `/` | Landing/status page. |
| `/mcp` | Auto read/read-write MCP endpoint. |
| `/mcp/readonly` | Forced read-only MCP endpoint. |
| `/mcp/readwrite` | Forced read-write MCP endpoint. |
| `/oauth/register` | Dynamic client registration for MCP clients. |
| `/oauth/authorize` | OAuth authorization proxy endpoint. |
| `/oauth/callback` | Fixed Auth0 callback target for the proxy. |
| `/oauth/token` | OAuth token proxy endpoint. |
| `/.well-known/oauth-authorization-server` | Localized authorization-server metadata. |
| `/.well-known/oauth-protected-resource` | Protected-resource metadata for MCP clients. |

## Contributing And Release Flow

The repository workflows show a main-branch flow: pull requests run CI, pushes to `main` run CI, and the Vercel project is the production target. Keep changes small, add or update focused Vitest coverage for behavior changes, run `pnpm typecheck`, `pnpm test`, and `pnpm lint`, then promote through the normal PR/review path before production deployment.

When adding a tool, implement the `GatewayTool` contract in `src/tools/`, add it to `src/tools/index.ts`, and let `registerGatewayTools` advertise it. Do not bypass `registerGatewayTools`; it flattens schemas for MCP clients and normalizes validation errors.
