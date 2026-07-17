import { describe, it, expect } from 'vitest'
import { normalizeBarcode } from './barcode'

describe('normalizeBarcode', () => {
  it('strips a Code-128 AIM identifier — the real scan the owner hit', () => {
    expect(normalizeBarcode(']C19200108')).toBe('9200108')
  })

  it('strips the other common AIM identifiers', () => {
    expect(normalizeBarcode(']E00123456789012')).toBe('0123456789012') // EAN-13 / UPC-A
    expect(normalizeBarcode(']E490311017')).toBe('90311017') // EAN-8
    expect(normalizeBarcode(']d2FOO')).toBe('FOO') // Data Matrix (lowercase letter)
    expect(normalizeBarcode(']Q1BAR')).toBe('BAR') // QR
  })

  it('leaves a clean barcode untouched — the ones that already worked', () => {
    expect(normalizeBarcode('3001-0016')).toBe('3001-0016')
    expect(normalizeBarcode('90311017')).toBe('90311017')
    expect(normalizeBarcode('01234565')).toBe('01234565')
  })

  it('is IDEMPOTENT — normalising a cleaned code returns it unchanged', () => {
    const once = normalizeBarcode(']C19200108')
    expect(normalizeBarcode(once)).toBe(once)
  })

  it('trims surrounding whitespace the scanner or a paste may add', () => {
    expect(normalizeBarcode('  9200108\n')).toBe('9200108')
    expect(normalizeBarcode(' ]C19200108 ')).toBe('9200108')
  })

  it('does NOT strip a real barcode that merely starts with ]', () => {
    // A genuine code is not an AIM id unless it is EXACTLY ]-letter-digit. Guard against over-stripping.
    expect(normalizeBarcode(']]C1')).toBe(']]C1') // ] then ] — second char is not a letter
    expect(normalizeBarcode(']12')).toBe(']12') // ] then digit — not letter-then-digit
    expect(normalizeBarcode(']AB')).toBe(']AB') // ] then two letters — not letter-then-digit
  })

  it('never returns empty by stripping — an AIM id with nothing after it is left alone', () => {
    // Length must exceed 3, or a bare `]C1` would normalise to '' and a barcode would vanish.
    expect(normalizeBarcode(']C1')).toBe(']C1')
  })

  it('handles an empty or blank input without throwing', () => {
    expect(normalizeBarcode('')).toBe('')
    expect(normalizeBarcode('   ')).toBe('')
  })
})
