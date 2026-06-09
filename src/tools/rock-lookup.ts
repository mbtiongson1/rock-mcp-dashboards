import { z } from 'zod';
import { GatewayTool, McpToolResult } from './types.js';
import { McpMode, McpScope } from '../mcp/modes.js';
import { OAuthRockContext } from '../http/oauth.js';
import { formatResponse } from './formatter.js';
import { quoteLinqString, quoteODataString } from '../rock/query.js';

const rockLookupSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('quickSearch'),
    query: z.string().min(1),
    kinds: z.array(z.enum([
      'person',
      'group',
      'groupType',
      'report',
      'entitySearch',
      'workflowType',
      'connectionType',
      'attribute',
      'definedValue'
    ])).optional(),
    limit: z.coerce.number().int().positive().max(50).default(10)
  }),
  z.object({
    action: z.literal('discovery'),
    includeRaw: z.boolean().default(false)
  }),
  z.object({
    action: z.literal('refreshDiscovery'),
    reason: z.string().optional()
  })
]);

export const rockLookupTool: GatewayTool = {
  name: 'rock_lookup',
  title: 'Rock Runtime Discovery & Lookup',
  schemaForMode(_mode: McpMode, _scopes: Set<McpScope>): z.ZodTypeAny | null {
    return rockLookupSchema;
  },
  descriptionForMode(_mode: McpMode): string {
    return 'Enables runtime discovery of Favor concepts and dynamic searches across Rock entities without exposing IDs.';
  },
  async handle(args: any, _extra: any, ctx: OAuthRockContext): Promise<McpToolResult> {
    const parsed = rockLookupSchema.parse(args);

    // Ensure discoveryService is attached to ctx
    const discoveryService = (ctx as any).discoveryService;
    if (!discoveryService) {
      return formatResponse(parsed.action, ctx, null, {
        code: 'MISSING_SERVICE',
        message: 'Discovery service is not initialized in the request context.',
      });
    }

    if (parsed.action === 'discovery') {
      try {
        const map = await discoveryService.getMap(ctx);
        return formatResponse(parsed.action, ctx, map);
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'DISCOVERY_ERROR',
          message: err.message || 'Failed to fetch discovery map.',
        });
      }
    }

    if (parsed.action === 'refreshDiscovery') {
      try {
        await discoveryService.refresh(ctx);
        return formatResponse(parsed.action, ctx, { success: true });
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'REFRESH_ERROR',
          message: err.message || 'Failed to refresh discovery map.',
        });
      }
    }

    if (parsed.action === 'quickSearch') {
      // Mock or call Rock API search
      const rockClient = (ctx as any).rockClient;
      if (!rockClient) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'MISSING_CLIENT',
          message: 'Rock client is not initialized in the request context.',
        });
      }

      try {
        const results: any[] = [];
        const kinds = parsed.kinds || ['person'];
        const query = parsed.query;
        const limit = parsed.limit;

        // Helper to filter by case-insensitive substring match
        const filterByQuery = (candidates: any[]): any[] => {
          return candidates.filter(c =>
            (c.name || '').toLowerCase().includes(query.toLowerCase())
          );
        };

        // 1. Person: Rock people search
        if (kinds.includes('person')) {
          const quoted = quoteLinqString(query);
          try {
            const people = await rockClient.post(ctx, '/api/v2/models/people/search', {
              Where: `NickName.Contains(${quoted}) || LastName.Contains(${quoted})`,
            });
            results.push(...(people || []).map((p: any) => ({
              kind: 'person',
              id: p.Id,
              guid: p.Guid,
              name: `${p.NickName || p.FirstName} ${p.LastName}`,
            })));
          } catch (err: any) {
            // v1 fallback
            try {
              const people = await rockClient.get(ctx, `/api/People?$filter=(substringof(${quoteODataString(query)}, NickName) eq true) or (substringof(${quoteODataString(query)}, LastName) eq true)&$top=${limit}`);
              results.push(...(people || []).map((p: any) => ({
                kind: 'person',
                id: p.Id,
                guid: p.Guid,
                name: `${p.NickName || p.FirstName} ${p.LastName}`,
              })));
            } catch (fallbackErr: any) {
              // Log but don't fail the whole request
              console.error('Failed to search people (v1 fallback):', fallbackErr.message);
            }
          }
        }

        // 2. Group: Rock groups search
        if (kinds.includes('group')) {
          const quoted = quoteLinqString(query);
          try {
            const groups = await rockClient.post(ctx, '/api/v2/models/groups/search', {
              Where: `Name.Contains(${quoted})`,
            }).catch(async () => {
              // v1 fallback
              return await rockClient.get(ctx, `/api/Groups?$filter=substringof(${quoteODataString(query)}, Name) eq true`);
            });
            results.push(...(groups || []).map((g: any) => ({
              kind: 'group',
              id: g.Id,
              guid: g.Guid,
              name: g.Name,
            })));
          } catch (err: any) {
            console.error('Failed to search groups:', err.message);
          }
        }

        // 3. Check if discovery-backed kinds are requested; fetch map once if needed
        const discoveryKinds = ['groupType', 'report', 'entitySearch', 'workflowType', 'connectionType', 'attribute'];
        const needsDiscovery = kinds.some(k => discoveryKinds.includes(k));
        let discoveryMap: any = null;

        if (needsDiscovery) {
          try {
            discoveryMap = await discoveryService.getMap(ctx);
          } catch (err: any) {
            return formatResponse(parsed.action, ctx, null, {
              code: 'DISCOVERY_ERROR',
              message: err.message || 'Failed to fetch discovery map.',
            });
          }
        }

        // 4. groupType: from discovery map (connectGroups + ministryTeams + other)
        if (kinds.includes('groupType') && discoveryMap) {
          const allGroupTypes = [
            ...discoveryMap.groupTypes.connectGroups,
            ...discoveryMap.groupTypes.ministryTeams,
            ...discoveryMap.groupTypes.other,
          ];
          const filtered = filterByQuery(allGroupTypes);
          results.push(...filtered.map((gt: any) => ({
            kind: 'groupType',
            id: gt.id,
            guid: gt.guid,
            name: gt.name,
            confidence: gt.confidence,
            signals: gt.signals,
          })));
        }

        // 5. report: from discovery map
        if (kinds.includes('report') && discoveryMap) {
          const filtered = filterByQuery(discoveryMap.reports || []);
          results.push(...filtered.map((r: any) => ({
            kind: 'report',
            id: r.id,
            guid: r.guid,
            name: r.name,
            confidence: r.confidence,
            signals: r.signals,
          })));
        }

        // 6. entitySearch: from discovery map
        if (kinds.includes('entitySearch') && discoveryMap) {
          const filtered = filterByQuery(discoveryMap.entitySearches || []);
          results.push(...filtered.map((es: any) => ({
            kind: 'entitySearch',
            id: es.id,
            guid: es.guid,
            idKey: es.idKey,
            name: es.name,
            confidence: es.confidence,
            signals: es.signals,
          })));
        }

        // 7. workflowType: from discovery map
        if (kinds.includes('workflowType') && discoveryMap) {
          const filtered = filterByQuery(discoveryMap.workflows || []);
          results.push(...filtered.map((w: any) => ({
            kind: 'workflowType',
            id: w.id,
            guid: w.guid,
            name: w.name,
            confidence: w.confidence,
            signals: w.signals,
          })));
        }

        // 8. connectionType: from discovery map
        if (kinds.includes('connectionType') && discoveryMap) {
          const filtered = filterByQuery(discoveryMap.connectionTypes || []);
          results.push(...filtered.map((ct: any) => ({
            kind: 'connectionType',
            id: ct.id,
            guid: ct.guid,
            name: ct.name,
            confidence: ct.confidence,
            signals: ct.signals,
          })));
        }

        // 9. attribute: from discovery map (concat all attribute arrays)
        if (kinds.includes('attribute') && discoveryMap) {
          const allAttrs = [
            ...discoveryMap.attributes.personLifecycle,
            ...discoveryMap.attributes.personAgeGroup,
            ...discoveryMap.attributes.groupAgeGroup,
            ...discoveryMap.attributes.fluroId,
          ];
          const filtered = filterByQuery(allAttrs);
          results.push(...filtered.map((a: any) => ({
            kind: 'attribute',
            id: a.id,
            guid: a.guid,
            name: a.name,
            confidence: a.confidence,
            signals: a.signals,
          })));
        }

        // 10. definedValue: Rock search with best-effort failure handling
        if (kinds.includes('definedValue')) {
          try {
            const quoted = quoteODataString(query);
            const definedValues = await rockClient.get(ctx, `/api/DefinedValues?$filter=substringof(${quoted}, Value) eq true&$top=${limit}`).catch(async () => {
              // v2 fallback
              return await rockClient.post(ctx, '/api/v2/models/definedvalues/search', {
                Where: `Value.Contains(${quoteLinqString(query)})`,
              });
            });
            results.push(...(definedValues || []).map((dv: any) => ({
              kind: 'definedValue',
              id: dv.Id,
              guid: dv.Guid,
              name: dv.Value,
            })));
          } catch (err: any) {
            // Silently skip definedValue failure; don't error the whole call
            console.error('Failed to search defined values:', err.message);
          }
        }

        return formatResponse(parsed.action, ctx, results.slice(0, limit));
      } catch (err: any) {
        return formatResponse(parsed.action, ctx, null, {
          code: 'SEARCH_ERROR',
          message: err.message || 'Failed to execute quick search.',
        });
      }
    }

    return formatResponse((parsed as any).action, ctx, null, {
      code: 'INVALID_ACTION',
      message: `Action not implemented: ${(parsed as any).action}`,
    });
  },
};
