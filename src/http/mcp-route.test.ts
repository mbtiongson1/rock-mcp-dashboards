import { afterEach, describe, it, expect } from 'vitest';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { handleMcpPost } from './mcp-route.js';
import { resetAppContextForTests, CreateAppContextOptions } from './app-context.js';
import type { Auth0OAuthConfig, Auth0OAuthMetadata } from './oauth.js';
import type { RockClient } from '../rock/client.js';

const oauthConfig: Auth0OAuthConfig = {
  issuer: 'https://auth.example.com/',
  audience: 'https://rock.example.com/api',
  resourceServerUrl: new URL('https://mcp.example.com/'),
  discoveryUrl: new URL('https://auth.example.com/.well-known/openid-configuration'),
};

const oauthMetadata: Auth0OAuthMetadata = {
  issuer: 'https://auth.example.com/',
  authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/oauth/token',
  registration_endpoint: 'https://auth.example.com/oauth/register',
  jwks_uri: 'https://auth.example.com/.well-known/jwks.json',
  response_types_supported: ['code'],
  token_endpoint_auth_methods_supported: ['none'],
};

function verifierWithScopes(scopes: string[]): OAuthTokenVerifier {
  return {
    verifyAccessToken: async (token) => ({
      token,
      clientId: 'test-client',
      scopes,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      extra: {
        sub: 'auth0|123',
        email: 'person@example.com',
        iss: oauthConfig.issuer,
      },
    }),
  };
}

class FakeRockClient implements RockClient {
  async get<T>(): Promise<T> { return [] as T; }
  async post<T>(): Promise<T> { return [] as T; }
  async put<T>(): Promise<T> { return {} as T; }
  async patch<T>(): Promise<T> { return {} as T; }
  async delete<T>(): Promise<T> { return {} as T; }
}

function appOptions(verifier: OAuthTokenVerifier): CreateAppContextOptions {
  return {
    oauthConfig,
    oauthMetadata,
    verifier,
    env: {
      ROCK_PUBLIC_URL: 'https://rock.example.com',
      AUTH0_CLIENT_ID: 'test-shared-client',
      AUTH0_MANAGEMENT_CLIENT_ID: 'test-mgmt-client',
      AUTH0_MANAGEMENT_CLIENT_SECRET: 'test-mgmt-secret',
    },
    rockClientFactory: () => new FakeRockClient(),
  };
}

function mcpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://mcp.example.com/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  resetAppContextForTests();
});

describe('handleMcpPost', () => {
  it('challenges unauthenticated requests with a 401 + resource metadata', async () => {
    const request = mcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const response = await handleMcpPost(request, 'mcp', appOptions(verifierWithScopes(['read', 'write'])));

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain(
      'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"'
    );
  });

  it('lists tools for an authenticated readonly request', async () => {
    const request = mcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { Authorization: 'Bearer valid-token' }
    );
    const response = await handleMcpPost(request, 'readonly', appOptions(verifierWithScopes(['read'])));

    expect(response.status).toBe(200);
    const text = await readBody(response);
    const json = parseMcpBody(text);
    expect(json.result?.tools).toBeInstanceOf(Array);
    expect(json.result.tools.length).toBeGreaterThan(0);
  });

  it('returns 403 when the readwrite endpoint is hit without the write scope', async () => {
    const request = mcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { Authorization: 'Bearer read-only-token' }
    );
    const response = await handleMcpPost(request, 'readwrite', appOptions(verifierWithScopes(['read'])));

    expect(response.status).toBe(403);
    const json = JSON.parse(await readBody(response));
    expect(json.error).toMatch(/write/i);
  });

  it('sets permissive CORS headers on responses', async () => {
    const request = mcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { Authorization: 'Bearer valid-token' }
    );
    const response = await handleMcpPost(request, 'mcp', appOptions(verifierWithScopes(['read', 'write'])));
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

async function readBody(response: Response): Promise<string> {
  return await response.text();
}

// The transport may answer with a single SSE event or a plain JSON body
// depending on the negotiated Accept header. Parse either shape.
function parseMcpBody(text: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed);
  }
  const dataLine = trimmed.split('\n').find((line) => line.startsWith('data:'));
  if (!dataLine) {
    throw new Error(`Unexpected MCP response body: ${text}`);
  }
  return JSON.parse(dataLine.slice('data:'.length).trim());
}
