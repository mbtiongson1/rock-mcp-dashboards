import { afterEach, describe, it, expect, vi } from 'vitest';
import { handleRegisterPost, isAllowedRedirectUri, overrideRegistrationEndpoint } from '../../src/http/register-route.js';
import { resetAppContextForTests, CreateAppContextOptions } from '../../src/http/app-context.js';
import type { Auth0OAuthConfig, Auth0OAuthMetadata } from '../../src/http/oauth.js';
import type { Auth0ManagementClient } from '../../src/http/auth0-management.js';

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

function mockManagementClient(
  currentCallbacks: string[] = [],
  shouldThrow: boolean = false
): Auth0ManagementClient {
  return {
    getClient: vi.fn(async () => {
      if (shouldThrow) {
        throw new Error('Management client error');
      }
      return {
        client_id: 'shared-client-id',
        callbacks: currentCallbacks,
      };
    }),
    mergeCallbacks: vi.fn(async (uris: string[]) => {
      if (shouldThrow) {
        throw new Error('Management client error');
      }
      const existing = new Set(currentCallbacks);
      const union = [...currentCallbacks];
      for (const uri of uris) {
        if (!existing.has(uri)) {
          union.push(uri);
        }
      }
      return union;
    }),
  } as any as Auth0ManagementClient;
}

function appOptions(
  managementClient: Auth0ManagementClient
): CreateAppContextOptions {
  return {
    oauthConfig,
    oauthMetadata,
    env: {
      ROCK_PUBLIC_URL: 'https://rock.example.com',
      AUTH0_CLIENT_ID: 'shared-client-id',
      AUTH0_MANAGEMENT_CLIENT_ID: 'test-mgmt-client',
      AUTH0_MANAGEMENT_CLIENT_SECRET: 'test-mgmt-secret',
    },
    managementClient,
  };
}

function registerRequest(body: unknown): Request {
  return new Request('https://mcp.example.com/oauth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  resetAppContextForTests();
});

describe('isAllowedRedirectUri', () => {
  it('allows https URIs', () => {
    expect(isAllowedRedirectUri('https://example.com/callback')).toBe(true);
  });

  it('allows http localhost', () => {
    expect(isAllowedRedirectUri('http://localhost:8080/callback')).toBe(true);
  });

  it('allows http 127.0.0.1', () => {
    expect(isAllowedRedirectUri('http://127.0.0.1:8080/callback')).toBe(true);
  });

  it('allows http [::1]', () => {
    expect(isAllowedRedirectUri('http://[::1]:8080/callback')).toBe(true);
  });

  it('rejects http non-loopback', () => {
    expect(isAllowedRedirectUri('http://example.com/callback')).toBe(false);
  });

  it('rejects invalid URI syntax', () => {
    expect(isAllowedRedirectUri('not a uri')).toBe(false);
  });

  it('rejects unsupported scheme', () => {
    expect(isAllowedRedirectUri('ftp://example.com/callback')).toBe(false);
  });
});

describe('overrideRegistrationEndpoint', () => {
  it('sets registration_endpoint to resource server /oauth/register', () => {
    const result = overrideRegistrationEndpoint(oauthMetadata, new URL('https://mcp.example.com/'));
    expect(result.registration_endpoint).toBe('https://mcp.example.com/oauth/register');
  });

  it('avoids double slash when resourceServerUrl has trailing slash', () => {
    const result = overrideRegistrationEndpoint(oauthMetadata, new URL('https://mcp.example.com/'));
    expect(result.registration_endpoint).not.toContain('//oauth');
  });

  it('preserves other metadata fields', () => {
    const result = overrideRegistrationEndpoint(oauthMetadata, new URL('https://mcp.example.com/'));
    expect(result.issuer).toBe(oauthMetadata.issuer);
    expect(result.authorization_endpoint).toBe(oauthMetadata.authorization_endpoint);
    expect(result.jwks_uri).toBe(oauthMetadata.jwks_uri);
  });
});

