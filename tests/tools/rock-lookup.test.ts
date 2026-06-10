import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-ignore
import { rockLookupTool } from '../../src/tools/rock-lookup.js';
// @ts-ignore
import { OAuthRockContext } from '../../src/http/oauth.js';
// @ts-ignore
import { DiscoveryService } from '../../src/discovery/discovery-service.js';

describe('rock_lookup tool', () => {
  let mockDiscoveryService: any;
  let mockRockClient: any;
  let mockCtx: any;

  beforeEach(() => {
    mockDiscoveryService = {
      getMap: vi.fn().mockResolvedValue({
        campuses: [{ name: 'Manila', confidence: 1.0, signals: [] }],
        groupTypes: {
          connectGroups: [
            { kind: 'groupType', id: 1, guid: 'guid-1', name: 'Connect Groups', confidence: 0.6, signals: ['test'] },
          ],
          ministryTeams: [
            { kind: 'groupType', id: 2, guid: 'guid-2', name: 'Ministry Teams', confidence: 0.6, signals: ['test'] },
          ],
          other: [
            { kind: 'groupType', id: 3, guid: 'guid-3', name: 'Other Groups', confidence: 0.1, signals: ['default'] },
          ],
        },
        reports: [
          { kind: 'report', id: 101, guid: 'report-1', name: 'Attendance Report', confidence: 0.9, signals: ['discovered report'] },
          { kind: 'report', id: 102, guid: 'report-2', name: 'Giving Report', confidence: 0.9, signals: ['discovered report'] },
        ],
        entitySearches: [
          { kind: 'entitySearch', id: 201, guid: 'search-1', idKey: 'key1', name: 'Member Search', confidence: 0.9, signals: ['discovered entity search'] },
        ],
        workflows: [
          { kind: 'workflowType', id: 301, guid: 'workflow-1', name: 'Visitor Check-in Workflow', confidence: 0.9, signals: ['discovered workflow type'] },
        ],
        connectionTypes: [
          { kind: 'connectionType', id: 401, guid: 'conn-1', name: 'Child Of', confidence: 0.9, signals: ['discovered connection type'] },
        ],
        attributes: {
          personLifecycle: [
            { kind: 'attribute.person', id: 501, guid: 'attr-1', name: 'Lifecycle Stage', confidence: 0.8, signals: ['lifecycle'] },
          ],
          personAgeGroup: [
            { kind: 'attribute.person', id: 502, guid: 'attr-2', name: 'Age Group', confidence: 0.85, signals: ['age group'] },
          ],
          groupAgeGroup: [
            { kind: 'attribute.group', id: 503, guid: 'attr-3', name: 'Group Age Group', confidence: 0.85, signals: ['age group'] },
          ],
          fluroId: [
            { kind: 'attribute.external', id: 504, guid: 'attr-4', name: 'Fluro ID', confidence: 0.8, signals: ['fluro'] },
          ],
        },
      }),
      refresh: vi.fn(),
    };

    mockRockClient = {
      post: vi.fn(),
      get: vi.fn(),
    };

    mockCtx = {
      mode: 'readonly',
      discoveryService: mockDiscoveryService,
      rockClient: mockRockClient,
    } as unknown as OAuthRockContext;
  });

  it('should handle discovery action and return map', async () => {
    const result = await rockLookupTool.handle({ action: 'discovery' }, null, mockCtx);
    expect(result.content[0].type).toBe('text');
    const response = JSON.parse(result.content[0].text!);
    expect(response.result.campuses[0].name).toBe('Manila');
    expect(mockDiscoveryService.getMap).toHaveBeenCalled();
  });

  it('should handle refreshDiscovery action', async () => {
    const result = await rockLookupTool.handle({ action: 'refreshDiscovery', reason: 'manual refresh' }, null, mockCtx);
    expect(result.content[0].type).toBe('text');
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(mockDiscoveryService.refresh).toHaveBeenCalled();
  });

  describe('quickSearch action', () => {
    it('should search person by default when no kinds specified', async () => {
      mockRockClient.post.mockResolvedValue([
        { Id: 1, Guid: 'person-1', NickName: 'John', LastName: 'Doe' },
      ]);

      const result = await rockLookupTool.handle(
        { action: 'quickSearch', query: 'john', limit: 10 },
        null,
        mockCtx
      );
      expect(result.content[0].type).toBe('text');
      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(true);
      expect(response.result.length).toBe(1);
      expect(response.result[0].kind).toBe('person');
      expect(response.result[0].name).toBe('John Doe');
      expect(mockRockClient.post).toHaveBeenCalledWith(
        mockCtx,
        '/api/v2/models/people/search',
        expect.objectContaining({ Where: expect.stringContaining('Contains') })
      );
    });

    it('should search groupType and filter by query', async () => {
      mockRockClient.post.mockResolvedValue([]);

      const result = await rockLookupTool.handle(
        { action: 'quickSearch', query: 'connect', kinds: ['groupType'], limit: 10 },
        null,
        mockCtx
      );
      expect(result.content[0].type).toBe('text');
      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(true);
      // Should match 'Connect Groups' but not others
      expect(response.result.length).toBe(1);
      expect(response.result[0].kind).toBe('groupType');
      expect(response.result[0].name).toBe('Connect Groups');
      expect(response.result[0].confidence).toBe(0.6);
      expect(response.result[0].signals).toEqual(['test']);
    });

    it('should search report and filter by query', async () => {
      mockRockClient.post.mockResolvedValue([]);

      const result = await rockLookupTool.handle(
        { action: 'quickSearch', query: 'attendance', kinds: ['report'], limit: 10 },
        null,
        mockCtx
      );
      expect(result.content[0].type).toBe('text');
      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(true);
      expect(response.result.length).toBe(1);
      expect(response.result[0].kind).toBe('report');
      expect(response.result[0].name).toBe('Attendance Report');
    });

    it('should search entitySearch and filter by query', async () => {
      mockRockClient.post.mockResolvedValue([]);

      const result = await rockLookupTool.handle(
        { action: 'quickSearch', query: 'member', kinds: ['entitySearch'], limit: 10 },
        null,
        mockCtx
      );
      expect(result.content[0].type).toBe('text');
      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(true);
      expect(response.result.length).toBe(1);
      expect(response.result[0].kind).toBe('entitySearch');
      expect(response.result[0].name).toBe('Member Search');
      expect(response.result[0].idKey).toBe('key1');
    });

    it('should search workflowType and filter by query', async () => {
      mockRockClient.post.mockResolvedValue([]);

      const result = await rockLookupTool.handle(
        { action: 'quickSearch', query: 'visitor', kinds: ['workflowType'], limit: 10 },
        null,
        mockCtx
      );
      expect(result.content[0].type).toBe('text');
      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(true);
      expect(response.result.length).toBe(1);
      expect(response.result[0].kind).toBe('workflowType');
      expect(response.result[0].name).toBe('Visitor Check-in Workflow');
    });

    it('should search connectionType and filter by query', async () => {
      mockRockClient.post.mockResolvedValue([]);

      const result = await rockLookupTool.handle(
        { action: 'quickSearch', query: 'child', kinds: ['connectionType'], limit: 10 },
        null,
        mockCtx
      );
      expect(result.content[0].type).toBe('text');
      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(true);
      expect(response.result.length).toBe(1);
      expect(response.result[0].kind).toBe('connectionType');
      expect(response.result[0].name).toBe('Child Of');
    });

    it('should search attribute (concatenating all attribute arrays) and filter by query', async () => {
      mockRockClient.post.mockResolvedValue([]);

      const result = await rockLookupTool.handle(
        { action: 'quickSearch', query: 'lifecycle', kinds: ['attribute'], limit: 10 },
        null,
        mockCtx
      );
      expect(result.content[0].type).toBe('text');
      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(true);
      expect(response.result.length).toBe(1);
      expect(response.result[0].kind).toBe('attribute');
      expect(response.result[0].name).toBe('Lifecycle Stage');
    });

    it('should search attribute for age group', async () => {
      mockRockClient.post.mockResolvedValue([]);

      const result = await rockLookupTool.handle(
        { action: 'quickSearch', query: 'age', kinds: ['attribute'], limit: 10 },
        null,
        mockCtx
      );
      expect(result.content[0].type).toBe('text');
      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(true);
      // Should match age group attributes (person and group age groups)
      // Results include person and group age groups that contain "age"
      const ageResults = response.result.filter((r: any) => r.name.includes('Age'));
      expect(ageResults.length).toBe(2);
    });

    it('should search definedValue with best-effort failure handling', async () => {
      mockRockClient.get.mockResolvedValue([
        { Id: 1, Guid: 'dv-1', Value: 'Active' },
      ]);

      const result = await rockLookupTool.handle(
        { action: 'quickSearch', query: 'active', kinds: ['definedValue'], limit: 10 },
        null,
        mockCtx
      );
      expect(result.content[0].type).toBe('text');
      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(true);
      expect(response.result.length).toBe(1);
      expect(response.result[0].kind).toBe('definedValue');
      expect(response.result[0].name).toBe('Active');
      expect(mockRockClient.get).toHaveBeenCalled();
    });

    it('should handle definedValue failure gracefully', async () => {
      mockRockClient.get.mockRejectedValue(new Error('API error'));
      mockRockClient.post.mockRejectedValue(new Error('API error'));

      const result = await rockLookupTool.handle(
        { action: 'quickSearch', query: 'test', kinds: ['definedValue'], limit: 10 },
        null,
        mockCtx
      );
      expect(result.content[0].type).toBe('text');
      const response = JSON.parse(result.content[0].text!);
      // Should not error; should just return empty result for definedValue
      expect(response.ok).toBe(true);
      expect(response.result.length).toBe(0);
    });

    it('should search multiple kinds and return both person and groupType', async () => {
      mockRockClient.post.mockResolvedValue([
        { Id: 1, Guid: 'person-1', NickName: 'John', LastName: 'Doe' },
      ]);

      const result = await rockLookupTool.handle(
        { action: 'quickSearch', query: 'connect', kinds: ['person', 'groupType'], limit: 10 },
        null,
        mockCtx
      );
      expect(result.content[0].type).toBe('text');
      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(true);
      // Should have person + groupType
      const kinds = response.result.map((r: any) => r.kind);
      expect(kinds).toContain('person');
      expect(kinds).toContain('groupType');
    });

    it('should respect limit parameter', async () => {
      mockRockClient.post.mockResolvedValue([
        { Id: 1, Guid: 'person-1', NickName: 'John', LastName: 'Doe' },
        { Id: 2, Guid: 'person-2', NickName: 'Jane', LastName: 'Smith' },
      ]);

      const result = await rockLookupTool.handle(
        { action: 'quickSearch', query: 'john', kinds: ['person'], limit: 1 },
        null,
        mockCtx
      );
      expect(result.content[0].type).toBe('text');
      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(true);
      expect(response.result.length).toBe(1);
    });

    it('should handle group search via Rock API', async () => {
      mockRockClient.post.mockResolvedValue([
        { Id: 10, Guid: 'group-1', Name: 'Small Group Alpha' },
      ]);

      const result = await rockLookupTool.handle(
        { action: 'quickSearch', query: 'alpha', kinds: ['group'], limit: 10 },
        null,
        mockCtx
      );
      expect(result.content[0].type).toBe('text');
      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(true);
      expect(response.result.length).toBe(1);
      expect(response.result[0].kind).toBe('group');
      expect(response.result[0].name).toBe('Small Group Alpha');
    });

    it('should fallback to v1 API when v2 person search fails', async () => {
      mockRockClient.post.mockRejectedValueOnce(new Error('Unauthorized'));
      mockRockClient.get.mockResolvedValueOnce([
        { Id: 3, Guid: 'person-3', NickName: 'Alex', LastName: 'Johnson' },
      ]);

      const result = await rockLookupTool.handle(
        { action: 'quickSearch', query: 'alex', kinds: ['person'], limit: 10 },
        null,
        mockCtx
      );
      expect(result.content[0].type).toBe('text');
      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(true);
      expect(response.result.length).toBe(1);
      expect(response.result[0].kind).toBe('person');
      expect(response.result[0].name).toBe('Alex Johnson');
      // Verify v1 API was called with correct OData filter
      expect(mockRockClient.get).toHaveBeenCalledWith(
        mockCtx,
        expect.stringContaining('/api/People?$filter=')
      );
    });

    it('should perform case-insensitive filtering', async () => {
      mockRockClient.post.mockResolvedValue([]);

      const result = await rockLookupTool.handle(
        { action: 'quickSearch', query: 'CONNECT', kinds: ['groupType'], limit: 10 },
        null,
        mockCtx
      );
      expect(result.content[0].type).toBe('text');
      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(true);
      expect(response.result.length).toBe(1);
      expect(response.result[0].name).toBe('Connect Groups');
    });
  });
});
