import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Workbook, type Worksheet, type Xlsx } from 'exceljs'
import { makeTestDb, type TestDb } from '../db/testkit'
import type { User } from '@shared/types'
import * as products from './products'
import {
  buildTemplate,
  CASH_COLUMNS,
  PARTY_COLUMNS,
  SHEET_CASH,
  SHEET_DUES,
  SHEET_INSTRUCTIONS,
  SHEET_STOCK,
  SHEET_UDHAAR,
  STOCK_COLUMNS
} from './excel-template'

/**
 * THE TEMPLATE the shop owner fills in.
 *
 * Two things it has to get right, and both of them are about Excel being helpful when nobody asked:
 *
 *   1. THE COLUMNS MIRROR HIS LEGACY "Item Detail" SCREEN, in that order, including the four we ignore.
 *      He exports from his old POS and pastes; if the columns do not line up he has to re-arrange 900
 *      rows by hand, and he will not — he will type it in instead, and mistype it.
 *
 *   2. THE NUMBER COLUMNS ARE FORMATTED AS TEXT. Given half a chance Excel turns 2185.0000 into 2185,
 *      8964000012345 into 8.964E+12, and a stock code of 007 into 7. A text column keeps what he typed.
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

function addProduct(sku: string, name: string): number {
  const uomId = t.db
    .prepare("SELECT id FROM lookups WHERE list_key = 'uom' AND code = 'pcs'")
    .pluck()
    .get() as number

  return products.create(t.db, actor, { sku, name, saleUomId: uomId }, new Date()).product.id
}

async function open(buffer: Buffer): Promise<Workbook> {
  const workbook = new Workbook()
  await workbook.xlsx.load(buffer as unknown as Parameters<Xlsx['load']>[0])
  return workbook
}

function headerRow(sheet: Worksheet): string[] {
  const headers: string[] = []
  sheet.getRow(1).eachCell((cell, column) => {
    headers[column - 1] = String(cell.value ?? '').trim()
  })
  return headers
}

describe('buildTemplate', () => {
  it('has the five sheets, in a book that opens on the instructions', async () => {
    const workbook = await open(await buildTemplate(t.db))

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      SHEET_INSTRUCTIONS,
      SHEET_STOCK,
      SHEET_UDHAAR,
      SHEET_DUES,
      SHEET_CASH
    ])
  })

  it('lays the Stock columns out exactly as the legacy Item Detail screen does', async () => {
    const workbook = await open(await buildTemplate(t.db))
    const sheet = workbook.getWorksheet(SHEET_STOCK) as Worksheet

    // The owner pastes his export straight in. This order IS the contract.
    expect(headerRow(sheet)).toEqual([
      'STOCK CODE',
      'ITEM NAME',
      'OTHER LANGUAGE NAME',
      'DEPARTMENT',
      'CATEGORY',
      'SUB CATEGORY',
      'BRAND',
      'LOCATION',
      'SIZE (VOLUME) - UOM',
      'PACKING',
      'SUPPLIER PRICE',
      'DISCOUNT',
      'COST PRICE',
      'UNIT COST',
      'RETAIL PRICE',
      'WHOLESALE PRICE',
      'PROFIT',
      'NET PROFIT',
      'RE ORDER LEVEL',
      'BALANCE QUANTITY',
      'BARCODE',
      'ITEM TYPE',
      'BATCH NO',
      'EXPIRY'
    ])
  })

  it('gives the udhaar, dues and cash sheets their headers', async () => {
    const workbook = await open(await buildTemplate(t.db))

    expect(headerRow(workbook.getWorksheet(SHEET_UDHAAR) as Worksheet)).toEqual([
      'NAME',
      'PHONE',
      'AMOUNT OWED',
      'NOTE'
    ])
    expect(headerRow(workbook.getWorksheet(SHEET_DUES) as Worksheet)).toEqual([
      'NAME',
      'PHONE',
      'AMOUNT OWED',
      'NOTE'
    ])
    expect(headerRow(workbook.getWorksheet(SHEET_CASH) as Worksheet)).toEqual([
      'CASH IN HAND',
      'BANK BALANCE'
    ])
  })

  it('PRE-FILLS the shop’s existing items — stock code and name, and nothing else', async () => {
    addProduct('SUGAR', 'Sugar 1kg')
    addProduct('OIL-5L', 'Cooking Oil 5L')
    addProduct('RICE-5KG', 'Rice 5kg')

    const workbook = await open(await buildTemplate(t.db))
    const sheet = workbook.getWorksheet(SHEET_STOCK) as Worksheet
    const headers = headerRow(sheet)

    const rows: Array<Record<string, string>> = []
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return
      const cells: Record<string, string> = {}
      headers.forEach((header, index) => {
        cells[header] = String(row.getCell(index + 1).value ?? '')
      })
      rows.push(cells)
    })

    // Ordered by name, so the owner can find things. Only the two columns they must not retype.
    expect(rows.map((row) => row['STOCK CODE'])).toEqual(['OIL-5L', 'RICE-5KG', 'SUGAR'])
    expect(rows.map((row) => row['ITEM NAME'])).toEqual(['Cooking Oil 5L', 'Rice 5kg', 'Sugar 1kg'])

    // EVERY OTHER CELL IS BLANK — and that is the point. A pre-filled price the owner leaves alone
    // would be re-imported over itself; one they clear would look like an instruction to zero it.
    // A blank cell says "I am not telling you about this", and the importer leaves the column alone.
    for (const row of rows) {
      for (const header of headers) {
        if (header === 'STOCK CODE' || header === 'ITEM NAME') continue
        expect(row[header], `${header} should be blank`).toBe('')
      }
    }
  })

  it('leaves a retired item out — it is not on the shelf to be counted', async () => {
    const id = addProduct('OLD', 'Discontinued thing')
    addProduct('SUGAR', 'Sugar 1kg')
    products.deactivate(t.db, actor, id)

    const workbook = await open(await buildTemplate(t.db))
    const sheet = workbook.getWorksheet(SHEET_STOCK) as Worksheet

    const skus: string[] = []
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return
      skus.push(String(row.getCell(1).value ?? ''))
    })

    expect(skus).toEqual(['SUGAR'])
  })

  it('formats the money, cost, quantity and barcode columns as TEXT', async () => {
    const workbook = await open(await buildTemplate(t.db))
    const sheet = workbook.getWorksheet(SHEET_STOCK) as Worksheet
    const headers = headerRow(sheet)

    // '@' is Excel's text format. Without it, 2185.0000 becomes 2185 the moment they press Enter, and
    // a 13-digit barcode becomes 8.964E+12 — unscannable, and unrecoverable.
    for (const column of STOCK_COLUMNS.filter((candidate) => candidate.text)) {
      const index = headers.indexOf(column.header) + 1
      expect(sheet.getColumn(index).numFmt, `${column.header} must be text-formatted`).toBe('@')
    }

    // EXPIRY is deliberately NOT text: a real date cell is unambiguous, while "1/3/2027" as text is
    // not — is it 1 March or 3 January?
    expect(STOCK_COLUMNS.find((column) => column.key === 'expiry')?.text).toBeUndefined()

    for (const column of [...PARTY_COLUMNS, ...CASH_COLUMNS].filter((candidate) => candidate.text)) {
      const partySheet = workbook.getWorksheet(SHEET_UDHAAR) as Worksheet
      const cashSheet = workbook.getWorksheet(SHEET_CASH) as Worksheet
      const target = CASH_COLUMNS.some((candidate) => candidate.key === column.key) ? cashSheet : partySheet
      const index = headerRow(target).indexOf(column.header) + 1
      if (index > 0) expect(target.getColumn(index).numFmt).toBe('@')
    }
  })

  it('keeps a stock code of 007 as 007', async () => {
    addProduct('007', 'James Bond Cola')

    const workbook = await open(await buildTemplate(t.db))
    const sheet = workbook.getWorksheet(SHEET_STOCK) as Worksheet

    // A General-formatted cell would have handed this back as the number 7, and the stock code would
    // never match again.
    expect(sheet.getCell('A2').value).toBe('007')
    expect(typeof sheet.getCell('A2').value).toBe('string')
  })

  it('freezes the header row and sizes the columns', async () => {
    const workbook = await open(await buildTemplate(t.db))
    const sheet = workbook.getWorksheet(SHEET_STOCK) as Worksheet

    // 900 rows in, the owner still has to know which column he is typing into.
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 })
    expect(sheet.getRow(1).font?.bold).toBe(true)

    for (let index = 1; index <= STOCK_COLUMNS.length; index += 1) {
      expect(sheet.getColumn(index).width).toBeGreaterThan(0)
    }
  })

  it('carries instructions written for a shopkeeper, not a programmer', async () => {
    const workbook = await open(await buildTemplate(t.db))
    const sheet = workbook.getWorksheet(SHEET_INSTRUCTIONS) as Worksheet

    const text: string[] = []
    sheet.eachRow((row) => text.push(String(row.getCell(1).value ?? '')))
    const all = text.join('\n')

    expect(all).toMatch(/BALANCE QUANTITY/)
    expect(all).toMatch(/type 5 for 5%/i)
    expect(all).toMatch(/2027-03-01/) // how to type a date, unambiguously
    expect(all).toMatch(/replaces what you uploaded before/i) // re-upload does not double the stock
    expect(all).toMatch(/blank box means "do not change this"/i)

    // No jargon, and no emojis — CLAUDE.md is explicit about both.
    expect(all).not.toMatch(/schema|validation|zod|SKU|null|integer|parse/i)
    expect(all).not.toMatch(/\p{Extended_Pictographic}/u)
  })

  it('builds for a brand-new shop with no items at all', async () => {
    const workbook = await open(await buildTemplate(t.db))
    const sheet = workbook.getWorksheet(SHEET_STOCK) as Worksheet

    expect(headerRow(sheet)).toHaveLength(STOCK_COLUMNS.length)
    expect(sheet.actualRowCount).toBe(1) // the header, and nothing under it
  })
})
