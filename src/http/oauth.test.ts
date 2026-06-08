import * as crypto from 'crypto';
import { describe, it, expect, vi } from 'vitest';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  Auth0OAuthTokenVerifier,
  authInfoToOAuthRockContext,
  fetchAuth0OAuthMetadata,
  loadAuth0Config,
  loadAuth0ManagementConfig,
} from './oauth.js';

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://mcp.example.com/mcp', { method: 'POST', headers });
}

describe('Auth0 OAuth config', () => {
  it('loads Auth0 env vars and normalizes URLs', () => {
    const config = loadAuth0Config({
      AUTH0_DOMAIN: 'favor.us.auth0.com',
      AUTH0_AUDIENCE: 'https://rock.example.com/api',
      MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
    });

    expect(config.issuer).toBe('https://favor.us.auth0.com/');
    expect(config.audience).toBe('https://rock.example.com/api');
    expect(config.resourceServerUrl.toString()).toBe('https://mcp.example.com/mcp');
    expect(config.discoveryUrl.toString()).toBe('https://favor.us.auth0.com/.well-known/openid-configuration');
  });

  it('keeps OAUTH_* env aliases for existing deployments', () => {
    const config = loadAuth0Config({
      OAUTH_ISSUER: 'https://legacy.example.com/',
      OAUTH_AUDIENCE: 'legacy-api',
      OAUTH_PUBLIC_URL: 'https://legacy-mcp.example.com/mcp',
    });

    expect(config.issuer).toBe('https://legacy.example.com/');
    expect(config.audience).toBe('legacy-api');
    expect(config.resourceServerUrl.toString()).toBe('https://legacy-mcp.example.com/mcp');
  });

  it('requires issuer/domain, audience, and resource server URL', () => {
    expect(() => loadAuth0Config({})).toThrow(/AUTH0_DOMAIN or AUTH0_ISSUER/);
    expect(() => loadAuth0Config({ AUTH0_DOMAIN: 'favor.us.auth0.com' })).toThrow(/AUTH0_AUDIENCE/);
    expect(() => loadAuth0Config({
      AUTH0_DOMAIN: 'favor.us.auth0.com',
      AUTH0_AUDIENCE: 'api',
    })).toThrow(/MCP_PUBLIC_URL/);
  });

  it('rejects an Auth0 issuer that is not https', () => {
    expect(() => loadAuth0Config({
      AUTH0_ISSUER: 'http://favor.us.auth0.com/',
      AUTH0_AUDIENCE: 'api',
      MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
    })).toThrow(/AUTH0_ISSUER.*https/i);
  });

  it('rejects a non-https MCP public URL unless it is explicit localhost loopback', () => {
    expect(() => loadAuth0Config({
      AUTH0_DOMAIN: 'favor.us.auth0.com',
      AUTH0_AUDIENCE: 'api',
      MCP_PUBLIC_URL: 'http://mcp.example.com/mcp',
    })).toThrow(/MCP_PUBLIC_URL.*https/i);

    expect(loadAuth0Config({
      AUTH0_DOMAIN: 'favor.us.auth0.com',
      AUTH0_AUDIENCE: 'api',
      MCP_PUBLIC_URL: 'http://localhost:3000/mcp',
    }).resourceServerUrl.toString()).toBe('http://localhost:3000/mcp');
  });
});

