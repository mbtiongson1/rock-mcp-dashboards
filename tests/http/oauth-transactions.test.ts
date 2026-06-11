import { describe, it, expect, vi } from 'vitest';
import {
  OAuthTransactionStore,
  PROXY_CODE_TTL_SECONDS,
  TRANSACTION_TTL_SECONDS,
} from '../../src/http/oauth-transactions.js';

function memoryStore(): OAuthTransactionStore {
  return new OAuthTransactionStore(null, 'test:');
}

describe('OAuthTransactionStore (in-memory)', () => {
  it('registers a client with an opaque mcp_ id and retrieves it', async () => {
    const store = memoryStore();
    const registration = await store.registerClient(['https://a.example.com/cb'], 'Claude');

    expect(registration.clientId).toMatch(/^mcp_[A-Za-z0-9_-]+$/);
    const fetched = await store.getClient(registration.clientId);
    expect(fetched).toMatchObject({
      clientId: registration.clientId,
      redirectUris: ['https://a.example.com/cb'],
      clientName: 'Claude',
    });
  });

  it('returns null for unknown or malformed client ids', async () => {
    const store = memoryStore();
    expect(await store.getClient('mcp_nope')).toBeNull();
    expect(await store.getClient('not-a-proxy-id')).toBeNull();
    expect(await store.getClient('')).toBeNull();
  });

  it('consumes a pending transaction exactly once', async () => {
    const store = memoryStore();
    const state = await store.createTransaction({
      clientId: 'mcp_abc',
      redirectUri: 'https://a.example.com/cb',
      connectorState: 'xyz',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
    });

    const txn = await store.consumeTransaction(state);
    expect(txn).toMatchObject({ clientId: 'mcp_abc', connectorState: 'xyz' });

    expect(await store.consumeTransaction(state)).toBeNull();
  });

  it('expires transactions after the TTL', async () => {
    vi.useFakeTimers();
    try {
      const store = memoryStore();
      const state = await store.createTransaction({
        clientId: 'mcp_abc',
        redirectUri: 'https://a.example.com/cb',
        codeChallenge: 'challenge',
        codeChallengeMethod: 'S256',
      });

      vi.advanceTimersByTime((TRANSACTION_TTL_SECONDS + 1) * 1000);
      expect(await store.consumeTransaction(state)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('consumes a proxy code exactly once and expires it after the TTL', async () => {
    vi.useFakeTimers();
    try {
      const store = memoryStore();
      const record = {
        clientId: 'mcp_abc',
        redirectUri: 'https://a.example.com/cb',
        codeChallenge: 'challenge',
        codeChallengeMethod: 'S256' as const,
        tokenResponse: { access_token: 'tok' },
      };

      const replayCode = await store.createProxyCode(record);
      expect(await store.consumeProxyCode(replayCode)).toMatchObject({ clientId: 'mcp_abc' });
      expect(await store.consumeProxyCode(replayCode)).toBeNull();

      const expiredCode = await store.createProxyCode(record);
      vi.advanceTimersByTime((PROXY_CODE_TTL_SECONDS + 1) * 1000);
      expect(await store.consumeProxyCode(expiredCode)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('generates unique states and codes', async () => {
    const store = memoryStore();
    const txn = {
      clientId: 'mcp_abc',
      redirectUri: 'https://a.example.com/cb',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256' as const,
    };
    const states = await Promise.all([store.createTransaction(txn), store.createTransaction(txn)]);
    expect(states[0]).not.toBe(states[1]);
  });
});

describe('OAuthTransactionStore (redis)', () => {
  function mockRedis() {
    const data = new Map<string, string>();
    return {
      data,
      set: vi.fn(async (key: string, value: string) => { data.set(key, value); }),
      get: vi.fn(async (key: string) => data.get(key) ?? null),
      getdel: vi.fn(async (key: string) => {
        const value = data.get(key) ?? null;
        data.delete(key);
        return value;
      }),
    };
  }

  it('stores registrations and transactions through redis with key prefix', async () => {
    const redis = mockRedis();
    const store = new OAuthTransactionStore(redis as any, 'pfx:');

    const registration = await store.registerClient(['https://a.example.com/cb']);
    expect([...redis.data.keys()][0]).toBe(`pfx:oauth:client:${registration.clientId}`);
    expect(await store.getClient(registration.clientId)).toMatchObject({
      redirectUris: ['https://a.example.com/cb'],
    });
  });

  it('sets a TTL on transactions and codes', async () => {
    const redis = mockRedis();
    const store = new OAuthTransactionStore(redis as any, 'pfx:');

    await store.createTransaction({
      clientId: 'mcp_abc',
      redirectUri: 'https://a.example.com/cb',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
    });
    expect(redis.set).toHaveBeenLastCalledWith(expect.stringContaining('pfx:oauth:txn:'), expect.any(String), { ex: TRANSACTION_TTL_SECONDS });

    await store.createProxyCode({
      clientId: 'mcp_abc',
      redirectUri: 'https://a.example.com/cb',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      tokenResponse: { access_token: 'tok' },
    });
    expect(redis.set).toHaveBeenLastCalledWith(expect.stringContaining('pfx:oauth:code:'), expect.any(String), { ex: PROXY_CODE_TTL_SECONDS });
  });

  it('uses getdel for one-time consumption', async () => {
    const redis = mockRedis();
    const store = new OAuthTransactionStore(redis as any, 'pfx:');

    const state = await store.createTransaction({
      clientId: 'mcp_abc',
      redirectUri: 'https://a.example.com/cb',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
    });

    expect(await store.consumeTransaction(state)).not.toBeNull();
    expect(redis.getdel).toHaveBeenCalledWith(`pfx:oauth:txn:${state}`);
    expect(await store.consumeTransaction(state)).toBeNull();
  });
});
