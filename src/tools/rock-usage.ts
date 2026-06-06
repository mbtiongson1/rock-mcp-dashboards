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
    return 'Exposes the Favor Church operating rules and guidelines for interacting with Rock RMS.';
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
