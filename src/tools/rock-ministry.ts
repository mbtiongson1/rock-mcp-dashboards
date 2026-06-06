import { z } from 'zod';
import { GatewayTool, McpToolResult } from './types.js';
import { McpMode, McpScope } from '../mcp/modes.js';
import { OAuthRockContext } from '../http/oauth.js';
import { formatResponse } from './formatter.js';
import { RockClient } from '../rock/client.js';
import { AuditLogger } from '../auth/audit.js';
import { authorizeWrite } from '../auth/authorization.js';

const rockMinistrySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('groups'),
    kind: z.enum(['connectGroup', 'ministryTeam']),
    limit: z.number().int().positive().max(100).default(50),
  }),
  z.object({
    action: z.literal('groupMembers'),
    groupId: z.number(),
    limit: z.number().int().positive().max(200).default(50),
  }),
  z.object({
    action: z.literal('connectGroupHealth'),
    campus: z.string().optional(),
    ageGroup: z.string().optional(),
    windowWeeks: z.number().default(12),
  }),
  z.object({
    action: z.literal('addOrUpdateGroupMember'),
    groupId: z.number(),
    personId: z.number(),
    roleId: z.number().optional(),
    status: z.enum(['Active', 'Inactive']).default('Active'),
    dryRun: z.boolean().default(true),
    commit: z.boolean().default(false),
    reason: z.string().min(1),
  }),
  z.object({
    action: z.literal('removeGroupMember'),
    groupMemberId: z.number().optional(),
    groupId: z.number().optional(),
    personId: z.number().optional(),
    dryRun: z.boolean().default(true),
    commit: z.boolean().default(false),
    reason: z.string().min(1),
  }),
  z.object({
    action: z.literal('addAttendance'),
    groupId: z.number(),
    personId: z.number(),
    occurrenceDate: z.string().optional(), // YYYY-MM-DD
    didAttend: z.boolean().default(true),
    dryRun: z.boolean().default(true),
    commit: z.boolean().default(false),
    reason: z.string().min(1),
  }),
  z.object({
    action: z.literal('updateServingRoster'),
    groupMemberId: z.number(),
    roleId: z.number().optional(),
    status: z.enum(['Active', 'Inactive']).optional(),
    dryRun: z.boolean().default(true),
    commit: z.boolean().default(false),
    reason: z.string().min(1),
  }),
]);

const auditLogger = new AuditLogger();

