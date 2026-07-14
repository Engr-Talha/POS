const { app, BrowserWindow } = require('electron')
const { writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')

/**
 * Render the receipts to PDF **and to PNG so a human can actually look at them**.
 *
 *   npm run receipt:preview
 *
 * CLAUDE.md trap #14: never ship a print layout you have not seen. This is how it gets seen.
 * The PDFs land in `preview/` and the PNGs beside them.
 *
 * loadFile, not loadURL('data:...') — large HTML breaks data URLs (trap #11).
 */
const OUT = join(__dirname, '..', 'preview')

// ONE window, reused. Destroying and recreating an offscreen window between renders made the second
// loadFile fail with ERR_FAILED — a race in Chromium's offscreen teardown, not in the receipt.
let win = null

async function render(name, html, widthMm) {
  const htmlPath = join(OUT, `${name}.html`)
  writeFileSync(htmlPath, html)

  if (!win) win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await win.loadFile(htmlPath)

  // MEASURE THE CONTENT, then make the page exactly that tall.
  //
  // Chromium ignores `auto` in `@page { size: 80mm auto }`, and preferCSSPageSize does not rescue it
  // — it silently falls back to a full letter page. A 4-inch receipt then printed on 11 inches of
  // paper: two-thirds of every receipt ejected blank. That is trap #16, and on a roll of thermal
  // paper it is not cosmetic, it is money on the floor all day.
  //
  // So: read the real content height in CSS pixels, convert at 96 px/inch, and print a page of
  // exactly that size. The receipt ends where the receipt ends.
  const heightPx = await win.webContents.executeJavaScript(
    'Math.ceil(document.documentElement.getBoundingClientRect().height)'
  )

  const pdf = await win.webContents.printToPDF({
    printBackground: true,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    pageSize: {
      width: widthMm / 25.4,
      height: heightPx / 96 // CSS pixels -> inches
    }
  })

  const pdfPath = join(OUT, `${name}.pdf`)
  writeFileSync(pdfPath, pdf)

  // A PDF I cannot look at is a PDF I have not checked. Rasterise it.
  const pngPath = join(OUT, `${name}.png`)
  try {
    execFileSync('sips', ['-s', 'format', 'png', pdfPath, '--out', pngPath], { stdio: 'ignore' })
  } catch {
    // sips is macOS-only; the PDF is still there.
  }

  console.log(`  ${name}: ${pdfPath}`)
  return pdfPath
}

async function main() {
  await app.whenReady()
  mkdirSync(OUT, { recursive: true })

  // Built from the compiled main bundle so the preview is the SAME code the app prints with.
  const { renderReceiptHtml } = require('../out/main/receipt-preview.js')
  const { sampleReceipt } = require('../out/main/receipt-preview.js')

  console.log('Rendering receipts...')
  await render('receipt-80mm', renderReceiptHtml(sampleReceipt(false), '80mm'), 80)
  await render('receipt-58mm', renderReceiptHtml(sampleReceipt(false), '58mm'), 58)
  await render('receipt-80mm-duplicate', renderReceiptHtml(sampleReceipt(true), '80mm'), 80)

  app.quit()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
