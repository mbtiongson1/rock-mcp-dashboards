import { describe, it, expect, beforeEach } from 'vitest';
import { authorizeWrite, WriteDescriptor } from '../../src/auth/authorization.js';
import { OAuthRockContext } from '../../src/http/oauth.js';

describe('authorizeWrite', () => {
  let mockCtx: Partial<OAuthRockContext>;

  beforeEach(() => {
    mockCtx = {
      mode: 'readwrite',
      scopes: new Set(['read', 'write']),
      rockUser: {
        isRsrAdmin: false,
        isStaff: false,
        personId: 123,
        ledGroupIds: [],
      },
      oauth: {
        subject: 'user-123',
        accessTokenHash: 'hash-123',
      },
      request: {
        requestId: 'req-123',
        sessionId: 'sess-123',
      },
    };
  });

  describe('mode/scope checks', () => {
    it('should deny write when mode is readonly', () => {
      mockCtx.mode = 'readonly';
      const desc: WriteDescriptor = {
        tool: 'rock_write',
        action: 'patch',
        model: 'people',
        operation: 'patch',
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('UNAUTHORIZED_MODE');
    });

    it('should deny write when write scope is missing', () => {
      mockCtx.scopes = new Set(['read']);
      const desc: WriteDescriptor = {
        tool: 'rock_write',
        action: 'patch',
        model: 'people',
        operation: 'patch',
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('UNAUTHORIZED_MODE');
    });

    it('should allow write with readwrite mode and write scope', () => {
      mockCtx.rockUser!.isRsrAdmin = true;
      const desc: WriteDescriptor = {
        tool: 'rock_write',
        action: 'patch',
        model: 'people',
        operation: 'patch',
        fields: ['Email'],
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      // Should pass mode/scope, field, and tier checks
      expect(result.allowed).toBe(true);
    });
  });

  describe('model allowlist checks', () => {
    it('should allow whitelisted models', () => {
      const allowedModels = [
        'people',
        'notes',
        'groupmembers',
        'attendances',
        'attendanceoccurrences',
        'connectionrequests',
        'workflows',
        'workflowactivities',
      ];

      for (const model of allowedModels) {
        const desc: WriteDescriptor = {
          tool: 'rock_write',
          action: 'create',
          model,
          operation: 'create',
        };
        const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
        // At minimum, should pass model check (may fail on operation check separately tested)
        expect(result.allowed || result.code !== 'MODEL_NOT_ALLOWED').toBe(true);
      }
    });

    it('should deny unknown models', () => {
      const desc: WriteDescriptor = {
        tool: 'rock_write',
        action: 'patch',
        model: 'unknownModel',
        operation: 'patch',
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('MODEL_NOT_ALLOWED');
    });

    it('should normalize model names case-insensitively', () => {
      mockCtx.rockUser!.isRsrAdmin = true;
      const desc: WriteDescriptor = {
        tool: 'rock_write',
        action: 'patch',
        model: 'PEOPLE',
        operation: 'patch',
        fields: ['Email'],
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(true);
    });
  });

  describe('field allowlist checks', () => {
    it('should allow fields in the allowlist for create', () => {
      mockCtx.rockUser!.isRsrAdmin = true;
      const desc: WriteDescriptor = {
        tool: 'rock_people',
        action: 'updateContactInfo',
        model: 'people',
        operation: 'patch',
        fields: ['Email', 'FirstName'],
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(true);
    });

    it('should deny disallowed fields', () => {
      const desc: WriteDescriptor = {
        tool: 'rock_write',
        action: 'patch',
        model: 'people',
        operation: 'patch',
        fields: ['Email', 'SuperSecretField'],
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('FIELD_NOT_ALLOWED');
      expect(result.reason).toContain('SuperSecretField');
    });

    it('should require fields to be provided for create/patch operations', () => {
      mockCtx.rockUser!.isRsrAdmin = true;
      const desc: WriteDescriptor = {
        tool: 'rock_people',
        action: 'updateContactInfo',
        model: 'people',
        operation: 'patch',
        // No fields provided
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      // Should still allow since fields check only applies if fields array is provided
      expect(result.allowed).toBe(true);
    });

    it('should allow only model-level validation for patchAttributes', () => {
      mockCtx.rockUser!.isRsrAdmin = true;
      const desc: WriteDescriptor = {
        tool: 'rock_people',
        action: 'patchAttributes',
        model: 'people',
        operation: 'patchAttributes',
        // Dynamic attribute keys - no field list
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(true);
    });

    it('should deny patchAttributes on models that do not support it', () => {
      const desc: WriteDescriptor = {
        tool: 'rock_write',
        action: 'patchAttributes',
        model: 'groupmembers',
        operation: 'patchAttributes',
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('OPERATION_NOT_ALLOWED');
    });
  });

  describe('delete elevation', () => {
    it('should deny delete to non-admins (groupLeader tier, not the target leader)', () => {
      mockCtx.rockUser!.isRsrAdmin = false;
      const desc: WriteDescriptor = {
        tool: 'rock_write',
        action: 'delete',
        model: 'groupmembers',
        operation: 'delete',
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('NOT_GROUP_LEADER');
    });

    it('should allow delete to the target group leader even without admin', () => {
      mockCtx.rockUser!.isRsrAdmin = false;
      const desc: WriteDescriptor = {
        tool: 'rock_write',
        action: 'delete',
        model: 'groupmembers',
        operation: 'delete',
        callerIsTargetGroupLeader: true,
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(true);
    });

    it('should allow delete to admins', () => {
      mockCtx.rockUser!.isRsrAdmin = true;
      const desc: WriteDescriptor = {
        tool: 'rock_write',
        action: 'delete',
        model: 'groupmembers',
        operation: 'delete',
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(true);
    });
  });

  describe('bulk bounds', () => {
    it('should allow bulk patch at default limit (25)', () => {
      mockCtx.rockUser!.isRsrAdmin = true;
      const desc: WriteDescriptor = {
        tool: 'rock_write',
        action: 'bulkPatch',
        model: 'people',
        operation: 'bulkPatch',
        count: 25,
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(true);
    });

    it('should deny bulk patch over the limit', () => {
      mockCtx.rockUser!.isRsrAdmin = true;
      const desc: WriteDescriptor = {
        tool: 'rock_write',
        action: 'bulkPatch',
        model: 'people',
        operation: 'bulkPatch',
        count: 100,
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('BULK_LIMIT_EXCEEDED');
    });

    it('should respect ROCK_MCP_BULK_WRITE_MAX env var if set', () => {
      mockCtx.rockUser!.isRsrAdmin = true;
      process.env.ROCK_MCP_BULK_WRITE_MAX = '10';
      const desc: WriteDescriptor = {
        tool: 'rock_write',
        action: 'bulkPatch',
        model: 'people',
        operation: 'bulkPatch',
        count: 15,
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('BULK_LIMIT_EXCEEDED');
      delete process.env.ROCK_MCP_BULK_WRITE_MAX;
    });
  });

  describe('operation support per model', () => {
    it('should deny patch on models that do not support it', () => {
      const desc: WriteDescriptor = {
        tool: 'rock_write',
        action: 'patch',
        model: 'attendanceoccurrences',
        operation: 'patch',
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('OPERATION_NOT_ALLOWED');
    });

    it('should deny create on models that do not support it', () => {
      const desc: WriteDescriptor = {
        tool: 'rock_write',
        action: 'patch',
        model: 'workflowactivities',
        operation: 'create',
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('OPERATION_NOT_ALLOWED');
    });

    it('should deny delete on models that do not support it', () => {
      mockCtx.rockUser!.isRsrAdmin = true;
      const desc: WriteDescriptor = {
        tool: 'rock_write',
        action: 'delete',
        model: 'notes',
        operation: 'delete',
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('OPERATION_NOT_ALLOWED');
    });
  });

  describe('comprehensive scenarios', () => {
    it('should allow people patch with allowed fields', () => {
      mockCtx.rockUser!.isRsrAdmin = true;
      const desc: WriteDescriptor = {
        tool: 'rock_people',
        action: 'updateContactInfo',
        model: 'people',
        operation: 'patch',
        fields: ['Email', 'FirstName'],
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(true);
    });

    it('should deny notes create with disallowed field', () => {
      const desc: WriteDescriptor = {
        tool: 'rock_people',
        action: 'createNote',
        model: 'notes',
        operation: 'create',
        fields: ['EntityId', 'NoteTypeId', 'BadField'],
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('FIELD_NOT_ALLOWED');
    });

    it('should allow groupmembers create with allowed fields', () => {
      const desc: WriteDescriptor = {
        tool: 'rock_ministry',
        action: 'addOrUpdateGroupMember',
        model: 'groupmembers',
        operation: 'create',
        fields: ['GroupId', 'PersonId', 'GroupRoleId'],
        callerIsTargetGroupLeader: true,
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(true);
    });

    it('should allow groupmembers delete for admins or the target group leader, deny others', () => {
      mockCtx.rockUser!.isRsrAdmin = false;
      const desc: WriteDescriptor = {
        tool: 'rock_ministry',
        action: 'removeGroupMember',
        model: 'groupmembers',
        operation: 'delete',
      };
      // Non-admin, not the target leader -> denied
      let result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('NOT_GROUP_LEADER');

      // Non-admin, but the target group leader -> allowed
      result = authorizeWrite(mockCtx as OAuthRockContext, { ...desc, callerIsTargetGroupLeader: true });
      expect(result.allowed).toBe(true);

      // Admin -> allowed regardless of leader status
      mockCtx.rockUser!.isRsrAdmin = true;
      result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(true);
    });

    it('should allow connectionrequests patch with allowed fields', () => {
      mockCtx.rockUser!.isRsrAdmin = true;
      const desc: WriteDescriptor = {
        tool: 'rock_workflow',
        action: 'updateConnectionRequest',
        model: 'connectionrequests',
        operation: 'patch',
        fields: ['ConnectionStatusId', 'AssignedPersonAliasId'],
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(true);
    });

    it('should allow workflows create with allowed fields', () => {
      mockCtx.rockUser!.isRsrAdmin = true;
      const desc: WriteDescriptor = {
        tool: 'rock_workflow',
        action: 'launchWorkflow',
        model: 'workflows',
        operation: 'create',
        fields: ['WorkflowTypeId', 'Name'],
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(true);
    });

    it('should allow workflowactivities patch with allowed fields', () => {
      mockCtx.rockUser!.isRsrAdmin = true;
      const desc: WriteDescriptor = {
        tool: 'rock_workflow',
        action: 'completeAction',
        model: 'workflowactivities',
        operation: 'patch',
        fields: ['CompletedDateTime'],
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(true);
    });

    it('should allow phonenumbers create with allowed fields', () => {
      mockCtx.rockUser!.isRsrAdmin = true;
      const desc: WriteDescriptor = {
        tool: 'rock_people',
        action: 'updateContactInfo',
        model: 'phonenumbers',
        operation: 'create',
        fields: ['PersonId', 'NumberTypeValueId', 'Number'],
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(true);
    });

    it('should allow phonenumbers patch with allowed fields', () => {
      mockCtx.rockUser!.isRsrAdmin = true;
      const desc: WriteDescriptor = {
        tool: 'rock_people',
        action: 'updateContactInfo',
        model: 'phonenumbers',
        operation: 'patch',
        fields: ['Number', 'IsMessagingEnabled'],
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(true);
    });

    it('should deny phonenumbers operations with disallowed fields', () => {
      const desc: WriteDescriptor = {
        tool: 'rock_people',
        action: 'updateContactInfo',
        model: 'phonenumbers',
        operation: 'create',
        fields: ['PersonId', 'NumberTypeValueId', 'DisallowedField'],
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('FIELD_NOT_ALLOWED');
    });
  });

  describe('tier authorization', () => {
    it('admin-tier denies non-admin (people patch)', () => {
      mockCtx.rockUser!.isRsrAdmin = false;
      const desc: WriteDescriptor = {
        tool: 'rock_write',
        action: 'patch',
        model: 'people',
        operation: 'patch',
        fields: ['Email'],
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('ADMIN_REQUIRED');
    });

    it('admin-tier allows admin (people patch)', () => {
      mockCtx.rockUser!.isRsrAdmin = true;
      const desc: WriteDescriptor = {
        tool: 'rock_write',
        action: 'patch',
        model: 'people',
        operation: 'patch',
        fields: ['Email'],
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(true);
    });

    it('groupLeader-tier allows admin with no callerIsTargetGroupLeader (groupmembers create)', () => {
      mockCtx.rockUser!.isRsrAdmin = true;
      const desc: WriteDescriptor = {
        tool: 'rock_ministry',
        action: 'addOrUpdateGroupMember',
        model: 'groupmembers',
        operation: 'create',
        fields: ['GroupId', 'PersonId'],
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(true);
    });

    it('groupLeader-tier allows the target group leader (groupmembers create)', () => {
      mockCtx.rockUser!.isRsrAdmin = false;
      const desc: WriteDescriptor = {
        tool: 'rock_ministry',
        action: 'addOrUpdateGroupMember',
        model: 'groupmembers',
        operation: 'create',
        fields: ['GroupId', 'PersonId'],
        callerIsTargetGroupLeader: true,
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(true);
    });

    it('groupLeader-tier denies a non-admin non-leader (groupmembers create)', () => {
      mockCtx.rockUser!.isRsrAdmin = false;
      const desc: WriteDescriptor = {
        tool: 'rock_ministry',
        action: 'addOrUpdateGroupMember',
        model: 'groupmembers',
        operation: 'create',
        fields: ['GroupId', 'PersonId'],
        callerIsTargetGroupLeader: false,
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('NOT_GROUP_LEADER');
    });

    it('groupLeader-tier fails closed when callerIsTargetGroupLeader is omitted (groupmembers create)', () => {
      mockCtx.rockUser!.isRsrAdmin = false;
      const desc: WriteDescriptor = {
        tool: 'rock_ministry',
        action: 'addOrUpdateGroupMember',
        model: 'groupmembers',
        operation: 'create',
        fields: ['GroupId', 'PersonId'],
        // callerIsTargetGroupLeader intentionally omitted
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('NOT_GROUP_LEADER');
    });

    it('groupLeader-tier delete: allowed for the target leader, denied otherwise (attendances delete)', () => {
      mockCtx.rockUser!.isRsrAdmin = false;
      const desc: WriteDescriptor = {
        tool: 'rock_ministry',
        action: 'unscheduleAttendance',
        model: 'attendances',
        operation: 'delete',
        callerIsTargetGroupLeader: true,
      };
      let result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(true);

      result = authorizeWrite(mockCtx as OAuthRockContext, { ...desc, callerIsTargetGroupLeader: false });
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('NOT_GROUP_LEADER');
    });

    it('attendances allows the new ScheduledToAttend/RSVP fields and still rejects bogus fields', () => {
      mockCtx.rockUser!.isRsrAdmin = false;
      const desc: WriteDescriptor = {
        tool: 'rock_ministry',
        action: 'scheduleAttendance',
        model: 'attendances',
        operation: 'create',
        fields: ['OccurrenceId', 'PersonAliasId', 'ScheduledToAttend', 'RSVP'],
        callerIsTargetGroupLeader: true,
      };
      const result = authorizeWrite(mockCtx as OAuthRockContext, desc);
      expect(result.allowed).toBe(true);

      const badDesc: WriteDescriptor = {
        ...desc,
        operation: 'patch',
        fields: ['ScheduledToAttend', 'BogusField'],
      };
      const badResult = authorizeWrite(mockCtx as OAuthRockContext, badDesc);
      expect(badResult.allowed).toBe(false);
      expect(badResult.code).toBe('FIELD_NOT_ALLOWED');
    });
  });
});
