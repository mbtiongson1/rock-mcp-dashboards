import { z } from 'zod';
import { GatewayTool, McpToolResult } from './types.js';
import { McpMode, McpScope } from '../mcp/modes.js';
import { OAuthRockContext } from '../http/oauth.js';
import { formatResponse } from './formatter.js';
import { RockClient } from '../rock/client.js';
import { quoteLinqString, quoteODataString, assertValidGuid, odataPagination } from '../rock/query.js';
import { AuditLogger } from '../auth/audit.js';
import { authorizeWrite } from '../auth/authorization.js';
import { getDefinedValueMap, resolveDefinedValueIdByName } from '../rock/defined-values.js';

// Named constants
const FAMILY_GROUP_TYPE_NAME = 'Family';
const ATTENDANCE_REGULAR_RATIO = 0.5; // >= 50% of weeks => 'Regular'

/**
 * Person reference accepted by read actions. Liberal in what it accepts so
 * first-time agent calls succeed: a plain object ({ id | guid | search }), a
 * bare number/numeric string (treated as id), a name string (treated as
 * search), or a JSON-stringified object (a common LLM-client failure mode).
 */
const personRefSchema = z.preprocess(
  (value) => {
    if (typeof value === 'number') return { id: value };
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (/^\d+$/.test(trimmed)) return { id: Number(trimmed) };
      if (trimmed.startsWith('{')) {
        try {
          return JSON.parse(trimmed);
        } catch {
          return { search: trimmed };
        }
      }
      return { search: trimmed };
    }
    return value;
  },
  z.object({
    id: z.coerce.number().optional().describe('Rock person ID.'),
    guid: z.string().optional().describe('Rock person GUID.'),
    search: z.string().optional().describe("Full or partial name, e.g. 'Alex Santos'."),
  })
).describe("Who to look up: { id } | { guid } | { search: 'Full Name' }. A bare name string or numeric ID is also accepted.");

// Read-only action schemas
const readOnlyPeopleActions = [
  z.object({
    action: z.literal('find'),
    query: z.string().min(1).describe("Name fragment to search for, e.g. 'San' matches 'Santos'."),
    limit: z.coerce.number().int().positive().max(100).default(20),
  }),
  z.object({
    action: z.literal('profile'),
    person: personRefSchema,
    include: z.array(z.enum(['groups', 'family', 'connectionStatus', 'attendanceSummary', 'servingSummary'])).optional(),
    includeSensitive: z.boolean().default(false).describe('Include email, phone, birthdate. Requires readwrite mode + staff/admin; otherwise omitted with a warning.'),
  }),
  z.object({
    action: z.literal('groups'),
    person: personRefSchema,
  }),
  z.object({
    action: z.literal('family'),
    person: personRefSchema,
  }),
  z.object({
    action: z.literal('connectionStatus'),
    person: personRefSchema,
  }),
  z.object({
    action: z.literal('attendanceSummary'),
    person: personRefSchema,
    windowWeeks: z.coerce.number().int().positive().max(52).default(12),
  }),
  z.object({
    action: z.literal('servingSummary'),
    person: personRefSchema,
  }),
  z.object({
    action: z.literal('filter'),
    campusId: z.coerce.number().int().positive().optional()
      .describe('Campus ID to filter by. Use campusName instead if you only know the name.'),
    campusName: z.string().min(1).optional()
      .describe("Campus name (e.g. 'Manila'); resolved to an ID via discovery, case-insensitive."),
    connectionStatus: z.string().min(1).optional()
      .describe("Connection status name (e.g. 'New', 'Crowd', 'Core', 'Leader'; case-insensitive) or numeric DefinedValue ID."),
    isActive: z.coerce.boolean().optional()
      .describe('Filter by record status: true = Active records only, false = non-active only.'),
    countOnly: z.coerce.boolean().default(false)
      .describe('Return only the true total count without fetching rows.'),
    limit: z.coerce.number().int().positive().max(500).default(50)
      .describe('Page size (max 500). The response always includes the true total.'),
    offset: z.coerce.number().int().nonnegative().default(0)
      .describe('Pagination offset; combine with limit to page through all matches.'),
  }),
] as const;

// Write action schemas
const writeActions = [
  z.object({
    action: z.literal('updateContactInfo'),
    personId: z.coerce.number().optional(),
    personGuid: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    dryRun: z.boolean().default(true).describe('Preview-only by default. Set dryRun:false AND commit:true to apply.'),
    commit: z.boolean().default(false).describe('Must be true (with dryRun:false) to actually write.'),
    reason: z.string().min(1).describe('Required justification for the change; recorded in the audit log.'),
  }),
  z.object({
    action: z.literal('patchAttributes'),
    personId: z.coerce.number().optional(),
    personGuid: z.string().optional(),
    attributes: z.record(z.string(), z.unknown()),
    dryRun: z.boolean().default(true).describe('Preview-only by default. Set dryRun:false AND commit:true to apply.'),
    commit: z.boolean().default(false).describe('Must be true (with dryRun:false) to actually write.'),
    reason: z.string().min(1).describe('Required justification for the change; recorded in the audit log.'),
  }),
  z.object({
    action: z.literal('createNote'),
    personId: z.coerce.number().optional(),
    personGuid: z.string().optional(),
    text: z.string().min(1),
    noteType: z.string().optional(),
    dryRun: z.boolean().default(true).describe('Preview-only by default. Set dryRun:false AND commit:true to apply.'),
    commit: z.boolean().default(false).describe('Must be true (with dryRun:false) to actually write.'),
    reason: z.string().min(1).describe('Required justification for the change; recorded in the audit log.'),
  }),
  z.object({
    action: z.literal('createFollowUpTask'),
    personId: z.coerce.number().optional(),
    personGuid: z.string().optional(),
    title: z.string().min(1),
    description: z.string().optional(),
    assignedToId: z.coerce.number().optional(),
    connectionOpportunityId: z.coerce.number().optional(),
    dryRun: z.boolean().default(true).describe('Preview-only by default. Set dryRun:false AND commit:true to apply.'),
    commit: z.boolean().default(false).describe('Must be true (with dryRun:false) to actually write.'),
    reason: z.string().min(1).describe('Required justification for the change; recorded in the audit log.'),
  }),
] as const;

const rockPeopleSchema = z.discriminatedUnion('action', [
  ...readOnlyPeopleActions,
  ...writeActions,
]);

const auditLogger = new AuditLogger();

/**
 * Get discovery service from context with proper typing.
 */
function getDiscoveryService(ctx: OAuthRockContext): any {
  return (ctx as any).discoveryService;
}

/**
 * Search people by name with v2 LINQ, falling back to v1 OData.
 * Handles full names ("First Last") on the v1 path by splitting into
 * first/last tokens — v1 has no string-concatenation filter, so an exact
 * match on the full string would never succeed there.
 */
async function searchPeopleByName(client: RockClient, ctx: OAuthRockContext, search: string): Promise<any[]> {
  try {
    const quoted = quoteLinqString(search);
    return await client.post(ctx, '/api/v2/models/people/search', {
      Where: `NickName == ${quoted} || LastName == ${quoted} || (NickName + " " + LastName) == ${quoted}`,
    });
  } catch {
    const parts = search.trim().split(/\s+/);
    let odataFilter: string;
    if (parts.length >= 2) {
      const first = parts[0];
      const last = parts.slice(1).join(' ');
      odataFilter =
        `((NickName eq ${quoteODataString(first)}) or (FirstName eq ${quoteODataString(first)})) and (LastName eq ${quoteODataString(last)})`;
    } else {
      odataFilter = `(NickName eq ${quoteODataString(search)}) or (LastName eq ${quoteODataString(search)})`;
    }
    return await client.get(ctx, `/api/People?$filter=${encodeURIComponent(odataFilter)}`);
  }
}

