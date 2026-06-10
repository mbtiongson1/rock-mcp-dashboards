import { z } from 'zod';
import * as crypto from 'crypto';
import { GatewayTool, McpToolResult } from './types.js';
import { McpMode, McpScope } from '../mcp/modes.js';
import { OAuthRockContext } from '../http/oauth.js';
import { formatResponse } from './formatter.js';
import { RockClient } from '../rock/client.js';
import { StoredDataset } from './dataset-store.js';
import { REPORT_VIEWER_URI } from '../mcp/apps.js';

/**
 * Map a Rock entity class name (e.g. 'Rock.Model.Person') to its REST v1
 * route segment (e.g. 'People').
 */
function entityNameToRoute(entityClassName: string): string {
  const name = entityClassName.split('.').pop() || entityClassName;
  if (name === 'Person') return 'People';
  if (name === 'Campus') return 'Campuses';
  if (name.endsWith('s')) return name;
  return `${name}s`;
}

/**
 * Execute a report's underlying DataView: GET /api/{EntityPlural}/DataView/{id}.
 * Throws if the report has no DataView or the entity type cannot be resolved.
 */
async function runReportViaDataView(
  rockClient: RockClient,
  ctx: OAuthRockContext,
  reportMeta: any,
  limit: number
): Promise<any[]> {
  const dataViewId = reportMeta?.DataViewId;
  const entityTypeId = reportMeta?.EntityTypeId;
  if (!dataViewId || !entityTypeId) {
    throw new Error('Report has no DataViewId/EntityTypeId.');
  }
  const entityType = await rockClient.get<any>(ctx, `/api/EntityTypes/${entityTypeId}`);
  const route = entityNameToRoute(entityType?.Name || '');
  const rows = await rockClient.get<any[]>(ctx, `/api/${route}/DataView/${dataViewId}?$top=${limit}`);
  return rows || [];
}

const rockReportSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('list'),
    query: z.string().optional(),
    limit: z.coerce.number().int().positive().max(100).default(50),
  }),
  z.object({
    action: z.literal('run'),
    reportId: z.coerce.number().describe("Report ID from the 'list' action."),
    limit: z.coerce.number().int().positive().max(500).default(50),
  }),
  z.object({
    action: z.literal('summary'),
    datasetId: z.string().describe("Dataset ID returned by the 'run' action (e.g. 'rpt_...')."),
    includeRows: z.boolean().default(false),
  }),
  z.object({
    action: z.literal('export'),
    datasetId: z.string().describe("Dataset ID returned by the 'run' action (e.g. 'rpt_...')."),
    format: z.enum(['csv', 'json']).default('csv'),
  }),
  z.object({
    action: z.literal('app'),
    datasetId: z.string().describe("Dataset ID returned by the 'run' action (e.g. 'rpt_...')."),
  }),
]);

