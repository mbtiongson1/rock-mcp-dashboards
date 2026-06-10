import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['tsx', 'src/server.ts', '--stdio'],
  cwd: '/Users/rico/Git/rock-mcp',
  env: { ...process.env },
});
const client = new Client({ name: 'audit', version: '1.0.0' });
await client.connect(transport);
const { tools } = await client.listTools();
for (const t of tools) {
  console.log('='.repeat(70));
  console.log(`TOOL: ${t.name} — ${t.title ?? ''}`);
  console.log(`DESC: ${t.description}`);
  const props = t.inputSchema?.properties ?? {};
  for (const [k, v] of Object.entries(props)) {
    const req = (t.inputSchema.required ?? []).includes(k) ? ' (required)' : '';
    const enums = v.enum ? ` enum[${v.enum.join('|')}]` : '';
    console.log(`  - ${k}${req}: ${v.type ?? ''}${enums} ${v.description ?? ''}`.slice(0, 220));
  }
}
await client.close();
