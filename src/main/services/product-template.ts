import { Workbook, type Worksheet } from 'exceljs'
import type { DB } from '../db'
import type { ColumnSpec } from './excel-template'

/**
 * THE ANYTIME PRODUCT-IMPORT TEMPLATE — the spreadsheet a trading shop fills in to bulk add or reprice
 * its items, on any day.
 *
 * This file owns the COLUMN CONTRACT for product-import.ts, the same way excel-template.ts owns it for
 * the opening importer. One definition, two directions: the sheet we hand out and the sheet we read
 * back cannot drift apart over a renamed header.
 *
 * ── WHAT IS AND IS NOT A COLUMN HERE — and why it matters ───────────────────────────────────────
 *
 * The columns are a SUBSET of the opening template's STOCK_COLUMNS, and the two most important columns
 * of that template are DELIBERATELY ABSENT from this one:
 *
 *   BALANCE QUANTITY  — NOT here. A live shop changes stock through Stock → Adjust or a purchase, each
 *                       with a stock movement and a balanced journal. A bulk sheet writing stock would
 *                       revalue the shelf with no journal, and the GL and the stock report would drift
 *                       silently (CLAUDE.md §4). This importer never touches stock, so the sheet must
 *                       not even invite a quantity.
 *
 *   COST / SUPPLIER   — NOT here. cost_price is the weighted average of what the shop actually PAID,
 *   PRICE / DISCOUNT    derived from stock movements, never typed (CLAUDE.md §5). A cost belongs to a
 *                       purchase, which posts a movement and a journal. There is nowhere on this sheet
 *                       to type one, on purpose.
 *
 * What IS here is the catalogue: the code, the name, where it sits, and the two SELLING prices — the
 * only numbers a shopkeeper types by hand and that this importer is allowed to write.
 *
 * ── WHY THE NUMBER COLUMNS ARE FORMATTED AS TEXT ────────────────────────────────────────────────
 *
 * Same reason as the opening template: Excel turns 199.9900 into 199.99, a long barcode into 8.964E+12,
 * and "007" into 7. A TEXT ('@') column keeps what the owner typed; the importer reads every numeric
 * cell as text anyway and converts it with parseMoney — belt and braces.
 */

export const PRODUCT_SHEET = 'Items'
export const PRODUCT_INSTRUCTIONS = 'Instructions'

/** The stable name the importer knows a column by, whatever the header actually says. */
export type ProductKey =
  | 'sku'
  | 'name'
  | 'nameOtherLang'
  | 'department'
  | 'category'
  | 'subCategory'
  | 'brand'
  | 'location'
  | 'sizeVolume'
  | 'retailPrice'
  | 'wholesalePrice'
  | 'reorderLevel'
  | 'barcode'
  | 'itemType'

/**
 * SHEET 1 — the items. A subset of the opening template's STOCK_COLUMNS, in the same left-to-right
 * order, so a legacy export or a sheet exported from the opening flow still lines up. NO balance
 * quantity, NO cost/supplier-price/discount columns — see the header for why.
 */
