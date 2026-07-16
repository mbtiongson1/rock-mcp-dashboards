import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rockRosterTool } from '../../src/tools/rock-roster.js';
import { OAuthRockContext } from '../../src/http/oauth.js';
import { extractActionNames } from '../../src/tools/schema-utils.js';
import { z } from 'zod';

describe('rock_roster tool', () => {
  let mockClient: any;
  let mockCtx: any;

  beforeEach(() => {
    mockClient = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    };

    mockCtx = {
      mode: 'readwrite',
      rockClient: mockClient,
      oauth: { subject: 'test-user' },
      rockUser: { personId: 123, isRsrAdmin: true },
      scopes: new Set(['read', 'write']),
      request: { sessionId: 'session-123' },
    } as unknown as OAuthRockContext;
  });

  describe('schema advertisement (empty-union guard)', () => {
    it('readwrite + write scope advertises all 4 actions', () => {
      const schema = rockRosterTool.schemaForMode('readwrite', new Set(['read', 'write']), {
        isAdmin: true,
        isStaffOrAdmin: true,
      });
      expect(schema).not.toBeNull();
      const actions = extractActionNames(schema as z.ZodTypeAny);
      expect(actions.sort()).toEqual(['rosterOptions', 'schedule', 'unschedule', 'viewRoster'].sort());
    });

    it('readonly mode advertises only the 2 read actions', () => {
      const schema = rockRosterTool.schemaForMode('readonly', new Set(['read']), {
        isAdmin: false,
        isStaffOrAdmin: false,
      });
      expect(schema).not.toBeNull();
      const actions = extractActionNames(schema as z.ZodTypeAny);
      expect(actions.sort()).toEqual(['rosterOptions', 'viewRoster'].sort());
    });

    it('leader-only (non-admin, non-staff) in readwrite mode STILL sees all 4 actions', () => {
      const schema = rockRosterTool.schemaForMode('readwrite', new Set(['read', 'write']), {
        isAdmin: false,
        isStaffOrAdmin: false,
      });
      expect(schema).not.toBeNull();
      const actions = extractActionNames(schema as z.ZodTypeAny);
      expect(actions.sort()).toEqual(['rosterOptions', 'schedule', 'unschedule', 'viewRoster'].sort());
    });

    it('readwrite mode without write scope falls back to 2 read actions', () => {
      const schema = rockRosterTool.schemaForMode('readwrite', new Set(['read']), {
        isAdmin: true,
        isStaffOrAdmin: true,
      });
      expect(schema).not.toBeNull();
      const actions = extractActionNames(schema as z.ZodTypeAny);
      expect(actions.sort()).toEqual(['rosterOptions', 'viewRoster'].sort());
    });
  });

  describe('rosterOptions', () => {
    it('returns roles from GroupLocations and services from the primary GroupLocationSchedules query', async () => {
      mockClient.get.mockImplementation((_ctx: any, path: string) => {
        if (path.includes('/api/GroupLocations')) {
          return Promise.resolve([
            { Id: 1, LocationId: 10, Location: { Name: 'Tech Captain' } },
            { Id: 2, LocationId: 11, Location: { Name: 'Camera Operator' } },
          ]);
        }
        if (path.includes('/api/GroupLocationSchedules')) {
          return Promise.resolve([
            { ScheduleId: 100, Schedule: { Name: '10AM' } },
            { ScheduleId: 101, Schedule: { Name: '12PM' } },
          ]);
        }
        return Promise.reject(new Error(`unexpected path: ${path}`));
      });

      const result = await rockRosterTool.handle({ action: 'rosterOptions', groupId: 42 }, null, mockCtx);
      const response = JSON.parse(result.content[0].text!);

      expect(response.ok).toBe(true);
      expect(response.result.groupId).toBe(42);
      expect(response.result.roles).toEqual(
        expect.arrayContaining([
          { locationId: 10, name: 'Tech Captain' },
          { locationId: 11, name: 'Camera Operator' },
        ])
      );
      expect(response.result.services).toEqual(
        expect.arrayContaining([
          { scheduleId: 100, name: '10AM' },
          { scheduleId: 101, name: '12PM' },
        ])
      );
    });

    it('falls back to AttendanceOccurrences + Schedules when GroupLocationSchedules rejects', async () => {
      mockClient.get.mockImplementation((_ctx: any, path: string) => {
        if (path.includes('/api/GroupLocations')) {
          return Promise.resolve([{ Id: 1, LocationId: 10, Location: { Name: 'Tech Captain' } }]);
        }
        if (path.includes('/api/GroupLocationSchedules')) {
          return Promise.reject(new Error('GroupLocationSchedules not queryable'));
        }
        if (path.includes('/api/AttendanceOccurrences')) {
          return Promise.resolve([
            { Id: 500, GroupId: 42, ScheduleId: 100 },
            { Id: 501, GroupId: 42, ScheduleId: 100 },
            { Id: 502, GroupId: 42, ScheduleId: 101 },
          ]);
        }
        if (path.includes('/api/Schedules')) {
          return Promise.resolve([
            { Id: 100, Name: '10AM' },
            { Id: 101, Name: '12PM' },
          ]);
        }
        return Promise.reject(new Error(`unexpected path: ${path}`));
      });

      const result = await rockRosterTool.handle({ action: 'rosterOptions', groupId: 42 }, null, mockCtx);
      const response = JSON.parse(result.content[0].text!);

      expect(response.ok).toBe(true);
      // Distinct schedule ids resolved to names, even though 3 occurrences share 2 schedules
      expect(response.result.services).toEqual(
        expect.arrayContaining([
          { scheduleId: 100, name: '10AM' },
          { scheduleId: 101, name: '12PM' },
        ])
      );
      expect(response.result.services.length).toBe(2);

      // No enum-bearing field in any $filter passed to Rock
      for (const call of mockClient.get.mock.calls) {
        const path = call[1] as string;
        expect(path).not.toMatch(/ScheduledToAttend/);
        expect(path).not.toMatch(/RSVP/);
      }
    });

    it('returns ROSTER_OPTIONS_ERROR when both roles and services queries fail entirely', async () => {
      mockClient.get.mockRejectedValue(new Error('Rock is down'));

      const result = await rockRosterTool.handle({ action: 'rosterOptions', groupId: 42 }, null, mockCtx);
      const response = JSON.parse(result.content[0].text!);

      expect(response.ok).toBe(false);
      expect(response.error.code).toBe('ROSTER_OPTIONS_ERROR');
    });
  });

  describe('viewRoster', () => {
    beforeEach(() => {
      mockClient.get.mockImplementation((_ctx: any, path: string) => {
        if (path.includes('/api/GroupLocations')) {
          return Promise.resolve([
            { Id: 1, LocationId: 10, Location: { Name: 'Tech Captain' } },
            { Id: 2, LocationId: 11, Location: { Name: 'Camera Operator' } },
          ]);
        }
        if (path.includes('/api/GroupLocationSchedules')) {
          return Promise.resolve([{ ScheduleId: 100, Schedule: { Name: '10AM' } }]);
        }
        if (path.includes('/api/AttendanceOccurrences')) {
          return Promise.resolve([{ Id: 900, GroupId: 42, LocationId: 10, ScheduleId: 100, OccurrenceDate: '2026-07-19T00:00:00' }]);
        }
        if (path.includes('/api/Attendances')) {
          return Promise.resolve([
            {
              Id: 1,
              OccurrenceId: 900,
              ScheduledToAttend: true,
              RSVP: 1,
              PersonAlias: { Id: 5001, PersonId: 200, Person: { NickName: 'Alex', FirstName: 'Alex', LastName: 'Santos' } },
            },
            {
              // Excluded: ScheduledToAttend false must NOT appear in the roster
              Id: 2,
              OccurrenceId: 900,
              ScheduledToAttend: false,
              RSVP: 0,
              PersonAlias: { Id: 5002, PersonId: 201, Person: { NickName: 'Bea', FirstName: 'Bea', LastName: 'Cruz' } },
            },
            {
              Id: 3,
              OccurrenceId: 900,
              ScheduledToAttend: true,
              RSVP: 3,
              PersonAlias: { Id: 5003, PersonId: 202, Person: { NickName: 'Carlo', FirstName: 'Carlo', LastName: 'Reyes' } },
            },
          ]);
        }
        return Promise.reject(new Error(`unexpected path: ${path}`));
      });
    });

    it('groups volunteers by service/role, excludes ScheduledToAttend:false, and maps RSVP to a label', async () => {
      const result = await rockRosterTool.handle({ action: 'viewRoster', groupId: 42, date: '2026-07-19' }, null, mockCtx);
      const response = JSON.parse(result.content[0].text!);

      expect(response.ok).toBe(true);
      expect(response.result.groupId).toBe(42);
      expect(response.result.date).toBe('2026-07-19');

      const service = response.result.services.find((s: any) => s.scheduleId === 100);
      expect(service).toBeDefined();
      expect(service.serviceName).toBe('10AM');

      const role = service.roles.find((r: any) => r.locationId === 10);
      expect(role).toBeDefined();
      expect(role.roleName).toBe('Tech Captain');

      const volunteerIds = role.volunteers.map((v: any) => v.personId);
      // Bea (ScheduledToAttend:false) is excluded
      expect(volunteerIds).toEqual(expect.arrayContaining([200, 202]));
      expect(volunteerIds).not.toContain(201);

      const alex = role.volunteers.find((v: any) => v.personId === 200);
      expect(alex.rsvp).toBe('Yes');
      const carlo = role.volunteers.find((v: any) => v.personId === 202);
      expect(carlo.rsvp).toBe('Unknown');
    });

    it('never puts ScheduledToAttend or RSVP inside an OData $filter', async () => {
      await rockRosterTool.handle({ action: 'viewRoster', groupId: 42, date: '2026-07-19' }, null, mockCtx);

      for (const call of mockClient.get.mock.calls) {
        const path = call[1] as string;
        if (path.includes('$filter')) {
          expect(path).not.toMatch(/ScheduledToAttend/);
          expect(path).not.toMatch(/RSVP/);
        }
      }
    });

    it('returns VIEW_ROSTER_ERROR when the occurrences query fails', async () => {
      mockClient.get.mockImplementation((_ctx: any, path: string) => {
        if (path.includes('/api/AttendanceOccurrences')) {
          return Promise.reject(new Error('Rock is down'));
        }
        if (path.includes('/api/GroupLocations')) {
          return Promise.resolve([]);
        }
        if (path.includes('/api/GroupLocationSchedules')) {
          return Promise.resolve([]);
        }
        return Promise.reject(new Error(`unexpected path: ${path}`));
      });

      const result = await rockRosterTool.handle({ action: 'viewRoster', groupId: 42, date: '2026-07-19' }, null, mockCtx);
      const response = JSON.parse(result.content[0].text!);

      expect(response.ok).toBe(false);
      expect(response.error.code).toBe('VIEW_ROSTER_ERROR');
    });
  });

  describe('schedule / unschedule stubs (implemented in B3/B4)', () => {
    it('schedule returns NOT_IMPLEMENTED', async () => {
      const result = await rockRosterTool.handle(
        {
          action: 'schedule',
          groupId: 42,
          personId: 200,
          locationId: 10,
          scheduleId: 100,
          date: '2026-07-19',
          reason: 'test',
        },
        null,
        mockCtx
      );
      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(false);
      expect(response.error.code).toBe('NOT_IMPLEMENTED');
    });

    it('unschedule returns NOT_IMPLEMENTED', async () => {
      const result = await rockRosterTool.handle(
        {
          action: 'unschedule',
          groupId: 42,
          personId: 200,
          locationId: 10,
          scheduleId: 100,
          date: '2026-07-19',
          reason: 'test',
        },
        null,
        mockCtx
      );
      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(false);
      expect(response.error.code).toBe('NOT_IMPLEMENTED');
    });
  });

  describe('missing rockClient', () => {
    it('returns MISSING_CLIENT when rockClient is absent from context', async () => {
      const ctxNoClient = { ...mockCtx, rockClient: undefined };
      const result = await rockRosterTool.handle({ action: 'rosterOptions', groupId: 42 }, null, ctxNoClient);
      const response = JSON.parse(result.content[0].text!);
      expect(response.ok).toBe(false);
      expect(response.error.code).toBe('MISSING_CLIENT');
    });
  });
});
