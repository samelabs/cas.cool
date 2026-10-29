import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts'],
    environment: 'node',
    // Integration tests boot one next dev server + one throwaway database —
    // never run test files concurrently.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
})