async function resolvePersonId(client: RockClient, ctx: OAuthRockContext, person: { id?: number; guid?: string; search?: string }): Promise<number | null> {
  if (person.id) return person.id;
  if (person.guid) {
    const validGuid = assertValidGuid(person.guid);
    let results: any[];
    try {
      results = await client.post(ctx, '/api/v2/models/people/search', { Where: `Guid == ${quoteLinqString(validGuid)}` });
    } catch {
      results = await client.get(ctx, `/api/People?$filter=Guid eq guid${quoteODataString(validGuid)}`);
    }
    if (results && results.length > 0) return results[0].Id;
  }
  if (person.search) {
    const results = await searchPeopleByName(client, ctx, person.search);
    if (results && results.length > 0) return results[0].Id;
  }
  return null;
}

async function resolvePersonAliasId(client: RockClient, ctx: OAuthRockContext, personId: number): Promise<number | null> {
  try {
    const aliases = await client.get<any[]>(ctx, `/api/PersonAlias?$filter=PersonId eq ${personId}`);
    if (aliases && aliases.length > 0) {
      return aliases[0].Id;
    }
  } catch {
    // Ignore and fallback
  }
  return null;
}

/**
 * Resolve the DefinedValue ID for Mobile phone type.
 * Mobile phone types are DefinedValues under the "Phone Type" DefinedType
 * with the well-known GUID 407E7E45-7B2E-4FCD-9605-ECB1339F2453.
 */
async function resolveMobilePhoneTypeId(client: RockClient, ctx: OAuthRockContext): Promise<number | null> {
  try {
    // Resolve via the shared two-step DefinedValue lookup (navigation-property
    // filters like DefinedType/Value are rejected by Rock's v1 OData).
    const mobileId = await resolveDefinedValueIdByName(client, ctx, 'Phone Type', 'Mobile');
    if (mobileId) {
      return mobileId;
    }
    throw new Error('Phone Type/Mobile not resolvable by name');
  } catch {
    // Fallback: try by GUID
    try {
      const byGuid = await client.get<any[]>(
        ctx,
        `/api/DefinedValues?$filter=Guid eq guid'407E7E45-7B2E-4FCD-9605-ECB1339F2453'&$top=1`
      );
      if (byGuid && byGuid.length > 0) {
        return byGuid[0].Id;
      }
    } catch {
      // Silent fallback
    }
  }
  return null;
}

/**
 * Find or update a Mobile PhoneNumber for a person.
 * Returns the updated/created PhoneNumber object.
 * If existingPhoneId is provided, skips the lookup and uses it directly.
 */
async function upsertMobilePhoneNumber(
  client: RockClient,
  ctx: OAuthRockContext,
  personId: number,
  mobileTypeId: number,
  phoneNumber: string,
  existingPhoneId?: number | null
): Promise<any> {
  // Use provided existingPhoneId or look it up
  let phoneToUpdate: number | null = existingPhoneId ?? null;

  if (phoneToUpdate === null) {
    // Lookup only if not provided
    let existingPhoneNumbers: any[] = [];
    try {
      existingPhoneNumbers = await client.get<any[]>(
        ctx,
        `/api/PhoneNumbers?$filter=PersonId eq ${personId} and NumberTypeValueId eq ${mobileTypeId}&$top=1`
      );
    } catch {
      // Ignore and treat as no existing record
    }
    if (existingPhoneNumbers && existingPhoneNumbers.length > 0) {
      phoneToUpdate = existingPhoneNumbers[0].Id;
    }
  }

  if (phoneToUpdate) {
    // Update existing
    try {
      const updated = await client.patch(ctx, `/api/v2/models/phonenumbers/${phoneToUpdate}`, {
        Number: phoneNumber,
      });
      return updated;
    } catch {
      // Fallback to v1
      const updated = await client.patch(ctx, `/api/PhoneNumbers/${phoneToUpdate}`, {
        Number: phoneNumber,
      });
      return updated;
    }
  } else {
    // Create new
    try {
      const created = await client.post(ctx, `/api/v2/models/phonenumbers`, {
        PersonId: personId,
        NumberTypeValueId: mobileTypeId,
        Number: phoneNumber,
      });
      return created;
    } catch {
      // Fallback to v1
      const created = await client.post(ctx, `/api/PhoneNumbers`, {
        PersonId: personId,
        NumberTypeValueId: mobileTypeId,
        Number: phoneNumber,
      });
      return created;
    }
  }
}

/**
 * Fetch Group records (Id, Name, GroupTypeId) by id via a single batched v1
 * query. Avoids the `$expand=Group` navigation property, which this Rock
 * instance's OData does not expose on GroupMember ("Could not find a property
 * named 'Group' on type 'Rock.Model.GroupMember'").
 */
async function fetchGroupsByIds(
  client: RockClient,
  ctx: OAuthRockContext,
  ids: number[]
): Promise<Map<number, any>> {
  const result = new Map<number, any>();
  const unique = [...new Set(ids.filter((id) => typeof id === 'number' && !Number.isNaN(id)))];
  if (unique.length === 0) return result;

  // Chunk to keep the OData filter string a reasonable length.
  const CHUNK = 50;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const filter = chunk.map((id) => `Id eq ${id}`).join(' or ');
    try {
      const groups = await client.get<any[]>(ctx, `/api/Groups?$filter=${filter}&$top=${chunk.length}`);
      for (const g of groups || []) {
        if (g && typeof g.Id === 'number') result.set(g.Id, g);
      }
    } catch {
      // Tolerate a failed chunk — callers degrade to ids without names.
    }
  }
  return result;
}

/**
 * Classify groups by type using discovery map.
 */
async function getPersonGroups(
  client: RockClient,
  ctx: OAuthRockContext,
  personId: number,
  discoveryService: any
): Promise<{ connectGroups: any[]; ministryTeams: any[]; other: any[]; warning?: string }> {
  // Guard: never interpolate an unresolved id into an OData filter. A bad id
  // would emit `PersonId eq undefined` and cascade several doomed Rock calls.
  if (typeof personId !== 'number' || Number.isNaN(personId)) {
    return {
      connectGroups: [],
      ministryTeams: [],
      other: [],
      warning: 'Skipped groups: person id was not resolved.',
    };
  }

  try {
    let members: any[] = [];
    let expandedGroups = false; // v2 search embeds the Group object; v1 does not
    try {
      members = await client.post(ctx, '/api/v2/models/groupmembers/search', {
        Where: `PersonId == ${personId}`,
        Limit: 200,
      });
      expandedGroups = true;
    } catch {
      // v1 OData fallback. Do NOT $expand=Group — that navigation property is
      // not exposed on GroupMember here. GroupRole expands fine; Group details
      // are fetched separately by id below.
      members = await client.get(ctx, `/api/GroupMembers?$filter=PersonId eq ${personId}&$top=200&$expand=GroupRole`);
    }

    const connectGroups: any[] = [];
    const ministryTeams: any[] = [];
    const other: any[] = [];

    // For the v1 path, resolve Group Name + GroupTypeId via a batched lookup.
    let groupsById = new Map<number, any>();
    if (!expandedGroups) {
      const ids = members.map((m: any) => m.GroupId).filter((id: any) => typeof id === 'number');
      groupsById = await fetchGroupsByIds(client, ctx, ids);
    }

    let map = null;
    try {
      if (discoveryService) {
        map = await discoveryService.getMap(ctx);
      }
    } catch {
      // Tolerate missing discovery
    }

    const connectGroupTypeIds = map ? map.groupTypes.connectGroups.map((c: any) => c.id) : [];
    const ministryTeamTypeIds = map ? map.groupTypes.ministryTeams.map((m: any) => m.id) : [];

    for (const m of members) {
      const group = m.Group || groupsById.get(m.GroupId) || {};
      const groupTypeId = group.GroupTypeId;
      const item = {
        groupId: group.Id ?? m.GroupId,
        name: group.Name,
        role: m.GroupRole ? m.GroupRole.Name : 'Member',
      };

      if (connectGroupTypeIds.includes(groupTypeId)) {
        connectGroups.push(item);
      } else if (ministryTeamTypeIds.includes(groupTypeId)) {
        ministryTeams.push(item);
      } else {
        other.push(item);
      }
    }

    return { connectGroups, ministryTeams, other };
  } catch (err: any) {
    return {
      connectGroups: [],
      ministryTeams: [],
      other: [],
      warning: `Failed to fetch groups: ${err.message}`,
    };
  }
}

