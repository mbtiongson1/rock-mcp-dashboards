import * as crypto from 'crypto';
import { describe, it, expect, vi } from 'vitest';
import {
  handleAuthorizeGet,
  handleCallbackGet,
  handleTokenPost,
  handleRevokePost,
  loadOAuthProxyClientConfig,
  proxyCallbackUrl,
  verifyPkceS256,
  OAuthProxyDeps,
} from '../../src/http/oauth-proxy.js';
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
  revocation_endpoint: 'https://auth.example.com/oauth/revoke',
  jwks_uri: 'https://auth.example.com/.well-known/jwks.json',
  response_types_supported: ['code'],
  token_endpoint_auth_methods_supported: ['none'],
};

const AUTH0_TOKENS = {
  access_token: 'auth0-access-token',
  refresh_token: 'auth0-refresh-token',
  token_type: 'Bearer',
  expires_in: 86400,
  scope: 'read write',
};

function makeDeps(overrides: Partial<OAuthProxyDeps> = {}): OAuthProxyDeps & { store: OAuthTransactionStore } {
  const store = new OAuthTransactionStore(null, 'test:');
  return {
    oauthConfig,
    oauthMetadata,
    proxyClient: { clientId: 'proxy-client-id', clientSecret: 'proxy-client-secret' },
    transactionStore: store,
    fetchFn: vi.fn(async () => new Response(JSON.stringify(AUTH0_TOKENS), { status: 200 })) as unknown as typeof fetch,
    store,
    ...overrides,
  };
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function registerConnector(store: OAuthTransactionStore, redirectUri = 'https://claude.ai/api/mcp/auth_callback') {
  return store.registerClient([redirectUri]);
}

function authorizeRequest(params: Record<string, string>): Request {
  const url = new URL('https://mcp.example.com/oauth/authorize');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Request(url.toString());
}

function tokenRequest(params: Record<string, string>): Request {
  return new Request('https://mcp.example.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

function revokeRequest(params: Record<string, string>): Request {
  return new Request('https://mcp.example.com/oauth/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

/** Runs the full authorize → callback flow and returns the proxy code + state. */
async function completeAuthorization(deps: ReturnType<typeof makeDeps>, connector: { clientId: string; redirectUris: string[] }, challenge: string) {
  const authorizeResponse = await handleAuthorizeGet(authorizeRequest({
    client_id: connector.clientId,
    redirect_uri: connector.redirectUris[0],
    response_type: 'code',
    state: 'connector-state',
    scope: 'read write',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }), deps);
  expect(authorizeResponse.status).toBe(302);
  const auth0Url = new URL(authorizeResponse.headers.get('location')!);
  const proxyState = auth0Url.searchParams.get('state')!;

  const callbackResponse = await handleCallbackGet(
    new Request(`https://mcp.example.com/oauth/callback?code=auth0-code&state=${proxyState}`),
    deps
  );
  expect(callbackResponse.status).toBe(302);
  const connectorUrl = new URL(callbackResponse.headers.get('location')!);
  return {
    code: connectorUrl.searchParams.get('code')!,
    state: connectorUrl.searchParams.get('state'),
    redirectedTo: `${connectorUrl.origin}${connectorUrl.pathname}`,
  };
}

describe('loadOAuthProxyClientConfig', () => {
  it('loads client id and secret', () => {
    expect(loadOAuthProxyClientConfig({ AUTH0_CLIENT_ID: 'id', AUTH0_CLIENT_SECRET: 'secret' }))
      .toEqual({ clientId: 'id', clientSecret: 'secret' });
  });

  it('throws when AUTH0_CLIENT_ID is missing', () => {
    expect(() => loadOAuthProxyClientConfig({ AUTH0_CLIENT_SECRET: 'secret' })).toThrow('AUTH0_CLIENT_ID');
  });

  it('throws when AUTH0_CLIENT_SECRET is missing', () => {
    expect(() => loadOAuthProxyClientConfig({ AUTH0_CLIENT_ID: 'id' })).toThrow('AUTH0_CLIENT_SECRET');
  });
});

describe('verifyPkceS256', () => {
  it('accepts a matching verifier', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
  });

  it('rejects a mismatched verifier', () => {
    const { challenge } = pkcePair();
    expect(verifyPkceS256('wrong-verifier', challenge)).toBe(false);
  });
});

describe('handleAuthorizeGet', () => {
  it('redirects to Auth0 with the proxy client and fixed callback', async () => {
    const deps = makeDeps();
    const connector = await registerConnector(deps.store);
    const { challenge } = pkcePair();

    const response = await handleAuthorizeGet(authorizeRequest({
      client_id: connector.clientId,
      redirect_uri: connector.redirectUris[0],
      response_type: 'code',
      state: 'abc',
      scope: 'read write',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }), deps);

    expect(response.status).toBe(302);
    const url = new URL(response.headers.get('location')!);
    expect(url.origin + url.pathname).toBe('https://auth.example.com/authorize');
    expect(url.searchParams.get('client_id')).toBe('proxy-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://mcp.example.com/oauth/callback');
    expect(url.searchParams.get('audience')).toBe(oauthConfig.audience);
    expect(url.searchParams.get('state')).not.toBe('abc'); // proxy state, not connector state
    const scope = url.searchParams.get('scope')!.split(' ');
    expect(scope).toEqual(expect.arrayContaining(['openid', 'email', 'offline_access', 'read', 'write']));
  });

  it('rejects unknown client_id with 401 and does not redirect', async () => {
    const deps = makeDeps();
    const { challenge } = pkcePair();
    const response = await handleAuthorizeGet(authorizeRequest({
      client_id: 'mcp_unknown',
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }), deps);

    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_client');
  });

  it('rejects unregistered redirect_uri with 400 and does not redirect (open-redirect guard)', async () => {
    const deps = makeDeps();
    const connector = await registerConnector(deps.store);
    const { challenge } = pkcePair();
    const response = await handleAuthorizeGet(authorizeRequest({
      client_id: connector.clientId,
      redirect_uri: 'https://evil.example.com/steal',
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }), deps);

    expect(response.status).toBe(400);
  });

  it('requires exact redirect_uri match — no prefix matching', async () => {
    const deps = makeDeps();
    const connector = await registerConnector(deps.store, 'https://claude.ai/cb');
    const { challenge } = pkcePair();
    const response = await handleAuthorizeGet(authorizeRequest({
      client_id: connector.clientId,
      redirect_uri: 'https://claude.ai/cb/extra',
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }), deps);

    expect(response.status).toBe(400);
  });

  it('redirects back with error when code_challenge is missing', async () => {
    const deps = makeDeps();
    const connector = await registerConnector(deps.store);
    const response = await handleAuthorizeGet(authorizeRequest({
      client_id: connector.clientId,
      redirect_uri: connector.redirectUris[0],
      response_type: 'code',
      state: 'abc',
    }), deps);

    expect(response.status).toBe(302);
    const url = new URL(response.headers.get('location')!);
    expect(url.origin).toBe('https://claude.ai');
    expect(url.searchParams.get('error')).toBe('invalid_request');
    expect(url.searchParams.get('state')).toBe('abc');
  });

  it('rejects plain code_challenge_method', async () => {
    const deps = makeDeps();
    const connector = await registerConnector(deps.store);
    const { challenge } = pkcePair();
    const response = await handleAuthorizeGet(authorizeRequest({
      client_id: connector.clientId,
      redirect_uri: connector.redirectUris[0],
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'plain',
    }), deps);

    expect(response.status).toBe(302);
    const url = new URL(response.headers.get('location')!);
    expect(url.searchParams.get('error')).toBe('invalid_request');
  });
});

describe('authorize → callback → token (full flow)', () => {
  it('returns the Auth0 token set to the connector', async () => {
    const deps = makeDeps();
    const connector = await registerConnector(deps.store);
    const { verifier, challenge } = pkcePair();

    const { code, state, redirectedTo } = await completeAuthorization(deps, connector, challenge);
    expect(state).toBe('connector-state');
    expect(redirectedTo).toBe('https://claude.ai/api/mcp/auth_callback');

    // Auth0 exchange used the confidential client and the fixed callback
    const fetchMock = deps.fetchFn as ReturnType<typeof vi.fn>;
    const [tokenUrl, init] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe('https://auth.example.com/oauth/token');
    const sentBody = new URLSearchParams(init.body as string);
    expect(sentBody.get('client_id')).toBe('proxy-client-id');
    expect(sentBody.get('client_secret')).toBe('proxy-client-secret');
    expect(sentBody.get('redirect_uri')).toBe(proxyCallbackUrl(oauthConfig.resourceServerUrl));

    const tokenResponse = await handleTokenPost(tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: connector.clientId,
      redirect_uri: connector.redirectUris[0],
    }), deps);

    expect(tokenResponse.status).toBe(200);
    expect(await tokenResponse.json()).toEqual(AUTH0_TOKENS);
    expect(tokenResponse.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rejects a wrong PKCE verifier', async () => {
    const deps = makeDeps();
    const connector = await registerConnector(deps.store);
    const { challenge } = pkcePair();
    const { code } = await completeAuthorization(deps, connector, challenge);

    const response = await handleTokenPost(tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: 'wrong-verifier',
      client_id: connector.clientId,
    }), deps);

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_grant');
  });

  it('rejects code replay (one-time use)', async () => {
    const deps = makeDeps();
    const connector = await registerConnector(deps.store);
    const { verifier, challenge } = pkcePair();
    const { code } = await completeAuthorization(deps, connector, challenge);

    const params = {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: connector.clientId,
    };
    const first = await handleTokenPost(tokenRequest(params), deps);
    expect(first.status).toBe(200);

    const second = await handleTokenPost(tokenRequest(params), deps);
    expect(second.status).toBe(400);
  });

  it('rejects a code presented by a different client', async () => {
    const deps = makeDeps();
    const connector = await registerConnector(deps.store);
    const other = await registerConnector(deps.store, 'https://other.example.com/cb');
    const { verifier, challenge } = pkcePair();
    const { code } = await completeAuthorization(deps, connector, challenge);

    const response = await handleTokenPost(tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: other.clientId,
    }), deps);

    expect(response.status).toBe(400);
  });

  it('rejects an unknown callback state', async () => {
    const deps = makeDeps();
    const response = await handleCallbackGet(
      new Request('https://mcp.example.com/oauth/callback?code=auth0-code&state=bogus'),
      deps
    );
    expect(response.status).toBe(400);
  });

  it('relays an Auth0 error back to the connector redirect_uri', async () => {
    const deps = makeDeps();
    const connector = await registerConnector(deps.store);
    const { challenge } = pkcePair();

    const authorizeResponse = await handleAuthorizeGet(authorizeRequest({
      client_id: connector.clientId,
      redirect_uri: connector.redirectUris[0],
      response_type: 'code',
      state: 'xyz',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }), deps);
    const proxyState = new URL(authorizeResponse.headers.get('location')!).searchParams.get('state')!;

    const callbackResponse = await handleCallbackGet(
      new Request(`https://mcp.example.com/oauth/callback?error=access_denied&error_description=nope&state=${proxyState}`),
      deps
    );
    expect(callbackResponse.status).toBe(302);
    const url = new URL(callbackResponse.headers.get('location')!);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('xyz');
  });
});

