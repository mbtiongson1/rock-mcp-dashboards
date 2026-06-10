# Next.js Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Express + Vite HTTP layer of `rock-mcp` with a native Next.js App Router project, removing all Vercel compatibility workarounds, while leaving MCP/Rock/auth/stdio logic untouched.

**Architecture:** Next.js App Router (Node runtime) with thin route handlers that delegate to framework-agnostic helpers. The MCP SDK's `WebStandardStreamableHTTPServerTransport` is Fetch-native (`handleRequest(req: Request): Promise<Response>`), so route handlers pass `NextRequest` straight through — no Node `req`/`res` bridge. OAuth bearer validation and `OAuthRockContext` construction are extracted into a `validateOAuthContext(request: Request)` helper. App dependencies (OAuth verifier/metadata, Rock clients, discovery, dataset store) are built once per serverless instance via a cached `getAppContext()`.

**Tech Stack:** Next.js 15 (App Router), React 19, `@modelcontextprotocol/sdk` 1.29 (`WebStandardStreamableHTTPServerTransport`), `jose`, TypeScript 5.4, Vitest, Vercel.

---

## File Structure

**New (Next.js + extracted helpers):**
- `next.config.ts` — `outputFileTracingIncludes` for `static/**` + built report-viewer; webpack externals if needed
- `app/route.ts` — `GET /` → landing page HTML
- `app/mcp/route.ts` — `POST /mcp`
- `app/mcp/readonly/route.ts` — `POST /mcp/readonly`
- `app/mcp/readwrite/route.ts` — `POST /mcp/readwrite`
- `app/.well-known/oauth-protected-resource/route.ts` — `GET` PRM JSON + CORS
- `app/.well-known/oauth-authorization-server/route.ts` — `GET` AS metadata JSON + CORS
- `src/http/app-context.ts` — cached `getAppContext()` building all deps
- `src/http/mcp-route.ts` — `handleMcpPost(request, endpointKind)` → `Response`
- `src/http/oauth-validate.ts` — `validateOAuthContext(request, opts)`, `corsHeaders`, `jsonCors`
- `tsconfig.server.json` — NodeNext build for stdio
- `public/static/icon.png`, `public/favicon.ico` — static assets served by Next

**Modified:**
- `package.json` — add `next`/`react`/`react-dom`/`@types/react`; drop `express`/`cors`/`@types/express`/`@types/cors` + `overrides`; scripts
- `tsconfig.json` — Next-owned (bundler resolution, jsx, next plugin)
- `src/http/oauth.ts` — drop Express types/middleware; add Fetch-`Request` overload of context builder
- `src/mcp/guide-text.ts` — add `process.cwd()` fallback path
- `src/mcp/apps.ts` — add `process.cwd()` fallback path
- `src/server.ts` — keep stdio branch; remove Express HTTP branch
- `vercel.json` — remove rewrites; keep function memory/duration only (or delete)

**Deleted:**
- `api/index.ts`
- `src/http/app.ts`
- `vite.config.ts` removed — report-viewer build replaced by `scripts/build-report-viewer.ts` (esbuild via tsx); `build:apps` retained

**Tests:**
- Replace `src/http/app.test.ts` → `src/http/mcp-route.test.ts` + `src/http/oauth-validate.test.ts`
- Keep `src/http/oauth.test.ts`, adjusting for removed Express middleware

---

### Task 1: Branch + Next.js dependencies + tsconfig split

**Files:** `package.json`, `tsconfig.json`, `tsconfig.server.json`, `next.config.ts`

- [ ] **Step 1:** Create branch `git checkout -b feature/nextjs-migration`
- [ ] **Step 2:** Add deps: `pnpm add next@15 react@19 react-dom@19` and `pnpm add -D @types/react@19 @types/react-dom@19`
- [ ] **Step 3:** Remove Express deps: `pnpm remove express cors @types/express @types/cors`, then delete the `overrides` block from `package.json`
- [ ] **Step 4:** Update `package.json` scripts:
  ```json
  "dev": "next dev",
  "dev:stdio": "tsx src/server.ts --stdio",
  "build": "next build && npm run build:apps",
  "build:apps": "vite build",
  "build:server": "tsc -p tsconfig.server.json",
  "start": "next start",
  "test": "vitest run",
  "lint": "next lint || eslint .",
  "typecheck": "tsc -p tsconfig.server.json --noEmit"
  ```
- [ ] **Step 5:** Create `tsconfig.server.json` (NodeNext for stdio build/typecheck):
  ```json
  {
    "extends": "./tsconfig.json",
    "compilerOptions": {
      "module": "NodeNext",
      "moduleResolution": "NodeNext",
      "jsx": "react-jsx",
      "outDir": "./dist",
      "rootDir": "./src",
      "noEmit": false,
      "plugins": []
    },
    "include": ["src/**/*"],
    "exclude": ["node_modules", "dist", "app", ".next"]
  }
  ```
