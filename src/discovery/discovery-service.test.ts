import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-ignore
import { DiscoveryService } from './discovery-service.js';
// @ts-ignore
import { RockClient } from '../rock/client.js';
// @ts-ignore
import { OAuthRockContext } from '../http/oauth.js';

describe('DiscoveryService', () => {
  let mockClient: RockClient;
  let service: DiscoveryService;
  const mockCtx = {} as OAuthRockContext;

  beforeEach(() => {
    mockClient = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    };
    // Initialize service with mock client and null redis to trigger in-memory fallback
    service = new DiscoveryService(mockClient, null);
  });

  it('should lazy load and cache the discovery map', async () => {
    // Stub client calls for discovery elements
    mockClient.get = vi.fn().mockImplementation(async (_ctx, path) => {
      if (path.includes('/SystemInfos') || path.includes('/System')) {
        return { Version: '17.7' };
      }
      return [];
    });

    mockClient.post = vi.fn().mockImplementation(async (_ctx, path, _body) => {
      if (path.includes('/campuses/search')) {
        return [{ Id: 1, Name: 'Manila', Guid: 'g-manila' }];
      }
      if (path.includes('/grouptypes/search')) {
        return [
          { Id: 10, Name: 'Connect Groups', Guid: 'g-cg' },
          { Id: 11, Name: 'Ministry Teams', Guid: 'g-mt' },
        ];
      }
      if (path.includes('/attributes/search')) {
        return [
          {
            Id: 100,
            Name: 'Connection Status',
            Key: 'connection_status',
            IsActive: true,
            EntityTypeId: 1,
            Guid: 'g-lifecycle',
            AttributeValues: [
              { Value: 'New' },
              { Value: 'Crowd' },
              { Value: 'Core' },
              { Value: 'Leader' },
            ],
          },
        ];
      }
      if (path.includes('/entitysearches/search')) {
        return [
          { Id: 200, Name: 'People Search', Key: 'people_search', Guid: 'g-search-1' },
        ];
      }
      if (path.includes('/workflowtypes/search')) {
        return [
          { Id: 300, Name: 'Baptism Flow', Guid: 'g-wf-1' },
        ];
      }
      if (path.includes('/connectiontypes/search')) {
        return [
          { Id: 400, Name: 'Member', Guid: 'g-conn-1' },
        ];
      }
      return [];
    });

    // First call: runs mock client search queries
    const map1 = await service.getMap(mockCtx);
    expect(map1.campuses).toHaveLength(1);
    expect(map1.campuses[0].name).toBe('Manila');
    expect(map1.attributes.personLifecycle.length).toBeGreaterThan(0);
    expect(map1.entitySearches.length).toBeGreaterThan(0);
    expect(map1.workflows.length).toBeGreaterThan(0);
    expect(map1.connectionTypes.length).toBeGreaterThan(0);
    expect(mockClient.post).toHaveBeenCalled();

    // Reset post spy to verify it's not called on second read
    vi.mocked(mockClient.post).mockClear();

    // Second call: should hit cache
    const map2 = await service.getMap(mockCtx);
    expect(map2.campuses).toHaveLength(1);
    expect(mockClient.post).not.toHaveBeenCalled();
  });

  it('should refresh discovery and query Rock again', async () => {
    mockClient.get = vi.fn().mockResolvedValue({ Version: '17.7' } as any);
    mockClient.post = vi.fn().mockResolvedValue([]);

    await service.getMap(mockCtx);
    expect(mockClient.post).toHaveBeenCalled();

    // Reset post spy
    vi.mocked(mockClient.post).mockClear();

    // Call refresh
    await service.refresh(mockCtx);

    // Should fetch again
    await service.getMap(mockCtx);
    expect(mockClient.post).toHaveBeenCalled();
  });

  it('should handle attribute discovery failures gracefully', async () => {
    mockClient.get = vi.fn().mockImplementation(async (_ctx, path) => {
      if (path.includes('/System')) {
        return { Version: '17.7' };
      }
      if (path.includes('/Reports')) {
        return [];
      }
      if (path.includes('/Attributes')) {
        throw new Error('Attributes endpoint unavailable');
      }
      return [];
    });

    mockClient.post = vi.fn().mockImplementation(async (_ctx, path, _body) => {
      if (path.includes('/campuses/search')) {
        return [{ Id: 1, Name: 'Manila', Guid: 'g-manila' }];
      }
      if (path.includes('/grouptypes/search')) {
        return [];
      }
      if (path.includes('/attributes/search')) {
        throw new Error('Attributes endpoint unavailable');
      }
      return [];
    });

    const map = await service.getMap(mockCtx);
    expect(map.attributes.personLifecycle).toHaveLength(0);
    expect(map.attributes.personAgeGroup).toHaveLength(0);
    expect(map.warnings.join(' ').toLowerCase()).toContain('attributes');
  });

  it('should discover attributes with proper confidence scoring', async () => {
    mockClient.post = vi.fn().mockImplementation(async (_ctx, path, _body) => {
      if (path.includes('/campuses/search')) {
        return [];
      }
      if (path.includes('/grouptypes/search')) {
        return [];
      }
      if (path.includes('/attributes/search')) {
        return [
          {
            Id: 100,
            Name: 'Connection Status',
            Key: 'connection_status',
            IsActive: true,
            EntityTypeId: 1,
            Guid: 'g-lifecycle',
            AttributeValues: [
              { Value: 'New' },
              { Value: 'Crowd' },
              { Value: 'Core' },
              { Value: 'Leader' },
            ],
          },
          {
            Id: 101,
            Name: 'Age Group',
            Key: 'age_group',
            IsActive: true,
            EntityTypeId: 1,
            Guid: 'g-age',
            AttributeValues: [
              { Value: 'Kids' },
              { Value: 'Youth' },
              { Value: 'Adults' },
            ],
          },
          {
            Id: 102,
            Name: 'Fluro ID',
            Key: 'fluro_id',
            IsActive: true,
            EntityTypeId: 1,
            Guid: 'g-fluro',
          },
        ];
      }
      if (path.includes('/entitysearches/search')) {
        return [];
      }
      if (path.includes('/workflowtypes/search')) {
        return [];
      }
      if (path.includes('/connectiontypes/search')) {
        return [];
      }
      return [];
    });

    mockClient.get = vi.fn().mockResolvedValue({ Version: '17.7' });

    const map = await service.getMap(mockCtx);
    expect(map.attributes.personLifecycle.length).toBeGreaterThan(0);
    expect(map.attributes.personLifecycle[0].confidence).toBeGreaterThan(0.7);
    expect(map.attributes.personAgeGroup.length).toBeGreaterThan(0);
    expect(map.attributes.fluroId.length).toBeGreaterThan(0);
  });
});
