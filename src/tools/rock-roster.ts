import { z } from 'zod';
import { GatewayTool, McpToolResult } from './types.js';
import { McpMode, McpScope } from '../mcp/modes.js';
import { OAuthRockContext } from '../http/oauth.js';
import { formatResponse } from './formatter.js';
import { RockClient } from '../rock/client.js';
import { AuditLogger } from '../auth/audit.js';
import { authorizeWrite } from '../auth/authorization.js';
import { quoteODataString } from '../rock/query.js';

const auditLogger = new AuditLogger();

// Rock RSVP enum: No=0, Yes=1, Maybe=2, Unknown=3. schedule() uses Unknown(3) for pending and Yes(1) for
// confirmed; unschedule() inactivation uses No(0). VERIFY the pending value against a real scheduled-but-
// unconfirmed Attendance on rock-preview before relying on it.
const RSVP_NO = 0;
const RSVP_YES = 1;
const RSVP_MAYBE = 2;
const RSVP_UNKNOWN = 3;

const RSVP_LABELS: Record<number, string> = {
  [RSVP_NO]: 'No',
  [RSVP_YES]: 'Yes',
  [RSVP_MAYBE]: 'Maybe',
  [RSVP_UNKNOWN]: 'Unknown',
};

function rsvpLabel(value: unknown): string {
  // Guard null/undefined BEFORE Number() coercion: Number(null) === 0, which would
  // otherwise misreport an unset RSVP as 'No' instead of 'Unknown'.
  if (value == null) return 'Unknown';
  const numeric = typeof value === 'number' ? value : Number(value);
  return RSVP_LABELS[numeric] ?? 'Unknown';
}

const rockRosterSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('rosterOptions'),
    groupId: z.coerce.number().describe('Rock group ID whose serving roles and services to list.'),
  }),
  z.object({
    action: z.literal('viewRoster'),
    groupId: z.coerce.number(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Service date, YYYY-MM-DD.'),
  }),
  z.object({
    action: z.literal('schedule'),
    groupId: z.coerce.number(),
    // person: exactly one of these resolves the volunteer
    personAliasId: z.coerce.number().optional(),
    personId: z.coerce.number().optional(),
    personName: z.string().min(1).optional().describe('Fuzzy name; resolved to a person (ambiguity errors).'),
    // role: a GroupLocation (locationId) or its name
    locationId: z.coerce.number().optional(),
    roleName: z.string().min(1).optional().describe("Serving role name, e.g. 'Tech Captain'."),
    // service: a Schedule (scheduleId) or its name
    scheduleId: z.coerce.number().optional(),
    serviceName: z.string().min(1).optional().describe("Service/time name, e.g. '10AM'."),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    confirmed: z.boolean().default(false).describe('false → pending (RSVP Unknown); true → confirmed (RSVP Yes).'),
    dryRun: z.boolean().default(true).describe('Preview-only by default. Set dryRun:false AND commit:true to apply.'),
    commit: z.boolean().default(false).describe('Must be true (with dryRun:false) to actually write.'),
    reason: z.string().min(1).describe('Required justification; recorded in the audit log.'),
  }),
  z.object({
    action: z.literal('unschedule'),
    groupId: z.coerce.number(),
    personAliasId: z.coerce.number().optional(),
    personId: z.coerce.number().optional(),
    personName: z.string().min(1).optional(),
    locationId: z.coerce.number().optional(),
    roleName: z.string().min(1).optional(),
    scheduleId: z.coerce.number().optional(),
    serviceName: z.string().min(1).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dryRun: z.boolean().default(true).describe('Preview-only by default. Set dryRun:false AND commit:true to apply.'),
    commit: z.boolean().default(false).describe('Must be true (with dryRun:false) to actually write.'),
    reason: z.string().min(1).describe('Required justification; recorded in the audit log.'),
  }),
]);

const rockRosterReadOnlySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('rosterOptions'),
    groupId: z.coerce.number().describe('Rock group ID whose serving roles and services to list.'),
  }),
  z.object({
    action: z.literal('viewRoster'),
    groupId: z.coerce.number(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Service date, YYYY-MM-DD.'),
  }),
]);

interface RoleOption {
  locationId: number;
  name: string;
}

interface ServiceOption {
  scheduleId: number;
  name: string;
}

/**
 * Fetch the group's serving roles (GroupLocations) and services (Schedules).
 * Shared by rosterOptions and viewRoster (which needs id->name lookups for grouping).
 */
