import * as crypto from 'crypto';
import * as jose from 'jose';
import type { Request, RequestHandler } from 'express';
import type { OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

export { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
export {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';

export interface OAuthRockContext {
  endpoint: 'mcp' | 'readonly' | 'readwrite';
  mode: 'readonly' | 'readwrite';
  scopes: Set<'read' | 'write'>;
  rockUserToken?: string;
  oauth: {
    subject: string;
    email?: string;
    name?: string;
    accessTokenHash: string;
    issuer?: string;
  };
  rockUser: {
    personId?: number;
    personGuid?: string;
    personAliasId?: number;
    userLoginId?: number;
    userName?: string;
    isRsrAdmin: boolean;
  };
  request: {
    sessionId: string;
    requestId: string;
    ip?: string;
    userAgent?: string;
  };
}

// Extend Request type to include our oauthContext
declare global {
  namespace Express {
    interface Request {
      oauthContext?: OAuthRockContext;
    }
  }
}

export interface VerifyTokenOptions {
  verifyToken?: (token: string) => Promise<{ isValid: boolean; payload?: any; error?: string }>;
}

export interface Auth0OAuthConfig {
  issuer: string;
  audience: string;
  resourceServerUrl: URL;
  discoveryUrl: URL;
}

export type Auth0OAuthMetadata = OAuthMetadata & {
  jwks_uri: string;
  registration_endpoint: string;
};

export type OAuthEnv = Record<string, string | undefined>;

export interface FetchAuth0OAuthMetadataOptions {
  config?: Auth0OAuthConfig;
  fetchFn?: (url: URL) => Promise<Response>;
}

export interface Auth0OAuthTokenVerifierDeps {
  jwksUri?: string | URL;
  createRemoteJWKSet?: (jwksUri: URL) => unknown;
  jwtVerify?: (
    token: string,
    jwks: unknown,
    options: { issuer: string; audience: string }
  ) => Promise<{ payload: jose.JWTPayload }>;
}

const AUTH0_ISSUER_KEYS = ['AUTH0_ISSUER', 'AUTH0_DOMAIN', 'OAUTH_ISSUER', 'OAUTH_DOMAIN'];
const AUTH0_AUDIENCE_KEYS = ['AUTH0_AUDIENCE', 'OAUTH_AUDIENCE'];
const MCP_PUBLIC_URL_KEYS = ['MCP_PUBLIC_URL', 'OAUTH_PUBLIC_URL', 'OAUTH_RESOURCE_SERVER_URL'];

export function loadAuth0Config(env: OAuthEnv = process.env): Auth0OAuthConfig {
  const issuerOrDomain = firstEnvValue(env, AUTH0_ISSUER_KEYS);
  if (!issuerOrDomain) {
    throw new Error('AUTH0_DOMAIN or AUTH0_ISSUER env var is required');
  }

  const audience = firstEnvValue(env, AUTH0_AUDIENCE_KEYS);
  if (!audience) {
    throw new Error('AUTH0_AUDIENCE env var is required');
  }

  const resourceServerUrlValue = firstEnvValue(env, MCP_PUBLIC_URL_KEYS);
  if (!resourceServerUrlValue) {
    throw new Error('MCP_PUBLIC_URL env var is required');
  }

  const issuer = normalizeIssuer(issuerOrDomain);

  return {
    issuer,
    audience,
    resourceServerUrl: parseUrl(resourceServerUrlValue, 'MCP_PUBLIC_URL'),
    discoveryUrl: new URL('.well-known/openid-configuration', issuer),
  };
}

export async function fetchAuth0OAuthMetadata(
  options: FetchAuth0OAuthMetadataOptions = {}
): Promise<Auth0OAuthMetadata> {
  const config = options.config || loadAuth0Config();
  const fetchFn = options.fetchFn || ((url: URL) => fetch(url));
  const response = await fetchFn(config.discoveryUrl);

  if (!response.ok) {
    throw new Error(`Failed to fetch Auth0 discovery metadata: ${response.status} ${response.statusText}`);
  }

  const metadata = await response.json() as Record<string, unknown>;
  const registrationEndpoint = stringClaim(metadata.registration_endpoint);
  if (!registrationEndpoint) {
    throw new Error('Auth0 Dynamic Client Registration endpoint is missing; enable DCR on the Auth0 tenant');
  }

  const jwksUri = stringClaim(metadata.jwks_uri);
  if (!jwksUri) {
    throw new Error('Auth0 discovery metadata is missing jwks_uri');
  }

  return {
    ...metadata,
    registration_endpoint: registrationEndpoint,
    jwks_uri: jwksUri,
  } as Auth0OAuthMetadata;
}

export class Auth0OAuthTokenVerifier implements OAuthTokenVerifier {
  private jwks: unknown;
  private jwtVerify: NonNullable<Auth0OAuthTokenVerifierDeps['jwtVerify']>;

  constructor(
    private config: Auth0OAuthConfig,
    deps: Auth0OAuthTokenVerifierDeps = {}
  ) {
    const jwksUri = deps.jwksUri ? new URL(deps.jwksUri) : new URL('.well-known/jwks.json', config.issuer);
    const createRemoteJWKSet = deps.createRemoteJWKSet || ((url: URL) => jose.createRemoteJWKSet(url));
    this.jwks = createRemoteJWKSet(jwksUri);
    this.jwtVerify = deps.jwtVerify || (async (token, jwks, options) => {
      const { payload } = await jose.jwtVerify(token, jwks as jose.JWTVerifyGetKey, options);
      return { payload };
    });
  }

  public async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const { payload } = await this.jwtVerify(token, this.jwks, {
        issuer: this.config.issuer,
        audience: this.config.audience,
      });
      const claims = payload as Record<string, unknown>;
      const clientId = stringClaim(claims.azp) || stringClaim(claims.client_id) || stringClaim(claims.sub) || '';

      return {
        token,
        clientId,
        scopes: extractScopes(claims),
        expiresAt: typeof claims.exp === 'number' ? claims.exp : undefined,
        extra: claims,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Invalid access token';
      throw new InvalidTokenError(message);
    }
  }
}

export function authInfoToOAuthRockContext(authInfo: AuthInfo, req: Request): OAuthRockContext {
  const claims = (authInfo.extra || {}) as Record<string, unknown>;
  const token = authInfo.token;
  const accessTokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const mcpScopes = new Set<'read' | 'write'>();
  if (authInfo.scopes.includes('read')) mcpScopes.add('read');
  if (authInfo.scopes.includes('write')) mcpScopes.add('write');

  const ctx: OAuthRockContext = {
    endpoint: 'mcp',
    mode: 'readonly',
    scopes: mcpScopes,
    oauth: {
      subject: stringClaim(claims.sub) || authInfo.clientId,
      email: stringClaim(claims.email),
      name: stringClaim(claims.name),
      accessTokenHash,
      issuer: stringClaim(claims.iss),
    },
    rockUser: {
      isRsrAdmin: false,
    },
    request: {
      sessionId: headerValue(req, 'x-mcp-session-id') || headerValue(req, 'x-session-id') || crypto.randomUUID(),
      requestId: headerValue(req, 'x-request-id') || crypto.randomUUID(),
      ip: req.ip || req.socket?.remoteAddress,
      userAgent: headerValue(req, 'user-agent'),
    },
  };

  attachRawToken(ctx, token);
  return ctx;
}

export function createOAuthContextAdapterMiddleware(): RequestHandler {
  return (req, res, next) => {
    const authInfo = (req as Request & { auth?: AuthInfo }).auth;
    if (!authInfo) {
      res.status(500).json({ error: 'OAuth auth info not initialized' });
      return;
    }

    req.oauthContext = authInfoToOAuthRockContext(authInfo, req);
    next();
  };
}

export function createAuthMiddleware(options: VerifyTokenOptions = {}) {
  const verifyToken = options.verifyToken || defaultVerifyToken;

  return async (req: any, res: any, next: any): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = authHeader.substring(7);
    try {
      const { isValid, payload, error } = await verifyToken(token);
      if (!isValid || !payload) {
        res.status(401).json({ error: error || 'Invalid token' });
        return;
      }

      // Check required read scope
      const scopeStr = payload.scope || '';
      const scopes = new Set<string>(scopeStr.split(/\s+/).filter(Boolean));
      if (!scopes.has('read')) {
        res.status(403).json({ error: 'Missing required read scope' });
        return;
      }

      const mcpScopes = new Set<'read' | 'write'>();
      if (scopes.has('read')) mcpScopes.add('read');
      if (scopes.has('write')) mcpScopes.add('write');

      // Create session ID and request ID
      const sessionId = req.headers['x-mcp-session-id'] as string || crypto.randomUUID();
      const requestId = crypto.randomUUID();
      const ip = req.ip || req.socket.remoteAddress;
      const userAgent = req.headers['user-agent'];

      // Generate access token hash for audit metadata
      const accessTokenHash = crypto.createHash('sha256').update(token).digest('hex');

      // Build context
      req.oauthContext = {
        endpoint: 'mcp', // default, resolved later
        mode: 'readonly', // default, resolved later
        scopes: mcpScopes,
        oauth: {
          subject: payload.sub || '',
          email: payload.email,
          name: payload.name,
          accessTokenHash,
          issuer: payload.iss,
        },
        rockUser: {
          isRsrAdmin: false, // default, resolved later
        },
        request: {
          sessionId,
          requestId,
          ip,
          userAgent,
        },
      };
      attachRawToken(req.oauthContext, token);

      next();
    } catch (err: any) {
      res.status(401).json({ error: err.message || 'Authentication failed' });
    }
  };
}

async function defaultVerifyToken(token: string) {
  const jwksUrl = process.env.OAUTH_JWKS_URL;
  const issuer = process.env.OAUTH_ISSUER;
  const audience = process.env.OAUTH_AUDIENCE;

  if (!jwksUrl) {
    // In local dev without config, decode but warn or allow in development
    if (process.env.NODE_ENV !== 'production') {
      const decoded = jose.decodeJwt(token);
      return { isValid: true, payload: decoded };
    }
    return { isValid: false, error: 'OAUTH_JWKS_URL env var is not configured' };
  }

  try {
    const JWKS = jose.createRemoteJWKSet(new URL(jwksUrl));
    const { payload } = await jose.jwtVerify(token, JWKS, {
      issuer,
      audience,
    });
    return { isValid: true, payload };
  } catch (err: any) {
    return { isValid: false, error: err.message };
  }
}

function firstEnvValue(env: OAuthEnv, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function normalizeIssuer(issuerOrDomain: string): string {
  const trimmed = issuerOrDomain.trim();
  const url = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`);
  url.search = '';
  url.hash = '';
  const normalized = url.toString();
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

function parseUrl(value: string, envName: string): URL {
  try {
    return new URL(value);
  } catch (_err) {
    throw new Error(`${envName} must be a valid absolute URL`);
  }
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function extractScopes(claims: Record<string, unknown>): string[] {
  const scopes = new Set<string>();
  const scope = claims.scope;
  if (typeof scope === 'string') {
    for (const item of scope.split(/\s+/).filter(Boolean)) {
      scopes.add(item);
    }
  }

  const permissions = claims.permissions;
  if (Array.isArray(permissions)) {
    for (const permission of permissions) {
      if (typeof permission === 'string' && permission.length > 0) {
        scopes.add(permission);
      }
    }
  }

  return [...scopes];
}

function headerValue(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function attachRawToken(ctx: OAuthRockContext, token: string): void {
  Object.defineProperty(ctx, 'rockUserToken', {
    value: token,
    enumerable: false,
    configurable: false,
  });
}
