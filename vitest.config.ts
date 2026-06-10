import { defineConfig } from 'vitest/config';

// Load environment variables from .env if available
try {
  // @ts-ignore
  process.loadEnvFile();
} catch (_err) {
  // Ignore error if .env doesn't exist
}

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
