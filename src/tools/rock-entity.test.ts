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

  it('should handle get action and return entity (non-people model)', async () => {
    mockClient.get.mockResolvedValue({ Id: 123, Name: 'Alex Santos' });

    const result = await rockEntityTool.handle(
      { action: 'get', model: 'groups', id: 123 },
      null,
      mockCtx
    );

    expect(mockClient.get).toHaveBeenCalledWith(mockCtx, '/api/v2/models/groups/123');
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
      '/api/v2/models/entitysearches/search/CoreMembers',
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
      '/api/v2/models/entitysearches/search/ActiveMembers',
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

  // Tests for get action with shape-based projection (PII filtering)
  describe('get action with shape-based projection for people', () => {
    it('should return privacy-safe projection for people with default shape (summary)', async () => {
      const rawRecord = {
        Id: 123,
        Guid: '11111111-1111-1111-1111-111111111111',
        IdKey: 'P123',
        FirstName: 'John',
        NickName: 'Johnny',
        LastName: 'Doe',
        Email: 'john.doe@example.com', // PII - should be excluded
        PhoneNumber: '555-1234', // PII - should be excluded
        BirthDate: '1980-01-15', // PII - should be excluded
        PrimaryCampusId: 1,
        ConnectionStatusValue: 'Member',
      };

      mockClient.get.mockResolvedValue(rawRecord);

      const result = await rockEntityTool.handle(
        { action: 'get', model: 'people', id: 123 },
        null,
        mockCtx
      );

      expect(mockClient.get).toHaveBeenCalledWith(mockCtx, '/api/v2/models/people/123');
      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(true);

      const projected = response.result;
      // Should include safe fields
      expect(projected.id).toBe(123);
      expect(projected.guid).toBe('11111111-1111-1111-1111-111111111111');
      expect(projected.idKey).toBe('P123');
      expect(projected.name).toBe('Johnny Doe');
      expect(projected.connectionStatus).toBe('Member');
      expect(projected.campus).toBeDefined(); // campus id or name

      // Should exclude PII
      expect(projected.Email).toBeUndefined();
      expect(projected.PhoneNumber).toBeUndefined();
      expect(projected.BirthDate).toBeUndefined();
      expect(projected.FirstName).toBeUndefined();
      expect(projected.LastName).toBeUndefined();
      expect(projected.NickName).toBeUndefined();
    });

    it('should return raw record for people with shape=full', async () => {
      const rawRecord = {
        Id: 123,
        Guid: '11111111-1111-1111-1111-111111111111',
        FirstName: 'John',
        LastName: 'Doe',
        Email: 'john.doe@example.com',
        PhoneNumber: '555-1234',
      };

      mockClient.get.mockResolvedValue(rawRecord);

      const result = await rockEntityTool.handle(
        { action: 'get', model: 'people', id: 123, shape: 'full' },
        null,
        mockCtx
      );

      expect(mockClient.get).toHaveBeenCalledWith(mockCtx, '/api/v2/models/people/123');
      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(true);

      const unprojected = response.result;
      // Should include all fields including PII
      expect(unprojected.Id).toBe(123);
      expect(unprojected.Email).toBe('john.doe@example.com');
      expect(unprojected.PhoneNumber).toBe('555-1234');
      expect(unprojected.FirstName).toBe('John');
    });

    it('should normalize person/persons model names to apply projection', async () => {
      const rawRecord = {
        Id: 456,
        FirstName: 'Jane',
        LastName: 'Smith',
        Email: 'jane@example.com',
        ConnectionStatusValue: 'Prospect',
      };

      mockClient.get.mockResolvedValue(rawRecord);

      // Test with 'person' instead of 'people'
      const result = await rockEntityTool.handle(
        { action: 'get', model: 'person', id: 456 },
        null,
        mockCtx
      );

      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(true);
      expect(response.result.Email).toBeUndefined();
      expect(response.result.name).toBe('Jane Smith');
    });

    it('should use NickName if FirstName is not available', async () => {
      const rawRecord = {
        Id: 789,
        FirstName: null,
        NickName: 'Bobby',
        LastName: 'Jones',
        Email: 'bobby@example.com',
      };

      mockClient.get.mockResolvedValue(rawRecord);

      const result = await rockEntityTool.handle(
        { action: 'get', model: 'people', id: 789 },
        null,
        mockCtx
      );

      const response = JSON.parse(result.content[0].text!);
      expect(response.result.name).toBe('Bobby Jones');
    });

    it('should return raw record for non-people models regardless of shape', async () => {
      const rawRecord = {
        Id: 999,
        Name: 'Sample Group',
        Description: 'This is a group',
      };

      mockClient.get.mockResolvedValue(rawRecord);

      const result = await rockEntityTool.handle(
        { action: 'get', model: 'groups', id: 999, shape: 'summary' },
        null,
        mockCtx
      );

      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(true);
      expect(response.result).toEqual(rawRecord);
    });

    it('should apply projection on v1 fallback for people', async () => {
      const rawRecord = {
        Id: 555,
        Guid: '22222222-2222-2222-2222-222222222222',
        FirstName: 'Alex',
        LastName: 'Brown',
        Email: 'alex@example.com',
        PhoneNumber: '555-5555',
        ConnectionStatusValue: 'Baptized',
      };

      // v2 fails, v1 succeeds
      mockClient.get
        .mockRejectedValueOnce(new Error('v2 not available'))
        .mockResolvedValueOnce(rawRecord);

      const result = await rockEntityTool.handle(
        { action: 'get', model: 'people', id: 555 },
        null,
        mockCtx
      );

      expect(mockClient.get).toHaveBeenNthCalledWith(1, mockCtx, '/api/v2/models/people/555');
      expect(mockClient.get).toHaveBeenNthCalledWith(2, mockCtx, '/api/People/555');

      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(true);
      expect(response.result.Email).toBeUndefined();
      expect(response.result.PhoneNumber).toBeUndefined();
      expect(response.result.name).toBe('Alex Brown');
      expect(response.result.id).toBe(555);
      expect(response.warning).toContain('Fell back to REST v1');
    });

    it('should include campus field (id or resolved name) in projection', async () => {
      const rawRecord = {
        Id: 111,
        FirstName: 'Chris',
        LastName: 'Davis',
        Email: 'chris@example.com',
        PrimaryCampusId: 5,
      };

      mockClient.get.mockResolvedValue(rawRecord);

      const result = await rockEntityTool.handle(
        { action: 'get', model: 'people', id: 111 },
        null,
        mockCtx
      );

      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(true);
      const projected = response.result;
      // Should have campus field (at least the ID)
      expect(projected.campus).toBeDefined();
    });
  });

  describe('searchByKey error handling', () => {
    it('should handle searchByKey failure when v2 access is denied', async () => {
      mockClient.post.mockRejectedValue(new Error('Rock API error (401 ): Unauthorized'));

      const result = await rockEntityTool.handle(
        {
          action: 'searchByKey',
          searchKey: 'SomeSearch',
          refinements: {},
          offset: 0,
          limit: 100,
        },
        null,
        mockCtx
      );

      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(false);
      expect(response.error.code).toBe('SEARCH_BY_KEY_ERROR');
      expect(response.error.message).toContain('REST v2 access');
    });
  });

  describe('count with searchKey error handling', () => {
    it('should handle count with searchKey failure when v2 access is denied', async () => {
      mockClient.post.mockRejectedValue(new Error('Rock API error (401 ): Unauthorized'));

      const result = await rockEntityTool.handle(
        {
          action: 'count',
          model: 'people',
          searchKey: 'SomeSearch',
        },
        null,
        mockCtx
      );

      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(false);
      expect(response.error.code).toBe('COUNT_ERROR');
      expect(response.error.message).toContain('REST v2 access');
    });
  });

  // Tests for model name normalization (issue #17)
  describe('model name normalization for search and count', () => {
    describe('search action — singular/capitalized model names', () => {
      it('should succeed for search with "Person" (singular capitalized)', async () => {
        mockClient.post.mockResolvedValue([{ Id: 1, FirstName: 'John' }]);

        const result = await rockEntityTool.handle(
          { action: 'search', model: 'Person', where: 'Id == 1' },
          null,
          mockCtx
        );

        // Should have called v2 with normalized (plural) path
        expect(mockClient.post).toHaveBeenCalledWith(
          mockCtx,
          '/api/v2/models/people/search',
          expect.objectContaining({ Where: 'Id == 1' })
        );
        const response = JSON.parse(result.content[0].text!);
        expect(response.ok).toBe(true);
        expect(response.error).toBeUndefined();
      });

      it('should succeed for search with "person" (singular lowercase)', async () => {
        mockClient.post.mockResolvedValue([{ Id: 2 }]);

        const result = await rockEntityTool.handle(
          { action: 'search', model: 'person' },
          null,
          mockCtx
        );

        expect(mockClient.post).toHaveBeenCalledWith(
          mockCtx,
          '/api/v2/models/people/search',
          expect.any(Object)
        );
        const response = JSON.parse(result.content[0].text!);
        expect(response.ok).toBe(true);
      });

      it('should succeed for search with "people" (already plural)', async () => {
        mockClient.post.mockResolvedValue([{ Id: 3 }]);

        const result = await rockEntityTool.handle(
          { action: 'search', model: 'people' },
          null,
          mockCtx
        );

        expect(mockClient.post).toHaveBeenCalledWith(
          mockCtx,
          '/api/v2/models/people/search',
          expect.any(Object)
        );
        const response = JSON.parse(result.content[0].text!);
        expect(response.ok).toBe(true);
      });

      it('should succeed for search with "Group" (singular capitalized)', async () => {
        mockClient.post.mockResolvedValue([{ Id: 10, Name: 'Test Group' }]);

        const result = await rockEntityTool.handle(
          { action: 'search', model: 'Group' },
          null,
          mockCtx
        );

        expect(mockClient.post).toHaveBeenCalledWith(
          mockCtx,
          '/api/v2/models/groups/search',
          expect.any(Object)
        );
        const response = JSON.parse(result.content[0].text!);
        expect(response.ok).toBe(true);
      });

      it('should succeed for search with "GroupMember" (singular PascalCase)', async () => {
        mockClient.post.mockResolvedValue([{ Id: 20, GroupId: 5, PersonId: 1 }]);

        const result = await rockEntityTool.handle(
          { action: 'search', model: 'GroupMember' },
          null,
          mockCtx
        );

        expect(mockClient.post).toHaveBeenCalledWith(
          mockCtx,
          '/api/v2/models/groupmembers/search',
          expect.any(Object)
        );
        const response = JSON.parse(result.content[0].text!);
        expect(response.ok).toBe(true);
      });

      it('should succeed for search with "DefinedValue" (singular PascalCase)', async () => {
        mockClient.post.mockResolvedValue([{ Id: 30, Value: 'Member' }]);

        const result = await rockEntityTool.handle(
          { action: 'search', model: 'DefinedValue' },
          null,
          mockCtx
        );

        expect(mockClient.post).toHaveBeenCalledWith(
          mockCtx,
          '/api/v2/models/definedvalues/search',
          expect.any(Object)
        );
        const response = JSON.parse(result.content[0].text!);
        expect(response.ok).toBe(true);
      });

      it('should reject search on genuinely disallowed model "UserLogin"', async () => {
        const result = await rockEntityTool.handle(
          { action: 'search', model: 'UserLogin', where: 'Id == 1' },
          null,
          mockCtx
        );

        expect(mockClient.post).not.toHaveBeenCalled();
        const response = JSON.parse(result.content[0].text!);
        expect(response.ok).toBe(false);
        expect(response.error?.code).toBe('MODEL_NOT_ALLOWED');
      });

      it('should reject search on genuinely disallowed model "userlogins"', async () => {
        const result = await rockEntityTool.handle(
          { action: 'search', model: 'userlogins', where: 'Id == 1' },
          null,
          mockCtx
        );

        expect(mockClient.post).not.toHaveBeenCalled();
        const response = JSON.parse(result.content[0].text!);
        expect(response.ok).toBe(false);
        expect(response.error?.code).toBe('MODEL_NOT_ALLOWED');
      });
    });

    describe('count action — singular/capitalized model names', () => {
      it('should succeed for count with "Person" (singular capitalized)', async () => {
        mockClient.post.mockResolvedValue(15);

        const result = await rockEntityTool.handle(
          { action: 'count', model: 'Person', where: 'IsActive == true' },
          null,
          mockCtx
        );

        expect(mockClient.post).toHaveBeenCalledWith(
          mockCtx,
          '/api/v2/models/people/search',
          expect.objectContaining({ IsCountOnly: true })
        );
        const response = JSON.parse(result.content[0].text!);
        expect(response.ok).toBe(true);
        expect(response.result.count).toBe(15);
      });

      it('should succeed for count with "person" (singular lowercase)', async () => {
        mockClient.post.mockResolvedValue(7);

        const result = await rockEntityTool.handle(
          { action: 'count', model: 'person' },
          null,
          mockCtx
        );

        expect(mockClient.post).toHaveBeenCalledWith(
          mockCtx,
          '/api/v2/models/people/search',
          expect.objectContaining({ IsCountOnly: true })
        );
        const response = JSON.parse(result.content[0].text!);
        expect(response.ok).toBe(true);
      });

      it('should succeed for count with "Group"', async () => {
        mockClient.post.mockResolvedValue(42);

        const result = await rockEntityTool.handle(
          { action: 'count', model: 'Group' },
          null,
          mockCtx
        );

        expect(mockClient.post).toHaveBeenCalledWith(
          mockCtx,
          '/api/v2/models/groups/search',
          expect.objectContaining({ IsCountOnly: true })
        );
        const response = JSON.parse(result.content[0].text!);
        expect(response.ok).toBe(true);
      });

      it('should reject count on genuinely disallowed model "UserLogin"', async () => {
        const result = await rockEntityTool.handle(
          { action: 'count', model: 'UserLogin' },
          null,
          mockCtx
        );

        expect(mockClient.post).not.toHaveBeenCalled();
        const response = JSON.parse(result.content[0].text!);
        expect(response.ok).toBe(false);
        expect(response.error?.code).toBe('MODEL_NOT_ALLOWED');
      });
    });
  });

  describe('searchByKey error includes discovery hint', () => {
    it('should include rock_lookup discovery hint in searchByKey error message', async () => {
      mockClient.post.mockRejectedValue(new Error('Rock API error (404): Not Found'));

      const result = await rockEntityTool.handle(
        { action: 'searchByKey', searchKey: 'UnknownKey' },
        null,
        mockCtx
      );

      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('SEARCH_BY_KEY_ERROR');
      expect(response.error?.message).toContain('rock_lookup');
    });

    it('should include availableSearchKeys when discoveryService is available', async () => {
      mockClient.post.mockRejectedValue(new Error('Rock API error (404): Not Found'));

      const mockDiscoveryService = {
        getMap: vi.fn().mockResolvedValue({
          entitySearches: [
            { idKey: 'ActiveMembers', name: 'Active Members' },
            { idKey: 'CoreLeaders', name: 'Core Leaders' },
          ],
        }),
      };

      const ctxWithDiscovery = {
        ...mockCtx,
        discoveryService: mockDiscoveryService,
      };

      const result = await rockEntityTool.handle(
        { action: 'searchByKey', searchKey: 'UnknownKey' },
        null,
        ctxWithDiscovery
      );

      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('SEARCH_BY_KEY_ERROR');
      expect(response.error?.availableSearchKeys).toBeDefined();
      expect(response.error?.availableSearchKeys).toHaveLength(2);
      expect(response.error?.availableSearchKeys[0].key).toBe('ActiveMembers');
      expect(response.error?.availableSearchKeys[1].key).toBe('CoreLeaders');
    });

    it('should not throw when discoveryService.getMap fails', async () => {
      mockClient.post.mockRejectedValue(new Error('Rock API error (401): Unauthorized'));

      const mockDiscoveryService = {
        getMap: vi.fn().mockRejectedValue(new Error('Discovery unavailable')),
      };

      const ctxWithDiscovery = {
        ...mockCtx,
        discoveryService: mockDiscoveryService,
      };

      const result = await rockEntityTool.handle(
        { action: 'searchByKey', searchKey: 'SomeKey' },
        null,
        ctxWithDiscovery
      );

      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('SEARCH_BY_KEY_ERROR');
      // No availableSearchKeys since discovery failed, but should not have thrown
      expect(response.error?.availableSearchKeys).toBeUndefined();
    });
  });
});
