import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-ignore
import { rockWriteTool } from './rock-write.js';
// @ts-ignore
import { OAuthRockContext } from '../http/oauth.js';

describe('rock_write tool', () => {
  let mockClient: any;
  let mockCtx: any;

  beforeEach(() => {
    mockClient = {
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    };

    mockCtx = {
      mode: 'readwrite',
      scopes: new Set(['read', 'write']),
      rockClient: mockClient,
      oauth: {
        subject: 'user-123',
        accessTokenHash: 'hash-123',
      },
      request: {
        requestId: 'req-123',
        sessionId: 'sess-123',
      },
      rockUser: {
        personId: 456,
        isRsrAdmin: false,
      },
      endpoint: '/mcp/readwrite',
    } as unknown as OAuthRockContext;
  });

  it('should return null schema in readonly mode', () => {
    const schema = rockWriteTool.schemaForMode('readonly', new Set(['read']));
    expect(schema).toBeNull();
  });

  it('should fail if reason is missing', async () => {
    const result = await rockWriteTool.handle(
      { action: 'patch', model: 'people', id: 123, data: { NickName: 'Alex' }, commit: true },
      null,
      mockCtx
    );
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(false);
    expect(response.error.message).toContain('reason');
  });

  it('should not mutate if dryRun is true', async () => {
    const result = await rockWriteTool.handle(
      { action: 'patch', model: 'people', id: 123, data: { NickName: 'Alex' }, dryRun: true, reason: 'Testing dryrun' },
      null,
      mockCtx
    );

    expect(mockClient.patch).not.toHaveBeenCalled();
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result.dryRun).toBe(true);
  });

  it('should call client.patch if commit is true and reason is provided', async () => {
    mockClient.patch.mockResolvedValue({ Id: 123, NickName: 'Alex' });

    const result = await rockWriteTool.handle(
      { action: 'patch', model: 'people', id: 123, data: { NickName: 'Alex' }, commit: true, dryRun: false, reason: 'Change nickname' },
      null,
      mockCtx
    );

    expect(mockClient.patch).toHaveBeenCalledWith(
      mockCtx,
      '/api/v2/models/people/123',
      expect.objectContaining({ NickName: 'Alex' })
    );
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
  });

  it('should deny patch on disallowed models', async () => {
    const result = await rockWriteTool.handle(
      { action: 'patch', model: 'secretModel', id: 123, data: { field: 'value' }, dryRun: true, reason: 'Test' },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('MODEL_NOT_ALLOWED');
  });

  it('should deny delete to non-admins', async () => {
    mockCtx.rockUser.isRsrAdmin = false;
    const result = await rockWriteTool.handle(
      { action: 'delete', model: 'groupmembers', id: 123, dryRun: true, reason: 'Test' },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('DELETE_REQUIRES_ADMIN');
  });

  it('should allow delete to admins', async () => {
    mockClient.delete.mockResolvedValue({});
    mockCtx.rockUser.isRsrAdmin = true;
    const result = await rockWriteTool.handle(
      { action: 'delete', model: 'groupmembers', id: 123, commit: true, dryRun: false, reason: 'Delete member' },
      null,
      mockCtx
    );

    expect(mockClient.delete).toHaveBeenCalled();
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
  });

  it('should deny patch with disallowed fields', async () => {
    const result = await rockWriteTool.handle(
      { action: 'patch', model: 'people', id: 123, data: { Email: 'test@example.com', SecretField: 'bad' }, dryRun: true, reason: 'Test' },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('FIELD_NOT_ALLOWED');
  });

  // ===== CREATE ACTION TESTS =====
  it('create: should fail if reason is missing', async () => {
    const result = await rockWriteTool.handle(
      { action: 'create', model: 'notes', data: { EntityId: 123, Text: 'Hello' }, commit: true },
      null,
      mockCtx
    );
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(false);
    expect(response.error.message).toContain('reason');
  });

  it('create: should not mutate if dryRun is true', async () => {
    const result = await rockWriteTool.handle(
      { action: 'create', model: 'notes', data: { EntityId: 123, Text: 'Hello' }, dryRun: true, reason: 'Create note' },
      null,
      mockCtx
    );

    expect(mockClient.post).not.toHaveBeenCalled();
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result.dryRun).toBe(true);
  });

  it('create: should post to v2 endpoint on commit', async () => {
    mockClient.post.mockResolvedValue({ Id: 999, EntityId: 123, Text: 'Hello' });

    const result = await rockWriteTool.handle(
      { action: 'create', model: 'notes', data: { EntityId: 123, Text: 'Hello' }, commit: true, dryRun: false, reason: 'Create note' },
      null,
      mockCtx
    );

    expect(mockClient.post).toHaveBeenCalledWith(
      mockCtx,
      '/api/v2/models/notes',
      expect.objectContaining({ EntityId: 123, Text: 'Hello' })
    );
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result.committed).toBe(true);
  });

  it('create: should deny on disallowed model', async () => {
    const result = await rockWriteTool.handle(
      { action: 'create', model: 'people', data: { FirstName: 'John' }, dryRun: true, reason: 'Test' },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('OPERATION_NOT_ALLOWED');
  });

  it('create: should deny on disallowed fields', async () => {
    const result = await rockWriteTool.handle(
      { action: 'create', model: 'notes', data: { EntityId: 123, Text: 'Hello', SecretField: 'bad' }, dryRun: true, reason: 'Test' },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('FIELD_NOT_ALLOWED');
  });

  // ===== PATCH ATTRIBUTES ACTION TESTS =====
  it('patchAttributes: should fail if reason is missing', async () => {
    const result = await rockWriteTool.handle(
      { action: 'patchAttributes', model: 'people', id: 123, attributes: { customAttr: 'value' }, commit: true },
      null,
      mockCtx
    );
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(false);
    expect(response.error.message).toContain('reason');
  });

  it('patchAttributes: should not mutate if dryRun is true', async () => {
    const result = await rockWriteTool.handle(
      { action: 'patchAttributes', model: 'people', id: 123, attributes: { customAttr: 'value' }, dryRun: true, reason: 'Patch attrs' },
      null,
      mockCtx
    );

    expect(mockClient.patch).not.toHaveBeenCalled();
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result.dryRun).toBe(true);
  });

  it('patchAttributes: should patch attributevalues endpoint on commit', async () => {
    mockClient.patch.mockResolvedValue({});

    const result = await rockWriteTool.handle(
      { action: 'patchAttributes', model: 'people', id: 123, attributes: { customAttr: 'value' }, commit: true, dryRun: false, reason: 'Patch attrs' },
      null,
      mockCtx
    );

    expect(mockClient.patch).toHaveBeenCalledWith(
      mockCtx,
      '/api/v2/models/people/123/attributevalues',
      expect.objectContaining({ customAttr: 'value' })
    );
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result.committed).toBe(true);
  });

  it('patchAttributes: should deny on disallowed model', async () => {
    const result = await rockWriteTool.handle(
      { action: 'patchAttributes', model: 'secretModel', id: 123, attributes: { attr: 'value' }, dryRun: true, reason: 'Test' },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('MODEL_NOT_ALLOWED');
  });

  // ===== BULK PATCH ACTION TESTS =====
  it('bulkPatch: should fail if reason is missing', async () => {
    const result = await rockWriteTool.handle(
      { action: 'bulkPatch', model: 'people', items: [{ id: 1, data: { Email: 'test@example.com' } }], commit: true },
      null,
      mockCtx
    );
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(false);
    expect(response.error.message).toContain('reason');
  });

  it('bulkPatch: dryRun should return total count', async () => {
    const result = await rockWriteTool.handle(
      { action: 'bulkPatch', model: 'people', items: [{ id: 1, data: { Email: 'test1@example.com' } }, { id: 2, data: { Email: 'test2@example.com' } }], dryRun: true, reason: 'Bulk patch' },
      null,
      mockCtx
    );

    expect(mockClient.patch).not.toHaveBeenCalled();
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result.dryRun).toBe(true);
    expect(response.result.total).toBe(2);
  });

  it('bulkPatch: should patch each item sequentially on commit', async () => {
    mockClient.patch.mockResolvedValue({ Id: 1 });

    const result = await rockWriteTool.handle(
      { action: 'bulkPatch', model: 'people', items: [{ id: 1, data: { Email: 'test1@example.com' } }, { id: 2, data: { Email: 'test2@example.com' } }], commit: true, dryRun: false, reason: 'Bulk patch' },
      null,
      mockCtx
    );

    expect(mockClient.patch).toHaveBeenCalledTimes(2);
    expect(mockClient.patch).toHaveBeenNthCalledWith(1, mockCtx, '/api/v2/models/people/1', expect.objectContaining({ Email: 'test1@example.com' }));
    expect(mockClient.patch).toHaveBeenNthCalledWith(2, mockCtx, '/api/v2/models/people/2', expect.objectContaining({ Email: 'test2@example.com' }));

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result.committed).toBe(true);
    expect(response.result.total).toBe(2);
    expect(response.result.succeeded).toBe(2);
    expect(response.result.failed).toBe(0);
  });

  it('bulkPatch: should deny on bulk limit exceeded', async () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: i, data: { Email: `test${i}@example.com` } }));

    const result = await rockWriteTool.handle(
      { action: 'bulkPatch', model: 'people', items, dryRun: true, reason: 'Test' },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('BULK_LIMIT_EXCEEDED');
  });

  it('bulkPatch: should deny on disallowed model', async () => {
    const result = await rockWriteTool.handle(
      { action: 'bulkPatch', model: 'secretModel', items: [{ id: 1, data: { field: 'value' } }], dryRun: true, reason: 'Test' },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('MODEL_NOT_ALLOWED');
  });

  it('bulkPatch: should collect per-item errors on commit', async () => {
    mockClient.patch
      .mockResolvedValueOnce({ Id: 1 })
      .mockRejectedValueOnce(new Error('Item 2 failed'))
      .mockResolvedValueOnce({ Id: 3 });

    const result = await rockWriteTool.handle(
      { action: 'bulkPatch', model: 'connectionrequests', items: [{ id: 1, data: { Comments: 'test1' } }, { id: 2, data: { Comments: 'test2' } }, { id: 3, data: { Comments: 'test3' } }], commit: true, dryRun: false, reason: 'Bulk patch' },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result.committed).toBe(true);
    expect(response.result.total).toBe(3);
    expect(response.result.succeeded).toBe(2);
    expect(response.result.failed).toBe(1);
    expect(response.result.results).toHaveLength(3);
  });
});
