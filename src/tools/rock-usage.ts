import { z } from 'zod';
import { GatewayTool, McpToolResult } from './types.js';
import { McpMode, McpScope } from '../mcp/modes.js';
import { OAuthRockContext } from '../http/oauth.js';

export const rockUsageTool: GatewayTool = {
  name: 'rock_usage',
  title: 'Rock Usage Guide',
  schemaForMode(_mode: McpMode, _scopes: Set<McpScope>): z.ZodTypeAny | null {
    return z.object({});
  },
  descriptionForMode(_mode: McpMode): string {
    return 'Returns the Favor Church operating rules and conventions for the Rock tools. Call this first (no arguments) if you are unsure which tool or action to use.';
  },
  async handle(_args: any, _extra: any, _ctx: OAuthRockContext): Promise<McpToolResult> {
    return {
      content: [
        {
          type: 'text',
          text: 'Guide is embedded in tool description and server instructions. Use rock_lookup when mapping is unknown.',
        },
      ],
    };
  },
};
