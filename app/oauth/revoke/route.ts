import { getAppContext } from '@/src/http/app-context';
import { jsonCors, MCP_CORS_HEADERS } from '@/src/http/oauth-validate';
import { handleRevokePost } from '@/src/http/oauth-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    const app = await getAppContext();
    return await handleRevokePost(request, {
      oauthConfig: app.oauthConfig,
      oauthMetadata: app.oauthMetadata,
      proxyClient: app.oauthProxyClient,
      transactionStore: app.transactionStore,
    });
  } catch (err) {
    console.error('[oauth revoke] Failed:', {
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonCors({ error: 'server_error' }, { status: 500 });
  }
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: MCP_CORS_HEADERS });
}
