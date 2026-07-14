import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Workbook } from 'exceljs'
import { makeTestDb, type TestDb } from '../db/testkit'
import * as excel from './excel-import'
import { buildTemplate } from './excel-template'
import * as opening from './opening'
import * as auth from './auth'
import type { User } from '@shared/types'

/**
 * REGRESSIONS from the Excel-import adversarial audit. Every one was REAL, and reproduced before it
 * was fixed. Three of them were CRITICAL: each would have silently corrupted the shop's opening books
 * while every journal balanced and the trial balance stayed green.
 */

let t: TestDb
let owner: User

beforeEach(() => {
  t = makeTestDb({ withSeed: true })
  owner = auth.createFirstOwner(t.db, { username: 'boss', fullName: 'Boss', password: 'password1' })
})
afterEach(() => t.cleanup())

async function sheetOf(): Promise<{ wb: Workbook; sheet: import('exceljs').Worksheet; col: (n: string) => number }> {
  const tpl = await buildTemplate(t.db)
  const wb = new Workbook()
  await wb.xlsx.load(tpl as never)
  const sheet = wb.getWorksheet('Stock')!
  const headers = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? '').trim())
  return { wb, sheet, col: (n: string) => headers.indexOf(n) }
}

async function preview(wb: Workbook) {
  return excel.parseWorkbook(t.db, Buffer.from(await wb.xlsx.writeBuffer()))
}

describe('CRITICAL: a FORMULA cell walked around every guard', () => {
  /**
   * exceljs hands a formula back as an OBJECT — { formula, result } — not a number. So
   * `typeof value === 'number'` was false for every formula, and every guard that relied on knowing
   * "this came in as a number" was disarmed for exactly the cells a shopkeeper is most likely to
   * produce: the ones he drag-filled down a column.
   */
  it('a drag-filled percent DISCOUNT formula is REFUSED, not read as 0.05%', async () => {
    const { wb, sheet, col } = await sheetOf()
    const row = sheet.getRow(sheet.rowCount + 1)
    row.getCell(col('STOCK CODE')).value = 'F1'
    row.getCell(col('ITEM NAME')).value = 'Formula Item'
    row.getCell(col('SUPPLIER PRICE')).value = 2185
    row.getCell(col('RETAIL PRICE')).value = 3999
    row.getCell(col('BALANCE QUANTITY')).value = 40

    // Excel shows "5.00%". The cell holds 0.05, wrapped in a formula.
    const d = row.getCell(col('DISCOUNT'))
    d.value = { formula: 'B2*0.05', result: 0.05 } as never
    d.numFmt = '0.00%'
    row.commit()

    const p = await preview(wb)

    // Before the fix: 0 errors, and the cost came out Rs 2183.9075 (a 0.05% discount) instead of
    // Rs 2075.75 (5%). Every item ~5% too dear, the whole opening inventory overstated, and that
    // inflated cost seeded the weighted average every future sale would be costed against.
    expect(p.errors.length).toBeGreaterThan(0)
    expect(p.errors.some((e) => /percentage/i.test(e.message))).toBe(true)
  })
})

describe('CRITICAL: stock with no cost was valued at ZERO', () => {
  it('a quantity with a blank SUPPLIER PRICE is REFUSED', async () => {
    const { wb, sheet, col } = await sheetOf()
    const row = sheet.getRow(sheet.rowCount + 1)
    row.getCell(col('STOCK CODE')).value = 'NOCOST'
    row.getCell(col('ITEM NAME')).value = 'Free Stock?'
    row.getCell(col('RETAIL PRICE')).value = 500
    row.getCell(col('BALANCE QUANTITY')).value = 25 // ...and no supplier price at all
    row.commit()

    const p = await preview(wb)

    // Before: it imported at Rs 0. The opening booked Rs 0 of inventory, the weighted average was
    // seeded at Rs 0, and every later sale of it posted COGS of ZERO — a 100% profit margin,
    // forever. The GL and the stock report agreed (both nothing), so nothing ever noticed.
    expect(p.errors.some((e) => /supplier price|100% profit/i.test(e.message))).toBe(true)
  })
})

