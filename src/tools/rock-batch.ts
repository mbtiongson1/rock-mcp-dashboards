import { z } from 'zod';
import { GatewayTool, McpToolResult } from './types.js';
import { McpMode, McpScope } from '../mcp/modes.js';
import { OAuthRockContext } from '../http/oauth.js';
import { formatResponse } from './formatter.js';
import { extractActionNames, describeToolValidationError } from './schema-utils.js';

// Import each delegatable tool directly (NOT via ./index.js) to avoid a circular
// import: index.ts pulls rock_batch into `allTools`, so rock_batch must not
// depend on index.ts. A test asserts this list stays in sync with `allTools`.
import { rockUsageTool } from './rock-usage.js';
import { rockLookupTool } from './rock-lookup.js';
import { rockEntityTool } from './rock-entity.js';
import { rockPeopleTool } from './rock-people.js';
import { rockMinistryTool } from './rock-ministry.js';
import { rockReportTool } from './rock-report.js';
import { rockWorkflowTool } from './rock-workflow.js';
import { rockWriteTool } from './rock-write.js';
import { rockRosterTool } from './rock-roster.js';

/** The tools a batch operation may target — every gateway tool except rock_batch itself. */
export const DELEGATABLE_TOOLS: GatewayTool[] = [
  rockUsageTool,
  rockLookupTool,
  rockEntityTool,
  rockPeopleTool,
  rockMinistryTool,
  rockReportTool,
  rockWorkflowTool,
  rockWriteTool,
  rockRosterTool,
];

const TOOL_NAMES = DELEGATABLE_TOOLS.map((t) => t.name) as [string, ...string[]];
const toolsByName = new Map(DELEGATABLE_TOOLS.map((t) => [t.name, t]));

/** Total operations allowed per batch. Each write item still passes its tool's own authz + bulk bounds. */
const BATCH_MAX = Number(process.env.ROCK_MCP_BATCH_MAX) || 25;

/** One operation's outcome. Input-ordered, best-effort: one failure never fails its siblings. */
export interface BatchOperationResult {
  ok: boolean;
  tool: string;
  action: string;
  result?: unknown;
  warning?: string;
  error?: unknown;
}

export interface BatchItem<T> {
  /** Writes run serially in input order; reads run in parallel. */
  isWrite: boolean;
  run: () => Promise<T>;
  /** Build a result from an unexpected throw so the batch never rejects. */
  onError: (err: unknown) => T;
}

/**
 * Execute batch items with the confirmed policy: reads in parallel, writes
 * serialized in input order (avoids Rock write races, e.g. duplicate
 * AttendanceOccurrence keys). Results are written by original index, so the
 * output is always aligned positionally with the input regardless of
 * completion order. `run()` failures are isolated via `onError`.
 */
export async function runBatch<T>(items: BatchItem<T>[]): Promise<T[]> {
  const results = new Array<T>(items.length);
  const parallel: Promise<void>[] = [];
  let writeChain: Promise<void> = Promise.resolve();

  items.forEach((item, index) => {
    const runOne = async (): Promise<void> => {
      try {
        results[index] = await item.run();
      } catch (err) {
        results[index] = item.onError(err);
      }
    };
    if (item.isWrite) {
      // Duplicated callback: a prior item's rejection still lets the chain continue.
      writeChain = writeChain.then(runOne, runOne);
    } else {
      parallel.push(runOne());
    }
  });

  await Promise.all([...parallel, writeChain]);
  return results;
}

// Read-action names per tool, derived from each tool's read-only surface. An
// action absent here (or a tool with no read-only surface) classifies as a
// write → serial, the safe default.
const readActionCache = new Map<string, Set<string>>();
function readActionsFor(tool: GatewayTool): Set<string> {
  let set = readActionCache.get(tool.name);
  if (!set) {
    const roSchema = tool.schemaForMode('readonly', new Set<McpScope>(['read']), {
      isAdmin: true,
      isStaffOrAdmin: true,
    });
    set = new Set(roSchema ? extractActionNames(roSchema) : []);
    readActionCache.set(tool.name, set);
  }
  return set;
}

function batchThrowError(tool: string, action: string, err: unknown): BatchOperationResult {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, tool, action, error: { code: 'BATCH_ITEM_ERROR', message } };
}

const operationSchema = z
  .object({
    tool: z.enum(TOOL_NAMES).describe('Target rock-mcp tool to invoke for this operation.'),
    action: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The action to run on the target tool (required by every tool except rock_usage). See the target tool for its valid actions."
      ),
  })
  .passthrough(); // remaining keys are the action's params, forwarded verbatim to the tool.

