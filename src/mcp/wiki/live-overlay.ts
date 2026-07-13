import { OAuthRockContext } from '../../http/oauth.js';
import { RockClient } from '../../rock/client.js';
import { getDefinedValueMap } from '../../rock/defined-values.js';
import { countByConnectionStatus } from '../../tools/rock-people.js';
import type { RockDiscoveryMap } from '../../discovery/discovery-service.js';
import { LiveBinding } from './wiki-types.js';

interface DiscoveryCandidateLike {
  id?: number;
  name: string;
  confidence?: number;
}

function renderCandidateList(items: DiscoveryCandidateLike[] | undefined): string {
  if (!items || items.length === 0) return '_None discovered._';
  return items
    .map((c) => {
      const id = c.id != null ? `id ${c.id}` : 'no id';
      const conf = typeof c.confidence === 'number' ? `, confidence ${c.confidence}` : '';
      return `- ${c.name} (${id}${conf})`;
    })
    .join('\n');
}

async function getMapSafe(ctx: OAuthRockContext): Promise<RockDiscoveryMap | null> {
  const ds = (ctx as any).discoveryService;
  if (!ds || typeof ds.getMap !== 'function') return null;
  try {
    return await ds.getMap(ctx);
  } catch {
    return null;
  }
}

async function renderDefinedType(
  binding: Extract<LiveBinding, { kind: 'definedType' }>,
  ctx: OAuthRockContext
): Promise<string | null> {
  const client = (ctx as any).rockClient as RockClient | undefined;
  if (!client) return null;
  const map = await getDefinedValueMap(client, ctx, binding.definedTypeName);
  if (map.size === 0) return null;

  const entries = [...map.entries()];

  if (binding.countsByStatus) {
    const counts = await Promise.allSettled(
      entries.map(([, name]) => countByConnectionStatus(ctx, name))
    );
    const rows = entries.map(([id, name], i) => {
      const r = counts[i];
      const count = r.status === 'fulfilled' && r.value != null ? String(r.value) : '—';
      return `| ${name} | ${id} | ${count} |`;
    });
    return [
      `Current **${binding.definedTypeName}** values and live people counts:`,
      '',
      '| Value | DefinedValue Id | People (live) |',
      '|---|---|---|',
      ...rows,
    ].join('\n');
  }

  const rows = entries.map(([id, name]) => `| ${name} | ${id} |`);
  return [
    `Current **${binding.definedTypeName}** values:`,
    '',
    '| Value | DefinedValue Id |',
    '|---|---|',
    ...rows,
  ].join('\n');
}

/**
 * Render a markdown "Live values" block for a wiki topic's `liveBinding`, or
 * `null` if there is nothing to add. Read-only and never throws — on any
 * failure it degrades to a short note so the curated article still renders.
 */
export async function renderLiveOverlay(
  binding: LiveBinding,
  ctx: OAuthRockContext
): Promise<string | null> {
  try {
    let block: string | null = null;
    let asOf = 'now';

    if (binding.kind === 'definedType') {
      block = await renderDefinedType(binding, ctx);
    } else {
      const map = await getMapSafe(ctx);
      if (!map) {
        return '\n---\n\n## Live values\n\n_Live overlay unavailable (discovery not initialized)._';
      }
      asOf = map.generatedAt ?? 'now';
      switch (binding.kind) {
        case 'groupType':
          block = renderCandidateList(map.groupTypes?.[binding.match]);
          break;
        case 'attribute':
          block = renderCandidateList(map.attributes?.[binding.match]);
          break;
        case 'campuses':
          block = renderCandidateList(map.campuses);
          break;
        case 'connectionTypes':
          block = renderCandidateList(map.connectionTypes);
          break;
        case 'workflows':
          block = renderCandidateList(map.workflows);
          break;
        case 'reports':
          block = renderCandidateList(map.reports);
          break;
      }
    }

    if (!block) {
      return '\n---\n\n## Live values\n\n_Live overlay unavailable right now._';
    }

    return `\n---\n\n## Live values (as of ${asOf})\n\n${block}\n\n_Live data reflects the current discovery snapshot; the curated guidance above is authoritative for process._`;
  } catch {
    return '\n---\n\n## Live values\n\n_Live overlay unavailable right now._';
  }
}
