import { RockClient } from '../rock/client.js';
import { OAuthRockContext } from '../http/oauth.js';
import { quoteODataString, assertValidGuid } from '../rock/query.js';

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

    // Rock v1 (OData) only — the v2 REST API is unavailable on this instance
    // (401s even with valid credentials).

    // 1. Resolve by explicit Guid claim if present
    if (oauth.rockPersonGuid) {
      const validGuid = assertValidGuid(oauth.rockPersonGuid);
      try {
        const results = await this.rockClient.get<any[]>(ctx, `/api/People?$filter=Guid eq guid${quoteODataString(validGuid)}`);
        if (results && results.length > 0) {
          person = results[0];
        }
      } catch {
        // Ignore
      }
    }

    // 2. Fallback to resolving by email
    if (!person && oauth.email) {
      try {
        const results = await this.rockClient.get<any[]>(ctx, `/api/People?$filter=Email eq ${quoteODataString(oauth.email)}`);
        if (results && results.length > 0) {
          person = results[0];
        }
      } catch {
        // Ignore
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

  /**
   * Checks RSR admin membership using the user's OWN forwarded token — there
   * is no admin API key. If Rock denies the lookup (401/403), the user is
   * treated as non-admin, which is the safe default.
   */
  private async checkRsrAdmin(ctx: OAuthRockContext, personId: number): Promise<boolean> {
    const lookupClient = this.rockClient;
    const cacheKey = `rsr-membership:${personId}`;
    const cached = this.getCached<boolean>(cacheKey);
    if (cached !== null) return cached;

    try {
      const groupCacheKey = `rsr-group-id`;
      let groupId = this.getCached<number>(groupCacheKey);

      if (!groupId) {
        try {
          const groups = await lookupClient.get<any[]>(ctx, `/api/Groups?$filter=Name eq ${quoteODataString(RockUserResolver.RSR_ROLE_NAME)}`);
          if (groups && groups.length > 0) {
            groupId = groups[0].Id;
          }
        } catch {
          // Ignore — user may not have permission to read groups (non-admin)
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
        const members = await lookupClient.get<any[]>(ctx, `/api/GroupMembers?$filter=GroupId eq ${groupId} and PersonId eq ${personId} and GroupMemberStatus eq 'Active'`);
        isMember = members && members.length > 0;
      } catch {
        // Ignore — denied lookups mean "not admin"
      }

      this.setCached(cacheKey, isMember, 300000);
      return isMember;
    } catch {
      return false;
    }
  }
}