describe('Auth0 OAuth metadata discovery', () => {
  it('fetches Auth0 discovery metadata and preserves the registration endpoint', async () => {
    const config = loadAuth0Config({
      AUTH0_DOMAIN: 'favor.us.auth0.com',
      AUTH0_AUDIENCE: 'api',
      MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
    });
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      issuer: 'https://favor.us.auth0.com/',
      authorization_endpoint: 'https://favor.us.auth0.com/authorize',
      token_endpoint: 'https://favor.us.auth0.com/oauth/token',
      jwks_uri: 'https://favor.us.auth0.com/.well-known/jwks.json',
      registration_endpoint: 'https://favor.us.auth0.com/oidc/register',
      response_types_supported: ['code'],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const metadata = await fetchAuth0OAuthMetadata({ config, fetchFn });

    expect(fetchFn).toHaveBeenCalledWith(config.discoveryUrl);
    expect(metadata.issuer).toBe('https://favor.us.auth0.com/');
    expect(metadata.registration_endpoint).toBe('https://favor.us.auth0.com/oidc/register');
    expect(metadata.jwks_uri).toBe('https://favor.us.auth0.com/.well-known/jwks.json');
  });

  it('fails fast when Auth0 dynamic client registration is not enabled', async () => {
    const config = loadAuth0Config({
      AUTH0_DOMAIN: 'favor.us.auth0.com',
      AUTH0_AUDIENCE: 'api',
      MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
    });
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      issuer: 'https://favor.us.auth0.com/',
      authorization_endpoint: 'https://favor.us.auth0.com/authorize',
      token_endpoint: 'https://favor.us.auth0.com/oauth/token',
      jwks_uri: 'https://favor.us.auth0.com/.well-known/jwks.json',
      response_types_supported: ['code'],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(fetchAuth0OAuthMetadata({ config, fetchFn })).rejects.toThrow(/Dynamic Client Registration/);
  });

  it('rejects discovery metadata when the issuer does not match config', async () => {
    const config = loadAuth0Config({
      AUTH0_DOMAIN: 'favor.us.auth0.com',
      AUTH0_AUDIENCE: 'api',
      MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
    });
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      issuer: 'https://different.us.auth0.com/',
      authorization_endpoint: 'https://favor.us.auth0.com/authorize',
      token_endpoint: 'https://favor.us.auth0.com/oauth/token',
      jwks_uri: 'https://favor.us.auth0.com/.well-known/jwks.json',
      registration_endpoint: 'https://favor.us.auth0.com/oidc/register',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(fetchAuth0OAuthMetadata({ config, fetchFn })).rejects.toThrow(/issuer/i);
  });

  it('rejects discovery metadata when a required endpoint is not a valid http url', async () => {
    const config = loadAuth0Config({
      AUTH0_DOMAIN: 'favor.us.auth0.com',
      AUTH0_AUDIENCE: 'api',
      MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
    });
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      issuer: 'https://favor.us.auth0.com/',
      authorization_endpoint: '/authorize',
      token_endpoint: 'https://favor.us.auth0.com/oauth/token',
      jwks_uri: 'https://favor.us.auth0.com/.well-known/jwks.json',
      registration_endpoint: 'https://favor.us.auth0.com/oidc/register',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(fetchAuth0OAuthMetadata({ config, fetchFn })).rejects.toThrow(/authorization_endpoint/i);
  });

  it('rejects discovery metadata when a required endpoint is not https', async () => {
    const config = loadAuth0Config({
      AUTH0_DOMAIN: 'favor.us.auth0.com',
      AUTH0_AUDIENCE: 'api',
      MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
    });
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      issuer: 'https://favor.us.auth0.com/',
      authorization_endpoint: 'https://favor.us.auth0.com/authorize',
      token_endpoint: 'http://favor.us.auth0.com/oauth/token',
      jwks_uri: 'https://favor.us.auth0.com/.well-known/jwks.json',
      registration_endpoint: 'https://favor.us.auth0.com/oidc/register',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(fetchAuth0OAuthMetadata({ config, fetchFn })).rejects.toThrow(/token_endpoint.*https/i);
  });
});