/**
 * Get family members with privacy-safe data only.
 */
async function getFamily(
  client: RockClient,
  ctx: OAuthRockContext,
  personId: number
): Promise<{ familyMembers: any[]; warning?: string }> {
  try {
    // Try to get person's families via groupmembers where GroupType is "Family"
    // First, find the Family group types
    let familyGroupTypeId: number | null = null;
    try {
      const groupTypes = await client.post<any[]>(ctx, '/api/v2/models/grouptypes/search', {
        Where: `Name == "${FAMILY_GROUP_TYPE_NAME}"`,
      });
      if (groupTypes && groupTypes.length > 0) {
        familyGroupTypeId = groupTypes[0].Id;
      }
    } catch {
      // Try v1 fallback
      try {
        const groupTypes = await client.get<any[]>(ctx, `/api/GroupTypes?$filter=substringof('${FAMILY_GROUP_TYPE_NAME}', Name) eq true`);
        if (groupTypes && groupTypes.length > 0) {
          familyGroupTypeId = groupTypes[0].Id;
        }
      } catch {
        // Fallback: couldn't find family group type
      }
    }

    if (!familyGroupTypeId) {
      return { familyMembers: [] };
    }

    // Get the person's family group (usually primary)
    let familyMembers: any[] = [];
    try {
      const personGroups = await client.post<any[]>(ctx, '/api/v2/models/groupmembers/search', {
        Where: `PersonId == ${personId} && Group.GroupTypeId == ${familyGroupTypeId}`,
      });
      if (personGroups && personGroups.length > 0) {
        const familyGroupId = personGroups[0].Group?.Id || personGroups[0].GroupId;
        if (familyGroupId) {
          // Now get all members of that family group
          const allMembers = await client.post<any[]>(ctx, '/api/v2/models/groupmembers/search', {
            Where: `GroupId == ${familyGroupId}`,
          });
          familyMembers = allMembers.map((m: any) => ({
            personId: m.Person?.Id || m.PersonId,
            name: m.Person ? `${m.Person.NickName || m.Person.FirstName} ${m.Person.LastName}` : 'Unknown',
            role: m.GroupRole ? m.GroupRole.Name : 'Family Member',
          }));
        }
      }
    } catch {
      // Try v1 fallback. Avoid $expand=Group and the Group/GroupTypeId
      // navigation filter — neither is exposed on GroupMember here. Instead,
      // list the person's memberships, resolve their groups by id, and pick the
      // family group client-side.
      try {
        const personMemberships = await client.get<any[]>(
          ctx,
          `/api/GroupMembers?$filter=PersonId eq ${personId}&$top=200`
        );
        const membershipGroupIds = (personMemberships || [])
          .map((m: any) => m.GroupId)
          .filter((id: any) => typeof id === 'number');
        const groupsById = await fetchGroupsByIds(client, ctx, membershipGroupIds);
        let familyGroupId: number | undefined;
        for (const [id, g] of groupsById) {
          if (g?.GroupTypeId === familyGroupTypeId) {
            familyGroupId = id;
            break;
          }
        }
        if (familyGroupId) {
          const allMembers = await client.get<any[]>(
            ctx,
            `/api/GroupMembers?$filter=GroupId eq ${familyGroupId}&$expand=Person,GroupRole`
          );
          familyMembers = allMembers.map((m: any) => ({
            personId: m.Person?.Id,
            name: m.Person ? `${m.Person.NickName || m.Person.FirstName} ${m.Person.LastName}` : 'Unknown',
            role: m.GroupRole ? m.GroupRole.Name : 'Family Member',
          }));
        }
      } catch {
        // Unable to resolve family
      }
    }

    return { familyMembers };
  } catch (err: any) {
    return {
      familyMembers: [],
      warning: `Failed to fetch family: ${err.message}`,
    };
  }
}

/**
 * Get connection status and lifecycle from discovery.
 */
async function getConnectionStatus(
  client: RockClient,
  ctx: OAuthRockContext,
  personId: number,
  discoveryService: any
): Promise<{ connectionStatus?: string; lifecycle?: string; warning?: string }> {
  try {
    // Fetch person to get ConnectionStatusValue
    let person: any = null;
    try {
      person = await client.get(ctx, `/api/v2/models/people/${personId}`);
    } catch {
      person = await client.get(ctx, `/api/People/${personId}`);
    }

    const result: any = {};

    if (person && person.ConnectionStatusValue) {
      result.connectionStatus = person.ConnectionStatusValue;
    } else if (person && person.ConnectionStatusValueId) {
      result.connectionStatus = person.ConnectionStatusValueId;
    }

    // Try to get lifecycle attribute from discovery
    let lifecycleAttrId: number | null = null;
    try {
      if (discoveryService) {
        const map = await discoveryService.getMap(ctx);
        if (map.attributes.personLifecycle && map.attributes.personLifecycle.length > 0) {
          lifecycleAttrId = map.attributes.personLifecycle[0].id;
        }
      }
    } catch {
      // Tolerate discovery failure
    }

    if (lifecycleAttrId) {
      try {
        const attrs = await client.get<any[]>(
          ctx,
          `/api/AttributeValues?$filter=EntityId eq ${personId} and AttributeId eq ${lifecycleAttrId}`
        );
        if (attrs && attrs.length > 0) {
          result.lifecycle = attrs[0].Value;
        }
      } catch {
        // Couldn't fetch attribute value
      }
    }

    return result;
  } catch (err: any) {
    return { warning: `Failed to fetch connection status: ${err.message}` };
  }
}

/**
 * Compute attendance summary.
 */
async function getAttendanceSummary(
  client: RockClient,
  ctx: OAuthRockContext,
  personId: number,
  windowWeeks: number
): Promise<{ windowWeeks: number; attendedCount: number; consistency: string; warning?: string }> {
  try {
    const aliasId = await resolvePersonAliasId(client, ctx, personId);
    if (!aliasId) {
      return {
        windowWeeks,
        attendedCount: 0,
        consistency: 'Inactive',
        warning: 'Could not resolve person alias ID',
      };
    }

    // Calculate cutoff date
    const now = new Date();
    const cutoffDate = new Date(now.getTime() - windowWeeks * 7 * 24 * 60 * 60 * 1000);
    const yyyy = cutoffDate.getFullYear();
    const mm = String(cutoffDate.getMonth() + 1).padStart(2, '0');
    const dd = String(cutoffDate.getDate()).padStart(2, '0');
    const cutoffStr = `${yyyy}-${mm}-${dd}T00:00:00`;

    let attendances: any[] = [];
    try {
      attendances = await client.get<any[]>(
        ctx,
        `/api/Attendances?$filter=PersonAliasId eq ${aliasId} and StartDateTime ge datetime'${cutoffStr}' and DidAttend eq true`
      );
    } catch {
      // Fallback; assume no attendances
    }

    const attendedCount = attendances ? attendances.length : 0;

    // Simple heuristic: Regular >= threshold of weeks, Occasional >= 1, else Inactive
    let consistency = 'Inactive';
    if (attendedCount >= windowWeeks * ATTENDANCE_REGULAR_RATIO) {
      consistency = 'Regular';
    } else if (attendedCount >= 1) {
      consistency = 'Occasional';
    }

    return { windowWeeks, attendedCount, consistency };
  } catch (err: any) {
    return {
      windowWeeks,
      attendedCount: 0,
      consistency: 'Inactive',
      warning: `Failed to fetch attendance: ${err.message}`,
    };
  }
}

