import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const entryPoint = path.join(root, 'src/apps/report-viewer/report-viewer.ts');
const htmlTemplate = path.join(root, 'src/apps/report-viewer/report-viewer.html');
const outDir = path.join(root, 'dist/apps');
const outFile = path.join(outDir, 'report-viewer.html');

/**
 * Build the MCP App as one self-contained HTML file. Next.js traces this output
 * into the serverless route bundle so MCP clients can load the app resource.
 */
async function build() {
  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    minify: true,
    write: false,
  });

  if (result.errors.length > 0) {
    console.error('esbuild failed:', result.errors);
    process.exit(1);
  }

  const jsBundle = result.outputFiles[0].text;

  let html = fs.readFileSync(htmlTemplate, 'utf8');
  const patched = html.replace(
    /<script\s+type="module"\s+src="\.\/report-viewer\.ts"><\/script>/,
    `<script>${jsBundle}</script>`
  );
  if (patched === html) {
    console.error('ERROR: HTML injection failed — <script> tag not found in template');
    process.exit(1);
  }
  html = patched;

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, html, 'utf8');
  console.log(`Built ${outFile} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
}

build().catch((err) => {
  console.error('build-report-viewer failed:', err);
  process.exit(1);
});