async function fetchRolesAndServices(
  rockClient: RockClient,
  ctx: OAuthRockContext,
  groupId: number
): Promise<{ roles: RoleOption[]; services: ServiceOption[] }> {
  const roleRows = await rockClient.get<any[]>(
    ctx,
    `/api/GroupLocations?$filter=GroupId eq ${groupId}&$expand=Location&$select=Id,LocationId,Location/Name`
  );
  const roles: RoleOption[] = (roleRows || []).map((row: any) => ({
    locationId: row.LocationId,
    name: row.Location?.Name,
  }));

  let services: ServiceOption[];
  try {
    // Primary: GroupLocationSchedules links a group's serving locations to Schedules.
    // NEEDS LIVE-PREVIEW VERIFICATION — the exact filter shape linking GroupLocations to
    // Schedules for a given GroupId is unconfirmed without a real Rock instance; falls
    // back to the AttendanceOccurrences-derived path below if this 400s/404s or is empty.
    const scheduleRows = await rockClient.get<any[]>(
      ctx,
      `/api/GroupLocationSchedules?$filter=GroupLocation/GroupId eq ${groupId}&$expand=Schedule`
    );
    if (!scheduleRows || scheduleRows.length === 0) {
      throw new Error('GroupLocationSchedules returned no rows; falling back.');
    }
    const seen = new Map<number, ServiceOption>();
    for (const row of scheduleRows) {
      const scheduleId = row.ScheduleId;
      const name = row.Schedule?.Name;
      if (scheduleId !== undefined && scheduleId !== null && !seen.has(scheduleId)) {
        seen.set(scheduleId, { scheduleId, name });
      }
    }
    services = Array.from(seen.values());
  } catch {
    // Fallback: collect distinct ScheduleIds from recent AttendanceOccurrences for the
    // group, then resolve each to a Schedule name.
    const occurrenceRows = await rockClient.get<any[]>(
      ctx,
      `/api/AttendanceOccurrences?$filter=GroupId eq ${groupId} and ScheduleId ne null&$top=100`
    );
    const distinctScheduleIds = Array.from(
      new Set((occurrenceRows || []).map((row: any) => row.ScheduleId).filter((id: any) => id !== undefined && id !== null))
    ) as number[];

    if (distinctScheduleIds.length === 0) {
      services = [];
    } else {
      const filter = distinctScheduleIds.map((id) => `Id eq ${id}`).join(' or ');
      const scheduleRows = await rockClient.get<any[]>(ctx, `/api/Schedules?$filter=${filter}`);
      services = (scheduleRows || []).map((row: any) => ({ scheduleId: row.Id, name: row.Name }));
    }
  }

  return { roles, services };
}

