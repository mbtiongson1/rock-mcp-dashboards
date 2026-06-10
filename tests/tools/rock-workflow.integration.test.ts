import { describe, it, expect } from 'vitest';
import { rockWorkflowTool } from '../../src/tools/rock-workflow.js';
import { RockClientImpl } from '../../src/rock/client.js';
import { OAuthRockContext } from '../../src/http/oauth.js';

describe('rock_workflow Integration Test', () => {
  const hasEnv = !!(process.env.ROCK_PUBLIC_URL && process.env.ROCK_API_KEY);

  it.runIf(hasEnv)('should query connection requests and workflow types on the live preview server', async () => {
    const client = new RockClientImpl({
      baseUrl: process.env.ROCK_PUBLIC_URL!,
      apiKey: process.env.ROCK_API_KEY!,
    });

    const mockCtx = {
      mode: 'readonly',
      scopes: new Set(['read']),
      request: {
        requestId: 'workflow-int-req-123',
        sessionId: 'workflow-int-sess-456',
      },
      rockClient: client,
    } as unknown as OAuthRockContext;

    // Call connectionRequests
    const resultCr = await rockWorkflowTool.handle(
      { action: 'connectionRequests' },
      null,
      mockCtx
    );

    expect(resultCr).toBeDefined();
    expect(resultCr.content[0].type).toBe('text');
    const responseCr = JSON.parse(resultCr.content[0].text!);
    expect(responseCr.ok).toBe(true);
    expect(Array.isArray(responseCr.result)).toBe(true);

    // Call workflowTypes
    const resultWt = await rockWorkflowTool.handle(
      { action: 'workflowTypes' },
      null,
      mockCtx
    );

    expect(resultWt).toBeDefined();
    expect(resultWt.content[0].type).toBe('text');
    const responseWt = JSON.parse(resultWt.content[0].text!);
    expect(responseWt.ok).toBe(true);
    expect(Array.isArray(responseWt.result)).toBe(true);
  });
});
