import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'

/**
 * MACHINE ID — a stable fingerprint of this computer.
 *
 * The customer reads this off the Activation screen and sends it to us; we mint a key bound to it.
 *
 * IT IS A HASH. We never expose a raw hardware serial — not on screen, not in a log, not in the
 * licence file. The customer is handing this string to a stranger over WhatsApp; it should reveal
 * nothing about their machine beyond "it is this one".
 *
 * It must be STABLE: if it changes, a paying customer's licence stops working and they cannot sell.
 * So we use the OS's own installation identifier, which survives reboots, disk cleanups and RAM
 * upgrades — not the MAC address, which changes with a dock or a VPN.
 */

function rawPlatformId(): string {
  try {
    if (process.platform === 'darwin') {
      // IOPlatformUUID — tied to the machine, stable across OS reinstalls.
      const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf8',
        timeout: 5000
      })
      const match = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)
      if (match?.[1]) return match[1]
    }

    if (process.platform === 'win32') {
      // MachineGuid — written by Windows at install time.
      const out = execFileSync(
        'reg',
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        { encoding: 'utf8', timeout: 5000 }
      )
      const match = out.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i)
      if (match?.[1]) return match[1]
    }

    if (process.platform === 'linux') {
      return readFileSync('/etc/machine-id', 'utf8').trim()
    }
  } catch {
    // Fall through to the fallback below.
  }

  // Fallback: better a licence bound to the hostname than an app that cannot be activated at all.
  // Weaker, but it fails toward "the customer can still use what they paid for".
  return `fallback:${hostname()}:${process.platform}:${process.arch}`
}

let cached: string | null = null

/** Uppercase hex, dash-grouped, e.g. `A1B2-C3D4-E5F6-7890` — short enough to read down a phone. */
export function getMachineId(): string {
  if (cached) return cached

  const digest = createHash('sha256')
    .update(`insha-pos:${rawPlatformId()}`) // namespaced, so the hash is ours and not reusable
    .digest('hex')
    .toUpperCase()

  const groups = [digest.slice(0, 4), digest.slice(4, 8), digest.slice(8, 12), digest.slice(12, 16)]
  cached = groups.join('-')
  return cached
}
