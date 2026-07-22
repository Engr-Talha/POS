import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, type TestDb } from '../db/testkit'
import { AppError } from '@shared/result'
import type { User } from '@shared/types'
import * as barcodeGen from './barcode-gen'
import * as products from './products'
import * as catalog from './catalog'
import * as ledger from './ledger'
import { renderLabelSheetHtml, ean13Modules } from '../printing/label'

/**
 * IN-HOUSE BARCODES.
 *
 * The one test that matters most is the CHECK DIGIT: a wrong 13th digit means every printed label is
 * unscannable, and nothing downstream would catch it. So it is pinned against published EAN-13 vectors.
 * The rest defend the safety properties: generation NEVER overwrites a barcode, is deterministic and
 * idempotent-safe, bumps a collision rather than dropping it, and — the whole point — never posts a
 * journal or moves stock (it is a catalogue write, nothing more).
 */

let t: TestDb
let actor: User

beforeEach(() => {
  t = makeTestDb({ withSeed: true })
  actor = makeUser(t)
})

afterEach(() => t.cleanup())

function makeUser(test: TestDb): User {
  const now = new Date().toISOString()
  const id = Number(
    test.db
      .prepare(
        `INSERT INTO users (username, full_name, role, password_hash, is_active, created_at, updated_at)
         VALUES ('insha', 'Insha Owner', 'owner', 'x', 1, ?, ?)`
      )
      .run(now, now).lastInsertRowid
  )
  return { id, username: 'insha', fullName: 'Insha Owner', role: 'owner', hasPin: false, isActive: true }
}

function uomId(): number {
  return t.db.prepare("SELECT id FROM lookups WHERE list_key = 'uom' AND code = 'pcs'").pluck().get() as number
}

function makeProduct(name: string, barcodes: string[] = []): number {
  return products.create(
    t.db,
    actor,
    { sku: name.replace(/\s+/g, '-').toUpperCase(), name, saleUomId: uomId(), retailPrice: 10_000, barcodes },
    new Date()
  ).product.id
}

function count(table: string): number {
  return t.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number
}

describe('ean13 — the check digit (the single most important thing)', () => {
  it('appends the correct check digit for published vectors', () => {
    // Classic textbook example, and two real 12-digit payloads with their known check digit.
    expect(barcodeGen.ean13('590123412345')).toBe('5901234123457')
    expect(barcodeGen.ean13('400638133393')).toBe('4006381333931')
    expect(barcodeGen.ean13('978014300723')).toBe('9780143007234')
  })

  it('refuses a payload that is not exactly 12 digits', () => {
    expect(() => barcodeGen.ean13('12345')).toThrow(AppError)
    expect(() => barcodeGen.ean13('abcdefghijkl')).toThrow(AppError)
  })
})

describe('generateInStoreEan — deterministic, in-store, self-validating', () => {
  it('is a 13-digit "2"-prefixed code, the same for the same id, and passes its own check digit', () => {
    const a = barcodeGen.generateInStoreEan(42)
    const b = barcodeGen.generateInStoreEan(42)
    expect(a).toBe(b) // deterministic
    expect(a).toHaveLength(13)
    expect(a.startsWith('2')).toBe(true) // GS1 in-store range
    // Re-deriving the check digit from the first 12 must reproduce the 13th.
    expect(barcodeGen.ean13(a.slice(0, 12))).toBe(a)
  })

  it('a bump produces a DIFFERENT valid code', () => {
    const base = barcodeGen.generateInStoreEan(42, 0)
    const bumped = barcodeGen.generateInStoreEan(42, 1)
    expect(bumped).not.toBe(base)
    expect(barcodeGen.ean13(bumped.slice(0, 12))).toBe(bumped)
  })
})

