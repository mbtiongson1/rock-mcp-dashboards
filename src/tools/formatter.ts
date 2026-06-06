import { OAuthRockContext } from '../http/oauth.js';
import { McpToolResult } from './types.js';

export interface ToolResponse<T> {
  ok: boolean;
  mode: 'readonly' | 'readwrite';
  action: string;
  result?: T;
  warning?: string;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta?: {
    rockVersion?: string;
    discoveryVersion?: string;
    datasetId?: string;
    appUri?: string;
    truncated?: boolean;
    cached?: boolean;
  };
}

export function formatResponse<T>(
  action: string,
  ctx: OAuthRockContext,
  result?: T,
  error?: { code: string; message: string; details?: unknown },
  warning?: string,
  meta?: ToolResponse<T>['meta']
): McpToolResult {
  const response: ToolResponse<T> = {
    ok: !error,
    mode: ctx.mode,
    action,
    result,
    warning,
    error,
    meta,
  };

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(response, null, 2),
      },
    ],
    isError: !!error,
  };
}
