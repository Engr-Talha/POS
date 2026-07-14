import { Workbook, type Worksheet } from 'exceljs'
import type { DB } from '../db'

/**
 * THE OPENING-BALANCE IMPORT TEMPLATE — the spreadsheet the shop owner fills in.
 *
 * This file owns the COLUMN CONTRACT. `excel-import.ts` reads it back and imports it against these
 * same constants, so the sheet we hand out and the sheet we can read cannot drift apart over a
 * renamed header. One definition, two directions.
 *
 * ── WHY THE COLUMNS ARE IN THIS ORDER, AND NOT A NICER ONE ──────────────────────────────────────
 *
 * They mirror the owner's legacy "Item Detail" screen, top to bottom. He exports from his old POS and
 * the columns have to LINE UP with no cutting and pasting — including the four we deliberately IGNORE
 * (COST PRICE, UNIT COST, PROFIT, NET PROFIT). Those four are DERIVED figures. We recompute them from
 * the supplier price, the discount and the pack size, because a derived number that was typed by hand
 * is a number that has already drifted from the thing it was supposedly derived from. They stay in the
 * sheet so his export lines up; they do not reach the database.
 *
 * ── WHY THE NUMBER COLUMNS ARE FORMATTED AS TEXT ────────────────────────────────────────────────
 *
 * Excel is helpful, and its help is the enemy here. Given half a chance it will:
 *
 *      turn 2185.0000     into  2185            (and the 4-dp cost discipline is gone)
 *      turn 8964000012345 into  8.964E+12       (and the barcode no longer scans)
 *      turn 007           into  7               (and the stock code no longer matches)
 *
 * A column formatted as TEXT ('@') keeps what the owner typed, exactly as they typed it. The importer
 * then reads EVERY numeric cell as text anyway and converts it with parseMoney / parseCost / parseQty
 * — belt and braces, because a legacy export will arrive with real numbers in it whatever we do here.
 *
 * EXPIRY is the one deliberate exception: it stays a normal (date-aware) column. "1/3/2027" as TEXT is
 * ambiguous — 1 March or 3 January? — while a real Excel date cell has already been resolved by the
 * owner's own locale, and we read the Date object back with no guessing. (See readCell in the importer.)
 */

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE SHEETS
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export const SHEET_STOCK = 'Stock'
export const SHEET_UDHAAR = 'Customer Udhaar'
export const SHEET_DUES = 'Supplier Dues'
export const SHEET_CASH = 'Cash and Bank'
export const SHEET_INSTRUCTIONS = 'Instructions'

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE COLUMN CONTRACT
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** The stable name the importer knows a column by, whatever the header actually says. */
export type StockKey =
  | 'sku'
  | 'name'
  | 'nameOtherLang'
  | 'department'
  | 'category'
  | 'subCategory'
  | 'brand'
  | 'location'
  | 'sizeVolume'
  | 'packing'
  | 'supplierPrice'
  | 'discount'
  | 'costPrice'
  | 'unitCost'
  | 'retailPrice'
  | 'wholesalePrice'
  | 'profit'
  | 'netProfit'
  | 'reorderLevel'
  | 'balanceQuantity'
  | 'barcode'
  | 'itemType'
  | 'batchNo'
  | 'expiry'

export type PartyKey = 'name' | 'phone' | 'amount' | 'note'
export type CashKey = 'cash' | 'bank'

export type ColumnSpec<K extends string> = {
  /** Written into row 1, and the first header the importer will recognise. */
  header: string
  key: K
  width: number
  /** Format the column as TEXT so Excel cannot 'helpfully' reformat what the owner types. */
  text?: boolean
  /** Read, echoed back, and thrown away — it is a DERIVED figure. Here so a legacy export lines up. */
  ignored?: boolean
}

