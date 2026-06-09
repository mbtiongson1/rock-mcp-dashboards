import { describe, it, expect, vi } from 'vitest';
import type { Auth0OAuthConfig } from './oauth.js';
import { Auth0ManagementClient } from './auth0-management.js';

describe('Auth0ManagementClient', () => {
  const baseConfig: Auth0OAuthConfig = {
    issuer: 'https://favorchurch.au.auth0.com/',
    audience: 'https://rock.example.com/api',
    resourceServerUrl: new URL('https://mcp.example.com/mcp'),
    discoveryUrl: new URL('https://favorchurch.au.auth0.com/.well-known/openid-configuration'),
  };

  function makeInMemoryRedis() {
    const data = new Map<string, string>();
    const ttls = new Map<string, number>();
    return {
      get: vi.fn(async (key: string) => data.get(key) ?? null),
      set: vi.fn(async (key: string, value: string, opts?: { ex?: number }) => {
        data.set(key, value);
        if (opts?.ex) {
          ttls.set(key, opts.ex);
        }
      }),
      del: vi.fn(async (key: string) => {
        data.delete(key);
        ttls.delete(key);
      }),
      _data: data,
      _ttls: ttls,
    };
  }

  describe('token minting and caching', () => {
    it('mints a token on first call and uses it for getClient', async () => {
      const fetchFn = vi.fn(async (url: string) => {
        if (url.includes('/oauth/token')) {
          return new Response(JSON.stringify({
            access_token: 'test-mgmt-token',
            expires_in: 86400,
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/api/v2/clients/')) {
          return new Response(JSON.stringify({
            client_id: 'shared-client-id',
            callbacks: ['https://example.com/callback'],
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const client = new Auth0ManagementClient(
        baseConfig,
        'mgmt-client-id',
        'mgmt-client-secret',
        'shared-client-id',
        { fetchFn }
      );

      const result = await client.getClient();

      expect(result).toEqual({
        client_id: 'shared-client-id',
        callbacks: ['https://example.com/callback'],
      });
      expect(fetchFn).toHaveBeenCalledWith(
        'https://favorchurch.au.auth0.com/oauth/token',
        expect.objectContaining({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'client_credentials',
            client_id: 'mgmt-client-id',
            client_secret: 'mgmt-client-secret',
            audience: 'https://favorchurch.au.auth0.com/api/v2/',
          }),
        })
      );
    });

    it('caches token in redis and reuses it on second call', async () => {
      const redis = makeInMemoryRedis();
      let tokenCallCount = 0;

      const fetchFn = vi.fn(async (url: string) => {
        if (url.includes('/oauth/token')) {
          tokenCallCount++;
          return new Response(JSON.stringify({
            access_token: `test-token-${tokenCallCount}`,
            expires_in: 3600,
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/api/v2/clients/')) {
          return new Response(JSON.stringify({
            client_id: 'shared-client-id',
            callbacks: [],
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const client = new Auth0ManagementClient(
        baseConfig,
        'mgmt-client-id',
        'mgmt-client-secret',
        'shared-client-id',
        { fetchFn, redis: redis as any }
      );

      await client.getClient();
      await client.getClient();

      expect(tokenCallCount).toBe(1);
      expect(redis.set).toHaveBeenCalled();
      expect(redis.get).toHaveBeenCalled();
    });

    it('handles redis.get returning an object (auto-deserialized)', async () => {
      const redis = makeInMemoryRedis();

      // Simulate Upstash returning a parsed object instead of a string
      (redis.get as any).mockResolvedValueOnce({
        access_token: 'cached-token',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });

      const fetchFn = vi.fn(async (url: string) => {
        if (url.includes('/api/v2/clients/')) {
          return new Response(JSON.stringify({
            client_id: 'shared-client-id',
            callbacks: [],
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const client = new Auth0ManagementClient(
        baseConfig,
        'mgmt-client-id',
        'mgmt-client-secret',
        'shared-client-id',
        { fetchFn, redis: redis as any }
      );

      await client.getClient();

      // Should use cached token without calling token endpoint
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(fetchFn).toHaveBeenCalledWith(
        expect.stringContaining('/api/v2/clients/'),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer cached-token',
          }),
        })
      );
    });

    it('refreshes token when expires_at is in the past', async () => {
      const now = 1000;
      let tokenCallCount = 0;

      const redis = makeInMemoryRedis();
      // Simulate expired token in cache
      (redis.get as any).mockResolvedValueOnce({
        access_token: 'expired-token',
        expires_at: now - 100, // expired
      });

      const fetchFn = vi.fn(async (url: string) => {
        if (url.includes('/oauth/token')) {
          tokenCallCount++;
          return new Response(JSON.stringify({
            access_token: `fresh-token-${tokenCallCount}`,
            expires_in: 3600,
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/api/v2/clients/')) {
          return new Response(JSON.stringify({
            client_id: 'shared-client-id',
            callbacks: [],
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const client = new Auth0ManagementClient(
        baseConfig,
        'mgmt-client-id',
        'mgmt-client-secret',
        'shared-client-id',
        {
          fetchFn,
          redis: redis as any,
          now: () => now * 1000, // convert to ms
        }
      );

      await client.getClient();

      expect(tokenCallCount).toBe(1);
      expect(fetchFn).toHaveBeenCalledWith(
        expect.stringContaining('/api/v2/clients/'),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer fresh-token-1',
          }),
        })
      );
    });

    it('uses in-memory fallback when redis is null', async () => {
      const now = 1000;
      let tokenCallCount = 0;

      const fetchFn = vi.fn(async (url: string) => {
        if (url.includes('/oauth/token')) {
          tokenCallCount++;
          return new Response(JSON.stringify({
            access_token: `in-mem-token-${tokenCallCount}`,
            expires_in: 3600,
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/api/v2/clients/')) {
          return new Response(JSON.stringify({
            client_id: 'shared-client-id',
            callbacks: [],
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const client = new Auth0ManagementClient(
        baseConfig,
        'mgmt-client-id',
        'mgmt-client-secret',
        'shared-client-id',
        { fetchFn, redis: null, now: () => now * 1000 }
      );

      await client.getClient();
      await client.getClient();

      expect(tokenCallCount).toBe(1);
    });

    it('refreshes token 30 seconds early', async () => {
      let tokenCallCount = 0;
      let nowMs = 1000 * 1000;

      const fetchFn = vi.fn(async (url: string) => {
        if (url.includes('/oauth/token')) {
          tokenCallCount++;
          return new Response(JSON.stringify({
            access_token: `token-${tokenCallCount}`,
            expires_in: 100, // 100 seconds
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/api/v2/clients/')) {
          return new Response(JSON.stringify({
            client_id: 'shared-client-id',
            callbacks: [],
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const client = new Auth0ManagementClient(
        baseConfig,
        'mgmt-client-id',
        'mgmt-client-secret',
        'shared-client-id',
        {
          fetchFn,
          redis: null,
          now: () => nowMs,
        }
      );

      // First call mints token at 1000s with expires_in=100
      // expires_at = 1000 + 100 - 30 = 1070s (in ms: 1070000)
      await client.getClient();
      expect(tokenCallCount).toBe(1);

      // Move time forward to 1050s (still within validity)
      nowMs = 1050 * 1000;
      await client.getClient();
      expect(tokenCallCount).toBe(1); // no refresh yet

      // Move time forward to 1070s (at expires_at - 30)
      nowMs = 1070 * 1000;
      await client.getClient();
      expect(tokenCallCount).toBe(2); // refresh triggered
    });
  });

  describe('getClient', () => {
    it('returns client info with callbacks', async () => {
      const fetchFn = vi.fn(async (url: string) => {
        if (url.includes('/oauth/token')) {
          return new Response(JSON.stringify({
            access_token: 'token',
            expires_in: 3600,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('/api/v2/clients/shared-client-123')) {
          return new Response(JSON.stringify({
            client_id: 'shared-client-123',
            callbacks: ['https://example.com/cb1', 'https://example.com/cb2'],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const client = new Auth0ManagementClient(
        baseConfig,
        'mgmt-client-id',
        'mgmt-client-secret',
        'shared-client-123',
        { fetchFn }
      );

      const result = await client.getClient();

      expect(result).toEqual({
        client_id: 'shared-client-123',
        callbacks: ['https://example.com/cb1', 'https://example.com/cb2'],
      });
    });

    it('defaults callbacks to empty array if not present', async () => {
      const fetchFn = vi.fn(async (url: string) => {
        if (url.includes('/oauth/token')) {
          return new Response(JSON.stringify({
            access_token: 'token',
            expires_in: 3600,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('/api/v2/clients/')) {
          return new Response(JSON.stringify({
            client_id: 'shared-client-id',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const client = new Auth0ManagementClient(
        baseConfig,
        'mgmt-client-id',
        'mgmt-client-secret',
        'shared-client-id',
        { fetchFn }
      );

      const result = await client.getClient();

      expect(result.callbacks).toEqual([]);
    });

    it('URL-encodes the client_id in the API path', async () => {
      const fetchFn = vi.fn(async (url: string) => {
        if (url.includes('/oauth/token')) {
          return new Response(JSON.stringify({
            access_token: 'token',
            expires_in: 3600,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('/api/v2/clients/')) {
          expect(url).toContain(encodeURIComponent('client/with/slashes'));
          return new Response(JSON.stringify({
            client_id: 'client/with/slashes',
            callbacks: [],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const client = new Auth0ManagementClient(
        baseConfig,
        'mgmt-client-id',
        'mgmt-client-secret',
        'client/with/slashes',
        { fetchFn }
      );

      await client.getClient();

      expect(fetchFn).toHaveBeenCalledWith(
        expect.stringContaining(encodeURIComponent('client/with/slashes')),
        expect.any(Object)
      );
    });
  });

  describe('mergeCallbacks', () => {
    it('adds a new callback URI via PATCH', async () => {
      const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/oauth/token')) {
          return new Response(JSON.stringify({
            access_token: 'token',
            expires_in: 3600,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('/api/v2/clients/') && init?.method === 'GET') {
          return new Response(JSON.stringify({
            client_id: 'shared-client-id',
            callbacks: ['https://example.com/old'],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('/api/v2/clients/') && init?.method === 'PATCH') {
          const body = JSON.parse(init?.body as string);
          return new Response(JSON.stringify({
            client_id: 'shared-client-id',
            callbacks: body.callbacks,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`Unexpected URL/method: ${url} ${init?.method}`);
      });

      const client = new Auth0ManagementClient(
        baseConfig,
        'mgmt-client-id',
        'mgmt-client-secret',
        'shared-client-id',
        { fetchFn }
      );

      const result = await client.mergeCallbacks(['https://example.com/new']);

      expect(result).toEqual(['https://example.com/old', 'https://example.com/new']);
      expect(fetchFn).toHaveBeenCalledWith(
        expect.stringContaining('/api/v2/clients/'),
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({
            callbacks: ['https://example.com/old', 'https://example.com/new'],
          }),
        })
      );
    });

    it('is idempotent: skips PATCH if URI already present', async () => {
      const fetchFn = vi.fn(async (url: string) => {
        if (url.includes('/oauth/token')) {
          return new Response(JSON.stringify({
            access_token: 'token',
            expires_in: 3600,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('/api/v2/clients/')) {
          return new Response(JSON.stringify({
            client_id: 'shared-client-id',
            callbacks: ['https://example.com/existing'],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const client = new Auth0ManagementClient(
        baseConfig,
        'mgmt-client-id',
        'mgmt-client-secret',
        'shared-client-id',
        { fetchFn }
      );

      const result = await client.mergeCallbacks(['https://example.com/existing']);

      expect(result).toEqual(['https://example.com/existing']);
      // Should only be called twice: once for token, once for GET client
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(fetchFn).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: 'PATCH' })
      );
    });

    it('dedupes and preserves order: existing first, then new', async () => {
      const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/oauth/token')) {
          return new Response(JSON.stringify({
            access_token: 'token',
            expires_in: 3600,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('/api/v2/clients/') && init?.method === 'GET') {
          return new Response(JSON.stringify({
            client_id: 'shared-client-id',
            callbacks: ['https://example.com/a', 'https://example.com/b'],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('/api/v2/clients/') && init?.method === 'PATCH') {
          return new Response(JSON.stringify({
            client_id: 'shared-client-id',
            callbacks: JSON.parse(init?.body as string).callbacks,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`Unexpected URL/method: ${url} ${init?.method}`);
      });

      const client = new Auth0ManagementClient(
        baseConfig,
        'mgmt-client-id',
        'mgmt-client-secret',
        'shared-client-id',
        { fetchFn }
      );

      const result = await client.mergeCallbacks([
        'https://example.com/c',
        'https://example.com/b', // already present
        'https://example.com/d',
      ]);

      expect(result).toEqual([
        'https://example.com/a',
        'https://example.com/b',
        'https://example.com/c',
        'https://example.com/d',
      ]);
    });

    it('handles multiple new URIs', async () => {
      const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/oauth/token')) {
          return new Response(JSON.stringify({
            access_token: 'token',
            expires_in: 3600,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('/api/v2/clients/') && init?.method === 'GET') {
          return new Response(JSON.stringify({
            client_id: 'shared-client-id',
            callbacks: ['https://example.com/existing'],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('/api/v2/clients/') && init?.method === 'PATCH') {
          return new Response(JSON.stringify({
            client_id: 'shared-client-id',
            callbacks: JSON.parse(init?.body as string).callbacks,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`Unexpected URL/method: ${url} ${init?.method}`);
      });

      const client = new Auth0ManagementClient(
        baseConfig,
        'mgmt-client-id',
        'mgmt-client-secret',
        'shared-client-id',
        { fetchFn }
      );

      const result = await client.mergeCallbacks([
        'https://example.com/new1',
        'https://example.com/new2',
      ]);

      expect(result).toEqual([
        'https://example.com/existing',
        'https://example.com/new1',
        'https://example.com/new2',
      ]);
    });
  });

  describe('error handling', () => {
    it('throws on non-2xx token endpoint response with status in message', async () => {
      const fetchFn = vi.fn(async (url: string) => {
        if (url.includes('/oauth/token')) {
          return new Response(
            JSON.stringify({ error: 'invalid_client' }),
            { status: 401, statusText: 'Unauthorized', headers: { 'content-type': 'application/json' } }
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const client = new Auth0ManagementClient(
        baseConfig,
        'mgmt-client-id',
        'mgmt-client-secret',
        'shared-client-id',
        { fetchFn }
      );

      await expect(client.getClient()).rejects.toThrow(/401/);
      await expect(client.getClient()).rejects.toThrow(/oauth\/token/);
    });

    it('never includes client_secret in error messages', async () => {
      const fetchFn = vi.fn(async (url: string) => {
        if (url.includes('/oauth/token')) {
          return new Response(
            JSON.stringify({ error: 'invalid_client' }),
            { status: 401, statusText: 'Unauthorized', headers: { 'content-type': 'application/json' } }
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const client = new Auth0ManagementClient(
        baseConfig,
        'mgmt-client-id',
        'secret-secret-secret', // the secret
        'shared-client-id',
        { fetchFn }
      );

      try {
        await client.getClient();
      } catch (err) {
        const message = (err as Error).message;
        expect(message).not.toContain('secret-secret-secret');
      }
    });

    it('never includes access_token in error messages', async () => {
      const fetchFn = vi.fn(async (url: string) => {
        if (url.includes('/oauth/token')) {
          return new Response(JSON.stringify({
            access_token: 'super-secret-token',
            expires_in: 3600,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('/api/v2/clients/')) {
          return new Response(
            JSON.stringify({ error: 'forbidden' }),
            { status: 403, statusText: 'Forbidden', headers: { 'content-type': 'application/json' } }
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const client = new Auth0ManagementClient(
        baseConfig,
        'mgmt-client-id',
        'mgmt-client-secret',
        'shared-client-id',
        { fetchFn }
      );

      try {
        await client.getClient();
      } catch (err) {
        const message = (err as Error).message;
        expect(message).not.toContain('super-secret-token');
      }
    });

    it('throws on non-2xx getClient response', async () => {
      const fetchFn = vi.fn(async (url: string) => {
        if (url.includes('/oauth/token')) {
          return new Response(JSON.stringify({
            access_token: 'token',
            expires_in: 3600,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('/api/v2/clients/')) {
          return new Response(
            JSON.stringify({ error: 'not_found' }),
            { status: 404, statusText: 'Not Found', headers: { 'content-type': 'application/json' } }
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const client = new Auth0ManagementClient(
        baseConfig,
        'mgmt-client-id',
        'mgmt-client-secret',
        'shared-client-id',
        { fetchFn }
      );

      await expect(client.getClient()).rejects.toThrow(/404/);
    });

    it('throws on non-2xx PATCH response', async () => {
      const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/oauth/token')) {
          return new Response(JSON.stringify({
            access_token: 'token',
            expires_in: 3600,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('/api/v2/clients/') && init?.method === 'GET') {
          return new Response(JSON.stringify({
            client_id: 'shared-client-id',
            callbacks: ['https://example.com/old'],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('/api/v2/clients/') && init?.method === 'PATCH') {
          return new Response(
            JSON.stringify({ error: 'invalid_body' }),
            { status: 422, statusText: 'Unprocessable Entity', headers: { 'content-type': 'application/json' } }
          );
        }
        throw new Error(`Unexpected URL/method: ${url} ${init?.method}`);
      });

      const client = new Auth0ManagementClient(
        baseConfig,
        'mgmt-client-id',
        'mgmt-client-secret',
        'shared-client-id',
        { fetchFn }
      );

      await expect(client.mergeCallbacks(['https://example.com/new'])).rejects.toThrow(/422/);
    });
  });
});
