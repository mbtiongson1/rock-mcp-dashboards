import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-ignore
import { getDefinedValueMap, resolveDefinedValueIdByName, clearDefinedValueCache } from '../../src/rock/defined-values.js';
// @ts-ignore
import { OAuthRockContext } from '../../src/http/oauth.js';

/**
 * Path-aware mock for the two-step lookup: DefinedTypes by Name → Id, then
 * DefinedValues by DefinedTypeId.
 */
function mockTwoStepLookup(client: any, typeId: number, values: Array<{ Id: any; Value: any }>) {
  client.get.mockImplementation(async (_ctx: any, path: string) => {
    if (path.startsWith('/api/DefinedTypes')) {
      return [{ Id: typeId }];
    }
    if (path.startsWith('/api/DefinedValues')) {
      expect(path).toContain(`DefinedTypeId eq ${typeId}`);
      return values;
    }
    throw new Error(`Unexpected path ${path}`);
  });
}

describe('defined-values module', () => {
  let mockClient: any;
  let mockCtx: any;

  beforeEach(() => {
    mockClient = {
      get: vi.fn(),
    };

    mockCtx = {
      oauth: { subject: 'test-user' },
      rockUser: { personId: 123 },
      request: { sessionId: 'session-123' },
    } as unknown as OAuthRockContext;

    clearDefinedValueCache();
  });

  it('returns a map of DefinedValue IDs to names via the two-step lookup', async () => {
    mockTwoStepLookup(mockClient, 4, [
      { Id: 67, Value: 'New' },
      { Id: 146, Value: 'Core' },
    ]);

    const map = await getDefinedValueMap(mockClient, mockCtx, 'Connection Status');

    expect(map.get(67)).toBe('New');
    expect(map.get(146)).toBe('Core');
    expect(map.size).toBe(2);
  });

  it('caches results and does not refetch on second call', async () => {
    mockTwoStepLookup(mockClient, 4, [{ Id: 67, Value: 'New' }]);

    const map1 = await getDefinedValueMap(mockClient, mockCtx, 'Connection Status');
    const map2 = await getDefinedValueMap(mockClient, mockCtx, 'Connection Status');

    expect(map1.get(67)).toBe('New');
    expect(map2.get(67)).toBe('New');
    // Two calls for the first (uncached) lookup, none for the second
    expect(mockClient.get).toHaveBeenCalledTimes(2);
  });

  it('returns empty map on fetch error and does not cache the error', async () => {
    mockClient.get.mockRejectedValue(new Error('API error'));

    const map1 = await getDefinedValueMap(mockClient, mockCtx, 'Connection Status');
    expect(map1.size).toBe(0);

    mockTwoStepLookup(mockClient, 4, [{ Id: 67, Value: 'New' }]);

    const map2 = await getDefinedValueMap(mockClient, mockCtx, 'Connection Status');
    expect(map2.get(67)).toBe('New');
  });

  it('returns empty map when the DefinedType is unknown', async () => {
    mockClient.get.mockResolvedValue([]);

    const map = await getDefinedValueMap(mockClient, mockCtx, 'No Such Type');
    expect(map.size).toBe(0);
  });

  it('handles null/undefined values in results gracefully', async () => {
    mockTwoStepLookup(mockClient, 4, [
      { Id: 67, Value: 'New' },
      { Id: null, Value: 'Bad' },
      { Id: 69, Value: null },
      { Id: 70, Value: 'Active' },
    ]);

    const map = await getDefinedValueMap(mockClient, mockCtx, 'Connection Status');

    expect(map.size).toBe(2);
    expect(map.get(67)).toBe('New');
    expect(map.get(70)).toBe('Active');
  });

  it('clears the cache when clearDefinedValueCache is called', async () => {
    mockTwoStepLookup(mockClient, 4, [{ Id: 67, Value: 'New' }]);

    const map1 = await getDefinedValueMap(mockClient, mockCtx, 'Connection Status');
    expect(map1.get(67)).toBe('New');

    clearDefinedValueCache();
    mockClient.get.mockClear();
    mockTwoStepLookup(mockClient, 4, [{ Id: 67, Value: 'New' }]);

    const map2 = await getDefinedValueMap(mockClient, mockCtx, 'Connection Status');
    expect(map2.get(67)).toBe('New');
    expect(mockClient.get).toHaveBeenCalledTimes(2);
  });

  it('resolveDefinedValueIdByName matches case-insensitively and returns null on miss', async () => {
    mockTwoStepLookup(mockClient, 12, [
      { Id: 3, Value: 'Active' },
      { Id: 4, Value: 'Inactive' },
    ]);

    expect(await resolveDefinedValueIdByName(mockClient, mockCtx, 'Record Status', 'active')).toBe(3);
    expect(await resolveDefinedValueIdByName(mockClient, mockCtx, 'Record Status', 'Missing')).toBeNull();
  });
});
