import { z } from 'zod';
import { GatewayTool, McpToolResult } from './types.js';
import { McpMode, McpScope } from '../mcp/modes.js';
import { OAuthRockContext } from '../http/oauth.js';
import { formatResponse } from './formatter.js';
import { RockClient } from '../rock/client.js';
import { escapeODataString } from '../rock/query.js';

/**
 * Allowlisted models for raw search/count-by-where operations.
 * searchByKey, get, and attributeValues are not subject to this allowlist.
 */
const READ_MODEL_ALLOWLIST = new Set([
  'people',
  'groups',
  'grouptypes',
  'groupmembers',
  'attendances',
  'attendanceoccurrences',
  'campuses',
  'reports',
  'connectionrequests',
  'connectiontypes',
  'workflows',
  'workflowtypes',
  'definedtypes',
  'definedvalues',
  'attributes',
  'schedules',
  'locations',
  'notes',
  'persons',
]);

const rockEntitySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('get'),
    model: z.string().min(1),
    id: z.union([z.string(), z.number()]),
    includeAttributes: z.boolean().default(false),
    shape: z.enum(['summary', 'full']).default('summary')
  }),
  z.object({
    action: z.literal('search'),
    model: z.string().min(1),
    where: z.string().min(1).optional(),
    select: z.string().min(1).optional(),
    sort: z.string().min(1).optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().max(500).default(50),
    shape: z.enum(['count', 'summary', 'table', 'full']).default('summary')
  }),
  z.object({
    action: z.literal('searchByKey'),
    model: z.string().min(1).optional(),
    searchKey: z.string().min(1),
    refinements: z.record(z.unknown()).default({}),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().max(1000).default(100),
    shape: z.enum(['count', 'summary', 'table', 'full']).default('table')
  }),
  z.object({
    action: z.literal('count'),
    model: z.string().min(1),
    where: z.string().min(1).optional(),
    searchKey: z.string().min(1).optional()
  }),
  z.object({
    action: z.literal('attributeValues'),
    model: z.string().min(1),
    id: z.union([z.string(), z.number()])
  })
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

function linqToOData(where?: string): string {
  if (!where) return '';
  let odata = where;
  odata = odata.replace(/\s*==\s*/g, ' eq ');
  odata = odata.replace(/\s*!=\s*/g, ' ne ');
  // Convert double-quoted strings to OData single-quoted strings with escaped quotes
  odata = odata.replace(/"([^"]*)"/g, (_match, content) => `'${escapeODataString(content)}'`);
  odata = odata.replace(/\s*&&\s*/g, ' and ');
  odata = odata.replace(/\s*\|\|\s*/g, ' or ');
  return odata;
}

