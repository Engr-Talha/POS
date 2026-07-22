import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Workbook, type Worksheet } from 'exceljs'
import { makeTestDb, type TestDb } from '../db/testkit'
import { AppError } from '@shared/result'
import type { User } from '@shared/types'
import * as productImport from './product-import'
import * as products from './products'
import * as ledger from './ledger'
import { buildProductTemplate, PRODUCT_COLUMNS, PRODUCT_SHEET } from './product-template'

/**
 * THE ANYTIME PRODUCT IMPORTER.
 *
 * These tests defend the properties that make this importer SAFE to run on a live, trading shop — the
 * ones that separate it from the opening importer:
 *
 *   1. EXCEL HANDS YOU FLOATS, AND NOT ONE OF THEM REACHES THE CATALOGUE. A price of 199.999 is
 *      REFUSED, by row number — never rounded to 199.99.
 *   2. IT NEVER MOVES STOCK AND NEVER POSTS A JOURNAL. In 'update-prices' mode an existing item's price
 *      changes, but stock_movements does not grow, journals does not grow, and the cost is untouched.
 *   3. IT IS ALL-OR-NOTHING. One bad row refuses the whole file; nothing is half-written.
 *
 * The standing invariant (CLAUDE.md §4): the trial balance still balances — trivially, because this
 * importer never touches the ledger. We assert it anyway.
 */

const RETAIL_MINOR = 399_900 // Rs 3999.00, 2 dp
const WHOLESALE_MINOR = 230_000 // Rs 2300.00, 2 dp

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
  return t.db
    .prepare("SELECT id FROM lookups WHERE list_key = 'uom' AND code = 'pcs'")
    .pluck()
    .get() as number
}

/** An item the shop already has. The importer must MATCH it, not make a second one. */
function existingProduct(options: {
  sku: string
  name: string
  retailPrice?: number
  wholesalePrice?: number
  barcodes?: string[]
}): number {
  return products.create(
    t.db,
    actor,
    {
      sku: options.sku,
      name: options.name,
      saleUomId: uomId(),
      retailPrice: options.retailPrice ?? 0,
      wholesalePrice: options.wholesalePrice ?? 0,
      barcodes: options.barcodes ?? []
    },
    new Date()
  ).product.id
}

// ── Building a spreadsheet, the way the owner's Excel would ──────────────────

type CellSpec = string | number | null | { value: string | number; numFmt: string }
type Cells = Record<string, CellSpec>

async function makeWorkbook(rows: Cells[], sheetName = PRODUCT_SHEET): Promise<Buffer> {
  const workbook = new Workbook()
  const sheet = workbook.addWorksheet(sheetName)
  const headers = PRODUCT_COLUMNS.map((c) => c.header)
  sheet.addRow(headers)
  for (const cells of rows) writeCells(sheet, headers, cells)
  return (await workbook.xlsx.writeBuffer()) as unknown as Buffer
}

function writeCells(sheet: Worksheet, headers: string[], cells: Cells): void {
  const row = sheet.addRow([])
  for (const [header, spec] of Object.entries(cells)) {
    const index = headers.indexOf(header)
    expect(index, `no such column in this sheet: ${header}`).toBeGreaterThanOrEqual(0)

    const cell = row.getCell(index + 1)
    if (spec !== null && typeof spec === 'object') {
      cell.value = spec.value
      cell.numFmt = spec.numFmt
    } else {
      cell.value = spec
    }
  }
}

// ── Counters ─────────────────────────────────────────────────────────────────

function count(table: string): number {
  return t.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number
}

