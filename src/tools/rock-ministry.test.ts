import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-ignore
import { rockMinistryTool } from './rock-ministry.js';
// @ts-ignore
import { OAuthRockContext } from '../http/oauth.js';

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

  it('connectGroupHealth should bypass discovery when groupTypeId is provided', async () => {
    // Mock groups and members for the overridden group type 99
    mockClient.post.mockResolvedValueOnce([
      { Id: 60, Name: 'Manila Connect Group', GroupTypeId: 99, IsActive: true },
    ]);
    mockClient.post.mockResolvedValueOnce([
      { Id: 5001, PersonId: 501, GroupRole: { Name: 'Leader', IsLeader: true } },
      { Id: 5002, PersonId: 502, GroupRole: { Name: 'Member', IsLeader: false } },
    ]);

    const result = await rockMinistryTool.handle(
      { action: 'connectGroupHealth', groupTypeId: 99 },
      null,
      mockCtx
    );

    // Discovery service should NOT have been called since groupTypeId was pinned
    expect(mockDiscoveryService.getMap).not.toHaveBeenCalled();

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);

    // The WHERE clause should use the pinned group type id (99), not the discovered one (10)
    const firstPostCall = mockClient.post.mock.calls[0];
    expect(firstPostCall[2].Where).toContain('GroupTypeId == 99');

    // discovery should reflect the override source, not a discovered name/confidence
    expect(response.result.discovery.connectGroupType.source).toBe('override');
    expect(response.result.discovery.connectGroupType.id).toBe(99);
    // No low-confidence warning should be present
    expect(response.result.discovery.warning).toBeUndefined();
  });

  it('connectGroupHealth should surface a low-confidence warning when confidence < 0.7', async () => {
    // Set up a discovery map with a low-confidence type
    mockDiscoveryService.getMap.mockResolvedValueOnce({
      groupTypes: {
        connectGroups: [{ id: 10, name: 'Connect Group Section', confidence: 0.35 }],
        ministryTeams: [],
      },
      campuses: [],
    });

    mockClient.post.mockResolvedValueOnce([
      { Id: 70, Name: 'Test Group', GroupTypeId: 10, IsActive: true },
    ]);
    mockClient.post.mockResolvedValueOnce([
      { Id: 6001, PersonId: 601, GroupRole: { Name: 'Member', IsLeader: false } },
    ]);

    const result = await rockMinistryTool.handle(
      { action: 'connectGroupHealth' },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result.discovery.connectGroupType.confidence).toBe(0.35);
    // Warning should be present
    expect(typeof response.result.discovery.warning).toBe('string');
    expect(response.result.discovery.warning).toContain('low confidence');
    expect(response.result.discovery.warning).toContain('groupTypeId');
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
});
