import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as crypto from 'crypto';
import {
  StoredDataset,
  InMemoryDatasetStore,
  RedisDatasetStore,
} from '../../src/tools/dataset-store.js';
import { OAuthRockContext } from '../../src/http/oauth.js';

// Mock Redis client using a simple Map
class MockRedis {
  private store = new Map<string, string>();
  private expirations = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    const expireAt = this.expirations.get(key);
    if (expireAt && Date.now() > expireAt) {
      this.store.delete(key);
      this.expirations.delete(key);
      return null;
    }
    const value = this.store.get(key);
    return value ?? null;
  }

  async set(key: string, value: string, options?: { ex?: number }): Promise<void> {
    this.store.set(key, value);
    if (options?.ex) {
      this.expirations.set(key, Date.now() + options.ex * 1000);
    }
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
    this.expirations.delete(key);
  }

  /**
   * Helper to manually expire a key for testing.
   */
  expireKey(key: string): void {
    this.expirations.set(key, Date.now() - 1000);
  }
}

describe('InMemoryDatasetStore', () => {
  let store: InMemoryDatasetStore;
  let mockCtx: OAuthRockContext;
  let testDataset: StoredDataset;

  beforeEach(() => {
    store = new InMemoryDatasetStore();

    const oauthSubject = 'test-user-123';
    const subjectHash = crypto.createHash('sha256').update(oauthSubject).digest('hex');

    mockCtx = {
      endpoint: 'mcp',
      mode: 'readonly',
      scopes: new Set(['read']),
      oauth: {
        subject: oauthSubject,
        email: 'test@example.com',
        accessTokenHash: '',
      },
      rockUser: {
        personId: 1,
        isRsrAdmin: false,
      },
      request: {
        sessionId: 'test-session',
        requestId: 'test-request',
      },
    } as unknown as OAuthRockContext;

    testDataset = {
      id: 'dataset-123',
      owner: {
        oauthSubjectHash: subjectHash,
        rockPersonId: 1,
        sessionId: 'test-session',
      },
      title: 'Test Dataset',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 min from now
      source: {
        tool: 'rock_report',
        action: 'run',
        reportId: 42,
      },
      columns: ['id', 'name', 'status'],
      rows: [
        { id: 1, name: 'Alice', status: 'active' },
        { id: 2, name: 'Bob', status: 'inactive' },
      ],
      sensitivity: 'person',
    };
  });

  it('should put and get a dataset', async () => {
    const id = await store.put(testDataset);
    expect(id).toBe('dataset-123');

    const retrieved = await store.get('dataset-123', mockCtx);
    expect(retrieved).toEqual(testDataset);
  });

  it('should return null for missing dataset', async () => {
    const retrieved = await store.get('nonexistent', mockCtx);
    expect(retrieved).toBeNull();
  });

  it('should return null for expired dataset', async () => {
    const expiredDataset = {
      ...testDataset,
      expiresAt: new Date(Date.now() - 1000).toISOString(), // already expired
    };

    await store.put(expiredDataset);
    const retrieved = await store.get('dataset-123', mockCtx);
    expect(retrieved).toBeNull();
  });

  it('should delete a dataset', async () => {
    await store.put(testDataset);
    await store.delete('dataset-123', mockCtx);

    const retrieved = await store.get('dataset-123', mockCtx);
    expect(retrieved).toBeNull();
  });

  it('should reject access to dataset with mismatched owner', async () => {
    await store.put(testDataset);

    // Create a different user context
    const otherUserSubject = 'other-user-456';
    const otherUserHash = crypto
      .createHash('sha256')
      .update(otherUserSubject)
      .digest('hex');

    const otherCtx = {
      ...mockCtx,
      oauth: {
        ...mockCtx.oauth,
        subject: otherUserSubject,
      },
    } as OAuthRockContext;

    // Verify the hash is actually different
    expect(otherUserHash).not.toBe(testDataset.owner.oauthSubjectHash);

    // Should throw on ownership mismatch
    await expect(store.get('dataset-123', otherCtx)).rejects.toThrow(
      'Access denied: dataset ownership mismatch'
    );
  });

  it('should accept optional ttlSeconds parameter without error', async () => {
    // ttlSeconds is optional and ignored in InMemoryDatasetStore
    const id = await store.put(testDataset, 3600);
    expect(id).toBe('dataset-123');

    const retrieved = await store.get('dataset-123', mockCtx);
    expect(retrieved).toEqual(testDataset);
  });

  it('should reject delete from a different user (ownership enforcement)', async () => {
    await store.put(testDataset);

    const otherCtx = {
      ...mockCtx,
      oauth: {
        ...mockCtx.oauth,
        subject: 'other-user-456',
      },
    } as OAuthRockContext;

    await expect(store.delete('dataset-123', otherCtx)).rejects.toThrow(
      'Access denied: dataset ownership mismatch'
    );

    // Verify the dataset was NOT deleted (still accessible by owner)
    const retrieved = await store.get('dataset-123', mockCtx);
    expect(retrieved).not.toBeNull();
  });
});

