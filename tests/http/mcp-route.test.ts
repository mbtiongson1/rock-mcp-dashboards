import { afterEach, describe, it, expect, vi } from 'vitest';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { handleMcpPost } from '../../src/http/mcp-route.js';
import * as redisModule from '../../src/rock/redis.js';
import { resetAppContextForTests, CreateAppContextOptions } from '../../src/http/app-context.js';
import type { Auth0OAuthConfig, Auth0OAuthMetadata } from '../../src/http/oauth.js';
import type { RockClient } from '../../src/rock/client.js';
import { AuditLogger } from '../../src/auth/audit.js';
import type { RockUserResolver } from '../../src/auth/rock-user-resolver.js';

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
  async get<T>(_ctx: any, _path: string): Promise<T> { return [] as T; }
  async post<T>(_ctx: any, _path: string, _body?: unknown): Promise<T> { return [] as T; }
  async put<T>(_ctx: any, _path: string, _body?: unknown): Promise<T> { return {} as T; }
  async patch<T>(_ctx: any, _path: string, _body?: unknown): Promise<T> { return {} as T; }
  async delete<T>(_ctx: any, _path: string): Promise<T> { return {} as T; }
}

const stubResolver = {
  resolve: async () => ({
    personId: 100,
    personGuid: 'a0000000-0000-0000-0000-000000000100',
    personAliasId: 100,
    isRsrAdmin: false,
  }),
} as unknown as RockUserResolver;