export const rockReportTool: GatewayTool = {
  name: 'rock_report',
  title: 'Rock Report & Analytics Viewer',
  appResourceUri: REPORT_VIEWER_URI,
  schemaForMode(_mode: McpMode, _scopes: Set<McpScope>): z.ZodTypeAny | null {
    return rockReportSchema;
  },
  descriptionForMode(_mode: McpMode): string {
    return 'Executes and reviews complex Rock reports and analytics datasets visually.';
  },
  async handle(args: any, _extra: any, ctx: OAuthRockContext): Promise<McpToolResult> {
    const parsed = rockReportSchema.parse(args);

    const rockClient = (ctx as any).rockClient as RockClient;
    if (!rockClient) {
      return formatResponse(parsed.action, ctx, null, {
        code: 'MISSING_CLIENT',
        message: 'Rock client is not initialized in request context.',
      });
    }

    const datasetStore = (ctx as any).datasetStore;

    if (parsed.action === 'list') {
      try {
        const reports = await rockClient.get<any[]>(ctx, '/api/Reports');
        const query = parsed.query?.toLowerCase();
        const filtered = reports
          .filter((r: any) => !query || r.Name.toLowerCase().includes(query))
          .slice(0, parsed.limit)
          .map((r: any) => ({
            id: r.Id,
            guid: r.Guid,
            name: r.Name,
            description: r.Description,
            category: r.Category ? r.Category.Name : 'General',
          }));
        return formatResponse(parsed.action, ctx, filtered);
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'LIST_ERROR',
          message: `Failed to list reports: ${err.message}`,
        });
      }
    }

    if (parsed.action === 'run') {
      const { reportId, limit } = parsed;
      try {
        if (!datasetStore) {
          throw new Error('Dataset store is not initialized.');
        }

        // Fetch report metadata first to get name
        const reportMeta = await rockClient.get<any>(ctx, `/api/Reports/${reportId}`);

        // Run the report. /api/Reports/run/{id} does not exist on Rock 17.x
        // (404 "The OData path is invalid"), so prefer executing the report's
        // underlying DataView via /api/{EntityPlural}/DataView/{dataViewId},
        // keeping the legacy endpoint as a fallback for other versions.
        let rows: any[];
        try {
          rows = await runReportViaDataView(rockClient, ctx, reportMeta, limit);
        } catch {
          rows = await rockClient.get<any[]>(ctx, `/api/Reports/run/${reportId}?$top=${limit}`);
          rows = (rows || []).slice(0, limit);
        }

        // Expose columns dynamically
        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

        // Save report dataset
        const datasetId = `rpt_${crypto.randomBytes(12).toString('hex')}`;
        const oauthSubjectHash = crypto
          .createHash('sha256')
          .update(ctx.oauth.subject || '')
          .digest('hex');

        const ttlSeconds = parseInt(process.env.ROCK_MCP_DATASET_TTL_SECONDS || '900', 10);

        const dataset: StoredDataset = {
          id: datasetId,
          owner: {
            oauthSubjectHash,
            rockPersonId: ctx.rockUser.personId,
            sessionId: ctx.request.sessionId,
          },
          title: reportMeta.Name || `Report ${reportId}`,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
          source: {
            tool: 'rock_report',
            action: 'run',
            reportId,
          },
          columns,
          rows,
          sensitivity: 'person', // default
        };

        await datasetStore.put(dataset);

        const responseResult = {
          title: dataset.title,
          rowCount: rows.length,
          columns,
          previewRows: rows.slice(0, 10), // Return only first 10 preview rows to save tokens
          datasetId,
          app: {
            resourceUri: REPORT_VIEWER_URI,
          },
        };

        return formatResponse(parsed.action, ctx, responseResult);
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'RUN_ERROR',
          message: `Failed to run report: ${err.message}`,
        });
      }
    }

    if (parsed.action === 'summary') {
      const { datasetId, includeRows } = parsed;
      try {
        if (!datasetStore) {
          throw new Error('Dataset store is not initialized.');
        }

        const dataset = await datasetStore.get(datasetId, ctx);
        if (!dataset) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'NOT_FOUND',
            message: 'Dataset not found or expired.',
          });
        }

        const summaryResult = {
          id: dataset.id,
          title: dataset.title,
          rowCount: dataset.rows.length,
          columns: dataset.columns,
          createdAt: dataset.createdAt,
          expiresAt: dataset.expiresAt,
          rows: includeRows ? dataset.rows : undefined,
        };

        return formatResponse(parsed.action, ctx, summaryResult);
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'SUMMARY_ERROR',
          message: `Failed to fetch dataset summary: ${err.message}`,
        });
      }
    }

    if (parsed.action === 'export') {
      const { datasetId, format } = parsed;
      try {
        if (!datasetStore) {
          throw new Error('Dataset store is not initialized.');
        }

        const dataset = await datasetStore.get(datasetId, ctx);
        if (!dataset) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'NOT_FOUND',
            message: 'Dataset not found or expired.',
          });
        }

        if (format === 'json') {
          return formatResponse(parsed.action, ctx, dataset.rows);
        }

        // CSV export
        const csvRows: string[] = [];
        csvRows.push(dataset.columns.join(','));
        for (const row of dataset.rows) {
          const vals = dataset.columns.map((c: string) => {
            const val = row[c];
            if (val === undefined || val === null) return '';
            const valStr = String(val).replace(/"/g, '""');
            return valStr.includes(',') || valStr.includes('\n') || valStr.includes('"') ? `"${valStr}"` : valStr;
          });
          csvRows.push(vals.join(','));
        }

        return formatResponse(parsed.action, ctx, csvRows.join('\n'));
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'EXPORT_ERROR',
          message: `Failed to export dataset: ${err.message}`,
        });
      }
    }

    if (parsed.action === 'app') {
      const { datasetId } = parsed;
      return formatResponse(parsed.action, ctx, {
        appUri: REPORT_VIEWER_URI,
        datasetId,
      });
    }

    const actionName = (parsed as any).action;
    return formatResponse(actionName, ctx, null, {
      code: 'NOT_IMPLEMENTED',
      message: `Action ${actionName} is not yet implemented.`,
    });
  },
};
