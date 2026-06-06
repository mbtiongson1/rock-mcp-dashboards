import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { McpMode } from './modes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function getRockGuideText(mode: McpMode): string {
  try {
    const filename = mode === 'readwrite' ? 'rock-usage-readwrite.md' : 'rock-usage-readonly.md';
    const filePath = path.resolve(__dirname, '../../static/mcp-guides', filename);
    return fs.readFileSync(filePath, 'utf8');
  } catch (err: any) {
    // Fallback if files aren't found (e.g. in certain test environments)
    return `Favor Church Rock MCP Guide (${mode} mode). Use rock_lookup when mapping is unknown.`;
  }
}
