import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Workbook, type Worksheet, type Xlsx } from 'exceljs'
import { makeTestDb, type TestDb } from '../db/testkit'
import { AppError } from '@shared/result'
import { ONE_UNIT } from '@shared/qty'
import type { User } from '@shared/types'
import * as excel from './excel-import'
import { buildTemplate, CASH_COLUMNS, PARTY_COLUMNS, SHEET_CASH, SHEET_DUES, SHEET_STOCK, SHEET_UDHAAR, STOCK_COLUMNS } from './excel-template'
import * as ledger from './ledger'
import * as lookups from './lookups'
import * as opening from './opening'
import * as products from './products'
import * as stock from './stock'
import { ACC } from '../db/chart-of-accounts'

/**
 * THE OPENING-BALANCE IMPORT.
 *
 * Everything in this file defends one sentence: EXCEL HANDS YOU FLOATS, AND NOT ONE OF THEM REACHES THE
 * LEDGER.
 *
 * A cell showing 2185.0000 arrives as a JS double. The whole app rests on money, cost and quantity
 * being INTEGERS on three different scales, and a single float admitted here would undo all of it —
 * quietly, in the shop's books, forever. So the tests below assert the STORED INTEGERS, not the
 * formatted output: 2185.0000 must become exactly 21_850_000, and a price with three decimals in it
 * must be REFUSED, by row number, rather than rounded and hoped over.
 *
 * The standing test from CLAUDE.md §4 runs at the end of every scenario that posts: the trial balance
 * balances.
 */

// ── The legacy numbers, from the owner's own Item Detail screen ──────────────
//
// A carton of 24 bought for Rs 2,185. Per piece that is Rs 91.041666… — which at 2 dp would be Rs 91.04,
// and the 0.0017 lost on every piece across a year of sales quietly falsifies every profit report the
// shop runs. This is why cost is 4 dp, and it is the number the round trip below asserts to the digit.
const SUPPLIER_PRICE_TEXT = '2185.0000'
const SUPPLIER_PRICE_COST = 21_850_000 // 4 dp
const RETAIL_MINOR = 399_900 // Rs 3999.00, 2 dp
const WHOLESALE_MINOR = 230_000 // Rs 2300.00, 2 dp
const CARTON = 24
const UNIT_COST = 910_417 // 4 dp — Rs 91.0417, NOT Rs 91.04
const OPENING_QTY_M = 40 * ONE_UNIT
/** 40 x Rs 91.0417 = Rs 3,641.668 -> Rs 3,641.67. Rounded PER LINE, exactly as the journal will post it. */
const LINE_VALUE_MINOR = 364_167

// ── Fixtures ─────────────────────────────────────────────────────────────────

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
  itemType?: 'inventory' | 'non_inventory'
  trackBatches?: boolean
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
      itemType: options.itemType ?? 'inventory',
      trackBatches: options.trackBatches ?? false,
      barcodes: options.barcodes ?? []
    },
    new Date()
  ).product.id
}

// ── Building a spreadsheet, the way the owner's Excel would ──────────────────

/**
 * A cell, as Excel would hand it to us. A bare number is the DANGEROUS case — that is the float — and
 * most of the tests below deliberately write numbers rather than strings for exactly that reason.
 */
type CellSpec = string | number | null | { value: string | number; numFmt: string }

/** Keyed by the header EXACTLY as it appears in the sheet. If a header ever changes, these break. */
type Cells = Record<string, CellSpec>

type SheetData = {
  stock?: Cells[]
  udhaar?: Cells[]
  dues?: Cells[]
  cash?: Cells
  /** Leave a sheet out entirely, to prove a missing sheet is not a crash. */
  omit?: string[]
}

async function makeWorkbook(data: SheetData): Promise<Buffer> {
  const workbook = new Workbook()
  const omit = new Set(data.omit ?? [])

  const add = (
    name: string,
    headers: string[],
    rows: Cells[]
  ): void => {
    if (omit.has(name)) return
    const sheet = workbook.addWorksheet(name)
    sheet.addRow(headers)
    for (const cells of rows) writeCells(sheet, headers, cells)
  }

  add(SHEET_STOCK, STOCK_COLUMNS.map((column) => column.header), data.stock ?? [])
  add(SHEET_UDHAAR, PARTY_COLUMNS.map((column) => column.header), data.udhaar ?? [])
  add(SHEET_DUES, PARTY_COLUMNS.map((column) => column.header), data.dues ?? [])
  add(SHEET_CASH, CASH_COLUMNS.map((column) => column.header), data.cash ? [data.cash] : [])

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

/** Load a generated template and fill it in — exactly what the owner does in Excel. */
async function fillTemplate(template: Buffer, data: SheetData): Promise<Buffer> {
  const workbook = new Workbook()
  await workbook.xlsx.load(template as unknown as Parameters<Xlsx['load']>[0])

  const fill = (name: string, rows: Cells[]): void => {
    const sheet = workbook.getWorksheet(name)
    expect(sheet, `the template has no "${name}" sheet`).toBeDefined()
    const headers = headerRow(sheet as Worksheet)

    for (const cells of rows) {
      const sku = cells['STOCK CODE']
      const existing = typeof sku === 'string' ? findRowBySku(sheet as Worksheet, headers, sku) : undefined

      // An item already listed in the template gets its blanks filled in, in place. A new one is
      // appended at the bottom. That is precisely the owner's workflow.
      if (existing) {
        for (const [header, spec] of Object.entries(cells)) {
          const index = headers.indexOf(header)
          const cell = existing.getCell(index + 1)
          if (spec !== null && typeof spec === 'object') {
            cell.value = spec.value
            cell.numFmt = spec.numFmt
          } else {
            cell.value = spec
          }
        }
      } else {
        writeCells(sheet as Worksheet, headers, cells)
      }
    }
  }

  fill(SHEET_STOCK, data.stock ?? [])
  fill(SHEET_UDHAAR, data.udhaar ?? [])
  fill(SHEET_DUES, data.dues ?? [])
  if (data.cash) {
    const sheet = workbook.getWorksheet(SHEET_CASH) as Worksheet
    const headers = headerRow(sheet)
    const row = sheet.getRow(2)
    for (const [header, spec] of Object.entries(data.cash)) {
      row.getCell(headers.indexOf(header) + 1).value = spec as string | number | null
    }
  }

  return (await workbook.xlsx.writeBuffer()) as unknown as Buffer
}

function headerRow(sheet: Worksheet): string[] {
  const headers: string[] = []
  sheet.getRow(1).eachCell((cell, column) => {
    headers[column - 1] = String(cell.value ?? '').trim()
  })
  return headers
}

function findRowBySku(sheet: Worksheet, headers: string[], sku: string) {
  const column = headers.indexOf('STOCK CODE') + 1
  let found: ReturnType<Worksheet['getRow']> | undefined

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return
    if (String(row.getCell(column).value ?? '').trim() === sku) found = row
  })

  return found
}

