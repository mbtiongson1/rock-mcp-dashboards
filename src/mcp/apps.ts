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
      // Try, in order: the esbuild single-file bundle relative to the
      // compiled module, the same bundle relative to the process working
      // directory (Next.js serverless functions traced via
      // outputFileTracingIncludes), then the raw source HTML as a last resort.
      const candidates = [
        path.resolve(__dirname, '../../dist/apps/report-viewer.html'),
        path.join(process.cwd(), 'dist/apps/report-viewer.html'),
        path.resolve(__dirname, '../apps/report-viewer/report-viewer.html'),
        path.join(process.cwd(), 'src/apps/report-viewer/report-viewer.html'),
      ];
      for (const candidate of candidates) {
        try {
          if (fs.existsSync(candidate)) {
            htmlContent = fs.readFileSync(candidate, 'utf8');
            break;
          }
        } catch {
          // try next candidate
        }
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
