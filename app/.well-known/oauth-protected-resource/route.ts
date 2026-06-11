import { getAppContext } from '@/src/http/app-context';
import { jsonCors, MCP_CORS_HEADERS } from '@/src/http/oauth-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const app = await getAppContext();
    return jsonCors({
      resource: app.oauthConfig.audience,
      // Advertise THIS server as the authorization server (not the raw Auth0
      // issuer) so spec-compliant clients discover our /.well-known/
      // oauth-authorization-server, which routes DCR to the single-client
      // /oauth/register proxy. Pointing at Auth0 directly sends clients to
      // Auth0's /oidc/register, which is capped (403 too_many_entities).
      authorization_servers: [app.oauthConfig.resourceServerUrl.origin],
      scopes_supported: ['read', 'write'],
      resource_name: 'Rock MCP',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'OAuth metadata unavailable';
    return jsonCors({ error: message }, { status: 503 });
  }
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: MCP_CORS_HEADERS });
}