describe('Auth0OAuthTokenVerifier', () => {
  it('verifies Auth0 JWTs and converts claims to SDK AuthInfo', async () => {
    const config = loadAuth0Config({
      AUTH0_ISSUER: 'https://favor.us.auth0.com/',
      AUTH0_AUDIENCE: 'https://rock.example.com/api',
      MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
    });
    const jwksKey = Symbol('jwks');
    const createRemoteJWKSet = vi.fn(() => jwksKey);
    const jwtVerify = vi.fn(async () => ({
      payload: {
        sub: 'auth0|123',
        azp: 'client-123',
        scope: 'read write',
        permissions: ['admin'],
        email: 'rico@example.com',
        name: 'Rico',
        iss: 'https://favor.us.auth0.com/',
        aud: 'https://rock.example.com/api',
        exp: 2_000_000_000,
      },
      protectedHeader: { alg: 'RS256' },
    }));

    const verifier = new Auth0OAuthTokenVerifier(config, {
      jwksUri: 'https://favor.us.auth0.com/.well-known/jwks.json',
      createRemoteJWKSet,
      jwtVerify,
    });

    const authInfo = await verifier.verifyAccessToken('raw-access-token');

    expect(createRemoteJWKSet).toHaveBeenCalledWith(new URL('https://favor.us.auth0.com/.well-known/jwks.json'));
    expect(jwtVerify).toHaveBeenCalledWith('raw-access-token', jwksKey, {
      issuer: 'https://favor.us.auth0.com/',
      audience: 'https://rock.example.com/api',
    });
    expect(authInfo).toEqual({
      token: 'raw-access-token',
      clientId: 'client-123',
      scopes: ['read', 'write', 'admin'],
      expiresAt: 2_000_000_000,
      extra: expect.objectContaining({
        sub: 'auth0|123',
        email: 'rico@example.com',
        name: 'Rico',
      }),
    });
  });

  it('rejects non-HTTPS JWKS dependency URLs', () => {
    const config = loadAuth0Config({
      AUTH0_ISSUER: 'https://favor.us.auth0.com/',
      AUTH0_AUDIENCE: 'https://rock.example.com/api',
      MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
    });

    expect(() => new Auth0OAuthTokenVerifier(config, {
      jwksUri: 'http://favor.us.auth0.com/.well-known/jwks.json',
    })).toThrow(/jwks_uri.*https/i);
  });

  it('rejects JWT payloads that do not include sub', async () => {
    const config = loadAuth0Config({
      AUTH0_ISSUER: 'https://favor.us.auth0.com/',
      AUTH0_AUDIENCE: 'https://rock.example.com/api',
      MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
    });

    const verifier = new Auth0OAuthTokenVerifier(config, {
      jwtVerify: vi.fn(async () => ({
        payload: {
          azp: 'client-123',
          scope: 'read write',
        },
      })),
    });

    await expect(verifier.verifyAccessToken('raw-access-token')).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(verifier.verifyAccessToken('raw-access-token')).rejects.toThrow(/subject/i);
  });

  it('rejects JWT payloads with whitespace-only sub', async () => {
    const config = loadAuth0Config({
      AUTH0_ISSUER: 'https://favor.us.auth0.com/',
      AUTH0_AUDIENCE: 'https://rock.example.com/api',
      MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
    });

    const verifier = new Auth0OAuthTokenVerifier(config, {
      jwtVerify: vi.fn(async () => ({
        payload: {
          sub: '   ',
          scope: 'read write',
        },
      })),
    });

    await expect(verifier.verifyAccessToken('raw-access-token')).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(verifier.verifyAccessToken('raw-access-token')).rejects.toThrow(/subject/i);
  });
});

