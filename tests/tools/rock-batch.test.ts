import { describe, it, expect } from 'vitest';
import { rockBatchTool, runBatch, DELEGATABLE_TOOLS, BatchItem } from '../../src/tools/rock-batch.js';
import { allTools } from '../../src/tools/index.js';
import { rockMinistryTool } from '../../src/tools/rock-ministry.js';
import { extractActionNames, flattenUnionForAdvertisement } from '../../src/tools/schema-utils.js';
import { OAuthRockContext } from '../../src/http/oauth.js';

/** Parse a tool result's single JSON text block. */
function body(result: any): any {
  return JSON.parse(result.content[0].text as string);
}

function readonlyCtx(overrides: Partial<any> = {}): OAuthRockContext {
  return {
    endpoint: 'mcp',
    mode: 'readonly',
    scopes: new Set(['read']),
    oauth: { subject: 'test-user' },
    rockUser: { personId: 123, isRsrAdmin: false, isStaff: true, ledGroupIds: [] },
    request: { sessionId: 'session-123', requestId: 'req-1' },
    ...overrides,
  } as unknown as OAuthRockContext;
}

describe('runBatch executor', () => {
  it('preserves input order regardless of completion order', async () => {
    const items: BatchItem<number>[] = [200, 5, 100].map((delay, i) => ({
      isWrite: false,
      onError: () => -1,
      run: async () => {
        await new Promise((r) => setTimeout(r, delay));
        return i;
      },
    }));

    const results = await runBatch(items);
    expect(results).toEqual([0, 1, 2]);
  });

  it('isolates a throwing item without failing its siblings', async () => {
    const items: BatchItem<string>[] = [
      { isWrite: false, onError: () => 'err', run: async () => 'a' },
      { isWrite: false, onError: (e) => `caught:${(e as Error).message}`, run: async () => { throw new Error('boom'); } },
      { isWrite: false, onError: () => 'err', run: async () => 'c' },
    ];

    const results = await runBatch(items);
    expect(results).toEqual(['a', 'caught:boom', 'c']);
  });

  it('runs reads in parallel and writes serially', async () => {
    let readActive = 0;
    let maxReadActive = 0;
    let writeActive = 0;
    let maxWriteActive = 0;

    const make = (isWrite: boolean): BatchItem<null> => ({
      isWrite,
      onError: () => null,
      run: async () => {
        if (isWrite) {
          writeActive++;
          maxWriteActive = Math.max(maxWriteActive, writeActive);
        } else {
          readActive++;
          maxReadActive = Math.max(maxReadActive, readActive);
        }
        await new Promise((r) => setTimeout(r, 10));
        if (isWrite) writeActive--;
        else readActive--;
        return null;
      },
    });

    // interleave reads and writes in input order
    await runBatch([make(false), make(true), make(false), make(true), make(false), make(true)]);

    expect(maxReadActive).toBe(3); // reads overlap
    expect(maxWriteActive).toBe(1); // writes never overlap
  });
});

describe('rock_batch tool', () => {
  it('stays in sync with allTools (every tool except rock_batch is delegatable)', () => {
    const expected = allTools.map((t: any) => t.name).filter((n: string) => n !== 'rock_batch').sort();
    const actual = DELEGATABLE_TOOLS.map((t) => t.name).sort();
    expect(actual).toEqual(expected);
    expect(actual).not.toContain('rock_batch'); // no recursion
  });

  it('advertises a non-empty object schema with an operations array', () => {
    const schema: any = rockBatchTool.schemaForMode('readwrite', new Set(['read', 'write']), {
      isAdmin: true,
      isStaffOrAdmin: true,
    });
    // Advertised via the same path register-tools uses. Not a discriminated
    // union, so the flattener returns it unchanged (no empty-schema pitfall).
    const advertised: any = flattenUnionForAdvertisement(schema);
    expect(Object.keys(advertised.shape)).toContain('operations');
  });

  it('classifies read actions as parallel and write actions as serial via the read-only surface', () => {
    // The tool derives read-vs-write from each tool's read-only action set.
    const readActions = extractActionNames(
      rockMinistryTool.schemaForMode('readonly', new Set(['read']), { isAdmin: true, isStaffOrAdmin: true })!
    );
    expect(readActions).toContain('groups'); // read → parallel-eligible
    expect(readActions).not.toContain('addOrUpdateGroupMember'); // write → serial
  });

  it('delegates a read operation and wraps raw (non-JSON) content', async () => {
    const ctx = readonlyCtx();
    const result = await rockBatchTool.handle(
      { operations: [{ tool: 'rock_usage', action: 'guide' }] },
      null,
      ctx
    );

    const payload = body(result);
    expect(payload.ok).toBe(true);
    expect(payload.action).toBe('batch');
    expect(payload.result.count).toBe(1);
    expect(payload.result.operations[0].ok).toBe(true);
    expect(payload.result.operations[0].tool).toBe('rock_usage');
  });

  it('returns TOOL_NOT_AVAILABLE for a write-only tool in read-only mode without mutating', async () => {
    const ctx = readonlyCtx(); // rock_write is hidden (schemaForMode → null) in readonly
    const result = await rockBatchTool.handle(
      { operations: [{ tool: 'rock_write', action: 'create', model: 'Person', reason: 'x' }] },
      null,
      ctx
    );

    const op = body(result).result.operations[0];
    expect(op.ok).toBe(false);
    expect(op.error.code).toBe('TOOL_NOT_AVAILABLE');
  });

  it('isolates a per-operation failure while succeeding its siblings', async () => {
    const ctx = readonlyCtx();
    const result = await rockBatchTool.handle(
      {
        operations: [
          { tool: 'rock_usage', action: 'guide' },
          { tool: 'rock_write', action: 'create' }, // unavailable in readonly → error item
        ],
      },
      null,
      ctx
    );

    const payload = body(result);
    expect(payload.result.operations[0].ok).toBe(true);
    expect(payload.result.operations[1].ok).toBe(false);
    expect(payload.result.failed).toBe(1);
  });
});
