import { z } from 'zod';
import { GatewayTool, McpToolResult } from './types.js';
import { McpMode, McpScope } from '../mcp/modes.js';
import { OAuthRockContext } from '../http/oauth.js';
import { formatResponse } from './formatter.js';
import { RockClient } from '../rock/client.js';
import { quoteLinqString, quoteODataString, assertValidGuid } from '../rock/query.js';
import { AuditLogger } from '../auth/audit.js';
import { authorizeWrite } from '../auth/authorization.js';

const rockPeopleSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('find'),
    query: z.string().min(1),
    limit: z.number().int().positive().max(100).default(20),
  }),
  z.object({
    action: z.literal('profile'),
    person: z.object({
      id: z.number().optional(),
      guid: z.string().optional(),
      search: z.string().optional(),
    }),
    include: z.array(z.enum(['groups', 'family', 'connectionStatus', 'attendanceSummary', 'servingSummary'])).optional(),
    includeSensitive: z.boolean().default(false),
  }),
  z.object({
    action: z.literal('groups'),
    person: z.object({
      id: z.number().optional(),
      guid: z.string().optional(),
      search: z.string().optional(),
    }),
  }),
  z.object({
    action: z.literal('family'),
    person: z.object({
      id: z.number().optional(),
      guid: z.string().optional(),
      search: z.string().optional(),
    }),
  }),
  z.object({
    action: z.literal('connectionStatus'),
    person: z.object({
      id: z.number().optional(),
      guid: z.string().optional(),
      search: z.string().optional(),
    }),
  }),
  z.object({
    action: z.literal('attendanceSummary'),
    person: z.object({
      id: z.number().optional(),
      guid: z.string().optional(),
      search: z.string().optional(),
    }),
    windowWeeks: z.number().int().positive().max(52).default(12),
  }),
  z.object({
    action: z.literal('servingSummary'),
    person: z.object({
      id: z.number().optional(),
      guid: z.string().optional(),
      search: z.string().optional(),
    }),
  }),
  z.object({
    action: z.literal('updateContactInfo'),
    personId: z.number().optional(),
    personGuid: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    dryRun: z.boolean().default(true),
    commit: z.boolean().default(false),
    reason: z.string().min(1),
  }),
  z.object({
    action: z.literal('patchAttributes'),
    personId: z.number().optional(),
    personGuid: z.string().optional(),
    attributes: z.record(z.unknown()),
    dryRun: z.boolean().default(true),
    commit: z.boolean().default(false),
    reason: z.string().min(1),
  }),
  z.object({
    action: z.literal('createNote'),
    personId: z.number().optional(),
    personGuid: z.string().optional(),
    text: z.string().min(1),
    noteType: z.string().optional(),
    dryRun: z.boolean().default(true),
    commit: z.boolean().default(false),
    reason: z.string().min(1),
  }),
  z.object({
    action: z.literal('createFollowUpTask'),
    personId: z.number().optional(),
    personGuid: z.string().optional(),
    title: z.string().min(1),
    description: z.string().optional(),
    assignedToId: z.number().optional(),
    connectionOpportunityId: z.number().optional(),
    dryRun: z.boolean().default(true),
    commit: z.boolean().default(false),
    reason: z.string().min(1),
  }),
]);

const auditLogger = new AuditLogger();

