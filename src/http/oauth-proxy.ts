import * as crypto from 'crypto';
import { jsonCors } from './oauth-validate.js';
import type { Auth0OAuthConfig, Auth0OAuthMetadata, OAuthEnv } from './oauth.js';
import { OAuthTransactionStore } from './oauth-transactions.js';

/**
 * OAuth authorization-server proxy.
 *
 * This server is the authorization server connectors talk to: it exposes
 * /oauth/authorize, /oauth/callback and /oauth/token, and delegates the actual
 * login + token issuance to Auth0 through ONE dedicated confidential client
 * (AUTH0_CLIENT_ID / AUTH0_CLIENT_SECRET) with a single fixed callback
 * (`{MCP_PUBLIC_URL}/oauth/callback`). Connector redirect URIs live in Redis
 * (see oauth-transactions.ts), so Auth0 client config never changes at runtime
 * and the Management API is not needed.
 *
 * Tokens are pass-through: connectors receive the Auth0-issued access and
 * refresh tokens, so the existing JWT verifier and the Rock Bearer-forwarding
 * strategy keep working unchanged.
 */

export interface OAuthProxyClientConfig {
  clientId: string;
  clientSecret: string;
}

export interface OAuthProxyDeps {
  oauthConfig: Auth0OAuthConfig;
  oauthMetadata: Auth0OAuthMetadata;
  proxyClient: OAuthProxyClientConfig;
  transactionStore: OAuthTransactionStore;
  fetchFn?: typeof fetch;
}

const AUTH0_CLIENT_ID_KEYS = ['AUTH0_CLIENT_ID'];
const AUTH0_CLIENT_SECRET_KEYS = ['AUTH0_CLIENT_SECRET'];

/** Scopes always requested from Auth0 in addition to what the connector asks for. */
const BASE_AUTH0_SCOPES = ['openid', 'profile', 'email', 'offline_access'];

export function loadOAuthProxyClientConfig(env: OAuthEnv = process.env): OAuthProxyClientConfig {
  const clientId = firstEnvValue(env, AUTH0_CLIENT_ID_KEYS);
  if (!clientId) {
    throw new Error('AUTH0_CLIENT_ID env var is required');
  }
  const clientSecret = firstEnvValue(env, AUTH0_CLIENT_SECRET_KEYS);
  if (!clientSecret) {
    throw new Error('AUTH0_CLIENT_SECRET env var is required');
  }
  return { clientId, clientSecret };
}

export function proxyCallbackUrl(resourceServerUrl: URL): string {
  return `${resourceServerUrl.href.replace(/\/$/, '')}/oauth/callback`;
}

/**
 * GET /oauth/authorize — validates the connector's request against its stored
 * registration, persists a pending transaction, and redirects to Auth0.
 */
export async function handleAuthorizeGet(request: Request, deps: OAuthProxyDeps): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const clientId = params.get('client_id') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';

  const registration = await deps.transactionStore.getClient(clientId);
  if (!registration) {
    return oauthError('invalid_client', 'Unknown client_id; register via /oauth/register first', 401);
  }

  // Refresh the client registration TTL since it's actively used
  await deps.transactionStore.touchClient(clientId);

  // Exact string match against the registered redirect URIs — no prefix or
  // wildcard matching (open-redirect prevention). Errors before this point
  // must NOT redirect.
  if (!redirectUri || !registration.redirectUris.includes(redirectUri)) {
    return oauthError('invalid_request', 'redirect_uri is not registered for this client', 400);
  }

  const connectorState = params.get('state') ?? undefined;
  const redirectError = (error: string, description: string): Response =>
    redirectWithParams(redirectUri, {
      error,
      error_description: description,
      ...(connectorState ? { state: connectorState } : {}),
    });

  if (params.get('response_type') !== 'code') {
    return redirectError('unsupported_response_type', 'Only response_type=code is supported');
  }

  // PKCE is mandatory for MCP clients; only S256 is accepted.
  const codeChallenge = params.get('code_challenge') ?? '';
  const codeChallengeMethod = params.get('code_challenge_method') ?? 'plain';
  if (!codeChallenge) {
    return redirectError('invalid_request', 'code_challenge is required (PKCE)');
  }
  if (codeChallengeMethod !== 'S256') {
    return redirectError('invalid_request', 'code_challenge_method must be S256');
  }

  const scope = params.get('scope') ?? undefined;
  const state = await deps.transactionStore.createTransaction({
    clientId,
    redirectUri,
    connectorState,
    codeChallenge,
    codeChallengeMethod: 'S256',
    scope,
  });

  const authorizeUrl = new URL(deps.oauthMetadata.authorization_endpoint);
  authorizeUrl.searchParams.set('client_id', deps.proxyClient.clientId);
  authorizeUrl.searchParams.set('redirect_uri', proxyCallbackUrl(deps.oauthConfig.resourceServerUrl));
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('audience', deps.oauthConfig.audience);
  authorizeUrl.searchParams.set('scope', mergeScopes(scope));

  return Response.redirect(authorizeUrl.toString(), 302);
}

