import { OAuthRockContext } from '../http/oauth.js';

export interface WriteDescriptor {
  tool: string;            // e.g. 'rock_write', 'rock_people'
  action: string;          // e.g. 'patch', 'updateContactInfo'
  model: string;           // canonical Rock model, e.g. 'people', 'groupmembers', 'notes', ...
  operation: 'create' | 'patch' | 'patchAttributes' | 'delete' | 'bulkPatch';
  fields?: string[];       // field names being written (for create/patch), if known
  count?: number;          // item count for bulk operations
}

export interface AuthzDecision {
  allowed: boolean;
  reason?: string;
  code?: string;
}

/**
 * Model allowlist definition.
 * Each model specifies which operations and fields are permitted.
 */
const MODEL_ALLOWLIST: Record<
  string,
  {
    operations: Set<'create' | 'patch' | 'patchAttributes' | 'delete' | 'bulkPatch'>;
    fields?: Set<string>; // undefined means all fields allowed for patchAttributes
  }
> = {
  people: {
    operations: new Set(['patch', 'patchAttributes', 'bulkPatch']),
    fields: new Set(['Email', 'FirstName', 'LastName', 'NickName']),
  },
  phonenumbers: {
    operations: new Set(['create', 'patch']),
    fields: new Set(['PersonId', 'NumberTypeValueId', 'Number', 'IsMessagingEnabled']),
  },
  notes: {
    operations: new Set(['create']),
    fields: new Set(['EntityId', 'NoteTypeId', 'Text', 'IsAlert', 'Caption']),
  },
  groupmembers: {
    operations: new Set(['create', 'patch', 'delete', 'bulkPatch']),
    fields: new Set(['GroupId', 'PersonId', 'GroupRoleId', 'GroupMemberStatus']),
  },
  attendances: {
    operations: new Set(['create', 'patch', 'bulkPatch']),
    fields: new Set(['OccurrenceId', 'PersonAliasId', 'DidAttend', 'StartDateTime', 'CampusId']),
  },
  attendanceoccurrences: {
    operations: new Set(['create']),
    fields: new Set(['GroupId', 'OccurrenceDate', 'ScheduleId', 'LocationId']),
  },
  connectionrequests: {
    operations: new Set(['create', 'patch', 'bulkPatch']),
    fields: new Set(['ConnectionOpportunityId', 'ConnectionStatusId', 'PersonAliasId', 'AssignedPersonAliasId', 'Comments']),
  },
  workflows: {
    operations: new Set(['create', 'patch', 'bulkPatch']),
    fields: new Set(['WorkflowTypeId', 'Name', 'IsActive', 'ActivatedDateTime', 'Status', 'CompletedDateTime']),
  },
  workflowactivities: {
    operations: new Set(['patch']),
    fields: new Set(['CompletedDateTime']),
  },
};

/**
 * Authorize a write operation.
 * Fail closed: default deny on any check failure.
 */
export function authorizeWrite(ctx: OAuthRockContext, desc: WriteDescriptor): AuthzDecision {
  // 1. Check mode and scope
  if (ctx.mode !== 'readwrite' || !ctx.scopes.has('write')) {
    return {
      allowed: false,
      code: 'UNAUTHORIZED_MODE',
      reason: 'Write operations require readwrite mode and write scope.',
    };
  }

  // 2. Check model allowlist (normalize case-insensitively)
  const normalizedModel = desc.model.toLowerCase();
  const modelConfig = MODEL_ALLOWLIST[normalizedModel];
  if (!modelConfig) {
    return {
      allowed: false,
      code: 'MODEL_NOT_ALLOWED',
      reason: `Model '${desc.model}' is not in the write allowlist.`,
    };
  }

  // 3. Check operation support for this model
  if (!modelConfig.operations.has(desc.operation)) {
    return {
      allowed: false,
      code: 'OPERATION_NOT_ALLOWED',
      reason: `Operation '${desc.operation}' is not allowed on model '${desc.model}'.`,
    };
  }

  // 4. Check field allowlist (only for create/patch, not for patchAttributes)
  if (desc.fields && desc.operation !== 'patchAttributes') {
    if (!modelConfig.fields) {
      return {
        allowed: false,
        code: 'FIELD_NOT_ALLOWED',
        reason: `No field allowlist defined for model '${desc.model}' operation '${desc.operation}'.`,
      };
    }
    for (const field of desc.fields) {
      if (!modelConfig.fields.has(field)) {
        return {
          allowed: false,
          code: 'FIELD_NOT_ALLOWED',
          reason: `Field '${field}' is not allowed on model '${desc.model}'.`,
        };
      }
    }
  }

  // 5. Check delete elevation (requires RSR admin)
  if (desc.operation === 'delete' && !ctx.rockUser.isRsrAdmin) {
    return {
      allowed: false,
      code: 'DELETE_REQUIRES_ADMIN',
      reason: 'Delete operations require admin privileges.',
    };
  }

  // 6. Check bulk bounds
  if (desc.operation === 'bulkPatch' || desc.count !== undefined) {
    const maxBulkWrite = parseInt(process.env.ROCK_MCP_BULK_WRITE_MAX || '25', 10);
    if (desc.count && desc.count > maxBulkWrite) {
      return {
        allowed: false,
        code: 'BULK_LIMIT_EXCEEDED',
        reason: `Bulk operation count (${desc.count}) exceeds limit (${maxBulkWrite}).`,
      };
    }
  }

  // All checks passed
  return {
    allowed: true,
  };
}