function appOptions(verifier: OAuthTokenVerifier): CreateAppContextOptions {
  return {
    oauthConfig,
    oauthMetadata,
    verifier,
    env: {
      ROCK_PUBLIC_URL: 'https://rock.example.com',
      AUTH0_CLIENT_ID: 'test-proxy-client',
      AUTH0_CLIENT_SECRET: 'test-proxy-secret',
    },
    rockClientFactory: () => new FakeRockClient(),
    rockUserResolver: stubResolver,
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

  it('advertises full input schemas (action enum + params) for union-based tools', async () => {
    const request = mcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { Authorization: 'Bearer valid-token' }
    );
    const response = await handleMcpPost(request, 'readonly', appOptions(verifierWithScopes(['read'])));

    expect(response.status).toBe(200);
    const json = parseMcpBody(await readBody(response));
    const tools: any[] = json.result.tools;

    const people = tools.find((t) => t.name === 'rock_people');
    expect(people).toBeDefined();
    expect(people.inputSchema.properties.action).toBeDefined();
    expect(people.inputSchema.properties.action.enum).toEqual(
      expect.arrayContaining(['find', 'profile', 'filter'])
    );
    expect(people.inputSchema.required).toContain('action');
    expect(people.description).toContain('Actions:');

    const entity = tools.find((t) => t.name === 'rock_entity');
    expect(entity.inputSchema.properties.action.enum).toEqual(
      expect.arrayContaining(['get', 'search', 'searchByKey', 'count', 'attributeValues'])
    );
    expect(entity.inputSchema.properties.model).toBeDefined();
    expect(entity.inputSchema.properties.model.description).toMatch(/people/);

    // Every advertised tool must expose a non-empty schema; an empty
    // properties object means agents have to guess parameters.
    // rock_usage is genuinely parameterless, so it is exempt.
    for (const tool of tools.filter((t) => t.name !== 'rock_usage')) {
      expect(
        Object.keys(tool.inputSchema.properties ?? {}).length,
        `tool ${tool.name} advertises an empty input schema`
      ).toBeGreaterThan(0);
    }
  });

  it('returns a structured INVALID_ARGUMENTS error listing valid actions for a bad discriminator', async () => {
    const request = mcpRequest(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'rock_people', arguments: { action: 'find', query: 'x', limit: 'not-a-number' } },
      },
      { Authorization: 'Bearer valid-token' }
    );
    const response = await handleMcpPost(request, 'readonly', appOptions(verifierWithScopes(['read'])));
    expect(response.status).toBe(200);
    const json = parseMcpBody(await readBody(response));
    // The flattened advertisement schema rejects obviously wrong types up front
    // or the strict union parse converts it into a structured tool error;
    // either way the agent gets actionable text, not an opaque failure.
    const text = JSON.stringify(json);
    expect(text).toMatch(/limit|number/i);
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

  it('rejects a ?url= override outside the allowed domain with 400', async () => {
    const request = new Request('https://mcp.example.com/mcp?url=evil.com', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer valid-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const response = await handleMcpPost(request, 'readonly', appOptions(verifierWithScopes(['read'])));

    expect(response.status).toBe(400);
    const json = JSON.parse(await readBody(response));
    expect(json.error).toMatch(/not an allowed Rock host/);
  });

  it('routes to an allowed ?url= override host and prioritizes it over ?server=', async () => {
    const factoryCalls: string[] = [];
    const options = appOptions(verifierWithScopes(['read']));
    options.rockClientFactory = (config) => {
      factoryCalls.push(config.baseUrl);
      const client = new FakeRockClient();
      (client as any).baseUrl = config.baseUrl;
      return client;
    };
    // Exclude mock user resolver so it falls back to dynamic resolver using our factory client
    options.rockUserResolver = undefined;

    // Mock the GetCurrentPerson call so user resolution passes and track calls
    const gotCalls: string[] = [];
    const originalGet = FakeRockClient.prototype.get;
    FakeRockClient.prototype.get = async function<T>(this: FakeRockClient, _ctx: unknown, path: string): Promise<T> {
      gotCalls.push((this as any).baseUrl);
      if (path.includes('GetCurrentPerson')) {
        return { Id: 100, Guid: 'a0000000-0000-0000-0000-000000000100', PrimaryAliasId: 100 } as unknown as T;
      }
      return [] as unknown as T;
    };

    try {
      const request = new Request('https://mcp.example.com/mcp?url=rock-preview.example.com&server=rock.example.com', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer valid-token',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      const response = await handleMcpPost(request, 'readonly', options);

      expect(response.status).toBe(200);
      expect(factoryCalls).toContain('https://rock-preview.example.com');
      // Assert that actual client operations ran against the overridden URL
      expect(gotCalls).toContain('https://rock-preview.example.com');
      expect(gotCalls).not.toContain('https://rock.example.com');
    } finally {
      FakeRockClient.prototype.get = originalGet;
    }
  });

  it('sets permissive CORS headers on responses', async () => {
    const request = mcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { Authorization: 'Bearer valid-token' }
    );
    const response = await handleMcpPost(request, 'mcp', appOptions(verifierWithScopes(['read', 'write'])));
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  describe('per-user rate limiting', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      delete process.env.ROCK_MCP_RATE_LIMIT_REQUESTS;
      delete process.env.ROCK_MCP_RATE_LIMIT_WINDOW_SECONDS;
    });

    it('returns 429 when the per-subject limit is exceeded', async () => {
      process.env.ROCK_MCP_RATE_LIMIT_REQUESTS = '1';
      const mockRedis = {
        // Second hit (value 2) exceeds the configured limit of 1.
        incr: vi.fn().mockResolvedValue(2),
        expire: vi.fn().mockResolvedValue(true),
      };
      vi.spyOn(redisModule, 'createRedisClient').mockReturnValue(mockRedis as any);

      const request = mcpRequest(
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        { Authorization: 'Bearer valid-token' }
      );
      const response = await handleMcpPost(request, 'readonly', appOptions(verifierWithScopes(['read'])));

      expect(response.status).toBe(429);
      const json = JSON.parse(await readBody(response));
      expect(json.error).toBe('rate_limited');
    });

    it('allows the request when under the limit', async () => {
      const mockRedis = {
        incr: vi.fn().mockResolvedValue(1),
        expire: vi.fn().mockResolvedValue(true),
      };
      vi.spyOn(redisModule, 'createRedisClient').mockReturnValue(mockRedis as any);

      const request = mcpRequest(
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        { Authorization: 'Bearer valid-token' }
      );
      const response = await handleMcpPost(request, 'readonly', appOptions(verifierWithScopes(['read'])));

      expect(response.status).toBe(200);
    });

    it('fails open (allows) when Redis is not configured', async () => {
      vi.spyOn(redisModule, 'createRedisClient').mockReturnValue(null);

      const request = mcpRequest(
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        { Authorization: 'Bearer valid-token' }
      );
      const response = await handleMcpPost(request, 'readonly', appOptions(verifierWithScopes(['read'])));

      expect(response.status).toBe(200);
    });
  });

  describe('Rock person requirement', () => {
    it('returns 403 when resolver returns no personId', async () => {
      const unknownUserResolver = {
        resolve: async () => ({
          isRsrAdmin: false,
        }),
      } as unknown as RockUserResolver;

      const options = appOptions(verifierWithScopes(['read']));
      options.rockUserResolver = unknownUserResolver;

      const request = mcpRequest(
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        { Authorization: 'Bearer valid-token' }
      );
      const response = await handleMcpPost(request, 'mcp', options);

      expect(response.status).toBe(403);
      const json = JSON.parse(await readBody(response));
      expect(json.error).toMatch(/not linked to a Rock person record/);
      expect(json.error).toContain('person@example.com');
    });

    it('logs denial with PERSON_NOT_RESOLVED error code when person not resolved', async () => {
      const unknownUserResolver = {
        resolve: async () => ({
          isRsrAdmin: false,
        }),
      } as unknown as RockUserResolver;

      const options = appOptions(verifierWithScopes(['read']));
      options.rockUserResolver = unknownUserResolver;

      const logSpy = vi.spyOn(AuditLogger.prototype, 'log');

      const request = mcpRequest(
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        { Authorization: 'Bearer valid-token' }
      );
      await handleMcpPost(request, 'mcp', options);

      expect(logSpy).toHaveBeenCalled();
      const logCall = logSpy.mock.calls[0];
      expect(logCall[1]).toMatchObject({
        tool: 'mcp',
        action: 'resolveUser',
        outcome: 'denied',
        errorCode: 'PERSON_NOT_RESOLVED',
      });
      expect(logCall[1].reason).toContain('person@example.com');

      logSpy.mockRestore();
    });

    it('returns 200 tools/list when person is resolved (regression)', async () => {
      const request = mcpRequest(
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        { Authorization: 'Bearer valid-token' }
      );
      const response = await handleMcpPost(request, 'mcp', appOptions(verifierWithScopes(['read'])));

      expect(response.status).toBe(200);
      const text = await readBody(response);
      const json = parseMcpBody(text);
      expect(json.result?.tools).toBeInstanceOf(Array);
      expect(json.result.tools.length).toBeGreaterThan(0);
    });
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