// ── Standing assertions ──────────────────────────────────────────────────────

/** THE STANDING TEST (CLAUDE.md §4): after every scenario, the trial balance balances. */
function assertBooksBalance(): void {
  const tb = ledger.trialBalance(t.db)
  expect(tb.balanced, 'the trial balance does not balance').toBe(true)
  expect(tb.totalDebit).toBe(tb.totalCredit)
}

/** The stored average is honest: products.cost_price === the average rebuilt from the movements alone. */
function assertAverageCostIsHonest(): void {
  const ids = t.db.prepare('SELECT id FROM products').pluck().all() as number[]
  for (const id of ids) {
    const stored = t.db.prepare('SELECT cost_price FROM products WHERE id = ?').pluck().get(id)
    expect(stored, `product ${id}: the stored average has drifted from its movements`).toBe(
      stock.recomputeAverageCost(t.db, id)
    )
  }
}

/** Nothing was written. Used after every refusal — a refused import must leave no trace at all. */
function assertNothingWritten(): void {
  expect(t.db.prepare('SELECT COUNT(*) FROM products').pluck().get()).toBe(0)
  expect(t.db.prepare('SELECT COUNT(*) FROM opening_stock_lines').pluck().get()).toBe(0)
  expect(t.db.prepare('SELECT COUNT(*) FROM opening_receivables').pluck().get()).toBe(0)
  expect(t.db.prepare('SELECT COUNT(*) FROM opening_payables').pluck().get()).toBe(0)
  expect(t.db.prepare('SELECT COUNT(*) FROM stock_movements').pluck().get()).toBe(0)
  expect(t.db.prepare('SELECT COUNT(*) FROM journals').pluck().get()).toBe(0)
}