describe('assignGeneratedBarcode — fills a gap, never overwrites', () => {
  it('generates for a loose item and stores it as the primary barcode the till resolves', () => {
    const id = makeProduct('Loose Rice')
    const { barcode } = barcodeGen.assignGeneratedBarcode(t.db, actor, id)

    const codes = catalog.listBarcodes(t.db, id)
    expect(codes.map((c) => c.barcode)).toContain(barcode)
    expect(codes.find((c) => c.barcode === barcode)?.isPrimary).toBe(true)

    // The shop's own scanner finds the item by the generated code.
    const match = catalog.findProductByBarcode(t.db, barcode)
    expect(match?.product.id).toBe(id)

    // A catalogue change only: NO journal, NO stock movement.
    expect(count('journals')).toBe(0)
    expect(count('stock_movements')).toBe(0)
    expect(ledger.trialBalance(t.db).balanced).toBe(true)

    // The audit trail records who made a barcode appear.
    const audited = t.db
      .prepare(`SELECT COUNT(*) FROM audit_log WHERE action = 'product.barcode_generate'`)
      .pluck()
      .get() as number
    expect(audited).toBe(1)
  })

  it('REFUSES an item that already has a barcode (so a second press is safe, not a duplicate)', () => {
    const id = makeProduct('Packed Sugar', ['8964000112233'])
    expect(() => barcodeGen.assignGeneratedBarcode(t.db, actor, id)).toThrow(AppError)
    // Still exactly the one supplier barcode — nothing was added.
    expect(catalog.listBarcodes(t.db, id)).toHaveLength(1)
  })

  it('bumps past a collision rather than failing or duplicating', () => {
    // Park product 1's deterministic code onto ANOTHER product, so product 1's first choice is taken.
    const other = makeProduct('Decoy')
    const clash = makeProduct('Wants Barcode')
    const wouldBe = barcodeGen.generateInStoreEan(clash)
    catalog.addBarcode(t.db, { productId: other, barcode: wouldBe })

    const { barcode } = barcodeGen.assignGeneratedBarcode(t.db, actor, clash)
    expect(barcode).not.toBe(wouldBe) // it bumped
    expect(catalog.findProductByBarcode(t.db, barcode)?.product.id).toBe(clash)
  })
})

describe('generateMissingBarcodes — fills every gap, counts honestly', () => {
  it('generates only for items without a barcode', () => {
    makeProduct('No Barcode A')
    makeProduct('No Barcode B')
    makeProduct('Has One', ['8964000999999'])

    const result = barcodeGen.generateMissingBarcodes(t.db, actor)
    expect(result.generated).toBe(2)
    expect(result.alreadyHad).toBe(1)

    // Every product now has exactly one barcode; nothing posted to the ledger.
    expect(count('journals')).toBe(0)
    expect(ledger.trialBalance(t.db).balanced).toBe(true)
  })
})

describe('label rendering — scannable and print-safe', () => {
  it('draws EAN-13 bars, shows the digits, and breaks no print trap', () => {
    const code = barcodeGen.ean13('200000000012')
    const html = renderLabelSheetHtml(
      [{ name: 'A Very Long Product Name That Must Wrap And Not Push The Bars Out', barcode: code, price: 12_345, sku: 'X-1' }],
      { perRow: 3, widthMm: 63, heightMm: 30, showPrice: true, currencySymbol: 'Rs' }
    )

    // The bar modules: an EAN-13 is 95 modules; the SVG draws a rect per dark run, so there are many.
    const rects = (html.match(/<rect/g) || []).length
    expect(rects).toBeGreaterThan(20)

    // The human-readable digits are printed under the bars.
    expect(html).toContain(code)

    // Print traps: NO box-shadow (trap #12), and NO network URL (trap #13). The SVG namespace
    // (http://www.w3.org/2000/svg) is an XML identifier, never fetched — exclude it before asserting.
    const withoutSvgNs = html.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')
    expect(/box-shadow\s*:/.test(html)).toBe(false)
    expect(/https?:\/\//.test(withoutSvgNs)).toBe(false)
  })

  it('encodes a valid code into exactly 95 modules', () => {
    const modules = ean13Modules(barcodeGen.ean13('200000000012'))
    expect(modules).toHaveLength(95)
    expect(/^[01]+$/.test(modules)).toBe(true)
  })
})
