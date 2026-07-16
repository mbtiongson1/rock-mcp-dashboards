import { z } from 'zod';
import { GatewayTool, McpToolResult } from './types.js';
import { McpMode, McpScope } from '../mcp/modes.js';
import { OAuthRockContext } from '../http/oauth.js';
import { getRockGuideText } from '../mcp/guide-text.js';
import { USAGE_NUDGE } from './usage-nudge.js';
import { formatResponse } from './formatter.js';
import { getTopic, listTopics, searchTopics } from '../mcp/wiki/wiki-store.js';
import { renderLiveOverlay } from '../mcp/wiki/live-overlay.js';

const WIKI_HINT =
  'This tool also doubles as a searchable Rock wiki: call with `{list:true}` to see best-practice topics, `{query:"..."}` to search them, or `{topic:"connection-status"}` to read one (with current live values).';

export const rockUsageTool: GatewayTool = {
  name: 'rock_usage',
  title: 'Rock Usage Guide',
  schemaForMode(
    _mode: McpMode,
    _scopes: Set<McpScope>,
    _caps: { isAdmin: boolean; isStaffOrAdmin: boolean }
  ): z.ZodTypeAny | null {
    // Plain optional-fields object: an empty object ({}) stays valid so the
    // default "no args → full guide" contract holds. Optional params turn the
    // tool into a searchable best-practices wiki.
    return z.object({
      topic: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Fetch one wiki article by id or alias, e.g. 'connection-status'. Returns curated guidance plus current live values when available."
        ),
      query: z
        .string()
        .min(1)
        .optional()
        .describe('Search the Rock best-practices wiki across titles, aliases, tags, and body. Returns ranked matches.'),
      list: z
        .boolean()
        .optional()
        .describe('List all available wiki topics (id, title, tags) to discover what guidance exists.'),
    });
  },
  descriptionForMode(mode: McpMode): string {
    return `${getRockGuideText(mode)}\n\n${USAGE_NUDGE}\n\n${WIKI_HINT}`;
  },
  async handle(args: any, _extra: any, ctx: OAuthRockContext): Promise<McpToolResult> {
    const mode = ctx.mode ?? 'readonly';
    const topic = typeof args?.topic === 'string' ? args.topic : undefined;
    const query = typeof args?.query === 'string' ? args.query : undefined;
    const list = args?.list === true;

    // Precedence: topic → query → list → default full guide.
    if (topic) {
      const article = getTopic(topic);
      if (!article) {
        const available = listTopics().map((t) => t.id);
        return formatResponse('topic', ctx, null, {
          code: 'TOPIC_NOT_FOUND',
          message: `No wiki topic '${topic}'. Use {list:true} to see topics.`,
          details: { available },
        });
      }
      let text = `# ${article.frontMatter.title}\n\n${article.body}`;
      if (article.frontMatter.liveBinding) {
        const overlay = await renderLiveOverlay(article.frontMatter.liveBinding, ctx);
        if (overlay) text += overlay;
      }
      return { content: [{ type: 'text', text }] };
    }

    if (query) {
      return formatResponse('query', ctx, searchTopics(query));
    }

    if (list) {
      return formatResponse('list', ctx, listTopics());
    }

    // Default: full usage guide (unchanged).
    return {
      content: [
        {
          type: 'text',
          text: `${getRockGuideText(mode)}\n\n${describeWriteAccess(ctx)}`,
        },
      ],
    };
  },
};

/**
 * Explain why the current session is read-only or read-write. On the `/mcp`
 * auto endpoint, write access requires the `write` scope AND (RSR-admin status
 * OR leading at least one group), so surface all three signals to make
 * "why can't I write?" diagnosable.
 */
function describeWriteAccess(ctx: OAuthRockContext): string {
  const scopes = [...(ctx.scopes ?? [])];
  const hasWrite = ctx.scopes?.has('write') ?? false;
  const isAdmin = ctx.rockUser?.isRsrAdmin ?? false;
  const lines = [
    'Write access diagnostics:',
    `- endpoint: ${ctx.endpoint}`,
    `- mode: ${ctx.mode}`,
    `- scopes: ${scopes.length ? scopes.join(', ') : '(none)'}`,
    `- write scope: ${hasWrite ? 'yes' : 'no'}`,
    `- isRsrAdmin: ${isAdmin ? 'yes' : 'no'}`,
    `- resolved personId: ${ctx.rockUser?.personId ?? '(unresolved)'}`,
  ];
  if (ctx.mode !== 'readwrite') {
    if (ctx.endpoint === 'mcp') {
      lines.push(
        `Read-only because ${!hasWrite ? 'the token lacks the write scope' : 'the user is neither an RSR admin nor an active group leader'}. The /mcp endpoint upgrades to readwrite only with write scope AND (RSR-admin membership OR leading at least one group).`
      );
    } else {
      lines.push('This is the readonly endpoint; connect via /mcp for write access.');
    }
  }
  return lines.join('\n');
}
