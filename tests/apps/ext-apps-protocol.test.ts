import { App, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/ext-apps';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

class InMemoryHostTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly received: JSONRPCMessage[] = [];

  async start() {}

  async send(message: JSONRPCMessage) {
    this.received.push(message);
    if (!('id' in message) || !('method' in message)) return;

    const result = message.method === 'ui/initialize'
      ? {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          hostInfo: { name: 'Rock test host', version: '1.0.0' },
          hostCapabilities: { serverTools: {} },
          hostContext: { theme: 'dark', platform: 'web' },
        }
      : message.method === 'tools/call'
        ? {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ ok: true, result: { datasetId: 'dataset-123' } }),
              },
            ],
          }
        : {};

    queueMicrotask(() => {
      this.onmessage?.({ jsonrpc: '2.0', id: message.id, result } as JSONRPCMessage);
    });
  }

  async close() {
    this.onclose?.();
  }

  notifyToolResult(datasetId: string) {
    this.onmessage?.({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, result: { datasetId } }),
          },
        ],
      },
    });
  }
}

describe('ext-apps 1.7 protocol compatibility', () => {
  it('negotiates the current UI protocol, receives tool results, and round-trips tools/call', async () => {
    const transport = new InMemoryHostTransport();
    const app = new App(
      { name: 'Rock Report Viewer', version: '1.0.0' },
      {},
      { autoResize: false, strict: true },
    );
    const onToolResult = vi.fn();
    app.ontoolresult = onToolResult;

    await app.connect(transport);

    expect(transport.received).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'ui/initialize',
        params: expect.objectContaining({
          protocolVersion: LATEST_PROTOCOL_VERSION,
          appInfo: { name: 'Rock Report Viewer', version: '1.0.0' },
        }),
      }),
      expect.objectContaining({ method: 'ui/notifications/initialized' }),
    ]));

    transport.notifyToolResult('pushed-dataset');
    await vi.waitFor(() => {
      expect(onToolResult).toHaveBeenCalledWith(expect.objectContaining({
        content: [
          expect.objectContaining({ text: expect.stringContaining('pushed-dataset') }),
        ],
      }));
    });

    const result = await app.callServerTool({
      name: 'rock_report',
      arguments: { action: 'summary', datasetId: 'dataset-123', includeRows: true },
    });
    expect(result.content[0]).toEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('dataset-123'),
    }));
    expect(transport.received).toContainEqual(expect.objectContaining({
      method: 'tools/call',
      params: expect.objectContaining({
        name: 'rock_report',
        arguments: { action: 'summary', datasetId: 'dataset-123', includeRows: true },
      }),
    }));

    await app.close();
  });
});
