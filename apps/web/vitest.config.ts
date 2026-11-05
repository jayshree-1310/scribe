import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    // Each test stubs `fetch` for itself; none may inherit another's.
    unstubGlobals: true,
    restoreMocks: true,
    // A cold run (CI's every run) spends seconds starting jsdom and React
    // before the first render; the default 5s has timed out on it.
    testTimeout: 15_000,
  },
})
