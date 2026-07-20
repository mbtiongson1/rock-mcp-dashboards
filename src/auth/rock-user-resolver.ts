import * as crypto from 'crypto';
import type { Redis } from '@upstash/redis';
import { RockClient, RockApiError } from '../rock/client.js';
import { OAuthRockContext } from '../http/oauth.js';
import { quoteODataString } from '../rock/query.js';
import { getRedisPrefix } from '../rock/redis.js';
import { hashOAuthSubject } from './audit.js';

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

/** True when an error is a Rock 401 (forwarded token rejected by Rock). */
function isRockUnauthorized(err: unknown): boolean {
  return err instanceof RockApiError && err.status === 401;
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
  /**
   * Telemetry ONLY: true when Rock rejected the forwarded token with a 401
   * during resolution (GetCurrentPerson). Used to disambiguate the recurring
   * 401 bursts in logs — it MUST NOT influence any authorization decision;
   * resolution still fails closed exactly as before.
   */
  tokenRejectedByRock?: boolean;
}

interface PersonMetadata {
  personGuid?: string;
  personAliasId?: number;
}

interface PersonMetadataCacheRecord {
  version: 1;
  expiresAt: number;
  metadata: PersonMetadata;
}

const PERSON_METADATA_TTL_SECONDS = 900;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function parsePersonMetadataCacheRecord(
  cached: unknown,
  now: number
): PersonMetadataCacheRecord | null {
  try {
    const parsed = typeof cached === 'string' ? JSON.parse(cached) as unknown : cached;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1) return null;
    if (typeof record.expiresAt !== 'number' || !Number.isFinite(record.expiresAt) || record.expiresAt <= now) {
      return null;
    }
    if (!record.metadata || typeof record.metadata !== 'object') return null;
    const metadata = record.metadata as Record<string, unknown>;
    if (metadata.personGuid !== undefined && (typeof metadata.personGuid !== 'string' || metadata.personGuid.length === 0)) {
      return null;
    }
    if (metadata.personAliasId !== undefined && !isPositiveInteger(metadata.personAliasId)) return null;
    if (metadata.personGuid === undefined && metadata.personAliasId === undefined) return null;
    return record as unknown as PersonMetadataCacheRecord;
  } catch {
    return null;
  }
}

export class RockUserResolver {
  private static RSR_ROLE_NAME = 'RSR - Rock Administration';
  /**
   * Default staff security roles. Membership in ANY of these (via the user's
   * own forwarded token) grants read access. Override the set with the
   * comma-separated `ROCK_STAFF_ROLE_NAMES` env var.
   */
  private static DEFAULT_STAFF_ROLE_NAMES = ['RSR - Staff Workers', 'RSR - Staff Like Workers'];

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

  constructor(
    private rockClient: RockClient,
    private redis: Redis | null = null,
    private redisPrefix: string = getRedisPrefix()
  ) {}

  private getPersonMetadataCacheKey(personId: number): string {
    const rockBaseUrlHash = crypto
      .createHash('sha256')
      .update(this.rockClient.baseUrl || 'default-rock-server')
      .digest('hex')
      .slice(0, 16);
    const personIdHash = crypto.createHash('sha256').update(String(personId)).digest('hex').slice(0, 16);
    return `${this.redisPrefix}person-metadata:v1:${rockBaseUrlHash}:${personIdHash}`;
  }

