import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-ignore
import { RockUserResolver } from './rock-user-resolver.js';
// @ts-ignore
import { RockClient } from '../rock/client.js';
// @ts-ignore
import { OAuthRockContext } from '../http/oauth.js';

describe('RockUserResolver', () => {
  let mockClient: RockClient;
  let resolver: RockUserResolver;
  const mockCtx = {} as OAuthRockContext;

  beforeEach(() => {
    mockClient = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    };
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
});
