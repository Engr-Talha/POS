const { execFileSync } = require('node:child_process')
const path = require('node:path')

/**
 * TRAP #7: on macOS the app will not launch unless it is signed. We have no paid Apple cert, so we
 * ad-hoc sign it (`--sign -`).
 *
 * This runs in afterPack — AFTER the .app is assembled but BEFORE the .dmg is built around it.
 * Signing the .app afterwards would leave the copy inside the shipped .dmg unsigned, which is the
 * subtle version of this bug: the app on your machine works, the one you hand someone else doesn't.
 *
 * macOS is the DEV LOOP only. Real mac auto-update needs a paid Apple certificate.
 * WINDOWS IS THE REAL TARGET.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)

  console.log(`[after-pack] ad-hoc signing ${appPath}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
}
