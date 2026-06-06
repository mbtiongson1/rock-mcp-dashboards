import * as crypto from 'crypto';
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  Auth0OAuthTokenVerifier,
  createAuthMiddleware,
  createOAuthContextAdapterMiddleware,
  fetchAuth0OAuthMetadata,
  loadAuth0Config,
} from './oauth.js';

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
});

describe('OAuth context adapter', () => {
  it('maps SDK req.auth into OAuthRockContext without enumerating the raw token', async () => {
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
    const req = {
      auth,
      headers: {
        'x-mcp-session-id': 'session-123',
        'x-request-id': 'request-123',
        'user-agent': 'vitest',
      },
      ip: '203.0.113.10',
      socket: { remoteAddress: '192.0.2.1' },
    } as unknown as Request & { oauthContext?: any };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn();

    await createOAuthContextAdapterMiddleware()(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.oauthContext.oauth).toEqual({
      subject: 'auth0|123',
      email: 'rico@example.com',
      name: 'Rico',
      issuer: 'https://favor.us.auth0.com/',
      accessTokenHash: crypto.createHash('sha256').update('raw-access-token').digest('hex'),
    });
    expect(req.oauthContext.scopes).toEqual(new Set(['read', 'write']));
    expect(req.oauthContext.rockUserToken).toBe('raw-access-token');
    expect(JSON.stringify(req.oauthContext)).not.toContain('raw-access-token');
    expect(req.oauthContext.request).toEqual({
      sessionId: 'session-123',
      requestId: 'request-123',
      ip: '203.0.113.10',
      userAgent: 'vitest',
    });
  });
});

describe('OAuth Middleware', () => {
  it('should return 401 when Authorization header is missing', async () => {
    const middleware = createAuthMiddleware({
      verifyToken: async () => ({ isValid: false, error: 'Missing token' }),
    });

    const req = { headers: {} } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 403 when read scope is missing', async () => {
    const middleware = createAuthMiddleware({
      verifyToken: async () => ({
        isValid: true,
        payload: { sub: 'user123', scope: 'other' }
      }),
    });

    const req = { headers: { authorization: 'Bearer token' } } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Missing required read scope' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('should succeed and attach oauthContext when token and read scope are valid', async () => {
    const middleware = createAuthMiddleware({
      verifyToken: async () => ({
        isValid: true,
        payload: { sub: 'user123', scope: 'read write', email: 'test@example.com' }
      }),
    });

    const req = {
      headers: { authorization: 'Bearer token' },
      ip: '127.0.0.1',
      headers_info: { 'user-agent': 'vitest' }
    } as unknown as Request & { oauthContext?: any };
    
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.oauthContext).toBeDefined();
    expect(req.oauthContext.oauth.subject).toBe('user123');
    expect(req.oauthContext.scopes).toContain('read');
    expect(req.oauthContext.scopes).toContain('write');
  });
});