describe('authInfoToOAuthRockContext', () => {
  it('maps SDK AuthInfo into OAuthRockContext without enumerating the raw token', () => {
    const auth: AuthInfo = {
      token: 'raw-access-token',
      clientId: 'client-123',
      scopes: ['read', 'write', 'other'],
      expiresAt: 2_000_000_000,
      extra: {
        sub: 'auth0|123',
        email: 'rico@example.com',
        name: 'Rico',
        iss: 'https://favor.us.auth0.com/',
      },
    };
    const req = makeRequest({
      'x-mcp-session-id': 'session-123',
      'x-request-id': 'request-123',
      'user-agent': 'vitest',
      'x-forwarded-for': '203.0.113.10, 70.41.3.18',
    });

    const ctx = authInfoToOAuthRockContext(auth, req);

    expect(ctx.oauth).toEqual({
      subject: 'auth0|123',
      email: 'rico@example.com',
      name: 'Rico',
      issuer: 'https://favor.us.auth0.com/',
      accessTokenHash: crypto.createHash('sha256').update('raw-access-token').digest('hex'),
    });
    expect(ctx.scopes).toEqual(new Set(['read', 'write']));
    expect(ctx.rockUserToken).toBe('raw-access-token');
    expect(JSON.stringify(ctx)).not.toContain('raw-access-token');
    expect(ctx.request).toEqual({
      sessionId: 'session-123',
      requestId: 'request-123',
      ip: '203.0.113.10',
      userAgent: 'vitest',
    });
  });

  it('rejects AuthInfo missing extra.sub even when clientId is present', () => {
    const auth: AuthInfo = {
      token: 'raw-access-token',
      clientId: 'client-123',
      scopes: ['read'],
      extra: {
        email: 'rico@example.com',
        name: 'Rico',
        iss: 'https://favor.us.auth0.com/',
      },
    };

    expect(() => authInfoToOAuthRockContext(auth, makeRequest())).toThrow(/subject/i);
  });

  it('rejects AuthInfo with whitespace-only extra.sub even when clientId is present', () => {
    const auth: AuthInfo = {
      token: 'raw-access-token',
      clientId: 'client-123',
      scopes: ['read'],
      extra: {
        sub: '   ',
        email: 'rico@example.com',
        name: 'Rico',
        iss: 'https://favor.us.auth0.com/',
      },
    };

    expect(() => authInfoToOAuthRockContext(auth, makeRequest())).toThrow(/subject/i);
  });

  it('generates session and request IDs when headers are absent', () => {
    const auth: AuthInfo = {
      token: 'raw-access-token',
      clientId: 'client-123',
      scopes: ['read'],
      extra: { sub: 'auth0|123' },
    };

    const ctx = authInfoToOAuthRockContext(auth, makeRequest());

    expect(ctx.request.sessionId).toMatch(/[0-9a-f-]{36}/);
    expect(ctx.request.requestId).toMatch(/[0-9a-f-]{36}/);
    expect(ctx.request.ip).toBeUndefined();
  });
});

describe('loadAuth0ManagementConfig', () => {
  it('returns all three values from a complete env', () => {
    const config = loadAuth0ManagementConfig({
      AUTH0_CLIENT_ID: 'public-client-id',
      AUTH0_MANAGEMENT_CLIENT_ID: 'management-client-id',
      AUTH0_MANAGEMENT_CLIENT_SECRET: 'management-client-secret',
    });

    expect(config.sharedPublicClientId).toBe('public-client-id');
    expect(config.clientId).toBe('management-client-id');
    expect(config.clientSecret).toBe('management-client-secret');
  });

  it('trims surrounding whitespace', () => {
    const config = loadAuth0ManagementConfig({
      AUTH0_CLIENT_ID: '  public-client-id  ',
      AUTH0_MANAGEMENT_CLIENT_ID: '  management-client-id  ',
      AUTH0_MANAGEMENT_CLIENT_SECRET: '  management-client-secret  ',
    });

    expect(config.sharedPublicClientId).toBe('public-client-id');
    expect(config.clientId).toBe('management-client-id');
    expect(config.clientSecret).toBe('management-client-secret');
  });

  it('throws when AUTH0_CLIENT_ID is missing', () => {
    expect(() => loadAuth0ManagementConfig({
      AUTH0_MANAGEMENT_CLIENT_ID: 'management-client-id',
      AUTH0_MANAGEMENT_CLIENT_SECRET: 'management-client-secret',
    })).toThrow('AUTH0_CLIENT_ID env var is required');
  });

  it('throws when AUTH0_MANAGEMENT_CLIENT_ID is missing', () => {
    expect(() => loadAuth0ManagementConfig({
      AUTH0_CLIENT_ID: 'public-client-id',
      AUTH0_MANAGEMENT_CLIENT_SECRET: 'management-client-secret',
    })).toThrow('AUTH0_MANAGEMENT_CLIENT_ID env var is required');
  });

  it('throws when AUTH0_MANAGEMENT_CLIENT_SECRET is missing', () => {
    expect(() => loadAuth0ManagementConfig({
      AUTH0_CLIENT_ID: 'public-client-id',
      AUTH0_MANAGEMENT_CLIENT_ID: 'management-client-id',
    })).toThrow('AUTH0_MANAGEMENT_CLIENT_SECRET env var is required');
  });
});
