import { getAppContext } from '@/src/http/app-context';
import { jsonCors, MCP_CORS_HEADERS } from '@/src/http/oauth-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const app = await getAppContext();
    return jsonCors(app.oauthMetadata);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'OAuth metadata unavailable';
    return jsonCors({ error: message }, { status: 503 });
  }
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: MCP_CORS_HEADERS });
}
