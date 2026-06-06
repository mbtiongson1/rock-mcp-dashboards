import { z } from 'zod';
import { McpMode, McpScope } from '../mcp/modes.js';
import { OAuthRockContext } from '../http/oauth.js';

export interface McpToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    [key: string]: any;
  }>;
  isError?: boolean;
}

export interface GatewayTool {
  name: string;
  title: string;
  schemaForMode(mode: McpMode, scopes: Set<McpScope>): z.ZodTypeAny | null;
  descriptionForMode(mode: McpMode): string;
  handle(args: any, extra: any, ctx: OAuthRockContext): Promise<McpToolResult>;
  /**
   * Optional: URI of a UI resource (MCP App) to display for this tool's results.
   * When set, the tool registration includes `_meta.ui.resourceUri` per MCP Apps spec.
   * The host will open the app when this tool completes.
   */
  appResourceUri?: string;
}
