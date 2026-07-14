import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Tests run against the SERVICES layer (src/main/services) in plain Node — never through Electron.
// That is the whole point of keeping services transport-agnostic (CLAUDE.md §3).
//
// TRAP #10: better-sqlite3 gets rebuilt for Electron's ABI by electron-builder, which then breaks
// vitest (Node ABI). `npm test` runs `npm rebuild better-sqlite3 --build-from-source` first.
// Do not remove that step.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    restoreMocks: true
  },
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  }
})