/**
 * SHEET 1 — the inventory. The legacy "Item Detail" screen, left to right.
 *
 * BALANCE QUANTITY is the one that moves money: it becomes an opening stock movement with a real
 * journal behind it (DR Inventory / CR Opening Balance Equity), valued at the UNIT COST recomputed
 * from the same row. It is not a column on `products` and never will be — stock is derived.
 */
export const STOCK_COLUMNS: ReadonlyArray<ColumnSpec<StockKey>> = [
  { header: 'STOCK CODE', key: 'sku', width: 18, text: true },
  { header: 'ITEM NAME', key: 'name', width: 34 },
  { header: 'OTHER LANGUAGE NAME', key: 'nameOtherLang', width: 24 },
  { header: 'DEPARTMENT', key: 'department', width: 16 },
  { header: 'CATEGORY', key: 'category', width: 16 },
  { header: 'SUB CATEGORY', key: 'subCategory', width: 16 },
  { header: 'BRAND', key: 'brand', width: 16 },
  { header: 'LOCATION', key: 'location', width: 14 },
  { header: 'SIZE (VOLUME) - UOM', key: 'sizeVolume', width: 18 },
  { header: 'PACKING', key: 'packing', width: 10, text: true },
  { header: 'SUPPLIER PRICE', key: 'supplierPrice', width: 15, text: true },
  { header: 'DISCOUNT', key: 'discount', width: 10, text: true },
  { header: 'COST PRICE', key: 'costPrice', width: 13, text: true, ignored: true },
  { header: 'UNIT COST', key: 'unitCost', width: 12, text: true, ignored: true },
  { header: 'RETAIL PRICE', key: 'retailPrice', width: 13, text: true },
  { header: 'WHOLESALE PRICE', key: 'wholesalePrice', width: 16, text: true },
  { header: 'PROFIT', key: 'profit', width: 10, text: true, ignored: true },
  { header: 'NET PROFIT', key: 'netProfit', width: 12, text: true, ignored: true },
  { header: 'RE ORDER LEVEL', key: 'reorderLevel', width: 15, text: true },
  { header: 'BALANCE QUANTITY', key: 'balanceQuantity', width: 17, text: true },
  { header: 'BARCODE', key: 'barcode', width: 20, text: true },
  { header: 'ITEM TYPE', key: 'itemType', width: 15 },
  { header: 'BATCH NO', key: 'batchNo', width: 14, text: true },
  // NOT text — see the header note. A real date cell is unambiguous; "1/3/2027" as text is not.
  { header: 'EXPIRY', key: 'expiry', width: 13 }
]

/** SHEETS 2 and 3 — who owes the shop, and who the shop owes. Same four columns, both ways. */
export const PARTY_COLUMNS: ReadonlyArray<ColumnSpec<PartyKey>> = [
  { header: 'NAME', key: 'name', width: 30 },
  { header: 'PHONE', key: 'phone', width: 18, text: true },
  { header: 'AMOUNT OWED', key: 'amount', width: 14, text: true },
  { header: 'NOTE', key: 'note', width: 40 }
]

