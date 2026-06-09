import { z } from 'zod';
import { GatewayTool, McpToolResult } from './types.js';
import { McpMode, McpScope } from '../mcp/modes.js';
import { OAuthRockContext } from '../http/oauth.js';
import { formatResponse } from './formatter.js';
import { RockClient } from '../rock/client.js';
import { AuditLogger } from '../auth/audit.js';
import { authorizeWrite } from '../auth/authorization.js';

const rockWriteSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    model: z.string().min(1),
    data: z.record(z.unknown()),
    dryRun: z.boolean().default(true),
    commit: z.boolean().default(false),
    reason: z.string().optional(),
  }),
  z.object({
    action: z.literal('patch'),
    model: z.string().min(1),
    id: z.union([z.string(), z.coerce.number()]),
    data: z.record(z.unknown()),
    dryRun: z.boolean().default(true),
    commit: z.boolean().default(false),
    reason: z.string().optional(),
  }),
  z.object({
    action: z.literal('patchAttributes'),
    model: z.string().min(1),
    id: z.union([z.string(), z.coerce.number()]),
    attributes: z.record(z.unknown()),
    dryRun: z.boolean().default(true),
    commit: z.boolean().default(false),
    reason: z.string().optional(),
  }),
  z.object({
    action: z.literal('delete'),
    model: z.string().min(1),
    id: z.union([z.string(), z.coerce.number()]),
    dryRun: z.boolean().default(true),
    commit: z.boolean().default(false),
    reason: z.string().optional(),
  }),
  z.object({
    action: z.literal('bulkPatch'),
    model: z.string().min(1),
    items: z.array(z.object({ id: z.union([z.string(), z.coerce.number()]), data: z.record(z.unknown()) })).min(1),
    dryRun: z.boolean().default(true),
    commit: z.boolean().default(false),
    reason: z.string().optional(),
  }),
]);

function getRestV1Path(model: string): string {
  const lower = model.toLowerCase();
  if (lower === 'people' || lower === 'person') return 'People';
  if (lower === 'grouptypes' || lower === 'grouptype') return 'GroupTypes';
  if (lower === 'groups' || lower === 'group') return 'Groups';
  if (lower === 'campuses' || lower === 'campus') return 'Campuses';
  if (lower === 'userlogins' || lower === 'userlogin') return 'UserLogins';
  if (lower === 'groupmembers' || lower === 'groupmember') return 'GroupMembers';
  return model.charAt(0).toUpperCase() + model.slice(1);
}

const auditLogger = new AuditLogger();

