import { RockClient } from '../rock/client.js';
import { OAuthRockContext } from '../http/oauth.js';
import { quoteODataString, assertValidGuid } from '../rock/query.js';

/**
 * True if a GroupMember's `GroupMemberStatus` represents "Active". Rock's enum
 * has serialized both ways across instances/paths — integer `1` (JSON model
 * binding) and string `'Active'` (some OData/EDM responses) — so accept both.
 * Never compare this enum to an integer inside an OData `$filter`; the EDM type
 * is string and Rock 400s (see CLAUDE.md "Known Rock API quirks").
 */
export function isActiveGroupMemberStatus(status: unknown): boolean {
  return status === 1 || status === 'Active';
}

export interface ResolvedRockUser {
  personId?: number;
  personGuid?: string;
  personAliasId?: number;
  userLoginId?: number;
  userName?: string;
  /** Member of the `RSR - Rock Administration` security role. */
  isRsrAdmin: boolean;
  /**
   * Member of a Rock staff security role (see {@link RockUserResolver} —
   * `RSR - Staff Workers` / `RSR - Staff Like Workers` by default, overridable
   * via `ROCK_STAFF_ROLE_NAMES`). Admins are treated as staff too.
   */
  isStaff: boolean;
  /**
   * Ids of groups this person actively leads (active membership + leader
   * role), used by later tasks to authorize non-admin leader-scoped writes.
   * Always present (never `undefined`) — `[]` for admins (who don't need it;
   * their authority comes from `isRsrAdmin`) and for anyone the lookup fails
   * to confirm as a leader.
   */
  ledGroupIds: number[];
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class RockUserResolver {
  private static RSR_ROLE_NAME = 'RSR - Rock Administration';
  /**
   * Default staff security roles. Membership in ANY of these (via the user's
   * own forwarded token) grants read access. Override the set with the
   * comma-separated `ROCK_STAFF_ROLE_NAMES` env var.
   */
  private static DEFAULT_STAFF_ROLE_NAMES = ['RSR - Staff Workers', 'RSR - Staff Like Workers'];
  private cache = new Map<string, CacheEntry<any>>();

  /** Resolve the configured staff role names (env override or defaults). */
  private staffRoleNames(): string[] {
    const raw = process.env.ROCK_STAFF_ROLE_NAMES?.trim();
    if (!raw) {
      return RockUserResolver.DEFAULT_STAFF_ROLE_NAMES;
    }
    const names = raw
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    return names.length > 0 ? names : RockUserResolver.DEFAULT_STAFF_ROLE_NAMES;
  }

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

    // 1. Ask Rock who the Bearer token belongs to. Rock validates the JWT via
    // its JSON Web Token Configuration and resolves the person through the
    // Auth0 person search key, so this works even when the access token
    // carries no email claim (Auth0 puts email only in the id_token).
    try {
      const me = await this.rockClient.get<any>(ctx, '/api/People/GetCurrentPerson');
      if (me && me.Id) {
        person = me;
      }
    } catch {
      // Ignore — fall back to claim-based lookups
    }

    // 2. Resolve by explicit Guid claim if present
    if (!person && oauth.rockPersonGuid) {
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

    // 3. Fallback to resolving by email
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
      isStaff: false,
      ledGroupIds: [],
    };

    if (person) {
      resolved.personId = person.Id;
      resolved.personGuid = person.Guid;
      resolved.personAliasId = person.PrimaryAliasId || person.Id;

      resolved.isRsrAdmin = await this.checkRsrAdmin(ctx, person.Id);
      // Admins are a privilege superset of staff, so skip the extra staff
      // lookups for them and treat them as staff.
      resolved.isStaff = resolved.isRsrAdmin ? true : await this.checkStaff(ctx, person.Id);
      // Admins override every write via isRsrAdmin, so they don't need their
      // led-group set — skip the extra lookup for them.
      resolved.ledGroupIds = resolved.isRsrAdmin ? [] : await this.getLedGroupIds(ctx, person.Id);
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
    return this.isActiveRoleMember(ctx, personId, RockUserResolver.RSR_ROLE_NAME);
  }

  /**
   * Checks staff membership: true if the person is an active member of ANY
   * configured staff role. Uses the user's own forwarded token and fails closed
   * (false) on any denied/failed lookup, exactly like the admin check.
   */
  private async checkStaff(ctx: OAuthRockContext, personId: number): Promise<boolean> {
    for (const roleName of this.staffRoleNames()) {
      if (await this.isActiveRoleMember(ctx, personId, roleName)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Returns true if `personId` is an Active member of the named Rock security
   * role. Group-id and membership results are cached. Any Rock error fails
   * closed (treated as "not a member"), which is the safe default for a gate.
   */
  private async isActiveRoleMember(ctx: OAuthRockContext, personId: number, roleName: string): Promise<boolean> {
    const membershipCacheKey = `role-membership:${personId}:${roleName}`;
    const cached = this.getCached<boolean>(membershipCacheKey);
    if (cached !== null) return cached;

    try {
      const groupId = await this.resolveRoleGroupId(ctx, roleName);
      if (!groupId) {
        return false;
      }

      let isMember = false;
      try {
        // GroupMemberStatus is an enum whose OData/EDM representation has
        // differed across Rock instances (string 'Active' vs integer 1) —
        // comparing it in the $filter has broken this gate both ways (400 type
        // error / empty match). Filter by group+person only (at most a handful
        // of rows) and check status client-side.
        const members = await this.rockClient.get<any[]>(
          ctx,
          `/api/GroupMembers?$filter=GroupId eq ${groupId} and PersonId eq ${personId}`
        );
        isMember = (members ?? []).some((m) => isActiveGroupMemberStatus(m.GroupMemberStatus));
      } catch {
        // Ignore — denied lookups mean "not a member"
      }

      this.setCached(membershipCacheKey, isMember, 300000);
      return isMember;
    } catch {
      return false;
    }
  }

  /**
   * Returns the ids of groups `personId` actively leads (active membership +
   * leader role), deduped. Uses the user's own forwarded token — there is no
   * admin API key. The `$filter` scopes by `PersonId` only (never compare the
   * `GroupMemberStatus` enum inside an OData `$filter` — the EDM type is
   * string and Rock 400s); active + leader is checked client-side via
   * {@link isActiveGroupMemberStatus} and `GroupRole?.IsLeader`. Fails closed
   * to `[]` on any Rock error, which is the safe default for a write gate.
   */
  private async getLedGroupIds(ctx: OAuthRockContext, personId: number): Promise<number[]> {
    const cacheKey = `led-group-ids:${personId}`;
    const cached = this.getCached<number[]>(cacheKey);
    if (cached !== null) return cached;

    let ledGroupIds: number[] = [];
    try {
      const members = await this.rockClient.get<any[]>(
        ctx,
        `/api/GroupMembers?$filter=PersonId eq ${personId}&$expand=GroupRole&$select=GroupId,GroupMemberStatus,GroupRole/IsLeader&$top=200`
      );
      const groupIds = new Set<number>();
      for (const m of members ?? []) {
        if (isActiveGroupMemberStatus(m.GroupMemberStatus) && m.GroupRole?.IsLeader === true) {
          groupIds.add(m.GroupId);
        }
      }
      ledGroupIds = Array.from(groupIds);
    } catch {
      // Ignore — denied/failed lookups mean "leads nothing" (fail closed)
    }

    this.setCached(cacheKey, ledGroupIds, 900000);
    return ledGroupIds;
  }

  /** Resolves (and caches) the group Id for a named security role. */
  private async resolveRoleGroupId(ctx: OAuthRockContext, roleName: string): Promise<number | null> {
    const groupCacheKey = `role-group-id:${roleName}`;
    let groupId = this.getCached<number>(groupCacheKey);
    if (groupId) return groupId;

    try {
      const groups = await this.rockClient.get<any[]>(
        ctx,
        `/api/Groups?$filter=Name eq ${quoteODataString(roleName)}`
      );
      if (groups && groups.length > 0) {
        groupId = groups[0].Id;
      }
    } catch {
      // Ignore — user may not have permission to read groups
    }

    if (groupId) {
      this.setCached(groupCacheKey, groupId, 3600000);
    }
    return groupId ?? null;
  }
}
