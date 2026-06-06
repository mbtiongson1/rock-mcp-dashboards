import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-ignore
import { rockEntityTool } from './rock-entity.js';
// @ts-ignore
import { OAuthRockContext } from '../http/oauth.js';

describe('rock_entity tool', () => {
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

  it('should handle get action and return entity', async () => {
    mockClient.get.mockResolvedValue({ Id: 123, Name: 'Alex Santos' });

    const result = await rockEntityTool.handle(
      { action: 'get', model: 'people', id: 123 },
      null,
      mockCtx
    );

    expect(mockClient.get).toHaveBeenCalledWith(mockCtx, '/api/v2/models/people/123');
    const response = JSON.parse(result.content[0].text!);
    expect(response.result.Name).toBe('Alex Santos');
  });

  it('should handle search action', async () => {
    mockClient.post.mockResolvedValue([{ Id: 123, Name: 'Alex Santos' }]);

    const result = await rockEntityTool.handle(
      { action: 'search', model: 'people', where: 'Id == 123' },
      null,
      mockCtx
    );

    expect(mockClient.post).toHaveBeenCalledWith(
      mockCtx,
      '/api/v2/models/people/search',
      expect.objectContaining({ Where: 'Id == 123' })
    );
    const response = JSON.parse(result.content[0].text!);
    expect(response.result[0].Name).toBe('Alex Santos');
  });

  it('should handle searchByKey action with model specified', async () => {
    mockClient.post.mockResolvedValue([
      { Id: 123, Name: 'Alex Santos' },
      { Id: 124, Name: 'Jane Doe' },
    ]);

    const result = await rockEntityTool.handle(
      {
        action: 'searchByKey',
        model: 'people',
        searchKey: 'ActiveLeaders',
        refinements: { Campus: 'Manila' },
        offset: 0,
        limit: 100,
      },
      null,
      mockCtx
    );

    expect(mockClient.post).toHaveBeenCalledWith(
      mockCtx,
      '/api/v2/models/people/search/ActiveLeaders',
      expect.objectContaining({
        Campus: 'Manila',
        Offset: 0,
        Limit: 100,
      })
    );
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result).toHaveLength(2);
    expect(response.result[0].Name).toBe('Alex Santos');
  });

  it('should handle searchByKey action without model (EntitySearch endpoint)', async () => {
    mockClient.post.mockResolvedValue([{ Id: 456, Name: 'John Smith' }]);

    const result = await rockEntityTool.handle(
      {
        action: 'searchByKey',
        searchKey: 'CoreMembers',
        refinements: { Status: 'Active' },
        offset: 0,
        limit: 50,
      },
      null,
      mockCtx
    );

    expect(mockClient.post).toHaveBeenCalledWith(
      mockCtx,
      '/api/v2/EntitySearch/CoreMembers',
      expect.objectContaining({
        Status: 'Active',
        Offset: 0,
        Limit: 50,
      })
    );
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result).toHaveLength(1);
    expect(response.result[0].Name).toBe('John Smith');
  });

  it('should handle count with where clause', async () => {
    mockClient.post.mockResolvedValue(42);

    const result = await rockEntityTool.handle(
      {
        action: 'count',
        model: 'people',
        where: 'IsActive == true',
      },
      null,
      mockCtx
    );

    expect(mockClient.post).toHaveBeenCalledWith(
      mockCtx,
      '/api/v2/models/people/search',
      expect.objectContaining({
        Where: 'IsActive == true',
        IsCountOnly: true,
      })
    );
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result.count).toBe(42);
  });

  it('should handle count with searchKey', async () => {
    mockClient.post.mockResolvedValue([
      { Id: 1 },
      { Id: 2 },
      { Id: 3 },
    ]);

    const result = await rockEntityTool.handle(
      {
        action: 'count',
        model: 'people',
        searchKey: 'ActiveMembers',
      },
      null,
      mockCtx
    );

    expect(mockClient.post).toHaveBeenCalledWith(
      mockCtx,
      '/api/v2/EntitySearch/ActiveMembers',
      expect.objectContaining({
        Offset: 0,
        Limit: 1000,
      })
    );
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result.count).toBe(3);
  });

  it('should reject raw search on non-allowlisted model', async () => {
    const result = await rockEntityTool.handle(
      {
        action: 'search',
        model: 'restrictedModel',
        where: 'Id == 1',
      },
      null,
      mockCtx
    );

    expect(mockClient.post).not.toHaveBeenCalled();
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('MODEL_NOT_ALLOWED');
    expect(response.error?.message).toContain('Raw search is not allowed on model');
  });

  it('should allow raw search on allowlisted model (people)', async () => {
    mockClient.post.mockResolvedValue([{ Id: 123, Name: 'Alex Santos' }]);

    const result = await rockEntityTool.handle(
      {
        action: 'search',
        model: 'people',
        where: 'Id == 123',
      },
      null,
      mockCtx
    );

    expect(mockClient.post).toHaveBeenCalled();
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
  });

  it('should reject count with where on non-allowlisted model', async () => {
    const result = await rockEntityTool.handle(
      {
        action: 'count',
        model: 'restrictedModel',
        where: 'Id == 1',
      },
      null,
      mockCtx
    );

    expect(mockClient.post).not.toHaveBeenCalled();
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('MODEL_NOT_ALLOWED');
  });

  it('should handle searchByKey with count shape', async () => {
    mockClient.post.mockResolvedValue([
      { Id: 1 },
      { Id: 2 },
      { Id: 3 },
      { Id: 4 },
      { Id: 5 },
    ]);

    const result = await rockEntityTool.handle(
      {
        action: 'searchByKey',
        searchKey: 'LargeGroup',
        shape: 'count',
      },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result).toBe(5);
  });

  it('should handle searchByKey errors gracefully', async () => {
    mockClient.post.mockRejectedValue(new Error('API error: Not Found'));

    const result = await rockEntityTool.handle(
      {
        action: 'searchByKey',
        searchKey: 'NonExistentSearch',
      },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('SEARCH_BY_KEY_ERROR');
    expect(response.error?.message).toContain('API error');
  });

  // Tests for v2/v1 fallback behavior for attributeValues
  it('should fetch attributeValues via v2 when v2 succeeds', async () => {
    const mockAttrs = [
      { AttributeId: 1, Value: 'value1' },
      { AttributeId: 2, Value: 'value2' },
    ];
    mockClient.get.mockResolvedValue(mockAttrs);

    const result = await rockEntityTool.handle(
      { action: 'attributeValues', model: 'people', id: 123 },
      null,
      mockCtx
    );

    expect(mockClient.get).toHaveBeenCalledWith(mockCtx, '/api/v2/models/people/123/attributevalues');
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result).toEqual(mockAttrs);
    expect(response.warning).toBeUndefined();
  });

  it('should fall back to v1 attributeValues endpoint when v2 fails', async () => {
    const mockAttrs = [
      { AttributeId: 1, Value: 'value1' },
      { AttributeId: 2, Value: 'value2' },
    ];

    // v2 fails, v1 succeeds
    mockClient.get
      .mockRejectedValueOnce(new Error('v2 not authorized'))
      .mockResolvedValueOnce(mockAttrs);

    const result = await rockEntityTool.handle(
      { action: 'attributeValues', model: 'people', id: 123 },
      null,
      mockCtx
    );

    // Should attempt v2 first
    expect(mockClient.get).toHaveBeenNthCalledWith(1, mockCtx, '/api/v2/models/people/123/attributevalues');
    // Then fall back to v1
    expect(mockClient.get).toHaveBeenNthCalledWith(2, mockCtx, '/api/People/123/AttributeValues');

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result).toEqual(mockAttrs);
    expect(response.warning).toContain('Fell back to REST v1');
  });

  it('should return clear error when both v2 and v1 attributeValues fail', async () => {
    mockClient.get.mockRejectedValue(new Error('Not Found'));

    const result = await rockEntityTool.handle(
      { action: 'attributeValues', model: 'people', id: 123 },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('ATTRIBUTE_VALUES_ERROR');
    expect(response.error?.message).toContain('v2 and v1');
  });

  // Tests for searchByKey v2 error handling
  it('should return clear error for searchByKey v2 failure noting v2-only requirement', async () => {
    mockClient.post.mockRejectedValue(new Error('401 Unauthorized'));

    const result = await rockEntityTool.handle(
      {
        action: 'searchByKey',
        searchKey: 'SavedEntitySearch',
      },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('SEARCH_BY_KEY_ERROR');
    expect(response.error?.message).toContain('v2');
  });

  // Tests for count with searchKey v2 error handling
  it('should return clear error for count with searchKey when v2 fails', async () => {
    mockClient.post.mockRejectedValue(new Error('401 Unauthorized'));

    const result = await rockEntityTool.handle(
      {
        action: 'count',
        model: 'people',
        searchKey: 'SavedEntitySearch',
      },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('COUNT_ERROR');
    expect(response.error?.message).toContain('v2');
  });
});