export const rockWriteTool: GatewayTool = {
  name: 'rock_write',
  title: 'Rock Mutation Client',
  schemaForMode(mode: McpMode, scopes: Set<McpScope>): z.ZodTypeAny | null {
    if (mode !== 'readwrite' || !scopes.has('write')) {
      return null; // Register only in readwrite mode
    }
    return rockWriteSchema;
  },
  descriptionForMode(_mode: McpMode): string {
    return 'Generic write and update operations on Rock entities.';
  },
  async handle(args: any, _extra: any, ctx: OAuthRockContext): Promise<McpToolResult> {
    // Check mode double-security
    if (ctx.mode !== 'readwrite') {
      return formatResponse('write', ctx, null, {
        code: 'UNAUTHORIZED_MODE',
        message: 'Write operations are disallowed in readonly mode.',
      });
    }

    const parsed = rockWriteSchema.parse(args);
    const { action, model, dryRun, commit, reason } = parsed;

    if (!reason || reason.trim().length === 0) {
      return formatResponse(action, ctx, null, {
        code: 'VALIDATION_ERROR',
        message: 'A human-readable reason is required for all write operations.',
      });
    }

    const rockClient = (ctx as any).rockClient as RockClient;
    if (!rockClient) {
      return formatResponse(action, ctx, null, {
        code: 'MISSING_CLIENT',
        message: 'Rock client is not initialized in request context.',
      });
    }

    const shouldMutate = commit && !dryRun;

    // Build authorization descriptor based on action
    let descriptor: any = {
      tool: 'rock_write',
      action,
      model,
      operation: action as 'create' | 'patch' | 'patchAttributes' | 'delete' | 'bulkPatch',
    };

    // Add action-specific fields
    if (action === 'create' || action === 'patch') {
      descriptor.fields = Object.keys((parsed as any).data || {});
    } else if (action === 'patchAttributes') {
      // patchAttributes: no fields in descriptor (authz layer exempts it from field allowlist)
    } else if (action === 'bulkPatch') {
      // bulkPatch: collect all fields and item count
      const items = (parsed as any).items || [];
      descriptor.count = items.length;
      descriptor.fields = Array.from(new Set(items.flatMap((item: any) => Object.keys(item.data || {}))));
    }

    // Perform authorization check BEFORE mutation, even for dry-runs
    const authz = authorizeWrite(ctx, descriptor);
    if (!authz.allowed) {
      const logTarget: any = { model };
      if (action !== 'create' && action !== 'bulkPatch') {
        logTarget.id = (parsed as any).id;
      }
      auditLogger.log(ctx, {
        tool: 'rock_write',
        action,
        target: logTarget,
        dryRun,
        commit,
        reason,
        outcome: 'denied',
        errorCode: authz.code,
      });
      return formatResponse(action, ctx, null, {
        code: authz.code || 'AUTHORIZATION_DENIED',
        message: authz.reason || 'Authorization denied.',
      });
    }

    if (!shouldMutate) {
      // Log audit dry-run
      const logTarget: any = { model };
      if (action !== 'create' && action !== 'bulkPatch') {
        logTarget.id = (parsed as any).id;
      }
      auditLogger.log(ctx, {
        tool: 'rock_write',
        action,
        target: logTarget,
        dryRun: true,
        commit: false,
        reason,
        outcome: 'allowed',
      });

      // Handle dry-run responses
      if (action === 'bulkPatch') {
        const items = (parsed as any).items || [];
        const allFields = Array.from(new Set(items.flatMap((item: any) => Object.keys(item.data || {}))));
        return formatResponse(action, ctx, {
          dryRun: true,
          committed: false,
          message: 'Dry run output. No mutations were applied.',
          total: items.length,
          model,
          sampleFields: allFields,
        });
      }

      const responseTarget: any = { model };
      if (action !== 'create') {
        responseTarget.id = (parsed as any).id;
      }
      return formatResponse(action, ctx, {
        dryRun: true,
        committed: false,
        message: 'Dry run output. No mutations were applied.',
        target: responseTarget,
        data: (action === 'create' || action === 'patch') ? (parsed as any).data : undefined,
        attributes: action === 'patchAttributes' ? (parsed as any).attributes : undefined,
      });
    }

    if (action === 'create') {
      const { data } = parsed as any;
      try {
        const result = await rockClient.post(ctx, `/api/v2/models/${model}`, data);

        auditLogger.log(ctx, {
          tool: 'rock_write',
          action,
          target: { model },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'success',
        });

        return formatResponse(action, ctx, { committed: true, result });
      } catch (_err) {
        // Fall back to REST v1 POST
        try {
          const v1Path = getRestV1Path(model);
          const result = await rockClient.post(ctx, `/api/${v1Path}`, data);

          auditLogger.log(ctx, {
            tool: 'rock_write',
            action,
            target: { model },
            dryRun: false,
            commit: true,
            reason: `${reason} (via REST v1 fallback)`,
            outcome: 'success',
          });

          return formatResponse(action, ctx, { committed: true, result }, undefined, 'Fell back to REST v1');
        } catch (v1Err: any) {
          auditLogger.log(ctx, {
            tool: 'rock_write',
            action,
            target: { model },
            dryRun: false,
            commit: true,
            reason,
            outcome: 'error',
            errorCode: 'CREATE_ERROR',
          });

          return formatResponse(action, ctx, null, {
            code: 'CREATE_ERROR',
            message: `CREATE failed on v2 and v1: ${v1Err.message}`,
          });
        }
      }
    }

    if (action === 'patch') {
      const { data, id } = parsed as any;
      try {
        const result = await rockClient.patch(ctx, `/api/v2/models/${model}/${id}`, data);

        auditLogger.log(ctx, {
          tool: 'rock_write',
          action,
          target: { model, id },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'success',
        });

        return formatResponse(action, ctx, { committed: true, result });
      } catch (_err) {
        // Fall back to REST v1 PATCH
        try {
          const v1Path = getRestV1Path(model);
          const result = await rockClient.patch(ctx, `/api/${v1Path}/${id}`, data);

          auditLogger.log(ctx, {
            tool: 'rock_write',
            action,
            target: { model, id },
            dryRun: false,
            commit: true,
            reason: `${reason} (via REST v1 fallback)`,
            outcome: 'success',
          });

          return formatResponse(action, ctx, { committed: true, result }, undefined, 'Fell back to REST v1');
        } catch (v1Err: any) {
          auditLogger.log(ctx, {
            tool: 'rock_write',
            action,
            target: { model, id },
            dryRun: false,
            commit: true,
            reason,
            outcome: 'error',
            errorCode: 'PATCH_ERROR',
          });

          return formatResponse(action, ctx, null, {
            code: 'PATCH_ERROR',
            message: `PATCH failed on v2 and v1: ${v1Err.message}`,
          });
        }
      }
    }

    if (action === 'patchAttributes') {
      const { id, attributes } = parsed as any;
      try {
        const result = await rockClient.patch(ctx, `/api/v2/models/${model}/${id}/attributevalues`, attributes);

        auditLogger.log(ctx, {
          tool: 'rock_write',
          action,
          target: { model, id },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'success',
        });

        return formatResponse(action, ctx, { committed: true, result });
      } catch (err: any) {
        auditLogger.log(ctx, {
          tool: 'rock_write',
          action,
          target: { model, id },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'error',
          errorCode: 'PATCH_ATTRIBUTES_ERROR',
        });

        return formatResponse(action, ctx, null, {
          code: 'PATCH_ATTRIBUTES_ERROR',
          message: `PATCH attributes failed: ${err.message}`,
        });
      }
    }

    if (action === 'delete') {
      const { id } = parsed as any;
      try {
        const result = await rockClient.delete(ctx, `/api/v2/models/${model}/${id}`);

        auditLogger.log(ctx, {
          tool: 'rock_write',
          action,
          target: { model, id },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'success',
        });

        return formatResponse(action, ctx, { committed: true, result });
      } catch (_err) {
        // Fall back to REST v1 DELETE
        try {
          const v1Path = getRestV1Path(model);
          const result = await rockClient.delete(ctx, `/api/${v1Path}/${id}`);

          auditLogger.log(ctx, {
            tool: 'rock_write',
            action,
            target: { model, id },
            dryRun: false,
            commit: true,
            reason: `${reason} (via REST v1 fallback)`,
            outcome: 'success',
          });

          return formatResponse(action, ctx, { committed: true, result }, undefined, 'Fell back to REST v1');
        } catch (v1Err: any) {
          auditLogger.log(ctx, {
            tool: 'rock_write',
            action,
            target: { model, id },
            dryRun: false,
            commit: true,
            reason,
            outcome: 'error',
            errorCode: 'DELETE_ERROR',
          });

          return formatResponse(action, ctx, null, {
            code: 'DELETE_ERROR',
            message: `DELETE failed on v2 and v1: ${v1Err.message}`,
          });
        }
      }
    }

    if (action === 'bulkPatch') {
      const { items } = parsed as any;
      const results: Array<{ id: string | number; ok: boolean; error?: string }> = [];
      let succeeded = 0;
      let failed = 0;

      for (const item of items) {
        try {
          await rockClient.patch(ctx, `/api/v2/models/${model}/${item.id}`, item.data);
          results.push({ id: item.id, ok: true });
          succeeded++;
        } catch (err: any) {
          results.push({ id: item.id, ok: false, error: err.message });
          failed++;
        }
      }

      auditLogger.log(ctx, {
        tool: 'rock_write',
        action,
        target: { model },
        dryRun: false,
        commit: true,
        reason,
        outcome: failed > 0 ? 'error' : 'success',
        errorCode: failed > 0 ? 'BULK_PATCH_PARTIAL_ERROR' : undefined,
      });

      return formatResponse(action, ctx, {
        committed: true,
        total: items.length,
        succeeded,
        failed,
        results,
      });
    }

    return formatResponse(action, ctx, null, {
      code: 'NOT_IMPLEMENTED',
      message: `Action ${action} is not yet implemented.`,
    });
  },
};