const rockBatchSchema = z.object({
  operations: z
    .array(operationSchema)
    .min(1)
    .max(BATCH_MAX)
    .describe(
      `Operations to execute (1-${BATCH_MAX}). Read operations run in parallel; write operations run serially in the given order. Each returns an independent { ok, tool, action, result | error } envelope; one failing operation never fails the others.`
    ),
});

export const rockBatchTool: GatewayTool = {
  name: 'rock_batch',
  title: 'Rock Batch Operations',
  schemaForMode(_mode: McpMode, _scopes: Set<McpScope>, _caps: { isAdmin: boolean; isStaffOrAdmin: boolean }): z.ZodTypeAny {
    // Available in every mode: read-only callers still benefit from batched
    // reads, and a write item submitted in read-only mode delegates to the
    // target tool, whose write branch fails closed with its own error.
    return rockBatchSchema;
  },
  descriptionForMode(_mode: McpMode): string {
    return (
      `Run multiple rock-mcp operations in one call. Provide an "operations" array; each item names a target ` +
      `{ tool, action, ...params } and is dispatched to that tool exactly as if called directly — same validation, ` +
      `write authorization, dryRun/commit semantics, and audit logging. Reads run in parallel; writes run serially in ` +
      `the given order (max ${BATCH_MAX} operations). Consult each target tool for its valid actions and parameters. ` +
      `Results come back input-ordered as { ok, tool, action, result | error }; one failing operation never fails the others. ` +
      `Write operations attempted in a read-only session return that tool's authorization error.`
    );
  },
  async handle(args: any, extra: any, ctx: OAuthRockContext): Promise<McpToolResult> {
    const parsed = rockBatchSchema.parse(args);
    const caps = {
      isAdmin: ctx.rockUser.isRsrAdmin,
      isStaffOrAdmin: ctx.rockUser.isRsrAdmin || ctx.rockUser.isStaff,
    };

    const items: BatchItem<BatchOperationResult>[] = parsed.operations.map((op) => {
      const { tool: toolName, ...rest } = op as { tool: string; [k: string]: unknown };
      const action = typeof rest.action === 'string' ? rest.action : 'unknown';
      const target = toolsByName.get(toolName);
      // Unknown target (defensive; the enum normally rejects it) or non-read action → serial.
      const isWrite = target ? !readActionsFor(target).has(action) : true;

      return {
        isWrite,
        onError: (err: unknown) => batchThrowError(toolName, action, err),
        run: async (): Promise<BatchOperationResult> => {
          if (!target) {
            return {
              ok: false,
              tool: toolName,
              action,
              error: { code: 'UNKNOWN_TOOL', message: `Unknown tool '${toolName}'.` },
            };
          }
          const visible = target.schemaForMode(ctx.mode, ctx.scopes, caps);
          if (!visible) {
            return {
              ok: false,
              tool: toolName,
              action,
              error: {
                code: 'TOOL_NOT_AVAILABLE',
                message: `Tool '${toolName}' is not available in ${ctx.mode} mode.`,
              },
            };
          }
          try {
            const res = await target.handle(rest, extra, ctx);
            return unwrapDelegatedResult(toolName, action, res);
          } catch (err) {
            if (err instanceof z.ZodError) {
              return {
                ok: false,
                tool: toolName,
                action,
                error: {
                  code: 'INVALID_ARGUMENTS',
                  message: describeToolValidationError(toolName, err, visible, rest),
                },
              };
            }
            throw err; // isolated by runBatch → onError
          }
        },
      };
    });

    const results = await runBatch(items);
    const failed = results.filter((r) => !r.ok).length;
    return formatResponse('batch', ctx, {
      count: results.length,
      succeeded: results.length - failed,
      failed,
      operations: results,
    });
  },
};

/**
 * Turn a delegated tool's McpToolResult into a batch envelope. Most tools
 * return a JSON `formatResponse` envelope, but some (rock_usage guide/topic,
 * report viewer resources) return raw text/resource content — pass those
 * through verbatim rather than failing to JSON.parse them.
 */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function unwrapDelegatedResult(tool: string, action: string, res: McpToolResult): BatchOperationResult {
  const envelope = tryParseJson(res.content?.[0]?.text ?? '');

  if (envelope && typeof envelope === 'object' && 'ok' in (envelope as Record<string, unknown>)) {
    const env = envelope as { ok: boolean; result?: unknown; warning?: string; error?: unknown };
    return env.ok
      ? { ok: true, tool, action, result: env.result, warning: env.warning }
      : { ok: false, tool, action, error: env.error };
  }

  // Non-envelope content (raw text / resource blocks): pass through, honoring isError.
  return { ok: !res.isError, tool, action, result: res.content };
}
