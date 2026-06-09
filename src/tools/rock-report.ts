import { z } from 'zod';
import * as crypto from 'crypto';
import { GatewayTool, McpToolResult } from './types.js';
import { McpMode, McpScope } from '../mcp/modes.js';
import { OAuthRockContext } from '../http/oauth.js';
import { formatResponse } from './formatter.js';
import { RockClient } from '../rock/client.js';
import { StoredDataset } from './dataset-store.js';
import { REPORT_VIEWER_URI } from '../mcp/apps.js';

const rockReportSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('list'),
    query: z.string().optional(),
    limit: z.coerce.number().int().positive().max(100).default(50),
  }),
  z.object({
    action: z.literal('run'),
    reportId: z.coerce.number(),
    limit: z.coerce.number().int().positive().max(500).default(50),
  }),
  z.object({
    action: z.literal('summary'),
    datasetId: z.string(),
    includeRows: z.boolean().default(false),
  }),
  z.object({
    action: z.literal('export'),
    datasetId: z.string(),
    format: z.enum(['csv', 'json']).default('csv'),
  }),
  z.object({
    action: z.literal('app'),
    datasetId: z.string(),
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
      const { reportId } = parsed;
      try {
        if (!datasetStore) {
          throw new Error('Dataset store is not initialized.');
        }

        // Fetch report metadata first to get name
        const reportMeta = await rockClient.get<any>(ctx, `/api/Reports/${reportId}`);

        // Run the report using GET /api/Reports/run/{id}
        const rows = await rockClient.get<any[]>(ctx, `/api/Reports/run/${reportId}`);
        
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
