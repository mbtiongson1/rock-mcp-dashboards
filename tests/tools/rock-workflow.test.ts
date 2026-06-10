import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-ignore
import { rockWorkflowTool } from '../../src/tools/rock-workflow.js';
// @ts-ignore
import { OAuthRockContext } from '../../src/http/oauth.js';

describe('rock_workflow tool', () => {
  let mockClient: any;
  let mockCtx: any;

  beforeEach(() => {
    mockClient = {
      get: vi.fn(),
      post: vi.fn(),
    };

    mockCtx = {
      mode: 'readonly',
      rockClient: mockClient,
    } as unknown as OAuthRockContext;
  });

  it('should handle connectionRequests action and return list', async () => {
    mockClient.post.mockRejectedValue(new Error('v2 not supported'));
    mockClient.get.mockResolvedValue([
      { Id: 1, PersonAlias: { Person: { FirstName: 'Alex', LastName: 'Santos' } } },
    ]);

    const result = await rockWorkflowTool.handle(
      { action: 'connectionRequests' },
      null,
      mockCtx
    );

    expect(mockClient.get).toHaveBeenCalledWith(mockCtx, '/api/ConnectionRequests?$top=50&$expand=PersonAlias/Person');
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result[0].personName).toBe('Alex Santos');
  });

  it('should handle workflowTypes action', async () => {
    mockClient.post.mockRejectedValue(new Error('v2 not supported'));
    mockClient.get.mockResolvedValue([
      { Id: 5, Name: 'Connect Follow-up' },
    ]);

    const result = await rockWorkflowTool.handle(
      { action: 'workflowTypes' },
      null,
      mockCtx
    );

    expect(mockClient.get).toHaveBeenCalledWith(mockCtx, '/api/WorkflowTypes?$top=50');
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result[0].name).toBe('Connect Follow-up');
  });
});
