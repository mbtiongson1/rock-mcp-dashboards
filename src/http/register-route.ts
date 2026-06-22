import { getAppContext, CreateAppContextOptions } from './app-context.js';
import { jsonCors } from './oauth-validate.js';
import type { Auth0OAuthMetadata } from './oauth.js';
import { DcrRateLimiter, extractClientIp } from './dcr-rate-limiter.js';
import { DCR_RATE_LIMIT_REQUESTS, DCR_RATE_LIMIT_WINDOW_SECONDS } from './oauth-transactions.js';
import { createRedisClient, getRedisPrefix } from '../rock/redis.js';

const MAX_REDIRECT_URIS = 10;

/**
 * Validates a redirect URI according to RFC 7591 rules with security hardening:
 * - Must be a valid absolute URL
 * - Must use HTTPS scheme
 * - EXCEPT: HTTP is allowed for loopback hosts (localhost, 127.0.0.1, [::1])
 * - Must NOT contain URL fragments (#)
 * - Must NOT contain embedded credentials (user:pass@)
 *
 * Optional allowlist (OAUTH_REDIRECT_URI_ALLOWLIST env var, comma-separated host suffixes)
 * can further restrict allowed hosts. When unset, all HTTPS + loopback HTTP are allowed.
 */
export function isAllowedRedirectUri(uri: string, allowListEnv?: string): boolean {
  // Reject URIs with fragments before parsing URL (# without content is stripped by URL parser)
  if (uri.includes('#')) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }

  // Reject URIs with embedded credentials
  if (url.username || url.password) {
    return false;
  }

  // Check scheme and host validity
  if (url.protocol === 'https:') {
    // Apply optional allowlist if configured
    if (allowListEnv) {
      return isHostAllowlisted(url.hostname, allowListEnv);
    }
    return true;
  }

  if (url.protocol === 'http:') {
    // HTTP only allowed for loopback, regardless of allowlist
    return isLoopbackHost(url.hostname);
  }

  return false;
}

/**
 * Check if a hostname matches the allowlist (comma-separated host suffixes).
 * Empty allowlist means allow all.
 */
function isHostAllowlisted(hostname: string, allowListEnv: string): boolean {
  const trimmed = allowListEnv.trim();
  if (!trimmed) {
    return true; // Empty allowlist = allow all
  }

  const hosts = trimmed.split(',').map(h => h.trim().toLowerCase());
  const lowerHostname = hostname.toLowerCase();

  for (const allowedHost of hosts) {
    if (lowerHostname === allowedHost || lowerHostname.endsWith(`.${allowedHost}`)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if a hostname is a loopback address.
 * Reuse the pattern from src/http/oauth.ts
 */
function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

/**
 * Rewrites Auth0 OAuth metadata so this server presents itself as the
 * authorization server to MCP clients. With the proxy model, ALL OAuth
 * endpoints live on this server:
 * - `authorization_endpoint` / `token_endpoint` point at /oauth/authorize and
 *   /oauth/token (the proxy delegates to Auth0 behind the scenes).
 * - `registration_endpoint` points at the Redis-backed /oauth/register —
 *   registration never touches Auth0.
 * - `issuer` is set to this server's origin per RFC 8414 §3.3.
 *
 * Auth0 still issues and signs the tokens, so `jwks_uri` keeps pointing at
 * Auth0 and token verification (src/http/oauth.ts) validates against the
 * Auth0 issuer.
 */
export function localizeOAuthMetadata(
  metadata: Auth0OAuthMetadata,
  resourceServerUrl: URL
): Auth0OAuthMetadata {
  const base = resourceServerUrl.href.replace(/\/$/, '');
  return {
    ...metadata,
    issuer: resourceServerUrl.origin,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['read', 'write'],
  };
}

/**
 * Framework-agnostic handler for POST /oauth/register.
 * Implements RFC 7591 dynamic client registration backed entirely by Redis:
 * each connector gets its own opaque client_id, and its redirect URIs are
 * validated here and enforced by the /oauth/authorize proxy. Auth0 is never
 * called — its client config stays fixed.
 */
export async function handleRegisterPost(
  request: Request,
  options?: CreateAppContextOptions
): Promise<Response> {
  try {
    const app = await getAppContext(options);

    // Rate limiting: check client IP against per-IP registration limit
    const clientIp = extractClientIp(request);
    const redis = createRedisClient();
    const limiter = new DcrRateLimiter(
      redis,
      getRedisPrefix(),
      DCR_RATE_LIMIT_REQUESTS,
      DCR_RATE_LIMIT_WINDOW_SECONDS
    );

    const isAllowed = await limiter.checkLimit(clientIp);
    if (!isAllowed) {
      console.warn('[register POST] Rate limit exceeded:', { clientIp });
      return jsonCors(
        {
          error: 'rate_limited',
          error_description: `Rate limit exceeded: maximum ${DCR_RATE_LIMIT_REQUESTS} registrations per ${DCR_RATE_LIMIT_WINDOW_SECONDS / 60} minutes per IP`,
        },
        { status: 429 }
      );
    }

    // Parse request body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonCors(
        {
          error: 'invalid_redirect_uri',
          error_description: 'Request body must be valid JSON',
        },
        { status: 400 }
      );
    }

    const bodyObj = body as Record<string, unknown>;

    // Validate redirect_uris field
    const redirectUris = bodyObj.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      return jsonCors(
        {
          error: 'invalid_redirect_uri',
          error_description: 'redirect_uris must be a non-empty array',
        },
        { status: 400 }
      );
    }

    // Validate each URI is a string
    if (!redirectUris.every((uri): uri is string => typeof uri === 'string')) {
      return jsonCors(
        {
          error: 'invalid_redirect_uri',
          error_description: 'All redirect_uris must be strings',
        },
        { status: 400 }
      );
    }

    if (redirectUris.length > MAX_REDIRECT_URIS) {
      return jsonCors(
        {
          error: 'invalid_redirect_uri',
          error_description: `A client may register at most ${MAX_REDIRECT_URIS} redirect_uris`,
        },
        { status: 400 }
      );
    }

    // Guard each redirect_uri (with optional allowlist from env var)
    const allowList = process.env.OAUTH_REDIRECT_URI_ALLOWLIST;
    for (const uri of redirectUris) {
      if (!isAllowedRedirectUri(uri, allowList)) {
        return jsonCors(
          {
            error: 'invalid_redirect_uri',
            error_description: 'One or more redirect_uris are invalid or disallowed (must be HTTPS, or HTTP only for loopback, no fragments or credentials)',
          },
          { status: 400 }
        );
      }
    }

    const clientName = typeof bodyObj.client_name === 'string' ? bodyObj.client_name : undefined;
    const registration = await app.transactionStore.registerClient([...new Set(redirectUris)], clientName);

    console.log('[register POST] Registered connector:', {
      clientId: registration.clientId,
      redirectUris: registration.redirectUris,
      clientName,
    });

    // Return RFC 7591 registration response (201)
    return jsonCors(
      {
        client_id: registration.clientId,
        client_name: clientName ?? 'Rock MCP',
        redirect_uris: registration.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      { status: 201 }
    );
  } catch (err) {
    console.error('[register POST] Registration failed:', {
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonCors(
      {
        error: 'server_error',
      },
      { status: 500 }
    );
  }
}