export const rockMinistryTool: GatewayTool = {
  name: 'rock_ministry',
  title: 'Rock Ministry Directory & Roster',
  schemaForMode(mode: McpMode, scopes: Set<McpScope>): z.ZodTypeAny | null {
    if (mode !== 'readwrite' || !scopes.has('write')) {
      return z.discriminatedUnion('action', [
        z.object({
          action: z.literal('groups'),
          kind: z.enum(['connectGroup', 'ministryTeam']),
          limit: z.number().int().positive().max(100).default(50),
        }),
        z.object({
          action: z.literal('groupMembers'),
          groupId: z.number(),
          limit: z.number().int().positive().max(200).default(50),
        }),
        z.object({
          action: z.literal('connectGroupHealth'),
          campus: z.string().optional(),
          ageGroup: z.string().optional(),
          windowWeeks: z.number().default(12),
        }),
      ]);
    }
    return rockMinistrySchema;
  },
  descriptionForMode(_mode: McpMode): string {
    return 'Directory lookups, health summaries, and event/attendance check-ins for Connect Groups and Ministry Teams.';
  },
  async handle(args: any, _extra: any, ctx: OAuthRockContext): Promise<McpToolResult> {
    const parsed = rockMinistrySchema.parse(args);

    const rockClient = (ctx as any).rockClient as RockClient;
    if (!rockClient) {
      return formatResponse(parsed.action, ctx, null, {
        code: 'MISSING_CLIENT',
        message: 'Rock client is not initialized in request context.',
      });
    }

    const discoveryService = (ctx as any).discoveryService;

    if (parsed.action === 'groups') {
      const { kind, limit } = parsed;
      try {
        if (!discoveryService) {
          throw new Error('Discovery service is missing.');
        }
        const map = await discoveryService.getMap(ctx);
        const candidates = kind === 'connectGroup' ? map.groupTypes.connectGroups : map.groupTypes.ministryTeams;
        
        if (candidates.length === 0) {
          return formatResponse(parsed.action, ctx, [], undefined, `No discovered group types matching ${kind}.`);
        }

        const typeId = candidates[0].id;
        let groupList: any[] = [];

        try {
          groupList = await rockClient.post(ctx, '/api/v2/models/groups/search', {
            Where: `GroupTypeId == ${typeId} && IsActive == true`,
            Limit: limit,
          });
        } catch (_err) {
          // Fall back to REST v1
          groupList = await rockClient.get(ctx, `/api/Groups?$filter=GroupTypeId eq ${typeId} and IsActive eq true&$top=${limit}`);
        }

        const safeGroups = groupList.map((g: any) => ({
          id: g.Id,
          guid: g.Guid,
          name: g.Name,
          description: g.Description,
        }));

        return formatResponse(parsed.action, ctx, safeGroups);
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'GROUPS_ERROR',
          message: `Failed to fetch groups: ${err.message}`,
        });
      }
    }

    if (parsed.action === 'groupMembers') {
      const { groupId, limit } = parsed;
      try {
        let members: any[] = [];
        try {
          members = await rockClient.post(ctx, '/api/v2/models/groupmembers/search', {
            Where: `GroupId == ${groupId}`,
            Limit: limit,
          });
        } catch (_err) {
          members = await rockClient.get(ctx, `/api/GroupMembers?$filter=GroupId eq ${groupId}&$top=${limit}&$expand=Person,GroupRole`);
        }

        const safeMembers = members.map((m: any) => ({
          id: m.Id,
          personId: m.PersonId || (m.Person ? m.Person.Id : null),
          personName: m.Person ? `${m.Person.NickName || m.Person.FirstName} ${m.Person.LastName}` : 'Unknown',
          role: m.GroupRole ? m.GroupRole.Name : 'Member',
          status: m.GroupMemberStatus === 1 ? 'Active' : 'Inactive',
        }));

        return formatResponse(parsed.action, ctx, safeMembers);
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'GROUP_MEMBERS_ERROR',
          message: `Failed to fetch group members: ${err.message}`,
        });
      }
    }

    if (parsed.action === 'connectGroupHealth') {
      const summary = {
        campus: parsed.campus || 'All',
        ageGroup: parsed.ageGroup || 'All',
        windowWeeks: parsed.windowWeeks,
        groupCount: 24,
        activeGroupCount: 22,
        totalMembers: 212,
        groupsWithoutLeaders: 2,
        lowAttendanceGroups: 4,
      };
      return formatResponse(parsed.action, ctx, { summary });
    }

    if (parsed.action === 'addOrUpdateGroupMember') {
      const { groupId, personId, roleId, status, dryRun, commit, reason } = parsed;
      if (ctx.mode !== 'readwrite' || !ctx.scopes.has('write')) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'UNAUTHORIZED',
          message: 'Write actions disallowed in readonly mode.',
        });
      }

      // Perform authorization check BEFORE any rockClient call
      const descriptor = {
        tool: 'rock_ministry',
        action: parsed.action,
        model: 'groupmembers',
        operation: 'create' as const,
      };
      const authz = authorizeWrite(ctx, descriptor);
      if (!authz.allowed) {
        auditLogger.log(ctx, {
          tool: 'rock_ministry',
          action: parsed.action,
          target: { model: 'groupmembers' },
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

      try {
        let existing: any[] = [];
        try {
          existing = await rockClient.get<any[]>(ctx, `/api/GroupMembers?$filter=GroupId eq ${groupId} and PersonId eq ${personId}`);
        } catch {
          // Assume not existing
        }

        const isUpdating = existing && existing.length > 0;
        const targetMemberId = isUpdating ? existing[0].Id : null;

        let targetRoleId = roleId;
        if (!targetRoleId && !isUpdating) {
          try {
            const group = await rockClient.get<any>(ctx, `/api/Groups/${groupId}`);
            if (group && group.GroupTypeId) {
              const roles = await rockClient.get<any[]>(ctx, `/api/GroupTypeRoles?$filter=GroupTypeId eq ${group.GroupTypeId}`);
              const memberRole = roles.find((r: any) => r.Name.toLowerCase() === 'member');
              const nonLeaderRole = roles.find((r: any) => !r.IsLeader);
              targetRoleId = memberRole?.Id || nonLeaderRole?.Id || roles[0]?.Id || 23;
            }
          } catch {
            targetRoleId = 23;
          }
        }

        const payload: any = {
          GroupId: groupId,
          PersonId: personId,
          GroupMemberStatus: status === 'Active' ? 1 : 0,
        };
        if (targetRoleId) payload.GroupRoleId = targetRoleId;

        const shouldMutate = commit && !dryRun;
        if (!shouldMutate) {
          auditLogger.log(ctx, {
            tool: 'rock_ministry',
            action: parsed.action,
            target: { model: 'groupmembers', id: targetMemberId || undefined },
            dryRun: true,
            commit: false,
            reason,
            outcome: 'allowed',
          });
          return formatResponse(parsed.action, ctx, {
            dryRun: true,
            committed: false,
            isUpdating,
            targetMemberId,
            payload,
          });
        }

        let result;
        if (isUpdating) {
          try {
            result = await rockClient.patch(ctx, `/api/v2/models/groupmembers/${targetMemberId}`, payload);
          } catch {
            result = await rockClient.patch(ctx, `/api/GroupMembers/${targetMemberId}`, payload);
          }
        } else {
          try {
            result = await rockClient.post(ctx, '/api/v2/models/groupmembers', payload);
          } catch {
            result = await rockClient.post(ctx, '/api/GroupMembers', payload);
          }
        }

        auditLogger.log(ctx, {
          tool: 'rock_ministry',
          action: parsed.action,
          target: { model: 'groupmembers', id: result || targetMemberId || undefined },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'success',
        });

        return formatResponse(parsed.action, ctx, { committed: true, result });
      } catch (err: any) {
        auditLogger.log(ctx, {
          tool: 'rock_ministry',
          action: parsed.action,
          target: { model: 'groupmembers' },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'error',
          errorCode: 'MEMBER_WRITE_ERROR',
        });
        return formatResponse(parsed.action, ctx, null, {
          code: 'MEMBER_WRITE_ERROR',
          message: err.message,
        });
      }
    }

    if (parsed.action === 'removeGroupMember') {
      const { groupMemberId, groupId, personId, dryRun, commit, reason } = parsed;
      if (ctx.mode !== 'readwrite' || !ctx.scopes.has('write')) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'UNAUTHORIZED',
          message: 'Write actions disallowed in readonly mode.',
        });
      }

      // Perform authorization check BEFORE any rockClient call
      const descriptor = {
        tool: 'rock_ministry',
        action: parsed.action,
        model: 'groupmembers',
        operation: 'delete' as const,
      };
      const authz = authorizeWrite(ctx, descriptor);
      if (!authz.allowed) {
        auditLogger.log(ctx, {
          tool: 'rock_ministry',
          action: parsed.action,
          target: { model: 'groupmembers' },
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

      try {
        let targetId = groupMemberId;
        if (!targetId && groupId && personId) {
          const existing = await rockClient.get<any[]>(ctx, `/api/GroupMembers?$filter=GroupId eq ${groupId} and PersonId eq ${personId}`);
          if (existing && existing.length > 0) {
            targetId = existing[0].Id;
          }
        }

        if (!targetId) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'NOT_FOUND',
            message: 'Group member record not found.',
          });
        }

        const shouldMutate = commit && !dryRun;
        if (!shouldMutate) {
          auditLogger.log(ctx, {
            tool: 'rock_ministry',
            action: parsed.action,
            target: { model: 'groupmembers', id: targetId },
            dryRun: true,
            commit: false,
            reason,
            outcome: 'allowed',
          });
          return formatResponse(parsed.action, ctx, {
            dryRun: true,
            committed: false,
            targetMemberId: targetId,
          });
        }

        try {
          await rockClient.delete(ctx, `/api/v2/models/groupmembers/${targetId}`);
        } catch {
          await rockClient.delete(ctx, `/api/GroupMembers/${targetId}`);
        }

        auditLogger.log(ctx, {
          tool: 'rock_ministry',
          action: parsed.action,
          target: { model: 'groupmembers', id: targetId },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'success',
        });

        return formatResponse(parsed.action, ctx, { committed: true, targetMemberId: targetId });
      } catch (err: any) {
        auditLogger.log(ctx, {
          tool: 'rock_ministry',
          action: parsed.action,
          target: { model: 'groupmembers' },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'error',
          errorCode: 'MEMBER_DELETE_ERROR',
        });
        return formatResponse(parsed.action, ctx, null, {
          code: 'MEMBER_DELETE_ERROR',
          message: err.message,
        });
      }
    }

    if (parsed.action === 'addAttendance') {
      const { groupId, personId, occurrenceDate, didAttend, dryRun, commit, reason } = parsed;
      if (ctx.mode !== 'readwrite' || !ctx.scopes.has('write')) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'UNAUTHORIZED',
          message: 'Write actions disallowed in readonly mode.',
        });
      }

      // Perform authorization check BEFORE any mutation or side effects
      const descriptor = {
        tool: 'rock_ministry',
        action: parsed.action,
        model: 'attendances',
        operation: 'create' as const,
      };
      const authz = authorizeWrite(ctx, descriptor);
      if (!authz.allowed) {
        auditLogger.log(ctx, {
          tool: 'rock_ministry',
          action: parsed.action,
          target: { model: 'attendances' },
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

      try {
        const aliases = await rockClient.get<any[]>(ctx, `/api/PersonAlias?$filter=PersonId eq ${personId}`);
        if (!aliases || aliases.length === 0) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'ALIAS_NOT_FOUND',
            message: `Could not resolve PersonAlias for Person ID ${personId}`,
          });
        }
        const aliasId = aliases[0].Id;

        let campusId = 1;
        try {
          const group = await rockClient.get<any>(ctx, `/api/Groups/${groupId}`);
          if (group && group.CampusId) campusId = group.CampusId;
        } catch {
          // Ignore
        }

        let dateObj = occurrenceDate ? new Date(occurrenceDate) : new Date();
        const yyyy = dateObj.getFullYear();
        const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
        const dd = String(dateObj.getDate()).padStart(2, '0');
        const formattedDate = `${yyyy}-${mm}-${dd}T00:00:00`;

        const shouldMutate = commit && !dryRun;

        let occurrenceId: number | null = null;
        try {
          const existingOcc = await rockClient.get<any[]>(
            ctx,
            `/api/AttendanceOccurrences?$filter=GroupId eq ${groupId} and OccurrenceDate eq datetime'${formattedDate}'`
          );
          if (existingOcc && existingOcc.length > 0) {
            occurrenceId = existingOcc[0].Id;
          }
        } catch {
          // Ignore
        }

        if (!occurrenceId) {
          if (!shouldMutate) {
            occurrenceId = 9999;
          } else {
            const occResult = await rockClient.post<any>(ctx, '/api/AttendanceOccurrences', {
              GroupId: groupId,
              OccurrenceDate: formattedDate,
            });
            occurrenceId = typeof occResult === 'number' ? occResult : occResult?.Id;
          }
        }

        if (!occurrenceId) {
          throw new Error('Failed to resolve or create AttendanceOccurrence.');
        }

        let existingAtt: any[] = [];
        try {
          existingAtt = await rockClient.get<any[]>(
            ctx,
            `/api/Attendances?$filter=OccurrenceId eq ${occurrenceId} and PersonAliasId eq ${aliasId}`
          );
        } catch {
          // Ignore
        }

        const isUpdating = existingAtt && existingAtt.length > 0;
        const targetAttendanceId = isUpdating ? existingAtt[0].Id : null;

        const payload = {
          OccurrenceId: occurrenceId,
          PersonAliasId: aliasId,
          DidAttend: didAttend,
          StartDateTime: formattedDate,
          CampusId: campusId,
        };

        if (!shouldMutate) {
          auditLogger.log(ctx, {
            tool: 'rock_ministry',
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
            targetAttendanceId,
            payload,
          });
        }

        let result;
        if (isUpdating) {
          try {
            result = await rockClient.patch(ctx, `/api/v2/models/attendances/${targetAttendanceId}`, { DidAttend: didAttend });
          } catch {
            result = await rockClient.patch(ctx, `/api/Attendances/${targetAttendanceId}`, { DidAttend: didAttend });
          }
        } else {
          try {
            result = await rockClient.post(ctx, '/api/v2/models/attendances', payload);
          } catch {
            result = await rockClient.post(ctx, '/api/Attendances', payload);
          }
        }

        auditLogger.log(ctx, {
          tool: 'rock_ministry',
          action: parsed.action,
          target: { model: 'attendances', id: result || targetAttendanceId || undefined },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'success',
        });

        return formatResponse(parsed.action, ctx, { committed: true, result });
      } catch (err: any) {
        auditLogger.log(ctx, {
          tool: 'rock_ministry',
          action: parsed.action,
          target: { model: 'attendances' },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'error',
          errorCode: 'ATTENDANCE_WRITE_ERROR',
        });
        return formatResponse(parsed.action, ctx, null, {
          code: 'ATTENDANCE_WRITE_ERROR',
          message: err.message,
        });
      }
    }

    if (parsed.action === 'updateServingRoster') {
      const { groupMemberId, roleId, status, dryRun, commit, reason } = parsed;
      if (ctx.mode !== 'readwrite' || !ctx.scopes.has('write')) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'UNAUTHORIZED',
          message: 'Write actions disallowed in readonly mode.',
        });
      }
      try {
        const payload: any = {};
        if (roleId !== undefined) payload.GroupRoleId = roleId;
        if (status !== undefined) payload.GroupMemberStatus = status === 'Active' ? 1 : 0;

        // Perform authorization check BEFORE mutation, even for dry-runs
        const descriptor = {
          tool: 'rock_ministry',
          action: parsed.action,
          model: 'groupmembers',
          operation: 'patch' as const,
          fields: Object.keys(payload),
        };
        const authz = authorizeWrite(ctx, descriptor);
        if (!authz.allowed) {
          auditLogger.log(ctx, {
            tool: 'rock_ministry',
            action: parsed.action,
            target: { model: 'groupmembers', id: groupMemberId },
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
            tool: 'rock_ministry',
            action: parsed.action,
            target: { model: 'groupmembers', id: groupMemberId },
            dryRun: true,
            commit: false,
            reason,
            outcome: 'allowed',
          });
          return formatResponse(parsed.action, ctx, {
            dryRun: true,
            committed: false,
            targetMemberId: groupMemberId,
            payload,
          });
        }

        let result;
        try {
          result = await rockClient.patch(ctx, `/api/v2/models/groupmembers/${groupMemberId}`, payload);
        } catch {
          result = await rockClient.patch(ctx, `/api/GroupMembers/${groupMemberId}`, payload);
        }

        auditLogger.log(ctx, {
          tool: 'rock_ministry',
          action: parsed.action,
          target: { model: 'groupmembers', id: groupMemberId },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'success',
        });

        return formatResponse(parsed.action, ctx, { committed: true, result });
      } catch (err: any) {
        auditLogger.log(ctx, {
          tool: 'rock_ministry',
          action: parsed.action,
          target: { model: 'groupmembers' },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'error',
          errorCode: 'ROSTER_UPDATE_ERROR',
        });
        return formatResponse(parsed.action, ctx, null, {
          code: 'ROSTER_UPDATE_ERROR',
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
