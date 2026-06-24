import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import {
  InsufficientScopeError,
  InvalidTokenError,
  OAuthError,
  ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { authInfoToOAuthRockContext, OAuthRockContext, OAuthEnv } from './oauth.js';

/**
 * CORS headers matching the old Express `cors()` configuration so web-based MCP
 * clients can call the endpoints and read the auth/session response headers.
 *
 * Note: `Access-Control-Allow-Origin` here is the default permissive value used
 * when no allowlist is configured. When `OAUTH_ALLOWED_ORIGINS` is set, the ACAO
 * header is computed per-request instead (see {@link resolveAllowOrigin}).
 */
export const MCP_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, mcp-protocol-version, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};

/**
 * Read the comma-separated `OAUTH_ALLOWED_ORIGINS` env var into a list of
 * normalized origins. Returns an empty array when unset/blank, which preserves
 * the legacy permissive (`*`) behavior.
 */
function getAllowedOrigins(env: OAuthEnv = process.env): string[] {
  const raw = env.OAUTH_ALLOWED_ORIGINS?.trim();
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Resolve the CORS Access-Control-Allow-Origin / Vary headers for a request.
 *
 * - No allowlist configured (env unset/blank): permissive `*`, no Vary. This
 *   preserves the original behavior for local dev and existing clients.
 * - Allowlist configured + request Origin matches: reflect that origin and set
 *   `Vary: Origin`.
 * - Allowlist configured + Origin missing or not matching: fall back to the
 *   first allowlisted origin (still set `Vary: Origin`), so a concrete,
 *   non-permissive origin is always advertised.
 */
export function resolveAllowOrigin(
  requestOrigin?: string,
  env: OAuthEnv = process.env
): { allowOrigin: string; vary: boolean } {
  const allowed = getAllowedOrigins(env);
  if (allowed.length === 0) {
    return { allowOrigin: '*', vary: false };
  }
  // Return the matching entry from the configured allowlist rather than echoing
  // the request's Origin header back verbatim. The value is identical, but its
  // provenance is the trusted env config — this breaks the request-header →
  // Access-Control-Allow-Origin taint flow that CodeQL flags as a permissive
  // CORS misconfiguration (js/cors-permissive-configuration).
  const match = requestOrigin ? allowed.find((origin) => origin === requestOrigin) : undefined;
  if (match) {
    return { allowOrigin: match, vary: true };
  }
  return { allowOrigin: allowed[0], vary: true };
}

/** Apply the resolved CORS origin headers onto a Headers object. */
function applyCorsHeaders(headers: Headers, requestOrigin?: string, overwrite = true): void {
  for (const [key, value] of Object.entries(MCP_CORS_HEADERS)) {
    if (key === 'Access-Control-Allow-Origin') {
      continue;
    }
    if (overwrite || !headers.has(key)) {
      headers.set(key, value);
    }
  }

  const { allowOrigin, vary } = resolveAllowOrigin(requestOrigin);
  if (overwrite || !headers.has('Access-Control-Allow-Origin')) {
    headers.set('Access-Control-Allow-Origin', allowOrigin);
  }
  if (vary) {
    const existingVary = headers.get('Vary');
    if (!existingVary) {
      headers.set('Vary', 'Origin');
    } else if (!existingVary.split(',').map((v) => v.trim().toLowerCase()).includes('origin')) {
      headers.set('Vary', `${existingVary}, Origin`);
    }
  }
}

/**
 * Build a JSON Response with CORS headers.
 *
 * @param requestOrigin the request's `Origin` header. When `OAUTH_ALLOWED_ORIGINS`
 *   is configured this is used to decide whether to reflect the origin; when the
 *   allowlist is unset the response stays permissive (`*`) regardless.
 */
export function jsonCors(body: unknown, init: ResponseInit = {}, requestOrigin?: string): Response {
  const headers = new Headers(init.headers);
  applyCorsHeaders(headers, requestOrigin, true);
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(body), { ...init, headers });
}

/** Merge the MCP CORS headers into an existing Response, returning a new Response. */
export function withCors(response: Response, requestOrigin?: string): Response {
  const headers = new Headers(response.headers);
  applyCorsHeaders(headers, requestOrigin, false);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export interface ValidateOAuthContextOptions {
  verifier: OAuthTokenVerifier;
  resourceMetadataUrl: string;
  requiredScopes?: string[];
}

export type ValidateOAuthContextResult =
  | { ctx: OAuthRockContext; response?: undefined }
  | { ctx?: undefined; response: Response };

/**
 * Fetch-native replacement for the Express `requireBearerAuth` +
 * `createOAuthContextAdapterMiddleware` chain. Validates the Bearer token and
 * either returns the resolved {@link OAuthRockContext} or a challenge Response.
 */
export async function validateOAuthContext(
  request: Request,
  options: ValidateOAuthContextOptions
): Promise<ValidateOAuthContextResult> {
  const { verifier, resourceMetadataUrl, requiredScopes = [] } = options;
  const requestOrigin = request.headers.get('origin') ?? undefined;

  const buildWwwAuthHeader = (errorCode: string, message: string): string => {
    let header = `Bearer error="${errorCode}", error_description="${message}"`;
    if (requiredScopes.length > 0) {
      header += `, scope="${requiredScopes.join(' ')}"`;
    }
    if (resourceMetadataUrl) {
      header += `, resource_metadata="${resourceMetadataUrl}"`;
    }
    return header;
  };

  try {
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      throw new InvalidTokenError('Missing Authorization header');
    }
    const [type, token] = authHeader.split(' ');
    if (type.toLowerCase() !== 'bearer' || !token) {
      throw new InvalidTokenError("Invalid Authorization header format, expected 'Bearer TOKEN'");
    }

    const authInfo = await verifier.verifyAccessToken(token);

    if (requiredScopes.length > 0) {
      const hasAllScopes = requiredScopes.every((scope) => authInfo.scopes.includes(scope));
      if (!hasAllScopes) {
        throw new InsufficientScopeError('Insufficient scope');
      }
    }

    if (typeof authInfo.expiresAt !== 'number' || isNaN(authInfo.expiresAt)) {
      throw new InvalidTokenError('Token has no expiration time');
    }
    if (authInfo.expiresAt < Date.now() / 1000) {
      throw new InvalidTokenError('Token has expired');
    }

    const ctx = authInfoToOAuthRockContext(authInfo, request);
    return { ctx };
  } catch (error) {
    if (error instanceof InvalidTokenError) {
      return {
        response: jsonCors(error.toResponseObject(), {
          status: 401,
          headers: { 'WWW-Authenticate': buildWwwAuthHeader(error.errorCode, error.message) },
        }, requestOrigin),
      };
    }
    if (error instanceof InsufficientScopeError) {
      return {
        response: jsonCors(error.toResponseObject(), {
          status: 403,
          headers: { 'WWW-Authenticate': buildWwwAuthHeader(error.errorCode, error.message) },
        }, requestOrigin),
      };
    }
    if (error instanceof ServerError) {
      return { response: jsonCors(error.toResponseObject(), { status: 500 }, requestOrigin) };
    }
    if (error instanceof OAuthError) {
      return { response: jsonCors(error.toResponseObject(), { status: 400 }, requestOrigin) };
    }
    const serverError = new ServerError('Internal Server Error');
    return { response: jsonCors(serverError.toResponseObject(), { status: 500 }, requestOrigin) };
  }
}