- [ ] **Step 6:** Let Next own `tsconfig.json`: `module: "esnext"`, `moduleResolution: "bundler"`, `jsx: "preserve"`, `allowJs`, `noEmit: true`, `incremental: true`, `plugins: [{name:"next"}]`, `paths` if needed, `include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"]`, `exclude: ["node_modules", "dist"]`. Keep strict + the existing strict flags.
- [ ] **Step 7:** Create `next.config.ts` with Node runtime defaults and file tracing:
  ```ts
  import type { NextConfig } from 'next';
  const nextConfig: NextConfig = {
    outputFileTracingIncludes: {
      '/mcp': ['./static/**/*', './dist/apps/**/*'],
      '/mcp/readonly': ['./static/**/*', './dist/apps/**/*'],
      '/mcp/readwrite': ['./static/**/*', './dist/apps/**/*'],
    },
  };
  export default nextConfig;
  ```
- [ ] **Step 8:** Commit: `chore(next): add Next.js deps and split tsconfig for stdio build`

---

### Task 2: Extract app dependency context

**Files:** Create `src/http/app-context.ts`

- [ ] **Step 1:** Build a cached factory that mirrors `createApp()` setup (lines 42–96 of old `app.ts`) but returns a plain object instead of an Express app. Export `getAppContext(): Promise<AppContext>` memoized in a module-level variable. `AppContext` holds: `oauthConfig`, `oauthMetadata`, `verifier`, `resourceMetadataUrl`, `rockClient`, `rockUserResolver`, `discoveryService`, `datasetStore`. Accept an optional `CreateAppOptions`-style override object for tests (same fields as the old `CreateAppOptions`).
- [ ] **Step 2:** Move the `CreateAppOptions` interface here. Initialization logic identical to old app.ts: `loadAuth0Config`, `fetchAuth0OAuthMetadata`, `Auth0OAuthTokenVerifier`, `getOAuthProtectedResourceMetadataUrl`, Rock client(s), `createRedisClient`, `DiscoveryService`, `RockUserResolver`, dataset store, console.log cache mode.
- [ ] **Step 3:** Memoize: cache the built context promise; expose `resetAppContextForTests()` that clears the cache so tests can inject overrides.
- [ ] **Step 4:** `pnpm typecheck` — expect PASS (file compiles).
- [ ] **Step 5:** Commit: `refactor(http): extract app dependency context from Express app`

---

### Task 3: Fetch-native OAuth validation helper (TDD)

**Files:** Create `src/http/oauth-validate.ts`, `src/http/oauth-validate.test.ts`; modify `src/http/oauth.ts`

- [ ] **Step 1 (test):** Write `oauth-validate.test.ts`. Cases:
  - Missing `Authorization` → returns `{ response }` with status 401 and `WWW-Authenticate` containing `error="invalid_token"` and `resource_metadata="<url>"`.
  - Valid bearer with `read` scope (injected fake verifier returning AuthInfo with `scopes:['read','write']`, `sub:'auth0|123'`, `exp` in future) → returns `{ ctx }` where `ctx.oauth.subject === 'auth0|123'` and `ctx.scopes` has `read`+`write`.
  - Bearer token failing verifier → 401 invalid_token.
  - Valid token but missing `read` scope → 403 with `WWW-Authenticate` `error="insufficient_scope"`.
- [ ] **Step 2:** Run `pnpm vitest run src/http/oauth-validate.test.ts` → FAIL (module missing).
- [ ] **Step 3 (impl):** In `oauth-validate.ts` implement `validateOAuthContext(request: Request, opts: { verifier: OAuthTokenVerifier; requiredScopes?: string[]; resourceMetadataUrl: string }): Promise<{ ctx: OAuthRockContext } | { response: Response }>`. Mirror SDK `requireBearerAuth` logic: parse `Bearer`, `verifier.verifyAccessToken`, scope check, expiry check; on `InvalidTokenError`→401, `InsufficientScopeError`→403, build `WWW-Authenticate` exactly as SDK does. On success call `authInfoToOAuthRockContext(authInfo, request)` (Fetch-Request version) and return `{ ctx }`. Add `jsonCors(body, init)` and `MCP_CORS_HEADERS` helpers (allow `Authorization, Content-Type, mcp-protocol-version, Mcp-Session-Id`; expose `WWW-Authenticate, Mcp-Session-Id`; allow any origin).
- [ ] **Step 4:** In `oauth.ts`: remove `import type { Request, RequestHandler } from 'express'`, the `declare global namespace Express` block, `createOAuthContextAdapterMiddleware`, `createAuthMiddleware`, `defaultVerifyToken`, and the `requireBearerAuth`/`mcpAuthMetadataRouter` re-exports. Change `authInfoToOAuthRockContext(authInfo, req)` to accept a Fetch `Request`: read headers via `req.headers.get(...)`, drop `req.ip`/`req.socket` (use `x-forwarded-for` header or `undefined`). Update `headerValue` to use `Request.headers.get`.
- [ ] **Step 5:** Run `pnpm vitest run src/http/oauth-validate.test.ts src/http/oauth.test.ts` → PASS (fix oauth.test.ts expectations for removed functions).
- [ ] **Step 6:** Commit: `feat(http): add Fetch-native OAuth validation helper`