async function resolvePersonId(client: RockClient, ctx: OAuthRockContext, person: { id?: number; guid?: string; search?: string }): Promise<number | null> {
  if (person.id) return person.id;
  if (person.guid) {
    const validGuid = assertValidGuid(person.guid);
    let results: any[] = [];
    try {
      results = await client.post(ctx, '/api/v2/models/people/search', { Where: `Guid == ${quoteLinqString(validGuid)}` });
    } catch {
      results = await client.get(ctx, `/api/People?$filter=Guid eq guid${quoteODataString(validGuid)}`);
    }
    if (results && results.length > 0) return results[0].Id;
  }
  if (person.search) {
    let results: any[] = [];
    try {
      const quoted = quoteLinqString(person.search);
      results = await client.post(ctx, '/api/v2/models/people/search', { Where: `NickName == ${quoted} || LastName == ${quoted} || (NickName + " " + LastName) == ${quoted}` });
    } catch {
      const odataFilter = `(NickName eq ${quoteODataString(person.search)}) or (LastName eq ${quoteODataString(person.search)})`;
      results = await client.get(ctx, `/api/People?$filter=${encodeURIComponent(odataFilter)}`);
    }
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
 * Classify groups by type using discovery map.
 */
async function getPersonGroups(
  client: RockClient,
  ctx: OAuthRockContext,
  personId: number,
  discoveryService: any
): Promise<{ connectGroups: any[]; ministryTeams: any[]; other: any[]; warning?: string }> {
  try {
    let members: any[] = [];
    try {
      members = await client.post(ctx, '/api/v2/models/groupmembers/search', {
        Where: `PersonId == ${personId}`,
        Limit: 200,
      });
    } catch {
      members = await client.get(ctx, `/api/GroupMembers?$filter=PersonId eq ${personId}&$top=200&$expand=Group,GroupRole`);
    }

    const connectGroups: any[] = [];
    const ministryTeams: any[] = [];
    const other: any[] = [];

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
      const group = m.Group || {};
      const groupTypeId = group.GroupTypeId;
      const item = {
        groupId: group.Id,
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
        Where: 'Name == "Family"',
      });
      if (groupTypes && groupTypes.length > 0) {
        familyGroupTypeId = groupTypes[0].Id;
      }
    } catch {
      // Try v1 fallback
      try {
        const groupTypes = await client.get<any[]>(ctx, `/api/GroupTypes?$filter=substringof('Family', Name) eq true`);
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
      // Try v1 fallback
      try {
        const familyGroupMembers = await client.get<any[]>(
          ctx,
          `/api/GroupMembers?$filter=PersonId eq ${personId} and Group/GroupTypeId eq ${familyGroupTypeId}&$expand=Group&$top=1`
        );
        if (familyGroupMembers && familyGroupMembers.length > 0) {
          const familyGroupId = familyGroupMembers[0].Group?.Id;
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

    // Simple heuristic: Regular >= 50% of weeks, Occasional >= 1, else Inactive
    let consistency = 'Inactive';
    if (attendedCount >= windowWeeks * 0.5) {
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

export const rockPeopleTool: GatewayTool = {
  name: 'rock_people',
  title: 'Rock People Directory',
  schemaForMode(mode: McpMode, scopes: Set<McpScope>): z.ZodTypeAny | null {
    if (mode !== 'readwrite' || !scopes.has('write')) {
      return z.discriminatedUnion('action', [
        z.object({
          action: z.literal('find'),
          query: z.string().min(1),
          limit: z.number().int().positive().max(100).default(20),
        }),
        z.object({
          action: z.literal('profile'),
          person: z.object({
            id: z.number().optional(),
            guid: z.string().optional(),
            search: z.string().optional(),
          }),
          include: z.array(z.enum(['groups', 'family', 'connectionStatus', 'attendanceSummary', 'servingSummary'])).optional(),
          includeSensitive: z.boolean().default(false),
        }),
        z.object({
          action: z.literal('groups'),
          person: z.object({
            id: z.number().optional(),
            guid: z.string().optional(),
            search: z.string().optional(),
          }),
        }),
        z.object({
          action: z.literal('family'),
          person: z.object({
            id: z.number().optional(),
            guid: z.string().optional(),
            search: z.string().optional(),
          }),
        }),
        z.object({
          action: z.literal('connectionStatus'),
          person: z.object({
            id: z.number().optional(),
            guid: z.string().optional(),
            search: z.string().optional(),
          }),
        }),
        z.object({
          action: z.literal('attendanceSummary'),
          person: z.object({
            id: z.number().optional(),
            guid: z.string().optional(),
            search: z.string().optional(),
          }),
          windowWeeks: z.number().int().positive().max(52).default(12),
        }),
        z.object({
          action: z.literal('servingSummary'),
          person: z.object({
            id: z.number().optional(),
            guid: z.string().optional(),
            search: z.string().optional(),
          }),
        }),
      ]);
    }
    return rockPeopleSchema;
  },
  descriptionForMode(_mode: McpMode): string {
    return 'Directory lookups, profiles, and relationship workflows for people in Rock RMS.';
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
        } catch (_err) {
          // Fall back to REST v1
          const odataFilter = `(substringof(${quoteODataString(query)}, NickName) eq true) or (substringof(${quoteODataString(query)}, LastName) eq true)`;
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

    if (parsed.action === 'profile') {
      const { person, include, includeSensitive } = parsed;
      const discoveryService = (ctx as any).discoveryService;
      try {
        let match: any = null;

        if (person.id) {
          try {
            match = await rockClient.get(ctx, `/api/v2/models/people/${person.id}`);
          } catch (_err) {
            match = await rockClient.get(ctx, `/api/People/${person.id}`);
          }
        } else if (person.guid) {
          const validGuid = assertValidGuid(person.guid);
          let results: any[] = [];
          try {
            results = await rockClient.post(ctx, '/api/v2/models/people/search', {
              Where: `Guid == ${quoteLinqString(validGuid)}`,
            });
          } catch (_err) {
            results = await rockClient.get(ctx, `/api/People?$filter=Guid eq guid${quoteODataString(validGuid)}`);
          }
          if (results && results.length > 0) {
            match = results[0];
          }
        } else if (person.search) {
          let results: any[] = [];
          try {
            const quoted = quoteLinqString(person.search);
            results = await rockClient.post(ctx, '/api/v2/models/people/search', {
              Where: `NickName == ${quoted} || LastName == ${quoted} || (NickName + " " + LastName) == ${quoted}`,
            });
          } catch (_err) {
            const odataFilter = `(NickName eq ${quoteODataString(person.search)}) or (LastName eq ${quoteODataString(person.search)})`;
            results = await rockClient.get(ctx, `/api/People?$filter=${encodeURIComponent(odataFilter)}`);
          }
          if (results && results.length > 0) {
            match = results[0];
          }
        }

        if (!match) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'NOT_FOUND',
            message: 'Person not found.',
          });
        }

        const isAuthorizedForSensitive = includeSensitive && ctx.mode === 'readwrite' && ctx.scopes.has('write');

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
          for (const includeType of include) {
            if (includeType === 'groups') {
              const groupData = await getPersonGroups(rockClient, ctx, match.Id, discoveryService);
              profileResult.groups = groupData;
            } else if (includeType === 'family') {
              const familyData = await getFamily(rockClient, ctx, match.Id);
              profileResult.family = familyData;
            } else if (includeType === 'connectionStatus') {
              const connData = await getConnectionStatus(rockClient, ctx, match.Id, discoveryService);
              profileResult.connectionStatus = connData;
            } else if (includeType === 'attendanceSummary') {
              const attData = await getAttendanceSummary(rockClient, ctx, match.Id, 12);
              profileResult.attendanceSummary = attData;
            } else if (includeType === 'servingSummary') {
              const servData = await getServingSummary(rockClient, ctx, match.Id, discoveryService);
              profileResult.servingSummary = servData;
            }
          }
        }

        return formatResponse(parsed.action, ctx, profileResult);
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
            message: 'Person not found.',
          });
        }
        const data: any = {};
        if (email !== undefined) data.Email = email;
        if (phone !== undefined) data.MobilePhoneNumber = phone;
        if (firstName !== undefined) data.FirstName = firstName;
        if (lastName !== undefined) data.LastName = lastName;

        // Perform authorization check BEFORE mutation, even for dry-runs
        const descriptor = {
          tool: 'rock_people',
          action: parsed.action,
          model: 'people',
          operation: 'patch' as const,
          fields: Object.keys(data),
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
            data,
          });
        }

        let result;
        try {
          result = await rockClient.patch(ctx, `/api/v2/models/people/${id}`, data);
        } catch {
          result = await rockClient.patch(ctx, `/api/People/${id}`, data);
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
            message: 'Person not found.',
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
      } catch (err: any) {
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
        return formatResponse(parsed.action, ctx, null, {
          code: 'PATCH_ATTRIBUTES_ERROR',
          message: err.message,
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
            message: 'Person not found.',
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
            message: 'Person not found.',
          });
        }

        const discoveryService = (ctx as any).discoveryService;
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
            message: 'Person not found.',
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
            message: 'Person not found.',
          });
        }

        const discoveryService = (ctx as any).discoveryService;
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
            message: 'Person not found.',
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
            message: 'Person not found.',
          });
        }

        const discoveryService = (ctx as any).discoveryService;
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
      try {
        const id = personId || (personGuid ? await resolvePersonId(rockClient, ctx, { guid: personGuid }) : null);
        if (!id) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'NOT_FOUND',
            message: 'Person not found.',
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

        let oppId = connectionOpportunityId || 1;

        const payload: any = {
          ConnectionOpportunityId: oppId,
          ConnectionStatusId: 2, // In Progress
          PersonAliasId: aliasId,
          Comments: description ? `${title}\n\n${description}` : title,
        };
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