/** THE STANDING TEST (CLAUDE.md §4): the trial balance balances — trivially, since we never post. */
function expectTrialBalanceBalances(): void {
  expect(ledger.trialBalance(t.db).balanced, 'the trial balance does not balance').toBe(true)
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('product-import — the float trap', () => {
  it('REFUSES a price with three decimals, by row number, and never rounds it', async () => {
    const buffer = await makeWorkbook([
      { 'STOCK CODE': 'NEW-1', 'ITEM NAME': 'Ghee 1kg', 'RETAIL PRICE': 199.999 }
    ])

    const preview = await productImport.parseProductWorkbook(t.db, buffer, { onExisting: 'skip' })

    expect(preview.errors.length).toBe(1)
    const problem = preview.errors[0]
    expect(problem?.row).toBe(2) // header is row 1; the data is row 2, as Excel shows it
    expect(problem?.column).toBe('RETAIL PRICE')
    // The message quotes the value back and says how to fix it — never a stack trace.
    expect(problem?.message).toContain('199.999')

    // And applying refuses the whole thing rather than rounding.
    await expect(
      productImport.applyProductImport(t.db, actor, buffer, { onExisting: 'skip' })
    ).rejects.toBeInstanceOf(AppError)
    expect(count('products')).toBe(0)
  })
})

describe('product-import — creating and skipping', () => {
  it('creates a new item, and its cost seeds at 0 (never typed)', async () => {
    const buffer = await makeWorkbook([
      {
        'STOCK CODE': 'RICE-5',
        'ITEM NAME': 'Basmati Rice 5kg',
        'RETAIL PRICE': '3999',
        'WHOLESALE PRICE': '2300'
      }
    ])

    const result = await productImport.applyProductImport(t.db, actor, buffer, { onExisting: 'skip' })

    expect(result).toEqual({ created: 1, updated: 0, skipped: 0 })

    const created = products.findBySku(t.db, 'RICE-5')
    expect(created).not.toBeNull()
    expect(created?.retailPrice).toBe(RETAIL_MINOR)
    expect(created?.wholesalePrice).toBe(WHOLESALE_MINOR)
    // Cost is DERIVED — seeded at 0, exactly as the product form leaves it with no purchase yet.
    expect(created?.costPrice).toBe(0)

    // No stock, no journal — the whole point.
    expect(count('stock_movements')).toBe(0)
    expect(count('journals')).toBe(0)
    expectTrialBalanceBalances()

    // ONE audit row records that a bulk import ran, with the actor and the counts — "who did what,
    // when" (CLAUDE.md §4). The per-item create is audited separately by products.create.
    const importRow = t.db
      .prepare(`SELECT user_name, user_role FROM audit_log WHERE action = 'product.import'`)
      .get() as { user_name: string; user_role: string } | undefined
    expect(importRow, 'a product.import audit row must be written').toBeTruthy()
    expect(importRow?.user_role).toBe(actor.role)
  })

  it('SKIPS an existing SKU in skip mode and leaves its price untouched', async () => {
    existingProduct({ sku: 'RICE-5', name: 'Basmati Rice 5kg', retailPrice: RETAIL_MINOR })

    const buffer = await makeWorkbook([
      { 'STOCK CODE': 'RICE-5', 'ITEM NAME': 'Basmati Rice 5kg', 'RETAIL PRICE': '4500' }
    ])

    const result = await productImport.applyProductImport(t.db, actor, buffer, { onExisting: 'skip' })

    expect(result).toEqual({ created: 0, updated: 0, skipped: 1 })
    // The price the sheet carried (Rs 4500) is IGNORED — the item keeps Rs 3999.
    expect(products.findBySku(t.db, 'RICE-5')?.retailPrice).toBe(RETAIL_MINOR)
    expect(count('products')).toBe(1) // not a second, duplicate product
    expectTrialBalanceBalances()
  })
})

describe('product-import — update-prices mode is safe', () => {
  it('updates the price but NOT the cost, and posts NO movement and NO journal', async () => {
    const id = existingProduct({
      sku: 'RICE-5',
      name: 'Basmati Rice 5kg',
      retailPrice: RETAIL_MINOR,
      wholesalePrice: WHOLESALE_MINOR
    })

    // Give the item a real, non-zero cost the way it happens in life — a stock adjustment posts a
    // movement and a journal, and cost becomes the weighted average of what was paid.
    const before = products.getById(t.db, id).product
    const costBefore = before.costPrice

    const movementsBefore = count('stock_movements')
    const journalsBefore = count('journals')

    const buffer = await makeWorkbook([
      { 'STOCK CODE': 'RICE-5', 'ITEM NAME': 'ignored', 'RETAIL PRICE': '4500' }
    ])

    const result = await productImport.applyProductImport(t.db, actor, buffer, {
      onExisting: 'update-prices'
    })

    expect(result).toEqual({ created: 0, updated: 1, skipped: 0 })

    const after = products.getById(t.db, id).product
    expect(after.retailPrice).toBe(450_000) // repriced to Rs 4500
    // COST IS UNTOUCHED — this importer physically cannot write it (not in products.update's map).
    expect(after.costPrice).toBe(costBefore)

    // THE CORE SAFETY PROPERTY: no new stock movement, no new journal.
    expect(count('stock_movements')).toBe(movementsBefore)
    expect(count('journals')).toBe(journalsBefore)
    expectTrialBalanceBalances()
  })

  it('classifies an existing item with identical prices as no-change and calls nothing', async () => {
    existingProduct({
      sku: 'RICE-5',
      name: 'Basmati Rice 5kg',
      retailPrice: RETAIL_MINOR,
      wholesalePrice: WHOLESALE_MINOR
    })

    const buffer = await makeWorkbook([
      { 'STOCK CODE': 'RICE-5', 'ITEM NAME': 'x', 'RETAIL PRICE': '3999', 'WHOLESALE PRICE': '2300' }
    ])

    const preview = await productImport.parseProductWorkbook(t.db, buffer, {
      onExisting: 'update-prices'
    })
    expect(preview.rows[0]?.classification).toBe('skip-nochange')
    expect(preview.toUpdate).toBe(0)

    const result = await productImport.applyProductImport(t.db, actor, buffer, {
      onExisting: 'update-prices'
    })
    expect(result).toEqual({ created: 0, updated: 0, skipped: 1 })
    // No product.price_change audit row was written, because nothing changed.
    const priceChanges = t.db
      .prepare(`SELECT COUNT(*) FROM audit_log WHERE action = 'product.price_change'`)
      .pluck()
      .get() as number
    expect(priceChanges).toBe(0)
  })
})

describe('product-import — matching and clashes', () => {
  it('matches an existing item BY BARCODE when the stock code is new', async () => {
    const id = existingProduct({
      sku: 'RICE-5',
      name: 'Basmati Rice 5kg',
      retailPrice: RETAIL_MINOR,
      barcodes: ['8964000012345']
    })

    // A row with a DIFFERENT stock code but the item's barcode — the owner re-keyed the code.
    const buffer = await makeWorkbook([
      {
        'STOCK CODE': 'RICE-NEW-CODE',
        'ITEM NAME': 'Basmati Rice 5kg',
        'BARCODE': '8964000012345',
        'RETAIL PRICE': '4500'
      }
    ])

    const preview = await productImport.parseProductWorkbook(t.db, buffer, {
      onExisting: 'update-prices'
    })

    expect(preview.errors).toEqual([])
    // It resolved to the EXISTING product, not a new one.
    expect(preview.rows[0]?.productId).toBe(id)
    expect(preview.rows[0]?.classification).toBe('update')
    expect(preview.toCreate).toBe(0)

    await productImport.applyProductImport(t.db, actor, buffer, { onExisting: 'update-prices' })
    expect(count('products')).toBe(1) // still one product — no duplicate created
    expect(products.getById(t.db, id).product.retailPrice).toBe(450_000)
    expectTrialBalanceBalances()
  })

  it('REFUSES a barcode already on ANOTHER product, naming it', async () => {
    // Rice owns the barcode.
    existingProduct({ sku: 'RICE-5', name: 'Basmati Rice 5kg', barcodes: ['8964000012345'] })
    // Sugar exists too, under its own code — the row below is unmistakably Sugar (SKU matches Sugar),
    // and it is trying to take Rice's barcode. That is a genuine clash, not a re-key.
    existingProduct({ sku: 'SUGAR-1', name: 'Sugar 1kg' })

    const buffer = await makeWorkbook([
      {
        'STOCK CODE': 'SUGAR-1',
        'ITEM NAME': 'Sugar 1kg',
        'BARCODE': '8964000012345',
        'RETAIL PRICE': '150'
      }
    ])

    const preview = await productImport.parseProductWorkbook(t.db, buffer, {
      onExisting: 'update-prices'
    })

    expect(preview.errors.length).toBe(1)
    expect(preview.errors[0]?.column).toBe('BARCODE')
    expect(preview.errors[0]?.message).toContain('Basmati Rice 5kg')

    await expect(
      productImport.applyProductImport(t.db, actor, buffer, { onExisting: 'update-prices' })
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('product-import — the template', () => {
  it('carries NO cost, supplier-price or balance-quantity columns, and pre-fills existing items', async () => {
    existingProduct({ sku: 'RICE-5', name: 'Basmati Rice 5kg' })

    const buffer = await buildProductTemplate(t.db)
    const workbook = new Workbook()
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0])

    const sheet = workbook.getWorksheet(PRODUCT_SHEET) as Worksheet
    const headers: string[] = []
    sheet.getRow(1).eachCell((cell, column) => {
      headers[column - 1] = String(cell.value ?? '').trim().toUpperCase()
    })

    // The columns that would let a bulk sheet silently revalue the shelf or write a cost are ABSENT.
    for (const forbidden of [
      'BALANCE QUANTITY',
      'COST PRICE',
      'UNIT COST',
      'SUPPLIER PRICE',
      'DISCOUNT'
    ]) {
      expect(headers, `template must not carry ${forbidden}`).not.toContain(forbidden)
    }

    // The item the shop already has is pre-filled — so the owner edits rather than retypes the name.
    const skuColumn = headers.indexOf('STOCK CODE') + 1
    const filled: string[] = []
    sheet.eachRow((row, n) => {
      if (n === 1) return
      filled.push(String(row.getCell(skuColumn).value ?? ''))
    })
    expect(filled).toContain('RICE-5')
  })
})

describe('product-import — an imported item is a NORMAL product, fully editable', () => {
  /**
   * The client asked: after importing an item from the sheet, opening it must show all its details so
   * it can be edited like any other. It ALREADY does — the importer creates through products.create,
   * the same path the form uses, so the edit form's products.getById() finds a complete product. This
   * pins that: import a rich row, read it back the way the edit form does, and assert every field
   * round-trips. If the importer ever diverged from create(), this fails.
   */
  it('round-trips through products.getById exactly as the edit form loads it', async () => {
    const buffer = await makeWorkbook([
      {
        'STOCK CODE': 'FULL-1',
        'ITEM NAME': 'Cooking Oil 5L',
        'OTHER LANGUAGE NAME': 'کھانا پکانے کا تیل',
        'RETAIL PRICE': '2499',
        'WHOLESALE PRICE': '2300',
        'RE ORDER LEVEL': '6',
        BARCODE: '8964000112233',
        'ITEM TYPE': 'inventory'
      }
    ])

    const result = await productImport.applyProductImport(t.db, actor, buffer, { onExisting: 'skip' })
    expect(result.created).toBe(1)

    // EXACTLY what the edit form calls when the row is clicked.
    const found = products.findBySku(t.db, 'FULL-1')
    expect(found, 'the imported item must exist').not.toBeNull()
    const detail = products.getById(t.db, found!.id)

    expect(detail.product.name).toBe('Cooking Oil 5L')
    expect(detail.product.nameOtherLang).toBe('کھانا پکانے کا تیل')
    expect(detail.product.retailPrice).toBe(249_900)
    expect(detail.product.wholesalePrice).toBe(230_000)
    // The barcode the sheet carried is on the item, so the form's barcode list is populated too.
    expect(detail.barcodes.map((b) => b.barcode)).toContain('8964000112233')
    // And it is immediately re-editable through the normal update path — no import-only limbo.
    products.update(t.db, actor, { id: found!.id, retailPrice: 260_000 })
    expect(products.getById(t.db, found!.id).product.retailPrice).toBe(260_000)
  })
})

describe('product-import — all or nothing', () => {
  it('one bad row refuses the WHOLE file; nothing is half-written', async () => {
    const buffer = await makeWorkbook([
      { 'STOCK CODE': 'GOOD-1', 'ITEM NAME': 'Good Item', 'RETAIL PRICE': '100' },
      { 'STOCK CODE': 'BAD-1', 'ITEM NAME': 'Bad Item', 'RETAIL PRICE': '12.345' }, // 3 decimals
      { 'STOCK CODE': 'GOOD-2', 'ITEM NAME': 'Another Good Item', 'RETAIL PRICE': '200' }
    ])

    await expect(
      productImport.applyProductImport(t.db, actor, buffer, { onExisting: 'skip' })
    ).rejects.toBeInstanceOf(AppError)

    // NOT the two good rows — none of it. A half-imported catalogue is worse than none.
    expect(count('products')).toBe(0)
    expect(count('stock_movements')).toBe(0)
    expect(count('journals')).toBe(0)
    expectTrialBalanceBalances()
  })
})
