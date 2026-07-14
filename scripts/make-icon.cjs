const { app, BrowserWindow } = require('electron')
const { writeFileSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

/**
 * Render build/logo.svg -> build/icon.png (1024x1024), which electron-builder converts into the
 * macOS .icns and the Windows .ico.
 *
 * Uses the Electron we already ship rather than adding an image-processing dependency just to make
 * one file. Run it by hand when the logo changes:
 *
 *   npm run make:icon
 *
 * DESIGN NOTE: the Malgary mark is dark navy (#001930). On a transparent background it would
 * disappear into a dark dock or a dark Windows taskbar. So it sits on a white square with padding —
 * legible on both light and dark, which is the whole job of an app icon.
 */
const SIZE = 1024
const PADDING = 0.14 // 14% breathing room, so it doesn't look cramped next to other icons

async function main() {
  await app.whenReady()

  const svg = readFileSync(join(__dirname, '..', 'build', 'logo.svg'), 'utf8')

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; padding: 0; width: ${SIZE}px; height: ${SIZE}px; }
      body {
        display: flex; align-items: center; justify-content: center;
        background: #ffffff;
      }
      svg { width: ${Math.round(SIZE * (1 - PADDING * 2))}px; height: auto; display: block; }
    </style>
  </head>
  <body>${svg}</body>
</html>`

  // loadFile, not loadURL('data:...') — trap #11: large inline HTML breaks data URLs.
  const tmp = join(app.getPath('temp'), 'pos-icon.html')
  writeFileSync(tmp, html)

  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    useContentSize: true,
    webPreferences: { offscreen: true }
  })

  await win.loadFile(tmp)
  const image = await win.webContents.capturePage()

  const out = join(__dirname, '..', 'build', 'icon.png')
  writeFileSync(out, image.toPNG())
  console.log(`wrote ${out} (${image.getSize().width}x${image.getSize().height})`)

  app.quit()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