/**
 * GET /oauth/callback — Auth0 redirects here after login. Exchanges the Auth0
 * code immediately (Auth0 codes are single-use and short-lived), stores the
 * token set under a one-time proxy code, and redirects back to the connector.
 */
export async function handleCallbackGet(request: Request, deps: OAuthProxyDeps): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const state = params.get('state') ?? '';

  const txn = state ? await deps.transactionStore.consumeTransaction(state) : null;
  if (!txn) {
    return oauthError('invalid_request', 'Unknown or expired authorization transaction', 400);
  }

  const connectorParams = (extra: Record<string, string>): Record<string, string> => ({
    ...extra,
    ...(txn.connectorState ? { state: txn.connectorState } : {}),
  });

  const auth0Error = params.get('error');
  if (auth0Error) {
    return redirectWithParams(txn.redirectUri, connectorParams({
      error: auth0Error,
      error_description: params.get('error_description') ?? '',
    }));
  }

  const code = params.get('code');
  if (!code) {
    return redirectWithParams(txn.redirectUri, connectorParams({
      error: 'invalid_request',
      error_description: 'Missing authorization code from Auth0',
    }));
  }

  let tokenResponse: Record<string, unknown>;
  try {
    tokenResponse = await exchangeWithAuth0(deps, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: proxyCallbackUrl(deps.oauthConfig.resourceServerUrl),
    });
  } catch (err) {
    console.error('[oauth callback] Auth0 code exchange failed:', {
      error: err instanceof Error ? err.message : String(err),
    });
    return redirectWithParams(txn.redirectUri, connectorParams({
      error: 'server_error',
      error_description: 'Token exchange with the upstream identity provider failed',
    }));
  }

  const proxyCode = await deps.transactionStore.createProxyCode({
    clientId: txn.clientId,
    redirectUri: txn.redirectUri,
    codeChallenge: txn.codeChallenge,
    codeChallengeMethod: txn.codeChallengeMethod,
    tokenResponse,
  });

  return redirectWithParams(txn.redirectUri, connectorParams({ code: proxyCode }));
}

/**
 * POST /oauth/token — public-client token endpoint (PKCE is the proof of
 * possession; no client secret is required of connectors).
 */
export async function handleTokenPost(request: Request, deps: OAuthProxyDeps): Promise<Response> {
  let body: URLSearchParams;
  try {
    body = await parseTokenRequestBody(request);
  } catch {
    return oauthError('invalid_request', 'Request body must be application/x-www-form-urlencoded or JSON', 400);
  }

  const grantType = body.get('grant_type');
  if (grantType === 'authorization_code') {
    return handleAuthorizationCodeGrant(body, deps);
  }
  if (grantType === 'refresh_token') {
    return handleRefreshTokenGrant(body, deps);
  }
  return oauthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token', 400);
}