describe('handleTokenPost refresh_token grant', () => {
  it('forwards the refresh to Auth0 with the confidential client', async () => {
    const deps = makeDeps();
    const connector = await registerConnector(deps.store);

    const response = await handleTokenPost(tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: 'auth0-refresh-token',
      client_id: connector.clientId,
    }), deps);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(AUTH0_TOKENS);

    const fetchMock = deps.fetchFn as ReturnType<typeof vi.fn>;
    const sentBody = new URLSearchParams(fetchMock.mock.calls[0][1].body as string);
    expect(sentBody.get('grant_type')).toBe('refresh_token');
    expect(sentBody.get('client_secret')).toBe('proxy-client-secret');
  });

  it('passes a rotated refresh_token from Auth0 through to the connector', async () => {
    const rotated = {
      access_token: 'new-access-token',
      refresh_token: 'rotated-refresh-token',
      token_type: 'Bearer',
      expires_in: 86400,
      scope: 'read write',
    };
    const deps = makeDeps({
      fetchFn: vi.fn(async () => new Response(JSON.stringify(rotated), { status: 200 })) as unknown as typeof fetch,
    });
    const connector = await registerConnector(deps.store);

    const response = await handleTokenPost(tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: 'auth0-refresh-token',
      client_id: connector.clientId,
    }), deps);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    // Auth0 is authoritative for rotation: the new refresh_token is passed through verbatim.
    expect(body.refresh_token).toBe('rotated-refresh-token');
    expect(body.access_token).toBe('new-access-token');
  });

  it('passes Auth0 invalid_grant errors through', async () => {
    const deps = makeDeps({
      fetchFn: vi.fn(async () => new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'revoked' }),
        { status: 400 }
      )) as unknown as typeof fetch,
    });
    const connector = await registerConnector(deps.store);

    const response = await handleTokenPost(tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: 'revoked-token',
      client_id: connector.clientId,
    }), deps);

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_grant');
  });

  it('rejects refresh for an unregistered client', async () => {
    const deps = makeDeps();
    const response = await handleTokenPost(tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: 'auth0-refresh-token',
      client_id: 'mcp_unknown',
    }), deps);

    expect(response.status).toBe(401);
  });

  it('rejects unsupported grant types', async () => {
    const deps = makeDeps();
    const response = await handleTokenPost(tokenRequest({
      grant_type: 'client_credentials',
    }), deps);

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('unsupported_grant_type');
  });
});

