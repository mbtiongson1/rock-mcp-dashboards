import { describe, it, expect } from 'vitest';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { validateOAuthContext } from '../../src/http/oauth-validate.js';

const RESOURCE_METADATA_URL = 'https://mcp.example.com/.well-known/oauth-protected-resource';

function makeVerifier(authInfo: AuthInfo | Error): OAuthTokenVerifier {
  return {
    verifyAccessToken: async () => {
      if (authInfo instanceof Error) {
        throw authInfo;
      }
      return authInfo;
    },
  };
}

const validAuthInfo: AuthInfo = {
  token: 'raw-access-token',
  clientId: 'client-123',
  scopes: ['read', 'write'],
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  extra: {
    sub: 'auth0|123',
    email: 'person@example.com',
    iss: 'https://auth.example.com/',
  },
};

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://mcp.example.com/mcp', {
    method: 'POST',
    headers,
  });
}

describe('validateOAuthContext', () => {
  it('returns a 401 challenge with resource_metadata when Authorization is missing', async () => {
    const result = await validateOAuthContext(makeRequest(), {
      verifier: makeVerifier(validAuthInfo),
      resourceMetadataUrl: RESOURCE_METADATA_URL,
      requiredScopes: ['read'],
    });

    expect(result.ctx).toBeUndefined();
    expect(result.response).toBeDefined();
    expect(result.response!.status).toBe(401);
    const wwwAuth = result.response!.headers.get('WWW-Authenticate');
    expect(wwwAuth).toContain('error="invalid_token"');
    expect(wwwAuth).toContain(`resource_metadata="${RESOURCE_METADATA_URL}"`);
  });

  it('resolves an OAuthRockContext for a valid bearer token with read+write scopes', async () => {
    const result = await validateOAuthContext(
      makeRequest({ Authorization: 'Bearer raw-access-token' }),
      {
        verifier: makeVerifier(validAuthInfo),
        resourceMetadataUrl: RESOURCE_METADATA_URL,
        requiredScopes: ['read'],
      }
    );

    expect(result.response).toBeUndefined();
    expect(result.ctx).toBeDefined();
    expect(result.ctx!.oauth.subject).toBe('auth0|123');
    expect(result.ctx!.oauth.email).toBe('person@example.com');
    expect(result.ctx!.scopes.has('read')).toBe(true);
    expect(result.ctx!.scopes.has('write')).toBe(true);
    // raw token must not be enumerable
    expect(JSON.stringify(result.ctx)).not.toContain('raw-access-token');
    expect(result.ctx!.rockUserToken).toBe('raw-access-token');
  });

  it('returns 401 invalid_token when the verifier rejects the token', async () => {
    const { InvalidTokenError } = await import(
      '@modelcontextprotocol/sdk/server/auth/errors.js'
    );
    const result = await validateOAuthContext(
      makeRequest({ Authorization: 'Bearer bad-token' }),
      {
        verifier: makeVerifier(new InvalidTokenError('jwt expired')),
        resourceMetadataUrl: RESOURCE_METADATA_URL,
        requiredScopes: ['read'],
      }
    );

    expect(result.response!.status).toBe(401);
    expect(result.response!.headers.get('WWW-Authenticate')).toContain('error="invalid_token"');
  });

  it('returns 403 insufficient_scope when read scope is missing', async () => {
    const result = await validateOAuthContext(
      makeRequest({ Authorization: 'Bearer raw-access-token' }),
      {
        verifier: makeVerifier({ ...validAuthInfo, scopes: ['write'] }),
        resourceMetadataUrl: RESOURCE_METADATA_URL,
        requiredScopes: ['read'],
      }
    );

    expect(result.response!.status).toBe(403);
    expect(result.response!.headers.get('WWW-Authenticate')).toContain('error="insufficient_scope"');
  });

  it('returns 401 when the token is expired', async () => {
    const result = await validateOAuthContext(
      makeRequest({ Authorization: 'Bearer raw-access-token' }),
      {
        verifier: makeVerifier({ ...validAuthInfo, expiresAt: Math.floor(Date.now() / 1000) - 10 }),
        resourceMetadataUrl: RESOURCE_METADATA_URL,
        requiredScopes: ['read'],
      }
    );

    expect(result.response!.status).toBe(401);
    expect(result.response!.headers.get('WWW-Authenticate')).toContain('error="invalid_token"');
  });
});
