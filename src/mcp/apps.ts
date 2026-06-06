import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerAppResource,
  RESOURCE_MIME_TYPE
} from '@modelcontextprotocol/ext-apps/server';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REPORT_VIEWER_URI = 'ui://rock/report-viewer.html';

export function registerReportViewerApp(server: McpServer) {
  registerAppResource(
    server,
    REPORT_VIEWER_URI,
    'Rock Report Viewer',
    { mimeType: RESOURCE_MIME_TYPE },
    async () => {
      let htmlContent = '<html><body>Report Viewer stub</body></html>';
      try {
        // Resolve path to built singlefile html
        const filePath = path.resolve(__dirname, '../../dist/apps/src/apps/report-viewer/report-viewer.html');
        if (fs.existsSync(filePath)) {
          htmlContent = fs.readFileSync(filePath, 'utf8');
        } else {
          // Fallback if built app is not in place
          const srcPath = path.resolve(__dirname, '../apps/report-viewer/report-viewer.html');
          if (fs.existsSync(srcPath)) {
            htmlContent = fs.readFileSync(srcPath, 'utf8');
          }
        }
      } catch (_err) {
        // Safe fallback
      }

      return {
        contents: [
          {
            uri: REPORT_VIEWER_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: htmlContent,
          },
        ],
      };
    }
  );
}
