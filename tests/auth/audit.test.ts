import { describe, it, expect, vi } from 'vitest';
// @ts-ignore
import { AuditLogger } from '../../src/auth/audit.js';
// @ts-ignore
import { OAuthRockContext } from '../../src/http/oauth.js';

describe('AuditLogger', () => {
  it('should correctly format and log audit events without logging sensitive data', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new AuditLogger();

    const ctx: OAuthRockContext = {
      endpoint: 'mcp',
      mode: 'readwrite',
      scopes: new Set(['read', 'write']),
      oauth: {
        subject: 'user-123',
        email: 'alex@example.com',
        accessTokenHash: 'secret_hash_value',
      },
      rockUser: {
        personId: 42,
        isRsrAdmin: true,
      },
      request: {
        requestId: 'req-abc',
        sessionId: 'sess-xyz',
      },
    };

    logger.log(ctx, {
      tool: 'rock_write',
      action: 'patch',
      target: { model: 'Person', id: 42 },
      dryRun: true,
      reason: 'Updating name',
      outcome: 'success',
    });

    expect(consoleSpy).toHaveBeenCalled();
    const loggedText = consoleSpy.mock.calls[0][0];
    const logObj = JSON.parse(loggedText);

    expect(logObj.requestId).toBe('req-abc');
    expect(logObj.sessionId).toBe('sess-xyz');
    expect(logObj.oauthSubjectHash).toBeDefined();
    // Verify sensitive email is NOT in audit log
    expect(loggedText).not.toContain('alex@example.com');
    expect(logObj.outcome).toBe('success');
    expect(logObj.reason).toBe('Updating name');

    consoleSpy.mockRestore();
  });
});