  /**
   * Resolves optional profile metadata that no login or write gate reads.
   * Live values win over Redis, and Redis failures simply leave the live
   * identity and privilege checks unaffected.
   */
  private async resolvePersonMetadata(person: any): Promise<PersonMetadata> {
    const liveMetadata: PersonMetadata = {
      ...(typeof person.Guid === 'string' && person.Guid.length > 0 ? { personGuid: person.Guid } : {}),
      ...(isPositiveInteger(person.PrimaryAliasId) ? { personAliasId: person.PrimaryAliasId } : {}),
    };
    let cachedRecord: PersonMetadataCacheRecord | null = null;
    const cacheKey = this.getPersonMetadataCacheKey(person.Id);

    if (this.redis) {
      try {
        const redisValue = await this.redis.get<unknown>(cacheKey);
        cachedRecord = parsePersonMetadataCacheRecord(redisValue, Date.now());
      } catch {
        // Redis is only an optimization. Keep the live metadata on read failure.
      }
    }

    const metadata = { ...(cachedRecord?.metadata ?? {}), ...liveMetadata };
    const liveMetadataChanged =
      cachedRecord === null ||
      (liveMetadata.personGuid !== undefined && liveMetadata.personGuid !== cachedRecord.metadata.personGuid) ||
      (liveMetadata.personAliasId !== undefined && liveMetadata.personAliasId !== cachedRecord.metadata.personAliasId);
    if (
      this.redis &&
      liveMetadataChanged &&
      (liveMetadata.personGuid !== undefined || liveMetadata.personAliasId !== undefined)
    ) {
      const record: PersonMetadataCacheRecord = {
        version: 1,
        expiresAt: Date.now() + PERSON_METADATA_TTL_SECONDS * 1000,
        metadata,
      };
      try {
        await this.redis.set(cacheKey, JSON.stringify(record), { ex: PERSON_METADATA_TTL_SECONDS });
      } catch {
        // Profile metadata remains available from the live response when Redis is down.
      }
    }

    return metadata;
  }

  public async resolve(
    ctx: OAuthRockContext,
    oauth: { subject: string; email?: string; rockPersonGuid?: string }
  ): Promise<ResolvedRockUser> {
    let person: any = null;

    // Rock v1 (OData) only — the v2 REST API is unavailable on this instance
    // (401s even with valid credentials).

    // Ask Rock who the Bearer token belongs to on every request. Rock validates the JWT via
    // its JSON Web Token Configuration and resolves the person through the
    // Auth0 person search key. This live binding is authoritative: claim-based
    // fallbacks could preserve a stale subject-to-person mapping when this
    // lookup fails, so failure leaves the user unresolved and denies access.
    let tokenRejectedByRock = false;
    try {
      const me = await this.rockClient.get<any>(ctx, '/api/People/GetCurrentPerson');
      if (me && me.Id) {
        person = me;
      }
    } catch (err) {
      if (isRockUnauthorized(err)) {
        tokenRejectedByRock = true;
        // Correlatable log line: a burst of these means Rock is rejecting
        // forwarded tokens (hypothesis c), as opposed to the client's own token
        // expiring at rock-mcp's gate (hypothesis a — that path never reaches here).
        console.warn(
          '[rock-user-resolver] Rock rejected forwarded token (401) during GetCurrentPerson; user left unresolved (fail-closed)',
          { subjectHash: hashOAuthSubject(oauth.subject) }
        );
      }
      // Ignore — unresolved is the fail-closed result below.
    }

    const resolved: ResolvedRockUser = {
      isRsrAdmin: false,
      isStaff: false,
      ledGroupIds: [],
      tokenRejectedByRock,
    };

    if (person) {
      resolved.personId = person.Id;

      // These checks and the inert metadata lookup depend only on the resolved
      // person id, not on each other, so keep them concurrent.
      const [metadata, isRsrAdmin, isStaff, ledGroupIds] = await Promise.all([
        this.resolvePersonMetadata(person),
        this.checkRsrAdmin(ctx, person.Id),
        this.checkStaff(ctx, person.Id),
        this.getLedGroupIds(ctx, person.Id),
      ]);
      resolved.personGuid = metadata.personGuid;
      resolved.personAliasId = metadata.personAliasId ?? person.Id;
      resolved.isRsrAdmin = isRsrAdmin;
      resolved.isStaff = isRsrAdmin || isStaff;
      resolved.ledGroupIds = isRsrAdmin ? [] : ledGroupIds;
    }

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
    const memberships = await Promise.all(
      this.staffRoleNames().map((roleName) => this.isActiveRoleMember(ctx, personId, roleName))
    );
    return memberships.some(Boolean);
  }

  /**
   * Returns true if `personId` is an Active member of the named Rock security
   * role. Both the role-group mapping and membership are queried live on every
   * request. Any Rock error fails closed (treated as "not a member"), which is
   * the safe default for a gate.
   */
  private async isActiveRoleMember(ctx: OAuthRockContext, personId: number, roleName: string): Promise<boolean> {
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

    return ledGroupIds;
  }

  /** Resolves the group Id for a named security role live on every request. */
  private async resolveRoleGroupId(ctx: OAuthRockContext, roleName: string): Promise<number | null> {
    let groupId: number | undefined;

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

    return groupId ?? null;
  }
}
