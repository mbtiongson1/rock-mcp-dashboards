import { App } from '@modelcontextprotocol/ext-apps';
import { escapeHtml } from './escape-html.js';

// Initialize the App
const app = new App({ name: 'Rock Report Viewer', version: '1.0.0' });

let currentRows: Record<string, any>[] = [];
let currentColumns: string[] = [];
let datasetId: string | null = null;
let currentSortColumn: string | null = null;
let currentSortDir: 'asc' | 'desc' = 'asc';
let currentSearchQuery: string = '';

// Connect to MCP Host
app.connect();

// Resolve from URL query parameters
const urlParams = new URLSearchParams(window.location.search);
datasetId = urlParams.get('datasetId');

if (datasetId) {
  loadDataset(datasetId);
}

// Handler for tool execution events if pushed from host.
// Per MCP Apps spec (ext-apps v0.3.0), ontoolresult receives a CallToolResult
// which has content: ContentBlock[]. We extract the JSON envelope from content[0].text
// and parse the datasetId from the result.
app.ontoolresult = (result: any) => {
  try {
    if (result && result.content && Array.isArray(result.content) && result.content.length > 0) {
      const textContent = result.content[0];
      if (textContent && typeof textContent.text === 'string') {
        const envelope = JSON.parse(textContent.text);
        if (envelope && envelope.result && envelope.result.datasetId) {
          datasetId = envelope.result.datasetId;
          loadDataset(datasetId!);
        }
      }
    }
  } catch {
    // If parsing fails, datasetId from URL will be used
  }
};

async function loadDataset(id: string) {
  const subtitle = document.getElementById('report-subtitle');
  if (subtitle) subtitle.textContent = 'Loading dataset...';

  try {
    const response = await app.callServerTool({
      name: 'rock_report',
      arguments: {
        action: 'summary',
        datasetId: id,
        includeRows: true,
      },
    });

    // Parse Response
    const text = (response.content?.[0] as any)?.text;
    if (!text) {
      throw new Error('No content received from server');
    }

    const payload = JSON.parse(text);
    if (!payload.ok || !payload.result) {
      throw new Error(payload.error?.message || 'Failed to fetch dataset');
    }

    const result = payload.result;
    currentRows = result.rows || [];
    currentColumns = result.columns || [];
    currentSortColumn = null;
    currentSortDir = 'asc';
    currentSearchQuery = '';

    // Reset search box
    const searchBox = document.getElementById('search-box') as HTMLInputElement;
    if (searchBox) searchBox.value = '';

    // Render Title & Subtitle
    const titleEl = document.getElementById('report-title');
    if (titleEl) titleEl.textContent = result.title || 'Rock Report';
    if (subtitle) subtitle.textContent = `Generated at ${new Date(result.createdAt).toLocaleString()}`;

    // Render Stats
    const totalEl = document.getElementById('stat-total');
    if (totalEl) totalEl.textContent = String(currentRows.length);
    const colsEl = document.getElementById('stat-cols');
    if (colsEl) colsEl.textContent = String(currentColumns.length);

    // Populate Headers & Body
    renderTable(currentRows);
    attachSortListeners();
  } catch (err: any) {
    if (subtitle) {
      subtitle.textContent = `Error: ${err.message || 'Failed to load report'}`;
      subtitle.style.color = '#ef4444';
    }
  }
}

// Determine if a value is numeric
function isNumeric(value: any): boolean {
  if (value === null || value === undefined || value === '') return false;
  const num = Number(value);
  return !Number.isNaN(num) && isFinite(num);
}

// Compare two values, handling nulls/undefined and types
function compareValues(a: any, b: any): number {
  // Nulls/undefined sort last
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;

  // Try numeric comparison if both look numeric
  const aNum = isNumeric(a) ? Number(a) : null;
  const bNum = isNumeric(b) ? Number(b) : null;

  if (aNum !== null && bNum !== null) {
    return aNum - bNum;
  }

  // Fall back to case-insensitive string comparison
  const aStr = String(a).toLowerCase();
  const bStr = String(b).toLowerCase();
  return aStr.localeCompare(bStr);
}

// Sort rows by column
function sortRows(rows: Record<string, any>[], column: string, direction: 'asc' | 'desc'): Record<string, any>[] {
  const sorted = [...rows].sort((a, b) => {
    const cmp = compareValues(a[column], b[column]);
    return direction === 'asc' ? cmp : -cmp;
  });
  return sorted;
}

