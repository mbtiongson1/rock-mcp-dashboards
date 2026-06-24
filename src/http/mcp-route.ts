import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { resolveMode, ScopeError, PersonResolutionError, EndpointKind } from '../mcp/modes.js';
import { registerGatewayTools } from '../mcp/register-tools.js';
import { registerReportViewerApp } from '../mcp/apps.js';
import { getRockGuideText } from '../mcp/guide-text.js';
import { getAppContext, CreateAppContextOptions } from './app-context.js';
import { validateOAuthContext, jsonCors, withCors } from './oauth-validate.js';
import { resolveServerOverride } from './server-override.js';
import type { OAuthRockContext } from './oauth.js';
import { AuditLogger } from '../auth/audit.js';
import { createRedisClient, getRedisPrefix } from '../rock/redis.js';
import {
  RateLimiter,
  MCP_RATE_LIMIT_SEGMENT,
  mcpRateLimitRequests,
  mcpRateLimitWindowSeconds,
} from './rate-limiter.js';
import * as crypto from 'crypto';

const auditLogger = new AuditLogger();

/**
 * Framework-agnostic MCP POST handler. Validates the OAuth bearer token, builds
 * a per-request McpServer with the tools allowed for the resolved mode, and
 * delegates to the Web-Standard Streamable HTTP transport (Fetch Request →
 * Response). Used by the Next.js App Router route handlers.
 *
 * @param options test-only dependency overrides (passed through to getAppContext)
 */
export async function handleMcpPost(
  request: Request,
  endpointKind: EndpointKind,
  options?: CreateAppContextOptions
): Promise<Response> {
  const app = await getAppContext(options);

  const validation = await validateOAuthContext(request, {
    verifier: app.verifier,
    requiredScopes: ['read'],
    resourceMetadataUrl: app.resourceMetadataUrl,
  });
  if (validation.response) {
    return validation.response;
  }
  const ctx: OAuthRockContext = validation.ctx;

  ctx.endpoint = endpointKind;

  // Per-user request rate limit. Keyed on a hash of the OAuth subject so the
  // bucket is stable across token rotations. Fails open when Redis is not
  // configured (local / stdio) or on any Redis error.
  const maxRequests = mcpRateLimitRequests();
  const windowSeconds = mcpRateLimitWindowSeconds();
  const subjectHash = crypto.createHash('sha256').update(ctx.oauth.subject).digest('hex');
  const rateLimiter = new RateLimiter(
    createRedisClient(),
    getRedisPrefix(),
    MCP_RATE_LIMIT_SEGMENT,
    maxRequests,
    windowSeconds
  );
  const withinLimit = await rateLimiter.checkLimit(subjectHash);
  if (!withinLimit) {
    console.warn('[mcp POST] Rate limit exceeded:', { subjectHash });
    return jsonCors(
      {
        error: 'rate_limited',
        error_description: `Rate limit exceeded: maximum ${maxRequests} requests per ${windowSeconds} seconds`,
      },
      { status: 429 }
    );
  }

  let activeRockClient = app.rockClient;
  let activeUserResolver = app.rockUserResolver;
  let activeDiscoveryService = app.discoveryService;

  // Optional per-request Rock server override: /mcp?url=<host> or /mcp?server=<host>.
  // Allowlisted hosts only (see server-override.ts).
  const { searchParams } = new URL(request.url);
  const serverParam = searchParams.get('url') || searchParams.get('server');
  if (serverParam) {
    const override = resolveServerOverride(serverParam, app.rockBaseUrl, process.env.ROCK_ALLOWED_SERVERS);
    if (!override.ok) {
      return jsonCors({ error: override.error }, { status: 400 });
    }
    activeRockClient = app.rockClientForBase(override.baseUrl);
    activeUserResolver = app.rockUserResolverForBase(override.baseUrl);
    activeDiscoveryService = app.discoveryServiceForBase(override.baseUrl);
  }

  (ctx as { rockClient?: unknown }).rockClient = activeRockClient;
  (ctx as { discoveryService?: unknown }).discoveryService = activeDiscoveryService;
  (ctx as { datasetStore?: unknown }).datasetStore = app.datasetStore;

  try {
    // Resolve Rock person for this OAuth subject
    const resolvedUser = await activeUserResolver.resolve(ctx, {
      subject: ctx.oauth.subject,
      email: ctx.oauth.email,
    });
    ctx.rockUser = resolvedUser;

    // Defense-in-depth: MCP access requires the OAuth identity to map to a
    // real Rock person, regardless of token scopes.
    if (!resolvedUser.personId) {
      const email = ctx.oauth.email || ctx.oauth.subject;
      throw new PersonResolutionError(
        `Your account (${email}) is not linked to a Rock person record. Ask a Rock admin to add this email to your person record.`,
        email
      );
    }

    // Resolve mode (throws ScopeError on insufficient scope)
    const mode = resolveMode(endpointKind, ctx);
    ctx.mode = mode;

    const server = new McpServer(
      {
        name: 'rock-mcp',
        version: '1.0.0',
      },
      {
        instructions: getRockGuideText(mode),
      }
    );

    // Register tools dynamically based on resolved mode & scopes
    registerGatewayTools(server, mode, ctx);

    // Register App resources
    registerReportViewerApp(server);

    // Stateless HTTP POST mode — Fetch-native transport
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    const response = await transport.handleRequest(request);
    return withCors(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    if (err instanceof PersonResolutionError) {
      auditLogger.log(ctx, {
        tool: 'mcp',
        action: 'resolveUser',
        outcome: 'denied',
        errorCode: 'PERSON_NOT_RESOLVED',
        reason: `Person not resolved for email: ${err.email || 'unknown'}`,
      });
      return jsonCors({ error: message }, { status: 403 });
    }
    if (err instanceof ScopeError) {
      return jsonCors({ error: message }, { status: 403 });
    }
    return jsonCors({ error: message }, { status: 500 });
  }
}
