// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  app: null as any,
  connectPromise: null as Promise<void> | null,
  resolveConnect: null as (() => void) | null,
  events: [] as string[],
}));

vi.mock('@modelcontextprotocol/ext-apps', () => ({
  App: class FakeApp {
    ontoolresult?: (result: any) => void;

    constructor() {
      harness.app = this;
    }

    connect = vi.fn(() => {
      harness.events.push(`connect:${typeof this.ontoolresult}`);
      return harness.connectPromise;
    });

    callServerTool = vi.fn(async (request: any) => {
      harness.events.push(`call:${request.arguments.action}`);
      if (request.arguments.action === 'export') {
        const result = request.arguments.format === 'csv'
          ? 'Name,Status\nZoe,Active\nAnna,Inactive'
          : [
              { Name: 'Zoe', Status: 'Active' },
              { Name: 'Anna', Status: 'Inactive' },
            ];
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, result }) }],
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              result: {
                title: 'Attendance',
                createdAt: '2026-07-13T00:00:00.000Z',
                columns: ['Name', 'Status'],
                rows: [
                  { Name: 'Zoe', Status: 'Active' },
                  { Name: 'Anna', Status: 'Inactive' },
                ],
              },
            }),
          },
        ],
      };
    });
  },
}));

function installReportViewerDom() {
  document.body.innerHTML = `
    <h1 id="report-title">Rock Report</h1>
    <p id="report-subtitle">Loading dataset...</p>
    <button id="btn-refresh">Refresh</button>
    <button id="btn-export-csv">Export CSV</button>
    <button id="btn-export-json">Export JSON</button>
    <div id="stat-total">0</div>
    <div id="stat-cols">0</div>
    <input id="search-box" />
    <table>
      <thead><tr id="table-headers"></tr></thead>
      <tbody id="table-body"></tbody>
    </table>
  `;
  window.history.replaceState({}, '', '/?datasetId=dataset-123');
}

describe('report viewer MCP App lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    installReportViewerDom();
    harness.events = [];
    harness.connectPromise = new Promise<void>((resolve) => {
      harness.resolveConnect = resolve;
    });
  });

  it('registers one-shot handlers before connect and waits for the 1.7 handshake before calling tools', async () => {
    await import('../../src/apps/report-viewer/report-viewer.js');

    expect(harness.events).toEqual(['connect:function']);
    expect(harness.app.callServerTool).not.toHaveBeenCalled();

    harness.resolveConnect!();

    await vi.waitFor(() => {
      expect(harness.app.callServerTool).toHaveBeenCalledWith({
        name: 'rock_report',
        arguments: {
          action: 'summary',
          datasetId: 'dataset-123',
          includeRows: true,
        },
      });
    });
  });

  it('renders initial results and keeps sorting, search, and exports working', async () => {
    const createObjectURL = vi.fn(() => 'blob:report-export');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const downloadNames: string[] = [];
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadNames.push(this.getAttribute('download') ?? '');
    });

    await import('../../src/apps/report-viewer/report-viewer.js');
    harness.resolveConnect!();

    await vi.waitFor(() => {
      expect(document.querySelectorAll('#table-body tr')).toHaveLength(2);
    });

    harness.app.ontoolresult({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ result: { datasetId: 'pushed-dataset' } }),
        },
      ],
    });
    await vi.waitFor(() => {
      expect(harness.app.callServerTool).toHaveBeenCalledWith(
        expect.objectContaining({
          arguments: expect.objectContaining({ datasetId: 'pushed-dataset' }),
        }),
      );
    });

    const nameHeader = document.querySelector<HTMLElement>('th[data-column="Name"]')!;
    nameHeader.click();
    expect([...document.querySelectorAll('#table-body tr')].map((row) => row.textContent)).toEqual([
      'AnnaInactive',
      'ZoeActive',
    ]);
    document.querySelector<HTMLElement>('th[data-column="Name"]')!.click();
    expect([...document.querySelectorAll('#table-body tr')].map((row) => row.textContent)).toEqual([
      'ZoeActive',
      'AnnaInactive',
    ]);

    const search = document.querySelector<HTMLInputElement>('#search-box')!;
    search.value = 'anna';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect([...document.querySelectorAll('#table-body tr')].map((row) => row.textContent)).toEqual([
      'AnnaInactive',
    ]);

    document.querySelector<HTMLButtonElement>('#btn-export-csv')!.click();
    await vi.waitFor(() => {
      expect(harness.app.callServerTool).toHaveBeenCalledWith({
        name: 'rock_report',
        arguments: { action: 'export', datasetId: 'pushed-dataset', format: 'csv' },
      });
    });
    await vi.waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1));
    expect(downloadNames[0]).toBe('export_pushed-dataset.csv');

    document.querySelector<HTMLButtonElement>('#btn-export-json')!.click();
    await vi.waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(2));
    expect(downloadNames[1]).toBe('export_pushed-dataset.json');
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });
});
