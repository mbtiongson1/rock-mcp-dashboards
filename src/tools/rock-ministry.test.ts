import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-ignore
import { rockMinistryTool } from './rock-ministry.js';
// @ts-ignore
import { OAuthRockContext } from '../http/oauth.js';
import { z } from 'zod';

describe('rock_ministry tool', () => {
  let mockClient: any;
  let mockDiscoveryService: any;
  let mockCtx: any;
  let mockDatasetStore: any;

  beforeEach(() => {
    mockClient = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    };

    mockDiscoveryService = {
      getMap: vi.fn().mockResolvedValue({
        groupTypes: {
          connectGroups: [{ id: 10, name: 'Connect Groups', confidence: 1.0 }],
          ministryTeams: [{ id: 11, name: 'Ministry Teams', confidence: 1.0 }],
        },
        campuses: [
          { id: 1, name: 'Main Campus', confidence: 1.0 },
        ],
      }),
    };

    mockDatasetStore = {
      put: vi.fn().mockResolvedValue('cghealth_abc123'),
    };

    mockCtx = {
      mode: 'readonly',
      rockClient: mockClient,
      discoveryService: mockDiscoveryService,
      datasetStore: mockDatasetStore,
      oauth: { subject: 'test-user' },
      rockUser: { personId: 123 },
      request: { sessionId: 'session-123' },
    } as unknown as OAuthRockContext;
  });

  it('should handle groups action and return list of groups under group type', async () => {
    mockClient.post.mockResolvedValue([
      { Id: 50, Name: 'Young Adults Friday BGC', GroupTypeId: 10 },
    ]);

    const result = await rockMinistryTool.handle(
      { action: 'groups', kind: 'connectGroup' },
      null,
      mockCtx
    );

    expect(mockClient.post).toHaveBeenCalledWith(
      mockCtx,
      '/api/v2/models/groups/search',
      expect.objectContaining({ Where: 'GroupTypeId == 10 && IsActive == true' })
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result[0].name).toBe('Young Adults Friday BGC');
  });

  it('should handle groupMembers action and return members', async () => {
    mockClient.post.mockResolvedValue([
      {
        Id: 1001,
        Person: { FirstName: 'Alex', LastName: 'Santos' },
        GroupRole: { Name: 'Member' },
      },
    ]);

    const result = await rockMinistryTool.handle(
      { action: 'groupMembers', groupId: 50 },
      null,
      mockCtx
    );

    expect(mockClient.post).toHaveBeenCalledWith(
      mockCtx,
      '/api/v2/models/groupmembers/search',
      expect.objectContaining({ Where: 'GroupId == 50' })
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result[0].personName).toBe('Alex Santos');
  });

  it('should compute connectGroupHealth with real metrics from live groups', async () => {
    // Mock groups response
    mockClient.post.mockResolvedValueOnce([
      { Id: 50, Name: 'Young Adults', GroupTypeId: 10, IsActive: true },
      { Id: 51, Name: 'Teens', GroupTypeId: 10, IsActive: true },
      { Id: 52, Name: 'Kids', GroupTypeId: 10, IsActive: true },
    ]);

    // Mock group members for each group
    // Group 50: 5 members, 1 leader
    mockClient.post.mockResolvedValueOnce([
      { Id: 1001, PersonId: 101, GroupRole: { Name: 'Leader', IsLeader: true } },
      { Id: 1002, PersonId: 102, GroupRole: { Name: 'Member', IsLeader: false } },
      { Id: 1003, PersonId: 103, GroupRole: { Name: 'Member', IsLeader: false } },
      { Id: 1004, PersonId: 104, GroupRole: { Name: 'Member', IsLeader: false } },
      { Id: 1005, PersonId: 105, GroupRole: { Name: 'Member', IsLeader: false } },
    ]);

    // Group 51: 3 members, no leader
    mockClient.post.mockResolvedValueOnce([
      { Id: 2001, PersonId: 201, GroupRole: { Name: 'Member', IsLeader: false } },
      { Id: 2002, PersonId: 202, GroupRole: { Name: 'Member', IsLeader: false } },
      { Id: 2003, PersonId: 203, GroupRole: { Name: 'Member', IsLeader: false } },
    ]);

    // Group 52: 2 members, 1 leader
    mockClient.post.mockResolvedValueOnce([
      { Id: 3001, PersonId: 301, GroupRole: { Name: 'Leader', IsLeader: true } },
      { Id: 3002, PersonId: 302, GroupRole: { Name: 'Member', IsLeader: false } },
    ]);

    const result = await rockMinistryTool.handle(
      { action: 'connectGroupHealth' },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);

    const { summary } = response.result;
    expect(summary.groupCount).toBe(3);
    expect(summary.activeGroupCount).toBe(3);
    expect(summary.totalMembers).toBe(10); // 5 + 3 + 2
    expect(summary.averageMembersPerGroup).toBe(3); // 10 / 3 ≈ 3
    expect(summary.groupsWithoutLeaders).toBe(1); // Group 51
    expect(summary.truncated).toBe(false);

    // Verify dataset was stored
    expect(mockDatasetStore.put).toHaveBeenCalled();
    expect(response.result.datasetId).toBeDefined();
  });

  it('connectGroupHealth should filter by campus when provided', async () => {
    mockClient.post.mockResolvedValueOnce([
      { Id: 50, Name: 'Young Adults', GroupTypeId: 10, CampusId: 1 },
    ]);

    mockClient.post.mockResolvedValueOnce([
      { Id: 1001, PersonId: 101, GroupRole: { Name: 'Leader', IsLeader: true } },
    ]);

    await rockMinistryTool.handle(
      { action: 'connectGroupHealth', campus: 'Main Campus' },
      null,
      mockCtx
    );

    // Verify the WHERE clause includes CampusId filter
    const firstPostCall = mockClient.post.mock.calls[0];
    expect(firstPostCall[1]).toBe('/api/v2/models/groups/search');
    expect(firstPostCall[2].Where).toContain('CampusId == 1');
  });

  it('connectGroupHealth should return error if no connect group type discovered', async () => {
    mockDiscoveryService.getMap.mockResolvedValueOnce({
      groupTypes: {
        connectGroups: [],
        ministryTeams: [{ id: 11, name: 'Ministry Teams' }],
      },
      campuses: [],
    });

    const result = await rockMinistryTool.handle(
      { action: 'connectGroupHealth' },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('NO_GROUP_TYPE');
  });

  it('addOrUpdateGroupMember should return ROLE_UNRESOLVED when no roleId and role cannot be resolved', async () => {
    mockCtx.mode = 'readwrite';
    mockCtx.scopes = new Set(['read', 'write']);

    // Mock group fetch that has no GroupType
    mockClient.get.mockResolvedValueOnce({
      Id: 50,
      Name: 'Test Group',
      GroupTypeId: 10,
      // No GroupType property
    });

    // Mock GroupTypeRoles fetch that returns empty
    mockClient.get.mockResolvedValueOnce([]);

    const result = await rockMinistryTool.handle(
      {
        action: 'addOrUpdateGroupMember',
        groupId: 50,
        personId: 100,
        // roleId NOT provided
        status: 'Active',
        dryRun: false,
        commit: true,
        reason: 'test',
      },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('ROLE_UNRESOLVED');
    expect(response.error.message).toContain('pass roleId explicitly');
  });

  describe('numeric param string coercion (issue #15)', () => {
    it('groupMembers schema parses string groupId to a number', () => {
      const schema = rockMinistryTool.schemaForMode('readonly', new Set(['read']));
      expect(schema).not.toBeNull();
      const result = (schema as z.ZodTypeAny).safeParse({ action: 'groupMembers', groupId: '86' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.groupId).toBe(86);
        expect(typeof result.data.groupId).toBe('number');
      }
    });

    it('groups schema parses string limit to a number', () => {
      const schema = rockMinistryTool.schemaForMode('readonly', new Set(['read']));
      expect(schema).not.toBeNull();
      const result = (schema as z.ZodTypeAny).safeParse({ action: 'groups', kind: 'connectGroup', limit: '25' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(25);
      }
    });

    it('groups schema still rejects out-of-range string limit (0 fails .positive())', () => {
      const schema = rockMinistryTool.schemaForMode('readonly', new Set(['read']));
      expect(schema).not.toBeNull();
      const result = (schema as z.ZodTypeAny).safeParse({ action: 'groups', kind: 'connectGroup', limit: '0' });
      expect(result.success).toBe(false);
    });

    it('groupMembers schema still rejects non-numeric string for groupId', () => {
      const schema = rockMinistryTool.schemaForMode('readonly', new Set(['read']));
      expect(schema).not.toBeNull();
      const result = (schema as z.ZodTypeAny).safeParse({ action: 'groupMembers', groupId: 'notanumber' });
      expect(result.success).toBe(false);
    });
  });

  it('addAttendance should omit CampusId when group has no campus', async () => {
    mockCtx.mode = 'readwrite';
    mockCtx.scopes = new Set(['read', 'write']);

    // Mock PersonAlias
    mockClient.get.mockResolvedValueOnce([{ Id: 5000 }]);

    // Mock Group with no CampusId
    mockClient.get.mockResolvedValueOnce({
      Id: 50,
      Name: 'Test Group',
      // No CampusId
    });

    // Mock AttendanceOccurrence check (none exists)
    mockClient.get.mockResolvedValueOnce([]);

    // Mock AttendanceOccurrence creation
    mockClient.post.mockResolvedValueOnce(9000);

    // Mock Attendance check (none exists)
    mockClient.get.mockResolvedValueOnce([]);

    // Mock Attendance creation
    mockClient.post.mockResolvedValueOnce(1001);

    const result = await rockMinistryTool.handle(
      {
        action: 'addAttendance',
        groupId: 50,
        personId: 100,
        occurrenceDate: '2025-06-06',
        didAttend: true,
        dryRun: false,
        commit: true,
        reason: 'test',
      },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);

    // Verify the payload sent to POST does not include CampusId
    const postCall = mockClient.post.mock.calls.find((call: any) =>
      call[1]?.includes('attendances')
    );
    expect(postCall[2].CampusId).toBeUndefined();
    expect(postCall[2].OccurrenceId).toBeDefined();
  });

  describe('leaderCount action (issue #20)', () => {
    it('returns totalLeaders deduped across groups (one leader shared by two groups)', async () => {
      // First post: groups search returns 2 groups
      mockClient.post.mockResolvedValueOnce([
        { Id: 50, Name: 'Young Adults', GroupTypeId: 10, IsActive: true },
        { Id: 51, Name: 'Adults', GroupTypeId: 10, IsActive: true },
      ]);

      // Group 50 members: leader 101 + member 102
      mockClient.post.mockResolvedValueOnce([
        { Id: 1001, PersonId: 101, GroupRole: { Name: 'Leader', IsLeader: true } },
        { Id: 1002, PersonId: 102, GroupRole: { Name: 'Member', IsLeader: false } },
      ]);

      // Group 51 members: SAME leader 101 (shared) + a second leader 201
      mockClient.post.mockResolvedValueOnce([
        { Id: 2001, PersonId: 101, GroupRole: { Name: 'Leader', IsLeader: true } },
        { Id: 2002, PersonId: 201, GroupRole: { Name: 'Leader', IsLeader: true } },
      ]);

      const result = await rockMinistryTool.handle(
        { action: 'leaderCount' },
        null,
        mockCtx
      );

      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(true);
      // Distinct leaders: 101 and 201 => 2, not 3 (sum)
      expect(response.result.totalLeaders).toBe(2);
      expect(response.result.groupsAnalyzed).toBe(2);
      expect(response.result.truncated).toBe(false);
      expect(response.result.campus).toBe('All');
    });

    it('passing groupTypeId bypasses discovery for type resolution', async () => {
      // groups search
      mockClient.post.mockResolvedValueOnce([
        { Id: 60, Name: 'Group A', GroupTypeId: 99, IsActive: true },
      ]);
      // members for group 60
      mockClient.post.mockResolvedValueOnce([
        { Id: 6001, PersonId: 601, GroupRole: { Name: 'Leader', IsLeader: true } },
      ]);

      const result = await rockMinistryTool.handle(
        { action: 'leaderCount', groupTypeId: 99 },
        null,
        mockCtx
      );

      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(true);
      // Discovery must NOT have been consulted for type resolution
      expect(mockDiscoveryService.getMap).not.toHaveBeenCalled();
      // The groups search WHERE clause must use the provided groupTypeId
      const groupsCall = mockClient.post.mock.calls[0];
      expect(groupsCall[1]).toBe('/api/v2/models/groups/search');
      expect(groupsCall[2].Where).toContain('GroupTypeId == 99');
      expect(response.result.totalLeaders).toBe(1);
    });

    it('sets truncated flag when group count exceeds the cap', async () => {
      // Build 101 groups (cap is 100; over-fetch detects truncation)
      const manyGroups = Array.from({ length: 101 }, (_, i) => ({
        Id: 1000 + i,
        Name: `Group ${i}`,
        GroupTypeId: 10,
        IsActive: true,
      }));
      mockClient.post.mockResolvedValueOnce(manyGroups);
      // Every subsequent member fetch returns the same single leader (deduped to 1)
      mockClient.post.mockResolvedValue([
        { Id: 9001, PersonId: 999, GroupRole: { Name: 'Leader', IsLeader: true } },
      ]);

      const result = await rockMinistryTool.handle(
        { action: 'leaderCount', groupTypeId: 10 },
        null,
        mockCtx
      );

      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(true);
      expect(response.result.truncated).toBe(true);
      // Only the first 100 groups are analyzed (bounded)
      expect(response.result.groupsAnalyzed).toBe(100);
      // All groups share the same single distinct leader
      expect(response.result.totalLeaders).toBe(1);
    });
  });
});
