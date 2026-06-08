import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import {
  InsufficientScopeError,
  InvalidTokenError,
  OAuthError,
  ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { authInfoToOAuthRockContext, OAuthRockContext } from './oauth.js';

/**
 * CORS headers matching the old Express `cors()` configuration so web-based MCP
 * clients can call the endpoints and read the auth/session response headers.
 */
export const MCP_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, mcp-protocol-version, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};

/** Build a JSON Response with permissive CORS headers. */
export function jsonCors(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(MCP_CORS_HEADERS)) {
    headers.set(key, value);
  }
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(body), { ...init, headers });
}

/** Merge the MCP CORS headers into an existing Response, returning a new Response. */
export function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(MCP_CORS_HEADERS)) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }
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
        }),
      };
    }
    if (error instanceof InsufficientScopeError) {
      return {
        response: jsonCors(error.toResponseObject(), {
          status: 403,
          headers: { 'WWW-Authenticate': buildWwwAuthHeader(error.errorCode, error.message) },
        }),
      };
    }
    if (error instanceof ServerError) {
      return { response: jsonCors(error.toResponseObject(), { status: 500 }) };
    }
    if (error instanceof OAuthError) {
      return { response: jsonCors(error.toResponseObject(), { status: 400 }) };
    }
    const serverError = new ServerError('Internal Server Error');
    return { response: jsonCors(serverError.toResponseObject(), { status: 500 }) };
  }
}
