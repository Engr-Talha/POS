import type { DB } from '../db'
import type { User } from '@shared/types'
import { AppError, ErrorCode } from '@shared/result'
import * as audit from './audit'
import * as settings from './settings'
import { addBarcode, assertBarcodeAvailable } from './catalog'
import type { LabelSpec, LabelSheetOptions } from '../printing/label'

/**
 * IN-HOUSE BARCODE GENERATION.
 *
 * The shop has loose, unpackaged goods — a scoop of rice, a single onion — that carry NO barcode of
 * their own. This makes one up, prints it on a peel-and-stick label, and the shop's own scanner reads
 * it back at the till exactly like a supplier's barcode. (printing/label.ts renders the label.)
 *
 * ── WHY EAN-13, AND WHY THE "2" PREFIX ──────────────────────────────────────────────────────────
 *
 * The code is a valid EAN-13 in the GS1-reserved "restricted distribution / in-store" range — a
 * leading digit of 2. GS1 set that range aside for exactly this: numbers a shop assigns to itself,
 * which are guaranteed NEVER to collide with a real manufacturer's GTIN printed on a can of beans.
 * So an in-store code and a supplier code can sit in the same product_barcodes table and the scanner
 * can never confuse the two.
 *
 * A valid EAN-13 is 13 digits: 12 of payload + 1 check digit (standard mod-10). A scanner computes
 * the same check digit and REFUSES a code whose 13th digit is wrong, so getting the check digit right
 * is the difference between a label that scans and a sticker that beeps an error every time. That is
 * why `ean13` has published-vector tests — it is the single most important thing in this file.
 *
 * ── WHY IT IS DETERMINISTIC ─────────────────────────────────────────────────────────────────────
 *
 * The payload is built from the product id, zero-padded. The SAME item always yields the SAME code,
 * so re-running the batch generator is idempotent and a label reprinted next year matches the sticker
 * already on the shelf. `assignGeneratedBarcode` REFUSES an item that already has any barcode, so a
 * supplier's code is never overwritten — the whole point is to fill the gap, not to replace.
 */

/** GS1's in-store / restricted-distribution leading digit. A "2…" GTIN is a code a shop owns. */
const IN_STORE_PREFIX = '2'

/**
 * THE EAN-13 CHECK DIGIT — standard mod-10.
 *
 * Take the 12 payload digits left-to-right. Weight them 1,3,1,3,… (odd positions ×1, even ×3),
 * sum, and the check digit is whatever makes that sum a multiple of 10. This is the algorithm every
 * scanner in the shop uses to validate a code, so it must match to the digit.
 *
 * `payload12` MUST be exactly 12 ASCII digits — this is an internal helper fed by
 * `generateInStoreEan`, not user input, so it throws (a programmer error) rather than returning a
 * friendly message.
 */
export function ean13(payload12: string): string {
  if (!/^\d{12}$/.test(payload12)) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'A barcode could not be generated for this item.',
      `ean13 expects exactly 12 digits, got "${payload12}"`
    )
  }

  let sum = 0
  for (let i = 0; i < 12; i++) {
    const digit = payload12.charCodeAt(i) - 48 // '0' === 48; faster and allocation-free
    // Positions are 1-based in the spec: position 1 (index 0) has weight 1, position 2 weight 3, …
    sum += i % 2 === 0 ? digit : digit * 3
  }

  const checkDigit = (10 - (sum % 10)) % 10
  return payload12 + String(checkDigit)
}

/**
 * A deterministic, valid EAN-13 for a product id.
 *
 * The 12-digit payload is: the "2" in-store prefix, then the product id zero-padded to fill the rest,
 * and `bump` shifts the number when a generated code (astronomically unlikely) already exists. The
 * product id is a positive integer well under 11 digits for any real shop, so it always fits.
 *
 * The check digit is appended by `ean13`, so the returned 13-digit code validates on any scanner.
 */
