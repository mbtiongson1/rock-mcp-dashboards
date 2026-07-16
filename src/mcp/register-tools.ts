import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { allTools } from '../tools/index.js';
import { formatResponse } from '../tools/formatter.js';
import {
  flattenUnionForAdvertisement,
  describeWithActions,
  describeToolValidationError,
} from '../tools/schema-utils.js';
import { McpMode } from './modes.js';
import type { OAuthRockContext } from '../http/oauth.js';
import { AuditLogger } from '../auth/audit.js';

/**
 * Register all gateway tools on an McpServer for the given mode/context.
 *
 * Discriminated-union schemas are flattened for advertisement (the SDK cannot
 * serialize a union root to JSON Schema, and would otherwise advertise an
 * empty input schema), descriptions enumerate the valid actions, and ZodErrors
 * thrown by the tools' strict parses are converted into structured tool
 * errors instead of opaque protocol failures.
 */
export function registerGatewayTools(server: McpServer, mode: McpMode, ctx: OAuthRockContext): void {
  const auditLogger = new AuditLogger();

  const caps = {
    isAdmin: ctx.rockUser.isRsrAdmin,
    isStaffOrAdmin: ctx.rockUser.isRsrAdmin || ctx.rockUser.isStaff,
  };

  for (const tool of allTools) {
    const schema = tool.schemaForMode(mode, ctx.scopes, caps);
    if (!schema) continue;

    // Per MCP Apps spec (ext-apps v0.3.0), tools that open an MCP App
    // must advertise the app resource URI via _meta.ui.resourceUri.
    const baseConfig = {
      title: tool.title,
      description: describeWithActions(tool.descriptionForMode(mode), schema),
      inputSchema: flattenUnionForAdvertisement(schema),
    };
    const config = tool.appResourceUri
      ? {
          ...baseConfig,
          _meta: {
            ui: {
              resourceUri: tool.appResourceUri,
            },
          },
        }
      : baseConfig;

    server.registerTool(
      tool.name,
      config,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (args: any, extra: any) => {
        try {
          return await tool.handle(args, extra, ctx) as any;
        } catch (err) {
          if (err instanceof z.ZodError) {
            const action = String(args?.action ?? 'unknown');
            const errorMessage = describeToolValidationError(tool.name, err, schema, args);
            const reason = errorMessage.substring(0, 200);

            auditLogger.log(ctx, {
              tool: tool.name,
              action,
              target: { model: tool.name },
              outcome: 'error',
              errorCode: 'INVALID_ARGUMENTS',
              reason,
            });

            return formatResponse(action, ctx, null, {
              code: 'INVALID_ARGUMENTS',
              message: errorMessage,
            }) as any;
          }
          throw err;
        }
      }
    );
  }
}
