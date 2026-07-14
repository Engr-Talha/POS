import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * Password and PIN hashing — scrypt, from Node's own crypto. No dependency.
 *
 * NEVER store a password. Not encrypted, not "hashed" with SHA-256 — scrypt, with a per-user random
 * salt, because scrypt is deliberately slow and memory-hard, which is what makes a stolen database
 * useless to someone who wants to guess "1234" a billion times.
 *
 * Format: scrypt$N$r$p$<salt-hex>$<hash-hex> — self-describing, so if we ever raise the cost
 * parameters, old hashes still verify and can be upgraded on next login.
 */

const N = 16384 // CPU/memory cost
const r = 8
const p = 1
const KEY_LEN = 64

export function hashSecret(plain: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(plain.normalize('NFKC'), salt, KEY_LEN, { N, r, p })
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${hash.toString('hex')}`
}

export function verifySecret(plain: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const [, nStr, rStr, pStr, saltHex, hashHex] = parts
  if (!nStr || !rStr || !pStr || !saltHex || !hashHex) return false

  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(hashHex, 'hex')

  let actual: Buffer
  try {
    actual = scryptSync(plain.normalize('NFKC'), salt, expected.length, {
      N: Number(nStr),
      r: Number(rStr),
      p: Number(pStr)
    })
  } catch {
    return false
  }

  // Constant-time. A plain === comparison leaks, through timing, how much of the hash matched.
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}
