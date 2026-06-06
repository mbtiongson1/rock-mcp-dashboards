import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    rollupOptions: {
      input: {
        'report-viewer': path.resolve(__dirname, 'src/apps/report-viewer/report-viewer.html'),
      },
    },
    outDir: path.resolve(__dirname, 'dist/apps'),
    emptyOutDir: true,
  },
});
