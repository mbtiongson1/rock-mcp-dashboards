import { afterEach, describe, it, expect } from 'vitest';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { buildAppContext, resetAppContextForTests } from './app-context.js';
import { Auth0ManagementClient } from './auth0-management.js';
import type { Auth0OAuthConfig, Auth0OAuthMetadata } from './oauth.js';
import type { RockClient, RockClientConfig } from '../rock/client.js';
import { ApiKeyStrategy, UserJwtStrategy } from '../rock/auth-strategy.js';

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
  registration_endpoint: 'https://auth.example.com/oauth/register',
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

afterEach(() => {
  resetAppContextForTests();
});

describe('buildAppContext', () => {
  it('uses a UserJwtStrategy client and no admin client when ROCK_API_KEY is absent', async () => {
    const clientFactory = makeClientFactory();
    await buildAppContext({
      oauthConfig,
      oauthMetadata,
      verifier,
      env: {
        ROCK_PUBLIC_URL: 'https://rock.example.com',
        AUTH0_CLIENT_ID: 'test-shared-client',
        AUTH0_MANAGEMENT_CLIENT_ID: 'test-mgmt-client',
        AUTH0_MANAGEMENT_CLIENT_SECRET: 'test-mgmt-secret',
      },
      rockClientFactory: clientFactory.factory,
    });

    expect(clientFactory.configs).toHaveLength(1);
    expect(clientFactory.configs[0].credentialStrategy).toBeInstanceOf(UserJwtStrategy);
    expect(clientFactory.configs[0].apiKey).toBeUndefined();
  });

  it('creates a separate admin lookup client only when ROCK_API_KEY is configured', async () => {
    const clientFactory = makeClientFactory();
    await buildAppContext({
      oauthConfig,
      oauthMetadata,
      verifier,
      env: {
        ROCK_PUBLIC_URL: 'https://rock.example.com',
        ROCK_API_KEY: 'admin-key',
        AUTH0_CLIENT_ID: 'test-shared-client',
        AUTH0_MANAGEMENT_CLIENT_ID: 'test-mgmt-client',
        AUTH0_MANAGEMENT_CLIENT_SECRET: 'test-mgmt-secret',
      },
      rockClientFactory: clientFactory.factory,
    });

    expect(clientFactory.configs).toHaveLength(2);
    expect(clientFactory.configs[0].credentialStrategy).toBeInstanceOf(UserJwtStrategy);
    expect(clientFactory.configs[1].credentialStrategy).toBeInstanceOf(ApiKeyStrategy);
  });

  it('exposes the protected-resource metadata URL derived from the resource server URL', async () => {
    const ctx = await buildAppContext({
      oauthConfig,
      oauthMetadata,
      verifier,
      env: {
        ROCK_PUBLIC_URL: 'https://rock.example.com',
        AUTH0_CLIENT_ID: 'test-shared-client',
        AUTH0_MANAGEMENT_CLIENT_ID: 'test-mgmt-client',
        AUTH0_MANAGEMENT_CLIENT_SECRET: 'test-mgmt-secret',
      },
      rockClientFactory: makeClientFactory().factory,
    });

    expect(ctx.resourceMetadataUrl).toBe('https://mcp.example.com/.well-known/oauth-protected-resource');
    expect(ctx.oauthMetadata.issuer).toBe('https://auth.example.com/');
  });

  it('uses provided managementClient override when supplied', async () => {
    const mockManagementClient = new Auth0ManagementClient(
      oauthConfig,
      'mock-mgmt-client-id',
      'mock-mgmt-client-secret',
      'mock-shared-client-id'
    );

    const ctx = await buildAppContext({
      oauthConfig,
      oauthMetadata,
      verifier,
      env: {
        ROCK_PUBLIC_URL: 'https://rock.example.com',
        AUTH0_CLIENT_ID: 'test-shared-client',
        AUTH0_MANAGEMENT_CLIENT_ID: 'test-mgmt-client',
        AUTH0_MANAGEMENT_CLIENT_SECRET: 'test-mgmt-secret',
      },
      rockClientFactory: makeClientFactory().factory,
      managementClient: mockManagementClient,
    });

    expect(ctx.managementClient).toBe(mockManagementClient);
  });
});
