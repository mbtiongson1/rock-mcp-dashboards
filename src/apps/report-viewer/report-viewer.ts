import { App } from '@modelcontextprotocol/ext-apps';

// Initialize the App
const app = new App({ name: 'Rock Report Viewer', version: '1.0.0' });

let currentRows: Record<string, any>[] = [];
let currentColumns: string[] = [];
let datasetId: string | null = null;

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
  } catch (_err) {
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
  } catch (err: any) {
    if (subtitle) {
      subtitle.textContent = `Error: ${err.message || 'Failed to load report'}`;
      subtitle.style.color = '#ef4444';
    }
  }
}

function renderTable(rows: Record<string, any>[]) {
  const headersEl = document.getElementById('table-headers');
  const bodyEl = document.getElementById('table-body');

  if (headersEl) {
    headersEl.innerHTML = currentColumns.map(col => `<th>${col}</th>`).join('');
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
            return `<td><span class="status-badge ${isActive ? 'active' : ''}">${displayVal}</span></td>`;
          }
          return `<td>${displayVal}</td>`;
        });
        return `<tr>${cells.join('')}</tr>`;
      })
      .join('');
  }
}

// Setup Event Listeners
document.getElementById('search-box')?.addEventListener('input', (e) => {
  const query = (e.target as HTMLInputElement).value.toLowerCase();
  const filtered = currentRows.filter(row => {
    return currentColumns.some(col => {
      const val = row[col];
      return val !== null && val !== undefined && String(val).toLowerCase().includes(query);
    });
  });
  renderTable(filtered);
});

document.getElementById('btn-refresh')?.addEventListener('click', () => {
  if (datasetId) {
    loadDataset(datasetId);
  }
});

document.getElementById('btn-export')?.addEventListener('click', async () => {
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
  } catch (err: any) {
    alert(`Export failed: ${err.message}`);
  }
});