---

### Task 4: Core MCP route handler (TDD)

**Files:** Create `src/http/mcp-route.ts`, `src/http/mcp-route.test.ts`

- [ ] **Step 1 (test):** Write `mcp-route.test.ts`. Inject app-context overrides (fake verifier, fake Rock client factory, oauthConfig/metadata as in old app.test.ts). Cases:
  - Unauthenticated `POST /mcp` (Request with no Authorization) → `handleMcpPost(request,'mcp')` resolves a `Response` with status 401 and `WWW-Authenticate` referencing `resource_metadata`.
  - Authenticated `tools/list` request with valid token → status 200, JSON-RPC body with `result.tools` array (or SSE — assert `200` and content-type acceptable). Use a `Request` with body `{jsonrpc:'2.0',id:1,method:'tools/list'}` and `Accept: application/json, text/event-stream`.
- [ ] **Step 2:** Run → FAIL (module missing).
- [ ] **Step 3 (impl):** Implement `handleMcpPost(request: Request, endpointKind: 'mcp'|'readonly'|'readwrite'): Promise<Response>`:
  - `const ctx = await getAppContext(opts?)`; call `validateOAuthContext(request, { verifier, requiredScopes:['read'], resourceMetadataUrl })`; if `response` return it.
  - Build `OAuthRockContext` enrichment exactly like old `handleMcpRequest`: set `endpoint`, attach `rockClient`/`discoveryService`/`datasetStore`, `rockUserResolver.resolve`, `resolveMode`, build `McpServer`, register tools per `schemaForMode`, `registerReportViewerApp`.
  - Create `new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })`, `await server.connect(transport)`, `const res = await transport.handleRequest(request, { authInfo })` and return `res` (merge CORS headers).
  - Wrap in try/catch: `ScopeError`→403 JSON, else 500 JSON (with CORS).
  - Read the body once: `WebStandardStreamableHTTPServerTransport` reads `req.json()` itself; pass `parsedBody` only if we pre-read. Prefer letting transport parse — pass the original `request` (clone if body already consumed by validate; validate must NOT read body).
- [ ] **Step 4:** Run tests → PASS.
- [ ] **Step 5:** Commit: `feat(http): add Fetch-native MCP route handler`

---

### Task 5: Next.js route handlers

**Files:** Create `app/mcp/route.ts`, `app/mcp/readonly/route.ts`, `app/mcp/readwrite/route.ts`, `app/route.ts`, `app/.well-known/oauth-protected-resource/route.ts`, `app/.well-known/oauth-authorization-server/route.ts`

- [ ] **Step 1:** Each MCP route:
  ```ts
  import { handleMcpPost } from '../../src/http/mcp-route';
  export const runtime = 'nodejs';
  export const maxDuration = 60;
  export const dynamic = 'force-dynamic';
  export async function POST(request: Request) { return handleMcpPost(request, 'mcp'); }
  export async function OPTIONS() { return new Response(null, { status: 204, headers: MCP_CORS_HEADERS }); }
  ```
  (readonly/readwrite identical with their endpointKind; import path depth adjusted.)
- [ ] **Step 2:** `app/route.ts` GET → landing page:
  ```ts
  export const runtime = 'nodejs';
  export async function GET() {
    const { datasetStoreIsRedis, rockUrl } = ...; // from getAppContext or env
    return new Response(getLandingPageHtml({ redisConfigured, rockUrl, version:'1.0.0' }), { headers: { 'content-type':'text/html; charset=utf-8' } });
  }
  ```
  Determine `redisConfigured` from `!!createRedisClient()` or an `AppContext` flag; `rockUrl` from env.
- [ ] **Step 3:** `.well-known/oauth-protected-resource/route.ts` GET → `jsonCors({ resource: resourceServerUrl.href, authorization_servers:[oauthMetadata.issuer], scopes_supported:['read','write'], resource_name:'Rock MCP' })` + `OPTIONS`. Use `getAppContext()` for metadata.
- [ ] **Step 4:** `.well-known/oauth-authorization-server/route.ts` GET → `jsonCors(oauthMetadata)` + `OPTIONS`.
- [ ] **Step 5:** Verify import-path resolution from `app/**` into `src/**` (relative or `@/` alias via tsconfig `paths`). Add `paths: { "@/*": ["./*"] }` if cleaner.
- [ ] **Step 6:** Commit: `feat(app): add Next.js route handlers for MCP, landing, metadata`

