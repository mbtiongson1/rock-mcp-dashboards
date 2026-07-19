import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RockUserResolver, isActiveGroupMemberStatus } from '../../src/auth/rock-user-resolver.js';
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

  interface AuthorizationState {
    personId: number;
    isRsrAdmin: boolean;
    isStaff: boolean;
    ledGroupIds: number[];
    omitProfileMetadata?: boolean;
  }

  function authorizationClient(state: AuthorizationState): RockClient {
    const client = createMockClient();
    Object.defineProperty(client, 'baseUrl', { value: 'https://rock.example' });
    client.get = vi.fn().mockImplementation(async (_ctx, path: string) => {
      if (path === '/api/People/GetCurrentPerson') {
        return {
          Id: state.personId,
          ...(state.omitProfileMetadata
            ? {}
            : { PrimaryAliasId: state.personId * 10, Guid: `guid-${state.personId}` }),
        };
      }
      if (path.includes('/api/Groups')) {
        if (path.includes('Rock Administration')) return [{ Id: 90 }];
        if (path.includes('Staff Like Workers')) return [{ Id: 92 }];
        if (path.includes('Staff Workers')) return [{ Id: 91 }];
        return [];
      }
      if (path.includes('$expand=GroupRole')) {
        return state.ledGroupIds.map((groupId) => ({
          GroupId: groupId,
          GroupMemberStatus: 'Active',
          GroupRole: { IsLeader: true },
        }));
      }
      if (path.includes('/api/GroupMembers')) {
        if (path.includes('GroupId eq 90') && state.isRsrAdmin) {
          return [{ GroupId: 90, PersonId: state.personId, GroupMemberStatus: 'Active' }];
        }
        if (path.includes('GroupId eq 91') && state.isStaff) {
          return [{ GroupId: 91, PersonId: state.personId, GroupMemberStatus: 'Active' }];
        }
        return [];
      }
      return [];
    });
    return client;
  }

  function createMockRedis() {
    const data = new Map<string, string>();
    return {
      data,
      get: vi.fn(async (key: string) => data.get(key) ?? null),
      set: vi.fn(async (key: string, value: string, _options?: { ex: number }) => {
        data.set(key, value);
        return 'OK';
      }),
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

  it('fails closed instead of using a GUID claim when GetCurrentPerson cannot validate the live binding', async () => {
    const oauth = {
      subject: 'user-123',
      email: 'alex@example.com',
      accessTokenHash: 'hash',
      rockPersonGuid: '550e8400-e29b-41d4-a716-446655440000', // claim containing person guid
    };

    mockClient.get = vi.fn().mockImplementation(async (_ctx, path: string) => {
      if (path === '/api/People/GetCurrentPerson') {
        throw new Error('Rock identity lookup unavailable');
      }
      if (path.includes('/api/People') && path.includes('Guid eq')) {
        return [{ Id: 12, PrimaryAliasId: 24, Guid: '550e8400-e29b-41d4-a716-446655440000', NickName: 'Alex' }];
      }
      return [];
    });

    const result = await resolver.resolve(mockCtx, oauth);

    expect(result.personId).toBeUndefined();
    expect(mockClient.get).toHaveBeenCalledTimes(1);
  });

  it('fails closed instead of using an email claim when GetCurrentPerson returns no person', async () => {
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

    expect(result.personId).toBeUndefined();
    expect(mockClient.get).toHaveBeenCalledTimes(1);
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

  describe('Redis-backed inert profile-metadata cache', () => {
    it('resolves live on a cache miss and caches only non-authorization profile metadata for 15 minutes', async () => {
      const redis = createMockRedis();
      const state = { personId: 21, isRsrAdmin: false, isStaff: false, ledGroupIds: [] };
      const client = authorizationClient(state);
      const redisResolver = new RockUserResolver(client, redis as any);

      const result = await redisResolver.resolve(mockCtx, { subject: 'cache-miss-user' });

      expect(result.personId).toBe(21);
      expect(redis.get).toHaveBeenCalledTimes(1);
      expect(redis.set).toHaveBeenCalledTimes(1);
      for (const [key, value, options] of redis.set.mock.calls) {
        expect(key).toMatch(/person-metadata:v1:/);
        expect(options).toEqual({ ex: 900 });
        expect(value).not.toMatch(/personId|isRsrAdmin|isStaff|ledGroupIds|subject/i);
      }
    });

    it('uses a profile-metadata Redis hit across resolver instances while all identity and privilege checks stay live', async () => {
      const redis = createMockRedis();
      const firstState = { personId: 22, isRsrAdmin: false, isStaff: false, ledGroupIds: [] };
      const firstClient = authorizationClient(firstState);
      await new RockUserResolver(firstClient, redis as any).resolve(mockCtx, { subject: 'cache-hit-user' });

      const secondState = {
        personId: 22,
        isRsrAdmin: false,
        isStaff: false,
        ledGroupIds: [],
        omitProfileMetadata: true,
      };
      const secondClient = authorizationClient(secondState);
      const result = await new RockUserResolver(secondClient, redis as any).resolve(mockCtx, {
        subject: 'cache-hit-user',
      });

      expect(result.personId).toBe(22);
      expect(result.personGuid).toBe('guid-22');
      expect(result.personAliasId).toBe(220);
      const secondPaths = vi.mocked(secondClient.get).mock.calls.map(([, path]) => path);
      expect(secondPaths).toContain('/api/People/GetCurrentPerson');
      expect(secondPaths.some((path) => path.includes('/api/GroupMembers'))).toBe(true);
      expect(secondPaths.some((path) => path.includes('/api/Groups'))).toBe(true);
      expect(redis.get).toHaveBeenCalledTimes(2);
      expect(redis.set).toHaveBeenCalledTimes(1);
    });

    it('keeps live identity and privilege resolution when Redis is down', async () => {
      const redis = {
        get: vi.fn().mockRejectedValue(new Error('Redis unavailable')),
        set: vi.fn().mockRejectedValue(new Error('Redis unavailable')),
      };
      const state = { personId: 24, isRsrAdmin: false, isStaff: false, ledGroupIds: [] };
      const client = authorizationClient(state);

      const result = await new RockUserResolver(client, redis as any).resolve(mockCtx, {
        subject: 'redis-down-user',
      });

      expect(result.personId).toBe(24);
      expect(redis.get).toHaveBeenCalledTimes(1);
      expect(client.get).toHaveBeenCalledWith(mockCtx, '/api/People/GetCurrentPerson');
      expect(vi.mocked(client.get).mock.calls.some(([, path]) => path.includes('/api/Groups'))).toBe(true);
      expect(redis.set).toHaveBeenCalledTimes(1);
    });

    it.each([
      {
        label: 'malformed',
        expiresAt: Date.now() + 60_000,
        personAliasId: 'not-an-id',
      },
      {
        label: 'expired',
        expiresAt: Date.now() - 1,
        personAliasId: 999,
      },
    ])('ignores a $label profile-metadata Redis entry and uses live metadata', async ({ expiresAt, personAliasId }) => {
      const redis = {
        get: vi.fn().mockResolvedValue(
          JSON.stringify({ version: 1, expiresAt, metadata: { personAliasId } })
        ),
        set: vi.fn().mockResolvedValue('OK'),
      };
      const state = { personId: 25, isRsrAdmin: false, isStaff: false, ledGroupIds: [] };
      const client = authorizationClient(state);

      const result = await new RockUserResolver(client, redis as any).resolve(mockCtx, {
        subject: 'invalid-cache-user',
      });

      expect(result.personId).toBe(25);
      expect(result.personAliasId).toBe(250);
      expect(result.isRsrAdmin).toBe(false);
      expect(redis.get).toHaveBeenCalledTimes(1);
      expect(client.get).toHaveBeenCalledWith(mockCtx, '/api/People/GetCurrentPerson');
      expect(vi.mocked(client.get).mock.calls.some(([, path]) => path.includes('/api/Groups'))).toBe(true);
    });

    it.each([
      {
        label: 'admin',
        initial: { isRsrAdmin: true, isStaff: false, ledGroupIds: [] },
        expectedInitial: { isRsrAdmin: true, isStaff: true, ledGroupIds: [] },
      },
      {
        label: 'staff',
        initial: { isRsrAdmin: false, isStaff: true, ledGroupIds: [] },
        expectedInitial: { isRsrAdmin: false, isStaff: true, ledGroupIds: [] },
      },
      {
        label: 'leader',
        initial: { isRsrAdmin: false, isStaff: false, ledGroupIds: [77] },
        expectedInitial: { isRsrAdmin: false, isStaff: false, ledGroupIds: [77] },
      },
    ])('denies a revoked $label immediately with a warm cache in the same and a fresh resolver', async ({ initial, expectedInitial }) => {
      const redis = createMockRedis();
      const state: AuthorizationState = { personId: 30, ...initial };
      const firstClient = authorizationClient(state);
      const firstResolver = new RockUserResolver(firstClient, redis as any);

      const granted = await firstResolver.resolve(mockCtx, { subject: 'revoked-user' });
      expect(granted).toMatchObject(expectedInitial);

      state.isRsrAdmin = false;
      state.isStaff = false;
      state.ledGroupIds = [];

      const deniedInSameResolver = await firstResolver.resolve(mockCtx, { subject: 'revoked-user' });
      expect(deniedInSameResolver).toMatchObject({ isRsrAdmin: false, isStaff: false, ledGroupIds: [] });

      const secondClient = authorizationClient(state);
      const deniedInFreshResolver = await new RockUserResolver(secondClient, redis as any).resolve(mockCtx, {
        subject: 'revoked-user',
      });
      expect(deniedInFreshResolver).toMatchObject({ isRsrAdmin: false, isStaff: false, ledGroupIds: [] });
      expect(secondClient.get).toHaveBeenCalledWith(mockCtx, '/api/People/GetCurrentPerson');
    });

    it('resolves a changed subject-to-person mapping immediately across resolver instances with a warm cache', async () => {
      const redis = createMockRedis();
      const state: AuthorizationState = {
        personId: 31,
        isRsrAdmin: false,
        isStaff: false,
        ledGroupIds: [],
      };

      const first = await new RockUserResolver(authorizationClient(state), redis as any).resolve(mockCtx, {
        subject: 'remapped-subject',
      });
      expect(first.personId).toBe(31);

      state.personId = 32;
      const secondClient = authorizationClient(state);
      const second = await new RockUserResolver(secondClient, redis as any).resolve(mockCtx, {
        subject: 'remapped-subject',
      });

      expect(second.personId).toBe(32);
      expect(second.personGuid).toBe('guid-32');
      expect(secondClient.get).toHaveBeenCalledWith(mockCtx, '/api/People/GetCurrentPerson');
    });
  });

  it('starts independent admin, staff, and led-group checks concurrently', async () => {
    const started: string[] = [];
    let releaseChecks: (() => void) | undefined;
    const checksMayFinish = new Promise<void>((resolve) => {
      releaseChecks = resolve;
    });
    mockClient.get = vi.fn().mockImplementation(async (_ctx, path: string) => {
      if (path === '/api/People/GetCurrentPerson') {
        return { Id: 25, PrimaryAliasId: 250, Guid: 'guid-25' };
      }
      if (path.includes('/api/Groups')) {
        if (path.includes('Rock Administration')) return [{ Id: 90 }];
        if (path.includes('Staff Workers')) return [{ Id: 91 }];
        return [];
      }
      if (path.includes('GroupId eq 90')) {
        started.push('admin');
        await checksMayFinish;
        return [];
      }
      if (path.includes('GroupId eq 91')) {
        started.push('staff');
        await checksMayFinish;
        return [];
      }
      if (path.includes('$expand=GroupRole')) {
        started.push('led-groups');
        await checksMayFinish;
        return [];
      }
      return [];
    });

    const pending = resolver.resolve(mockCtx, { subject: 'parallel-user' });
    try {
      await vi.waitFor(() => {
        expect(started).toEqual(expect.arrayContaining(['admin', 'staff', 'led-groups']));
      });
    } finally {
      releaseChecks?.();
    }
    await pending;
  });

  it('should return isRsrAdmin true if user is member of RSR role', async () => {
    const oauth = {
      subject: 'user-123',
      email: 'admin@example.com',
      accessTokenHash: 'hash',
    };

    mockClient.get = vi.fn().mockImplementation(async (_ctx, path) => {
      if (path === '/api/People/GetCurrentPerson') {
        return { Id: 1, PrimaryAliasId: 10, Guid: '550e8400-e29b-41d4-a716-446655440001' };
      }
      if (path.includes('/api/Groups')) {
        return [{ Id: 99, Name: 'RSR - Rock Administration' }];
      }
      if (path.includes('/api/GroupMembers')) {
        // The membership $filter must scope by group+person only. Never compare
        // the GroupMemberStatus enum in the filter — Rock's EDM types it as a
        // string and comparing to an integer 400s; status is checked in code.
        expect(path).toContain('GroupId eq');
        expect(path).toContain('PersonId eq');
        expect(path).not.toContain('GroupMemberStatus');
        return [{ Id: 1001, PersonId: 1, GroupId: 99, GroupMemberStatus: 1 }];
      }
      return [];
    });

    const result = await resolver.resolve(mockCtx, oauth);

    expect(result.isRsrAdmin).toBe(true);
  });

  it('counts a member as active whether GroupMemberStatus is 1 or "Active"', async () => {
    for (const status of [1, 'Active']) {
      const client = createMockClient();
      client.get = vi.fn().mockImplementation(async (_ctx, path) => {
        if (path === '/api/People/GetCurrentPerson') {
          return { Id: 1, PrimaryAliasId: 10, Guid: '550e8400-e29b-41d4-a716-446655440001' };
        }
        if (path.includes('/api/Groups')) {
          return [{ Id: 99, Name: 'RSR - Rock Administration' }];
        }
        if (path.includes('/api/GroupMembers')) {
          return [{ Id: 1001, PersonId: 1, GroupId: 99, GroupMemberStatus: status }];
        }
        return [];
      });
      const result = await new RockUserResolver(client).resolve(mockCtx, {
        subject: `admin-${status}`,
        email: 'admin@example.com',
      });
      expect(result.isRsrAdmin, `status=${status}`).toBe(true);
    }
  });

  it('does not count an inactive member (0 / "Inactive") as active', async () => {
    for (const status of [0, 'Inactive']) {
      const client = createMockClient();
      client.get = vi.fn().mockImplementation(async (_ctx, path) => {
        if (path === '/api/People/GetCurrentPerson') {
          return { Id: 1, PrimaryAliasId: 10, Guid: '550e8400-e29b-41d4-a716-446655440001' };
        }
        if (path.includes('/api/Groups')) {
          return [{ Id: 99, Name: 'RSR - Rock Administration' }];
        }
        if (path.includes('/api/GroupMembers')) {
          return [{ Id: 1001, PersonId: 1, GroupId: 99, GroupMemberStatus: status }];
        }
        return [];
      });
      const result = await new RockUserResolver(client).resolve(mockCtx, {
        subject: `inactive-${status}`,
        email: 'inactive@example.com',
      });
      expect(result.isRsrAdmin, `status=${status}`).toBe(false);
    }
  });

  it('uses the user token for the RSR lookup and fails closed when Rock denies it', async () => {
    const oauth = {
      subject: 'user-non-admin',
      email: 'member@example.com',
      accessTokenHash: 'hash',
    };

    mockClient.get = vi.fn().mockImplementation(async (_ctx, path) => {
      if (path === '/api/People/GetCurrentPerson') {
        return { Id: 4, PrimaryAliasId: 40, Guid: '550e8400-e29b-41d4-a716-446655440004' };
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
      if (path === '/api/People/GetCurrentPerson') {
        return { Id: 5, PrimaryAliasId: 50, Guid: '550e8400-e29b-41d4-a716-446655440005' };
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
        if (path === '/api/People/GetCurrentPerson') {
          return { Id: 7, PrimaryAliasId: 70, Guid: '550e8400-e29b-41d4-a716-446655440007' };
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
        if (path === '/api/People/GetCurrentPerson') {
          return { Id: 8, PrimaryAliasId: 80, Guid: '550e8400-e29b-41d4-a716-446655440008' };
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
        if (path === '/api/People/GetCurrentPerson') {
          return { Id: 9, PrimaryAliasId: 90, Guid: '550e8400-e29b-41d4-a716-446655440009' };
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
          if (path === '/api/People/GetCurrentPerson') {
            return { Id: 11, PrimaryAliasId: 110, Guid: '550e8400-e29b-41d4-a716-446655440011' };
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

describe('ledGroupIds / getLedGroupIds', () => {
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

  /**
   * Builds a mock client for a single non-admin, non-staff person whose
   * leadership GroupMembers query either returns `leadershipResult` (an array
   * of raw GroupMember rows) or throws it (if it's an Error).
   */
  function nonAdminClient(personId: number, leadershipResult: any[] | Error): RockClient {
    const client = createMockClient();
    client.get = vi.fn().mockImplementation(async (_ctx, path: string) => {
      if (path === '/api/People/GetCurrentPerson') {
        return { Id: personId, PrimaryAliasId: personId * 10, Guid: `guid-${personId}` };
      }
      if (path.includes('/api/Groups')) {
        // No RSR admin / staff role groups exist for this person — isRsrAdmin
        // and isStaff both resolve to false without ever hitting GroupMembers
        // for those checks.
        return [];
      }
      if (path.includes('/api/GroupMembers')) {
        // The leadership query is the only GroupMembers call reachable here.
        // GroupMemberStatus/IsLeader are legitimately in $select — the
        // constraint is that the $filter clause itself must never compare
        // either enum (that 400s on Rock's EDM string typing).
        const [, filterAndRest = ''] = path.split('$filter=');
        const filterClause = filterAndRest.split('&')[0];
        expect(filterClause).toBe(`PersonId eq ${personId}`);
        expect(path).toContain('$expand=GroupRole');
        if (leadershipResult instanceof Error) throw leadershipResult;
        return leadershipResult;
      }
      return [];
    });
    return client;
  }

  beforeEach(() => {
    mockClient = createMockClient();
    resolver = new RockUserResolver(mockClient);
  });

  it('includes only active+leader rows and dedupes GroupId', async () => {
    const rows = [
      { GroupId: 10, GroupMemberStatus: 'Active', GroupRole: { IsLeader: true } },
      { GroupId: 10, GroupMemberStatus: 1, GroupRole: { IsLeader: true } }, // duplicate group, active leader
      { GroupId: 20, GroupMemberStatus: 'Inactive', GroupRole: { IsLeader: true } }, // inactive leader — excluded
      { GroupId: 30, GroupMemberStatus: 'Active', GroupRole: { IsLeader: false } }, // active non-leader — excluded
    ];
    resolver = new RockUserResolver(nonAdminClient(1, rows));

    const result = await resolver.resolve(mockCtx, { subject: 'leader-1', email: 'leader1@example.com' });

    expect(result.ledGroupIds).toEqual([10]);
  });

  it('counts both GroupMemberStatus enum representations (1 and "Active")', async () => {
    const rows = [
      { GroupId: 40, GroupMemberStatus: 1, GroupRole: { IsLeader: true } },
      { GroupId: 41, GroupMemberStatus: 'Active', GroupRole: { IsLeader: true } },
    ];
    resolver = new RockUserResolver(nonAdminClient(2, rows));

    const result = await resolver.resolve(mockCtx, { subject: 'leader-2', email: 'leader2@example.com' });

    expect(result.ledGroupIds?.sort()).toEqual([40, 41]);
  });

  it('fails closed to [] when the leadership lookup throws, and resolve() still succeeds', async () => {
    resolver = new RockUserResolver(nonAdminClient(3, new Error('500 Internal Server Error')));

    const result = await resolver.resolve(mockCtx, { subject: 'leader-3', email: 'leader3@example.com' });

    expect(result.personId).toBe(3);
    expect(result.ledGroupIds).toEqual([]);
  });

  it('discards led-group results for admins after concurrent authorization lookups', async () => {
    const leadershipQuery = vi.fn();
    mockClient.get = vi.fn().mockImplementation(async (_ctx, path: string) => {
      if (path === '/api/People/GetCurrentPerson') {
        return { Id: 6, PrimaryAliasId: 60, Guid: 'guid-6' };
      }
      if (path.includes('/api/Groups')) {
        if (path.includes('Rock Administration')) return [{ Id: 99, Name: 'RSR - Rock Administration' }];
        return [];
      }
      if (path.includes('$expand=GroupRole')) {
        leadershipQuery(path);
        return [{ GroupId: 999, GroupMemberStatus: 'Active', GroupRole: { IsLeader: true } }];
      }
      if (path.includes('/api/GroupMembers')) {
        // Admin role-membership check for group 99.
        if (path.includes('GroupId eq 99')) {
          return [{ Id: 1, PersonId: 6, GroupId: 99, GroupMemberStatus: 1 }];
        }
        return [];
      }
      return [];
    });

    const result = await resolver.resolve(mockCtx, { subject: 'admin-1', email: 'admin1@example.com' });

    expect(result.isRsrAdmin).toBe(true);
    expect(result.ledGroupIds).toEqual([]);
    expect(leadershipQuery).toHaveBeenCalledTimes(1);
  });

  it('is always present ([]) on a resolved non-admin, non-leader user', async () => {
    resolver = new RockUserResolver(nonAdminClient(7, []));

    const result = await resolver.resolve(mockCtx, { subject: 'plain-1', email: 'plain1@example.com' });

    expect(result.ledGroupIds).toEqual([]);
    expect(result.ledGroupIds).not.toBeUndefined();
  });
});

describe('isActiveGroupMemberStatus', () => {
  it('accepts both the integer and string "Active" representations', () => {
    expect(isActiveGroupMemberStatus(1)).toBe(true);
    expect(isActiveGroupMemberStatus('Active')).toBe(true);
  });

  it('rejects inactive, unknown, and missing values', () => {
    for (const v of [0, 'Inactive', 2, '1', null, undefined, {}]) {
      expect(isActiveGroupMemberStatus(v), `value=${JSON.stringify(v)}`).toBe(false);
    }
  });
});