// Apply search filter
function filterRows(rows: Record<string, any>[], query: string): Record<string, any>[] {
  if (!query) return rows;
  const lower = query.toLowerCase();
  return rows.filter(row => {
    return currentColumns.some(col => {
      const val = row[col];
      return val !== null && val !== undefined && String(val).toLowerCase().includes(lower);
    });
  });
}

// Get displayed rows (filtered and sorted)
function getDisplayedRows(): Record<string, any>[] {
  let rows = filterRows(currentRows, currentSearchQuery);
  if (currentSortColumn) {
    rows = sortRows(rows, currentSortColumn, currentSortDir);
  }
  return rows;
}

function renderTable(rows: Record<string, any>[]) {
  const headersEl = document.getElementById('table-headers');
  const bodyEl = document.getElementById('table-body');

  if (headersEl) {
    headersEl.innerHTML = currentColumns
      .map(col => {
        const classes = ['sortable'];
        if (currentSortColumn === col) {
          classes.push(`sort-${currentSortDir}`);
        }
        return `<th class="${classes.join(' ')}" data-column="${escapeHtml(col)}">${escapeHtml(col)}</th>`;
      })
      .join('');
  }

  if (bodyEl) {
    if (rows.length === 0) {
      bodyEl.innerHTML = `<tr><td colspan="100%" class="empty-state">No matching records found.</td></tr>`;
      return;
    }

    bodyEl.innerHTML = rows
      .map(row => {
        const cells = currentColumns.map(col => {
          const val = row[col];
          const displayVal = val === null || val === undefined ? '' : String(val);
          // Highlight active statuses with badges if applicable
          if (col.toLowerCase() === 'status' || col.toLowerCase() === 'connectionstatus') {
            const isActive = displayVal.toLowerCase() === 'active' || displayVal.toLowerCase() === 'core';
            return `<td><span class="status-badge ${isActive ? 'active' : ''}">${escapeHtml(displayVal)}</span></td>`;
          }
          return `<td>${escapeHtml(displayVal)}</td>`;
        });
        return `<tr>${cells.join('')}</tr>`;
      })
      .join('');
  }
}

function attachSortListeners() {
  const headers = document.querySelectorAll('#table-headers th[data-column]');
  headers.forEach(header => {
    header.addEventListener('click', () => {
      const column = header.getAttribute('data-column');
      if (!column) return;

      if (currentSortColumn === column) {
        // Toggle direction
        currentSortDir = currentSortDir === 'asc' ? 'desc' : 'asc';
      } else {
        // New column, default to asc
        currentSortColumn = column;
        currentSortDir = 'asc';
      }

      const displayedRows = getDisplayedRows();
      renderTable(displayedRows);
      attachSortListeners();
    });
  });
}

// Setup Event Listeners
document.getElementById('search-box')?.addEventListener('input', (e) => {
  currentSearchQuery = (e.target as HTMLInputElement).value;
  const displayedRows = getDisplayedRows();
  renderTable(displayedRows);
  attachSortListeners();
});

document.getElementById('btn-refresh')?.addEventListener('click', () => {
  if (datasetId) {
    loadDataset(datasetId);
  }
});

document.getElementById('btn-export-csv')?.addEventListener('click', async () => {
  if (!datasetId) return;

  try {
    const response = await app.callServerTool({
      name: 'rock_report',
      arguments: {
        action: 'export',
        datasetId,
        format: 'csv',
      },
    });

    const text = (response.content?.[0] as any)?.text;
    if (!text) throw new Error('Export failed');

    const payload = JSON.parse(text);
    const csvContent = payload.result;

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `export_${datasetId}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } catch (err: any) {
    alert(`CSV export failed: ${err.message}`);
  }
});

document.getElementById('btn-export-json')?.addEventListener('click', async () => {
  if (!datasetId) return;

  try {
    const response = await app.callServerTool({
      name: 'rock_report',
      arguments: {
        action: 'export',
        datasetId,
        format: 'json',
      },
    });

    const text = (response.content?.[0] as any)?.text;
    if (!text) throw new Error('Export failed');

    const payload = JSON.parse(text);
    const jsonData = payload.result;

    const jsonContent = JSON.stringify(jsonData, null, 2);
    const blob = new Blob([jsonContent], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `export_${datasetId}.json`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } catch (err: any) {
    alert(`JSON export failed: ${err.message}`);
  }
});