---

### Task 6: Static assets + runtime file resolution

**Files:** `public/static/icon.png`, `public/favicon.ico`, `src/mcp/guide-text.ts`, `src/mcp/apps.ts`

- [ ] **Step 1:** `mkdir -p public/static && cp static/icon.png public/static/icon.png && cp static/icon.png public/favicon.ico`
- [ ] **Step 2:** `guide-text.ts`: try `__dirname`-relative path first, then fall back to `path.join(process.cwd(), 'static/mcp-guides', filename)` before the string fallback. Keep stdio behavior intact.
- [ ] **Step 3:** `apps.ts`: add `process.cwd()`-relative candidates (`dist/apps/src/apps/report-viewer/report-viewer.html`, `src/apps/report-viewer/report-viewer.html`) to the existing candidate list.
- [ ] **Step 4:** `pnpm typecheck` → PASS.
- [ ] **Step 5:** Commit: `feat(app): serve static assets via public/ and harden runtime file resolution`

---

### Task 7: Remove Express layer + Vercel workarounds

**Files:** Delete `api/index.ts`, `src/http/app.ts`; replace `src/http/app.test.ts`; modify `src/server.ts`, `vercel.json`

- [ ] **Step 1:** Delete `api/index.ts` and `src/http/app.ts`.
- [ ] **Step 2:** Delete `src/http/app.test.ts` (behavior now covered by `mcp-route.test.ts` + metadata covered by route handlers; port any unique assertions — admin client creation, UserJwtStrategy — into a small `app-context.test.ts`).
- [ ] **Step 3:** `src/server.ts`: keep the `--stdio` branch unchanged; replace the `else` Express branch with a message instructing `next dev`/`next start` (and `process.exit(1)` if invoked without `--stdio` in a server context), or simply guard so importing stays side-effect-free. Verify `import { createApp }` removed.
- [ ] **Step 4:** `vercel.json`: remove `rewrites`; remove the `functions["api/index.ts"]` block. Keep only what Next needs (likely delete the file entirely, since `maxDuration`/`runtime` are set per-route). Decide: delete `vercel.json`.
- [ ] **Step 5:** `pnpm vitest run` → PASS (full suite).
- [ ] **Step 6:** `pnpm build:server` (tsc stdio) → PASS; `pnpm dev:stdio` smoke (boots, lists tools) → verify.
- [ ] **Step 7:** Commit: `refactor: remove Express HTTP layer and Vercel rewrite workarounds`

---

### Task 8: Local Next build + E2E verification

- [ ] **Step 1:** `pnpm build` (next build + vite) → PASS, no type errors, no `any`-cast lint regressions.
- [ ] **Step 2:** `pnpm start` (or `next dev`) locally; with a real/issued token (or `MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL` dev path), curl:
  - `GET /` → 200 HTML landing page
  - `GET /static/icon.png` → 200 image/png
  - `GET /favicon.ico` → 200
  - `GET /.well-known/oauth-protected-resource` → 200 JSON with correct `resource`/`authorization_servers`
  - `POST /mcp` no auth → 401 with `WWW-Authenticate`
  - `POST /mcp` with valid token, `tools/list` → 200 JSON-RPC tools
  - `POST /mcp/readwrite` with read-only token → 403 scope error
- [ ] **Step 3:** Commit any fixes.

---

### Task 9: Vercel deploy + production E2E

- [ ] **Step 1:** Confirm env vars present on Vercel project (`AUTH0_*`/`OAUTH_*`, `MCP_PUBLIC_URL`, `ROCK_*`, `UPSTASH_*`) via `vercel env ls`.
- [ ] **Step 2:** Push branch; open PR. Trigger Vercel preview deploy (`vercel` or PR auto-deploy).
- [ ] **Step 3:** Run the Task 8 E2E checks against the preview URL.
- [ ] **Step 4:** Subagent code review (correctness + scope discipline) on the PR diff; address findings.
- [ ] **Step 5:** Merge to `main`; verify production deploy at `rock-mcp.favor.church` with the same E2E checks.

---

## Acceptance Criteria (from issue #5)

- [ ] `/mcp`, `/mcp/readonly`, `/mcp/readwrite` respond over HTTP on Vercel
- [ ] OAuth scope enforcement (`read` required, `write` gated) works
- [ ] Landing page + `/static/icon.png` + `/favicon.ico` served
- [ ] `--stdio` mode unaffected
- [ ] Express, `cors`, `vercel.json` rewrite removed
- [ ] `@types/express-serve-static-core` override + `any` handler casts deleted
- [ ] TypeScript compiles cleanly with no overrides
