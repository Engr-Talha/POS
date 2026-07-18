/**
 * CHECK A LICENCE KEY — the vendor's "is this key real, and what does it say?".
 *
 *   npm run check:license -- "<the key the shop has>"
 *   npm run check:license -- "<key>" --machine-id E15E-4A88-2B64-C279
 *
 * It runs the EXACT check the shop's app runs (verifyLicenseKey against the same embedded public key),
 * so its answer is the app's answer — not a second opinion that could disagree. It then shows the
 * payload in plain language and, if you pass --machine-id, tells you whether the key was minted for THAT
 * machine and whether it has expired.
 *
 * `tools/` is maintainer-only and is NOT shipped in the installer.
 */
import { verifyLicenseKey } from '../src/main/security/license-key'
import { LICENSE_PUBLIC_KEY } from '../src/main/security/public-key'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

// The key is the first non-flag argument.
const key = process.argv.slice(2).find((a) => !a.startsWith('--') && a !== arg('machine-id'))
const expectMachine = arg('machine-id')

if (!key) {
  console.error(`
  Usage:
    npm run check:license -- "<licence key>"
    npm run check:license -- "<licence key>" --machine-id <the shop's Machine ID>
`)
  process.exit(1)
}

const result = verifyLicenseKey(key.trim(), LICENSE_PUBLIC_KEY)

if (!result.ok) {
  console.log(`
  ❌  NOT VALID
      ${result.reason}

  This key was NOT signed by your private key (or it is damaged/edited). The shop's app would reject it
  the same way. Mint a fresh one with:  npm run keygen -- --licensee "<shop>" --machine-id <ID>
`)
  process.exit(1)
}

const p = result.payload
const now = new Date()
const expired = p.expiresAt !== null && new Date(p.expiresAt) < now
const daysLeft =
  p.expiresAt === null
    ? null
    : Math.ceil((new Date(p.expiresAt).getTime() - now.getTime()) / (24 * 60 * 60 * 1000))

console.log(`
  ✅  SIGNATURE VALID — this key really was issued by you.

      Licensee   : ${p.licensee}
      Machine ID : ${p.machineId}
      Plan       : ${p.plan}
      Issued     : ${new Date(p.issuedAt).toDateString()}
      Expires    : ${p.expiresAt === null ? 'never (lifetime)' : new Date(p.expiresAt).toDateString()}${
        p.expiresAt === null ? '' : expired ? '   ⚠️  EXPIRED' : `   (${daysLeft} days left)`
      }`)

// A valid SIGNATURE is not the whole story. The app also checks the key was minted for THAT machine and
// that it has not expired — so surface both, since a "valid" key on the wrong machine still won't run.
if (expectMachine) {
  const match = p.machineId.trim().toUpperCase() === expectMachine.trim().toUpperCase()
  console.log(
    `\n      For machine ${expectMachine}:  ${
      match ? '✅ MATCHES — this key is for this machine.' : '❌ DOES NOT MATCH — this key was minted for a DIFFERENT machine, so this shop’s app will refuse it.'
    }`
  )
}

if (expired) {
  console.log(`
  The signature is genuine but the licence has EXPIRED. The shop's app is in READ-ONLY mode: they can
  still see everything, run reports and back up their data — they just cannot make new sales until you
  issue a renewal (same command, same Machine ID, a later expiry).`)
}

console.log('')