/** The message a SHOPKEEPER sees — not the technical one that goes to the log file. */
async function expectRefusal(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await run()
  } catch (error) {
    const shown = error instanceof AppError ? error.userMessage : (error as Error).message
    expect(shown).toMatch(pattern)
    expect(shown).not.toMatch(/zod|sqlite|undefined|\bNaN\b|Error:/i)
    return
  }
  throw new Error('Expected that import to be refused, but it succeeded.')
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE FLOAT TRAP
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('the float trap — Excel hands you doubles', () => {
  it('imports 2185.0000 as EXACTLY 21_850_000 (4-dp cost) and 3999.00 as EXACTLY 399_900 (2-dp money)', async () => {
    const buffer = await makeWorkbook({
      stock: [
        {
          // A REAL NUMBER, not a string. This is precisely what a legacy export hands us, and it is
          // a JS double by the time it reaches the parser.
          'STOCK CODE': 'OIL-5L',
          'ITEM NAME': 'Cooking Oil 5L',
          PACKING: 1,
          'SUPPLIER PRICE': 2185.0,
          'RETAIL PRICE': 3999.0,
          'WHOLESALE PRICE': 2300.0
        },
        {
          // The same figures, typed as TEXT into a text-formatted column (what our own template does).
          // Both roads must arrive at the same integer, or the template and a legacy export disagree.
          'STOCK CODE': 'OIL-5L-TXT',
          'ITEM NAME': 'Cooking Oil 5L (text cells)',
          PACKING: '1',
          'SUPPLIER PRICE': SUPPLIER_PRICE_TEXT,
          'RETAIL PRICE': '3999.00',
          'WHOLESALE PRICE': '2300.00'
        }
      ]
    })

    const preview = await excel.parseWorkbook(t.db, buffer)
    expect(preview.errors).toEqual([])

    const [fromNumber, fromText] = preview.stock.rows
    expect(fromNumber?.packCost).toBe(SUPPLIER_PRICE_COST)
    expect(fromNumber?.retailPrice).toBe(RETAIL_MINOR)
    expect(fromNumber?.wholesalePrice).toBe(WHOLESALE_MINOR)

    // Identical integers from both. A number cell and a text cell are the same figure.
    expect(fromText?.packCost).toBe(SUPPLIER_PRICE_COST)
    expect(fromText?.retailPrice).toBe(RETAIL_MINOR)
    expect(fromText?.wholesalePrice).toBe(WHOLESALE_MINOR)

    await excel.applyImport(t.db, actor, buffer)

    // THE STORED INTEGERS, straight out of SQLite. Not a formatted string — the actual columns.
    const stored = t.db
      .prepare('SELECT retail_price, wholesale_price FROM products WHERE sku = ?')
      .get('OIL-5L') as { retail_price: number; wholesale_price: number }

    expect(stored.retail_price).toBe(399_900)
    expect(stored.wholesale_price).toBe(230_000)
    expect(Number.isInteger(stored.retail_price)).toBe(true)
  })

  it('REFUSES a money cell with 3 decimal places — it does not round it', async () => {
    const buffer = await makeWorkbook({
      stock: [
        { 'STOCK CODE': 'RICE-5KG', 'ITEM NAME': 'Rice 5kg', 'RETAIL PRICE': 3999.123 }
      ]
    })

    const preview = await excel.parseWorkbook(t.db, buffer)

    expect(preview.errors).toHaveLength(1)
    const error = preview.errors[0]
    expect(error?.sheet).toBe(SHEET_STOCK)
    expect(error?.row).toBe(2) // the row number the owner can SEE in Excel
    expect(error?.column).toBe('RETAIL PRICE')
    expect(error?.value).toBe('3999.123')
    expect(error?.message).toMatch(/no more than 2 numbers after the dot/i)

    // And it is REFUSED, not quietly rounded to 3999.12.
    await expectRefusal(() => excel.applyImport(t.db, actor, buffer), /row 2/i)
    assertNothingWritten()
  })

  it('REFUSES a float artifact (0.1 + 0.2) rather than absorbing it', async () => {
    const buffer = await makeWorkbook({
      stock: [{ 'STOCK CODE': 'X', 'ITEM NAME': 'X', 'RETAIL PRICE': 0.1 + 0.2 }]
    })

    const preview = await excel.parseWorkbook(t.db, buffer)
    expect(preview.errors[0]?.value).toBe('0.30000000000000004')
    expect(preview.errors[0]?.column).toBe('RETAIL PRICE')
  })

  it('REFUSES a cost with more than 4 decimal places', async () => {
    const buffer = await makeWorkbook({
      stock: [{ 'STOCK CODE': 'X', 'ITEM NAME': 'X', 'SUPPLIER PRICE': 91.041666 }]
    })

    const preview = await excel.parseWorkbook(t.db, buffer)
    expect(preview.errors[0]?.column).toBe('SUPPLIER PRICE')
    expect(preview.errors[0]?.message).toMatch(/no more than 4 numbers after the dot/i)
  })

  it('REFUSES a percent-formatted discount cell, because Excel stores 5% as 0.05', async () => {
    // Left alone, this imports a 0.05% discount where the owner meant 5% — and the cost comes out at
    // 99.95% of the supplier price instead of 95%, on every item, looking perfectly reasonable.
    const buffer = await makeWorkbook({
      stock: [
        {
          'STOCK CODE': 'X',
          'ITEM NAME': 'X',
          'SUPPLIER PRICE': 2185,
          DISCOUNT: { value: 0.05, numFmt: '0.00%' }
        }
      ]
    })

    const preview = await excel.parseWorkbook(t.db, buffer)
    expect(preview.errors[0]?.column).toBe('DISCOUNT')
    expect(preview.errors[0]?.message).toMatch(/formatted as a percentage/i)
  })

  it('reads a plain discount as basis points: 5 -> 500', async () => {
    const buffer = await makeWorkbook({
      stock: [{ 'STOCK CODE': 'X', 'ITEM NAME': 'X', 'SUPPLIER PRICE': 2185, DISCOUNT: 5, PACKING: 1 }]
    })

    const preview = await excel.parseWorkbook(t.db, buffer)
    expect(preview.errors).toEqual([])
    expect(preview.stock.rows[0]?.discountBp).toBe(500)
    // Rs 2185 less 5% = Rs 2075.75, to the last of the four decimals.
    expect(preview.stock.rows[0]?.packCost).toBe(20_757_500)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// PLAIN-LANGUAGE REFUSALS
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('rejecting a row, in words a shopkeeper can act on', () => {
  it('names the sheet, the row, the column and the value when a quantity is not a number', async () => {
    const buffer = await makeWorkbook({
      stock: [
        { 'STOCK CODE': 'A', 'ITEM NAME': 'A' },
        { 'STOCK CODE': 'RICE-5KG', 'ITEM NAME': 'Rice 5kg', 'BALANCE QUANTITY': 'abc' }
      ]
    })

    const preview = await excel.parseWorkbook(t.db, buffer)

    expect(preview.errors).toHaveLength(1)
    expect(preview.errors[0]).toEqual({
      sheet: 'Stock',
      row: 3,
      column: 'BALANCE QUANTITY',
      value: 'abc',
      message: expect.stringContaining('We could not read "abc" as a quantity')
    })
    // No stack trace, no jargon. A cashier reads this.
    expect(preview.errors[0]?.message).not.toMatch(/zod|parse|null|NaN/i)
  })

  it('REFUSES a duplicate stock code rather than silently letting one row win', async () => {
    const buffer = await makeWorkbook({
      stock: [
        { 'STOCK CODE': 'RICE-5KG', 'ITEM NAME': 'Rice 5kg', 'BALANCE QUANTITY': 10, 'SUPPLIER PRICE': 100 },
        { 'STOCK CODE': 'SUGAR', 'ITEM NAME': 'Sugar' },
        { 'STOCK CODE': 'rice-5kg', 'ITEM NAME': 'Rice 5kg again', 'BALANCE QUANTITY': 25, 'SUPPLIER PRICE': 100 }
      ]
    })

    const preview = await excel.parseWorkbook(t.db, buffer)

    expect(preview.errors).toHaveLength(1)
    expect(preview.errors[0]?.row).toBe(4)
    expect(preview.errors[0]?.column).toBe('STOCK CODE')
    expect(preview.errors[0]?.message).toMatch(/already on row 2/i)

    await expectRefusal(() => excel.applyImport(t.db, actor, buffer), /row 4/i)
    assertNothingWritten()
  })

  it('REFUSES a balance quantity on a NON INVENTORY item', async () => {
    const buffer = await makeWorkbook({
      stock: [
        {
          'STOCK CODE': 'DELIVERY',
          'ITEM NAME': 'Home Delivery',
          'ITEM TYPE': 'NON INVENTORY',
          'BALANCE QUANTITY': 5
        }
      ]
    })

    const preview = await excel.parseWorkbook(t.db, buffer)

    expect(preview.errors).toHaveLength(1)
    expect(preview.errors[0]?.row).toBe(2)
    expect(preview.errors[0]?.column).toBe('BALANCE QUANTITY')
    expect(preview.errors[0]?.message).toMatch(/not a stocked item|NON INVENTORY/i)

    await expectRefusal(() => excel.applyImport(t.db, actor, buffer), /row 2/i)
    assertNothingWritten()
  })

  it('REFUSES a balance quantity on an item that is ALREADY non-inventory, even with no ITEM TYPE column', async () => {
    // The sheet says nothing about the type — but the shop's own catalogue does, and it is the one
    // that decides. A service cannot acquire a shelf just because a column was left blank.
    existingProduct({ sku: 'DELIVERY', name: 'Home Delivery', itemType: 'non_inventory' })

    const buffer = await makeWorkbook({
      stock: [{ 'STOCK CODE': 'DELIVERY', 'BALANCE QUANTITY': 5 }]
    })

    const preview = await excel.parseWorkbook(t.db, buffer)
    expect(preview.errors[0]?.column).toBe('BALANCE QUANTITY')
    expect(preview.errors[0]?.message).toMatch(/NON INVENTORY/i)
  })

  it('REFUSES a barcode Excel has already mangled into a number', async () => {
    const buffer = await makeWorkbook({
      stock: [{ 'STOCK CODE': 'X', 'ITEM NAME': 'X', BARCODE: 8.964000012345e21 }]
    })

    const preview = await excel.parseWorkbook(t.db, buffer)
    expect(preview.errors[0]?.column).toBe('BARCODE')
    expect(preview.errors[0]?.message).toMatch(/format the barcode column as Text/i)
  })

  it('REFUSES a barcode that already belongs to a different item', async () => {
    existingProduct({ sku: 'RICE-5KG', name: 'Rice 5kg', barcodes: ['8964000012345'] })

    const buffer = await makeWorkbook({
      stock: [{ 'STOCK CODE': 'SUGAR', 'ITEM NAME': 'Sugar', BARCODE: '8964000012345' }]
    })

    const preview = await excel.parseWorkbook(t.db, buffer)
    expect(preview.errors[0]?.column).toBe('BARCODE')
    expect(preview.errors[0]?.message).toMatch(/already belongs to "Rice 5kg"/i)
  })

  it('REFUSES a new stock code with no item name', async () => {
    const buffer = await makeWorkbook({ stock: [{ 'STOCK CODE': 'NEW-1', 'RETAIL PRICE': 100 }] })

    const preview = await excel.parseWorkbook(t.db, buffer)
    expect(preview.errors[0]?.column).toBe('ITEM NAME')
    expect(preview.errors[0]?.message).toMatch(/new stock code/i)
  })

  it('REFUSES a file that is not the template at all', async () => {
    const workbook = new Workbook()
    workbook.addWorksheet('Sheet1').addRow(['hello'])
    const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer

    await expectRefusal(
      () => excel.parseWorkbook(t.db, buffer),
      /does not look like the import template/i
    )
  })

  it('REFUSES something that is not a spreadsheet', async () => {
    await expectRefusal(
      () => excel.parseWorkbook(t.db, Buffer.from('this is not an xlsx file')),
      /could not open that file/i
    )
  })

  it('reports EVERY problem in one pass, not just the first', async () => {
    const buffer = await makeWorkbook({
      stock: [
        { 'STOCK CODE': 'A', 'ITEM NAME': 'A', 'RETAIL PRICE': 1.234 },
        { 'STOCK CODE': 'B', 'ITEM NAME': 'B', 'BALANCE QUANTITY': 'lots' },
        { 'STOCK CODE': 'C', 'ITEM NAME': 'C', 'SUPPLIER PRICE': 'free' }
      ]
    })

    const preview = await excel.parseWorkbook(t.db, buffer)

    // One upload, one list of everything wrong with the file. Not "fix this, upload, fix that,
    // upload" across a 900-row sheet — that is how people give up and type it in by hand.
    expect(preview.errors.map((error) => error.row)).toEqual([2, 3, 4])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// LOOKUPS
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('lookups', () => {
  it('auto-creates unknown departments, categories and brands, and reports them in the preview', async () => {
    const buffer = await makeWorkbook({
      stock: [
        {
          'STOCK CODE': 'OIL-5L',
          'ITEM NAME': 'Cooking Oil 5L',
          DEPARTMENT: 'Grocery',
          CATEGORY: 'Cooking Oil',
          'SUB CATEGORY': 'Vegetable Oil',
          BRAND: 'Dalda',
          LOCATION: 'Aisle 3'
        },
        {
          'STOCK CODE': 'OIL-1L',
          'ITEM NAME': 'Cooking Oil 1L',
          DEPARTMENT: 'grocery', // the same department, spelled differently. One lookup, not two.
          BRAND: 'Dalda',
          CATEGORY: 'General' // this one is SEEDED — it must not be created a second time
        }
      ]
    })

    const preview = await excel.parseWorkbook(t.db, buffer)

    expect(preview.errors).toEqual([])
    expect(preview.lookupsToCreate).toEqual({
      department: ['Grocery'],
      category: ['Cooking Oil'],
      sub_category: ['Vegetable Oil'],
      brand: ['Dalda'],
      location: ['Aisle 3']
    })

    const result = await excel.applyImport(t.db, actor, buffer)
    expect(result.lookupsCreated).toBe(5)

    // Created once, and BOTH items point at the same one.
    const departments = lookups.list(t.db, 'department')
    expect(departments.filter((row) => row.label.toLowerCase() === 'grocery')).toHaveLength(1)

    const grocery = departments.find((row) => row.label === 'Grocery')
    const oil5 = products.getBySku(t.db, 'OIL-5L').product
    const oil1 = products.getBySku(t.db, 'OIL-1L').product

    expect(oil5.departmentId).toBe(grocery?.id)
    expect(oil1.departmentId).toBe(grocery?.id)
    expect(oil5.brandId).toBe(lookups.list(t.db, 'brand').find((row) => row.label === 'Dalda')?.id)

    // "General" was already seeded. It is reused, not duplicated.
    expect(lookups.list(t.db, 'category').filter((row) => row.code === 'general')).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE ROUND TRIP — build the template, fill it in, import it, commit it
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('the full round trip', () => {
  it('template -> fill -> parse -> apply -> commit: the books balance and the cost is exact', async () => {
    // One item the shop already has (so the template pre-fills it), and one it does not.
    existingProduct({ sku: 'SUGAR', name: 'Sugar 1kg', retailPrice: 15_000 })

    const template = await buildTemplate(t.db)

    const buffer = await fillTemplate(template, {
      stock: [
        {
          // The legacy carton, typed exactly as the owner's old POS exports it.
          'STOCK CODE': 'OIL-5L',
          'ITEM NAME': 'Cooking Oil 5L',
          'OTHER LANGUAGE NAME': 'کھانا پکانے کا تیل',
          DEPARTMENT: 'Grocery',
          CATEGORY: 'Cooking Oil',
          BRAND: 'Dalda',
          PACKING: CARTON,
          'SUPPLIER PRICE': SUPPLIER_PRICE_TEXT,
          'RETAIL PRICE': '3999.00',
          'WHOLESALE PRICE': '2300.00',
          // These four are DERIVED. Whatever nonsense the legacy export puts here is thrown away.
          'COST PRICE': '9999.99',
          'UNIT COST': '1.23',
          PROFIT: '999',
          'NET PROFIT': '999',
          'RE ORDER LEVEL': 10,
          'BALANCE QUANTITY': 40,
          BARCODE: '8964000012345',
          'ITEM TYPE': 'INVENTORY'
        },
        // The pre-filled row for the item the shop already has: only the numbers get typed.
        { 'STOCK CODE': 'SUGAR', 'BALANCE QUANTITY': 12, 'SUPPLIER PRICE': '100.0000' }
      ],
      udhaar: [{ NAME: 'Muhammad Rashid', PHONE: '0300-1234567', 'AMOUNT OWED': '12400.00', NOTE: 'Old ledger page 4' }],
      dues: [{ NAME: 'Metro Cash & Carry', 'AMOUNT OWED': '8000.00' }],
      cash: { 'CASH IN HAND': '50000.00', 'BANK BALANCE': '200000.00' }
    })

    // ── PREVIEW: nothing written ────────────────────────────────────────────
    const preview = await excel.parseWorkbook(t.db, buffer)

    expect(preview.errors).toEqual([])
    expect(preview.stock.newProducts).toBe(1) // OIL-5L
    expect(preview.stock.existingProducts).toBe(1) // SUGAR, matched by stock code
    expect(preview.stock.openingLines).toBe(2)
    expect(preview.udhaar.totalMinor).toBe(1_240_000)
    expect(preview.dues.totalMinor).toBe(800_000)
    expect(preview.cash).toBe(5_000_000)
    expect(preview.bank).toBe(20_000_000)

    const oilRow = preview.stock.rows.find((row) => row.sku === 'OIL-5L')
    expect(oilRow?.packCost).toBe(SUPPLIER_PRICE_COST) // 2185.0000 -> 21_850_000
    expect(oilRow?.unitCost).toBe(UNIT_COST) // /24 -> 91.0417, NOT 91.04
    expect(oilRow?.qtyM).toBe(OPENING_QTY_M)
    expect(oilRow?.lineValueMinor).toBe(LINE_VALUE_MINOR)

    expect(t.db.prepare('SELECT COUNT(*) FROM opening_stock_lines').pluck().get()).toBe(0)

    // ── APPLY: the draft is filled in, but NOT committed ────────────────────
    const result = await excel.applyImport(t.db, actor, buffer)

    expect(result.productsCreated).toBe(1)
    // ZERO, not one. The SUGAR row carried only a quantity and a cost — and neither of those is a
    // detail OF THE ITEM: one becomes an opening stock movement, the other values it. Nothing about
    // Sugar itself changed, so nothing about Sugar itself is reported as changed.
    expect(result.productsUpdated).toBe(0)
    expect(result.customersCreated).toBe(1)
    expect(result.suppliersCreated).toBe(1)
    expect(result.stockLines).toBe(2)
    expect(opening.getSetup(t.db).status).toBe('draft') // the owner still presses Commit himself
    expect(t.db.prepare('SELECT COUNT(*) FROM journals').pluck().get()).toBe(0)

    const oil = products.getBySku(t.db, 'OIL-5L').product
    expect(oil.nameOtherLang).toBe('کھانا پکانے کا تیل')
    expect(oil.retailPrice).toBe(RETAIL_MINOR)
    expect(oil.wholesalePrice).toBe(WHOLESALE_MINOR)
    expect(oil.minStockM).toBe(10 * ONE_UNIT)

    // NOTHING has written cost_price. It is still zero — the opening movement seeds it at commit.
    expect(oil.costPrice).toBe(0)

    // ── COMMIT: now it is in the books ──────────────────────────────────────
    opening.commit(t.db, actor)

    assertBooksBalance()
    assertAverageCostIsHonest()

    // ON-HAND MATCHES THE SHEET.
    expect(stock.onHand(t.db, oil.id)).toBe(OPENING_QTY_M)
    expect(stock.onHand(t.db, products.getBySku(t.db, 'SUGAR').product.id)).toBe(12 * ONE_UNIT)

    // THE WEIGHTED AVERAGE COST IS THE COST FROM THE SHEET, to the fourth decimal.
    expect(stock.averageCost(t.db, oil.id)).toBe(UNIT_COST)

    // The general ledger and the stock report tell the same story.
    const valuation = stock
      .stockLevels(t.db, { pageSize: 200 })
      .rows.reduce((total, row) => total + row.stockValueMinor, 0)
    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(valuation)

    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(5_000_000)
    expect(ledger.accountBalance(t.db, ACC.BANK)).toBe(20_000_000)
    expect(ledger.accountBalance(t.db, ACC.RECEIVABLE)).toBe(1_240_000)
    expect(ledger.accountBalance(t.db, ACC.PAYABLE)).toBe(800_000)
  })

  it('uploading the SAME file twice does not double the stock', async () => {
    const buffer = await makeWorkbook({
      stock: [
        {
          'STOCK CODE': 'OIL-5L',
          'ITEM NAME': 'Cooking Oil 5L',
          PACKING: CARTON,
          'SUPPLIER PRICE': SUPPLIER_PRICE_TEXT,
          'BALANCE QUANTITY': 40
        }
      ],
      udhaar: [{ NAME: 'Muhammad Rashid', 'AMOUNT OWED': '12400.00' }],
      dues: [{ NAME: 'Metro', 'AMOUNT OWED': '8000.00' }],
      cash: { 'CASH IN HAND': '50000.00' }
    })

    const first = await excel.applyImport(t.db, actor, buffer)
    expect(first.productsCreated).toBe(1)

    // The owner spots a typo, re-saves, and uploads again. The draft is REPLACED, not added to.
    const second = await excel.applyImport(t.db, actor, buffer)
    expect(second.productsCreated).toBe(0) // matched by stock code the second time — not made twice

    // ONE item, ONE opening line, ONE customer, ONE supplier — not two of each.
    expect(t.db.prepare('SELECT COUNT(*) FROM products').pluck().get()).toBe(1)
    expect(t.db.prepare('SELECT COUNT(*) FROM opening_stock_lines').pluck().get()).toBe(1)
    expect(t.db.prepare('SELECT COUNT(*) FROM customers').pluck().get()).toBe(1)
    expect(t.db.prepare('SELECT COUNT(*) FROM suppliers').pluck().get()).toBe(1)

    opening.commit(t.db, actor)

    const oil = products.getBySku(t.db, 'OIL-5L').product
    expect(stock.onHand(t.db, oil.id)).toBe(OPENING_QTY_M) // 40, not 80
    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(5_000_000) // Rs 50,000, not Rs 100,000
    expect(ledger.accountBalance(t.db, ACC.RECEIVABLE)).toBe(1_240_000)
    assertBooksBalance()
  })

  it('an empty template imports harmlessly', async () => {
    existingProduct({ sku: 'SUGAR', name: 'Sugar 1kg', retailPrice: 15_000 })
    existingProduct({ sku: 'RICE-5KG', name: 'Rice 5kg', retailPrice: 120_000 })

    // Straight out of buildTemplate: two items listed, and not one number typed against them.
    const template = await buildTemplate(t.db)

    const preview = await excel.parseWorkbook(t.db, template)

    expect(preview.errors).toEqual([])
    expect(preview.stock.newProducts).toBe(0)
    expect(preview.stock.existingProducts).toBe(2)
    expect(preview.stock.openingLines).toBe(0)
    expect(preview.stock.totalValueMinor).toBe(0)
    expect(preview.cash).toBeUndefined()
    expect(preview.bank).toBeUndefined()

    const result = await excel.applyImport(t.db, actor, template)

    expect(result.productsCreated).toBe(0)
    expect(result.stockLines).toBe(0)
    expect(result.summary.stockValueMinor).toBe(0)

    // And the shop's prices are exactly where they were. A blank cell said nothing; it did not say zero.
    expect(products.getBySku(t.db, 'SUGAR').product.retailPrice).toBe(15_000)
    expect(products.getBySku(t.db, 'RICE-5KG').product.retailPrice).toBe(120_000)

    opening.commit(t.db, actor)
    assertBooksBalance()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// WHAT AN IMPORT MUST NEVER DO
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('what an import must never do', () => {
  it('does not wipe a price the sheet left blank (trap #18)', async () => {
    const id = existingProduct({ sku: 'SUGAR', name: 'Sugar 1kg', retailPrice: 15_000 })
    t.db.prepare('UPDATE products SET wholesale_price = 14000, name_other_lang = ? WHERE id = ?').run('چینی', id)

    // The owner fills in a quantity and nothing else — as the pre-filled template invites them to.
    const buffer = await makeWorkbook({
      stock: [{ 'STOCK CODE': 'SUGAR', 'BALANCE QUANTITY': 12, 'SUPPLIER PRICE': '100.0000' }]
    })

    await excel.applyImport(t.db, actor, buffer)

    const sugar = products.getBySku(t.db, 'SUGAR').product
    expect(sugar.retailPrice).toBe(15_000) // NOT zeroed
    expect(sugar.wholesalePrice).toBe(14_000) // NOT zeroed
    expect(sugar.nameOtherLang).toBe('چینی') // NOT wiped
    expect(sugar.name).toBe('Sugar 1kg') // the sheet's ITEM NAME is ignored for an existing item
  })

  it('never writes products.cost_price — the opening movement seeds it', async () => {
    const buffer = await makeWorkbook({
      stock: [
        {
          'STOCK CODE': 'OIL-5L',
          'ITEM NAME': 'Cooking Oil 5L',
          PACKING: CARTON,
          'SUPPLIER PRICE': SUPPLIER_PRICE_TEXT,
          'COST PRICE': '2185.0000', // the sheet's own COST PRICE column — ignored
          'UNIT COST': '91.0417', // ...and its UNIT COST — also ignored
          'BALANCE QUANTITY': 40
        }
      ]
    })

    await excel.applyImport(t.db, actor, buffer)

    const oil = products.getBySku(t.db, 'OIL-5L').product
    // Still zero. Cost is DERIVED from stock_movements, and no movement has been posted yet — the
    // draft is a worksheet, not the books.
    expect(oil.costPrice).toBe(0)

    opening.commit(t.db, actor)

    // NOW it has a cost, and it came from the movement, with a balanced journal behind it.
    expect(stock.averageCost(t.db, oil.id)).toBe(UNIT_COST)
    assertAverageCostIsHonest()
    assertBooksBalance()
  })

  it('writes NOTHING AT ALL when a later row is broken', async () => {
    const buffer = await makeWorkbook({
      stock: [
        { 'STOCK CODE': 'GOOD-1', 'ITEM NAME': 'Perfectly fine', DEPARTMENT: 'Grocery', 'BALANCE QUANTITY': 5, 'SUPPLIER PRICE': 100 },
        { 'STOCK CODE': 'GOOD-2', 'ITEM NAME': 'Also fine', 'BALANCE QUANTITY': 5, 'SUPPLIER PRICE': 100 },
        { 'STOCK CODE': 'BAD', 'ITEM NAME': 'Broken', 'RETAIL PRICE': 1.234 }
      ],
      udhaar: [{ NAME: 'Rashid', 'AMOUNT OWED': '12400.00' }]
    })

    await expectRefusal(() => excel.applyImport(t.db, actor, buffer), /row 4/i)

    // A HALF-IMPORTED SHOP IS WORSE THAN NO IMPORT — nobody could tell which half was real.
    assertNothingWritten()
    expect(t.db.prepare('SELECT COUNT(*) FROM customers').pluck().get()).toBe(0)
    expect(lookups.list(t.db, 'department').find((row) => row.label === 'Grocery')).toBeUndefined()
  })

  it('is REFUSED once the opening balances are committed', async () => {
    opening.commit(t.db, actor) // an empty but committed opening

    const buffer = await makeWorkbook({
      stock: [{ 'STOCK CODE': 'X', 'ITEM NAME': 'X', 'BALANCE QUANTITY': 5, 'SUPPLIER PRICE': 100 }]
    })

    await expectRefusal(() => excel.parseWorkbook(t.db, buffer), /already been saved to the books/i)
    await expectRefusal(() => excel.applyImport(t.db, actor, buffer), /already been saved to the books/i)
    assertNothingWritten()
  })

  it('is REFUSED once the shop has traded', async () => {
    const id = existingProduct({ sku: 'SUGAR', name: 'Sugar 1kg' })

    // A real sale movement: the shop is live, and the opening balances freeze behind it.
    t.db
      .prepare(
        `INSERT INTO stock_movements (at, type, product_id, qty_m, unit_cost, created_at)
         VALUES (?, 'sale', ?, -1000, 0, ?)`
      )
      .run(new Date().toISOString(), id, new Date().toISOString())

    const buffer = await makeWorkbook({
      stock: [{ 'STOCK CODE': 'SUGAR', 'BALANCE QUANTITY': 5, 'SUPPLIER PRICE': 100 }]
    })

    await expectRefusal(() => excel.applyImport(t.db, actor, buffer), /already made sales or purchases/i)
    expect(t.db.prepare('SELECT COUNT(*) FROM opening_stock_lines').pluck().get()).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE PARTY SHEETS
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('customer udhaar and supplier dues', () => {
  it('creates the people it does not know, and matches the ones it does', async () => {
    const buffer = await makeWorkbook({
      udhaar: [
        { NAME: 'Muhammad Rashid', PHONE: '0300-1234567', 'AMOUNT OWED': '12400.50', NOTE: 'Page 4' },
        { NAME: 'Ali Khan', 'AMOUNT OWED': 8000 }
      ],
      dues: [{ NAME: 'Metro Cash & Carry', 'AMOUNT OWED': '8000.00' }]
    })

    const preview = await excel.parseWorkbook(t.db, buffer)
    expect(preview.errors).toEqual([])
    expect(preview.udhaar.newCustomers).toBe(2)
    expect(preview.udhaar.totalMinor).toBe(1_240_050 + 800_000)

    await excel.applyImport(t.db, actor, buffer)

    const rashid = t.db
      .prepare('SELECT id, phone, credit_limit FROM customers WHERE name = ?')
      .get('Muhammad Rashid') as { id: number; phone: string; credit_limit: number }

    expect(rashid.phone).toBe('0300-1234567')
    // A credit limit is what they are ALLOWED to owe, not what they DO owe. The sheet says nothing
    // about it, so nothing is set.
    expect(rashid.credit_limit).toBe(0)

    const receivable = t.db
      .prepare('SELECT amount, note FROM opening_receivables WHERE customer_id = ?')
      .get(rashid.id) as { amount: number; note: string }

    expect(receivable.amount).toBe(1_240_050) // Rs 12,400.50 — exact
    expect(receivable.note).toBe('Page 4')

    // A second upload matches Rashid by name + phone rather than creating a twin.
    await excel.applyImport(t.db, actor, buffer)
    expect(t.db.prepare('SELECT COUNT(*) FROM customers').pluck().get()).toBe(2)

    opening.commit(t.db, actor)
    assertBooksBalance()
  })

  it('REFUSES the same person twice on one sheet — it would double what they owe', async () => {
    const buffer = await makeWorkbook({
      udhaar: [
        { NAME: 'Muhammad Rashid', 'AMOUNT OWED': '12400.00' },
        { NAME: 'muhammad rashid', 'AMOUNT OWED': '3000.00' }
      ]
    })

    const preview = await excel.parseWorkbook(t.db, buffer)
    expect(preview.errors).toHaveLength(1)
    expect(preview.errors[0]?.sheet).toBe(SHEET_UDHAAR)
    expect(preview.errors[0]?.row).toBe(3)
    expect(preview.errors[0]?.message).toMatch(/already on row 2/i)
  })

  it('REFUSES an amount of zero — it is not a debt', async () => {
    const buffer = await makeWorkbook({ udhaar: [{ NAME: 'Ali', 'AMOUNT OWED': 0 }] })

    const preview = await excel.parseWorkbook(t.db, buffer)
    expect(preview.errors[0]?.message).toMatch(/not a debt/i)
  })

  it('matches the one existing person of that name whose number nobody ever wrote down', async () => {
    const now = new Date().toISOString()
    t.db
      .prepare(
        `INSERT INTO customers (name, phone, credit_limit, is_active, created_at, updated_at)
         VALUES ('Ali Khan', NULL, 0, 1, ?, ?)`
      )
      .run(now, now)

    const buffer = await makeWorkbook({
      udhaar: [{ NAME: 'Ali Khan', PHONE: '0300-1234567', 'AMOUNT OWED': '5000.00' }]
    })

    const preview = await excel.parseWorkbook(t.db, buffer)
    expect(preview.errors).toEqual([])
    expect(preview.udhaar.newCustomers).toBe(0) // it is him — the shop just never had his number

    await excel.applyImport(t.db, actor, buffer)
    expect(t.db.prepare('SELECT COUNT(*) FROM customers').pluck().get()).toBe(1)
  })

  it('creates a separate person when the name matches but the phone number does not', async () => {
    const now = new Date().toISOString()
    t.db
      .prepare(
        `INSERT INTO customers (name, phone, credit_limit, is_active, created_at, updated_at)
         VALUES ('Ali Khan', '0300-9999999', 0, 1, ?, ?)`
      )
      .run(now, now)

    const buffer = await makeWorkbook({
      udhaar: [{ NAME: 'Ali Khan', PHONE: '0300-1234567', 'AMOUNT OWED': '5000.00' }]
    })

    const preview = await excel.parseWorkbook(t.db, buffer)
    expect(preview.udhaar.newCustomers).toBe(1) // a different Ali Khan, and his debt is his own

    await excel.applyImport(t.db, actor, buffer)
    expect(t.db.prepare('SELECT COUNT(*) FROM customers').pluck().get()).toBe(2)
  })

  it('asks for a phone number when two customers share a name', async () => {
    const now = new Date().toISOString()
    for (const phone of ['0300-1111111', '0300-2222222']) {
      t.db
        .prepare(
          `INSERT INTO customers (name, phone, credit_limit, is_active, created_at, updated_at)
           VALUES ('Muhammad Rashid', ?, 0, 1, ?, ?)`
        )
        .run(phone, now, now)
    }

    const buffer = await makeWorkbook({ udhaar: [{ NAME: 'Muhammad Rashid', 'AMOUNT OWED': '5000.00' }] })

    const preview = await excel.parseWorkbook(t.db, buffer)
    expect(preview.errors[0]?.message).toMatch(/more than one customer called/i)
    expect(preview.errors[0]?.message).toMatch(/phone number/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// BATCHES — only for the items that are set up for them
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('batch and expiry', () => {
  it('carries the batch and the expiry through to the batch record for a batch-tracked item', async () => {
    const id = existingProduct({ sku: 'MED-1', name: 'Panadol 500mg', trackBatches: true })

    const buffer = await makeWorkbook({
      stock: [
        {
          'STOCK CODE': 'MED-1',
          'SUPPLIER PRICE': '50.0000',
          'BALANCE QUANTITY': 100,
          'BATCH NO': 'B-2231',
          EXPIRY: '2027-03-01'
        }
      ]
    })

    const preview = await excel.parseWorkbook(t.db, buffer)
    expect(preview.errors).toEqual([])
    expect(preview.stock.rows[0]?.batchNo).toBe('B-2231')
    expect(preview.stock.rows[0]?.expiryDate).toBe('2027-03-01')

    await excel.applyImport(t.db, actor, buffer)
    opening.commit(t.db, actor)

    const batch = t.db
      .prepare('SELECT batch_no, expiry_date FROM batches WHERE product_id = ?')
      .get(id) as { batch_no: string; expiry_date: string }

    expect(batch.batch_no).toBe('B-2231')
    expect(batch.expiry_date).toBe('2027-03-01')

    const movement = t.db
      .prepare('SELECT batch_id FROM stock_movements WHERE product_id = ?')
      .get(id) as { batch_id: number | null }
    expect(movement.batch_id).not.toBeNull()

    assertBooksBalance()
  })

  it('reads a real Excel date cell, not just an ISO string', async () => {
    existingProduct({ sku: 'MED-1', name: 'Panadol 500mg', trackBatches: true })

    const workbook = new Workbook()
    const sheet = workbook.addWorksheet(SHEET_STOCK)
    sheet.addRow(['STOCK CODE', 'BALANCE QUANTITY', 'BATCH NO', 'EXPIRY', 'SUPPLIER PRICE'])
    const row = sheet.addRow([])
    row.getCell(1).value = 'MED-1'
    row.getCell(2).value = 100
    row.getCell(3).value = 'B-2231'
    row.getCell(4).value = new Date(Date.UTC(2027, 2, 1)) // a Date, as Excel's date picker gives it
    row.getCell(5).value = 50 // stock has to be worth something — see the zero-cost regression
    const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer

    const preview = await excel.parseWorkbook(t.db, buffer)

    expect(preview.errors).toEqual([])
    expect(preview.stock.rows[0]?.expiryDate).toBe('2027-03-01')
  })

  it('REFUSES a date it cannot read without guessing', async () => {
    existingProduct({ sku: 'MED-1', name: 'Panadol', trackBatches: true })

    // "1/3/2027" — 1 March, or 3 January? We do not guess at an expiry date.
    const buffer = await makeWorkbook({
      stock: [{ 'STOCK CODE': 'MED-1', 'BATCH NO': 'B-1', EXPIRY: '1/3/2027' }]
    })

    const preview = await excel.parseWorkbook(t.db, buffer)
    expect(preview.errors[0]?.column).toBe('EXPIRY')
    expect(preview.errors[0]?.message).toMatch(/2027-03-01/)
  })

  it('IGNORES a batch number on an item that is not set up for batch tracking', async () => {
    // Refusing the whole import over a batch number typed onto a tin of beans would help nobody. The
    // Instructions sheet says batches are only used for items set up for them.
    existingProduct({ sku: 'BEANS', name: 'Baked Beans', trackBatches: false })

    const buffer = await makeWorkbook({
      stock: [{ 'STOCK CODE': 'BEANS', 'BALANCE QUANTITY': 10, 'BATCH NO': 'B-1', EXPIRY: '2027-03-01', 'SUPPLIER PRICE': 100 }]
    })

    const preview = await excel.parseWorkbook(t.db, buffer)

    expect(preview.errors).toEqual([])
    expect(preview.stock.rows[0]?.batchNo).toBeNull()
    expect(preview.stock.rows[0]?.expiryDate).toBeNull()

    await excel.applyImport(t.db, actor, buffer)
    opening.commit(t.db, actor)

    expect(t.db.prepare('SELECT COUNT(*) FROM batches').pluck().get()).toBe(0)
    assertBooksBalance()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE HEADER ROW
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('matching the headers', () => {
  it('ignores case, spaces and underscores', async () => {
    const workbook = new Workbook()
    const sheet = workbook.addWorksheet(SHEET_STOCK)
    sheet.addRow(['stock_code', 'Item Name', 'balance quantity', 'SUPPLIER  PRICE'])
    sheet.addRow(['OIL-5L', 'Cooking Oil 5L', 40, '2185.0000'])
    const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer

    const preview = await excel.parseWorkbook(t.db, buffer)

    expect(preview.errors).toEqual([])
    expect(preview.stock.rows[0]?.sku).toBe('OIL-5L')
    expect(preview.stock.rows[0]?.qtyM).toBe(OPENING_QTY_M)
    expect(preview.stock.rows[0]?.packCost).toBe(SUPPLIER_PRICE_COST)
  })

  it('REFUSES a sheet with two columns that mean the same thing', async () => {
    const workbook = new Workbook()
    const sheet = workbook.addWorksheet(SHEET_STOCK)
    sheet.addRow(['STOCK CODE', 'ITEM NAME', 'RETAIL PRICE', 'SALE PRICE'])
    sheet.addRow(['X', 'X', 100, 200])
    const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer

    const preview = await excel.parseWorkbook(t.db, buffer)
    expect(preview.errors[0]?.message).toMatch(/two columns that both mean "RETAIL PRICE"/i)
  })

  it('says so plainly when there is no STOCK CODE column', async () => {
    const workbook = new Workbook()
    const sheet = workbook.addWorksheet(SHEET_STOCK)
    sheet.addRow(['ITEM NAME', 'BALANCE QUANTITY'])
    sheet.addRow(['Cooking Oil', 40])
    const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer

    const preview = await excel.parseWorkbook(t.db, buffer)
    expect(preview.errors).toHaveLength(1) // once — not once per row
    expect(preview.errors[0]?.message).toMatch(/no STOCK CODE column/i)
  })

  it('ignores blank rows and columns it does not know', async () => {
    const workbook = new Workbook()
    const sheet = workbook.addWorksheet(SHEET_STOCK)
    sheet.addRow(['STOCK CODE', 'ITEM NAME', 'SOME LEGACY COLUMN', 'BALANCE QUANTITY', 'SUPPLIER PRICE'])
    sheet.addRow(['OIL-5L', 'Cooking Oil 5L', 'who knows', 40, 100])
    sheet.addRow([])
    sheet.addRow(['SUGAR', 'Sugar 1kg', '', 12, 100])
    const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer

    const preview = await excel.parseWorkbook(t.db, buffer)

    expect(preview.errors).toEqual([])
    expect(preview.stock.rows).toHaveLength(2)
    expect(preview.stock.rows.map((row) => row.sku)).toEqual(['OIL-5L', 'SUGAR'])
  })
})
