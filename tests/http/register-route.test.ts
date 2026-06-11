import { afterEach, describe, it, expect } from 'vitest';
import { handleRegisterPost, isAllowedRedirectUri, localizeOAuthMetadata } from '../../src/http/register-route.js';
import { resetAppContextForTests, CreateAppContextOptions } from '../../src/http/app-context.js';
import { OAuthTransactionStore } from '../../src/http/oauth-transactions.js';
import type { Auth0OAuthConfig, Auth0OAuthMetadata } from '../../src/http/oauth.js';

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
  jwks_uri: 'https://auth.example.com/.well-known/jwks.json',
  response_types_supported: ['code'],
  token_endpoint_auth_methods_supported: ['none'],
};

function appOptions(store?: OAuthTransactionStore): CreateAppContextOptions {
  return {
    oauthConfig,
    oauthMetadata,
    env: {
      ROCK_PUBLIC_URL: 'https://rock.example.com',
    },
    oauthProxyClient: { clientId: 'auth0-client-id', clientSecret: 'auth0-client-secret' },
    transactionStore: store ?? new OAuthTransactionStore(null, 'test:'),
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

describe('localizeOAuthMetadata', () => {
  it('points all OAuth endpoints at the resource server', () => {
    const result = localizeOAuthMetadata(oauthMetadata, new URL('https://mcp.example.com/'));
    expect(result.registration_endpoint).toBe('https://mcp.example.com/oauth/register');
    expect(result.authorization_endpoint).toBe('https://mcp.example.com/oauth/authorize');
    expect(result.token_endpoint).toBe('https://mcp.example.com/oauth/token');
  });

  it('avoids double slash when resourceServerUrl has trailing slash', () => {
    const result = localizeOAuthMetadata(oauthMetadata, new URL('https://mcp.example.com/'));
    expect(result.registration_endpoint).not.toContain('//oauth');
    expect(result.authorization_endpoint).not.toContain('//oauth');
    expect(result.token_endpoint).not.toContain('//oauth');
  });

  it('rewrites issuer to this server origin (RFC 8414 §3.3) with no trailing slash', () => {
    const result = localizeOAuthMetadata(oauthMetadata, new URL('https://mcp.example.com/'));
    expect(result.issuer).toBe('https://mcp.example.com');
  });

  it('leaves jwks_uri pointing at Auth0 (tokens are Auth0-signed)', () => {
    const result = localizeOAuthMetadata(oauthMetadata, new URL('https://mcp.example.com/'));
    expect(result.jwks_uri).toBe(oauthMetadata.jwks_uri);
  });

  it('advertises PKCE S256 and public-client token auth', () => {
    const result = localizeOAuthMetadata(oauthMetadata, new URL('https://mcp.example.com/'));
    expect(result.code_challenge_methods_supported).toEqual(['S256']);
    expect(result.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(result.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
  });
});

describe('handleRegisterPost', () => {
  it('returns 201 with a per-connector client_id', async () => {
    const request = registerRequest({
      redirect_uris: ['https://new.example.com/callback'],
    });

    const response = await handleRegisterPost(request, appOptions());

    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(typeof body.client_id).toBe('string');
    expect(body.client_id as string).toMatch(/^mcp_/);
    expect(body.redirect_uris).toEqual(['https://new.example.com/callback']);
    expect(body.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(body.response_types).toEqual(['code']);
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.client_secret).toBeUndefined();
  });

  it('persists the registration in the transaction store', async () => {
    const store = new OAuthTransactionStore(null, 'test:');
    const request = registerRequest({
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    });

    const response = await handleRegisterPost(request, appOptions(store));
    const body = (await response.json()) as Record<string, unknown>;

    const registration = await store.getClient(body.client_id as string);
    expect(registration).not.toBeNull();
    expect(registration!.redirectUris).toEqual(['https://claude.ai/api/mcp/auth_callback']);
  });

  it('issues distinct client_ids to distinct connectors', async () => {
    const options = appOptions();
    const first = await handleRegisterPost(registerRequest({ redirect_uris: ['https://a.example.com/cb'] }), options);
    const second = await handleRegisterPost(registerRequest({ redirect_uris: ['https://b.example.com/cb'] }), options);

    const firstBody = (await first.json()) as Record<string, unknown>;
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(firstBody.client_id).not.toBe(secondBody.client_id);
  });

  it('echoes the requested client_name', async () => {
    const request = registerRequest({
      redirect_uris: ['https://example.com/callback'],
      client_name: 'Claude',
    });

    const response = await handleRegisterPost(request, appOptions());
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.client_name).toBe('Claude');
  });

  it('dedupes repeated redirect_uris', async () => {
    const request = registerRequest({
      redirect_uris: ['https://example.com/callback', 'https://example.com/callback'],
    });

    const response = await handleRegisterPost(request, appOptions());
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.redirect_uris).toEqual(['https://example.com/callback']);
  });

  it('allows http localhost redirect_uri', async () => {
    const request = registerRequest({
      redirect_uris: ['http://localhost:8080/callback'],
    });

    const response = await handleRegisterPost(request, appOptions());

    expect(response.status).toBe(201);
  });

  it('rejects non-https non-loopback redirect_uri with 400', async () => {
    const request = registerRequest({
      redirect_uris: ['http://evil.com/callback'],
    });

    const response = await handleRegisterPost(request, appOptions());

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_redirect_uri');
  });

  it('rejects request with missing redirect_uris field with 400', async () => {
    const request = registerRequest({
      client_name: 'My App',
    });

    const response = await handleRegisterPost(request, appOptions());

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_redirect_uri');
  });

  it('rejects request with empty redirect_uris array with 400', async () => {
    const request = registerRequest({
      redirect_uris: [],
    });

    const response = await handleRegisterPost(request, appOptions());

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_redirect_uri');
  });

  it('rejects request with non-string redirect_uri with 400', async () => {
    const request = registerRequest({
      redirect_uris: [123],
    });

    const response = await handleRegisterPost(request, appOptions());

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_redirect_uri');
  });

  it('rejects more than 10 redirect_uris with 400', async () => {
    const request = registerRequest({
      redirect_uris: Array.from({ length: 11 }, (_, i) => `https://example${i}.com/cb`),
    });

    const response = await handleRegisterPost(request, appOptions());

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_redirect_uri');
    expect(body.error_description).toContain('10');
  });

  it('rejects invalid JSON with 400', async () => {
    const request = new Request('https://mcp.example.com/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json',
    });

    const response = await handleRegisterPost(request, appOptions());

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_redirect_uri');
  });

  it('rejects if any redirect_uri is invalid', async () => {
    const request = registerRequest({
      redirect_uris: ['https://valid.com/cb', 'http://invalid.com/cb'],
    });

    const response = await handleRegisterPost(request, appOptions());

    expect(response.status).toBe(400);
  });

  it('includes CORS headers in all responses', async () => {
    const request = registerRequest({
      redirect_uris: ['https://example.com/callback'],
    });

    const response = await handleRegisterPost(request, appOptions());

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Content-Type')).toBe('application/json');
  });
});