async function handleAuthorizationCodeGrant(body: URLSearchParams, deps: OAuthProxyDeps): Promise<Response> {
  const code = body.get('code') ?? '';
  const codeVerifier = body.get('code_verifier') ?? '';
  const clientId = body.get('client_id') ?? '';
  const redirectUri = body.get('redirect_uri');

  if (!code || !codeVerifier || !clientId) {
    return oauthError('invalid_request', 'code, code_verifier and client_id are required', 400);
  }

  // One-time consume: replayed or expired codes fail closed.
  const record = await deps.transactionStore.consumeProxyCode(code);
  if (!record) {
    return oauthError('invalid_grant', 'Authorization code is invalid, expired, or already used', 400);
  }
  if (record.clientId !== clientId) {
    return oauthError('invalid_grant', 'Authorization code was issued to a different client', 400);
  }
  if (redirectUri !== null && redirectUri !== record.redirectUri) {
    return oauthError('invalid_grant', 'redirect_uri does not match the authorization request', 400);
  }
  if (!verifyPkceS256(codeVerifier, record.codeChallenge)) {
    return oauthError('invalid_grant', 'PKCE verification failed', 400);
  }

  return jsonCors(record.tokenResponse, { status: 200, headers: NO_STORE_HEADERS });
}

async function handleRefreshTokenGrant(body: URLSearchParams, deps: OAuthProxyDeps): Promise<Response> {
  const refreshToken = body.get('refresh_token') ?? '';
  const clientId = body.get('client_id') ?? '';

  if (!refreshToken) {
    return oauthError('invalid_request', 'refresh_token is required', 400);
  }
  const registration = await deps.transactionStore.getClient(clientId);
  if (!registration) {
    return oauthError('invalid_client', 'Unknown client_id', 401);
  }

  try {
    const tokenResponse = await exchangeWithAuth0(deps, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    return jsonCors(tokenResponse, { status: 200, headers: NO_STORE_HEADERS });
  } catch (err) {
    if (err instanceof Auth0TokenError) {
      // Pass Auth0's OAuth error through (e.g. invalid_grant on revoked tokens).
      return jsonCors(err.body, { status: err.status, headers: NO_STORE_HEADERS });
    }
    console.error('[oauth token] Auth0 refresh failed:', {
      error: err instanceof Error ? err.message : String(err),
    });
    return oauthError('server_error', 'Token refresh with the upstream identity provider failed', 502);
  }
}

class Auth0TokenError extends Error {
  constructor(public status: number, public body: Record<string, unknown>) {
    super(`Auth0 token endpoint returned ${status}`);
  }
}

async function exchangeWithAuth0(
  deps: OAuthProxyDeps,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const fetchFn = deps.fetchFn ?? fetch;
  const response = await fetchFn(deps.oauthMetadata.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      ...params,
      client_id: deps.proxyClient.clientId,
      client_secret: deps.proxyClient.clientSecret,
    }).toString(),
  });

  let payload: Record<string, unknown>;
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch {
    payload = { error: 'server_error', error_description: 'Upstream token endpoint returned a non-JSON response' };
  }

  if (!response.ok) {
    throw new Auth0TokenError(response.status, payload);
  }
  return payload;
}

async function parseTokenRequestBody(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const json = await request.json() as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(json)) {
      if (typeof value === 'string') {
        params.set(key, value);
      }
    }
    return params;
  }
  return new URLSearchParams(await request.text());
}

export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  const computed = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const expected = Buffer.from(codeChallenge);
  const actual = Buffer.from(computed);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function mergeScopes(connectorScope: string | undefined): string {
  const scopes = new Set<string>(BASE_AUTH0_SCOPES);
  for (const scope of (connectorScope ?? '').split(/\s+/).filter(Boolean)) {
    scopes.add(scope);
  }
  return [...scopes].join(' ');
}

function redirectWithParams(baseUri: string, params: Record<string, string>): Response {
  const url = new URL(baseUri);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return Response.redirect(url.toString(), 302);
}

function oauthError(error: string, description: string, status: number): Response {
  return jsonCors({ error, error_description: description }, { status, headers: NO_STORE_HEADERS });
}

const NO_STORE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'Pragma': 'no-cache',
};

function firstEnvValue(env: OAuthEnv, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}