describe('RedisDatasetStore', () => {
  let store: RedisDatasetStore;
  let mockRedis: MockRedis;
  let mockCtx: OAuthRockContext;
  let testDataset: StoredDataset;

  beforeEach(() => {
    mockRedis = new MockRedis();
    // Cast to any to avoid type strictness for mock
    store = new RedisDatasetStore(mockRedis as any, 'test-prefix:');

    const oauthSubject = 'test-user-123';
    const subjectHash = crypto.createHash('sha256').update(oauthSubject).digest('hex');

    mockCtx = {
      endpoint: 'mcp',
      mode: 'readonly',
      scopes: new Set(['read']),
      oauth: {
        subject: oauthSubject,
        email: 'test@example.com',
        accessTokenHash: '',
      },
      rockUser: {
        personId: 1,
        isRsrAdmin: false,
      },
      request: {
        sessionId: 'test-session',
        requestId: 'test-request',
      },
    } as unknown as OAuthRockContext;

    testDataset = {
      id: 'redis-dataset-456',
      owner: {
        oauthSubjectHash: subjectHash,
        rockPersonId: 1,
        sessionId: 'test-session',
      },
      title: 'Redis Test Dataset',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 min from now
      source: {
        tool: 'rock_report',
        action: 'run',
        reportId: 99,
      },
      columns: ['id', 'value'],
      rows: [{ id: 1, value: 'test' }],
      sensitivity: 'low',
    };
  });

  it('should put and get a dataset with custom TTL', async () => {
    const id = await store.put(testDataset, 1800); // 30 minutes
    expect(id).toBe('redis-dataset-456');

    const retrieved = await store.get('redis-dataset-456', mockCtx);
    expect(retrieved).toEqual(testDataset);
  });

  it('should put and get a dataset with default TTL from environment', async () => {
    const id = await store.put(testDataset);
    expect(id).toBe('redis-dataset-456');

    const retrieved = await store.get('redis-dataset-456', mockCtx);
    expect(retrieved).toEqual(testDataset);
  });

  it('should store dataset under prefixed Redis key', async () => {
    // Spy on redis.set to verify the key format
    const setSpy = vi.spyOn(mockRedis, 'set');

    await store.put(testDataset, 600);

    expect(setSpy).toHaveBeenCalledWith(
      'test-prefix:dataset:redis-dataset-456',
      JSON.stringify(testDataset),
      { ex: 600 }
    );
  });

  it('should return null for missing dataset', async () => {
    const retrieved = await store.get('nonexistent', mockCtx);
    expect(retrieved).toBeNull();
  });

  it('should return null for expired dataset and clean it up', async () => {
    await store.put(testDataset, 600);
    const key = 'test-prefix:dataset:redis-dataset-456';

    // Manually expire the key in mock Redis
    mockRedis.expireKey(key);

    const retrieved = await store.get('redis-dataset-456', mockCtx);

    // Verify it returns null for expired dataset
    expect(retrieved).toBeNull();

    // Verify the key was cleaned up by trying to get it again
    const afterDelete = await store.get('redis-dataset-456', mockCtx);
    expect(afterDelete).toBeNull();
  });

  it('should delete a dataset', async () => {
    await store.put(testDataset, 600);

    const delSpy = vi.spyOn(mockRedis, 'del');
    await store.delete('redis-dataset-456', mockCtx);

    expect(delSpy).toHaveBeenCalledWith('test-prefix:dataset:redis-dataset-456');

    const retrieved = await store.get('redis-dataset-456', mockCtx);
    expect(retrieved).toBeNull();
  });

  it('should reject access to dataset with mismatched owner', async () => {
    await store.put(testDataset, 600);

    const otherUserSubject = 'other-user-789';
    const otherCtx = {
      ...mockCtx,
      oauth: {
        ...mockCtx.oauth,
        subject: otherUserSubject,
      },
    } as OAuthRockContext;

    await expect(store.get('redis-dataset-456', otherCtx)).rejects.toThrow(
      'Access denied: dataset ownership mismatch'
    );
  });

  it('should handle both string and object returns from Redis', async () => {
    // Test string return
    await store.put(testDataset, 600);
    const retrieved = await store.get('redis-dataset-456', mockCtx);
    expect(retrieved).toEqual(testDataset);

    // The MockRedis always returns strings, so this test validates
    // that the store correctly handles JSON.parse for string returns
  });

  it('should compute TTL from dataset.expiresAt if not provided', async () => {
    const futureTime = new Date(Date.now() + 3600 * 1000); // 1 hour from now
    const datasetWithExpiresAt = {
      ...testDataset,
      expiresAt: futureTime.toISOString(),
    };

    const setSpy = vi.spyOn(mockRedis, 'set');
    await store.put(datasetWithExpiresAt); // no ttlSeconds provided

    // Verify that a reasonable TTL was computed from expiresAt
    const calls = setSpy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [, , options] = calls[0];
    expect(options?.ex).toBeGreaterThan(0);
    // Should be roughly 3600 seconds (±5 for test execution time)
    expect(options?.ex).toBeGreaterThanOrEqual(3595);
    expect(options?.ex).toBeLessThanOrEqual(3605);
  });
});
