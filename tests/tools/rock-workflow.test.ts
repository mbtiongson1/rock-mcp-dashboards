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

  it('workflowStatus should resolve via the v1 controller and report isCompleted=false when CompletedDateTime is null', async () => {
    mockClient.get.mockResolvedValue({ Id: 3734, Name: 'Volunteer to Serve', Status: 'Active', CompletedDateTime: null });

    const result = await rockWorkflowTool.handle(
      { action: 'workflowStatus', workflowId: 3734 },
      null,
      mockCtx
    );

    // v1 controller keys on the integer Id (not the v2 IdKey route).
    expect(mockClient.get).toHaveBeenCalledWith(mockCtx, '/api/Workflows/3734');
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result.isCompleted).toBe(false);
    expect(response.result.status).toBe('Active');
  });

  it('workflowStatus should report isCompleted=true only when CompletedDateTime is set', async () => {
    mockClient.get.mockResolvedValue({ Id: 42, Name: 'Done WF', Status: 'Completed', CompletedDateTime: '2026-07-18T00:00:00Z' });

    const result = await rockWorkflowTool.handle(
      { action: 'workflowStatus', workflowId: 42 },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.result.isCompleted).toBe(true);
  });

  it('workflowStatus should fail closed on an id/record mismatch instead of trusting the wrong workflow', async () => {
    // Simulates the IdKey-vs-Id bug: Rock returns a different (completed) record.
    mockClient.get.mockResolvedValue({ Id: 9999, Name: 'Other WF', Status: 'Completed', CompletedDateTime: '2026-07-01T00:00:00Z' });

    const result = await rockWorkflowTool.handle(
      { action: 'workflowStatus', workflowId: 3734 },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('WORKFLOW_ID_MISMATCH');
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
