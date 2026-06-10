import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { resolveMode, ScopeError, EndpointKind } from '../mcp/modes.js';
import { registerGatewayTools } from '../mcp/register-tools.js';
import { registerReportViewerApp } from '../mcp/apps.js';
import { getRockGuideText } from '../mcp/guide-text.js';
import { getAppContext, CreateAppContextOptions } from './app-context.js';
import { validateOAuthContext, jsonCors, withCors } from './oauth-validate.js';
import type { OAuthRockContext } from './oauth.js';

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
  (ctx as { rockClient?: unknown }).rockClient = app.rockClient;
  (ctx as { discoveryService?: unknown }).discoveryService = app.discoveryService;
  (ctx as { datasetStore?: unknown }).datasetStore = app.datasetStore;

  try {
    // Resolve Rock person for this OAuth subject
    const resolvedUser = await app.rockUserResolver.resolve(ctx, {
      subject: ctx.oauth.subject,
      email: ctx.oauth.email,
    });
    ctx.rockUser = resolvedUser;

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
    if (err instanceof ScopeError) {
      return jsonCors({ error: message }, { status: 403 });
    }
    return jsonCors({ error: message }, { status: 500 });
  }
}
