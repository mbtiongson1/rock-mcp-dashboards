import { z } from 'zod';
import { GatewayTool, McpToolResult } from './types.js';
import { McpMode, McpScope } from '../mcp/modes.js';
import { OAuthRockContext } from '../http/oauth.js';
import { formatResponse } from './formatter.js';
import { RockClient } from '../rock/client.js';
import { AuditLogger } from '../auth/audit.js';
import { authorizeWrite } from '../auth/authorization.js';

const rockWorkflowSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('connectionRequests'),
    limit: z.number().int().positive().max(100).default(50),
  }),
  z.object({
    action: z.literal('workflowTypes'),
    limit: z.number().int().positive().max(100).default(50),
  }),
  z.object({
    action: z.literal('workflowStatus'),
    workflowId: z.number(),
  }),
  z.object({
    action: z.literal('steps'),
    workflowId: z.number(),
  }),
  z.object({
    action: z.literal('launchWorkflow'),
    workflowTypeId: z.number(),
    name: z.string().optional(),
    dryRun: z.boolean().default(true),
    commit: z.boolean().default(false),
    reason: z.string().min(1),
  }),
  z.object({
    action: z.literal('updateWorkflow'),
    workflowId: z.number(),
    status: z.string().optional(),
    isCompleted: z.boolean().optional(),
    dryRun: z.boolean().default(true),
    commit: z.boolean().default(false),
    reason: z.string().min(1),
  }),
  z.object({
    action: z.literal('completeAction'),
    activityId: z.number(),
    dryRun: z.boolean().default(true),
    commit: z.boolean().default(false),
    reason: z.string().min(1),
  }),
  z.object({
    action: z.literal('updateConnectionRequest'),
    connectionRequestId: z.number(),
    statusId: z.number().optional(),
    assignedPersonAliasId: z.number().optional(),
    comments: z.string().optional(),
    dryRun: z.boolean().default(true),
    commit: z.boolean().default(false),
    reason: z.string().min(1),
  }),
]);

const auditLogger = new AuditLogger();

