import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-ignore
import { rockReportTool } from '../../src/tools/rock-report.js';
// @ts-ignore
import { OAuthRockContext } from '../../src/http/oauth.js';
// @ts-ignore
import { InMemoryDatasetStore } from '../../src/tools/dataset-store.js';
// @ts-ignore
import { clearDefinedValueCache } from '../../src/rock/defined-values.js';

describe('rock_report tool', () => {
  let mockClient: any;
  let mockCtx: any;
  let datasetStore: any;

  beforeEach(() => {
    // Clear DefinedValue cache before each test
    clearDefinedValueCache();

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
        return [{ Id: 7228, FirstName: 'Sam', LastName: 'Lee', Email: 'sam@example.com', BirthDate: '2000-01-01' }];
      }
      throw new Error(`Unexpected path ${path}`);
    });

    const result = await rockReportTool.handle({ action: 'run', reportId: 42, limit: 10 }, null, mockCtx);
    const response = JSON.parse(result.content[0].text!);

    expect(response.ok).toBe(true);
    expect(response.result.rowCount).toBe(1);
    expect(mockClient.get).toHaveBeenCalledWith(mockCtx, '/api/People/DataView/4?$top=10');

    // Person rows must be privacy-projected: no email/birthdate in report output
    expect(response.result.previewRows[0].FullName).toBe('Sam Lee');
    expect(response.result.previewRows[0].Email).toBeUndefined();
    expect(response.result.previewRows[0].BirthDate).toBeUndefined();
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

  it('includes resolved ConnectionStatus and RecordStatus names in DataView rows', async () => {
    mockClient.get = vi.fn().mockImplementation(async (_ctx, path) => {
      if (path === '/api/Reports/42') {
        return { Id: 42, Name: 'People Report', DataViewId: 4, EntityTypeId: 15 };
      }
      if (path === '/api/EntityTypes/15') {
        return { Id: 15, Name: 'Rock.Model.Person' };
      }
      if (path.startsWith('/api/People/DataView/4')) {
        return [
          {
            Id: 7228,
            FirstName: 'Sam',
            LastName: 'Lee',
            ConnectionStatusValueId: 67,
            RecordStatusValueId: 3,
          },
        ];
      }
      if (path.includes('Connection Status')) {
        return [{ Id: 40 }]; // DefinedTypes lookup
      }
      if (path.includes('Record Status')) {
        return [{ Id: 12 }]; // DefinedTypes lookup
      }
      if (path.includes('DefinedTypeId eq 40')) {
        return [
          { Id: 67, Value: 'Member' },
          { Id: 68, Value: 'Visitor' },
        ];
      }
      if (path.includes('DefinedTypeId eq 12')) {
        return [
          { Id: 3, Value: 'Active' },
          { Id: 4, Value: 'Inactive' },
        ];
      }
      throw new Error(`Unexpected path ${path}`);
    });

    const result = await rockReportTool.handle({ action: 'run', reportId: 42, limit: 10 }, null, mockCtx);
    const response = JSON.parse(result.content[0].text!);

    expect(response.ok).toBe(true);
    expect(response.result.previewRows[0].ConnectionStatusValueId).toBe(67);
    expect(response.result.previewRows[0].ConnectionStatus).toBe('Member');
    expect(response.result.previewRows[0].RecordStatusValueId).toBe(3);
    expect(response.result.previewRows[0].RecordStatus).toBe('Active');
  });
});