export function generateInStoreEan(productId: number, bump = 0): string {
  if (!Number.isSafeInteger(productId) || productId <= 0) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'A barcode could not be generated for this item.',
      `generateInStoreEan needs a positive product id, got ${productId}`
    )
  }

  // 12 payload digits total: 1 for the prefix leaves 11 for the number.
  const numberWidth = 12 - IN_STORE_PREFIX.length
  const n = productId + bump

  const body = String(n).padStart(numberWidth, '0')
  if (body.length > numberWidth) {
    // A shop would need ~100 billion products to hit this. If it ever happens, fail loudly rather
    // than silently truncate into a code that collides.
    throw new AppError(
      ErrorCode.VALIDATION,
      'A barcode could not be generated for this item.',
      `product number ${n} does not fit in ${numberWidth} digits`
    )
  }

  return ean13(IN_STORE_PREFIX + body)
}

/** How many bumps we try before giving up. Each bump is a different code; a real clash needs many. */
const MAX_COLLISION_RETRIES = 10

/**
 * GENERATE and store an in-store barcode for one item that has NONE.
 *
 * Refuses an item that already carries any barcode (a supplier's, or one generated earlier) — the
 * feature FILLS a gap, it never overwrites. This is also what makes a second call safe: press the
 * button twice and the second press is refused, not a duplicate.
 *
 * The code goes in through `catalog.addBarcode`, so every rule that guards a hand-typed barcode
 * guards this one too: the cross-table uniqueness check (`assertBarcodeAvailable`), normalisation,
 * and the "first barcode becomes primary" rule — which is exactly the code a label prints.
 *
 * A generated code that WOULD collide (another product already owns it) is BUMPED to the next number
 * and retried, never silently skipped. After a few tries it fails with a plain message.
 */
export function assignGeneratedBarcode(
  db: DB,
  actor: User,
  productId: number,
  now = new Date()
): { productId: number; barcode: string; wasGenerated: true } {
  const existing = db
    .prepare('SELECT barcode FROM product_barcodes WHERE product_id = ? LIMIT 1')
    .pluck()
    .get(productId) as string | undefined

  if (existing != null) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'This item already has a barcode, so there is nothing to generate. Generated barcodes are only for loose goods that carry none.',
      `assignGeneratedBarcode refused: product ${productId} already has barcode ${existing}`
    )
  }

  const write = db.transaction((): string => {
    for (let bump = 0; bump <= MAX_COLLISION_RETRIES; bump++) {
      const code = generateInStoreEan(productId, bump)

      // Would this code clash with any barcode already in the shop? assertBarcodeAvailable throws a
      // VALIDATION AppError if it does — we catch that ONE case, bump, and try the next number. Any
      // other error (a real fault) is not swallowed.
      try {
        assertBarcodeAvailable(db, code)
      } catch (error) {
        if (error instanceof AppError && error.code === ErrorCode.VALIDATION) {
          continue // this number is taken — try the next one
        }
        throw error
      }

      // addBarcode makes the first barcode primary automatically — the one a label prints.
      addBarcode(db, { productId, barcode: code }, now)
      return code
    }

    throw new AppError(
      ErrorCode.VALIDATION,
      'A barcode could not be generated for this item. Please try again, or add a barcode by hand.',
      `assignGeneratedBarcode exhausted ${MAX_COLLISION_RETRIES} retries for product ${productId}`
    )
  })

  const barcode = write()

  // A barcode appearing on an item is a catalogue change worth a WHO/WHEN line (CLAUDE.md §4).
  audit.record(
    db,
    actor,
    {
      action: 'product.barcode_generate',
      entity: 'product',
      entityId: productId,
      after: { barcode, generated: true }
    },
    now
  )

  return { productId, barcode, wasGenerated: true }
}

export type GenerateMissingResult = {
  /** How many items had a barcode generated just now. */
  generated: number
  /** How many were skipped because they already carried a barcode. */
  alreadyHad: number
}

