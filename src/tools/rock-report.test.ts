import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-ignore
import { rockReportTool } from './rock-report.js';
// @ts-ignore
import { OAuthRockContext } from '../http/oauth.js';
// @ts-ignore
import { InMemoryDatasetStore } from './dataset-store.js';

describe('rock_report tool', () => {
  let mockClient: any;
  let mockCtx: any;
  let datasetStore: any;

  beforeEach(() => {
    mockClient = {
      get: vi.fn(),
      post: vi.fn(),
    };

    datasetStore = new InMemoryDatasetStore();

    mockCtx = {
      mode: 'readonly',
      rockClient: mockClient,
      datasetStore,
      oauth: {
        subject: 'user-123',
      },
      rockUser: {},
      request: {},
    } as unknown as OAuthRockContext;
  });

  it('runs a report via its DataView when the report has one (Rock 17.x)', async () => {
    mockClient.get = vi.fn().mockImplementation(async (_ctx, path) => {
      if (path === '/api/Reports/42') {
        return { Id: 42, Name: 'Pending Individuals', DataViewId: 4, EntityTypeId: 15 };
      }
      if (path === '/api/EntityTypes/15') {
        return { Id: 15, Name: 'Rock.Model.Person' };
      }
      if (path.startsWith('/api/People/DataView/4')) {
        return [{ Id: 7228, FirstName: 'Sam' }];
      }
      throw new Error(`Unexpected path ${path}`);
    });

    const result = await rockReportTool.handle({ action: 'run', reportId: 42, limit: 10 }, null, mockCtx);
    const response = JSON.parse(result.content[0].text!);

    expect(response.ok).toBe(true);
    expect(response.result.rowCount).toBe(1);
    expect(mockClient.get).toHaveBeenCalledWith(mockCtx, '/api/People/DataView/4?$top=10');
  });

  it('should run report and return preview & datasetId', async () => {
    mockClient.get.mockResolvedValue([
      { Id: 1, Name: 'Active Members Report', Category: { Name: 'Ministry' } },
    ]);

    // Query for listing reports
    const resultList = await rockReportTool.handle({ action: 'list' }, null, mockCtx);
    const listResponse = JSON.parse(resultList.content[0].text!);
    expect(listResponse.ok).toBe(true);

    // Mock query result for run report
    mockClient.get = vi.fn().mockImplementation(async (_ctx, path) => {
      if (path.includes('/api/Reports/run/')) {
        // Run report output
        return [
          { Id: 1, Name: 'Alex Santos', Status: 'Core' },
          { Id: 2, Name: 'Maria Santos', Status: 'Crowd' },
        ];
      }
      if (path.includes('/api/Reports/')) {
        return { Id: 42, Name: 'Favor Connection Report' };
      }
      return [];
    });

    const resultRun = await rockReportTool.handle(
      { action: 'run', reportId: 42 },
      null,
      mockCtx
    );

    const runResponse = JSON.parse(resultRun.content[0].text!);
    expect(runResponse.ok).toBe(true);
    expect(runResponse.result.rowCount).toBe(2);
    expect(runResponse.result.datasetId).toBeDefined();

    // Verify we can query summary for the dataset
    const resultSummary = await rockReportTool.handle(
      { action: 'summary', datasetId: runResponse.result.datasetId, includeRows: true },
      null,
      mockCtx
    );

    const summaryResponse = JSON.parse(resultSummary.content[0].text!);
    expect(summaryResponse.ok).toBe(true);
    expect(summaryResponse.result.rows).toHaveLength(2);
  });
});
