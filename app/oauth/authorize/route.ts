import { getAppContext } from '@/src/http/app-context';
import { jsonCors, MCP_CORS_HEADERS } from '@/src/http/oauth-validate';
import { handleAuthorizeGet } from '@/src/http/oauth-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    const app = await getAppContext();
    return await handleAuthorizeGet(request, {
      oauthConfig: app.oauthConfig,
      oauthMetadata: app.oauthMetadata,
      proxyClient: app.oauthProxyClient,
      transactionStore: app.transactionStore,
    });
  } catch (err) {
    console.error('[oauth authorize] Failed:', {
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonCors({ error: 'server_error' }, { status: 500 });
  }
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: MCP_CORS_HEADERS });
}
