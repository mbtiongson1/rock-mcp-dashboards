import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import {
  Auth0OAuthConfig,
  Auth0OAuthMetadata,
  Auth0OAuthTokenVerifier,
  fetchAuth0OAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
  loadAuth0Config,
  OAuthEnv,
} from './oauth.js';
import { loadOAuthProxyClientConfig, OAuthProxyClientConfig } from './oauth-proxy.js';
import { OAuthTransactionStore } from './oauth-transactions.js';
import { RockClient, RockClientConfig, RockClientImpl } from '../rock/client.js';
import { UserJwtStrategy } from '../rock/auth-strategy.js';
import { RockUserResolver } from '../auth/rock-user-resolver.js';
import { DiscoveryService } from '../discovery/discovery-service.js';
import { InMemoryDatasetStore, RedisDatasetStore, DatasetStore } from '../tools/dataset-store.js';
import { createRedisClient } from '../rock/redis.js';

/**
 * Dependency overrides for tests. Mirrors the old Express `CreateAppOptions`.
 */
export interface CreateAppContextOptions {
  env?: OAuthEnv;
  oauthConfig?: Auth0OAuthConfig;
  oauthMetadata?: Auth0OAuthMetadata;
  verifier?: OAuthTokenVerifier;
  fetchFn?: (url: URL) => Promise<Response>;
  rockClientFactory?: (config: RockClientConfig) => RockClient;
  oauthProxyClient?: OAuthProxyClientConfig;
  transactionStore?: OAuthTransactionStore;
  rockUserResolver?: RockUserResolver;
}

/**
 * Fully-initialized application dependencies shared across HTTP route handlers.
 * In Express these lived as closures inside `createApp()`; in Next.js they are
 * built once per serverless instance and cached.
 */
export interface AppContext {
  oauthConfig: Auth0OAuthConfig;
  oauthMetadata: Auth0OAuthMetadata;
  verifier: OAuthTokenVerifier;
  resourceMetadataUrl: string;
  /** Auth0 confidential client used by the OAuth proxy (AUTH0_CLIENT_ID/SECRET). */
  oauthProxyClient: OAuthProxyClientConfig;
  /** Redis-backed connector registrations + authorize/code transactions. */
  transactionStore: OAuthTransactionStore;
  rockClient: RockClient;
  rockUserResolver: RockUserResolver;
  discoveryService: DiscoveryService;
  datasetStore: DatasetStore;
  redisConfigured: boolean;
  /** Base URL of the default Rock server (ROCK_PUBLIC_URL / ROCK_API_URL). */
  rockBaseUrl: string;
  /**
   * Returns a RockClient bound to an alternate Rock base URL (per-request
   * `?server=` override). Clients are cached per base URL. Callers must
   * validate the URL via resolveServerOverride first.
   */
  rockClientForBase(baseUrl: string): RockClient;
}

export async function buildAppContext(options: CreateAppContextOptions = {}): Promise<AppContext> {
  const env = options.env || process.env;
  const oauthConfig = options.oauthConfig || loadAuth0Config(env);
  const oauthMetadata = options.oauthMetadata || await fetchAuth0OAuthMetadata({
    config: oauthConfig,
    fetchFn: options.fetchFn,
  });
  const verifier = options.verifier || new Auth0OAuthTokenVerifier(oauthConfig, {
    jwksUri: oauthMetadata.jwks_uri,
  });
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(oauthConfig.resourceServerUrl);
  const createRockClient = options.rockClientFactory || ((config: RockClientConfig) => new RockClientImpl(config));

  const rockBaseUrl = env.ROCK_PUBLIC_URL || env.ROCK_API_URL || '';
  const rockClient = createRockClient({
    baseUrl: rockBaseUrl,
    credentialStrategy: new UserJwtStrategy(),
  });

  const redis = createRedisClient();

  const oauthProxyClient = options.oauthProxyClient || loadOAuthProxyClientConfig(env);
  const transactionStore = options.transactionStore || new OAuthTransactionStore(redis);

  const discoveryService = new DiscoveryService(rockClient, redis);
  const rockUserResolver = options.rockUserResolver ?? new RockUserResolver(rockClient);
  const datasetStore: DatasetStore = redis
    ? new RedisDatasetStore(redis)
    : new InMemoryDatasetStore();

  if (redis) {
    console.log('[Rock MCP] Using Redis cache for discovery and datasets');
  } else {
    console.log('[Rock MCP] Using in-memory cache (Redis not configured)');
  }

  const scopedClients = new Map<string, RockClient>([[rockBaseUrl, rockClient]]);
  const rockClientForBase = (baseUrl: string): RockClient => {
    let client = scopedClients.get(baseUrl);
    if (!client) {
      client = createRockClient({
        baseUrl,
        credentialStrategy: new UserJwtStrategy(),
      });
      scopedClients.set(baseUrl, client);
    }
    return client;
  };

  return {
    oauthConfig,
    oauthMetadata,
    verifier,
    resourceMetadataUrl,
    oauthProxyClient,
    transactionStore,
    rockClient,
    rockUserResolver,
    discoveryService,
    datasetStore,
    redisConfigured: !!redis,
    rockBaseUrl,
    rockClientForBase,
  };
}

let cached: Promise<AppContext> | undefined;

/**
 * Returns the cached AppContext, building it on first call. Pass options only
 * in tests (any options bypass and replace the cache for deterministic setup).
 */
export function getAppContext(options?: CreateAppContextOptions): Promise<AppContext> {
  if (options) {
    cached = buildAppContext(options);
    return cached;
  }
  if (!cached) {
    cached = buildAppContext();
  }
  return cached;
}

/** Clears the cached context. For tests only. */
export function resetAppContextForTests(): void {
  cached = undefined;
}
