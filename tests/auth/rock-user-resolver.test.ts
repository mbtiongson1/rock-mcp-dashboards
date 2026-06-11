import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-ignore
import { RockUserResolver } from '../../src/auth/rock-user-resolver.js';
// @ts-ignore
import { RockClient } from '../../src/rock/client.js';
// @ts-ignore
import { OAuthRockContext } from '../../src/http/oauth.js';

describe('RockUserResolver', () => {
  let mockClient: RockClient;
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
    resolver = new RockUserResolver(mockClient);
  });

  it('resolves the user via GetCurrentPerson first (no claims needed)', async () => {
    const oauth = {
      subject: 'google-oauth2|123',
      accessTokenHash: 'hash',
    };

    mockClient.get = vi.fn().mockImplementation(async (_ctx, path) => {
      if (path === '/api/People/GetCurrentPerson') {
        return { Id: 5, PrimaryAliasId: 14, Guid: '550e8400-e29b-41d4-a716-446655440005' };
      }
      return [];
    });

    const result = await resolver.resolve(mockCtx, oauth);

    expect(result.personId).toBe(5);
    expect(result.personAliasId).toBe(14);
  });

  it('should resolve user by explicit GUID claim via Rock v1', async () => {
    const oauth = {
      subject: 'user-123',
      email: 'alex@example.com',
      accessTokenHash: 'hash',
      rockPersonGuid: '550e8400-e29b-41d4-a716-446655440000', // claim containing person guid
    };

    mockClient.get = vi.fn().mockImplementation(async (_ctx, path) => {
      if (path.includes('/api/People') && path.includes('Guid eq')) {
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

    mockClient.get = vi.fn().mockImplementation(async (_ctx, path) => {
      if (path.includes('/api/People') && path.includes('Email eq')) {
        return [{ Id: 12, PrimaryAliasId: 24, Guid: 'guid-abc-123' }];
      }
      return [];
    });

    const result = await resolver.resolve(mockCtx, oauth);

    expect(result.personId).toBe(12);
    expect(result.personGuid).toBe('guid-abc-123');
  });

  it('never calls the unavailable v2 API', async () => {
    const oauth = {
      subject: 'user-123',
      email: 'alex@example.com',
      accessTokenHash: 'hash',
    };

    mockClient.get = vi.fn().mockResolvedValue([]);

    await resolver.resolve(mockCtx, oauth);

    expect(mockClient.post).not.toHaveBeenCalled();
  });

  it('should return isRsrAdmin true if user is member of RSR role', async () => {
    const oauth = {
      subject: 'user-123',
      email: 'admin@example.com',
      accessTokenHash: 'hash',
    };

    mockClient.get = vi.fn().mockImplementation(async (_ctx, path) => {
      if (path.includes('/api/People')) {
        return [{ Id: 1, PrimaryAliasId: 10, Guid: '550e8400-e29b-41d4-a716-446655440001' }];
      }
      if (path.includes('/api/Groups')) {
        return [{ Id: 99, Name: 'RSR - Rock Administration' }];
      }
      if (path.includes('/api/GroupMembers')) {
        expect(path).toContain("GroupMemberStatus eq 'Active'");
        return [{ Id: 1001, PersonId: 1, GroupId: 99, GroupMemberStatus: 1 }];
      }
      return [];
    });

    const result = await resolver.resolve(mockCtx, oauth);

    expect(result.isRsrAdmin).toBe(true);
  });

  it('uses the user token for the RSR lookup and fails closed when Rock denies it', async () => {
    const oauth = {
      subject: 'user-non-admin',
      email: 'member@example.com',
      accessTokenHash: 'hash',
    };

    mockClient.get = vi.fn().mockImplementation(async (_ctx, path) => {
      if (path.includes('/api/People')) {
        return [{ Id: 4, PrimaryAliasId: 40, Guid: '550e8400-e29b-41d4-a716-446655440004' }];
      }
      if (path.includes('/api/Groups')) {
        // Non-admins may not be able to read the RSR group at all
        throw new Error('401 Unauthorized');
      }
      return [];
    });

    const result = await resolver.resolve(mockCtx, oauth);

    expect(result.personId).toBe(4);
    expect(result.isRsrAdmin).toBe(false);
  });

  it('fails closed when the membership lookup is denied', async () => {
    const oauth = {
      subject: 'user-denied-membership',
      email: 'denied@example.com',
      accessTokenHash: 'hash',
    };

    mockClient.get = vi.fn().mockImplementation(async (_ctx, path) => {
      if (path.includes('/api/People')) {
        return [{ Id: 5, PrimaryAliasId: 50, Guid: '550e8400-e29b-41d4-a716-446655440005' }];
      }
      if (path.includes('/api/Groups')) {
        return [{ Id: 99, Name: 'RSR - Rock Administration' }];
      }
      if (path.includes('/api/GroupMembers')) {
        throw new Error('403 Forbidden');
      }
      return [];
    });

    const result = await resolver.resolve(mockCtx, oauth);

    expect(result.personId).toBe(5);
    expect(result.isRsrAdmin).toBe(false);
  });
});