/**
 * Get serving summary (ministry teams only).
 */
async function getServingSummary(
  client: RockClient,
  ctx: OAuthRockContext,
  personId: number,
  discoveryService: any
): Promise<{ serving: any[]; warning?: string }> {
  const groupData = await getPersonGroups(client, ctx, personId, discoveryService);
  return {
    serving: groupData.ministryTeams,
    warning: groupData.warning,
  };
}

/**
 * Resolve campus name from ID.
 */
async function resolveCampusName(
  client: RockClient,
  ctx: OAuthRockContext,
  campusId: number | null | undefined,
  discoveryService: any
): Promise<string | null> {
  if (!campusId) return null;

  try {
    if (discoveryService) {
      const map = await discoveryService.getMap(ctx);
      const campus = map.campuses.find((c: any) => c.id === campusId);
      if (campus) return campus.name;
    }
  } catch {
    // Fallback
  }

  // Direct query fallback
  try {
    const campus = await client.get<any>(ctx, `/api/Campuses/${campusId}`);
    if (campus) return campus.Name;
  } catch {
    // Ignore
  }

  return null;
}

/**
 * Resolve a DefinedValue ID by DefinedType name and Value name.
 * Delegates to the shared two-step resolver: navigation-property filters
 * like DefinedType/Name are rejected by Rock's v1 OData.
 */
async function resolveDefinedValueId(
  client: RockClient,
  ctx: OAuthRockContext,
  definedTypeName: string,
  valueName: string
): Promise<number | null> {
  return resolveDefinedValueIdByName(client, ctx, definedTypeName, valueName);
}

/**
 * Count active Rock people in a given Connection Status (e.g. 'New', 'Crowd',
 * 'Core', 'Leader'). Read-only and failure-safe: returns the true total, or
 * `null` if the status can't be resolved or the count can't be fetched. Used by
 * the rock_usage wiki live overlay; mirrors the count path in the `filter` action.
 */
export async function countByConnectionStatus(
  ctx: OAuthRockContext,
  statusName: string
): Promise<number | null> {
  const client = (ctx as any).rockClient as RockClient | undefined;
  if (!client) return null;
  try {
    const statusMap = await getDefinedValueMap(client, ctx, 'Connection Status');
    const needle = statusName.toLowerCase();
    let valueId: number | null = null;
    for (const [id, value] of statusMap.entries()) {
      if (value.toLowerCase() === needle) {
        valueId = id;
        break;
      }
    }
    if (valueId == null) return null;

    try {
      const countResult = await client.post(ctx, '/api/v2/models/people/search', {
        Where: `ConnectionStatusValueId == ${valueId}`,
        IsCountOnly: true,
      });
      return Number(countResult);
    } catch {
      const all = await client.get<any[]>(
        ctx,
        `/api/People?$filter=ConnectionStatusValueId eq ${valueId}&$select=Id`
      );
      return (all || []).length;
    }
  } catch {
    return null;
  }
}

