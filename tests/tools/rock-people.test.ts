import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-ignore
import { rockPeopleTool } from '../../src/tools/rock-people.js';
// @ts-ignore
import { OAuthRockContext } from '../../src/http/oauth.js';
// @ts-ignore
import { clearDefinedValueCache } from '../../src/rock/defined-values.js';

describe('rock_people tool', () => {
  let mockClient: any;
  let mockCtx: any;
  let mockDiscoveryService: any;

  beforeEach(() => {
    // Clear DefinedValue cache before each test
    clearDefinedValueCache();

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

  // Tests for updateContactInfo with phone number handling
  it('updateContactInfo: dry-run should describe person and phone changes without mutation', async () => {
    mockCtx.mode = 'readwrite';
    mockCtx.scopes = new Set(['read', 'write']);

    mockClient.get.mockResolvedValue([
      { Id: 1, Value: 'Mobile', Guid: '407E7E45-7B2E-4FCD-9605-ECB1339F2453' },
    ]); // DefinedValue for Mobile

    const result = await rockPeopleTool.handle(
      {
        action: 'updateContactInfo',
        personId: 123,
        email: 'new@example.com',
        phone: '+1234567890',
        firstName: 'John',
        dryRun: true,
        commit: false,
        reason: 'test update',
      },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result.dryRun).toBe(true);
    expect(response.result.committed).toBe(false);
    expect(response.result.data).toBeDefined();
    expect(response.result.data.Email).toBe('new@example.com');
    expect(response.result.data.FirstName).toBe('John');
    // dry-run should NOT include MobilePhoneNumber in the person patch
    expect(response.result.data.MobilePhoneNumber).toBeUndefined();
    // But should describe the phone intent somewhere
    expect(response.result.phoneIntent).toBeDefined();
    expect(response.result.phoneIntent.number).toBe('+1234567890');

    // Verify no mutations occurred
    expect(mockClient.patch).not.toHaveBeenCalled();
    expect(mockClient.post).not.toHaveBeenCalled();
  });

  it('updateContactInfo: commit with no existing mobile number should POST PhoneNumber', async () => {
    mockCtx.mode = 'readwrite';
    mockCtx.scopes = new Set(['read', 'write']);

    const getCall = vi.fn();
    const patchCall = vi.fn();
    const postCall = vi.fn();

    // First get: DefinedTypes lookup for 'Phone Type'
    getCall.mockResolvedValueOnce([{ Id: 13 }]);
    // Second get: DefinedValues for that type (Mobile)
    getCall.mockResolvedValueOnce([
      { Id: 1, Value: 'Mobile', Guid: '407E7E45-7B2E-4FCD-9605-ECB1339F2453' },
    ]);
    // Second get: Check for existing PhoneNumber - none found
    getCall.mockResolvedValueOnce([]);

    // Patch Person: successful
    patchCall.mockResolvedValueOnce({ Id: 123, Email: 'new@example.com' });

    // Post PhoneNumber: create new
    postCall.mockResolvedValueOnce({ Id: 999, PersonId: 123, NumberTypeValueId: 1, Number: '+1234567890' });

    mockClient.get = getCall;
    mockClient.patch = patchCall;
    mockClient.post = postCall;

    const result = await rockPeopleTool.handle(
      {
        action: 'updateContactInfo',
        personId: 123,
        email: 'new@example.com',
        phone: '+1234567890',
        dryRun: false,
        commit: true,
        reason: 'test update',
      },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result.committed).toBe(true);

    // Verify Person was patched with Email but NOT MobilePhoneNumber
    expect(patchCall.mock.calls.length).toBeGreaterThan(0);
    const personPatchCall = patchCall.mock.calls.find((call: any) =>
      call[1]?.includes('/api/') && call[1]?.includes('people')
    );
    expect(personPatchCall).toBeDefined();
    expect(personPatchCall[2].Email).toBe('new@example.com');
    expect(personPatchCall[2].MobilePhoneNumber).toBeUndefined();

    // Verify PhoneNumber was created
    expect(postCall.mock.calls.length).toBeGreaterThan(0);
    const phoneNumberPostCall = postCall.mock.calls.find((call: any) =>
      call[1]?.includes('phonenumbers') || call[1]?.includes('PhoneNumbers')
    );
    expect(phoneNumberPostCall).toBeDefined();
    expect(phoneNumberPostCall[2].PersonId).toBe(123);
    expect(phoneNumberPostCall[2].Number).toBe('+1234567890');
  });

  it('updateContactInfo: commit with existing mobile number should PATCH it', async () => {
    mockCtx.mode = 'readwrite';
    mockCtx.scopes = new Set(['read', 'write']);

    const getCall = vi.fn();
    const patchCall = vi.fn();

    // First get: DefinedTypes lookup for 'Phone Type'
    getCall.mockResolvedValueOnce([{ Id: 13 }]);
    // Second get: DefinedValues for that type (Mobile)
    getCall.mockResolvedValueOnce([
      { Id: 1, Value: 'Mobile', Guid: '407E7E45-7B2E-4FCD-9605-ECB1339F2453' },
    ]);
    // Second get: Find existing PhoneNumber (for authorization determination)
    getCall.mockResolvedValueOnce([
      { Id: 888, PersonId: 123, NumberTypeValueId: 1, Number: '+1111111111' },
    ]);

    // Patch PhoneNumber: update existing
    patchCall.mockResolvedValueOnce({ Id: 888, PersonId: 123, NumberTypeValueId: 1, Number: '+9876543210' });

    mockClient.get = getCall;
    mockClient.patch = patchCall;

    const result = await rockPeopleTool.handle(
      {
        action: 'updateContactInfo',
        personId: 123,
        phone: '+9876543210',
        dryRun: false,
        commit: true,
        reason: 'test update',
      },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result.committed).toBe(true);

    // Verify PhoneNumber was patched (not created)
    const patchCalls = patchCall.mock.calls.filter((call: any) =>
      call[1]?.includes('phonenumbers') || call[1]?.includes('PhoneNumbers')
    );
    expect(patchCalls.length).toBeGreaterThan(0);
    const phoneNumberPatch = patchCalls[0];
    expect(phoneNumberPatch[2].Number).toBe('+9876543210');
  });

  it('updateContactInfo: authorization denied should not mutate', async () => {
    mockCtx.mode = 'readonly'; // read-only mode
    mockCtx.scopes = new Set(['read']);

    const result = await rockPeopleTool.handle(
      {
        action: 'updateContactInfo',
        personId: 123,
        email: 'new@example.com',
        dryRun: false,
        commit: true,
        reason: 'test update',
      },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('UNAUTHORIZED');
    expect(mockClient.patch).not.toHaveBeenCalled();
    expect(mockClient.get).not.toHaveBeenCalled();
  });

  it('updateContactInfo: should patch email/firstName/lastName on Person without phone', async () => {
    mockCtx.mode = 'readwrite';
    mockCtx.scopes = new Set(['read', 'write']);

    mockClient.patch.mockResolvedValue({ Id: 123, Email: 'new@example.com', FirstName: 'Jane' });

    const result = await rockPeopleTool.handle(
      {
        action: 'updateContactInfo',
        personId: 123,
        email: 'new@example.com',
        firstName: 'Jane',
        dryRun: false,
        commit: true,
        reason: 'test update',
      },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(response.result.committed).toBe(true);

    // Verify Person was patched
    const patchCall = mockClient.patch.mock.calls[0];
    expect(patchCall[2].Email).toBe('new@example.com');
    expect(patchCall[2].FirstName).toBe('Jane');
    expect(patchCall[2].MobilePhoneNumber).toBeUndefined();
    // No phone-related gets should occur
    expect(mockClient.get).not.toHaveBeenCalled();
  });

  it('updateContactInfo with phone: should deny phonenumbers write and not mutate when authorization fails', async () => {
    mockCtx.mode = 'readwrite';
    mockCtx.scopes = new Set(['read', 'write']);

    // Mock the phonenumbers authorization to fail by removing it from the allowlist context
    // We'll simulate this by using a custom mock context that denies phone writes
    const restrictedCtx = {
      ...mockCtx,
      // Override with a context that denies phone writes by being readonly for that operation
    } as unknown as OAuthRockContext;
    restrictedCtx.mode = 'readwrite';
    restrictedCtx.scopes = new Set(['read']); // Only read scope - no write

    mockClient.get.mockResolvedValue([
      { Id: 1, Value: 'Mobile', Guid: '407E7E45-7B2E-4FCD-9605-ECB1339F2453' },
    ]);

    const result = await rockPeopleTool.handle(
      {
        action: 'updateContactInfo',
        personId: 123,
        phone: '+1234567890',
        dryRun: false,
        commit: true,
        reason: 'test update',
      },
      null,
      restrictedCtx
    );

    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('UNAUTHORIZED');

    // Verify NO mutations occurred
    expect(mockClient.patch).not.toHaveBeenCalled();
    expect(mockClient.post).not.toHaveBeenCalled();
  });

  it('updateContactInfo: partial failure (Person succeeds, PhoneNumber fails) should return partial response', async () => {
    mockCtx.mode = 'readwrite';
    mockCtx.scopes = new Set(['read', 'write']);

    const getCall = vi.fn();
    const patchCall = vi.fn();
    const postCall = vi.fn();

    // First get: DefinedTypes lookup for 'Phone Type'
    getCall.mockResolvedValueOnce([{ Id: 13 }]);
    // Second get: DefinedValues for that type (Mobile)
    getCall.mockResolvedValueOnce([
      { Id: 1, Value: 'Mobile', Guid: '407E7E45-7B2E-4FCD-9605-ECB1339F2453' },
    ]);
    // Second get: Check for existing PhoneNumber - none found (so it will POST)
    getCall.mockResolvedValueOnce([]);

    // Patch Person: successful
    patchCall.mockResolvedValueOnce({ Id: 123, Email: 'new@example.com' });

    // Post PhoneNumber: both v2 and v1 attempts fail
    postCall.mockRejectedValueOnce(new Error('PhoneNumber creation failed - v2 API error'));
    postCall.mockRejectedValueOnce(new Error('PhoneNumber creation failed - v1 API error'));

    mockClient.get = getCall;
    mockClient.patch = patchCall;
    mockClient.post = postCall;

    const result = await rockPeopleTool.handle(
      {
        action: 'updateContactInfo',
        personId: 123,
        email: 'new@example.com',
        phone: '+1234567890',
        dryRun: false,
        commit: true,
        reason: 'test partial failure',
      },
      null,
      mockCtx
    );

    const response = JSON.parse(result.content[0].text!);

    // Assert partial failure response shape
    expect(response.ok).toBe(true);
    expect(response.result.partial).toBe(true);
    expect(response.result.committed).toBe(false);

    // Assert person mutation succeeded and is in results
    expect(response.result.results).toBeDefined();
    expect(response.result.results.person).toBeDefined();
    expect(response.result.results.person.Email).toBe('new@example.com');

    // Assert phone error is surfaced in errors
    expect(response.result.errors).toBeDefined();
    expect(response.result.errors.phone).toBeDefined();
    expect(response.result.errors.phone).toContain('PhoneNumber creation failed');
  });

  describe('filter action', () => {
    function mockFilterPost(total: number, rows: any[]) {
      mockClient.post.mockImplementation(async (_ctx: any, _path: string, body: any) => {
        if (body && body.IsCountOnly) return total;
        return rows;
      });
    }

    const sampleRows = [
      {
        Id: 1, Guid: 'g-1', NickName: 'Ana', LastName: 'Cruz',
        PrimaryCampusId: 1, ConnectionStatusValue: 'Member', Email: 'ana@example.com',
      },
    ];

    it('resolves campusName via discovery and returns the true total with privacy-safe rows', async () => {
      mockFilterPost(450, sampleRows);

      const result = await rockPeopleTool.handle(
        { action: 'filter', campusName: 'main campus' },
        null,
        mockCtx
      );
      const response = JSON.parse(result.content[0].text!);

      expect(response.ok).toBe(true);
      expect(response.result.total).toBe(450);
      expect(response.result.campus).toEqual({ id: 1, name: 'Main Campus' });
      expect(response.result.results[0].name).toBe('Ana Cruz');
      expect(response.result.results[0].email).toBeUndefined();

      // Where clause filters on the resolved campus id
      const searchCall = mockClient.post.mock.calls.find((c: any[]) => !c[2]?.IsCountOnly);
      expect(searchCall[2].Where).toContain('PrimaryCampusId == 1');
    });

    it('supports countOnly without fetching rows', async () => {
      mockFilterPost(450, sampleRows);

      const result = await rockPeopleTool.handle(
        { action: 'filter', campusId: 1, countOnly: true },
        null,
        mockCtx
      );
      const response = JSON.parse(result.content[0].text!);

      expect(response.ok).toBe(true);
      expect(response.result.total).toBe(450);
      expect(response.result.results).toBeUndefined();
      // Only the count query was issued
      expect(mockClient.post.mock.calls.every((c: any[]) => c[2]?.IsCountOnly)).toBe(true);
    });

    it('passes offset and limit through for real pagination', async () => {
      mockFilterPost(450, sampleRows);

      const result = await rockPeopleTool.handle(
        { action: 'filter', campusId: 1, offset: 200, limit: 100 },
        null,
        mockCtx
      );
      const response = JSON.parse(result.content[0].text!);

      expect(response.ok).toBe(true);
      expect(response.result.offset).toBe(200);
      const searchCall = mockClient.post.mock.calls.find((c: any[]) => !c[2]?.IsCountOnly);
      expect(searchCall[2].Offset).toBe(200);
      expect(searchCall[2].Limit).toBe(100);
    });

    it('returns a helpful error listing campuses when campusName cannot be resolved', async () => {
      const result = await rockPeopleTool.handle(
        { action: 'filter', campusName: 'Atlantis' },
        null,
        mockCtx
      );
      const response = JSON.parse(result.content[0].text!);

      expect(response.ok).toBe(false);
      expect(response.error.code).toBe('CAMPUS_NOT_FOUND');
      expect(response.error.message).toContain('Main Campus');
    });

    it('requires at least one filter criterion', async () => {
      const result = await rockPeopleTool.handle(
        { action: 'filter' },
        null,
        mockCtx
      );
      const response = JSON.parse(result.content[0].text!);

      expect(response.ok).toBe(false);
      expect(response.error.code).toBe('FILTER_REQUIRED');
    });

    it('accepts a numeric connectionStatus DefinedValue ID without a lookup', async () => {
      mockFilterPost(15, sampleRows);

      const result = await rockPeopleTool.handle(
        { action: 'filter', campusId: 2, connectionStatus: '99', countOnly: true },
        null,
        mockCtx
      );
      const response = JSON.parse(result.content[0].text!);

      expect(response.ok).toBe(true);
      expect(response.result.total).toBe(15);
      const call = mockClient.post.mock.calls[0];
      expect(call[2].Where).toContain('PrimaryCampusId == 2');
      expect(call[2].Where).toContain('ConnectionStatusValueId == 99');
      // No DefinedValue lookup needed for numeric IDs
      expect(mockClient.get).not.toHaveBeenCalled();
    });

    it('resolves a connectionStatus name to its DefinedValue ID', async () => {
      mockClient.get
        .mockResolvedValueOnce([{ Id: 4 }]) // DefinedTypes lookup
        .mockResolvedValueOnce([{ Id: 77, Value: 'Leader' }]);
      mockFilterPost(1, [{ Id: 200, Guid: 'guid-200', NickName: 'Tom', LastName: 'Jones', ConnectionStatusValueId: 77 }]);

      const result = await rockPeopleTool.handle(
        { action: 'filter', connectionStatus: 'leader' },
        null,
        mockCtx
      );
      const response = JSON.parse(result.content[0].text!);

      expect(response.ok).toBe(true);
      expect(response.result.results).toHaveLength(1);
      expect(mockClient.get).toHaveBeenCalledWith(
        mockCtx,
        expect.stringContaining('Connection Status')
      );
      const searchCall = mockClient.post.mock.calls.find((c: any[]) => !c[2]?.IsCountOnly);
      expect(searchCall[2].Where).toContain('ConnectionStatusValueId == 77');
    });

    it('lists available statuses when a connectionStatus name cannot be resolved', async () => {
      mockClient.get
        .mockResolvedValueOnce([{ Id: 4 }]) // DefinedTypes lookup
        .mockResolvedValueOnce([{ Id: 1, Value: 'Member' }, { Id: 2, Value: 'Visitor' }]);

      const result = await rockPeopleTool.handle(
        { action: 'filter', connectionStatus: 'NonExistentStatus' },
        null,
        mockCtx
      );
      const response = JSON.parse(result.content[0].text!);

      expect(response.ok).toBe(false);
      expect(response.error.code).toBe('CONNECTION_STATUS_NOT_FOUND');
      expect(response.error.message).toContain('NonExistentStatus');
      expect(response.error.message).toContain('Member');
    });

    it('applies isActive via the resolved Active RecordStatus DefinedValue', async () => {
      mockClient.get
        .mockResolvedValueOnce([{ Id: 12 }]) // DefinedTypes lookup
        .mockResolvedValueOnce([{ Id: 3, Value: 'Active' }]);
      mockFilterPost(10, sampleRows);

      const result = await rockPeopleTool.handle(
        { action: 'filter', campusId: 1, isActive: true },
        null,
        mockCtx
      );
      const response = JSON.parse(result.content[0].text!);

      expect(response.ok).toBe(true);
      const searchCall = mockClient.post.mock.calls.find((c: any[]) => !c[2]?.IsCountOnly);
      expect(searchCall[2].Where).toContain('RecordStatusValueId == 3');
    });

    it('errors instead of counting everyone when isActive is the only filter and cannot be resolved', async () => {
      mockClient.get.mockResolvedValue([]); // RecordStatus lookups all empty

      const result = await rockPeopleTool.handle(
        { action: 'filter', isActive: true },
        null,
        mockCtx
      );
      const response = JSON.parse(result.content[0].text!);

      expect(response.ok).toBe(false);
      expect(response.error.code).toBe('FILTER_UNRESOLVED');
      expect(response.error.message).toContain('isActive');
    });

    it('falls back to v1 OData when v2 throws', async () => {
      mockClient.post.mockRejectedValue(new Error('v2 unavailable'));
      mockClient.get.mockResolvedValue([
        { Id: 400, Guid: 'guid-400', NickName: 'Chris', LastName: 'Martin', PrimaryCampusId: 3 },
      ]);

      const result = await rockPeopleTool.handle(
        { action: 'filter', campusId: 3 },
        null,
        mockCtx
      );
      const response = JSON.parse(result.content[0].text!);

      expect(response.ok).toBe(true);
      expect(response.result.results).toHaveLength(1);
      expect(response.result.results[0].id).toBe(400);
      expect(response.warning).toMatch(/v1/i);
      expect(mockClient.get).toHaveBeenCalledWith(
        mockCtx,
        expect.stringContaining('PrimaryCampusId')
      );
    });

    it('resolves ConnectionStatusValueId to name in v1 fallback rows', async () => {
      mockClient.post.mockRejectedValue(new Error('v2 unavailable'));
      // GET calls happen in order:
      // 1. Count query (returns array, .length gives count)
      // 2. Rows query (returns actual rows)
      // 3. DefinedValues query (returns the map)
      mockClient.get
        .mockResolvedValueOnce([
          {
            Id: 400,
            Guid: 'guid-400',
            NickName: 'Chris',
            LastName: 'Martin',
            PrimaryCampusId: 3,
            ConnectionStatusValueId: 67,
          },
        ]) // Count query (OData), returns 1 row
        .mockResolvedValueOnce([
          {
            Id: 400,
            Guid: 'guid-400',
            NickName: 'Chris',
            LastName: 'Martin',
            PrimaryCampusId: 3,
            ConnectionStatusValueId: 67,
            // Note: ConnectionStatusValue is null on v1 fallback
          },
        ]) // Rows query (OData)
        .mockResolvedValueOnce([{ Id: 4 }]) // DefinedTypes lookup
        .mockResolvedValueOnce([
          { Id: 67, Value: 'Member' },
          { Id: 68, Value: 'Visitor' },
        ]); // DefinedValues query

      const result = await rockPeopleTool.handle(
        { action: 'filter', campusId: 3 },
        null,
        mockCtx
      );
      const response = JSON.parse(result.content[0].text!);

      expect(response.ok).toBe(true);
      expect(response.result.results).toHaveLength(1);
      expect(response.result.results[0].connectionStatus).toBe('Member');
    });

    it('accepts lenient person references (bare string, numeric, stringified JSON)', async () => {
      // Bare name string is treated as { search }
      mockClient.post.mockResolvedValue([{ Id: 9, Guid: 'g-9', FirstName: 'Alex', LastName: 'Santos' }]);
      let result = await rockPeopleTool.handle(
        { action: 'profile', person: 'Alex Santos' },
        null,
        mockCtx
      );
      let response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(true);
      expect(response.result.person.name).toBe('Alex Santos');

      // Numeric string is treated as { id }
      mockClient.get.mockResolvedValue({ Id: 9, Guid: 'g-9', FirstName: 'Alex', LastName: 'Santos' });
      result = await rockPeopleTool.handle(
        { action: 'profile', person: '9' },
        null,
        mockCtx
      );
      response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(true);

      // JSON-stringified object is parsed (common LLM-client failure mode)
      result = await rockPeopleTool.handle(
        { action: 'profile', person: '{"search": "Alex Santos"}' },
        null,
        mockCtx
      );
      response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(true);
      expect(response.result.person.name).toBe('Alex Santos');
    });

    it('is available in readonly mode', async () => {
      const schema = rockPeopleTool.schemaForMode('readonly', new Set(['read']));
      expect(schema).not.toBeNull();

      mockFilterPost(5, sampleRows);

      const result = await rockPeopleTool.handle(
        { action: 'filter', campusId: 1, countOnly: true },
        null,
        mockCtx // mockCtx is readonly mode
      );
      const response = JSON.parse(result.content[0].text!);

      expect(response.ok).toBe(true);
      expect(typeof response.result.total).toBe('number');
    });
  });
});