/**
 * THE "GENERATE FOR ALL LOOSE ITEMS" BUTTON.
 *
 * Runs `assignGeneratedBarcode` for every ACTIVE item that has no barcode — or, if `productIds` is
 * given, only those of them without one. Returns a count of what it did and what it skipped, so the
 * screen can say "made 12 barcodes; 40 items already had one".
 *
 * Items that already carry a barcode are COUNTED, not errored on — the whole point of the batch is
 * "fill the gaps", and an item with a supplier barcode is not a gap.
 */
export function generateMissingBarcodes(
  db: DB,
  actor: User,
  productIds?: number[],
  now = new Date()
): GenerateMissingResult {
  // The candidate set: every ACTIVE product, optionally narrowed to the ids asked for. A retired item
  // is off the shelf, so it needs no label.
  let rows: Array<{ id: number }>
  if (productIds && productIds.length > 0) {
    const unique = [...new Set(productIds)]
    const placeholders = unique.map(() => '?').join(',')
    rows = db
      .prepare(
        `SELECT id FROM products WHERE is_active = 1 AND id IN (${placeholders}) ORDER BY id`
      )
      .all(...unique) as Array<{ id: number }>
  } else {
    rows = db
      .prepare('SELECT id FROM products WHERE is_active = 1 ORDER BY id')
      .all() as Array<{ id: number }>
  }

  let generated = 0
  let alreadyHad = 0

  for (const row of rows) {
    const has = db
      .prepare('SELECT 1 FROM product_barcodes WHERE product_id = ? LIMIT 1')
      .pluck()
      .get(row.id) as number | undefined

    if (has != null) {
      alreadyHad++
      continue
    }

    assignGeneratedBarcode(db, actor, row.id, now)
    generated++
  }

  return { generated, alreadyHad }
}

/** One line of the print request: which item, and how many stickers of it. */
export type LabelRequestItem = { productId: number; copies: number }

/**
 * BUILD THE LABEL SHEET — the specs to draw, and the layout to draw them on.
 *
 * Reads each requested item's name, primary barcode and retail price, repeats it `copies` times, and
 * pairs the list with the shop's own label-sheet layout from Settings. An item with NO barcode is
 * SKIPPED (there is nothing to print) and reported back in `skippedNoBarcode`, so the screen can say
 * "3 items had no barcode — generate one first" rather than printing a blank sticker. Copies are
 * clamped to a sane 1..100 so a fat-fingered "1000" cannot spool a ream.
 *
 * The renderer never sees a price it should not: `labels.showPrice` off means the price is left off
 * every spec here, not merely hidden in CSS.
 */
export function buildLabelSheet(
  db: DB,
  items: LabelRequestItem[]
): { specs: LabelSpec[]; options: LabelSheetOptions; skippedNoBarcode: string[] } {
  const showPrice = settings.get<boolean>(db, 'labels.showPrice', true)

  const options: LabelSheetOptions = {
    perRow: settings.get<number>(db, 'labels.perRow', 3),
    widthMm: settings.get<number>(db, 'labels.widthMm', 63),
    heightMm: settings.get<number>(db, 'labels.heightMm', 30),
    showPrice,
    currencySymbol: settings.get<string>(db, 'currency.symbol', 'Rs')
  }

  const specs: LabelSpec[] = []
  const skippedNoBarcode: string[] = []

  for (const item of items) {
    const row = db
      .prepare(
        `SELECT p.name, p.sku, p.retail_price,
                (SELECT barcode FROM product_barcodes
                  WHERE product_id = p.id ORDER BY is_primary DESC, id LIMIT 1) AS barcode
           FROM products p WHERE p.id = ?`
      )
      .get(item.productId) as
      | { name: string; sku: string; retail_price: number; barcode: string | null }
      | undefined

    if (row == null) continue
    if (row.barcode == null) {
      skippedNoBarcode.push(row.name)
      continue
    }

    const copies = Math.min(100, Math.max(1, Math.trunc(item.copies) || 1))
    for (let i = 0; i < copies; i++) {
      specs.push({
        name: row.name,
        barcode: row.barcode,
        sku: row.sku,
        price: showPrice ? row.retail_price : undefined
      })
    }
  }

  return { specs, options, skippedNoBarcode }
}