export const PRODUCT_COLUMNS: ReadonlyArray<ColumnSpec<ProductKey>> = [
  { header: 'STOCK CODE', key: 'sku', width: 18, text: true },
  { header: 'ITEM NAME', key: 'name', width: 34 },
  { header: 'OTHER LANGUAGE NAME', key: 'nameOtherLang', width: 24 },
  { header: 'DEPARTMENT', key: 'department', width: 16 },
  { header: 'CATEGORY', key: 'category', width: 16 },
  { header: 'SUB CATEGORY', key: 'subCategory', width: 16 },
  { header: 'BRAND', key: 'brand', width: 16 },
  { header: 'LOCATION', key: 'location', width: 14 },
  { header: 'SIZE (VOLUME) - UOM', key: 'sizeVolume', width: 18 },
  { header: 'RETAIL PRICE', key: 'retailPrice', width: 13, text: true },
  { header: 'WHOLESALE PRICE', key: 'wholesalePrice', width: 16, text: true },
  { header: 'RE ORDER LEVEL', key: 'reorderLevel', width: 15, text: true },
  { header: 'BARCODE', key: 'barcode', width: 20, text: true },
  { header: 'ITEM TYPE', key: 'itemType', width: 15 }
]

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// BUILD
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Build the template, PRE-FILLED with every item the shop already has (stock code + name).
 *
 * The owner then types numbers against items that are already spelled the way the app spells them —
 * retyping names is how one item gets imported twice under two spellings.
 *
 * ONLY the stock code and the name are pre-filled. Not the prices: a pre-filled price the owner leaves
 * alone would be re-imported over itself, and a blank cell means "I am not telling you about this", so
 * the importer leaves that column alone. (CLAUDE.md trap #18.)
 */
export async function buildProductTemplate(db: DB, now = new Date()): Promise<Buffer> {
  const workbook = new Workbook()
  workbook.creator = 'Insha POS'
  workbook.created = now

  buildInstructions(workbook)
  buildItems(workbook, db)

  const buffer = await workbook.xlsx.writeBuffer()
  return buffer as unknown as Buffer
}

function buildItems(workbook: Workbook, db: DB): void {
  const sheet = workbook.addWorksheet(PRODUCT_SHEET)
  applyColumns(sheet, PRODUCT_COLUMNS)

  // .iterate(), not .all(): a shop with 100k items must not build 100k row objects in memory at once
  // just to write them straight back out. (CLAUDE.md §4 — assume 100k rows.)
  const rows = db
    .prepare('SELECT sku, name FROM products WHERE is_active = 1 ORDER BY name, sku')
    .iterate() as IterableIterator<{ sku: string; name: string }>

  const skuColumn = indexOf(PRODUCT_COLUMNS, 'sku')
  const nameColumn = indexOf(PRODUCT_COLUMNS, 'name')

  for (const product of rows) {
    const row = sheet.addRow([])
    // Written as strings into text-formatted cells: a stock code of "007" must come back as "007".
    row.getCell(skuColumn).value = product.sku
    row.getCell(nameColumn).value = product.name
  }
}

/** Headers, widths, the text format, and a frozen header row so it stays put on a long scroll. */
function applyColumns<K extends string>(
  sheet: Worksheet,
  columns: ReadonlyArray<ColumnSpec<K>>
): void {
  sheet.columns = columns.map((column) => ({
    header: column.header,
    key: column.key,
    width: column.width,
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
  if (index < 0) throw new Error(`no such column: ${key}`)
  return index + 1 // exceljs columns are 1-based
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE INSTRUCTIONS SHEET — written for a shopkeeper, not a programmer.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

type Line = { text: string; heading?: boolean }

const INSTRUCTIONS: Line[] = [
  { text: 'Add or update your items — how to fill this in', heading: true },
  { text: '' },
  {
    text: 'Use this sheet to add a lot of items at once, or to update the selling prices of items you already have. Fill it in, save it, and upload it back into the app.'
  },
  {
    text: 'The app will SHOW YOU exactly what it is about to do — how many items are new, how many prices will change, and how many will be left alone — and let you check it before anything is saved.'
  },
  { text: '' },
  { text: 'The Items sheet', heading: true },
  {
    text: 'Your existing items are already listed, with their stock code and name filled in. To add an item the app does not know yet, type it on a new row. A new item needs a STOCK CODE and an ITEM NAME. Everything else is optional.'
  },
  {
    text: 'The STOCK CODE is how the app recognises an item. If the code already exists, the app treats the row as that item. If it does not, the app creates a new one. (If the code is new but the BARCODE is one the app already knows, it uses the item that barcode belongs to.)'
  },
  { text: '' },
  { text: 'Prices', heading: true },
  { text: 'RETAIL PRICE and WHOLESALE PRICE are what YOU sell the item for.' },
  {
    text: 'Type prices plainly: 3999 or 3999.50. Do not type Rs, and do not type a % sign. A price can have up to 2 numbers after the dot. If a number will not fit, the app will TELL YOU the row and what is wrong — it will never round your money quietly.'
  },
  { text: '' },
  { text: 'Existing items — you choose what happens', heading: true },
  {
    text: 'When you upload, you pick one of two things for items that already exist: SKIP THEM (the safe choice — their prices are left exactly as they are), or ALSO UPDATE THEIR PRICES (the app changes an existing item’s price only when the price in your sheet is different).'
  },
  {
    text: 'Either way, this sheet NEVER changes an item’s stock and NEVER changes its cost. Stock changes through a stock adjustment or a purchase; cost is worked out from what you actually paid. This sheet is only for the catalogue and the selling prices.'
  },
  { text: '' },
  { text: 'A few things worth knowing', heading: true },
  {
    text: 'DEPARTMENT, CATEGORY, SUB CATEGORY, BRAND and LOCATION are created for you if they do not exist yet, but only for brand-new items. The review screen tells you how many were added.'
  },
  {
    text: 'ITEM TYPE is INVENTORY for anything you keep on a shelf, or NON INVENTORY for a service or a charge (a delivery fee, a bag).'
  },
  {
    text: 'Do not list the same stock code twice — the app will stop and ask you to fix it, rather than guess which row you meant.'
  },
  {
    text: 'Do not delete the heading row or rename the sheet. That row is how the app knows which column is which.'
  }
]

function buildInstructions(workbook: Workbook): void {
  const sheet = workbook.addWorksheet(PRODUCT_INSTRUCTIONS)
  sheet.getColumn(1).width = 118

  for (const line of INSTRUCTIONS) {
    const row = sheet.addRow([line.text])
    const cell = row.getCell(1)
    cell.alignment = { wrapText: true, vertical: 'top' }
    if (line.heading) cell.font = { bold: true, size: 12 }
  }
}
