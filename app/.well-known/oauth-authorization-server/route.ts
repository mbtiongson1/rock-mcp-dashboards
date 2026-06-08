import { getAppContext } from '@/src/http/app-context';
import { jsonCors, MCP_CORS_HEADERS } from '@/src/http/oauth-validate';
import { overrideRegistrationEndpoint } from '@/src/http/register-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const app = await getAppContext();
    const metadata = overrideRegistrationEndpoint(app.oauthMetadata, app.oauthConfig.resourceServerUrl);
    return jsonCors(metadata);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'OAuth metadata unavailable';
    return jsonCors({ error: message }, { status: 503 });
  }
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: MCP_CORS_HEADERS });
}
