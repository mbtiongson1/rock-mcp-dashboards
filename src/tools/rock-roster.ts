import { z } from 'zod';
import { GatewayTool, McpToolResult } from './types.js';
import { McpMode, McpScope } from '../mcp/modes.js';
import { OAuthRockContext } from '../http/oauth.js';
import { formatResponse } from './formatter.js';
import { RockClient } from '../rock/client.js';

// Rock RSVP enum: No=0, Yes=1, Maybe=2, Unknown=3. schedule() uses Unknown(3) for pending and Yes(1) for
// confirmed; unschedule() inactivation uses No(0). VERIFY the pending value against a real scheduled-but-
// unconfirmed Attendance on rock-preview before relying on it.
const RSVP_NO = 0;
const RSVP_YES = 1;
const RSVP_MAYBE = 2;
const RSVP_UNKNOWN = 3;
// Referenced here so the constants document the full enum even though only some
// values are used by the (stubbed) write actions today.
void RSVP_NO;
void RSVP_YES;
void RSVP_UNKNOWN;

const RSVP_LABELS: Record<number, string> = {
  [RSVP_NO]: 'No',
  [RSVP_YES]: 'Yes',
  [RSVP_MAYBE]: 'Maybe',
  [RSVP_UNKNOWN]: 'Unknown',
};

function rsvpLabel(value: unknown): string {
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
    return 'View and manage volunteer serving assignments (Group Scheduler): list roles/services, view a date\'s roster, and schedule/unschedule volunteers.';
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

    if (parsed.action === 'schedule' || parsed.action === 'unschedule') {
      // WRITE logic implemented in a later task (B3/B4). Stubbed here so the schema
      // advertises all 4 actions now, without applying any mutation.
      return formatResponse(parsed.action, ctx, null, {
        code: 'NOT_IMPLEMENTED',
        message: `Action ${parsed.action} is implemented in a later task.`,
      });
    }

    const actionName = (parsed as any).action;
    return formatResponse(actionName, ctx, null, {
      code: 'NOT_IMPLEMENTED',
      message: `Action ${actionName} is not yet implemented.`,
    });
  },
};
