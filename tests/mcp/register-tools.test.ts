import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGatewayTools } from '../../src/mcp/register-tools.js';
import { AuditLogger } from '../../src/auth/audit.js';
import type { OAuthRockContext } from '../../src/http/oauth.js';

vi.mock('../../src/auth/audit.js');

describe('registerGatewayTools', () => {
  let mockServer: Partial<McpServer>;
  let mockAuditLogger: any;
  let testCtx: OAuthRockContext;

  beforeEach(() => {
    mockServer = {
      registerTool: vi.fn(),
    };

    mockAuditLogger = {
      log: vi.fn(),
    };

    (AuditLogger as any).mockImplementation(() => mockAuditLogger);

    testCtx = {
      endpoint: 'mcp',
      mode: 'readonly',
      scopes: new Set(['read']),
      oauth: {
        subject: 'test-subject',
        email: 'test@example.com',
        accessTokenHash: 'hash',
      },
      rockUser: {
        personId: 123,
        isRsrAdmin: false,
        isStaff: false,
        ledGroupIds: [],
      },
      request: {
        sessionId: 'session-123',
        requestId: 'request-123',
      },
    };
  });

  it('logs INVALID_ARGUMENTS errors with tool name, action, and error code', async () => {
    registerGatewayTools(mockServer as McpServer, 'readonly', testCtx);

    const registerCalls = (mockServer.registerTool as any).mock.calls;
    expect(registerCalls.length).toBeGreaterThan(0);

    // Find the rock_people tool and call its handler with invalid args
    const peopleTool = registerCalls.find((call: any) => call[0] === 'rock_people');
    expect(peopleTool).toBeDefined();

    const handler = peopleTool![2]; // Third argument is the handler function
    await handler(
      { action: 'find', query: 'test', limit: 'not-a-number' },
      {}
    );

    // Verify the audit log was called with INVALID_ARGUMENTS
    expect(mockAuditLogger.log).toHaveBeenCalledWith(
      testCtx,
      expect.objectContaining({
        tool: 'rock_people',
        action: 'find',
        outcome: 'error',
        errorCode: 'INVALID_ARGUMENTS',
      })
    );
  });

  it('includes truncated error message in reason field', async () => {
    registerGatewayTools(mockServer as McpServer, 'readonly', testCtx);

    const registerCalls = (mockServer.registerTool as any).mock.calls;
    const peopleTool = registerCalls.find((call: any) => call[0] === 'rock_people');
    const handler = peopleTool![2];

    await handler(
      { action: 'find', query: 'test', limit: 'invalid' },
      {}
    );

    expect(mockAuditLogger.log).toHaveBeenCalled();
    const auditCall = mockAuditLogger.log.mock.calls[0];
    const params = auditCall[1];

    expect(params.reason).toBeDefined();
    expect(typeof params.reason).toBe('string');
    expect(params.reason.length).toBeLessThanOrEqual(200);
  });

  it('includes target model set to tool name', async () => {
    registerGatewayTools(mockServer as McpServer, 'readonly', testCtx);

    const registerCalls = (mockServer.registerTool as any).mock.calls;
    const peopleTool = registerCalls.find((call: any) => call[0] === 'rock_entity');
    const handler = peopleTool![2];

    await handler(
      { action: 'get', model: 'people' }, // Missing required id
      {}
    );

    expect(mockAuditLogger.log).toHaveBeenCalled();
    const auditCall = mockAuditLogger.log.mock.calls[0];
    const params = auditCall[1];

    expect(params.target).toEqual({ model: 'rock_entity' });
  });

  it('uses unknown action when action field is missing', async () => {
    registerGatewayTools(mockServer as McpServer, 'readonly', testCtx);

    const registerCalls = (mockServer.registerTool as any).mock.calls;
    const peopleTool = registerCalls.find((call: any) => call[0] === 'rock_people');
    const handler = peopleTool![2];

    await handler({ query: 'test' }, {}); // Missing action

    expect(mockAuditLogger.log).toHaveBeenCalled();
    const auditCall = mockAuditLogger.log.mock.calls[0];
    const params = auditCall[1];

    expect(params.action).toBe('unknown');
  });

  it('registers rock_roster with a non-empty flattened advertisement schema', async () => {
    registerGatewayTools(mockServer as McpServer, 'readwrite', {
      ...testCtx,
      mode: 'readwrite',
      scopes: new Set(['read', 'write']),
    });

    const registerCalls = (mockServer.registerTool as any).mock.calls;
    const rosterTool = registerCalls.find((call: any) => call[0] === 'rock_roster');
    expect(rosterTool).toBeDefined();

    const config = rosterTool![1];
    // The flattened advertisement schema must expose the discriminator's enum
    // of action names — a bare discriminated-union root would advertise an
    // empty object schema here instead.
    const shape = config.inputSchema?.shape ?? config.inputSchema?._def?.shape?.();
    expect(shape).toBeDefined();
    expect(shape.action).toBeDefined();
  });
});