/** SHEET 4 — one row, two figures. */
export const CASH_COLUMNS: ReadonlyArray<ColumnSpec<CashKey>> = [
  { header: 'CASH IN HAND', key: 'cash', width: 18, text: true },
  { header: 'BANK BALANCE', key: 'bank', width: 18, text: true }
]

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// BUILD
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Build the template, PRE-FILLED with every item the shop already has (stock code + name).
 *
 * The owner then only types the numbers — quantities and costs — against items that are already
 * spelled the way the app spells them. Retyping 340 item names into a spreadsheet is how 340 items get
 * imported twice under two spellings.
 *
 * ONLY the stock code and the name are pre-filled. Not the prices. A pre-filled price the owner leaves
 * alone would be re-imported over itself, and a pre-filled price they clear would look like an
 * instruction to set the price to nothing. A blank cell means "I am not telling you about this", and
 * the importer leaves the column alone. (CLAUDE.md trap #18.)
 */
export async function buildTemplate(db: DB, now = new Date()): Promise<Buffer> {
  const workbook = new Workbook()
  workbook.creator = 'Insha POS'
  workbook.created = now

  buildInstructions(workbook)
  buildStock(workbook, db)
  buildParty(workbook, SHEET_UDHAAR)
  buildParty(workbook, SHEET_DUES)
  buildCash(workbook)

  const buffer = await workbook.xlsx.writeBuffer()
  return buffer as unknown as Buffer
}

function buildStock(workbook: Workbook, db: DB): void {
  const sheet = workbook.addWorksheet(SHEET_STOCK)
  applyColumns(sheet, STOCK_COLUMNS)

  // .iterate(), not .all(): a shop with 100k items must not have 100k row objects built in memory at
  // once just to write them straight back out again. (CLAUDE.md §4 — assume 100k rows.)
  const rows = db
    .prepare('SELECT sku, name FROM products WHERE is_active = 1 ORDER BY name, sku')
    .iterate() as IterableIterator<{ sku: string; name: string }>

  const skuColumn = indexOf(STOCK_COLUMNS, 'sku')
  const nameColumn = indexOf(STOCK_COLUMNS, 'name')

  for (const product of rows) {
    const row = sheet.addRow([])
    // Written as strings into text-formatted cells: a stock code of "007" must come back as "007".
    row.getCell(skuColumn).value = product.sku
    row.getCell(nameColumn).value = product.name
  }
}

function buildParty(workbook: Workbook, name: string): void {
  applyColumns(workbook.addWorksheet(name), PARTY_COLUMNS)
}

function buildCash(workbook: Workbook): void {
  const sheet = workbook.addWorksheet(SHEET_CASH)
  applyColumns(sheet, CASH_COLUMNS)
  // Row 2 is left EMPTY on purpose. A blank figure means "do not change what is already there" — see
  // the Instructions sheet, which says so in words the owner will actually read.
  sheet.addRow([])
}

/** Headers, widths, the text format, and a frozen header row so it stays put on a 5,000-row scroll. */
function applyColumns<K extends string>(
  sheet: Worksheet,
  columns: ReadonlyArray<ColumnSpec<K>>
): void {
  sheet.columns = columns.map((column) => ({
    header: column.header,
    key: column.key,
    width: column.width,
    // '@' is Excel's TEXT format. It applies to cells the OWNER types too, not just the ones we write
    // — which is the whole point: it stops Excel reformatting 2185.0000 the moment they press Enter.
    style: column.text ? { numFmt: '@' } : {}
  }))

  const header = sheet.getRow(1)
  header.font = { bold: true }
  header.alignment = { vertical: 'middle' }
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDF2F7' } }
  header.height = 20
  header.commit()

  sheet.views = [{ state: 'frozen', ySplit: 1 }]
}

function indexOf<K extends string>(columns: ReadonlyArray<ColumnSpec<K>>, key: K): number {
  const index = columns.findIndex((column) => column.key === key)
  // A programming error, not a user error: the key is a compile-time union.
  if (index < 0) throw new Error(`no such column: ${key}`)
  return index + 1 // exceljs columns are 1-based
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE INSTRUCTIONS SHEET
//
// Written for a shopkeeper, not a programmer. No jargon, no "schema", no "validation". It is the FIRST
// sheet in the book, because the one thing we know about a person opening this file is that they have
// not been told what to do with it.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

type Line = { text: string; heading?: boolean }

const INSTRUCTIONS: Line[] = [
  { text: 'Setting up your shop — how to fill this in', heading: true },
  { text: '' },
  {
    text: 'This file tells the app what your shop ALREADY HAS on the day you start using it: the stock on your shelves, the cash in your till, the money customers owe you, and the money you owe your suppliers.'
  },
  {
    text: 'Fill in what you know, save the file, and upload it back into the app. The app will SHOW YOU what it is about to do and let you check it before anything is saved. Nothing is written to your books until you press Save on that review screen.'
  },
  { text: '' },
  { text: 'The four sheets', heading: true },
  { text: 'Stock — your items. Every item you already have on the shelf.' },
  { text: 'Customer Udhaar — customers who owe YOU money.' },
  { text: 'Supplier Dues — suppliers YOU owe money to.' },
  { text: 'Cash and Bank — the cash in your till and the money in your bank.' },
  { text: '' },
  { text: 'The Stock sheet', heading: true },
  {
    text: 'Your existing items are already listed, with their stock code and name filled in. Just type the numbers next to them.'
  },
  {
    text: 'To add an item the app does not know yet, type it on a new row. A new item needs a STOCK CODE and an ITEM NAME. Everything else is optional.'
  },
  { text: '' },
  {
    text: 'BALANCE QUANTITY is the important one. It is how many you have RIGHT NOW. Leave it blank for an item you have none of — the item will still be added, it will just start with no stock.'
  },
  {
    text: 'SUPPLIER PRICE is what you PAY for it. PACKING is how many pieces come in the pack you buy (a carton of 24 is 24). Leave PACKING blank if you buy it one at a time.'
  },
  {
    text: 'DISCOUNT is the discount your supplier gives you, as a plain number: type 5 for 5%.'
  },
  {
    text: 'RETAIL PRICE and WHOLESALE PRICE are what YOU sell it for.'
  },
  {
    text: 'COST PRICE, UNIT COST, PROFIT and NET PROFIT are worked out for you. You can leave them blank — anything you type there is ignored.'
  },
  { text: '' },
  { text: 'Typing numbers', heading: true },
  { text: 'Type prices plainly: 3999 or 3999.50. Do not type Rs, and do not type a % sign.' },
  {
    text: 'Prices can have up to 2 numbers after the dot (3999.50). Supplier prices can have up to 4 (91.0417). Quantities can have up to 3 (1.5 kg is 1.5).'
  },
  {
    text: 'If a number will not fit those rules, the app will TELL YOU the row and what is wrong with it. It will never round your money quietly.'
  },
  { text: 'EXPIRY dates: type them as 2027-03-01 — year, then month, then day.' },
  { text: '' },
  { text: 'A few things worth knowing', heading: true },
  {
    text: 'The STOCK CODE is how the app recognises an item. If the code already exists, the app updates that item. If it does not, the app creates a new one.'
  },
  {
    text: 'Do not list the same stock code twice — the app will stop and ask you to fix it, rather than guess which row you meant.'
  },
  {
    text: 'DEPARTMENT, CATEGORY, SUB CATEGORY, BRAND and LOCATION are created for you if they do not exist yet. The review screen tells you how many were added.'
  },
  {
    text: 'ITEM TYPE is INVENTORY for anything you keep on a shelf, or NON INVENTORY for a service or a charge (a delivery fee, a bag). A NON INVENTORY item cannot have a balance quantity — there is nothing on a shelf to count.'
  },
  {
    text: 'BATCH NO and EXPIRY are only used for items you have already set up for batch tracking. For everything else, leave them blank.'
  },
  {
    text: 'If you upload the file a second time, it REPLACES what you uploaded before. It does not add to it, so your stock will not be doubled.'
  },
  {
    text: 'On the Cash and Bank sheet, a blank box means "do not change this". Type 0 if you truly have none.'
  },
  { text: '' },
  {
    text: 'Do not delete the heading row or rename the sheets. That row is how the app knows which column is which.'
  }
]

function buildInstructions(workbook: Workbook): void {
  const sheet = workbook.addWorksheet(SHEET_INSTRUCTIONS)
  sheet.getColumn(1).width = 118

  for (const line of INSTRUCTIONS) {
    const row = sheet.addRow([line.text])
    const cell = row.getCell(1)
    cell.alignment = { wrapText: true, vertical: 'top' }
    if (line.heading) cell.font = { bold: true, size: 12 }
  }
}
