import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { rockUsageTool } from '../../src/tools/rock-usage.js';
import { rockLookupTool } from '../../src/tools/rock-lookup.js';
import { rockEntityTool } from '../../src/tools/rock-entity.js';
import { rockPeopleTool } from '../../src/tools/rock-people.js';
import { rockMinistryTool } from '../../src/tools/rock-ministry.js';
import { rockReportTool } from '../../src/tools/rock-report.js';
import { rockWorkflowTool } from '../../src/tools/rock-workflow.js';
import { rockWriteTool } from '../../src/tools/rock-write.js';
import { extractActionNames } from '../../src/tools/schema-utils.js';

/**
 * Capability matrix for schemaForMode(mode, scopes, caps).
 *
 * Visibility rules (Task A5 brief):
 * - rock_ministry (and, later, rock_roster): write actions visible to admins
 *   AND leaders — no isAdmin gate. Per-group leadership enforced at handle time.
 * - rock_people / rock_workflow: write actions only visible when caps.isAdmin.
 * - rock_write: null unless readwrite && caps.isAdmin.
 * - rock_report: null unless caps.isStaffOrAdmin (hidden from leader-only users).
 * - rock_usage / rock_lookup / rock_entity: visible to all, signature-only change.
 */

const RW = new Set<'read' | 'write'>(['read', 'write']);

const ADMIN = { isAdmin: true, isStaffOrAdmin: true };
const LEADER_ONLY = { isAdmin: false, isStaffOrAdmin: false };
const STAFF_ONLY = { isAdmin: false, isStaffOrAdmin: true };

function actionsOf(schema: z.ZodTypeAny | null): string[] {
  if (!schema) return [];
  return extractActionNames(schema);
}

describe('schemaForMode capability matrix', () => {
  describe('admin caller (readwrite)', () => {
    it('sees rock_write', () => {
      expect(rockWriteTool.schemaForMode('readwrite', RW, ADMIN)).not.toBeNull();
    });

    it('sees rock_people write actions', () => {
      const actions = actionsOf(rockPeopleTool.schemaForMode('readwrite', RW, ADMIN));
      expect(actions).toContain('updateContactInfo');
      expect(actions).toContain('find');
    });

    it('sees rock_workflow write actions', () => {
      const actions = actionsOf(rockWorkflowTool.schemaForMode('readwrite', RW, ADMIN));
      expect(actions).toContain('launchWorkflow');
      expect(actions).toContain('connectionRequests');
    });

    it('sees rock_report', () => {
      expect(rockReportTool.schemaForMode('readwrite', RW, ADMIN)).not.toBeNull();
    });

    it('sees rock_ministry write actions', () => {
      const actions = actionsOf(rockMinistryTool.schemaForMode('readwrite', RW, ADMIN));
      expect(actions).toContain('addOrUpdateGroupMember');
      expect(actions).toContain('groups');
    });
  });

  describe('leader-only caller (admitted leader, not staff/admin, readwrite)', () => {
    it('hides rock_write entirely', () => {
      expect(rockWriteTool.schemaForMode('readwrite', RW, LEADER_ONLY)).toBeNull();
    });

    it('hides rock_people write actions but keeps read actions', () => {
      const actions = actionsOf(rockPeopleTool.schemaForMode('readwrite', RW, LEADER_ONLY));
      expect(actions).not.toContain('updateContactInfo');
      expect(actions).toContain('find');
      expect(actions).toContain('profile');
    });

    it('hides rock_workflow write actions but keeps read actions', () => {
      const actions = actionsOf(rockWorkflowTool.schemaForMode('readwrite', RW, LEADER_ONLY));
      expect(actions).not.toContain('launchWorkflow');
      expect(actions).not.toContain('updateWorkflow');
      expect(actions).toContain('connectionRequests');
      expect(actions).toContain('workflowTypes');
    });

    it('SEES rock_ministry write actions (leaders write to groups they lead)', () => {
      const actions = actionsOf(rockMinistryTool.schemaForMode('readwrite', RW, LEADER_ONLY));
      expect(actions).toContain('addOrUpdateGroupMember');
      expect(actions).toContain('groups');
    });

    it('hides rock_report (giving exposure)', () => {
      expect(rockReportTool.schemaForMode('readwrite', RW, LEADER_ONLY)).toBeNull();
    });

    it('still sees rock_usage, rock_lookup, rock_entity', () => {
      expect(rockUsageTool.schemaForMode('readwrite', RW, LEADER_ONLY)).not.toBeNull();
      expect(rockLookupTool.schemaForMode('readwrite', RW, LEADER_ONLY)).not.toBeNull();
      expect(rockEntityTool.schemaForMode('readwrite', RW, LEADER_ONLY)).not.toBeNull();
    });
  });

  describe('staff-only caller (staff/admin-report access but not admin, not leader)', () => {
    it('sees rock_report', () => {
      expect(rockReportTool.schemaForMode('readwrite', RW, STAFF_ONLY)).not.toBeNull();
    });

    it('hides rock_write', () => {
      expect(rockWriteTool.schemaForMode('readwrite', RW, STAFF_ONLY)).toBeNull();
    });

    it('hides rock_people write actions', () => {
      const actions = actionsOf(rockPeopleTool.schemaForMode('readwrite', RW, STAFF_ONLY));
      expect(actions).not.toContain('updateContactInfo');
    });

    it('hides rock_workflow write actions', () => {
      const actions = actionsOf(rockWorkflowTool.schemaForMode('readwrite', RW, STAFF_ONLY));
      expect(actions).not.toContain('launchWorkflow');
    });
  });
});
