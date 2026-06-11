import { afterEach, describe, it, expect } from 'vitest';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { buildAppContext, resetAppContextForTests } from '../../src/http/app-context.js';
import { OAuthTransactionStore } from '../../src/http/oauth-transactions.js';
import type { Auth0OAuthConfig, Auth0OAuthMetadata } from '../../src/http/oauth.js';
import type { RockClient, RockClientConfig } from '../../src/rock/client.js';
import { UserJwtStrategy } from '../../src/rock/auth-strategy.js';

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
  jwks_uri: 'https://auth.example.com/.well-known/jwks.json',
  response_types_supported: ['code'],
  token_endpoint_auth_methods_supported: ['none'],
};

const verifier: OAuthTokenVerifier = {
  verifyAccessToken: async (token) => ({
    token,
    clientId: 'test-client',
    scopes: ['read', 'write'],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    extra: { sub: 'auth0|123' },
  }),
};

class FakeRockClient implements RockClient {
  async get<T>(): Promise<T> { return [] as T; }
  async post<T>(): Promise<T> { return [] as T; }
  async put<T>(): Promise<T> { return {} as T; }
  async patch<T>(): Promise<T> { return {} as T; }
  async delete<T>(): Promise<T> { return {} as T; }
}

function makeClientFactory() {
  const configs: RockClientConfig[] = [];
  return {
    configs,
    factory: (config: RockClientConfig): RockClient => {
      configs.push(config);
      return new FakeRockClient();
    },
  };
}

const baseEnv = {
  ROCK_PUBLIC_URL: 'https://rock.example.com',
  AUTH0_CLIENT_ID: 'test-proxy-client',
  AUTH0_CLIENT_SECRET: 'test-proxy-secret',
};

afterEach(() => {
  resetAppContextForTests();
});

describe('buildAppContext', () => {
  it('uses a single UserJwtStrategy client — there is no admin API-key client', async () => {
    const clientFactory = makeClientFactory();
    await buildAppContext({
      oauthConfig,
      oauthMetadata,
      verifier,
      env: baseEnv,
      rockClientFactory: clientFactory.factory,
    });

    expect(clientFactory.configs).toHaveLength(1);
    expect(clientFactory.configs[0].credentialStrategy).toBeInstanceOf(UserJwtStrategy);
    expect(clientFactory.configs[0].apiKey).toBeUndefined();
  });

  it('loads the OAuth proxy confidential client from AUTH0_CLIENT_ID/SECRET', async () => {
    const ctx = await buildAppContext({
      oauthConfig,
      oauthMetadata,
      verifier,
      env: baseEnv,
      rockClientFactory: makeClientFactory().factory,
    });

    expect(ctx.oauthProxyClient).toEqual({
      clientId: 'test-proxy-client',
      clientSecret: 'test-proxy-secret',
    });
    expect(ctx.transactionStore).toBeInstanceOf(OAuthTransactionStore);
  });

  it('throws when AUTH0_CLIENT_SECRET is missing', async () => {
    await expect(buildAppContext({
      oauthConfig,
      oauthMetadata,
      verifier,
      env: {
        ROCK_PUBLIC_URL: 'https://rock.example.com',
        AUTH0_CLIENT_ID: 'test-proxy-client',
      },
      rockClientFactory: makeClientFactory().factory,
    })).rejects.toThrow(/AUTH0_CLIENT_SECRET/);
  });

  it('exposes the protected-resource metadata URL derived from the resource server URL', async () => {
    const ctx = await buildAppContext({
      oauthConfig,
      oauthMetadata,
      verifier,
      env: baseEnv,
      rockClientFactory: makeClientFactory().factory,
    });

    expect(ctx.resourceMetadataUrl).toBe('https://mcp.example.com/.well-known/oauth-protected-resource');
    expect(ctx.oauthMetadata.issuer).toBe('https://auth.example.com/');
  });

  it('uses provided transactionStore override when supplied', async () => {
    const store = new OAuthTransactionStore(null, 'test:');
    const ctx = await buildAppContext({
      oauthConfig,
      oauthMetadata,
      verifier,
      env: baseEnv,
      rockClientFactory: makeClientFactory().factory,
      transactionStore: store,
    });

    expect(ctx.transactionStore).toBe(store);
  });
});
