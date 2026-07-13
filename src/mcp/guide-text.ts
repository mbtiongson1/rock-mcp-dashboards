import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { McpMode } from './modes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function getRockGuideText(mode: McpMode): string {
  const filename = mode === 'readwrite' ? 'rock-usage-readwrite.md' : 'rock-usage-readonly.md';
  // Try the source-relative path (stdio/tsc build) first, then a path relative
  // to the process working directory (Next.js serverless functions run from the
  // project root with `static/` traced in via outputFileTracingIncludes).
  const candidates = [
    path.resolve(__dirname, '../../static/mcp-guides', filename),
    path.join(process.cwd(), 'static/mcp-guides', filename),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, 'utf8');
      }
    } catch {
      // try next candidate
    }
  }
  const orgName = process.env.ORGANIZATION_NAME || 'Favor Church';
  // Fallback if files aren't found (e.g. in certain test environments)
  return `${orgName} Rock MCP Guide (${mode} mode). Use rock_lookup when mapping is unknown.`;
}
