import { z } from 'zod';
import * as crypto from 'crypto';
import { GatewayTool, McpToolResult } from './types.js';
import { McpMode, McpScope } from '../mcp/modes.js';
import { OAuthRockContext } from '../http/oauth.js';
import { formatResponse } from './formatter.js';
import { RockClient } from '../rock/client.js';
import { AuditLogger } from '../auth/audit.js';
import { authorizeWrite } from '../auth/authorization.js';
import { StoredDataset } from './dataset-store.js';

// Constants for bounded analysis
const MAX_GROUPS_ANALYZED = 100;
// Note: lowAttendanceGroups detection omitted in favor of boundedness per plan §17.7

const rockMinistrySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('groups'),
    kind: z.enum(['connectGroup', 'ministryTeam']),
    limit: z.coerce.number().int().positive().max(100).default(50),
  }),
  z.object({
    action: z.literal('groupMembers'),
    groupId: z.coerce.number(),
    limit: z.coerce.number().int().positive().max(200).default(50),
  }),
  z.object({
    action: z.literal('connectGroupHealth'),
    campus: z.string().optional(),
    ageGroup: z.string().optional(),
    windowWeeks: z.coerce.number().default(12),
    groupTypeId: z.coerce.number().optional(),
  }),
  z.object({
    action: z.literal('leaderCount'),
    campusId: z.coerce.number().optional(), // omit = all campuses
    groupTypeId: z.coerce.number().optional(), // override connect-group type; else discover
    ageGroupBreakdown: z.coerce.boolean().default(false),
  }),
  z.object({
    action: z.literal('addOrUpdateGroupMember'),
    groupId: z.coerce.number(),
    personId: z.coerce.number(),
    roleId: z.coerce.number().optional(),
    status: z.enum(['Active', 'Inactive']).default('Active'),
    dryRun: z.boolean().default(true),
    commit: z.boolean().default(false),
    reason: z.string().min(1),
  }),
  z.object({
    action: z.literal('removeGroupMember'),
    groupMemberId: z.coerce.number().optional(),
    groupId: z.coerce.number().optional(),
    personId: z.coerce.number().optional(),
    dryRun: z.boolean().default(true),
    commit: z.boolean().default(false),
    reason: z.string().min(1),
  }),
  z.object({
    action: z.literal('addAttendance'),
    groupId: z.coerce.number(),
    personId: z.coerce.number(),
    occurrenceDate: z.string().optional(), // YYYY-MM-DD
    didAttend: z.boolean().default(true),
    dryRun: z.boolean().default(true),
    commit: z.boolean().default(false),
    reason: z.string().min(1),
  }),
  z.object({
    action: z.literal('updateServingRoster'),
    groupMemberId: z.coerce.number(),
    roleId: z.coerce.number().optional(),
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
          limit: z.coerce.number().int().positive().max(100).default(50),
        }),
        z.object({
          action: z.literal('groupMembers'),
          groupId: z.coerce.number(),
          limit: z.coerce.number().int().positive().max(200).default(50),
        }),
        z.object({
          action: z.literal('connectGroupHealth'),
          campus: z.string().optional(),
          ageGroup: z.string().optional(),
          windowWeeks: z.coerce.number().default(12),
          groupTypeId: z.coerce.number().optional(),
        }),
        z.object({
          action: z.literal('leaderCount'),
          campusId: z.coerce.number().optional(),
          groupTypeId: z.coerce.number().optional(),
          ageGroupBreakdown: z.coerce.boolean().default(false),
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
      const { campus, ageGroup, windowWeeks, groupTypeId: groupTypeIdOverride } = parsed;
      const discoveryService = (ctx as any).discoveryService;

      try {
        // Track how the group type was resolved for the response
        let connectGroupTypeId: number;
        let discoveryInfo: any;
        let map: any;

        if (groupTypeIdOverride !== undefined) {
          // Caller pinned the group type — skip discovery entirely
          connectGroupTypeId = groupTypeIdOverride;
          discoveryInfo = { connectGroupType: { id: connectGroupTypeId, source: 'override' } };

          // Still need map for campus lookup if campus is provided
          if (campus && discoveryService) {
            try {
              map = await discoveryService.getMap(ctx);
            } catch {
              // Ignore — campus filter will be skipped
            }
          }
        } else {
          // Auto-discover the group type
          if (!discoveryService) {
            return formatResponse(parsed.action, ctx, null, {
              code: 'DISCOVERY_UNAVAILABLE',
              message: 'Discovery service is not available for group type resolution.',
            });
          }

          map = await discoveryService.getMap(ctx);

          // Resolve Connect Group type
          if (!map.groupTypes.connectGroups || map.groupTypes.connectGroups.length === 0) {
            return formatResponse(parsed.action, ctx, null, {
              code: 'NO_GROUP_TYPE',
              message: 'No Connect Group type discovered. Please configure connect groups in Rock RMS.',
            });
          }

          const discovered = map.groupTypes.connectGroups[0];
          connectGroupTypeId = discovered.id;
          discoveryInfo = {
            connectGroupType: {
              name: discovered.name,
              confidence: discovered.confidence,
            },
          };
          if (discovered.confidence < 0.7) {
            discoveryInfo.warning = `Connect group type resolved with low confidence (${discovered.confidence}); results may reflect the wrong group type. Pass groupTypeId to pin it.`;
          }
        }

        // Resolve campus ID if provided
        let campusId: number | null = null;
        if (campus && map) {
          const matchedCampus = map.campuses.find((c: any) => c.name.toLowerCase().includes(campus.toLowerCase()));
          if (matchedCampus) {
            campusId = matchedCampus.id;
          }
        }

        // Fetch groups (v2 first, then v1 fallback)
        let allGroups: any[] = [];
        const whereClause = campusId
          ? `GroupTypeId == ${connectGroupTypeId} && IsActive == true && CampusId == ${campusId}`
          : `GroupTypeId == ${connectGroupTypeId} && IsActive == true`;

        try {
          allGroups = await rockClient.post(ctx, '/api/v2/models/groups/search', {
            Where: whereClause,
            Limit: MAX_GROUPS_ANALYZED + 1, // Request one extra to detect truncation
          });
        } catch (_err) {
          // Fallback to v1
          const v1Filter = campusId
            ? `GroupTypeId eq ${connectGroupTypeId} and IsActive eq true and CampusId eq ${campusId}`
            : `GroupTypeId eq ${connectGroupTypeId} and IsActive eq true`;
          allGroups = await rockClient.get(ctx, `/api/Groups?$filter=${encodeURIComponent(v1Filter)}&$top=${MAX_GROUPS_ANALYZED + 1}`);
        }

        const truncated = allGroups.length > MAX_GROUPS_ANALYZED;
        const groupsToAnalyze = allGroups.slice(0, MAX_GROUPS_ANALYZED);

        // Analyze each group for members and leaders
        let totalMembers = 0;
        let groupsWithoutLeaders = 0;
        const perGroupData: any[] = [];

        for (const group of groupsToAnalyze) {
          try {
            // Fetch group members
            let members: any[] = [];
            try {
              members = await rockClient.post(ctx, '/api/v2/models/groupmembers/search', {
                Where: `GroupId == ${group.Id}`,
              });
            } catch (_err) {
              members = await rockClient.get(ctx, `/api/GroupMembers?$filter=GroupId eq ${group.Id}`);
            }

            const memberCount = members.length;
            totalMembers += memberCount;

            // Check for leaders (GroupRole.IsLeader == true)
            const hasLeader = members.some((m: any) => {
              const role = m.GroupRole || {};
              return role.IsLeader === true;
            });

            if (!hasLeader && memberCount > 0) {
              groupsWithoutLeaders++;
            }

            // Compute age group filter if provided
            let groupMatchesAgeFilter = true;
            if (ageGroup) {
              // Best-effort name-based match
              groupMatchesAgeFilter = (group.Name || '').toLowerCase().includes(ageGroup.toLowerCase());
            }

            perGroupData.push({
              groupId: group.Id,
              groupName: group.Name,
              memberCount,
              hasLeader,
              matchesAgeFilter: groupMatchesAgeFilter,
            });
          } catch (err: any) {
            // Log but continue to next group
            console.warn(`Error analyzing group ${group.Id}: ${err.message}`);
          }
        }

        const analyzedCount = groupsToAnalyze.length;
        const averageMembersPerGroup = analyzedCount > 0 ? Math.round(totalMembers / analyzedCount) : 0;

        // Build summary
        const summary: any = {
          campus: campus || 'All',
          ageGroup: ageGroup || 'All',
          windowWeeks,
          groupCount: Math.max(allGroups.length - (truncated ? 1 : 0), 0), // Account for over-fetch
          activeGroupCount: analyzedCount,
          analyzedCount,
          totalMembers,
          averageMembersPerGroup,
          groupsWithoutLeaders,
          truncated,
        };

        // Note: lowAttendanceGroups omitted as per plan §17.7 (attendance query too expensive)
        // Plan requires bounding at MAX_GROUPS_ANALYZED and omitting lowAttendanceGroups with documentation

        // Store dataset via datasetStore if available
        let datasetId: string | undefined;
        const datasetStore = (ctx as any).datasetStore;
        if (datasetStore) {
          try {
            const oauthSubjectHash = crypto
              .createHash('sha256')
              .update(ctx.oauth.subject || '')
              .digest('hex');

            const ttlSeconds = parseInt(process.env.ROCK_MCP_DATASET_TTL_SECONDS || '900', 10);

            const dataset: StoredDataset = {
              id: `cghealth_${crypto.randomBytes(12).toString('hex')}`,
              owner: {
                oauthSubjectHash,
                rockPersonId: ctx.rockUser?.personId,
                sessionId: ctx.request?.sessionId,
              },
              title: `Connect Group Health Report - ${campus || 'All'} - ${new Date().toISOString().split('T')[0]}`,
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
              source: {
                tool: 'rock_ministry',
                action: 'connectGroupHealth',
                model: 'groups',
              },
              columns: ['groupId', 'groupName', 'memberCount', 'hasLeader', 'matchesAgeFilter'],
              rows: perGroupData,
              summary: JSON.stringify(summary),
              sensitivity: 'low',
            };

            await datasetStore.put(dataset);
            datasetId = dataset.id;
          } catch (err: any) {
            console.warn(`Failed to store dataset: ${err.message}`);
            // Continue without dataset ID
          }
        }

        const response: any = { summary };
        if (datasetId) {
          response.datasetId = datasetId;
        }
        response.discovery = discoveryInfo;

        return formatResponse(parsed.action, ctx, response);
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'HEALTH_ANALYSIS_ERROR',
          message: `Failed to analyze group health: ${err.message}`,
        });
      }
    }

    if (parsed.action === 'leaderCount') {
      const { campusId, groupTypeId, ageGroupBreakdown } = parsed;
      try {
        // Resolve the connect-group type id (explicit override wins, else discover)
        let connectGroupTypeId: number | undefined = groupTypeId;
        let connectGroupTypeDiscovery: { name: string; confidence: number } | undefined;

        if (connectGroupTypeId === undefined) {
          if (!discoveryService) {
            return formatResponse(parsed.action, ctx, null, {
              code: 'NO_GROUP_TYPE',
              message: 'No Connect Group type could be resolved: discovery service unavailable and no groupTypeId provided.',
            });
          }
          const map = await discoveryService.getMap(ctx);
          if (!map.groupTypes.connectGroups || map.groupTypes.connectGroups.length === 0) {
            return formatResponse(parsed.action, ctx, null, {
              code: 'NO_GROUP_TYPE',
              message: 'No Connect Group type discovered. Provide groupTypeId explicitly or configure connect groups in Rock RMS.',
            });
          }
          connectGroupTypeId = map.groupTypes.connectGroups[0].id;
          connectGroupTypeDiscovery = {
            name: map.groupTypes.connectGroups[0].name,
            confidence: map.groupTypes.connectGroups[0].confidence,
          };
        } else {
          connectGroupTypeDiscovery = { name: `groupTypeId ${connectGroupTypeId}`, confidence: 1.0 };
        }

        // Resolve campus name for display (campusId is already numeric; no name resolution needed for query)
        let campusName = 'All';
        let groupAgeGroupAttrAvailable = false;
        if ((campusId !== undefined || ageGroupBreakdown) && discoveryService) {
          try {
            const map = await discoveryService.getMap(ctx);
            if (campusId !== undefined) {
              const matchedCampus = (map.campuses || []).find((c: any) => c.id === campusId);
              if (matchedCampus) campusName = matchedCampus.name;
            }
            groupAgeGroupAttrAvailable = !!(map.attributes?.groupAgeGroup && map.attributes.groupAgeGroup.length > 0);
          } catch {
            // Non-fatal: fall back to defaults
          }
        }

        // Fetch candidate groups (v2 first, v1 fallback). Over-fetch by 1 to detect truncation.
        let allGroups: any[] = [];
        const whereClause =
          campusId !== undefined
            ? `GroupTypeId == ${connectGroupTypeId} && IsActive == true && CampusId == ${campusId}`
            : `GroupTypeId == ${connectGroupTypeId} && IsActive == true`;

        try {
          allGroups = await rockClient.post(ctx, '/api/v2/models/groups/search', {
            Where: whereClause,
            Limit: MAX_GROUPS_ANALYZED + 1,
          });
        } catch (_err) {
          const v1Filter =
            campusId !== undefined
              ? `GroupTypeId eq ${connectGroupTypeId} and IsActive eq true and CampusId eq ${campusId}`
              : `GroupTypeId eq ${connectGroupTypeId} and IsActive eq true`;
          allGroups = await rockClient.get(ctx, `/api/Groups?$filter=${encodeURIComponent(v1Filter)}&$top=${MAX_GROUPS_ANALYZED + 1}`);
        }

        const truncated = allGroups.length > MAX_GROUPS_ANALYZED;
        const groupsToAnalyze = allGroups.slice(0, MAX_GROUPS_ANALYZED);

        // Known age-group buckets for best-effort name matching
        const AGE_BUCKETS = ['Seasoned', 'Adults', 'Young Adults', 'Youth', 'Kids'];
        const matchBucket = (name: string): string | null => {
          const lower = (name || '').toLowerCase();
          // Check more specific buckets first (Young Adults before Adults)
          if (lower.includes('young adult')) return 'Young Adults';
          if (lower.includes('seasoned')) return 'Seasoned';
          if (lower.includes('youth') || lower.includes('teen')) return 'Youth';
          if (lower.includes('kid') || lower.includes('child')) return 'Kids';
          if (lower.includes('adult')) return 'Adults';
          return null;
        };

        const distinctLeaders = new Set<number>();
        // Track distinct leaders per bucket (each person counted once per bucket)
        const bucketLeaderSets: Record<string, Set<number>> = {};
        let breakdownResolvable = false;

        for (const group of groupsToAnalyze) {
          try {
            let members: any[] = [];
            try {
              members = await rockClient.post(ctx, '/api/v2/models/groupmembers/search', {
                Where: `GroupId == ${group.Id}`,
              });
            } catch (_err) {
              members = await rockClient.get(ctx, `/api/GroupMembers?$filter=GroupId eq ${group.Id}&$expand=Person,GroupRole`);
            }

            const bucket = ageGroupBreakdown ? matchBucket(group.Name) : null;
            if (bucket) breakdownResolvable = true;

            for (const m of members) {
              const role = m.GroupRole || {};
              if (role.IsLeader !== true) continue;
              const personId: number | null = m.PersonId ?? (m.Person ? m.Person.Id : null);
              if (personId === null || personId === undefined) continue;
              distinctLeaders.add(personId);

              if (ageGroupBreakdown && bucket) {
                if (!bucketLeaderSets[bucket]) bucketLeaderSets[bucket] = new Set<number>();
                bucketLeaderSets[bucket].add(personId);
              }
            }
          } catch (err: any) {
            // Log but continue to next group
            console.warn(`Error analyzing group ${group.Id} for leaderCount: ${err.message}`);
          }
        }

        const response: any = {
          campus: campusName,
          totalLeaders: distinctLeaders.size,
          groupsAnalyzed: groupsToAnalyze.length,
          truncated,
          discovery: {
            connectGroupType: connectGroupTypeDiscovery,
          },
        };

        if (ageGroupBreakdown) {
          if (breakdownResolvable) {
            const breakdown: Record<string, number> = {};
            for (const bucket of AGE_BUCKETS) {
              if (bucketLeaderSets[bucket]) breakdown[bucket] = bucketLeaderSets[bucket].size;
            }
            response.breakdown = breakdown;
            if (!groupAgeGroupAttrAvailable) {
              response.warning =
                'Age-group breakdown is best-effort, derived from group name matching (group age-group attribute not available).';
            }
          } else {
            response.warning =
              'Age-group breakdown unavailable: could not reliably determine age groups for the analyzed groups.';
          }
        }

        return formatResponse(parsed.action, ctx, response);
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'LEADER_COUNT_ERROR',
          message: `Failed to count leaders: ${err.message}`,
        });
      }
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
              // First, try to get the default role from GroupType
              if (group.GroupType && group.GroupType.DefaultGroupRoleId) {
                targetRoleId = group.GroupType.DefaultGroupRoleId;
              } else {
                // Fallback: fetch roles and pick appropriately
                const roles = await rockClient.get<any[]>(ctx, `/api/GroupTypeRoles?$filter=GroupTypeId eq ${group.GroupTypeId}`);
                const memberRole = roles.find((r: any) => r.Name.toLowerCase() === 'member');
                const nonLeaderRole = roles.find((r: any) => !r.IsLeader);
                targetRoleId = memberRole?.Id || nonLeaderRole?.Id || roles[0]?.Id;
              }
            }
          } catch {
            // Role resolution failed; will be caught below
          }
        }

        // Enforce that a role must be resolved (no magic number fallbacks)
        if (!targetRoleId && !isUpdating) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'ROLE_UNRESOLVED',
            message: 'Could not resolve a group role; pass roleId explicitly.',
          });
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

        let campusId: number | null = null;
        try {
          const group = await rockClient.get<any>(ctx, `/api/Groups/${groupId}`);
          if (group && group.CampusId) campusId = group.CampusId;
        } catch {
          // Ignore; campusId may remain null
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

        const payload: any = {
          OccurrenceId: occurrenceId,
          PersonAliasId: aliasId,
          DidAttend: didAttend,
          StartDateTime: formattedDate,
        };
        if (campusId) payload.CampusId = campusId;

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
