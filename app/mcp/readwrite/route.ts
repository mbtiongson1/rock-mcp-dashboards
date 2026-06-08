import { handleMcpPost } from '@/src/http/mcp-route';
import { MCP_CORS_HEADERS } from '@/src/http/oauth-validate';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleMcpPost(request, 'readwrite');
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: MCP_CORS_HEADERS });
}