describe('CRITICAL: importing stock deleted hand-entered udhaar', () => {
  it('a stock-only workbook leaves the owner’s typed-in udhaar alone', async () => {
    // The owner types twenty customers into the wizard...
    const customerId = Number(
      t.db
        .prepare("INSERT INTO customers (name, is_active, created_at, updated_at) VALUES ('Ali', 1, 'x', 'x')")
        .run().lastInsertRowid
    )
    opening.addReceivable(t.db, owner, { customerId, amount: 625_000 })
    expect(opening.listReceivables(t.db).total).toBe(1)

    // ...then uploads a spreadsheet of STOCK. It says nothing at all about udhaar.
    const { wb, sheet, col } = await sheetOf()
    const row = sheet.getRow(sheet.rowCount + 1)
    row.getCell(col('STOCK CODE')).value = 'S1'
    row.getCell(col('ITEM NAME')).value = 'Item'
    row.getCell(col('SUPPLIER PRICE')).value = 100
    row.getCell(col('RETAIL PRICE')).value = 150
    row.getCell(col('BALANCE QUANTITY')).value = 5
    row.commit()

    await excel.applyImport(t.db, owner, Buffer.from(await wb.xlsx.writeBuffer()))

    // A file that says nothing about udhaar is not an instruction to DELETE the udhaar.
    expect(opening.listReceivables(t.db).total).toBe(1)
    expect(opening.listStockLines(t.db).total).toBe(1)
  })
})

describe('HIGH: a stock code was matched case-sensitively', () => {
  it('"abc" in the sheet finds the existing "ABC" instead of creating a twin', async () => {
    const uomId = t.db.prepare("SELECT id FROM lookups WHERE list_key='uom' AND code='pcs'").pluck().get() as number
    t.db
      .prepare(
        `INSERT INTO products (sku, name, sale_uom_id, item_type, price_entry_mode, is_active, created_at, updated_at)
         VALUES ('ABC', 'Existing Item', ?, 'inventory', 'exclusive', 1, 'x', 'x')`
      )
      .run(uomId)

    const { wb, sheet, col } = await sheetOf()
    const row = sheet.getRow(sheet.rowCount + 1)
    row.getCell(col('STOCK CODE')).value = 'abc' // the same stock code, typed in lower case
    row.getCell(col('SUPPLIER PRICE')).value = 100
    row.getCell(col('RETAIL PRICE')).value = 150
    row.getCell(col('BALANCE QUANTITY')).value = 5
    row.commit()

    const p = await preview(wb)

    // Before: a SECOND product was created, and the opening stock landed on the empty duplicate while
    // the real item stayed at zero. A stock code is an identifier — "abc" and "ABC" are the same item.
    expect(p.stock.rows[0]?.isNew).toBe(false)
    expect(t.db.prepare('SELECT COUNT(*) FROM products').pluck().get()).toBe(1)
  })
})

describe('HIGH: an expiry with no batch number died at Import, not at Preview', () => {
  it('is caught in the PREVIEW, with its row number, while the sheet is still open', async () => {
    const { wb, sheet, col } = await sheetOf()
    const row = sheet.getRow(sheet.rowCount + 1)
    row.getCell(col('STOCK CODE')).value = 'E1'
    row.getCell(col('ITEM NAME')).value = 'Medicine'
    row.getCell(col('SUPPLIER PRICE')).value = 100
    row.getCell(col('RETAIL PRICE')).value = 150
    row.getCell(col('BALANCE QUANTITY')).value = 5
    row.getCell(col('EXPIRY')).value = new Date('2027-01-01') // ...but no BATCH NO
    row.commit()

    const p = await preview(wb)
    expect(p.errors.some((e) => /batch number/i.test(e.message))).toBe(true)
    expect(p.errors[0]?.row).toBeGreaterThan(1) // it names the row he has to go and fix
  })
})