export const rockPeopleTool: GatewayTool = {
  name: 'rock_people',
  title: 'Rock People Directory',
  schemaForMode(
    mode: McpMode,
    scopes: Set<McpScope>,
    caps: { isAdmin: boolean; isStaffOrAdmin: boolean }
  ): z.ZodTypeAny | null {
    if (mode !== 'readwrite' || !scopes.has('write') || !caps.isAdmin) {
      return z.discriminatedUnion('action', [
        readOnlyPeopleActions[0],
        ...readOnlyPeopleActions.slice(1),
      ]);
    }
    return rockPeopleSchema;
  },
  descriptionForMode(_mode: McpMode): string {
    return "Directory lookups, profiles, and relationship workflows for people in Rock RMS. Use 'filter' to list or count people by campus or connection status with true totals and pagination.";
  },
  async handle(args: any, _extra: any, ctx: OAuthRockContext): Promise<McpToolResult> {
    const parsed = rockPeopleSchema.parse(args);

    const rockClient = (ctx as any).rockClient as RockClient;
    if (!rockClient) {
      return formatResponse(parsed.action, ctx, null, {
        code: 'MISSING_CLIENT',
        message: 'Rock client is not initialized in request context.',
      });
    }

    if (parsed.action === 'find') {
      const { query, limit } = parsed;
      try {
        let results: any[] = [];
        try {
          const quoted = quoteLinqString(query);
          results = await rockClient.post(ctx, '/api/v2/models/people/search', {
            Where: `NickName.Contains(${quoted}) || LastName.Contains(${quoted})`,
            Limit: limit,
          });
        } catch {
          // Fall back to REST v1. v1 has no string-concatenation filter, so a
          // full-name query like "First Last" can never substring-match a single
          // name field — split into first/last tokens instead (mirrors
          // searchPeopleByName).
          const parts = query.trim().split(/\s+/);
          let odataFilter: string;
          if (parts.length >= 2) {
            const first = parts[0];
            const last = parts.slice(1).join(' ');
            odataFilter =
              `((substringof(${quoteODataString(first)}, NickName) eq true) or (substringof(${quoteODataString(first)}, FirstName) eq true)) and (substringof(${quoteODataString(last)}, LastName) eq true)`;
          } else {
            odataFilter = `(substringof(${quoteODataString(query)}, NickName) eq true) or (substringof(${quoteODataString(query)}, LastName) eq true)`;
          }
          results = await rockClient.get(ctx, `/api/People?$filter=${encodeURIComponent(odataFilter)}&$top=${limit}`);
        }

        const safeResults = results.map((p: any) => ({
          id: p.Id,
          guid: p.Guid,
          name: `${p.NickName || p.FirstName} ${p.LastName}`,
        }));

        return formatResponse(parsed.action, ctx, safeResults);
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'FIND_ERROR',
          message: `Failed to find people: ${err.message}`,
        });
      }
    }

    if (parsed.action === 'filter') {
      const { campusId, campusName, connectionStatus, isActive, countOnly, limit, offset } = parsed;
      const discoveryService = getDiscoveryService(ctx);

      if (!campusId && !campusName && !connectionStatus && isActive === undefined) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'FILTER_REQUIRED',
          message: 'Provide at least one filter: campusId, campusName, connectionStatus, or isActive.',
        });
      }

      try {
        // Resolve campus (by ID or name) against the discovery map, falling
        // back to the Campuses API so name resolution still works without discovery.
        let campus: { id: number; name: string | null } | null = null;
        if (campusId || campusName) {
          let campuses: Array<{ id: number; name: string }> = [];
          try {
            if (discoveryService) {
              const map = await discoveryService.getMap(ctx);
              campuses = map.campuses || [];
            }
          } catch {
            // Tolerate missing discovery
          }
          if (campuses.length === 0) {
            try {
              const raw = await rockClient.get<any[]>(ctx, '/api/Campuses');
              campuses = (raw || []).map((c: any) => ({ id: c.Id, name: c.Name }));
            } catch {
              // No campus list available
            }
          }

          if (campusId) {
            const found = campuses.find((c) => c.id === campusId);
            campus = { id: campusId, name: found ? found.name : null };
          } else if (campusName) {
            const needle = campusName.toLowerCase();
            const found =
              campuses.find((c) => c.name.toLowerCase() === needle) ||
              campuses.find((c) => c.name.toLowerCase().includes(needle));
            if (!found) {
              return formatResponse(parsed.action, ctx, null, {
                code: 'CAMPUS_NOT_FOUND',
                message: `No campus matched '${campusName}'. Available campuses: ${campuses.map((c) => c.name).join(', ') || '(none discovered)'}.`,
              });
            }
            campus = { id: found.id, name: found.name };
          }
        }

        // Resolve connection status (name, case-insensitive, or numeric DefinedValue ID)
        let connectionStatusValueId: number | null = null;
        if (connectionStatus) {
          if (/^\d+$/.test(connectionStatus)) {
            connectionStatusValueId = parseInt(connectionStatus, 10);
          } else {
            const statusMap = await getDefinedValueMap(rockClient, ctx, 'Connection Status');
            const needle = connectionStatus.toLowerCase();
            const found = [...statusMap.entries()].find(([, value]) => value.toLowerCase() === needle);
            if (!found) {
              return formatResponse(parsed.action, ctx, null, {
                code: 'CONNECTION_STATUS_NOT_FOUND',
                message: `No connection status matched '${connectionStatus}'. Available: ${[...statusMap.values()].join(', ') || '(none found)'}. A numeric DefinedValue ID is also accepted.`,
              });
            }
            connectionStatusValueId = found[0];
          }
        }

        // Resolve the "Active" RecordStatus DefinedValue for the isActive filter
        let warning: string | undefined;
        let activeRecordStatusId: number | null = null;
        if (isActive !== undefined) {
          activeRecordStatusId = await resolveDefinedValueId(rockClient, ctx, 'Record Status', 'Active');
          if (activeRecordStatusId === null) {
            warning = 'isActive filter was not applied: could not resolve the "Active" RecordStatus DefinedValue.';
          }
        }

        const linqClauses: string[] = [];
        const odataClauses: string[] = [];
        if (campus) {
          linqClauses.push(`PrimaryCampusId == ${campus.id}`);
          odataClauses.push(`PrimaryCampusId eq ${campus.id}`);
        }
        if (connectionStatusValueId) {
          linqClauses.push(`ConnectionStatusValueId == ${connectionStatusValueId}`);
          odataClauses.push(`ConnectionStatusValueId eq ${connectionStatusValueId}`);
        }
        if (isActive !== undefined && activeRecordStatusId !== null) {
          linqClauses.push(isActive
            ? `RecordStatusValueId == ${activeRecordStatusId}`
            : `RecordStatusValueId != ${activeRecordStatusId}`);
          odataClauses.push(isActive
            ? `RecordStatusValueId eq ${activeRecordStatusId}`
            : `RecordStatusValueId ne ${activeRecordStatusId}`);
        }
        // If every requested filter failed to resolve, error out rather than
        // silently counting the whole database.
        if (linqClauses.length === 0) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'FILTER_UNRESOLVED',
            message: warning ?? 'No filter could be applied.',
          });
        }

        const where = linqClauses.join(' && ');
        const odataFilter = odataClauses.join(' and ');

        // True total via count-only query (not capped by the page size)
        let total: number;
        try {
          const countResult = await rockClient.post(ctx, '/api/v2/models/people/search', {
            Where: where,
            IsCountOnly: true,
          });
          total = Number(countResult);
        } catch {
          const all = await rockClient.get<any[]>(
            ctx,
            `/api/People?$filter=${encodeURIComponent(odataFilter)}&$select=Id`
          );
          total = (all || []).length;
          warning = 'Fell back to REST v1 for count';
        }

        const filters: any = {};
        if (campus) filters.campus = campus;
        if (connectionStatus) filters.connectionStatus = connectionStatus;

        if (countOnly) {
          return formatResponse(parsed.action, ctx, { total, ...filters }, undefined, warning);
        }

        let rows: any[] = [];
        try {
          rows = await rockClient.post(ctx, '/api/v2/models/people/search', {
            Where: where,
            Offset: offset,
            Limit: limit,
          });
        } catch {
          // Sort before skip — Rock v1 500s on $skip without $orderby.
          const pagination = odataPagination({ top: limit, skip: offset });
          rows = await rockClient.get<any[]>(
            ctx,
            `/api/People?$filter=${encodeURIComponent(odataFilter)}${pagination ? `&${pagination}` : ''}`
          );
          warning = warning ? `${warning}; fell back to REST v1 for rows` : 'Fell back to REST v1 for rows';
        }

        // Fetch DefinedValue map for ConnectionStatus to resolve IDs to names
        const connectionStatusMap = await getDefinedValueMap(rockClient, ctx, 'Connection Status');

        const results = (rows || []).map((p: any) => ({
          id: p.Id,
          guid: p.Guid,
          name: `${p.NickName || p.FirstName || ''} ${p.LastName || ''}`.trim(),
          campusId: p.PrimaryCampusId || p.CampusId,
          connectionStatus: p.ConnectionStatusValue || (p.ConnectionStatusValueId ? connectionStatusMap.get(p.ConnectionStatusValueId) : undefined),
        }));

        return formatResponse(parsed.action, ctx, {
          total,
          offset,
          limit,
          count: results.length,
          ...filters,
          results,
        }, undefined, warning);
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'FILTER_ERROR',
          message: `Failed to filter people: ${err.message}`,
        });
      }
    }

    if (parsed.action === 'profile') {
      const { person, include, includeSensitive } = parsed;
      const discoveryService = getDiscoveryService(ctx);
      try {
        let match: any = null;

        if (person.id) {
          try {
            match = await rockClient.get(ctx, `/api/v2/models/people/${person.id}`);
          } catch {
            match = await rockClient.get(ctx, `/api/People/${person.id}`);
          }
        } else if (person.guid) {
          const validGuid = assertValidGuid(person.guid);
          let results: any[] = [];
          try {
            results = await rockClient.post(ctx, '/api/v2/models/people/search', {
              Where: `Guid == ${quoteLinqString(validGuid)}`,
            });
          } catch {
            results = await rockClient.get(ctx, `/api/People?$filter=Guid eq guid${quoteODataString(validGuid)}`);
          }
          if (results && results.length > 0) {
            match = results[0];
          }
        } else if (person.search) {
          const results = await searchPeopleByName(rockClient, ctx, person.search);
          if (results && results.length > 0) {
            match = results[0];
          }
        }

        if (!match) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'NOT_FOUND',
            message: "Person not found. Exact name match failed — try { action: 'find', query: '<partial name>' } for a fuzzy search.",
          });
        }

        const isStaffOrAdmin = !!(ctx.rockUser && (ctx.rockUser.isRsrAdmin || ctx.rockUser.isStaff));
        const isAuthorizedForSensitive =
          includeSensitive && ctx.mode === 'readwrite' && ctx.scopes.has('write') && isStaffOrAdmin;
        let sensitiveWarning: string | undefined;
        if (includeSensitive && !isAuthorizedForSensitive) {
          sensitiveWarning =
            'Sensitive fields (email/phone/birthdate) omitted: includeSensitive requires readwrite mode and staff/admin access.';
        }

        const profileResult: any = {
          person: {
            id: match.Id,
            guid: match.Guid,
            name: `${match.NickName || match.FirstName} ${match.LastName}`,
            firstName: match.FirstName,
            lastName: match.LastName,
          },
        };

        // Add campus
        if (match.PrimaryCampusId || match.CampusId) {
          const campusName = await resolveCampusName(rockClient, ctx, match.PrimaryCampusId || match.CampusId, discoveryService);
          if (campusName) {
            profileResult.person.campus = campusName;
          }
        }

        if (isAuthorizedForSensitive) {
          profileResult.person.email = match.Email;
          profileResult.person.phone = match.MobilePhoneNumber || match.Phone;
          profileResult.person.birthdate = match.BirthDate || (match.BirthYear ? `${match.BirthYear}-${match.BirthMonth}-${match.BirthDay}` : undefined);
        }

        // Compose included summaries if requested
        if (include && include.length > 0) {
          const personId = match.Id;
          const hasValidId = typeof personId === 'number' && !Number.isNaN(personId);
          for (const includeType of include) {
            if (!hasValidId) {
              // The resolved record carried no numeric Id — skip every include
              // rather than interpolate `undefined` into Rock filters.
              (profileResult as any)[includeType] = { warning: 'Skipped: person id was not resolved.' };
              continue;
            }
            if (includeType === 'groups') {
              const groupData = await getPersonGroups(rockClient, ctx, personId, discoveryService);
              profileResult.groups = groupData;
            } else if (includeType === 'family') {
              const familyData = await getFamily(rockClient, ctx, personId);
              profileResult.family = familyData;
            } else if (includeType === 'connectionStatus') {
              const connData = await getConnectionStatus(rockClient, ctx, personId, discoveryService);
              profileResult.connectionStatus = connData;
            } else if (includeType === 'attendanceSummary') {
              const attData = await getAttendanceSummary(rockClient, ctx, personId, 12);
              profileResult.attendanceSummary = attData;
            } else if (includeType === 'servingSummary') {
              const servData = await getServingSummary(rockClient, ctx, personId, discoveryService);
              profileResult.servingSummary = servData;
            }
          }
        }

        return formatResponse(parsed.action, ctx, profileResult, undefined, sensitiveWarning);
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'PROFILE_ERROR',
          message: `Failed to fetch profile: ${err.message}`,
        });
      }
    }

    if (parsed.action === 'updateContactInfo') {
      const { personId, personGuid, email, phone, firstName, lastName, dryRun, commit, reason } = parsed;
      if (ctx.mode !== 'readwrite' || !ctx.scopes.has('write')) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'UNAUTHORIZED',
          message: 'Write actions disallowed in readonly mode.',
        });
      }
      try {
        const id = personId || (personGuid ? await resolvePersonId(rockClient, ctx, { guid: personGuid }) : null);
        if (!id) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'NOT_FOUND',
            message: "Person not found. Exact name match failed — try { action: 'find', query: '<partial name>' } for a fuzzy search.",
          });
        }

        // Build Person data (excluding phone, which goes to PhoneNumber entity)
        const personData: any = {};
        if (email !== undefined) personData.Email = email;
        if (firstName !== undefined) personData.FirstName = firstName;
        if (lastName !== undefined) personData.LastName = lastName;

        // Build phone intent (if phone is being updated)
        let phoneIntent: any = undefined;
        let mobileTypeId: number | null = null;
        let phoneOperation: 'create' | 'patch' | undefined = undefined;
        let existingPhoneId: number | null = null;
        if (phone !== undefined) {
          mobileTypeId = await resolveMobilePhoneTypeId(rockClient, ctx);
          if (!mobileTypeId) {
            return formatResponse(parsed.action, ctx, null, {
              code: 'PHONE_TYPE_RESOLUTION_ERROR',
              message: 'Could not resolve Mobile phone type DefinedValue.',
            });
          }

          // Determine whether we'll create or patch by checking for existing Mobile PhoneNumber
          // This lookup is a read-only check to determine authorization, not an unauthorized side effect.
          let existingPhoneNumbers: any[] = [];
          try {
            existingPhoneNumbers = await rockClient.get<any[]>(
              ctx,
              `/api/PhoneNumbers?$filter=PersonId eq ${id} and NumberTypeValueId eq ${mobileTypeId}&$top=1`
            );
          } catch {
            // Ignore and treat as no existing record
          }

          phoneOperation = (existingPhoneNumbers && existingPhoneNumbers.length > 0) ? 'patch' : 'create';
          if (existingPhoneNumbers && existingPhoneNumbers.length > 0) {
            existingPhoneId = existingPhoneNumbers[0].Id;
          }
          phoneIntent = {
            number: phone,
            numberTypeValueId: mobileTypeId,
          };
        }

        // Check authorization for Person fields
        let authz: any = { allowed: true };
        if (Object.keys(personData).length > 0) {
          const descriptor = {
            tool: 'rock_people',
            action: parsed.action,
            model: 'people',
            operation: 'patch' as const,
            fields: Object.keys(personData),
          };
          authz = authorizeWrite(ctx, descriptor);
          if (!authz.allowed) {
            auditLogger.log(ctx, {
              tool: 'rock_people',
              action: parsed.action,
              target: { model: 'people', id },
              dryRun,
              commit,
              reason,
              outcome: 'denied',
              errorCode: authz.code,
            });
            return formatResponse(parsed.action, ctx, null, {
              code: authz.code || 'AUTHORIZATION_DENIED',
              message: authz.reason || 'Authorization denied.',
            });
          }
        }

        // Check authorization for PhoneNumber if phone is being updated
        if (phoneIntent && phoneOperation) {
          const phoneDescriptor = {
            tool: 'rock_people',
            action: parsed.action,
            model: 'phonenumbers',
            operation: phoneOperation,
            fields: ['Number', 'PersonId', 'NumberTypeValueId'],
          };
          authz = authorizeWrite(ctx, phoneDescriptor);
          if (!authz.allowed) {
            auditLogger.log(ctx, {
              tool: 'rock_people',
              action: parsed.action,
              target: { model: 'phonenumbers', id },
              dryRun,
              commit,
              reason,
              outcome: 'denied',
              errorCode: authz.code,
            });
            return formatResponse(parsed.action, ctx, null, {
              code: authz.code || 'AUTHORIZATION_DENIED',
              message: authz.reason || 'Authorization denied.',
            });
          }
        }

        const shouldMutate = commit && !dryRun;
        if (!shouldMutate) {
          auditLogger.log(ctx, {
            tool: 'rock_people',
            action: parsed.action,
            target: { model: 'people', id },
            dryRun: true,
            commit: false,
            reason,
            outcome: 'allowed',
          });
          const dryRunResponse: any = {
            dryRun: true,
            committed: false,
            target: { id },
          };
          if (Object.keys(personData).length > 0) {
            dryRunResponse.data = personData;
          }
          if (phoneIntent) {
            dryRunResponse.phoneIntent = phoneIntent;
          }
          return formatResponse(parsed.action, ctx, dryRunResponse);
        }

        // Perform mutations with error handling for partial failures
        let personResult: any = undefined;
        let phoneResult: any = undefined;
        let personError: any = undefined;
        let phoneError: any = undefined;

        // Patch Person (if there are person fields to update)
        if (Object.keys(personData).length > 0) {
          try {
            try {
              personResult = await rockClient.patch(ctx, `/api/v2/models/people/${id}`, personData);
            } catch {
              personResult = await rockClient.patch(ctx, `/api/People/${id}`, personData);
            }
          } catch (err) {
            personError = err;
          }
        }

        // Upsert PhoneNumber (if phone is being updated)
        if (phoneIntent && mobileTypeId) {
          try {
            phoneResult = await upsertMobilePhoneNumber(rockClient, ctx, id, mobileTypeId, phone!, existingPhoneId);
          } catch (err) {
            phoneError = err;
          }
        }

        // Determine outcome based on what succeeded/failed
        const bothSucceeded = !personError && !phoneError;
        const neitherSucceeded = personError && phoneError;

        if (bothSucceeded) {
          auditLogger.log(ctx, {
            tool: 'rock_people',
            action: parsed.action,
            target: { model: 'people', id },
            dryRun: false,
            commit: true,
            reason,
            outcome: 'success',
          });
          const committedResponse: any = { committed: true };
          if (personResult) committedResponse.personResult = personResult;
          if (phoneResult) committedResponse.phoneResult = phoneResult;
          return formatResponse(parsed.action, ctx, committedResponse);
        } else if (neitherSucceeded) {
          // Both failed: report as error
          auditLogger.log(ctx, {
            tool: 'rock_people',
            action: parsed.action,
            target: { model: 'people', id },
            dryRun: false,
            commit: true,
            reason,
            outcome: 'error',
            errorCode: 'UPDATE_CONTACT_ERROR',
          });
          const errors: string[] = [];
          if (personError) errors.push(`Person update failed: ${personError.message}`);
          if (phoneError) errors.push(`Phone update failed: ${phoneError.message}`);
          return formatResponse(parsed.action, ctx, null, {
            code: 'UPDATE_CONTACT_ERROR',
            message: errors.join(' | '),
          });
        } else {
          // Partial failure: one succeeded, one failed
          auditLogger.log(ctx, {
            tool: 'rock_people',
            action: parsed.action,
            target: { model: 'people', id },
            dryRun: false,
            commit: true,
            reason,
            outcome: 'error',
            errorCode: 'UPDATE_CONTACT_PARTIAL',
          });
          const partialResponse: any = {
            committed: false,
            partial: true,
            results: {},
            errors: {},
          };
          if (personResult) {
            partialResponse.results.person = personResult;
          } else if (personError) {
            partialResponse.errors.person = personError.message;
          }
          if (phoneResult) {
            partialResponse.results.phone = phoneResult;
          } else if (phoneError) {
            partialResponse.errors.phone = phoneError.message;
          }
          return formatResponse(parsed.action, ctx, partialResponse);
        }
      } catch (err: any) {
        auditLogger.log(ctx, {
          tool: 'rock_people',
          action: parsed.action,
          target: { model: 'people' },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'error',
          errorCode: 'UPDATE_CONTACT_ERROR',
        });
        return formatResponse(parsed.action, ctx, null, {
          code: 'UPDATE_CONTACT_ERROR',
          message: err.message,
        });
      }
    }

    if (parsed.action === 'patchAttributes') {
      const { personId, personGuid, attributes, dryRun, commit, reason } = parsed;
      if (ctx.mode !== 'readwrite' || !ctx.scopes.has('write')) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'UNAUTHORIZED',
          message: 'Write actions disallowed in readonly mode.',
        });
      }
      try {
        const id = personId || (personGuid ? await resolvePersonId(rockClient, ctx, { guid: personGuid }) : null);
        if (!id) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'NOT_FOUND',
            message: "Person not found. Exact name match failed — try { action: 'find', query: '<partial name>' } for a fuzzy search.",
          });
        }

        // Perform authorization check BEFORE mutation, even for dry-runs
        const descriptor = {
          tool: 'rock_people',
          action: parsed.action,
          model: 'people',
          operation: 'patchAttributes' as const,
        };
        const authz = authorizeWrite(ctx, descriptor);
        if (!authz.allowed) {
          auditLogger.log(ctx, {
            tool: 'rock_people',
            action: parsed.action,
            target: { model: 'people', id },
            dryRun,
            commit,
            reason,
            outcome: 'denied',
            errorCode: authz.code,
          });
          return formatResponse(parsed.action, ctx, null, {
            code: authz.code || 'AUTHORIZATION_DENIED',
            message: authz.reason || 'Authorization denied.',
          });
        }

        const shouldMutate = commit && !dryRun;
        if (!shouldMutate) {
          auditLogger.log(ctx, {
            tool: 'rock_people',
            action: parsed.action,
            target: { model: 'people', id },
            dryRun: true,
            commit: false,
            reason,
            outcome: 'allowed',
          });
          return formatResponse(parsed.action, ctx, {
            dryRun: true,
            committed: false,
            target: { id },
            attributes,
          });
        }

        // Attempt to patch attributes via v2.
        // NOTE: Rock REST v1 has no clean equivalent for patching person attributes.
        // Unlike entity read operations (which gracefully fall back to v1), attribute writes
        // require v2 access. If v2 fails, we return a clear, actionable error rather than
        // attempting an uncertain v1 path.
        try {
          const result = await rockClient.patch(ctx, `/api/v2/models/people/${id}/attributevalues`, attributes);
          auditLogger.log(ctx, {
            tool: 'rock_people',
            action: parsed.action,
            target: { model: 'people', id },
            dryRun: false,
            commit: true,
            reason,
            outcome: 'success',
          });
          return formatResponse(parsed.action, ctx, { committed: true, result });
        } catch (err) {
          auditLogger.log(ctx, {
            tool: 'rock_people',
            action: parsed.action,
            target: { model: 'people', id },
            dryRun: false,
            commit: true,
            reason,
            outcome: 'error',
            errorCode: 'PATCH_ATTRIBUTES_ERROR',
          });
          const errorMessage = err instanceof Error ? err.message : String(err);
          return formatResponse(parsed.action, ctx, null, {
            code: 'PATCH_ATTRIBUTES_ERROR',
            message: `Attribute write failed (requires REST v2 access; grant the API key v2 access): ${errorMessage}`,
          });
        }
      } catch (err) {
        auditLogger.log(ctx, {
          tool: 'rock_people',
          action: parsed.action,
          target: { model: 'people' },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'error',
          errorCode: 'PATCH_ATTRIBUTES_ERROR',
        });
        const errorMessage = err instanceof Error ? err.message : String(err);
        return formatResponse(parsed.action, ctx, null, {
          code: 'PATCH_ATTRIBUTES_ERROR',
          message: `Attribute write failed: ${errorMessage}`,
        });
      }
    }

    if (parsed.action === 'createNote') {
      const { personId, personGuid, text, noteType, dryRun, commit, reason } = parsed;
      if (ctx.mode !== 'readwrite' || !ctx.scopes.has('write')) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'UNAUTHORIZED',
          message: 'Write actions disallowed in readonly mode.',
        });
      }
      try {
        const id = personId || (personGuid ? await resolvePersonId(rockClient, ctx, { guid: personGuid }) : null);
        if (!id) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'NOT_FOUND',
            message: "Person not found. Exact name match failed — try { action: 'find', query: '<partial name>' } for a fuzzy search.",
          });
        }

        let noteTypeId = 4; // Default to Personal Note
        if (noteType) {
          if (/^\d+$/.test(noteType)) {
            noteTypeId = parseInt(noteType, 10);
          } else {
            try {
              const types = await rockClient.get<any[]>(ctx, `/api/NoteTypes?$filter=EntityType/Name eq 'Rock.Model.Person' and substringof(${quoteODataString(noteType)}, Name) eq true`);
              if (types && types.length > 0) {
                noteTypeId = types[0].Id;
              }
            } catch {
              // Ignore and fallback
            }
          }
        }

        const payload = {
          EntityId: id,
          NoteTypeId: noteTypeId,
          Text: text,
          IsAlert: false,
        };

        // Perform authorization check BEFORE mutation, even for dry-runs
        const descriptor = {
          tool: 'rock_people',
          action: parsed.action,
          model: 'notes',
          operation: 'create' as const,
          fields: Object.keys(payload),
        };
        const authz = authorizeWrite(ctx, descriptor);
        if (!authz.allowed) {
          auditLogger.log(ctx, {
            tool: 'rock_people',
            action: parsed.action,
            target: { model: 'notes' },
            dryRun,
            commit,
            reason,
            outcome: 'denied',
            errorCode: authz.code,
          });
          return formatResponse(parsed.action, ctx, null, {
            code: authz.code || 'AUTHORIZATION_DENIED',
            message: authz.reason || 'Authorization denied.',
          });
        }

        const shouldMutate = commit && !dryRun;
        if (!shouldMutate) {
          auditLogger.log(ctx, {
            tool: 'rock_people',
            action: parsed.action,
            target: { model: 'people', id },
            dryRun: true,
            commit: false,
            reason,
            outcome: 'allowed',
          });
          return formatResponse(parsed.action, ctx, {
            dryRun: true,
            committed: false,
            target: { id },
            payload,
          });
        }

        let result;
        try {
          result = await rockClient.post(ctx, '/api/v2/models/notes', payload);
        } catch {
          result = await rockClient.post(ctx, '/api/Notes', payload);
        }

        auditLogger.log(ctx, {
          tool: 'rock_people',
          action: parsed.action,
          target: { model: 'people', id },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'success',
        });
        return formatResponse(parsed.action, ctx, { committed: true, result });
      } catch (err: any) {
        auditLogger.log(ctx, {
          tool: 'rock_people',
          action: parsed.action,
          target: { model: 'people' },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'error',
          errorCode: 'CREATE_NOTE_ERROR',
        });
        return formatResponse(parsed.action, ctx, null, {
          code: 'CREATE_NOTE_ERROR',
          message: err.message,
        });
      }
    }

    if (parsed.action === 'groups') {
      const { person } = parsed;
      try {
        const id = await resolvePersonId(rockClient, ctx, person);
        if (!id) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'NOT_FOUND',
            message: "Person not found. Exact name match failed — try { action: 'find', query: '<partial name>' } for a fuzzy search.",
          });
        }

        const discoveryService = getDiscoveryService(ctx);
        const groupData = await getPersonGroups(rockClient, ctx, id, discoveryService);

        return formatResponse(parsed.action, ctx, groupData);
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'GROUPS_ERROR',
          message: `Failed to fetch groups: ${err.message}`,
        });
      }
    }

    if (parsed.action === 'family') {
      const { person } = parsed;
      try {
        const id = await resolvePersonId(rockClient, ctx, person);
        if (!id) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'NOT_FOUND',
            message: "Person not found. Exact name match failed — try { action: 'find', query: '<partial name>' } for a fuzzy search.",
          });
        }

        const familyData = await getFamily(rockClient, ctx, id);

        return formatResponse(parsed.action, ctx, familyData);
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'FAMILY_ERROR',
          message: `Failed to fetch family: ${err.message}`,
        });
      }
    }

    if (parsed.action === 'connectionStatus') {
      const { person } = parsed;
      try {
        const id = await resolvePersonId(rockClient, ctx, person);
        if (!id) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'NOT_FOUND',
            message: "Person not found. Exact name match failed — try { action: 'find', query: '<partial name>' } for a fuzzy search.",
          });
        }

        const discoveryService = getDiscoveryService(ctx);
        const connData = await getConnectionStatus(rockClient, ctx, id, discoveryService);

        return formatResponse(parsed.action, ctx, connData);
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'CONNECTION_STATUS_ERROR',
          message: `Failed to fetch connection status: ${err.message}`,
        });
      }
    }

    if (parsed.action === 'attendanceSummary') {
      const { person, windowWeeks } = parsed;
      try {
        const id = await resolvePersonId(rockClient, ctx, person);
        if (!id) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'NOT_FOUND',
            message: "Person not found. Exact name match failed — try { action: 'find', query: '<partial name>' } for a fuzzy search.",
          });
        }

        const attData = await getAttendanceSummary(rockClient, ctx, id, windowWeeks);

        return formatResponse(parsed.action, ctx, attData);
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'ATTENDANCE_SUMMARY_ERROR',
          message: `Failed to fetch attendance summary: ${err.message}`,
        });
      }
    }

    if (parsed.action === 'servingSummary') {
      const { person } = parsed;
      try {
        const id = await resolvePersonId(rockClient, ctx, person);
        if (!id) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'NOT_FOUND',
            message: "Person not found. Exact name match failed — try { action: 'find', query: '<partial name>' } for a fuzzy search.",
          });
        }

        const discoveryService = getDiscoveryService(ctx);
        const servData = await getServingSummary(rockClient, ctx, id, discoveryService);

        return formatResponse(parsed.action, ctx, servData);
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'SERVING_SUMMARY_ERROR',
          message: `Failed to fetch serving summary: ${err.message}`,
        });
      }
    }

    if (parsed.action === 'createFollowUpTask') {
      const { personId, personGuid, title, description, assignedToId, connectionOpportunityId, dryRun, commit, reason } = parsed;
      if (ctx.mode !== 'readwrite' || !ctx.scopes.has('write')) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'UNAUTHORIZED',
          message: 'Write actions disallowed in readonly mode.',
        });
      }

      // Require connectionOpportunityId to be explicitly provided
      if (!connectionOpportunityId) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'OPPORTUNITY_REQUIRED',
          message: 'connectionOpportunityId is required to create a follow-up connection request.',
        });
      }

      try {
        const id = personId || (personGuid ? await resolvePersonId(rockClient, ctx, { guid: personGuid }) : null);
        if (!id) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'NOT_FOUND',
            message: "Person not found. Exact name match failed — try { action: 'find', query: '<partial name>' } for a fuzzy search.",
          });
        }

        const aliasId = await resolvePersonAliasId(rockClient, ctx, id);
        if (!aliasId) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'ALIAS_NOT_FOUND',
            message: 'Could not resolve person alias ID.',
          });
        }

        let assignedAliasId: number | undefined;
        if (assignedToId) {
          assignedAliasId = await resolvePersonAliasId(rockClient, ctx, assignedToId) || undefined;
        }

        const payload: any = {
          ConnectionOpportunityId: connectionOpportunityId,
          PersonAliasId: aliasId,
          Comments: description ? `${title}\n\n${description}` : title,
        };
        // Omit ConnectionStatusId to let Rock apply its default
        // (Do not hardcode ConnectionStatusId: 2)
        if (assignedAliasId) {
          payload.AssignedPersonAliasId = assignedAliasId;
        }

        // Perform authorization check BEFORE mutation, even for dry-runs
        const descriptor = {
          tool: 'rock_people',
          action: parsed.action,
          model: 'connectionrequests',
          operation: 'create' as const,
          fields: Object.keys(payload),
        };
        const authz = authorizeWrite(ctx, descriptor);
        if (!authz.allowed) {
          auditLogger.log(ctx, {
            tool: 'rock_people',
            action: parsed.action,
            target: { model: 'connectionrequests' },
            dryRun,
            commit,
            reason,
            outcome: 'denied',
            errorCode: authz.code,
          });
          return formatResponse(parsed.action, ctx, null, {
            code: authz.code || 'AUTHORIZATION_DENIED',
            message: authz.reason || 'Authorization denied.',
          });
        }

        const shouldMutate = commit && !dryRun;
        if (!shouldMutate) {
          auditLogger.log(ctx, {
            tool: 'rock_people',
            action: parsed.action,
            target: { model: 'people', id },
            dryRun: true,
            commit: false,
            reason,
            outcome: 'allowed',
          });
          return formatResponse(parsed.action, ctx, {
            dryRun: true,
            committed: false,
            target: { id },
            payload,
          });
        }

        let result;
        try {
          result = await rockClient.post(ctx, '/api/v2/models/connectionrequests', payload);
        } catch {
          result = await rockClient.post(ctx, '/api/ConnectionRequests', payload);
        }

        auditLogger.log(ctx, {
          tool: 'rock_people',
          action: parsed.action,
          target: { model: 'people', id },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'success',
        });
        return formatResponse(parsed.action, ctx, { committed: true, result });
      } catch (err: any) {
        auditLogger.log(ctx, {
          tool: 'rock_people',
          action: parsed.action,
          target: { model: 'people' },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'error',
          errorCode: 'CREATE_TASK_ERROR',
        });
        return formatResponse(parsed.action, ctx, null, {
          code: 'CREATE_TASK_ERROR',
          message: err.message,
        });
      }
    }

    const actionName = (parsed as any).action;
    return formatResponse(actionName, ctx, null, {
      code: 'NOT_IMPLEMENTED',
      message: `Action ${actionName} is not yet implemented.`,
    });
  },
};
