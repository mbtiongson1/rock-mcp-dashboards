import { z } from 'zod';
import { GatewayTool, McpToolResult } from './types.js';
import { McpMode, McpScope } from '../mcp/modes.js';
import { OAuthRockContext } from '../http/oauth.js';
import { formatResponse } from './formatter.js';
import { RockClient } from '../rock/client.js';
import { quoteLinqString, quoteODataString, assertValidGuid } from '../rock/query.js';
import { AuditLogger } from '../auth/audit.js';

const rockPeopleSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('find'),
    query: z.string().min(1),
    limit: z.number().int().positive().max(100).default(20),
  }),
  z.object({
    action: z.literal('profile'),
    person: z.object({
      id: z.number().optional(),
      guid: z.string().optional(),
      search: z.string().optional(),
    }),
    includeSensitive: z.boolean().default(false),
  }),
  z.object({
    action: z.literal('updateContactInfo'),
    personId: z.number().optional(),
    personGuid: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    dryRun: z.boolean().default(true),
    commit: z.boolean().default(false),
    reason: z.string().min(1),
  }),
  z.object({
    action: z.literal('patchAttributes'),
    personId: z.number().optional(),
    personGuid: z.string().optional(),
    attributes: z.record(z.unknown()),
    dryRun: z.boolean().default(true),
    commit: z.boolean().default(false),
    reason: z.string().min(1),
  }),
  z.object({
    action: z.literal('createNote'),
    personId: z.number().optional(),
    personGuid: z.string().optional(),
    text: z.string().min(1),
    noteType: z.string().optional(),
    dryRun: z.boolean().default(true),
    commit: z.boolean().default(false),
    reason: z.string().min(1),
  }),
  z.object({
    action: z.literal('createFollowUpTask'),
    personId: z.number().optional(),
    personGuid: z.string().optional(),
    title: z.string().min(1),
    description: z.string().optional(),
    assignedToId: z.number().optional(),
    connectionOpportunityId: z.number().optional(),
    dryRun: z.boolean().default(true),
    commit: z.boolean().default(false),
    reason: z.string().min(1),
  }),
]);

const auditLogger = new AuditLogger();

async function resolvePersonId(client: RockClient, ctx: OAuthRockContext, person: { id?: number; guid?: string; search?: string }): Promise<number | null> {
  if (person.id) return person.id;
  if (person.guid) {
    const validGuid = assertValidGuid(person.guid);
    let results: any[] = [];
    try {
      results = await client.post(ctx, '/api/v2/models/people/search', { Where: `Guid == ${quoteLinqString(validGuid)}` });
    } catch {
      results = await client.get(ctx, `/api/People?$filter=Guid eq guid${quoteODataString(validGuid)}`);
    }
    if (results && results.length > 0) return results[0].Id;
  }
  if (person.search) {
    let results: any[] = [];
    try {
      const quoted = quoteLinqString(person.search);
      results = await client.post(ctx, '/api/v2/models/people/search', { Where: `NickName == ${quoted} || LastName == ${quoted} || (NickName + " " + LastName) == ${quoted}` });
    } catch {
      const odataFilter = `(NickName eq ${quoteODataString(person.search)}) or (LastName eq ${quoteODataString(person.search)})`;
      results = await client.get(ctx, `/api/People?$filter=${encodeURIComponent(odataFilter)}`);
    }
    if (results && results.length > 0) return results[0].Id;
  }
  return null;
}

async function resolvePersonAliasId(client: RockClient, ctx: OAuthRockContext, personId: number): Promise<number | null> {
  try {
    const aliases = await client.get<any[]>(ctx, `/api/PersonAlias?$filter=PersonId eq ${personId}`);
    if (aliases && aliases.length > 0) {
      return aliases[0].Id;
    }
  } catch {
    // Ignore and fallback
  }
  return null;
}

