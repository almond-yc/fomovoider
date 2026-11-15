import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'edge-runtime',
    include: ['src/**/*.test.ts', 'convex/**/*.test.ts'],
    setupFiles: ['src/connectors/x/__tests__/setup.ts'],
    server: { deps: { inline: ['convex-test'] } },
  },
});
