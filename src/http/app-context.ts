import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import {
  Auth0OAuthConfig,
  Auth0OAuthMetadata,
  Auth0OAuthTokenVerifier,
  fetchAuth0OAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
  loadAuth0Config,
  loadAuth0ManagementConfig,
  OAuthEnv,
} from './oauth.js';
import { Auth0ManagementClient } from './auth0-management.js';
import { RockClient, RockClientConfig, RockClientImpl } from '../rock/client.js';
import { ApiKeyStrategy, UserJwtStrategy } from '../rock/auth-strategy.js';
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
  managementClient?: Auth0ManagementClient;
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
  managementClient: Auth0ManagementClient;
  rockClient: RockClient;
  rockUserResolver: RockUserResolver;
  discoveryService: DiscoveryService;
  datasetStore: DatasetStore;
  redisConfigured: boolean;
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

  const adminApiKey = env.ROCK_API_KEY?.trim();
  const adminClient = adminApiKey
    ? createRockClient({
        baseUrl: rockBaseUrl,
        credentialStrategy: new ApiKeyStrategy(adminApiKey),
      })
    : undefined;

  const redis = createRedisClient();

  const managementClient = options.managementClient || (() => {
    const mgmtCfg = loadAuth0ManagementConfig(env);
    return new Auth0ManagementClient(
      oauthConfig,
      mgmtCfg.clientId,
      mgmtCfg.clientSecret,
      mgmtCfg.sharedPublicClientId,
      { redis }
    );
  })();

  const discoveryService = new DiscoveryService(rockClient, redis);
  const rockUserResolver = new RockUserResolver(rockClient, adminClient);
  const datasetStore: DatasetStore = redis
    ? new RedisDatasetStore(redis)
    : new InMemoryDatasetStore();

  if (redis) {
    console.log('[Rock MCP] Using Redis cache for discovery and datasets');
  } else {
    console.log('[Rock MCP] Using in-memory cache (Redis not configured)');
  }

  return {
    oauthConfig,
    oauthMetadata,
    verifier,
    resourceMetadataUrl,
    managementClient,
    rockClient,
    rockUserResolver,
    discoveryService,
    datasetStore,
    redisConfigured: !!redis,
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