export const rockPeopleTool: GatewayTool = {
  name: 'rock_people',
  title: 'Rock People Directory',
  schemaForMode(mode: McpMode, scopes: Set<McpScope>): z.ZodTypeAny | null {
    if (mode !== 'readwrite' || !scopes.has('write')) {
      return z.discriminatedUnion('action', [
        z.object({
          action: z.literal('find'),
          query: z.string().min(1),
          limit: z.number().int().positive().max(100).default(20),
        }),
        z.object({
          action: z.literal('profile'),
          person: z.object({
            id: z.number().optional(),
            guid: z.string().optional(),
            search: z.string().optional(),
          }),
          includeSensitive: z.boolean().default(false),
        }),
      ]);
    }
    return rockPeopleSchema;
  },
  descriptionForMode(_mode: McpMode): string {
    return 'Directory lookups, profiles, and relationship workflows for people in Rock RMS.';
  },
  async handle(args: any, _extra: any, ctx: OAuthRockContext): Promise<McpToolResult> {
    const parsed = rockPeopleSchema.parse(args);

    const rockClient = (ctx as any).rockClient as RockClient;
    if (!rockClient) {
      return formatResponse(parsed.action, ctx, null, {
        code: 'MISSING_CLIENT',
        message: 'Rock client is not initialized in request context.',
      });
    }

    if (parsed.action === 'find') {
      const { query, limit } = parsed;
      try {
        let results: any[] = [];
        try {
          const quoted = quoteLinqString(query);
          results = await rockClient.post(ctx, '/api/v2/models/people/search', {
            Where: `NickName.Contains(${quoted}) || LastName.Contains(${quoted})`,
            Limit: limit,
          });
        } catch (_err) {
          // Fall back to REST v1
          const odataFilter = `(substringof(${quoteODataString(query)}, NickName) eq true) or (substringof(${quoteODataString(query)}, LastName) eq true)`;
          results = await rockClient.get(ctx, `/api/People?$filter=${encodeURIComponent(odataFilter)}&$top=${limit}`);
        }

        const safeResults = results.map((p: any) => ({
          id: p.Id,
          guid: p.Guid,
          name: `${p.NickName || p.FirstName} ${p.LastName}`,
        }));

        return formatResponse(parsed.action, ctx, safeResults);
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'FIND_ERROR',
          message: `Failed to find people: ${err.message}`,
        });
      }
    }

    if (parsed.action === 'profile') {
      const { person, includeSensitive } = parsed;
      try {
        let match: any = null;

        if (person.id) {
          try {
            match = await rockClient.get(ctx, `/api/v2/models/people/${person.id}`);
          } catch (_err) {
            match = await rockClient.get(ctx, `/api/People/${person.id}`);
          }
        } else if (person.guid) {
          const validGuid = assertValidGuid(person.guid);
          let results: any[] = [];
          try {
            results = await rockClient.post(ctx, '/api/v2/models/people/search', {
              Where: `Guid == ${quoteLinqString(validGuid)}`,
            });
          } catch (_err) {
            results = await rockClient.get(ctx, `/api/People?$filter=Guid eq guid${quoteODataString(validGuid)}`);
          }
          if (results && results.length > 0) {
            match = results[0];
          }
        } else if (person.search) {
          let results: any[] = [];
          try {
            const quoted = quoteLinqString(person.search);
            results = await rockClient.post(ctx, '/api/v2/models/people/search', {
              Where: `NickName == ${quoted} || LastName == ${quoted} || (NickName + " " + LastName) == ${quoted}`,
            });
          } catch (_err) {
            const odataFilter = `(NickName eq ${quoteODataString(person.search)}) or (LastName eq ${quoteODataString(person.search)})`;
            results = await rockClient.get(ctx, `/api/People?$filter=${encodeURIComponent(odataFilter)}`);
          }
          if (results && results.length > 0) {
            match = results[0];
          }
        }

        if (!match) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'NOT_FOUND',
            message: 'Person not found.',
          });
        }

        const isAuthorizedForSensitive = includeSensitive && ctx.mode === 'readwrite' && ctx.scopes.has('write');

        const profileResult: any = {
          person: {
            id: match.Id,
            guid: match.Guid,
            name: `${match.NickName || match.FirstName} ${match.LastName}`,
            firstName: match.FirstName,
            lastName: match.LastName,
          },
        };

        if (isAuthorizedForSensitive) {
          profileResult.person.email = match.Email;
          profileResult.person.phone = match.MobilePhoneNumber || match.Phone;
          profileResult.person.birthdate = match.BirthDate || (match.BirthYear ? `${match.BirthYear}-${match.BirthMonth}-${match.BirthDay}` : undefined);
        }

        return formatResponse(parsed.action, ctx, profileResult);
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'PROFILE_ERROR',
          message: `Failed to fetch profile: ${err.message}`,
        });
      }
    }

    if (parsed.action === 'updateContactInfo') {
      const { personId, personGuid, email, phone, firstName, lastName, dryRun, commit, reason } = parsed;
      if (ctx.mode !== 'readwrite' || !ctx.scopes.has('write')) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'UNAUTHORIZED',
          message: 'Write actions disallowed in readonly mode.',
        });
      }
      try {
        const id = personId || (personGuid ? await resolvePersonId(rockClient, ctx, { guid: personGuid }) : null);
        if (!id) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'NOT_FOUND',
            message: 'Person not found.',
          });
        }
        const data: any = {};
        if (email !== undefined) data.Email = email;
        if (phone !== undefined) data.MobilePhoneNumber = phone;
        if (firstName !== undefined) data.FirstName = firstName;
        if (lastName !== undefined) data.LastName = lastName;

        const shouldMutate = commit && !dryRun;
        if (!shouldMutate) {
          auditLogger.log(ctx, {
            tool: 'rock_people',
            action: parsed.action,
            target: { model: 'people', id },
            dryRun: true,
            commit: false,
            reason,
            outcome: 'allowed',
          });
          return formatResponse(parsed.action, ctx, {
            dryRun: true,
            committed: false,
            target: { id },
            data,
          });
        }

        let result;
        try {
          result = await rockClient.patch(ctx, `/api/v2/models/people/${id}`, data);
        } catch {
          result = await rockClient.patch(ctx, `/api/People/${id}`, data);
        }

        auditLogger.log(ctx, {
          tool: 'rock_people',
          action: parsed.action,
          target: { model: 'people', id },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'success',
        });
        return formatResponse(parsed.action, ctx, { committed: true, result });
      } catch (err: any) {
        auditLogger.log(ctx, {
          tool: 'rock_people',
          action: parsed.action,
          target: { model: 'people' },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'error',
          errorCode: 'UPDATE_CONTACT_ERROR',
        });
        return formatResponse(parsed.action, ctx, null, {
          code: 'UPDATE_CONTACT_ERROR',
          message: err.message,
        });
      }
    }

    if (parsed.action === 'patchAttributes') {
      const { personId, personGuid, attributes, dryRun, commit, reason } = parsed;
      if (ctx.mode !== 'readwrite' || !ctx.scopes.has('write')) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'UNAUTHORIZED',
          message: 'Write actions disallowed in readonly mode.',
        });
      }
      try {
        const id = personId || (personGuid ? await resolvePersonId(rockClient, ctx, { guid: personGuid }) : null);
        if (!id) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'NOT_FOUND',
            message: 'Person not found.',
          });
        }

        const shouldMutate = commit && !dryRun;
        if (!shouldMutate) {
          auditLogger.log(ctx, {
            tool: 'rock_people',
            action: parsed.action,
            target: { model: 'people', id },
            dryRun: true,
            commit: false,
            reason,
            outcome: 'allowed',
          });
          return formatResponse(parsed.action, ctx, {
            dryRun: true,
            committed: false,
            target: { id },
            attributes,
          });
        }

        const result = await rockClient.patch(ctx, `/api/v2/models/people/${id}/attributevalues`, attributes);
        auditLogger.log(ctx, {
          tool: 'rock_people',
          action: parsed.action,
          target: { model: 'people', id },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'success',
        });
        return formatResponse(parsed.action, ctx, { committed: true, result });
      } catch (err: any) {
        auditLogger.log(ctx, {
          tool: 'rock_people',
          action: parsed.action,
          target: { model: 'people' },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'error',
          errorCode: 'PATCH_ATTRIBUTES_ERROR',
        });
        return formatResponse(parsed.action, ctx, null, {
          code: 'PATCH_ATTRIBUTES_ERROR',
          message: err.message,
        });
      }
    }

    if (parsed.action === 'createNote') {
      const { personId, personGuid, text, noteType, dryRun, commit, reason } = parsed;
      if (ctx.mode !== 'readwrite' || !ctx.scopes.has('write')) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'UNAUTHORIZED',
          message: 'Write actions disallowed in readonly mode.',
        });
      }
      try {
        const id = personId || (personGuid ? await resolvePersonId(rockClient, ctx, { guid: personGuid }) : null);
        if (!id) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'NOT_FOUND',
            message: 'Person not found.',
          });
        }

        let noteTypeId = 4; // Default to Personal Note
        if (noteType) {
          if (/^\d+$/.test(noteType)) {
            noteTypeId = parseInt(noteType, 10);
          } else {
            try {
              const types = await rockClient.get<any[]>(ctx, `/api/NoteTypes?$filter=EntityType/Name eq 'Rock.Model.Person' and substringof(${quoteODataString(noteType)}, Name) eq true`);
              if (types && types.length > 0) {
                noteTypeId = types[0].Id;
              }
            } catch {
              // Ignore and fallback
            }
          }
        }

        const payload = {
          EntityId: id,
          NoteTypeId: noteTypeId,
          Text: text,
          IsAlert: false,
        };

        const shouldMutate = commit && !dryRun;
        if (!shouldMutate) {
          auditLogger.log(ctx, {
            tool: 'rock_people',
            action: parsed.action,
            target: { model: 'people', id },
            dryRun: true,
            commit: false,
            reason,
            outcome: 'allowed',
          });
          return formatResponse(parsed.action, ctx, {
            dryRun: true,
            committed: false,
            target: { id },
            payload,
          });
        }

        let result;
        try {
          result = await rockClient.post(ctx, '/api/v2/models/notes', payload);
        } catch {
          result = await rockClient.post(ctx, '/api/Notes', payload);
        }

        auditLogger.log(ctx, {
          tool: 'rock_people',
          action: parsed.action,
          target: { model: 'people', id },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'success',
        });
        return formatResponse(parsed.action, ctx, { committed: true, result });
      } catch (err: any) {
        auditLogger.log(ctx, {
          tool: 'rock_people',
          action: parsed.action,
          target: { model: 'people' },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'error',
          errorCode: 'CREATE_NOTE_ERROR',
        });
        return formatResponse(parsed.action, ctx, null, {
          code: 'CREATE_NOTE_ERROR',
          message: err.message,
        });
      }
    }

    if (parsed.action === 'createFollowUpTask') {
      const { personId, personGuid, title, description, assignedToId, connectionOpportunityId, dryRun, commit, reason } = parsed;
      if (ctx.mode !== 'readwrite' || !ctx.scopes.has('write')) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'UNAUTHORIZED',
          message: 'Write actions disallowed in readonly mode.',
        });
      }
      try {
        const id = personId || (personGuid ? await resolvePersonId(rockClient, ctx, { guid: personGuid }) : null);
        if (!id) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'NOT_FOUND',
            message: 'Person not found.',
          });
        }

        const aliasId = await resolvePersonAliasId(rockClient, ctx, id);
        if (!aliasId) {
          return formatResponse(parsed.action, ctx, null, {
            code: 'ALIAS_NOT_FOUND',
            message: 'Could not resolve person alias ID.',
          });
        }

        let assignedAliasId: number | undefined;
        if (assignedToId) {
          assignedAliasId = await resolvePersonAliasId(rockClient, ctx, assignedToId) || undefined;
        }

        let oppId = connectionOpportunityId || 1;

        const payload: any = {
          ConnectionOpportunityId: oppId,
          ConnectionStatusId: 2, // In Progress
          PersonAliasId: aliasId,
          Comments: description ? `${title}\n\n${description}` : title,
        };
        if (assignedAliasId) {
          payload.AssignedPersonAliasId = assignedAliasId;
        }

        const shouldMutate = commit && !dryRun;
        if (!shouldMutate) {
          auditLogger.log(ctx, {
            tool: 'rock_people',
            action: parsed.action,
            target: { model: 'people', id },
            dryRun: true,
            commit: false,
            reason,
            outcome: 'allowed',
          });
          return formatResponse(parsed.action, ctx, {
            dryRun: true,
            committed: false,
            target: { id },
            payload,
          });
        }

        let result;
        try {
          result = await rockClient.post(ctx, '/api/v2/models/connectionrequests', payload);
        } catch {
          result = await rockClient.post(ctx, '/api/ConnectionRequests', payload);
        }

        auditLogger.log(ctx, {
          tool: 'rock_people',
          action: parsed.action,
          target: { model: 'people', id },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'success',
        });
        return formatResponse(parsed.action, ctx, { committed: true, result });
      } catch (err: any) {
        auditLogger.log(ctx, {
          tool: 'rock_people',
          action: parsed.action,
          target: { model: 'people' },
          dryRun: false,
          commit: true,
          reason,
          outcome: 'error',
          errorCode: 'CREATE_TASK_ERROR',
        });
        return formatResponse(parsed.action, ctx, null, {
          code: 'CREATE_TASK_ERROR',
          message: err.message,
        });
      }
    }

    const actionName = (parsed as any).action;
    return formatResponse(actionName, ctx, null, {
      code: 'NOT_IMPLEMENTED',
      message: `Action ${actionName} is not yet implemented.`,
    });
  },
};
