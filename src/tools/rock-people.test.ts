import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-ignore
import { rockPeopleTool } from './rock-people.js';
// @ts-ignore
import { OAuthRockContext } from '../http/oauth.js';

describe('rock_people tool', () => {
  let mockClient: any;
  let mockCtx: any;
  let mockDiscoveryService: any;

  beforeEach(() => {
    mockClient = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
    };

    mockDiscoveryService = {
      getMap: vi.fn().mockResolvedValue({
        campuses: [
          { id: 1, name: 'Main Campus' },
        ],
        groupTypes: {
          connectGroups: [{ id: 10, name: 'Connect Group' }],
          ministryTeams: [{ id: 11, name: 'Ministry Team' }],
          other: [],
        },
        attributes: {
          personLifecycle: [{ id: 50, name: 'Lifecycle' }],
          personAgeGroup: [],
          groupAgeGroup: [],
          fluroId: [],
        },
      }),
    };

    mockCtx = {
      mode: 'readonly',
      rockClient: mockClient,
      discoveryService: mockDiscoveryService,
      oauth: { subject: 'test-user' },
      rockUser: { personId: 123 },
      request: { sessionId: 'session-123' },
    } as unknown as OAuthRockContext;
  });

  it('should return a privacy-safe profile by default', async () => {
    mockClient.post.mockResolvedValue([
      {
        Id: 123,
        Guid: 'g-123',
        FirstName: 'Alex',
        LastName: 'Santos',
        Email: 'alex@example.com',
        PrimaryAliasId: 1234,
        PrimaryCampusId: 1,
      },
    ]);

    mockClient.get.mockResolvedValue({ Id: 1, Name: 'Main Campus' });

    const result = await rockPeopleTool.handle(
      { action: 'profile', person: { search: 'Alex Santos' } },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    if (!response.ok) {
      console.error('Error:', response.error);
    }
    expect(response.ok).toBe(true);
    expect(response.result.person.name).toBe('Alex Santos');
    // Ensure email is hidden/redacted by default
    expect(response.result.person.email).toBeUndefined();
  });

  it('should reveal email if explicitly requested and user has read/write scope', async () => {
    mockCtx.mode = 'readwrite';
    mockCtx.scopes = new Set(['read', 'write']);

    mockClient.post.mockResolvedValue([
      {
        Id: 123,
        Guid: 'g-123',
        FirstName: 'Alex',
        LastName: 'Santos',
        Email: 'alex@example.com',
        PrimaryAliasId: 1234,
      },
    ]);

    const result = await rockPeopleTool.handle(
      { action: 'profile', person: { search: 'Alex Santos' }, includeSensitive: true },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result.person.email).toBe('alex@example.com');
  });

  it('should classify groups into connect groups and ministry teams', async () => {
    mockClient.post.mockResolvedValue([
      {
        Id: 1,
        Group: { Id: 10, Name: 'Group 1', GroupTypeId: 10 },
        GroupRole: { Name: 'Leader' },
      },
      {
        Id: 2,
        Group: { Id: 11, Name: 'Group 2', GroupTypeId: 11 },
        GroupRole: { Name: 'Member' },
      },
    ]);

    const result = await rockPeopleTool.handle(
      { action: 'groups', person: { id: 123 } },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result.connectGroups).toHaveLength(1);
    expect(response.result.connectGroups[0].name).toBe('Group 1');
    expect(response.result.ministryTeams).toHaveLength(1);
    expect(response.result.ministryTeams[0].name).toBe('Group 2');
  });

  it('should fetch family members', async () => {
    // First call: get family group type
    mockClient.post.mockResolvedValueOnce([{ Id: 20, Name: 'Family' }]);
    // Second call: get person's family group membership
    mockClient.post.mockResolvedValueOnce([
      {
        Id: 100,
        Group: { Id: 200, GroupTypeId: 20 },
        GroupRole: { Name: 'Head of Household' },
      },
    ]);
    // Third call: get all members of that family group
    mockClient.post.mockResolvedValueOnce([
      {
        Id: 100,
        Person: { Id: 123, FirstName: 'Alex', LastName: 'Santos' },
        GroupRole: { Name: 'Head of Household' },
      },
      {
        Id: 101,
        Person: { Id: 124, FirstName: 'Sarah', LastName: 'Santos' },
        GroupRole: { Name: 'Spouse' },
      },
    ]);

    const result = await rockPeopleTool.handle(
      { action: 'family', person: { id: 123 } },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result.familyMembers).toHaveLength(2);
    expect(response.result.familyMembers[0].name).toBe('Alex Santos');
  });

  it('should get connection status', async () => {
    mockClient.get.mockResolvedValue({
      Id: 123,
      ConnectionStatusValue: 'Member',
    });

    mockClient.post.mockResolvedValue([]);

    const result = await rockPeopleTool.handle(
      { action: 'connectionStatus', person: { id: 123 } },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result.connectionStatus).toBe('Member');
  });

  it('should compute attendance summary with consistency', async () => {
    // Mock PersonAlias lookup
    mockClient.get
      .mockResolvedValueOnce([{ Id: 1000 }]) // PersonAlias
      .mockResolvedValueOnce([
        { Id: 1 },
        { Id: 2 },
        { Id: 3 },
        { Id: 4 },
        { Id: 5 },
        { Id: 6 },
        { Id: 7 },
      ]); // Attendances (7 out of 12 weeks = Regular)

    const result = await rockPeopleTool.handle(
      { action: 'attendanceSummary', person: { id: 123 }, windowWeeks: 12 },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result.windowWeeks).toBe(12);
    expect(response.result.attendedCount).toBe(7);
    expect(response.result.consistency).toBe('Regular');
  });

  it('should get serving summary (ministry teams only)', async () => {
    mockClient.post.mockResolvedValue([
      {
        Id: 1,
        Group: { Id: 11, Name: 'Worship Team', GroupTypeId: 11 },
        GroupRole: { Name: 'Band Member' },
      },
      {
        Id: 2,
        Group: { Id: 10, Name: 'Small Group', GroupTypeId: 10 },
        GroupRole: { Name: 'Member' },
      },
    ]);

    const result = await rockPeopleTool.handle(
      { action: 'servingSummary', person: { id: 123 } },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result.serving).toHaveLength(1);
    expect(response.result.serving[0].name).toBe('Worship Team');
  });

  it('should include groups in profile when requested', async () => {
    mockClient.post.mockResolvedValueOnce([
      {
        Id: 123,
        Guid: 'g-123',
        FirstName: 'Alex',
        LastName: 'Santos',
        PrimaryCampusId: 1,
      },
    ]);
    // Groups call
    mockClient.post.mockResolvedValueOnce([
      {
        Id: 1,
        Group: { Id: 10, Name: 'Group 1', GroupTypeId: 10 },
        GroupRole: { Name: 'Leader' },
      },
    ]);

    const result = await rockPeopleTool.handle(
      { action: 'profile', person: { search: 'Alex Santos' }, include: ['groups'] },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result.groups).toBeDefined();
    expect(response.result.groups.connectGroups).toHaveLength(1);
  });

  it('createFollowUpTask should require connectionOpportunityId', async () => {
    mockCtx.mode = 'readwrite';
    mockCtx.scopes = new Set(['read', 'write']);

    const result = await rockPeopleTool.handle(
      {
        action: 'createFollowUpTask',
        personId: 123,
        title: 'Follow up',
        dryRun: true,
        commit: false,
        reason: 'test',
        // connectionOpportunityId NOT provided
      },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('OPPORTUNITY_REQUIRED');
  });

  it('createFollowUpTask should succeed with explicit connectionOpportunityId', async () => {
    mockCtx.mode = 'readwrite';
    mockCtx.scopes = new Set(['read', 'write']);

    mockClient.post.mockResolvedValueOnce([
      { Id: 123, FirstName: 'Alex', LastName: 'Santos' },
    ]);
    mockClient.get.mockResolvedValueOnce([{ Id: 5000 }]); // PersonAlias
    mockClient.post.mockResolvedValueOnce({ Id: 1001 }); // ConnectionRequest created

    const result = await rockPeopleTool.handle(
      {
        action: 'createFollowUpTask',
        personId: 123,
        title: 'Follow up conversation',
        description: 'Discuss participation',
        connectionOpportunityId: 42, // Explicitly provided
        dryRun: false,
        commit: true,
        reason: 'follow-up workflow',
      },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result.committed).toBe(true);

    // Verify ConnectionOpportunityId was passed (not hardcoded 1)
    const postCall = mockClient.post.mock.calls.find((call: any) =>
      call[1]?.includes('connectionrequests')
    );
    expect(postCall[2].ConnectionOpportunityId).toBe(42);

    // Verify ConnectionStatusId was NOT hardcoded in payload
    expect(postCall[2].ConnectionStatusId).toBeUndefined();
  });

  // Tests for patchAttributes v2/v1 fallback
  it('patchAttributes: should require write authorization', async () => {
    // Readonly mode - should deny
    const result = await rockPeopleTool.handle(
      {
        action: 'patchAttributes',
        personId: 123,
        attributes: { customAttr: 'value' },
        dryRun: true,
        commit: false,
        reason: 'test',
      },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('UNAUTHORIZED');
  });

  it('patchAttributes: should succeed on v2 without attempting v1 fallback', async () => {
    mockCtx.mode = 'readwrite';
    mockCtx.scopes = new Set(['read', 'write']);

    mockClient.patch.mockResolvedValue({ success: true });

    const result = await rockPeopleTool.handle(
      {
        action: 'patchAttributes',
        personId: 123,
        attributes: { customAttr: 'newValue' },
        dryRun: false,
        commit: true,
        reason: 'test update',
      },
      null,
      mockCtx
    );

    expect(mockClient.patch).toHaveBeenCalledWith(
      mockCtx,
      '/api/v2/models/people/123/attributevalues',
      { customAttr: 'newValue' }
    );
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result.committed).toBe(true);
  });

  it('patchAttributes: should return clear error when v2 fails, noting v2 requirement', async () => {
    mockCtx.mode = 'readwrite';
    mockCtx.scopes = new Set(['read', 'write']);

    mockClient.patch.mockRejectedValue(new Error('401 Unauthorized - v2 access required'));

    const result = await rockPeopleTool.handle(
      {
        action: 'patchAttributes',
        personId: 123,
        attributes: { customAttr: 'newValue' },
        dryRun: false,
        commit: true,
        reason: 'test update',
      },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('PATCH_ATTRIBUTES_ERROR');
    expect(response.error?.message).toContain('v2');
  });
});
