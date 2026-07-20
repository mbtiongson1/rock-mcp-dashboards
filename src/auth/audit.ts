import * as crypto from 'crypto';
import { OAuthRockContext } from '../http/oauth.js';

export interface AuditEvent {
  timestamp: string;
  requestId: string;
  sessionId: string;
  oauthSubjectHash: string;
  rockPersonId?: number;
  endpoint: string;
  mode: 'readonly' | 'readwrite';
  scopeUsed: 'read' | 'write';
  tool: string;
  action: string;
  target?: {
    model?: string;
    id?: string | number;
    guid?: string;
  };
  dryRun?: boolean;
  commit?: boolean;
  reason?: string;
  outcome: 'allowed' | 'denied' | 'success' | 'error';
  errorCode?: string;
}

export class AuditLogger {
  public log(
    ctx: OAuthRockContext,
    params: {
      tool: string;
      action: string;
      target?: {
        model?: string;
        id?: string | number;
        guid?: string;
      };
      dryRun?: boolean;
      commit?: boolean;
      reason?: string;
      outcome: 'allowed' | 'denied' | 'success' | 'error';
      errorCode?: string;
    }
  ): void {
    const oauthSubjectHash = crypto
      .createHash('sha256')
      .update(ctx.oauth.subject || '')
      .digest('hex');

    const scopeUsed: 'read' | 'write' = params.tool === 'rock_write' || params.action.startsWith('update') || params.action.startsWith('create') || params.action.startsWith('add') || params.action.startsWith('patch')
      ? 'write'
      : 'read';

    const event: AuditEvent = {
      timestamp: new Date().toISOString(),
      requestId: ctx.request.requestId,
      sessionId: ctx.request.sessionId,
      oauthSubjectHash,
      rockPersonId: ctx.rockUser.personId,
      endpoint: ctx.endpoint,
      mode: ctx.mode,
      scopeUsed,
      tool: params.tool,
      action: params.action,
      target: params.target,
      dryRun: params.dryRun,
      commit: params.commit,
      reason: params.reason,
      outcome: params.outcome,
      errorCode: params.errorCode,
    };

    // Log as a single line JSON string for structured logging tools to parse easily
    console.log(JSON.stringify(event));
  }
}
