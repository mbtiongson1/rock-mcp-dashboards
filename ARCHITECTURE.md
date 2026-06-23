# Rock MCP Architecture

This document expands the README with the flows a new developer needs before changing tools, OAuth behavior, or deployment configuration.

## Runtime Shape

Rock MCP has one shared tool layer and two entrypoints.

The HTTP entrypoint is the production path. Next.js route handlers in `app/mcp/**/route.ts` call `handleMcpPost` in `src/http/mcp-route.ts`. That handler loads the cached `AppContext`, validates the bearer token, resolves the Auth0 subject to a Rock person, chooses read-only or read-write mode, registers the allowed tools on a fresh `McpServer`, registers the report-viewer MCP App resource, and hands the request to the web-standard streamable HTTP transport.

The stdio entrypoint in `src/server.ts` is for local development and inspection. It uses `ROCK_PUBLIC_URL` or `ROCK_API_URL` plus `ROCK_API_KEY`, attaches an in-memory discovery service and dataset store, and registers the tools in read-write mode under a local admin-like context.

## OAuth Proxy Flow

MCP clients talk to this service as the authorization server:

1. The client discovers localized metadata from `/.well-known/oauth-authorization-server`.
2. The client registers redirect URIs with `/oauth/register`; registrations live in `OAuthTransactionStore`.
3. `/oauth/authorize` validates the stored redirect URI and PKCE challenge, creates a short-lived transaction, and redirects to Auth0 using the fixed confidential client.
4. `/oauth/callback` exchanges the Auth0 code immediately, stores the Auth0 token response behind a one-time proxy code, and redirects back to the MCP client.
5. `/oauth/token` validates PKCE and returns the stored Auth0 token response to the MCP client.
6. Later MCP calls present the Auth0 access token as a bearer token; `Auth0OAuthTokenVerifier` validates issuer, audience, expiration, and scopes.

Redis is required for reliable deployed OAuth flows because registration, authorize, callback, and token requests may land on different serverless instances. Without Redis, the in-memory store is suitable only for single-process local development.

## Mode Resolution

Mode is resolved after the OAuth subject is linked to a Rock person:

| Endpoint | Result |
| --- | --- |
| `/mcp/readonly` | Requires `read`; always read-only. |
| `/mcp/readwrite` | Requires `read` and `write`; read-write. |
| `/mcp` | Requires `read`; read-write only when `write` is present and the Rock person is an RSR admin. |

Person resolution failures stop the request before tools are registered. This protects the auto endpoint from treating an unresolved identity as privileged.

## Tool Registration

Every MCP tool implements `GatewayTool` from `src/tools/types.ts`. `schemaForMode` decides whether a tool is visible for the resolved mode and scopes. `registerGatewayTools` is the only registration path because it:

- flattens discriminated-union schemas into MCP-advertisable input schemas,
- adds action names to descriptions,
- attaches the report-viewer app resource metadata when a tool declares one,
- converts Zod validation failures into structured tool responses,
- logs validation failures through the audit logger.

## Rock Access

HTTP requests use `UserJwtStrategy`, so the caller's bearer token is forwarded to Rock and Rock enforces native user permissions. Local stdio mode uses `ApiKeyStrategy` for developer testing.

The optional `?server=` query parameter lets a request target another Rock host, but `resolveServerOverride` restricts it to HTTPS hosts that match the default parent domain or `ROCK_ALLOWED_SERVERS`. Discovery and person resolution still use the default Rock server; only tool calls use the override client.

## Data And Caching

`DiscoveryService` builds per-user discovery maps for campuses, group types, attributes, reports, entity searches, workflows, and connection types. Discovery maps are cached in memory and Redis with `ROCK_MCP_DISCOVERY_TTL_SECONDS`.

Report and ministry tools can store larger datasets in `DatasetStore` implementations. Stored datasets include an OAuth subject hash and expiration, and reads enforce ownership before returning rows. Redis-backed datasets use `ROCK_MCP_DATASET_TTL_SECONDS` unless the dataset has an explicit `expiresAt`.

## Write Safety

Write-capable tools must pass through `authorizeWrite` before mutation. The policy requires read-write mode, `write` scope, an allowlisted Rock model, an allowed operation, allowed fields for create/patch operations, admin status for deletes, and the configured bulk limit.

Writes are preview-only unless callers pass both `dryRun: false` and `commit: true`. Every write path requires a human-readable `reason` and logs an audit event.