function nextDayIso(date: string): string {
  const [year, month, day] = date.split('-').map((part) => parseInt(part, 10));
  // Construct in UTC to avoid local-timezone drift shifting the calendar day.
  const dateObj = new Date(Date.UTC(year, month - 1, day));
  dateObj.setUTCDate(dateObj.getUTCDate() + 1);
  const yyyy = dateObj.getUTCFullYear();
  const mm = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dateObj.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

interface ResolveErrorResult {
  code: string;
  message: string;
  details?: unknown;
}

type ResolvePersonResult = { personAliasId: number } | { error: ResolveErrorResult };
type ResolveRoleResult = { locationId: number } | { error: ResolveErrorResult };
type ResolveServiceResult = { scheduleId: number } | { error: ResolveErrorResult };
type ResolveScheduleTargetResult =
  | { personAliasId: number; locationId: number; scheduleId: number }
  | { error: ResolveErrorResult };

/**
 * Resolve a volunteer to a PersonAliasId. Exactly one of personAliasId/personId/personName
 * is expected; personAliasId wins if given. Reusable by unschedule (B4).
 */
async function resolvePerson(
  rockClient: RockClient,
  ctx: OAuthRockContext,
  input: { personAliasId?: number; personId?: number; personName?: string }
): Promise<ResolvePersonResult> {
  const { personAliasId, personId, personName } = input;

  if (personAliasId) {
    return { personAliasId };
  }

  if (personId) {
    try {
      const person = await rockClient.get<any>(ctx, `/api/People/${personId}`);
      if (person && person.PrimaryAliasId) {
        return { personAliasId: person.PrimaryAliasId };
      }
    } catch {
      // Fall through to the PersonAlias lookup below.
    }
    const aliases = await rockClient.get<any[]>(ctx, `/api/PersonAlias?$filter=PersonId eq ${personId}`);
    if (aliases && aliases.length > 0) {
      return { personAliasId: aliases[0].Id };
    }
    return {
      error: { code: 'PERSON_NOT_FOUND', message: `Could not resolve PersonAlias for Person ID ${personId}.` },
    };
  }

  if (personName) {
    // Mirrors rock-people.ts `find`'s v1 fallback name-search shape: split into
    // first/last tokens when possible for a tighter match.
    const parts = personName.trim().split(/\s+/);
    let odataFilter: string;
    if (parts.length >= 2) {
      const first = parts[0];
      const last = parts.slice(1).join(' ');
      odataFilter =
        `((substringof(${quoteODataString(first)}, NickName) eq true) or (substringof(${quoteODataString(first)}, FirstName) eq true)) and (substringof(${quoteODataString(last)}, LastName) eq true)`;
    } else {
      odataFilter = `(substringof(${quoteODataString(personName)}, NickName) eq true) or (substringof(${quoteODataString(personName)}, LastName) eq true)`;
    }
    const matches = await rockClient.get<any[]>(ctx, `/api/People?$filter=${encodeURIComponent(odataFilter)}&$top=10`);

    if (!matches || matches.length === 0) {
      return { error: { code: 'PERSON_NOT_FOUND', message: `No person found matching '${personName}'.` } };
    }
    if (matches.length > 1) {
      return {
        error: {
          code: 'PERSON_AMBIGUOUS',
          message: `Multiple people match '${personName}'. Pass personId or personAliasId to disambiguate.`,
          details: {
            candidates: matches.map((p: any) => ({
              personId: p.Id,
              name: `${p.NickName || p.FirstName} ${p.LastName}`,
            })),
          },
        },
      };
    }

    const person = matches[0];
    if (person.PrimaryAliasId) {
      return { personAliasId: person.PrimaryAliasId };
    }
    const aliases = await rockClient.get<any[]>(ctx, `/api/PersonAlias?$filter=PersonId eq ${person.Id}`);
    if (aliases && aliases.length > 0) {
      return { personAliasId: aliases[0].Id };
    }
    return { error: { code: 'PERSON_NOT_FOUND', message: `Could not resolve PersonAlias for '${personName}'.` } };
  }

  return {
    error: {
      code: 'PERSON_INPUT_REQUIRED',
      message: 'One of personAliasId, personId, or personName is required.',
    },
  };
}

/** Resolve a serving role (GroupLocation) to a locationId. `roles` is only needed when matching by name. */
function resolveRole(locationId: number | undefined, roleName: string | undefined, roles: RoleOption[] | null): ResolveRoleResult {
  if (locationId) {
    return { locationId };
  }
  if (roleName) {
    const available = roles || [];
    const matches = available.filter((r) => r.name && r.name.toLowerCase() === roleName.toLowerCase());
    if (matches.length === 0) {
      return {
        error: {
          code: 'ROLE_UNRESOLVED',
          message: `No serving role matching '${roleName}' was found for this group.`,
          details: { availableRoles: available.map((r) => r.name) },
        },
      };
    }
    if (matches.length > 1) {
      return {
        error: {
          code: 'ROLE_AMBIGUOUS',
          message: `Multiple serving roles match '${roleName}'.`,
          details: { matches: matches.map((r) => ({ locationId: r.locationId, name: r.name })) },
        },
      };
    }
    return { locationId: matches[0].locationId };
  }
  return { error: { code: 'ROLE_INPUT_REQUIRED', message: 'One of locationId or roleName is required.' } };
}

/** Resolve a service (Schedule) to a scheduleId. `services` is only needed when matching by name. */
function resolveService(
  scheduleId: number | undefined,
  serviceName: string | undefined,
  services: ServiceOption[] | null
): ResolveServiceResult {
  if (scheduleId) {
    return { scheduleId };
  }
  if (serviceName) {
    const available = services || [];
    const matches = available.filter((s) => s.name && s.name.toLowerCase() === serviceName.toLowerCase());
    if (matches.length === 0) {
      return {
        error: {
          code: 'SERVICE_UNRESOLVED',
          message: `No service matching '${serviceName}' was found for this group.`,
          details: { availableServices: available.map((s) => s.name) },
        },
      };
    }
    if (matches.length > 1) {
      return {
        error: {
          code: 'SERVICE_AMBIGUOUS',
          message: `Multiple services match '${serviceName}'.`,
          details: { matches: matches.map((s) => ({ scheduleId: s.scheduleId, name: s.name })) },
        },
      };
    }
    return { scheduleId: matches[0].scheduleId };
  }
  return { error: { code: 'SERVICE_INPUT_REQUIRED', message: 'One of scheduleId or serviceName is required.' } };
}

/**
 * Resolve person + role + service inputs to concrete ids for `schedule`/`unschedule`.
 * Read-only (may run before authz per plan). Reusable by unschedule (B4).
 */
async function resolveScheduleTarget(
  rockClient: RockClient,
  ctx: OAuthRockContext,
  groupId: number,
  input: {
    personAliasId?: number;
    personId?: number;
    personName?: string;
    locationId?: number;
    roleName?: string;
    scheduleId?: number;
    serviceName?: string;
  }
): Promise<ResolveScheduleTargetResult> {
  const personResult = await resolvePerson(rockClient, ctx, input);
  if ('error' in personResult) return personResult;

  let roles: RoleOption[] | null = null;
  let services: ServiceOption[] | null = null;
  const needsGroupRosterOptions = !input.locationId || !input.scheduleId;
  if (needsGroupRosterOptions) {
    const fetched = await fetchRolesAndServices(rockClient, ctx, groupId);
    roles = fetched.roles;
    services = fetched.services;
  }

  const roleResult = resolveRole(input.locationId, input.roleName, roles);
  if ('error' in roleResult) return roleResult;

  const serviceResult = resolveService(input.scheduleId, input.serviceName, services);
  if ('error' in serviceResult) return serviceResult;

  return {
    personAliasId: personResult.personAliasId,
    locationId: roleResult.locationId,
    scheduleId: serviceResult.scheduleId,
  };
}

export const rockRosterTool: GatewayTool = {
  name: 'rock_roster',
  title: 'Rock Group Scheduler Roster',
  schemaForMode(
    mode: McpMode,
    scopes: Set<McpScope>,
    _caps: { isAdmin: boolean; isStaffOrAdmin: boolean }
  ): z.ZodTypeAny | null {
    if (mode !== 'readwrite' || !scopes.has('write')) {
      return rockRosterReadOnlySchema;
    }
    // Writes are visible to admins AND leaders (no isAdmin gate on visibility); per-group
    // leadership enforcement happens at handle time (implemented in B3/B4).
    return rockRosterSchema;
  },
  descriptionForMode(_mode: McpMode): string {
    return 'Group Scheduler: schedule/unschedule volunteers to a specific date, service time, and serving role, and view a date\'s roster. Use whenever a request mentions a specific date, service, or role assignment — e.g. \'roster X to [team] for Sunday\', \'schedule the July 19 team\', \'assign X to Stream Operator\', \'who\'s scheduled\'. For long-term team membership (who is on the team), use `rock_ministry` instead.';
  },
  async handle(args: any, _extra: any, ctx: OAuthRockContext): Promise<McpToolResult> {
    const parsed = rockRosterSchema.parse(args);

    const rockClient = (ctx as any).rockClient as RockClient;
    if (!rockClient) {
      return formatResponse(parsed.action, ctx, null, {
        code: 'MISSING_CLIENT',
        message: 'Rock client is not initialized in request context.',
      });
    }

    if (parsed.action === 'rosterOptions') {
      const { groupId } = parsed;
      try {
        const { roles, services } = await fetchRolesAndServices(rockClient, ctx, groupId);
        return formatResponse(parsed.action, ctx, { groupId, roles, services });
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'ROSTER_OPTIONS_ERROR',
          message: `Failed to fetch roster options: ${err.message}`,
        });
      }
    }

    if (parsed.action === 'viewRoster') {
      const { groupId, date } = parsed;
      try {
        const { roles, services } = await fetchRolesAndServices(rockClient, ctx, groupId);
        const roleNameById = new Map<number, string>(roles.map((r) => [r.locationId, r.name]));
        const serviceNameById = new Map<number, string>(services.map((s) => [s.scheduleId, s.name]));

        const start = `${date}T00:00:00`;
        const end = `${nextDayIso(date)}T00:00:00`;

        const occurrences = await rockClient.get<any[]>(
          ctx,
          `/api/AttendanceOccurrences?$filter=GroupId eq ${groupId} and OccurrenceDate ge datetime'${start}' and OccurrenceDate lt datetime'${end}'`
        );

        // scheduleId -> locationId -> volunteers[]
        const byService = new Map<number, Map<number, any[]>>();

        for (const occurrence of occurrences || []) {
          const occurrenceId = occurrence.Id;
          const scheduleId = occurrence.ScheduleId;
          const locationId = occurrence.LocationId;

          const attendances = await rockClient.get<any[]>(
            ctx,
            `/api/Attendances?$filter=OccurrenceId eq ${occurrenceId}&$expand=PersonAlias/Person`
          );

          // ScheduledToAttend/RSVP are Rock enums — NEVER put them in an OData $filter
          // (Rock 400s on enum-vs-int/string mismatches). Filter client-side instead.
          const scheduled = (attendances || []).filter((a: any) => a.ScheduledToAttend === true);

          if (scheduled.length === 0) continue;

          if (!byService.has(scheduleId)) byService.set(scheduleId, new Map());
          const byRole = byService.get(scheduleId)!;
          if (!byRole.has(locationId)) byRole.set(locationId, []);
          const volunteers = byRole.get(locationId)!;

          for (const attendance of scheduled) {
            const personAlias = attendance.PersonAlias || {};
            const person = personAlias.Person || {};
            volunteers.push({
              personId: personAlias.PersonId ?? person.Id ?? null,
              personAliasId: personAlias.Id ?? attendance.PersonAliasId ?? null,
              name: person.NickName || person.FirstName ? `${person.NickName || person.FirstName} ${person.LastName || ''}`.trim() : 'Unknown',
              rsvp: rsvpLabel(attendance.RSVP),
            });
          }
        }

        const servicesOut = Array.from(byService.entries()).map(([scheduleId, byRole]) => ({
          scheduleId,
          serviceName: serviceNameById.get(scheduleId) ?? null,
          roles: Array.from(byRole.entries()).map(([locationId, volunteers]) => ({
            locationId,
            roleName: roleNameById.get(locationId) ?? null,
            volunteers,
          })),
        }));

        return formatResponse(parsed.action, ctx, { groupId, date, services: servicesOut });
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'VIEW_ROSTER_ERROR',
          message: `Failed to fetch roster: ${err.message}`,
        });
      }
    }

    if (parsed.action === 'schedule') {
      const {
        groupId,
        personAliasId,
        personId,
        personName,
        locationId,
        roleName,
        scheduleId,
        serviceName,
        date,
        confirmed,
        dryRun,
        commit,
        reason,
      } = parsed;

      // 1. Inline mode/scope gate (mirrors rock-ministry's addAttendance).
      if (ctx.mode !== 'readwrite' || !ctx.scopes.has('write')) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'UNAUTHORIZED',
          message: 'Write actions disallowed in readonly mode.',
        });
      }

      // 2. Resolve person/role/service → ids. These are read-only lookups, so
      // resolution failures (not-found/ambiguous) may run before authz.
      const resolved = await resolveScheduleTarget(rockClient, ctx, groupId, {
        personAliasId,
        personId,
        personName,
        locationId,
        roleName,
        scheduleId,
        serviceName,
      });
      if ('error' in resolved) {
        return formatResponse(parsed.action, ctx, null, resolved.error);
      }
      const resolvedPersonAliasId = resolved.personAliasId;
      const resolvedLocationId = resolved.locationId;
      const resolvedScheduleId = resolved.scheduleId;

      // 3. Compute leadership + authorize BEFORE any mutation.
      const callerIsTargetGroupLeader = ctx.rockUser.isRsrAdmin || ctx.rockUser.ledGroupIds.includes(groupId);

      const occurrenceAuthz = authorizeWrite(ctx, {
        tool: 'rock_roster',
        action: parsed.action,
        model: 'attendanceoccurrences',
        operation: 'create',
        fields: ['GroupId', 'OccurrenceDate', 'ScheduleId', 'LocationId'],
        groupId,
        callerIsTargetGroupLeader,
      });
      if (!occurrenceAuthz.allowed) {
        auditLogger.log(ctx, {
          tool: 'rock_roster',
          action: parsed.action,
          target: { model: 'attendanceoccurrences', id: groupId },
          dryRun,
          commit,
          reason,
          outcome: 'denied',
          errorCode: occurrenceAuthz.code,
        });
        return formatResponse(parsed.action, ctx, null, {
          code: occurrenceAuthz.code || 'AUTHORIZATION_DENIED',
          message: occurrenceAuthz.reason || 'Authorization denied.',
        });
      }

      let campusId: number | null = null;
      try {
        const group = await rockClient.get<any>(ctx, `/api/Groups/${groupId}`);
        if (group && group.CampusId) campusId = group.CampusId;
      } catch {
        // Ignore; campusId may remain null (best-effort, mirrors addAttendance).
      }

      const attendanceFields = [
        'OccurrenceId',
        'PersonAliasId',
        'ScheduledToAttend',
        'RSVP',
        'DidAttend',
        'StartDateTime',
        ...(campusId ? ['CampusId'] : []),
      ];
      const attendanceAuthz = authorizeWrite(ctx, {
        tool: 'rock_roster',
        action: parsed.action,
        model: 'attendances',
        operation: 'create',
        fields: attendanceFields,
        groupId,
        callerIsTargetGroupLeader,
      });
      if (!attendanceAuthz.allowed) {
        auditLogger.log(ctx, {
          tool: 'rock_roster',
          action: parsed.action,
          target: { model: 'attendances', id: groupId },
          dryRun,
          commit,
          reason,
          outcome: 'denied',
          errorCode: attendanceAuthz.code,
        });
        return formatResponse(parsed.action, ctx, null, {
          code: attendanceAuthz.code || 'AUTHORIZATION_DENIED',
          message: attendanceAuthz.reason || 'Authorization denied.',
        });
      }

      const formattedDate = `${date}T00:00:00`;
      const shouldMutate = commit && !dryRun;

      try {
        // 4. Get-or-create the AttendanceOccurrence keyed on {GroupId, LocationId, ScheduleId, OccurrenceDate}.
        let occurrenceId: number | null = null;
        try {
          const existingOcc = await rockClient.get<any[]>(
            ctx,
            `/api/AttendanceOccurrences?$filter=GroupId eq ${groupId} and LocationId eq ${resolvedLocationId} and ScheduleId eq ${resolvedScheduleId} and OccurrenceDate eq datetime'${formattedDate}'`
          );
          if (existingOcc && existingOcc.length > 0) {
            occurrenceId = existingOcc[0].Id;
          }
        } catch {
          // Ignore; fall through to create/preview.
        }

        if (!occurrenceId) {
          if (!shouldMutate) {
            occurrenceId = 9999; // dryRun placeholder, mirrors addAttendance.
          } else {
            // OMIT SundayDate — Rock computes it; sending it can 400.
            const occResult = await rockClient.post<any>(ctx, '/api/AttendanceOccurrences', {
              GroupId: groupId,
              LocationId: resolvedLocationId,
              ScheduleId: resolvedScheduleId,
              OccurrenceDate: formattedDate,
            });
            occurrenceId = typeof occResult === 'number' ? occResult : occResult?.Id;
          }
        }

        if (!occurrenceId) {
          throw new Error('Failed to resolve or create AttendanceOccurrence.');
        }

        // 5. Create-or-patch the Attendance for (OccurrenceId, PersonAliasId).
        // NEVER filter on RSVP/ScheduledToAttend — Rock 400s on enum-vs-int/string mismatches.
        let existingAtt: any[] = [];
        try {
          existingAtt = await rockClient.get<any[]>(
            ctx,
            `/api/Attendances?$filter=OccurrenceId eq ${occurrenceId} and PersonAliasId eq ${resolvedPersonAliasId}`
          );
        } catch {
          // Ignore.
        }

        const isUpdating = existingAtt && existingAtt.length > 0;
        const targetAttendanceId = isUpdating ? existingAtt[0].Id : null;

        const payload: any = {
          OccurrenceId: occurrenceId,
          PersonAliasId: resolvedPersonAliasId,
          ScheduledToAttend: true,
          RSVP: confirmed ? RSVP_YES : RSVP_UNKNOWN,
          DidAttend: false,
          StartDateTime: formattedDate,
        };
        if (campusId) payload.CampusId = campusId;

        const resolvedIds = {
          personAliasId: resolvedPersonAliasId,
          locationId: resolvedLocationId,
          scheduleId: resolvedScheduleId,
          occurrenceId,
        };

        if (!shouldMutate) {
          auditLogger.log(ctx, {
            tool: 'rock_roster',
            action: parsed.action,
            target: { model: 'attendances', id: targetAttendanceId || undefined },
            dryRun: true,
            commit: false,
            reason,
            outcome: 'allowed',
          });
          return formatResponse(parsed.action, ctx, {
            dryRun: true,
            committed: false,
            isUpdating,
            resolved: resolvedIds,
            payload,
          });
        }

        let result;
        if (isUpdating) {
          const patchPayload = { ScheduledToAttend: true, RSVP: payload.RSVP };
          try {
            result = await rockClient.patch(ctx, `/api/v2/models/attendances/${targetAttendanceId}`, patchPayload);
          } catch {
            result = await rockClient.patch(ctx, `/api/Attendances/${targetAttendanceId}`, patchPayload);
          }
        } else {
          try {
            result = await rockClient.post(ctx, '/api/v2/models/attendances', payload);
          } catch {
            result = await rockClient.post(ctx, '/api/Attendances', payload);
          }
        }

        auditLogger.log(ctx, {
          tool: 'rock_roster',
          action: parsed.action,
          target: { model: 'attendances', id: result || targetAttendanceId || undefined },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'success',
        });

        return formatResponse(parsed.action, ctx, { committed: true, isUpdating, resolved: resolvedIds, result });
      } catch (err: any) {
        auditLogger.log(ctx, {
          tool: 'rock_roster',
          action: parsed.action,
          target: { model: 'attendances' },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'error',
          errorCode: 'SCHEDULE_WRITE_ERROR',
        });
        return formatResponse(parsed.action, ctx, null, {
          code: 'SCHEDULE_WRITE_ERROR',
          message: err.message,
        });
      }
    }

    if (parsed.action === 'unschedule') {
      const {
        groupId,
        personAliasId,
        personId,
        personName,
        locationId,
        roleName,
        scheduleId,
        serviceName,
        date,
        dryRun,
        commit,
        reason,
      } = parsed;

      // 1. Inline mode/scope gate (mirrors schedule/removeGroupMember).
      if (ctx.mode !== 'readwrite' || !ctx.scopes.has('write')) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'UNAUTHORIZED',
          message: 'Write actions disallowed in readonly mode.',
        });
      }

      // 2. Resolve person/role/service → ids. Reuse B3's shared resolver. These are
      // read-only lookups, so resolution failures (not-found/ambiguous) may run before authz.
      const resolved = await resolveScheduleTarget(rockClient, ctx, groupId, {
        personAliasId,
        personId,
        personName,
        locationId,
        roleName,
        scheduleId,
        serviceName,
      });
      if ('error' in resolved) {
        return formatResponse(parsed.action, ctx, null, resolved.error);
      }
      const resolvedPersonAliasId = resolved.personAliasId;
      const resolvedLocationId = resolved.locationId;
      const resolvedScheduleId = resolved.scheduleId;

      const formattedDate = `${date}T00:00:00`;

      try {
        // 3. Resolve the occurrence + attendance to remove. Missing either is an
        // idempotent no-op — nothing to unschedule, so no authz check and no mutation.
        const occurrences = await rockClient.get<any[]>(
          ctx,
          `/api/AttendanceOccurrences?$filter=GroupId eq ${groupId} and LocationId eq ${resolvedLocationId} and ScheduleId eq ${resolvedScheduleId} and OccurrenceDate eq datetime'${formattedDate}'`
        );

        if (!occurrences || occurrences.length === 0) {
          auditLogger.log(ctx, {
            tool: 'rock_roster',
            action: parsed.action,
            target: { model: 'attendanceoccurrences', id: groupId },
            dryRun,
            commit,
            reason,
            outcome: 'allowed',
          });
          return formatResponse(parsed.action, ctx, {
            committed: false,
            noop: true,
            note: 'No matching occurrence; nothing to unschedule.',
          });
        }
        const occurrenceId = occurrences[0].Id;

        // NEVER filter on RSVP/ScheduledToAttend — Rock 400s on enum-vs-int/string mismatches.
        const existingAtt = await rockClient.get<any[]>(
          ctx,
          `/api/Attendances?$filter=OccurrenceId eq ${occurrenceId} and PersonAliasId eq ${resolvedPersonAliasId}`
        );

        if (!existingAtt || existingAtt.length === 0) {
          auditLogger.log(ctx, {
            tool: 'rock_roster',
            action: parsed.action,
            target: { model: 'attendances', id: occurrenceId },
            dryRun,
            commit,
            reason,
            outcome: 'allowed',
          });
          return formatResponse(parsed.action, ctx, {
            committed: false,
            noop: true,
            note: 'No matching attendance; nothing to unschedule.',
          });
        }
        const targetAttendanceId = existingAtt[0].Id;

        // 4. Compute leadership + authorize the DELETE. Only reached when there IS an
        // attendance to remove.
        const callerIsTargetGroupLeader = ctx.rockUser.isRsrAdmin || ctx.rockUser.ledGroupIds.includes(groupId);

        const deleteAuthz = authorizeWrite(ctx, {
          tool: 'rock_roster',
          action: parsed.action,
          model: 'attendances',
          operation: 'delete',
          groupId,
          callerIsTargetGroupLeader,
        });
        if (!deleteAuthz.allowed) {
          auditLogger.log(ctx, {
            tool: 'rock_roster',
            action: parsed.action,
            target: { model: 'attendances', id: targetAttendanceId },
            dryRun,
            commit,
            reason,
            outcome: 'denied',
            errorCode: deleteAuthz.code,
          });
          return formatResponse(parsed.action, ctx, null, {
            code: deleteAuthz.code || 'AUTHORIZATION_DENIED',
            message: deleteAuthz.reason || 'Authorization denied.',
          });
        }

        // 5. dryRun preview — no mutation.
        const shouldMutate = commit && !dryRun;
        if (!shouldMutate) {
          auditLogger.log(ctx, {
            tool: 'rock_roster',
            action: parsed.action,
            target: { model: 'attendances', id: targetAttendanceId },
            dryRun: true,
            commit: false,
            reason,
            outcome: 'allowed',
          });
          return formatResponse(parsed.action, ctx, {
            dryRun: true,
            committed: false,
            targetAttendanceId,
            occurrenceId,
            plannedAction: 'delete-with-inactivate-fallback',
          });
        }

        // 6. Commit — delete (v2 then v1), falling back to inactivation on failure.
        try {
          try {
            await rockClient.delete(ctx, `/api/v2/models/attendances/${targetAttendanceId}`);
          } catch {
            await rockClient.delete(ctx, `/api/Attendances/${targetAttendanceId}`);
          }

          auditLogger.log(ctx, {
            tool: 'rock_roster',
            action: parsed.action,
            target: { model: 'attendances', id: targetAttendanceId },
            dryRun: false,
            commit: true,
            reason,
            outcome: 'success',
          });
          return formatResponse(parsed.action, ctx, { committed: true, method: 'deleted', targetAttendanceId });
        } catch {
          // DELETE failed on both v2 and v1 → fall back to inactivating the attendance.
          // Re-authorize for the patch operation before mutating.
          const patchAuthz = authorizeWrite(ctx, {
            tool: 'rock_roster',
            action: parsed.action,
            model: 'attendances',
            operation: 'patch',
            fields: ['ScheduledToAttend', 'RSVP'],
            groupId,
            callerIsTargetGroupLeader,
          });
          if (!patchAuthz.allowed) {
            auditLogger.log(ctx, {
              tool: 'rock_roster',
              action: parsed.action,
              target: { model: 'attendances', id: targetAttendanceId },
              dryRun: false,
              commit: true,
              reason,
              outcome: 'denied',
              errorCode: patchAuthz.code,
            });
            return formatResponse(parsed.action, ctx, null, {
              code: patchAuthz.code || 'AUTHORIZATION_DENIED',
              message: patchAuthz.reason || 'Authorization denied.',
            });
          }

          const patchPayload = { ScheduledToAttend: false, RSVP: RSVP_NO };
          try {
            await rockClient.patch(ctx, `/api/v2/models/attendances/${targetAttendanceId}`, patchPayload);
          } catch {
            await rockClient.patch(ctx, `/api/Attendances/${targetAttendanceId}`, patchPayload);
          }

          auditLogger.log(ctx, {
            tool: 'rock_roster',
            action: parsed.action,
            target: { model: 'attendances', id: targetAttendanceId },
            dryRun: false,
            commit: true,
            reason,
            outcome: 'success',
          });
          return formatResponse(parsed.action, ctx, { committed: true, method: 'inactivated', targetAttendanceId });
        }
      } catch (err: any) {
        auditLogger.log(ctx, {
          tool: 'rock_roster',
          action: parsed.action,
          target: { model: 'attendances', id: groupId },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'error',
          errorCode: 'UNSCHEDULE_ERROR',
        });
        return formatResponse(parsed.action, ctx, null, {
          code: 'UNSCHEDULE_ERROR',
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
