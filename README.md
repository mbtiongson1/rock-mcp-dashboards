# Rock MCP (Model Context Protocol Server for Rock RMS)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI Status](https://github.com/favorchurch/rock-mcp/workflows/CI/badge.svg)](https://github.com/favorchurch/rock-mcp/actions)

An open-source Model Context Protocol (MCP) server that exposes **Rock RMS** (a church management system) to AI assistants (such as Claude Desktop, Cursor, and other compatible LLM clients).

Developed by **Favor Church Manila**, `rock-mcp` acts as a secure, low-token action-router and OAuth 2.0 proxy to interface AI operations safely with Rock RMS v17.7 and REST v1 APIs.

---

## 🌟 Key Features

- **OAuth 2.0 Secured Gateway:** Dynamic Client Registration (DCR), PKCE-based authorization flow, and Auth0 JWT verification (JWKS) to execute operations securely on behalf of authenticated users.
- **Fail-Safe Security Model:**
  - **Dynamic Modes:** Employs three gateways (`/mcp` auto-detecting, `/mcp/readonly`, and `/mcp/readwrite`). If user claims fail to resolve or permissions are insufficient, it automatically fails closed to read-only.
  - **Dry-Run by Default:** All write/mutation actions default to `dryRun: true`. Persisted modifications require `dryRun: false` and `commit: true`.
  - **Write Auditing:** Every mutation requires a human-readable `reason` string, compiled into a single-line JSON log for standard observability pipelines.
  - **Strict Allowlist:** Mutative operations restricted to a specific set of models (e.g., people, notes, connection requests) and allowed fields to prevent arbitrary database updates.
- **Built-in React Report Viewer:** An MCP App (`ui://rock/report-viewer.html`) powered by `@modelcontextprotocol/ext-apps` to let users view, filter, and analyze large datasets or report outputs interactively inside their IDE/client.
- **Church-Specific Capabilities:** Native tools designed for campus filterings, ministry connect group health analysis, serving rosters, and the Favor church four-stage lifecycle model.

---

## 📂 Repository Structure

- [`app/`](file:///Users/rico/Git/rock-mcp/app) — Next.js Route Handlers for the public HTTP endpoints, OAuth 2.0 proxy (`/oauth/*`), and `.well-known` configuration.
- [`src/`](file:///Users/rico/Git/rock-mcp/src) — Core application source code:
  - [`src/server.ts`](file:///Users/rico/Git/rock-mcp/src/server.ts) — Developer stdio server entry point.
  - [`src/mcp/`](file:///Users/rico/Git/rock-mcp/src/mcp) — MCP tool registration, modes, and application integrations.
  - [`src/tools/`](file:///Users/rico/Git/rock-mcp/src/tools) — Standardized domain-specific MCP tool definitions.
  - [`src/auth/`](file:///Users/rico/Git/rock-mcp/src/auth) — Write authorization validation, auditing, and Auth0-to-Rock person resolution.
  - [`src/rock/`](file:///Users/rico/Git/rock-mcp/src/rock) — Rock RMS HTTP client, authentication strategy, and Redis cache config.
  - [`src/discovery/`](file:///Users/rico/Git/rock-mcp/src/discovery) — Automated Rock RMS capability discovery (attributes, reports, group types).
  - [`src/apps/report-viewer/`](file:///Users/rico/Git/rock-mcp/src/apps/report-viewer) — React code for the interactive Report Viewer app.
- [`static/`](file:///Users/rico/Git/rock-mcp/static) — Static assets and localized markdown guides injected into the MCP server instructions.
- [`tests/`](file:///Users/rico/Git/rock-mcp/tests) — Comprehensive test coverage (Vitest).

---

## 🚀 Connection Endpoints

Depending on the security policy and client configuration, `rock-mcp` exposes three main endpoints:

| Endpoint | Method | Scope | Behavior |
|---|---|---|---|
| `/mcp` | `POST` | `read` | **Smart Gateway:** Auto-detects user admin privileges. Elevates to read-write for Rock Admins with write scopes; otherwise defaults to read-only. |
| `/mcp/readonly` | `POST` | `read` | **Read-Only Gateway:** Enforces a read-only context. Safe default for standard LLM connections. |
| `/mcp/readwrite` | `POST` | `read + write` | **Read-Write Gateway:** Requires explicit write scopes and admin permissions. |

---

## 🛠️ Integration Guide

### Claude Desktop

To register the MCP server, add it to your `claude_desktop_config.json`:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "rock-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/sdk",
        "connect",
        "https://rock-mcp.favor.church/mcp"
      ]
    }
  }
}
```

### Cursor IDE

To connect using Cursor:
1. Go to **Settings > Features > MCP**.
2. Click **+ Add New MCP Server**.
3. Set the parameters:
   - **Name:** `rock-mcp`
   - **Type:** `command`
   - **Command:** `npx -y @modelcontextprotocol/sdk connect https://rock-mcp.favor.church/mcp`
4. Complete the Auth0 browser-based authorization flow when prompted.

---

## 🛡️ Security & PII Standards

- **Privacy-Safe by Default:** Queries returning person records exclude email, phone, birthdate, address, notes, and financial details unless explicitly requested.
- **Audit-Required Writes:** Any write/patch/delete operation requires a `reason` parameter.
- **Fail-Safe Mode Checks:** If mapping a user's Auth0 ID to a Rock Person fails, the system locks into read-only mode to prevent privilege escalation.
- **Bulk Write Limits:** Multi-patch operations are capped at a maximum of **25 items** to protect against bulk corruption or unintended resource utilization.

---

## 💻 Local Development

### Prerequisites

- Node.js v22+
- `pnpm` (package manager)
- A local `.env` file containing:

```env
AUTH0_DOMAIN=your-auth0-domain.auth0.com
AUTH0_AUDIENCE=https://your-api-audience.com
AUTH0_CLIENT_ID=your-auth0-client-id
AUTH0_CLIENT_SECRET=your-auth0-client-secret
MCP_PUBLIC_URL=http://localhost:3000
ROCK_API_URL=https://rock.yourchurch.com/api
ROCK_API_KEY=your-local-dev-rock-api-key
ROCK_PUBLIC_URL=https://rock.yourchurch.com
# Optional Redis cache (falls back to in-memory locally if omitted)
UPSTASH_KV_REST_API_URL=https://your-redis.upstash.io
UPSTASH_KV_REST_API_TOKEN=your-redis-token
```

### Commands

| Command | Action |
|---|---|
| `pnpm install` | Install all workspace dependencies. |
| `pnpm dev` | Run Next.js development server (port `3000`). |
| `pnpm dev:stdio` | Starts local CLI stdio MCP server for testing/debugging. |
| `pnpm build` | Builds the React Report Viewer app and bundles Next.js. |
| `pnpm test` | Run Vitest unit tests. |
| `pnpm lint` | Run ESLint check. |
| `pnpm typecheck` | Run TypeScript compilation check. |

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