describe('handleRegisterPost', () => {
  it('returns 201 with registration response for valid request', async () => {
    const mgmtClient = mockManagementClient(['https://existing.com/cb']);
    const request = registerRequest({
      redirect_uris: ['https://new.example.com/callback'],
    });

    const response = await handleRegisterPost(request, appOptions(mgmtClient));

    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.client_id).toBe('shared-client-id');
    expect(body.client_name).toBe('Rock MCP');
    expect(Array.isArray(body.redirect_uris)).toBe(true);
    expect(body.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(body.response_types).toEqual(['code']);
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.client_secret).toBeUndefined();
  });

  it('merges redirect_uris into existing callbacks', async () => {
    const mgmtClient = mockManagementClient(['https://existing.com/cb']);
    const request = registerRequest({
      redirect_uris: ['https://new.example.com/callback'],
    });

    await handleRegisterPost(request, appOptions(mgmtClient));

    expect(mgmtClient.mergeCallbacks).toHaveBeenCalledWith(['https://new.example.com/callback']);
  });

  it('returns merged redirect_uris in response', async () => {
    const mgmtClient = mockManagementClient(['https://existing.com/cb']);
    vi.spyOn(mgmtClient, 'mergeCallbacks').mockResolvedValueOnce([
      'https://existing.com/cb',
      'https://new.example.com/callback',
    ]);
    const request = registerRequest({
      redirect_uris: ['https://new.example.com/callback'],
    });

    const response = await handleRegisterPost(request, appOptions(mgmtClient));
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.redirect_uris).toEqual(['https://existing.com/cb', 'https://new.example.com/callback']);
  });

  it('is idempotent: duplicate redirect_uri returns 201', async () => {
    const mgmtClient = mockManagementClient(['https://example.com/callback']);
    vi.spyOn(mgmtClient, 'mergeCallbacks').mockResolvedValueOnce(['https://example.com/callback']);
    const request = registerRequest({
      redirect_uris: ['https://example.com/callback'],
    });

    const response = await handleRegisterPost(request, appOptions(mgmtClient));

    expect(response.status).toBe(201);
    expect(mgmtClient.mergeCallbacks).toHaveBeenCalledWith(['https://example.com/callback']);
  });

  it('allows http localhost redirect_uri', async () => {
    const mgmtClient = mockManagementClient([]);
    const request = registerRequest({
      redirect_uris: ['http://localhost:8080/callback'],
    });

    const response = await handleRegisterPost(request, appOptions(mgmtClient));

    expect(response.status).toBe(201);
    expect(mgmtClient.mergeCallbacks).toHaveBeenCalledWith(['http://localhost:8080/callback']);
  });

  it('rejects non-https non-loopback redirect_uri with 400', async () => {
    const mgmtClient = mockManagementClient([]);
    const request = registerRequest({
      redirect_uris: ['http://evil.com/callback'],
    });

    const response = await handleRegisterPost(request, appOptions(mgmtClient));

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_redirect_uri');
    expect(mgmtClient.mergeCallbacks).not.toHaveBeenCalled();
  });

  it('rejects request with missing redirect_uris field with 400', async () => {
    const mgmtClient = mockManagementClient([]);
    const request = registerRequest({
      client_name: 'My App',
    });

    const response = await handleRegisterPost(request, appOptions(mgmtClient));

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_redirect_uri');
  });

  it('rejects request with empty redirect_uris array with 400', async () => {
    const mgmtClient = mockManagementClient([]);
    const request = registerRequest({
      redirect_uris: [],
    });

    const response = await handleRegisterPost(request, appOptions(mgmtClient));

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_redirect_uri');
  });

  it('rejects request with non-string redirect_uri with 400', async () => {
    const mgmtClient = mockManagementClient([]);
    const request = registerRequest({
      redirect_uris: [123],
    });

    const response = await handleRegisterPost(request, appOptions(mgmtClient));

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_redirect_uri');
  });

  it('rejects over-capacity (>50 callbacks) with 400', async () => {
    const existingCallbacks = Array.from({ length: 50 }, (_, i) => `https://example${i}.com/cb`);
    const mgmtClient = mockManagementClient(existingCallbacks);
    const request = registerRequest({
      redirect_uris: ['https://newone.com/callback'],
    });

    const response = await handleRegisterPost(request, appOptions(mgmtClient));

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_redirect_uri');
    expect(body.error_description).toContain('limit');
  });

  it('allows exactly 50 callbacks after merge', async () => {
    const existingCallbacks = Array.from({ length: 49 }, (_, i) => `https://example${i}.com/cb`);
    const mgmtClient = mockManagementClient(existingCallbacks);
    const request = registerRequest({
      redirect_uris: ['https://newone.com/callback'],
    });

    const response = await handleRegisterPost(request, appOptions(mgmtClient));

    expect(response.status).toBe(201);
  });

  it('rejects invalid JSON with 400', async () => {
    const mgmtClient = mockManagementClient([]);
    const request = new Request('https://mcp.example.com/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json',
    });

    const response = await handleRegisterPost(request, appOptions(mgmtClient));

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_redirect_uri');
  });

  it('ignores extra request fields (client_name, grant_types, etc)', async () => {
    const mgmtClient = mockManagementClient([]);
    const request = registerRequest({
      redirect_uris: ['https://example.com/callback'],
      client_name: 'ignored',
      grant_types: ['authorization_code'],
      token_endpoint_auth_method: 'client_secret_basic',
      jwks_uri: 'https://example.com/.well-known/jwks.json',
      client_secret: 'should-be-ignored',
    });

    const response = await handleRegisterPost(request, appOptions(mgmtClient));

    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    // Response has our fixed fields, not the request's
    expect(body.client_name).toBe('Rock MCP');
    expect(body.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(body.token_endpoint_auth_method).toBe('none');
  });

  it('returns 500 with generic error if management client throws', async () => {
    const mgmtClient = mockManagementClient([], true);
    const request = registerRequest({
      redirect_uris: ['https://example.com/callback'],
    });

    const response = await handleRegisterPost(request, appOptions(mgmtClient));

    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('server_error');
    // Ensure no secret/token in response
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain('Management client error');
  });

  it('includes CORS headers in all responses', async () => {
    const mgmtClient = mockManagementClient([]);
    const request = registerRequest({
      redirect_uris: ['https://example.com/callback'],
    });

    const response = await handleRegisterPost(request, appOptions(mgmtClient));

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Content-Type')).toBe('application/json');
  });

  it('handles multiple valid redirect_uris', async () => {
    const mgmtClient = mockManagementClient([]);
    vi.spyOn(mgmtClient, 'mergeCallbacks').mockResolvedValueOnce([
      'https://app1.com/cb',
      'https://app2.com/cb',
    ]);
    const request = registerRequest({
      redirect_uris: ['https://app1.com/cb', 'https://app2.com/cb'],
    });

    const response = await handleRegisterPost(request, appOptions(mgmtClient));

    expect(response.status).toBe(201);
    expect(mgmtClient.mergeCallbacks).toHaveBeenCalledWith(['https://app1.com/cb', 'https://app2.com/cb']);
  });

  it('rejects if any redirect_uri is invalid', async () => {
    const mgmtClient = mockManagementClient([]);
    const request = registerRequest({
      redirect_uris: ['https://valid.com/cb', 'http://invalid.com/cb'],
    });

    const response = await handleRegisterPost(request, appOptions(mgmtClient));

    expect(response.status).toBe(400);
    expect(mgmtClient.mergeCallbacks).not.toHaveBeenCalled();
  });
});
