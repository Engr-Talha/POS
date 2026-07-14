// Bundle just the receipt renderer + sample into a CJS file the preview script can require.
import { build } from 'vite'
import { resolve } from 'node:path'

await build({
  configFile: false,
  build: {
    lib: {
      entry: resolve('src/main/printing/preview-entry.ts'),
      formats: ['cjs'],
      fileName: () => 'receipt-preview.js'
    },
    outDir: 'out/main',
    emptyOutDir: false,
    minify: false,
    rollupOptions: { external: ['electron'] }
  },
  resolve: { alias: { '@shared': resolve('src/shared') } },
  logLevel: 'error'
})
console.log('bundled out/main/receipt-preview.js')