export const rockWorkflowTool: GatewayTool = {
  name: 'rock_workflow',
  title: 'Rock Connection & Workflow Manager',
  schemaForMode(mode: McpMode, scopes: Set<McpScope>): z.ZodTypeAny | null {
    if (mode !== 'readwrite' || !scopes.has('write')) {
      return z.discriminatedUnion('action', [
        z.object({
          action: z.literal('connectionRequests'),
          limit: z.number().int().positive().max(100).default(50),
        }),
        z.object({
          action: z.literal('workflowTypes'),
          limit: z.number().int().positive().max(100).default(50),
        }),
        z.object({
          action: z.literal('workflowStatus'),
          workflowId: z.number(),
        }),
        z.object({
          action: z.literal('steps'),
          workflowId: z.number(),
        }),
      ]);
    }
    return rockWorkflowSchema;
  },
  descriptionForMode(_mode: McpMode): string {
    return 'Handles Connection Requests, workflow steps, and tasks in Rock RMS.';
  },
  async handle(args: any, _extra: any, ctx: OAuthRockContext): Promise<McpToolResult> {
    const parsed = rockWorkflowSchema.parse(args);

    const rockClient = (ctx as any).rockClient as RockClient;
    if (!rockClient) {
      return formatResponse(parsed.action, ctx, null, {
        code: 'MISSING_CLIENT',
        message: 'Rock client is not initialized in request context.',
      });
    }

    if (parsed.action === 'connectionRequests') {
      const { limit } = parsed;
      try {
        let list: any[] = [];
        try {
          list = await rockClient.post(ctx, '/api/v2/models/connectionrequests/search', {
            Limit: limit,
          });
        } catch (_err) {
          list = await rockClient.get(ctx, `/api/ConnectionRequests?$top=${limit}&$expand=PersonAlias/Person`);
        }

        const safeList = list.map((cr: any) => ({
          id: cr.Id,
          personId: cr.PersonAlias?.Person?.Id || cr.PersonAliasId,
          personName: cr.PersonAlias?.Person ? `${cr.PersonAlias.Person.NickName || cr.PersonAlias.Person.FirstName} ${cr.PersonAlias.Person.LastName}` : 'Unknown',
          comments: cr.Comments,
          status: cr.ConnectionStatus?.Name || 'Pending',
        }));

        return formatResponse(parsed.action, ctx, safeList);
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'CONNECTION_REQUESTS_ERROR',
          message: `Failed to fetch connection requests: ${err.message}`,
        });
      }
    }

    if (parsed.action === 'workflowTypes') {
      const { limit } = parsed;
      try {
        let list: any[] = [];
        try {
          list = await rockClient.post(ctx, '/api/v2/models/workflowtypes/search', {
            Limit: limit,
          });
        } catch (_err) {
          list = await rockClient.get(ctx, `/api/WorkflowTypes?$top=${limit}`);
        }

        const safeList = list.map((wt: any) => ({
          id: wt.Id,
          name: wt.Name,
          description: wt.Description,
        }));

        return formatResponse(parsed.action, ctx, safeList);
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'WORKFLOW_TYPES_ERROR',
          message: `Failed to fetch workflow types: ${err.message}`,
        });
      }
    }

    if (parsed.action === 'workflowStatus') {
      const { workflowId } = parsed;
      try {
        let wf: any = null;
        try {
          wf = await rockClient.get(ctx, `/api/v2/models/workflows/${workflowId}`);
        } catch (_err) {
          wf = await rockClient.get(ctx, `/api/Workflows/${workflowId}`);
        }

        return formatResponse(parsed.action, ctx, {
          id: wf.Id,
          name: wf.Name,
          status: wf.Status,
          isCompleted: wf.CompletedDateTime !== null,
        });
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'WORKFLOW_STATUS_ERROR',
          message: `Failed to fetch workflow status: ${err.message}`,
        });
      }
    }

    if (parsed.action === 'steps') {
      const { workflowId } = parsed;
      try {
        let steps: any[] = [];
        try {
          steps = await rockClient.post(ctx, '/api/v2/models/workflowactivities/search', {
            Where: `WorkflowId == ${workflowId}`,
          });
        } catch (_err) {
          steps = await rockClient.get(ctx, `/api/WorkflowActivities?$filter=WorkflowId eq ${workflowId}`);
        }

        const safeSteps = steps.map((s: any) => ({
          id: s.Id,
          activityType: s.ActivityType?.Name || 'Activity',
          isCompleted: s.CompletedDateTime !== null,
        }));

        return formatResponse(parsed.action, ctx, safeSteps);
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'STEPS_ERROR',
          message: `Failed to fetch steps: ${err.message}`,
        });
      }
    }

    if (parsed.action === 'launchWorkflow') {
      const { workflowTypeId, name, dryRun, commit, reason } = parsed;
      if (ctx.mode !== 'readwrite' || !ctx.scopes.has('write')) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'UNAUTHORIZED',
          message: 'Write actions disallowed in readonly mode.',
        });
      }
      try {
        const payload: any = {
          WorkflowTypeId: workflowTypeId,
          Name: name || `Workflow Type ${workflowTypeId}`,
          IsActive: true,
          ActivatedDateTime: new Date().toISOString(),
        };

        // Perform authorization check BEFORE mutation, even for dry-runs
        const descriptor = {
          tool: 'rock_workflow',
          action: parsed.action,
          model: 'workflows',
          operation: 'create' as const,
          fields: Object.keys(payload),
        };
        const authz = authorizeWrite(ctx, descriptor);
        if (!authz.allowed) {
          auditLogger.log(ctx, {
            tool: 'rock_workflow',
            action: parsed.action,
            target: { model: 'workflows' },
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
            tool: 'rock_workflow',
            action: parsed.action,
            target: { model: 'workflows' },
            dryRun: true,
            commit: false,
            reason,
            outcome: 'allowed',
          });
          return formatResponse(parsed.action, ctx, {
            dryRun: true,
            committed: false,
            payload,
          });
        }

        let result: any;
        try {
          result = await rockClient.post(ctx, '/api/v2/models/workflows', payload);
        } catch {
          result = await rockClient.post(ctx, '/api/Workflows', payload);
        }

        auditLogger.log(ctx, {
          tool: 'rock_workflow',
          action: parsed.action,
          target: { model: 'workflows', id: result || undefined },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'success',
        });

        return formatResponse(parsed.action, ctx, { committed: true, result });
      } catch (err: any) {
        auditLogger.log(ctx, {
          tool: 'rock_workflow',
          action: parsed.action,
          target: { model: 'workflows' },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'error',
          errorCode: 'LAUNCH_WORKFLOW_ERROR',
        });
        return formatResponse(parsed.action, ctx, null, {
          code: 'LAUNCH_WORKFLOW_ERROR',
          message: err.message,
        });
      }
    }

    if (parsed.action === 'updateWorkflow') {
      const { workflowId, status, isCompleted, dryRun, commit, reason } = parsed;
      if (ctx.mode !== 'readwrite' || !ctx.scopes.has('write')) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'UNAUTHORIZED',
          message: 'Write actions disallowed in readonly mode.',
        });
      }
      try {
        const payload: any = {};
        if (status !== undefined) payload.Status = status;
        if (isCompleted !== undefined) {
          payload.CompletedDateTime = isCompleted ? new Date().toISOString() : null;
        }

        // Perform authorization check BEFORE mutation, even for dry-runs
        const descriptor = {
          tool: 'rock_workflow',
          action: parsed.action,
          model: 'workflows',
          operation: 'patch' as const,
          fields: Object.keys(payload),
        };
        const authz = authorizeWrite(ctx, descriptor);
        if (!authz.allowed) {
          auditLogger.log(ctx, {
            tool: 'rock_workflow',
            action: parsed.action,
            target: { model: 'workflows', id: workflowId },
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
            tool: 'rock_workflow',
            action: parsed.action,
            target: { model: 'workflows', id: workflowId },
            dryRun: true,
            commit: false,
            reason,
            outcome: 'allowed',
          });
          return formatResponse(parsed.action, ctx, {
            dryRun: true,
            committed: false,
            targetId: workflowId,
            payload,
          });
        }

        let result: any;
        try {
          result = await rockClient.patch(ctx, `/api/v2/models/workflows/${workflowId}`, payload);
        } catch {
          result = await rockClient.patch(ctx, `/api/Workflows/${workflowId}`, payload);
        }

        auditLogger.log(ctx, {
          tool: 'rock_workflow',
          action: parsed.action,
          target: { model: 'workflows', id: workflowId },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'success',
        });

        return formatResponse(parsed.action, ctx, { committed: true, result });
      } catch (err: any) {
        auditLogger.log(ctx, {
          tool: 'rock_workflow',
          action: parsed.action,
          target: { model: 'workflows', id: workflowId },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'error',
          errorCode: 'UPDATE_WORKFLOW_ERROR',
        });
        return formatResponse(parsed.action, ctx, null, {
          code: 'UPDATE_WORKFLOW_ERROR',
          message: err.message,
        });
      }
    }

    if (parsed.action === 'completeAction') {
      const { activityId, dryRun, commit, reason } = parsed;
      if (ctx.mode !== 'readwrite' || !ctx.scopes.has('write')) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'UNAUTHORIZED',
          message: 'Write actions disallowed in readonly mode.',
        });
      }
      try {
        const payload = {
          CompletedDateTime: new Date().toISOString(),
        };

        // Perform authorization check BEFORE mutation, even for dry-runs
        const descriptor = {
          tool: 'rock_workflow',
          action: parsed.action,
          model: 'workflowactivities',
          operation: 'patch' as const,
          fields: Object.keys(payload),
        };
        const authz = authorizeWrite(ctx, descriptor);
        if (!authz.allowed) {
          auditLogger.log(ctx, {
            tool: 'rock_workflow',
            action: parsed.action,
            target: { model: 'workflowactivities', id: activityId },
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
            tool: 'rock_workflow',
            action: parsed.action,
            target: { model: 'workflowactivities', id: activityId },
            dryRun: true,
            commit: false,
            reason,
            outcome: 'allowed',
          });
          return formatResponse(parsed.action, ctx, {
            dryRun: true,
            committed: false,
            targetId: activityId,
            payload,
          });
        }

        let result: any;
        try {
          result = await rockClient.patch(ctx, `/api/v2/models/workflowactivities/${activityId}`, payload);
        } catch {
          result = await rockClient.patch(ctx, `/api/WorkflowActivities/${activityId}`, payload);
        }

        auditLogger.log(ctx, {
          tool: 'rock_workflow',
          action: parsed.action,
          target: { model: 'workflowactivities', id: activityId },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'success',
        });

        return formatResponse(parsed.action, ctx, { committed: true, result });
      } catch (err: any) {
        auditLogger.log(ctx, {
          tool: 'rock_workflow',
          action: parsed.action,
          target: { model: 'workflowactivities', id: activityId },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'error',
          errorCode: 'COMPLETE_ACTION_ERROR',
        });
        return formatResponse(parsed.action, ctx, null, {
          code: 'COMPLETE_ACTION_ERROR',
          message: err.message,
        });
      }
    }

    if (parsed.action === 'updateConnectionRequest') {
      const { connectionRequestId, statusId, assignedPersonAliasId, comments, dryRun, commit, reason } = parsed;
      if (ctx.mode !== 'readwrite' || !ctx.scopes.has('write')) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'UNAUTHORIZED',
          message: 'Write actions disallowed in readonly mode.',
        });
      }
      try {
        const payload: any = {};
        if (statusId !== undefined) payload.ConnectionStatusId = statusId;
        if (assignedPersonAliasId !== undefined) payload.AssignedPersonAliasId = assignedPersonAliasId;
        if (comments !== undefined) payload.Comments = comments;

        // Perform authorization check BEFORE mutation, even for dry-runs
        const descriptor = {
          tool: 'rock_workflow',
          action: parsed.action,
          model: 'connectionrequests',
          operation: 'patch' as const,
          fields: Object.keys(payload),
        };
        const authz = authorizeWrite(ctx, descriptor);
        if (!authz.allowed) {
          auditLogger.log(ctx, {
            tool: 'rock_workflow',
            action: parsed.action,
            target: { model: 'connectionrequests', id: connectionRequestId },
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
            tool: 'rock_workflow',
            action: parsed.action,
            target: { model: 'connectionrequests', id: connectionRequestId },
            dryRun: true,
            commit: false,
            reason,
            outcome: 'allowed',
          });
          return formatResponse(parsed.action, ctx, {
            dryRun: true,
            committed: false,
            targetId: connectionRequestId,
            payload,
          });
        }

        let result: any;
        try {
          result = await rockClient.patch(ctx, `/api/v2/models/connectionrequests/${connectionRequestId}`, payload);
        } catch {
          result = await rockClient.patch(ctx, `/api/ConnectionRequests/${connectionRequestId}`, payload);
        }

        auditLogger.log(ctx, {
          tool: 'rock_workflow',
          action: parsed.action,
          target: { model: 'connectionrequests', id: connectionRequestId },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'success',
        });

        return formatResponse(parsed.action, ctx, { committed: true, result });
      } catch (err: any) {
        auditLogger.log(ctx, {
          tool: 'rock_workflow',
          action: parsed.action,
          target: { model: 'connectionrequests', id: connectionRequestId },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'error',
          errorCode: 'UPDATE_CONNECTION_ERROR',
        });
        return formatResponse(parsed.action, ctx, null, {
          code: 'UPDATE_CONNECTION_ERROR',
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
