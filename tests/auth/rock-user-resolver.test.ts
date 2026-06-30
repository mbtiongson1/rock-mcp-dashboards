import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RockUserResolver } from '../../src/auth/rock-user-resolver.js';
import { RockClient } from '../../src/rock/client.js';
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
        // GroupMemberStatus is an integer enum (1 = Active); the string form
        // 'Active' silently matches nothing on this v1 OData instance.
        expect(path).toContain('GroupMemberStatus eq 1');
        expect(path).not.toContain("GroupMemberStatus eq 'Active'");
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

  describe('staff detection', () => {
    // A non-admin who is a member of "RSR - Staff Workers".
    function staffWorkerClient(): void {
      mockClient.get = vi.fn().mockImplementation(async (_ctx, path) => {
        if (path.includes('/api/People')) {
          return [{ Id: 7, PrimaryAliasId: 70, Guid: '550e8400-e29b-41d4-a716-446655440007' }];
        }
        if (path.includes('/api/Groups')) {
          if (path.includes('Rock Administration')) return [{ Id: 99, Name: 'RSR - Rock Administration' }];
          if (path.includes('Staff Like Workers')) return [{ Id: 51, Name: 'RSR - Staff Like Workers' }];
          if (path.includes('Staff Workers')) return [{ Id: 50, Name: 'RSR - Staff Workers' }];
          return [];
        }
        if (path.includes('/api/GroupMembers')) {
          // Active member of group 50 (Staff Workers) only.
          if (path.includes('GroupId eq 50')) return [{ Id: 1, PersonId: 7, GroupId: 50, GroupMemberStatus: 1 }];
          return [];
        }
        return [];
      });
    }

    it('returns isStaff true and isRsrAdmin false for a Staff Workers member', async () => {
      staffWorkerClient();
      const result = await resolver.resolve(mockCtx, { subject: 'staff-1', email: 'staff@example.com' });
      expect(result.isRsrAdmin).toBe(false);
      expect(result.isStaff).toBe(true);
    });

    it('returns isStaff true for a Staff Like Workers member (second default role)', async () => {
      mockClient.get = vi.fn().mockImplementation(async (_ctx, path) => {
        if (path.includes('/api/People')) {
          return [{ Id: 8, PrimaryAliasId: 80, Guid: '550e8400-e29b-41d4-a716-446655440008' }];
        }
        if (path.includes('/api/Groups')) {
          if (path.includes('Staff Like Workers')) return [{ Id: 51, Name: 'RSR - Staff Like Workers' }];
          if (path.includes('Staff Workers')) return [{ Id: 50, Name: 'RSR - Staff Workers' }];
          return [];
        }
        if (path.includes('/api/GroupMembers')) {
          if (path.includes('GroupId eq 51')) return [{ Id: 2, PersonId: 8, GroupId: 51, GroupMemberStatus: 1 }];
          return [];
        }
        return [];
      });
      const result = await resolver.resolve(mockCtx, { subject: 'staff-2', email: 'stafflike@example.com' });
      expect(result.isStaff).toBe(true);
    });

    it('returns isStaff false when the person is in neither staff role', async () => {
      mockClient.get = vi.fn().mockImplementation(async (_ctx, path) => {
        if (path.includes('/api/People')) {
          return [{ Id: 9, PrimaryAliasId: 90, Guid: '550e8400-e29b-41d4-a716-446655440009' }];
        }
        if (path.includes('/api/Groups')) return [{ Id: 50, Name: 'RSR - Staff Workers' }];
        if (path.includes('/api/GroupMembers')) return []; // member of nothing
        return [];
      });
      const result = await resolver.resolve(mockCtx, { subject: 'visitor', email: 'visitor@example.com' });
      expect(result.isRsrAdmin).toBe(false);
      expect(result.isStaff).toBe(false);
    });

    it('honors the ROCK_STAFF_ROLE_NAMES env override', async () => {
      const prev = process.env.ROCK_STAFF_ROLE_NAMES;
      process.env.ROCK_STAFF_ROLE_NAMES = 'Custom Staff Role';
      try {
        mockClient.get = vi.fn().mockImplementation(async (_ctx, path) => {
          if (path.includes('/api/People')) {
            return [{ Id: 11, PrimaryAliasId: 110, Guid: '550e8400-e29b-41d4-a716-446655440011' }];
          }
          if (path.includes('/api/Groups')) {
            if (path.includes('Custom Staff Role')) return [{ Id: 60, Name: 'Custom Staff Role' }];
            return []; // the default RSR staff roles must NOT be consulted
          }
          if (path.includes('/api/GroupMembers')) {
            if (path.includes('GroupId eq 60')) return [{ Id: 3, PersonId: 11, GroupId: 60, GroupMemberStatus: 1 }];
            return [];
          }
          return [];
        });
        const result = await resolver.resolve(mockCtx, { subject: 'custom-staff', email: 'custom@example.com' });
        expect(result.isStaff).toBe(true);
      } finally {
        if (prev === undefined) delete process.env.ROCK_STAFF_ROLE_NAMES;
        else process.env.ROCK_STAFF_ROLE_NAMES = prev;
      }
    });
  });
});
