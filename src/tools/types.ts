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

/**
 * Shared contract for every Rock MCP gateway tool. Tools declare their schema
 * per resolved mode so read-write-only tools can be hidden before clients ever
 * see them, then receive the fully resolved OAuth/Rock context at execution.
 */
export interface GatewayTool {
  name: string;
  title: string;
  /** Return a Zod schema for visible tools or null to hide the tool in this mode. */
  schemaForMode(mode: McpMode, scopes: Set<McpScope>): z.ZodTypeAny | null;
  /** Human-readable description used when advertising the tool to MCP clients. */
  descriptionForMode(mode: McpMode): string;
  /** Execute the tool with already-validated args and the request-scoped context. */
  handle(args: any, extra: any, ctx: OAuthRockContext): Promise<McpToolResult>;
  /**
   * Optional: URI of a UI resource (MCP App) to display for this tool's results.
   * When set, the tool registration includes `_meta.ui.resourceUri` per MCP Apps spec.
   * The host will open the app when this tool completes.
   */
  appResourceUri?: string;
}