export const rockEntityTool: GatewayTool = {
  name: 'rock_entity',
  title: 'Rock Entity Client',
  schemaForMode(_mode: McpMode, _scopes: Set<McpScope>): z.ZodTypeAny | null {
    return rockEntitySchema;
  },
  descriptionForMode(_mode: McpMode): string {
    return 'Generic read-only operations on Rock entities.';
  },
  async handle(args: any, _extra: any, ctx: OAuthRockContext): Promise<McpToolResult> {
    const parsed = rockEntitySchema.parse(args);

    const rockClient = (ctx as any).rockClient as RockClient;
    if (!rockClient) {
      return formatResponse(parsed.action, ctx, null, {
        code: 'MISSING_CLIENT',
        message: 'Rock client is not initialized in request context.',
      });
    }

    if (parsed.action === 'get') {
      const { model, id } = parsed;
      try {
        const result = await rockClient.get(ctx, `/api/v2/models/${model}/${id}`);
        return formatResponse(parsed.action, ctx, result);
      } catch (_err) {
        // Fall back to REST v1
        try {
          const v1Path = getRestV1Path(model);
          const result = await rockClient.get(ctx, `/api/${v1Path}/${id}`);
          return formatResponse(parsed.action, ctx, result, undefined, 'Fell back to REST v1');
        } catch (v1Err: any) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'GET_ERROR',
            message: `GET failed on v2 and v1: ${v1Err.message}`,
          });
        }
      }
    }

    if (parsed.action === 'search') {
      const { model, where, offset, limit } = parsed;

      // Enforce model allowlist for raw search
      const normalizedModel = model.toLowerCase();
      if (!READ_MODEL_ALLOWLIST.has(normalizedModel)) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'MODEL_NOT_ALLOWED',
          message: `Raw search is not allowed on model ${model}. Use searchByKey (saved Entity Search) instead.`,
        });
      }

      try {
        const result = await rockClient.post(ctx, `/api/v2/models/${model}/search`, {
          Where: where,
          Offset: offset,
          Limit: limit,
        });
        return formatResponse(parsed.action, ctx, result);
      } catch (_err) {
        // Fall back to REST v1
        try {
          const v1Path = getRestV1Path(model);
          let url = `/api/${v1Path}`;
          const params: string[] = [];
          if (where) {
            params.push(`$filter=${encodeURIComponent(linqToOData(where))}`);
          }
          if (limit) {
            params.push(`$top=${limit}`);
          }
          if (offset) {
            params.push(`$skip=${offset}`);
          }
          if (params.length > 0) {
            url += `?${params.join('&')}`;
          }
          const result = await rockClient.get(ctx, url);
          return formatResponse(parsed.action, ctx, result, undefined, 'Fell back to REST v1');
        } catch (v1Err: any) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'SEARCH_ERROR',
            message: `Search failed on v2 and v1: ${v1Err.message}`,
          });
        }
      }
    }

    if (parsed.action === 'searchByKey') {
      const { model, searchKey, refinements, offset, limit, shape } = parsed;

      try {
        let endpoint: string;
        if (model) {
          // Model-specific search endpoint
          endpoint = `/api/v2/models/${model}/search/${searchKey}`;
        } else {
          // Generic EntitySearch endpoint (v2 saved-search-by-key)
          // Note: May need verification against the live Rock 17.7 instance
          endpoint = `/api/v2/EntitySearch/${searchKey}`;
        }

        const queryBag = {
          ...refinements,
          Offset: offset,
          Limit: limit,
        };

        const result = await rockClient.post(ctx, endpoint, queryBag);

        // Handle shape: 'count' returns only the count/length
        if (shape === 'count') {
          const count = Array.isArray(result) ? result.length : 1;
          return formatResponse(parsed.action, ctx, count);
        }

        return formatResponse(parsed.action, ctx, result);
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'SEARCH_BY_KEY_ERROR',
          message: `Saved Entity Search failed: ${err.message}`,
        });
      }
    }

    if (parsed.action === 'count') {
      const { model, where, searchKey } = parsed;

      // If searchKey is provided, use the saved search path
      if (searchKey) {
        try {
          // Use the EntitySearch endpoint with large limit to fetch all results
          const result = await rockClient.post(ctx, `/api/v2/EntitySearch/${searchKey}`, {
            Offset: 0,
            Limit: 1000,
          });
          const count = Array.isArray(result) ? result.length : 1;
          return formatResponse(parsed.action, ctx, { count });
        } catch (err: any) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'COUNT_ERROR',
            message: `Count with searchKey failed: ${err.message}`,
          });
        }
      }

      // Otherwise, use where-based count (raw LINQ)
      // Enforce model allowlist for raw count-by-where
      const normalizedModel = model.toLowerCase();
      if (!READ_MODEL_ALLOWLIST.has(normalizedModel)) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'MODEL_NOT_ALLOWED',
          message: `Raw count is not allowed on model ${model}. Use searchByKey (saved Entity Search) instead.`,
        });
      }

      try {
        const result = await rockClient.post(ctx, `/api/v2/models/${model}/search`, {
          Where: where,
          IsCountOnly: true,
        });
        return formatResponse(parsed.action, ctx, { count: result });
      } catch (_err) {
        // Fall back to REST v1
        try {
          const v1Path = getRestV1Path(model);
          let url = `/api/${v1Path}`;
          if (where) {
            url += `?$filter=${encodeURIComponent(linqToOData(where))}`;
          }
          const result = await rockClient.get<any[]>(ctx, url);
          return formatResponse(parsed.action, ctx, { count: result.length }, undefined, 'Fell back to REST v1 count');
        } catch (v1Err: any) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'COUNT_ERROR',
            message: `Count failed on v2 and v1: ${v1Err.message}`,
          });
        }
      }
    }

    if (parsed.action === 'attributeValues') {
      const { model, id } = parsed;
      try {
        const result = await rockClient.get(ctx, `/api/v2/models/${model}/${id}/attributevalues`);
        return formatResponse(parsed.action, ctx, result);
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'ATTRIBUTE_VALUES_ERROR',
          message: `Failed to fetch attribute values: ${err.message}`,
        });
      }
    }

    // Exhaustiveness check: if we get here, a new action type wasn't handled
    const _: never = parsed;
    return _ as never;
  },
};
