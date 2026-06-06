import { RockClient } from '../rock/client.js';
import { OAuthRockContext } from '../http/oauth.js';
import { quoteLinqString, quoteODataString, assertValidGuid } from '../rock/query.js';

export interface ResolvedRockUser {
  personId?: number;
  personGuid?: string;
  personAliasId?: number;
  userLoginId?: number;
  userName?: string;
  isRsrAdmin: boolean;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class RockUserResolver {
  private static RSR_ROLE_NAME = 'RSR - Rock Administration';
  private cache = new Map<string, CacheEntry<any>>();

  constructor(private rockClient: RockClient) {}

  private getCached<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  private setCached<T>(key: string, value: T, ttlMs: number): void {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  public async resolve(
    ctx: OAuthRockContext,
    oauth: { subject: string; email?: string; rockPersonGuid?: string }
  ): Promise<ResolvedRockUser> {
    const cacheKey = `user-resolution:${oauth.subject}`;
    const cached = this.getCached<ResolvedRockUser>(cacheKey);
    if (cached) return cached;

    let person: any = null;

    // 1. Resolve by explicit Guid claim if present
    if (oauth.rockPersonGuid) {
      const validGuid = assertValidGuid(oauth.rockPersonGuid);
      try {
        const results = await this.rockClient.post<any[]>(ctx, '/api/v2/models/people/search', {
          Where: `Guid == ${quoteLinqString(validGuid)}`,
        });
        if (results && results.length > 0) {
          person = results[0];
        }
      } catch {
        try {
          const results = await this.rockClient.get<any[]>(ctx, `/api/People?$filter=Guid eq guid${quoteODataString(validGuid)}`);
          if (results && results.length > 0) {
            person = results[0];
          }
        } catch {
          // Ignore
        }
      }
    }

    // 2. Fallback to resolving by email
    if (!person && oauth.email) {
      try {
        const results = await this.rockClient.post<any[]>(ctx, '/api/v2/models/people/search', {
          Where: `Email == ${quoteLinqString(oauth.email)}`,
        });
        if (results && results.length > 0) {
          person = results[0];
        }
      } catch {
        try {
          const results = await this.rockClient.get<any[]>(ctx, `/api/People?$filter=Email eq ${quoteODataString(oauth.email)}`);
          if (results && results.length > 0) {
            person = results[0];
          }
        } catch {
          // Ignore
        }
      }
    }

    const resolved: ResolvedRockUser = {
      isRsrAdmin: false,
    };

    if (person) {
      resolved.personId = person.Id;
      resolved.personGuid = person.Guid;
      resolved.personAliasId = person.PrimaryAliasId || person.Id;

      resolved.isRsrAdmin = await this.checkRsrAdmin(ctx, person.Id);
    }

    // Cache user resolution for 15 minutes
    this.setCached(cacheKey, resolved, 900000);

    return resolved;
  }

  private async checkRsrAdmin(ctx: OAuthRockContext, personId: number): Promise<boolean> {
    const cacheKey = `rsr-membership:${personId}`;
    const cached = this.getCached<boolean>(cacheKey);
    if (cached !== null) return cached;

    try {
      const groupCacheKey = `rsr-group-id`;
      let groupId = this.getCached<number>(groupCacheKey);

      if (!groupId) {
        try {
          const groups = await this.rockClient.post<any[]>(ctx, '/api/v2/models/groups/search', {
            Where: `Name == ${quoteLinqString(RockUserResolver.RSR_ROLE_NAME)}`,
          });
          if (groups && groups.length > 0) {
            groupId = groups[0].Id;
          }
        } catch {
          try {
            const groups = await this.rockClient.get<any[]>(ctx, `/api/Groups?$filter=Name eq ${quoteODataString(RockUserResolver.RSR_ROLE_NAME)}`);
            if (groups && groups.length > 0) {
              groupId = groups[0].Id;
            }
          } catch {
            // Ignore
          }
        }
        if (groupId) {
          this.setCached(groupCacheKey, groupId, 3600000);
        }
      }

      if (!groupId) {
        return false;
      }

      let isMember = false;
      try {
        const members = await this.rockClient.post<any[]>(ctx, '/api/v2/models/groupmembers/search', {
          Where: `GroupId == ${groupId} && PersonId == ${personId} && GroupMemberStatus == 1`,
        });
        isMember = members && members.length > 0;
      } catch {
        try {
          const members = await this.rockClient.get<any[]>(ctx, `/api/GroupMembers?$filter=GroupId eq ${groupId} and PersonId eq ${personId} and GroupMemberStatus eq 1`);
          isMember = members && members.length > 0;
        } catch {
          // Ignore
        }
      }

      this.setCached(cacheKey, isMember, 300000);
      return isMember;
    } catch {
      return false;
    }
  }
}
