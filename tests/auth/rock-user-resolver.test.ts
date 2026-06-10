import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-ignore
import { RockUserResolver } from '../../src/auth/rock-user-resolver.js';
// @ts-ignore
import { RockClient } from '../../src/rock/client.js';
// @ts-ignore
import { OAuthRockContext } from '../../src/http/oauth.js';

describe('RockUserResolver', () => {
  let mockClient: RockClient;
  let mockAdminClient: RockClient;
  let resolver: RockUserResolver;
  const mockCtx = {} as OAuthRockContext;

  function createMockClient(): RockClient {
    return {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    };
  }

  beforeEach(() => {
    mockClient = createMockClient();
    mockAdminClient = createMockClient();
    resolver = new RockUserResolver(mockClient);
  });

  it('should resolve user by explicit GUID claim if present', async () => {
    const oauth = {
      subject: 'user-123',
      email: 'alex@example.com',
      accessTokenHash: 'hash',
      rockPersonGuid: '550e8400-e29b-41d4-a716-446655440000', // claim containing person guid
    };

    mockClient.post = vi.fn().mockImplementation(async (_ctx, path, _body: any) => {
      if (path.includes('/people/search')) {
        return [{ Id: 12, PrimaryAliasId: 24, Guid: '550e8400-e29b-41d4-a716-446655440000', NickName: 'Alex' }];
      }
      return [];
    });

    const result = await resolver.resolve(mockCtx, oauth);

    expect(result.personId).toBe(12);
    expect(result.personGuid).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(result.personAliasId).toBe(24);
  });

  it('should resolve user by email if GUID claim is not present', async () => {
    const oauth = {
      subject: 'user-123',
      email: 'alex@example.com',
      accessTokenHash: 'hash',
    };

    mockClient.post = vi.fn().mockImplementation(async (_ctx, path, _body: any) => {
      if (path.includes('/people/search')) {
        return [{ Id: 12, PrimaryAliasId: 24, Guid: 'guid-abc-123' }];
      }
      return [];
    });

    const result = await resolver.resolve(mockCtx, oauth);

    expect(result.personId).toBe(12);
    expect(result.personGuid).toBe('guid-abc-123');
  });

  it('should return isRsrAdmin true if user is member of RSR role', async () => {
    const oauth = {
      subject: 'user-123',
      email: 'admin@example.com',
      accessTokenHash: 'hash',
    };

    mockClient.post = vi.fn().mockImplementation(async (_ctx, path, _body: any) => {
      if (path.includes('/people/search')) {
        return [{ Id: 1, PrimaryAliasId: 10, Guid: '550e8400-e29b-41d4-a716-446655440001' }];
      }
      if (path.includes('/groups/search')) {
        // Group search for role "RSR - Rock Administration"
        return [{ Id: 99, Name: 'RSR - Rock Administration' }];
      }
      if (path.includes('/groupmembers/search')) {
        // Group member search for personId = 1, groupId = 99, status active (IsSystem or active)
        return [{ Id: 1001, PersonId: 1, GroupId: 99, GroupMemberStatus: 1 }]; // status 1 is active
      }
      return [];
    });

    const result = await resolver.resolve(mockCtx, oauth);

    expect(result.isRsrAdmin).toBe(true);
  });

  it('should return isRsrAdmin true when v2 fails and v1 fallback returns active membership', async () => {
    const oauth = {
      subject: 'user-456',
      email: 'rsr-admin@example.com',
      accessTokenHash: 'hash',
    };

    mockClient.post = vi.fn().mockImplementation(async (_ctx, path, _body: any) => {
      if (path.includes('/people/search')) {
        return [{ Id: 2, PrimaryAliasId: 20, Guid: '550e8400-e29b-41d4-a716-446655440002' }];
      }
      if (path.includes('/groups/search')) {
        return [{ Id: 99, Name: 'RSR - Rock Administration' }];
      }
      if (path.includes('/groupmembers/search')) {
        // Simulate v2 failure (401 unauthorized)
        throw new Error('Unauthorized');
      }
      return [];
    });

    mockClient.get = vi.fn().mockImplementation(async (_ctx, path) => {
      // v1 fallback: return active membership with enum name 'Active'
      if (path.includes('/api/GroupMembers')) {
        // Verify the filter contains 'Active' not '1'
        expect(path).toContain("GroupMemberStatus eq 'Active'");
        return [{ Id: 1002, PersonId: 2, GroupId: 99, GroupMemberStatus: 1 }]; // v1 response can still have numeric status
      }
      return [];
    });

    const result = await resolver.resolve(mockCtx, oauth);

    expect(result.isRsrAdmin).toBe(true);
    expect(mockClient.get).toHaveBeenCalled();
  });

  it('uses the optional admin client only for RSR admin lookup', async () => {
    resolver = new RockUserResolver(mockClient, mockAdminClient);
    const oauth = {
      subject: 'user-admin-client',
      email: 'admin-client@example.com',
      accessTokenHash: 'hash',
    };

    mockClient.post = vi.fn().mockImplementation(async (_ctx, path, _body: any) => {
      if (path.includes('/people/search')) {
        return [{ Id: 3, PrimaryAliasId: 30, Guid: '550e8400-e29b-41d4-a716-446655440003' }];
      }
      return [];
    });

    mockAdminClient.post = vi.fn().mockImplementation(async (_ctx, path, _body: any) => {
      if (path.includes('/groups/search')) {
        return [{ Id: 99, Name: 'RSR - Rock Administration' }];
      }
      if (path.includes('/groupmembers/search')) {
        return [{ Id: 1003, PersonId: 3, GroupId: 99, GroupMemberStatus: 1 }];
      }
      return [];
    });

    const result = await resolver.resolve(mockCtx, oauth);

    expect(result.personId).toBe(3);
    expect(result.isRsrAdmin).toBe(true);
    expect(mockClient.post).toHaveBeenCalledWith(mockCtx, '/api/v2/models/people/search', expect.any(Object));
    expect(mockClient.post).not.toHaveBeenCalledWith(mockCtx, '/api/v2/models/groups/search', expect.any(Object));
    expect(mockClient.post).not.toHaveBeenCalledWith(mockCtx, '/api/v2/models/groupmembers/search', expect.any(Object));
    expect(mockAdminClient.post).toHaveBeenCalledWith(mockCtx, '/api/v2/models/groups/search', expect.any(Object));
    expect(mockAdminClient.post).toHaveBeenCalledWith(mockCtx, '/api/v2/models/groupmembers/search', expect.any(Object));
  });

  it('fails closed when the optional admin client cannot check RSR membership', async () => {
    resolver = new RockUserResolver(mockClient, mockAdminClient);
    const oauth = {
      subject: 'user-admin-client-failure',
      email: 'admin-client-failure@example.com',
      accessTokenHash: 'hash',
    };

    mockClient.post = vi.fn().mockImplementation(async (_ctx, path, _body: any) => {
      if (path.includes('/people/search')) {
        return [{ Id: 4, PrimaryAliasId: 40, Guid: '550e8400-e29b-41d4-a716-446655440004' }];
      }
      return [];
    });

    mockAdminClient.post = vi.fn().mockRejectedValue(new Error('Admin lookup unavailable'));
    mockAdminClient.get = vi.fn().mockRejectedValue(new Error('Admin fallback unavailable'));

    const result = await resolver.resolve(mockCtx, oauth);

    expect(result.personId).toBe(4);
    expect(result.isRsrAdmin).toBe(false);
    expect(mockAdminClient.post).toHaveBeenCalled();
    expect(mockAdminClient.get).toHaveBeenCalled();
    expect(mockClient.post).not.toHaveBeenCalledWith(mockCtx, '/api/v2/models/groups/search', expect.any(Object));
    expect(mockClient.post).not.toHaveBeenCalledWith(mockCtx, '/api/v2/models/groupmembers/search', expect.any(Object));
  });
});
