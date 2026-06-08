import * as crypto from 'crypto';
import * as jose from 'jose';
import type { OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

export {
  getOAuthProtectedResourceMetadataUrl,
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

export interface Auth0OAuthConfig {
  issuer: string;
  audience: string;
  resourceServerUrl: URL;
  discoveryUrl: URL;
}

export interface Auth0ManagementConfig {
  clientId: string;
  clientSecret: string;
  sharedPublicClientId: string;
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
const AUTH0_CLIENT_ID_KEYS = ['AUTH0_CLIENT_ID'];
const AUTH0_MANAGEMENT_CLIENT_ID_KEYS = ['AUTH0_MANAGEMENT_CLIENT_ID'];
const AUTH0_MANAGEMENT_CLIENT_SECRET_KEYS = ['AUTH0_MANAGEMENT_CLIENT_SECRET'];

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
    resourceServerUrl: parseUrl(resourceServerUrlValue, 'MCP_PUBLIC_URL', {
      requireHttps: true,
      allowLoopbackHttp: true,
    }),
    discoveryUrl: new URL('.well-known/openid-configuration', issuer),
  };
}

export function loadAuth0ManagementConfig(env: OAuthEnv = process.env): Auth0ManagementConfig {
  const sharedPublicClientId = firstEnvValue(env, AUTH0_CLIENT_ID_KEYS);
  if (!sharedPublicClientId) {
    throw new Error('AUTH0_CLIENT_ID env var is required');
  }

  const clientId = firstEnvValue(env, AUTH0_MANAGEMENT_CLIENT_ID_KEYS);
  if (!clientId) {
    throw new Error('AUTH0_MANAGEMENT_CLIENT_ID env var is required');
  }

  const clientSecret = firstEnvValue(env, AUTH0_MANAGEMENT_CLIENT_SECRET_KEYS);
  if (!clientSecret) {
    throw new Error('AUTH0_MANAGEMENT_CLIENT_SECRET env var is required');
  }

  return {
    clientId,
    clientSecret,
    sharedPublicClientId,
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
  const issuer = stringClaim(metadata.issuer);
  if (!issuer) {
    throw new Error('Auth0 discovery metadata is missing issuer');
  }
  if (normalizeIssuer(issuer) !== config.issuer) {
    throw new Error(`Auth0 discovery metadata issuer mismatch: expected ${config.issuer}, got ${issuer}`);
  }

  const authorizationEndpoint = requireHttpsUrl(metadata.authorization_endpoint, 'authorization_endpoint');
  const tokenEndpoint = requireHttpsUrl(metadata.token_endpoint, 'token_endpoint');
  const registrationEndpoint = stringClaim(metadata.registration_endpoint);
  if (!registrationEndpoint) {
    throw new Error('Auth0 Dynamic Client Registration endpoint is missing; enable DCR on the Auth0 tenant');
  }
  requireHttpsUrl(registrationEndpoint, 'registration_endpoint');

  const jwksUri = stringClaim(metadata.jwks_uri);
  if (!jwksUri) {
    throw new Error('Auth0 discovery metadata is missing jwks_uri');
  }
  requireHttpsUrl(jwksUri, 'jwks_uri');

  return {
    ...metadata,
    issuer,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
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
    const jwksUri = deps.jwksUri
      ? parseUrl(deps.jwksUri.toString(), 'jwks_uri', { requireHttps: true })
      : new URL('.well-known/jwks.json', config.issuer);
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
      const subject = nonEmptyTrimmedClaim(claims.sub);
      if (!subject) {
        throw new InvalidTokenError('Access token subject (sub) is required');
      }
      const clientId = nonEmptyTrimmedClaim(claims.azp) || nonEmptyTrimmedClaim(claims.client_id) || subject;

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
  const subject = nonEmptyTrimmedClaim(claims.sub);
  if (!subject) {
    throw new Error('OAuth auth info subject (sub) is required');
  }

  const ctx: OAuthRockContext = {
    endpoint: 'mcp',
    mode: 'readonly',
    scopes: mcpScopes,
    oauth: {
      subject,
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
      ip: clientIpFromHeaders(req),
      userAgent: headerValue(req, 'user-agent'),
    },
  };

  attachRawToken(ctx, token);
  return ctx;
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
  const url = trimmed.includes('://')
    ? parseUrl(trimmed, 'AUTH0_ISSUER/AUTH0_DOMAIN', { requireHttps: true })
    : parseUrl(`https://${trimmed}`, 'AUTH0_ISSUER/AUTH0_DOMAIN', { requireHttps: true });
  url.search = '';
  url.hash = '';
  const normalized = url.toString();
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

function parseUrl(
  value: string,
  envName: string,
  options: { requireHttps?: boolean; allowLoopbackHttp?: boolean } = {}
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new Error(`${envName} must be a valid absolute URL`, { cause });
  }

  if (options.requireHttps) {
    assertAllowedUrlScheme(url, envName, options.allowLoopbackHttp === true);
  }

  return url;
}

function requireHttpsUrl(value: unknown, fieldName: string): string {
  const stringValue = typeof value === 'string' ? value : '';
  try {
    const url = new URL(stringValue);
    assertAllowedUrlScheme(url, `Auth0 discovery metadata ${fieldName}`, false);
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes(fieldName)) {
      throw cause;
    }
    throw new Error(`Auth0 discovery metadata ${fieldName} must be a valid absolute HTTPS URL`, { cause });
  }

  return stringValue;
}

function assertAllowedUrlScheme(url: URL, label: string, allowLoopbackHttp: boolean): void {
  if (url.protocol === 'https:') {
    return;
  }

  if (url.protocol === 'http:') {
    if (allowLoopbackHttp && isLoopbackHost(url.hostname)) {
      return;
    }

    if (allowLoopbackHttp) {
      throw new Error(`${label} must use HTTPS unless it points to localhost loopback over HTTP`);
    }

    throw new Error(`${label} must use HTTPS`);
  }

  throw new Error(`${label} has unsupported URL scheme: ${url.protocol}`);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nonEmptyTrimmedClaim(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
  const value = req.headers.get(name);
  return value === null ? undefined : value;
}

function clientIpFromHeaders(req: Request): string | undefined {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) {
      return first;
    }
  }
  return req.headers.get('x-real-ip') ?? undefined;
}

function attachRawToken(ctx: OAuthRockContext, token: string): void {
  Object.defineProperty(ctx, 'rockUserToken', {
    value: token,
    enumerable: false,
    configurable: false,
  });
}
