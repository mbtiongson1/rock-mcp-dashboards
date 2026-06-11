import type { Redis } from '@upstash/redis';
import type { Auth0OAuthConfig } from './oauth.js';
import { getRedisPrefix } from '../rock/redis.js';

export interface Auth0ManagementClientDeps {
  redis?: Redis | null;
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}

export interface Auth0ClientInfo {
  client_id: string;
  callbacks: string[];
}

export interface Auth0ClientOrigins {
  web_origins: string[];
  allowed_origins: string[];
}

/** Union of two string lists, preserving existing order then appending new, deduped. */
function unionPreserveOrder(existing: string[], additions: string[]): string[] {
  const seen = new Set(existing);
  const result = [...existing];
  for (const item of additions) {
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

interface CachedToken {
  access_token: string;
  expires_at: number;
}

/**
 * A minimal, dependency-injectable Auth0 Management API client.
 * Handles token minting with M2M credentials, caches tokens in Redis,
 * and provides methods to read and update the shared client's callbacks.
 */
export class Auth0ManagementClient {
  private fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
  private redis: Redis | null;
  private now: () => number;
  private redisPrefix: string;

  private inMemoryToken: CachedToken | null = null;

  constructor(
    private config: Auth0OAuthConfig,
    private managementClientId: string,
    private managementClientSecret: string,
    private sharedClientId: string,
    deps?: Auth0ManagementClientDeps
  ) {
    this.fetchFn = deps?.fetchFn ?? ((url: string, init?: RequestInit) => fetch(url, init));
    this.redis = deps?.redis ?? null;
    this.now = deps?.now ?? (() => Date.now());
    this.redisPrefix = getRedisPrefix();
  }

  /**
   * Mints or retrieves a cached M2M access token.
   * Caches in Redis (if available) with TTL, and keeps an in-memory copy as fallback.
   * Refreshes 30 seconds early to avoid expiry races.
   */
  private async getAccessToken(): Promise<string> {
    const nowSeconds = Math.floor(this.now() / 1000);

    // Check in-memory cache first
    if (
      this.inMemoryToken &&
      this.inMemoryToken.expires_at > nowSeconds
    ) {
      return this.inMemoryToken.access_token;
    }

    // Check Redis cache
    if (this.redis) {
      const cached = await this.redis.get(`${this.redisPrefix}oauth:management-token`);
      if (cached) {
        const token: CachedToken = typeof cached === 'string'
          ? JSON.parse(cached)
          : (cached as CachedToken);

        if (token.expires_at > nowSeconds) {
          this.inMemoryToken = token;
          return token.access_token;
        }
      }
    }

    // Mint a new token
    const tokenUrl = `${this.config.issuer}oauth/token`;
    const response = await this.fetchFn(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.managementClientId,
        client_secret: this.managementClientSecret,
        audience: `${this.config.issuer}api/v2/`,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to mint Auth0 M2M token: ${response.status} ${response.statusText} (${tokenUrl})`
      );
    }

    const data = await response.json() as Record<string, unknown>;
    const accessToken = typeof data.access_token === 'string' ? data.access_token : null;
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : null;

    if (!accessToken || !expiresIn) {
      throw new Error('Auth0 M2M token response missing access_token or expires_in');
    }

    const expiresAt = nowSeconds + expiresIn - 30; // refresh 30s early
    const cached: CachedToken = {
      access_token: accessToken,
      expires_at: expiresAt,
    };

    // Cache in Redis
    if (this.redis) {
      const ttlSeconds = Math.max(1, expiresAt - nowSeconds);
      await this.redis.set(
        `${this.redisPrefix}oauth:management-token`,
        JSON.stringify(cached),
        { ex: ttlSeconds }
      );
    }

    // Cache in memory
    this.inMemoryToken = cached;

    return accessToken;
  }

  /**
   * Fetches the shared client's current configuration from Auth0.
   * Returns client_id and callbacks array (defaults to [] if not present).
   */
  public async getClient(): Promise<Auth0ClientInfo> {
    const token = await this.getAccessToken();
    const url = `${this.config.issuer}api/v2/clients/${encodeURIComponent(
      this.sharedClientId
    )}?fields=client_id,callbacks&include_fields=true`;

    const response = await this.fetchFn(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch Auth0 client: ${response.status} ${response.statusText} (${url})`
      );
    }

    const data = await response.json() as Record<string, unknown>;

    return {
      client_id: typeof data.client_id === 'string' ? data.client_id : this.sharedClientId,
      callbacks: Array.isArray(data.callbacks) ? (data.callbacks as string[]) : [],
    };
  }

  /**
   * Merges new callback URIs into the shared client's allowed callbacks.
   * Dedupes and preserves order: existing callbacks first, then new ones.
   * Idempotent: if the new URIs are already present, skips the PATCH.
   * Returns the full set of callbacks after the merge.
   */
  public async mergeCallbacks(newUris: string[]): Promise<string[]> {
    const client = await this.getClient();
    const existing = new Set(client.callbacks);

    // Compute the union: existing order preserved, then new ones
    const union: string[] = [...client.callbacks];
    for (const uri of newUris) {
      if (!existing.has(uri)) {
        union.push(uri);
      }
    }

    // If nothing changed, skip the PATCH
    if (union.length === client.callbacks.length) {
      return union;
    }

    // PATCH the client with the new callbacks
    const token = await this.getAccessToken();
    const url = `${this.config.issuer}api/v2/clients/${encodeURIComponent(this.sharedClientId)}`;

    const response = await this.fetchFn(url, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ callbacks: union }),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to update Auth0 client callbacks: ${response.status} ${response.statusText} (${url})`
      );
    }

    return union;
  }

  /**
   * Merges new origins into the shared client's Allowed Web Origins
   * (`web_origins`) and Allowed Origins / CORS (`allowed_origins`).
   *
   * Used to auto-allow a connector's origin (e.g. https://claude.ai,
   * https://chatgpt.com) when it registers, so we don't have to hardcode a
   * list of known connectors. Dedupes, preserves order, and skips the PATCH
   * when nothing changes. Callers should treat this as best-effort: origin
   * acceptance is not required for the authorization-code flow to start, so a
   * failure here must not block registration.
   */
  public async mergeOrigins(newOrigins: string[]): Promise<Auth0ClientOrigins> {
    if (newOrigins.length === 0) {
      return { web_origins: [], allowed_origins: [] };
    }

    const token = await this.getAccessToken();
    const base = `${this.config.issuer}api/v2/clients/${encodeURIComponent(this.sharedClientId)}`;

    const getResponse = await this.fetchFn(
      `${base}?fields=web_origins,allowed_origins&include_fields=true`,
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } }
    );
    if (!getResponse.ok) {
      throw new Error(
        `Failed to fetch Auth0 client origins: ${getResponse.status} ${getResponse.statusText} (${base})`
      );
    }

    const data = await getResponse.json() as Record<string, unknown>;
    const currentWeb = Array.isArray(data.web_origins) ? (data.web_origins as string[]) : [];
    const currentAllowed = Array.isArray(data.allowed_origins) ? (data.allowed_origins as string[]) : [];

    const webOrigins = unionPreserveOrder(currentWeb, newOrigins);
    const allowedOrigins = unionPreserveOrder(currentAllowed, newOrigins);

    // Nothing new — skip the PATCH.
    if (webOrigins.length === currentWeb.length && allowedOrigins.length === currentAllowed.length) {
      return { web_origins: webOrigins, allowed_origins: allowedOrigins };
    }

    const patchResponse = await this.fetchFn(base, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ web_origins: webOrigins, allowed_origins: allowedOrigins }),
    });
    if (!patchResponse.ok) {
      throw new Error(
        `Failed to update Auth0 client origins: ${patchResponse.status} ${patchResponse.statusText} (${base})`
      );
    }

    return { web_origins: webOrigins, allowed_origins: allowedOrigins };
  }
}