describe('handleRevokePost', () => {
  it('forwards the revocation to Auth0 and returns 200 (RFC 7009)', async () => {
    const deps = makeDeps({
      fetchFn: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    });
    const connector = await registerConnector(deps.store);

    const response = await handleRevokePost(revokeRequest({
      token: 'auth0-refresh-token',
      token_type_hint: 'refresh_token',
      client_id: connector.clientId,
    }), deps);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    const fetchMock = deps.fetchFn as ReturnType<typeof vi.fn>;
    const [revokeUrl, init] = fetchMock.mock.calls[0];
    expect(revokeUrl).toBe('https://auth.example.com/oauth/revoke');
    const sentBody = new URLSearchParams(init.body as string);
    expect(sentBody.get('token')).toBe('auth0-refresh-token');
    expect(sentBody.get('token_type_hint')).toBe('refresh_token');
    // Forwarded with the proxy's confidential client credentials.
    expect(sentBody.get('client_id')).toBe('proxy-client-id');
    expect(sentBody.get('client_secret')).toBe('proxy-client-secret');
  });

  it('returns 200 even for an unknown token (no probing)', async () => {
    // Auth0 returns 200 for unknown tokens per RFC 7009.
    const deps = makeDeps({
      fetchFn: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    });
    const connector = await registerConnector(deps.store);

    const response = await handleRevokePost(revokeRequest({
      token: 'unknown-token',
      client_id: connector.clientId,
    }), deps);

    expect(response.status).toBe(200);
  });

  it('rejects an unknown client_id with invalid_client', async () => {
    const deps = makeDeps({
      fetchFn: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    });

    const response = await handleRevokePost(revokeRequest({
      token: 'auth0-refresh-token',
      client_id: 'mcp_unknown',
    }), deps);

    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_client');
    // Must not have called Auth0 for an unauthenticated client.
    expect((deps.fetchFn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('requires a token', async () => {
    const deps = makeDeps();
    const connector = await registerConnector(deps.store);

    const response = await handleRevokePost(revokeRequest({
      client_id: connector.clientId,
    }), deps);

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_request');
  });

  it('falls back to {issuer}/oauth/revoke when metadata omits revocation_endpoint', async () => {
    const metadataWithoutRevoke = { ...oauthMetadata };
    delete (metadataWithoutRevoke as Record<string, unknown>).revocation_endpoint;
    const deps = makeDeps({
      oauthMetadata: metadataWithoutRevoke,
      fetchFn: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    });
    const connector = await registerConnector(deps.store);

    const response = await handleRevokePost(revokeRequest({
      token: 'auth0-refresh-token',
      client_id: connector.clientId,
    }), deps);

    expect(response.status).toBe(200);
    const fetchMock = deps.fetchFn as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls[0][0]).toBe('https://auth.example.com/oauth/revoke');
  });

  it('relays an Auth0 error body without leaking secrets', async () => {
    const deps = makeDeps({
      fetchFn: vi.fn(async () => new Response(
        JSON.stringify({ error: 'unsupported_token_type' }),
        { status: 400 }
      )) as unknown as typeof fetch,
    });
    const connector = await registerConnector(deps.store);

    const response = await handleRevokePost(revokeRequest({
      token: 'auth0-refresh-token',
      client_id: connector.clientId,
    }), deps);

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('unsupported_token_type');
    expect(JSON.stringify(body)).not.toContain('proxy-client-secret');
  });
});
