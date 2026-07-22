import { Workbook, type Row, type Worksheet, type Xlsx } from 'exceljs'
import type { DB } from '../db'
import type { User } from '@shared/types'
import { AppError, ErrorCode } from '@shared/result'
import type { ItemType, PriceEntryMode } from '@shared/catalog'
import type { OpeningSummary } from '@shared/opening'
import { parseMoney } from '@shared/money'
import { parseCost, costToPriceMinor } from '@shared/cost'
import { parseQty, ONE_UNIT } from '@shared/qty'
import * as audit from './audit'
import * as catalog from './catalog'
import * as settings from './settings'
import { REGISTRY_DEFAULTS } from '@shared/settings-registry'
import * as customers from './customers'
import * as suppliers from './suppliers'
import * as lookups from './lookups'
import * as opening from './opening'
import * as products from './products'
import * as stock from './stock'
import {
  CASH_COLUMNS,
  PARTY_COLUMNS,
  SHEET_CASH,
  SHEET_DUES,
  SHEET_STOCK,
  SHEET_UDHAAR,
  STOCK_COLUMNS,
  type CashKey,
  type ColumnSpec,
  type PartyKey,
  type StockKey
} from './excel-template'

/**
 * THE OPENING-BALANCE IMPORTER — a shop's whole life, migrated in one upload.
 *
 * The owner exports his old POS's "Item Detail" screen to Excel, fills in what he has, and uploads it.
 * Out of it come his catalogue, his opening stock, his customers' udhaar, his suppliers' dues, and the
 * cash in his till — as a DRAFT he then reviews and commits himself. This never commits for him.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE: EXCEL HANDS YOU FLOATS.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A cell showing 2185.0000 is a JS DOUBLE by the time it reaches us. The entire app rests on the
 * discipline that money, cost and quantity are INTEGERS — 2 dp, 4 dp and 3 dp, on three different
 * scales — and one float admitted here quietly undoes all of it, in the books, silently, forever.
 *
 * So EVERY numeric cell is read as TEXT (`readCell` -> `String(number)`, which gives the shortest
 * string that round-trips the double) and converted with parseMoney / parseCost / parseQty. If a cell
 * will not convert EXACTLY, THE ROW IS REJECTED, by number, in plain language.
 *
 * We NEVER round it and hope. A retail price of 3999.123 is not 3999.12 — it is a typo, and the owner
 * is the only person who can say which. There is no parseFloat and no Number() anywhere in this file,
 * and there must never be one.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THE SHEET DOES *NOT* GET TO DECIDE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * COST PRICE, UNIT COST, PROFIT and NET PROFIT are columns on the legacy screen, and the sheet carries
 * them so his export lines up with no re-arranging. They are READ AND THROWN AWAY. They are DERIVED,
 * and we recompute them from the two numbers that are not:
 *
 *      COST PRICE  =  SUPPLIER PRICE less DISCOUNT      products.costFromSupplier()
 *      UNIT COST   =  COST PRICE / PACKING              products.unitCostFromPack()
 *
 * and nothing here ever writes `products.cost_price`. Cost is the weighted average of what the shop
 * actually PAID — derived from stock_movements, exactly like stock on hand. The opening stock movement
 * seeds it at commit, through stock.adjust(), with a balanced journal behind it. An importer that typed
 * a cost straight into the column would revalue the shelf with no movement and no journal to explain
 * it, the GL and the stock report would disagree, and the trial balance would still balance — so
 * nothing anywhere would catch it. (CLAUDE.md §4, and the note on products.ts's UPDATABLE map.)
 *
 * BALANCE QUANTITY is not a column on `products` either, and never will be. It becomes an OPENING STOCK
 * MOVEMENT, valued at the unit cost recomputed above, with a real journal behind it — which is what
 * makes the figure defensible instead of a number that simply appeared.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * PARSE, THEN APPLY — and the transaction in between
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 *   parseWorkbook()   WRITES NOTHING. It returns what WOULD happen, and every problem it found, all
 *                     of them, in one pass — so the owner fixes the whole file once instead of
 *                     discovering the next broken row on the next upload.
 *
 *   applyImport()     re-parses, REFUSES if there is a single error, and then does the lot in ONE
 *                     transaction. A half-imported shop — some items in, some not, stock that does not
 *                     match the ledger — is worse than no import at all, because nobody can tell which
 *                     half is real.
 *
 * exceljs is async and better-sqlite3's transactions are strictly synchronous (a transaction function
 * that returns a promise is refused outright). That is why the parse happens BEFORE the transaction is
 * opened, and the transaction itself touches nothing but the database.
 */

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE CONTRACT
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** The lists a stock row can add to. All lookups-driven — never a hardcoded dropdown. (CLAUDE.md §4) */
export const IMPORT_LOOKUP_LISTS = [
  'department',
  'category',
  'sub_category',
  'brand',
  'location'
] as const
export type ImportLookupList = (typeof IMPORT_LOOKUP_LISTS)[number]

/**
 * One problem, in one cell, in words a shopkeeper can act on. Never a stack trace, never "ZodError",
 * never "SQLITE_CONSTRAINT". `row` is the row number AS EXCEL SHOWS IT, because that is the only row
 * number the owner can see.
 */
export type ImportError = {
  sheet: string
  row: number
  column: string
  value: string
  message: string
}

/** One line of the Stock sheet, as it would land. Everything needed both to SHOW it and to WRITE it. */
export type StockRow = {
  row: number
  sku: string
  /** The name as typed. Ignored for an item that already exists — its name is not the sheet's business. */
  name: string
  /** Null = this stock code is new, and the item will be created. */
  productId: number | null
  isNew: boolean
  itemType: ItemType

  nameOtherLang: string | undefined
  sizeVolume: string | undefined
  /** The labels as typed. Resolved to ids — creating any that are missing — at apply time. */
  lookupLabels: Partial<Record<ImportLookupList, string>>

  /** 3-dp qty. The pack the item is BOUGHT in: a carton of 24 is 24000. Blank in the sheet = 1. */
  packSizeM: number
  /** 4-dp cost of ONE PACK, after the discount. Derived: SUPPLIER PRICE less DISCOUNT. */
  packCost: number
  /** 4-dp cost of ONE BASE UNIT. Derived: pack cost / pack size. What the opening movement is valued at. */
  unitCost: number
  /** Basis points off the supplier price. 5% = 500. */
  discountBp: number

  /** 2-dp money. Undefined = the cell was blank, so the item's price is left exactly as it is. */
  retailPrice: number | undefined
  wholesalePrice: number | undefined
  /** 3-dp qty. RE ORDER LEVEL. */
  minStockM: number | undefined

  /** 3-dp qty. 0 = a catalogue-only row: the item is created/updated, but it gets no opening stock. */
  qtyM: number
  /** 2-dp money. qty x unit cost, rounded EXACTLY as the commit will round it. See lineValueMinor(). */
  lineValueMinor: number

  barcodes: string[]
  batchNo: string | null
  expiryDate: string | null
}

/** One line of the Customer Udhaar or Supplier Dues sheet. */
export type PartyRow = {
  row: number
  name: string
  phone: string | null
  /** 2-dp money, always positive. A zero is not a debt. */
  amount: number
  note: string | null
  /** Null = this person is new, and will be created. */
  partyId: number | null
  isNew: boolean
}

/**
 * WHAT WOULD HAPPEN. Nothing is written to produce this — it is the review screen, and it is exactly
 * what applyImport() will do if the owner says yes.
 */
export type ImportPreview = {
  stock: {
    rows: StockRow[]
    newProducts: number
    existingProducts: number
    /** How many rows carry an opening quantity. The rest are catalogue-only. */
    openingLines: number
    /** 2-dp money. The sum of the lines — what Inventory will be debited with. */
    totalValueMinor: number
  }
  udhaar: { rows: PartyRow[]; newCustomers: number; totalMinor: number }
  dues: { rows: PartyRow[]; newSuppliers: number; totalMinor: number }
  /** 2-dp money. Undefined = the cell was blank, so the figure already in the draft is left alone. */
  cash: number | undefined
  bank: number | undefined
  /** Departments, categories, brands… that do not exist yet and will be created. */
  lookupsToCreate: Record<ImportLookupList, string[]>
  /** EMPTY, or the import is refused. Every problem in the file, not just the first. */
  errors: ImportError[]
}

/** What the import actually did. The wizard shows this, then opens the Review step on `summary`. */
export type ImportResult = {
  productsCreated: number
  productsUpdated: number
  barcodesAdded: number
  customersCreated: number
  suppliersCreated: number
  lookupsCreated: number
  stockLines: number
  receivables: number
  payables: number
  /** The DRAFT as it now stands. Nothing is in the books yet — the owner still presses Commit. */
  summary: OpeningSummary
}

/**
 * Past this many problems the file is not "a bit wrong", it is the wrong file — or its columns do not
 * line up at all. Listing 40,000 of them helps nobody and would hold a copy of the whole sheet in
 * memory as error objects.
 */
const MAX_ERRORS = 500

/**
 * exceljs types its buffer as an ArrayBuffer; in Node it hands back — and takes — a real Buffer.
 *
 * EXPORTED so the anytime product importer (product-import.ts) loads a workbook through the exact same
 * type, rather than re-declaring a subtly different one.
 */
export type ExcelBuffer = Parameters<Xlsx['load']>[0]

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE FLOAT TRAP — reading a cell
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export type CellRead = {
  /** The cell AS TEXT. The only form in which a number is allowed to leave this section of the file. */
  text: string
  /** Excel handed us a number, rather than text the owner typed. */
  wasNumber: boolean
  /** The cell is formatted as a percentage — so Excel is storing 5% as 0.05. See below. */
  isPercent: boolean
}

const BLANK: CellRead = { text: '', wasNumber: false, isPercent: false }

/**
 * THE VALUE A CELL REALLY CARRIES.
 *
 * exceljs hands back a FORMULA cell as an object — `{ formula: 'B2*0.05', result: 0.05 }` — not as a
 * number. So `typeof value === 'number'` was FALSE for every formula, and every guard that depended
 * on knowing "this arrived as a number" was silently disarmed for exactly the cells a shopkeeper is
 * most likely to produce: the ones he drag-filled down a column.
 *
 * What that cost: a DISCOUNT column drag-filled with `=B2*0.05` and formatted as a percentage shows
 * "5.00%" on screen and holds 0.05 underneath. The percent guard never fired, so it imported as
 * 5 basis points — 0.05% — instead of 500. Every item's cost came out ~5% too high, the whole opening
 * inventory was overstated, and that inflated cost then seeded the weighted average every future sale
 * would be costed against. Nothing caught it: the journals balanced perfectly around the wrong number.
 *
 * A formula is judged on the value it actually carries. Nested, because exceljs can wrap a shared
 * formula's result in another result.
 */
export function effectiveValue(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && 'result' in (value as Record<string, unknown>)) {
    return effectiveValue((value as Record<string, unknown>)['result'])
  }
  return value
}

export function readCell(row: Row, column: number | undefined): CellRead {
  if (column === undefined) return BLANK

  const cell = row.getCell(column)
  const numFmt = typeof cell.numFmt === 'string' ? cell.numFmt : ''
  const value: unknown = cell.value

  return {
    text: valueToText(value).trim(),
    // The formula's RESULT, not the wrapper around it. See effectiveValue.
    wasNumber: typeof effectiveValue(value) === 'number',
    isPercent: numFmt.includes('%')
  }
}

/**
 * A CELL, AS TEXT. This is the disarming of the float trap, and it is one line of it.
 *
 * `String(2185)` is "2185". `String(91.0417)` is "91.0417". JavaScript's number-to-string gives the
 * SHORTEST string that round-trips the double exactly, so nothing is lost on the way out — and a double
 * that CANNOT be a clean decimal shows itself for what it is: 0.1 + 0.2 comes back as
 * "0.30000000000000004", parseMoney refuses it, and the owner is told which row to look at.
 *
 * That string then goes to parseMoney / parseCost / parseQty, which produce an INTEGER or produce
 * NOTHING. What must never happen is arithmetic on the double itself — parseFloat, Number(), `* 100`,
 * Math.round — because every one of those re-admits the float that the integer discipline exists to
 * keep out, and it does it silently.
 */
export function valueToText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value) // ← the whole trap, disarmed here.
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'

  // A real Excel date cell. NOT cell.text, which renders a Date as a locale string
  // ("Mon Mar 01 2027 05:00:00 GMT+0500") — the ISO day is the only unambiguous thing in it.
  if (value instanceof Date) return value.toISOString().slice(0, 10)

  if (typeof value === 'object') {
    const object = value as Record<string, unknown>

    // A cell the owner part-formatted mid-word: "RICE" + " 5kg" as two runs.
    if (Array.isArray(object['richText'])) {
      return (object['richText'] as Array<{ text?: string }>).map((run) => run.text ?? '').join('')
    }
    // A formula. Take its CACHED RESULT and put it through exactly the same conversion — a formula
    // that worked out to a 17-decimal float is caught by the same net as one typed by hand.
    if ('result' in object) return valueToText(object['result'])
    // #N/A, #REF!, #DIV/0!. KEEP THE MARKER so the parse refuses it by name. Returning "" here would
    // read a broken cell as an innocent blank — a missing quantity nobody is ever told about.
    if ('error' in object) return String(object['error'])
    // A formula that has never been calculated has no result to read.
    if ('formula' in object || 'sharedFormula' in object) return ''
    if (typeof object['text'] === 'string') return object['text'] // a hyperlink
  }

  return String(value)
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// HEADERS
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * "STOCK CODE", "Stock Code", "stock_code" and "stockcode" are the same column. Case is ignored and so
 * is everything that is not a letter or a digit — which also lets "SIZE (VOLUME) - UOM" survive the
 * brackets and the dash.
 */
export function normalizeHeader(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * The headers each column answers to: the template's own, plus what the owner's old POS is likely to
 * call it. A header we do not recognise is IGNORED — a legacy export is full of columns that are none
 * of our business, and refusing the file over one of them would help nobody.
 *
 * BALANCE QUANTITY's aliases are deliberately TIGHT. It is the column that moves money: a bare "QTY" in
 * some other export could as easily mean the pack size, and guessing wrong would post stock the shop
 * does not have. If it does not match, the preview says "0 items will have an opening quantity" — which
 * the owner will see. A wrong guess, they would not.
 */
const STOCK_ALIASES: Record<StockKey, string[]> = {
  sku: ['stockcode', 'sku', 'itemcode', 'productcode', 'code'],
  name: ['itemname', 'name', 'productname', 'itemdescription', 'description'],
  nameOtherLang: ['otherlanguagename', 'otherlanguage', 'urduname', 'urdu', 'alternatename'],
  department: ['department', 'dept'],
  category: ['category'],
  subCategory: ['subcategory'],
  brand: ['brand'],
  location: ['location', 'shelf', 'aisle', 'rack'],
  sizeVolume: ['sizevolumeuom', 'sizevolume', 'size', 'volume', 'uom', 'unit'],
  packing: ['packing', 'packsize', 'pack', 'packingqty', 'unitsperpack', 'qtyperpack'],
  supplierPrice: ['supplierprice', 'purchaseprice', 'buyingprice', 'supplierrate'],
  discount: ['discount', 'discountpercent', 'disc'],
  costPrice: ['costprice', 'cost'],
  unitCost: ['unitcost', 'costperunit'],
  retailPrice: ['retailprice', 'retail', 'saleprice', 'sellingprice', 'salerate'],
  wholesalePrice: ['wholesaleprice', 'wholesale', 'wholesalerate'],
  profit: ['profit', 'profitpercent'],
  netProfit: ['netprofit'],
  reorderLevel: ['reorderlevel', 'reorder', 'minstock', 'minimumstock', 'reorderqty'],
  balanceQuantity: ['balancequantity', 'balanceqty', 'openingquantity', 'openingqty', 'qtyinhand'],
  barcode: ['barcode', 'barcodes', 'ean', 'upc'],
  itemType: ['itemtype', 'type'],
  batchNo: ['batchno', 'batch', 'batchnumber', 'lotno', 'lot'],
  expiry: ['expiry', 'expirydate', 'expdate', 'exp', 'expiredate']
}

const PARTY_ALIASES: Record<PartyKey, string[]> = {
  name: ['name', 'customername', 'suppliername', 'partyname', 'party'],
  phone: ['phone', 'mobile', 'contact', 'phoneno', 'mobileno', 'contactno'],
  amount: ['amountowed', 'amount', 'balance', 'outstanding', 'due', 'dues', 'owed'],
  note: ['note', 'notes', 'remarks', 'remark', 'comment']
}

const CASH_ALIASES: Record<CashKey, string[]> = {
  cash: ['cashinhand', 'cash', 'cashbalance', 'till'],
  bank: ['bankbalance', 'bank', 'bankaccount']
}

/** key -> the 1-based column number it was found in. Absent = the sheet does not have that column. */
export type ColumnMap<K extends string> = Partial<Record<K, number>>

/**
 * Match the sheet's header row against the contract.
 *
 * TWO COLUMNS THAT MEAN THE SAME THING IS AN ERROR, not a race won by whichever came last. A sheet with
 * both "RETAIL PRICE" and "SALE PRICE" in it is a sheet whose author has to say which one they meant.
 */
export function mapColumns<K extends string>(
  sheet: Worksheet,
  columns: ReadonlyArray<ColumnSpec<K>>,
  aliases: Record<K, string[]>,
  errors: ErrorSink
): ColumnMap<K> {
  const map: ColumnMap<K> = {}
  const claimedBy = new Map<K, string>()
  const header = sheet.getRow(1)

  header.eachCell((cell, columnNumber) => {
    const text = valueToText(cell.value).trim()
    const normalized = normalizeHeader(text)
    if (!normalized) return

    const spec = columns.find(
      (candidate) =>
        normalizeHeader(candidate.header) === normalized ||
        (aliases[candidate.key] ?? []).includes(normalized)
    )
    if (!spec) return // a column that is none of our business

    const already = claimedBy.get(spec.key)
    if (already !== undefined) {
      errors.add(sheet.name, 1, text, text, `This sheet has two columns that both mean "${spec.header}" — "${already}" and "${text}". Please remove one of them, so it is clear which figure to use.`)
      return
    }

    claimedBy.set(spec.key, text)
    map[spec.key] = columnNumber
  })

  return map
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// COLLECTING THE PROBLEMS
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Every problem in the file, in one pass. NOT the first one and then stop: the owner has one file open,
 * and being told about one broken cell at a time — upload, fix, upload, fix — across a 900-row sheet is
 * how people give up and type it all in by hand instead.
 */
export class ErrorSink {
  readonly rows: ImportError[] = []
  private overflowed = false

  /**
   * How many problems were RAISED — not how many we kept.
   *
   * The two used to be the same number, and that was a quiet disaster: past MAX_ERRORS the sink stops
   * storing, so `rows.length` stops growing, so RowReader.failed (which compared counts) went
   * permanently FALSE — and every bad row after the 500th was treated as GOOD and imported with
   * silently defaulted values. A cap on LISTING errors had accidentally become a cap on DETECTING
   * them, and it only bit on the files most likely to be broken: the big, messy ones.
   */
  private attempted = 0

  add(sheet: string, row: number, column: string, value: string, message: string): void {
    this.attempted++

    if (this.rows.length >= MAX_ERRORS) {
      if (!this.overflowed) {
        this.overflowed = true
        this.rows.push({
          sheet,
          row,
          column: '',
          value: '',
          message: `This file has more than ${MAX_ERRORS} problems, so we have stopped listing them. It may be the wrong file, or its columns may not line up with the template. Please download a fresh template and copy your figures into it.`
        })
      }
      return
    }
    this.rows.push({ sheet, row, column, value, message })
  }

  /** Problems RAISED. Use this to decide whether a row is safe — never `rows.length`. */
  get count(): number {
    return this.attempted
  }
}

/**
 * Reads one row's cells, and turns a bad one into a sentence the owner can act on.
 *
 *   undefined  the cell is BLANK. Not a problem — it means "I am not telling you about this", and the
 *              caller leaves the column alone. (CLAUDE.md trap #18.)
 *   null       the cell is WRONG. A problem has already been recorded against it; the caller only has
 *              to know that this row is not safe to import.
 */
export class RowReader {
  /** How many problems the file had BEFORE this row was read. See `failed`. */
  private readonly startedWith: number

  constructor(
    private readonly sheet: string,
    private readonly row: Row,
    private readonly rowNumber: number,
    private readonly headers: Record<string, string>,
    private readonly columns: Record<string, number | undefined>,
    private readonly errors: ErrorSink
  ) {
    this.startedWith = errors.count
  }

  /** Did anything go wrong on this row? Then nothing on it may be written. */
  get failed(): boolean {
    return this.errors.count > this.startedWith
  }

  private label(key: string): string {
    return this.headers[key] ?? key
  }

  private cell(key: string): CellRead {
    return readCell(this.row, this.columns[key])
  }

  private fail(key: string, value: string, message: string): null {
    this.errors.add(this.sheet, this.rowNumber, this.label(key), value, message)
    return null
  }

  /** The cell exactly as the owner typed it. What an error message should quote back at them. */
  raw(key: string): string {
    return this.cell(key).text
  }

  /** Record a problem this row's own rules found, rather than one the cell's format gave away. */
  reject(key: string, message: string): void {
    this.fail(key, this.raw(key), message)
  }

  /** Is every cell we care about on this row empty? Then it is a blank row, and blank rows are fine. */
  isBlank(keys: string[]): boolean {
    return keys.every((key) => this.cell(key).text === '')
  }

  text(key: string, maxLength = 200): string | undefined {
    const { text } = this.cell(key)
    if (text === '') return undefined
    if (text.length > maxLength) {
      this.fail(key, text, `This is too long. Please shorten it to ${maxLength} letters or fewer.`)
      return undefined
    }
    return text
  }

  /**
   * A CELL THAT EXCEL IS STORING AS A PERCENTAGE.
   *
   * Format a cell as "5.00%" and Excel stores the number 0.05. We would read "0.05", parse it happily,
   * and import a 0.05% discount where the owner meant 5% — so his cost comes out at 99.95% of the
   * supplier price instead of 95%, on every item, and the figure looks perfectly reasonable.
   *
   * We do NOT quietly multiply it back up. Multiplying a float by 100 is exactly the thing this file
   * exists to refuse. We stop and say what to do about it.
   */
  private percentFormatted(key: string, cell: CellRead): boolean {
    if (!cell.isPercent || !cell.wasNumber) return false
    this.fail(
      key,
      cell.text,
      'This cell is formatted as a percentage, so Excel has stored it as a fraction (5% is stored as 0.05). Please format the column as Text and type 5 for 5%.'
    )
    return true
  }

  /** 2-dp MONEY, in integer minor units. A price, an amount owed, the cash in the till. */
  money(key: string): number | null | undefined {
    const cell = this.cell(key)
    if (cell.text === '') return undefined
    if (this.percentFormatted(key, cell)) return null

    const minor = parseMoney(cell.text)
    if (minor === null) {
      return this.fail(
        key,
        cell.text,
        `We could not read "${cell.text}" as an amount. Please type it plainly, like 3999 or 3999.50 — no more than 2 numbers after the dot, and no Rs sign.`
      )
    }
    if (minor < 0) {
      return this.fail(key, cell.text, 'This amount cannot be less than zero.')
    }
    return minor
  }

  /** 4-dp COST, in integer ten-thousandths. A DIFFERENT SCALE from money. What the shop PAYS. */
  cost(key: string): number | null | undefined {
    const cell = this.cell(key)
    if (cell.text === '') return undefined
    if (this.percentFormatted(key, cell)) return null

    const cost = parseCost(cell.text)
    if (cost === null) {
      return this.fail(
        key,
        cell.text,
        `We could not read "${cell.text}" as a cost. Please type it plainly, like 2185 or 91.0417 — no more than 4 numbers after the dot, and no Rs sign.`
      )
    }
    if (cost < 0) {
      return this.fail(key, cell.text, 'A cost cannot be less than zero.')
    }
    return cost
  }

  /** 3-dp QUANTITY, in integer thousandths. 1 piece = 1000; 1.5 kg = 1500. */
  qty(key: string): number | null | undefined {
    const cell = this.cell(key)
    if (cell.text === '') return undefined
    if (this.percentFormatted(key, cell)) return null

    const qtyM = parseQty(cell.text)
    if (qtyM === null) {
      return this.fail(
        key,
        cell.text,
        `We could not read "${cell.text}" as a quantity. Please type a number, like 12 or 1.5 — no more than 3 numbers after the dot, and no letters.`
      )
    }
    return qtyM
  }

  /**
   * A PERCENTAGE, as basis points. 5% -> 500. 12.75% -> 1275.
   *
   * Percent-to-basis-points is a multiply by 100 — the SAME integer scaling as rupees-to-paisa — so
   * parseMoney does it exactly, and it does it without ever touching a float. A trailing "%" typed into
   * a TEXT cell is unambiguous and is simply dropped; a NUMBER cell that Excel has percent-formatted is
   * not unambiguous at all, and is refused above.
   */
  percentBp(key: string): number | null | undefined {
    const cell = this.cell(key)
    if (cell.text === '') return undefined
    if (this.percentFormatted(key, cell)) return null

    const cleaned = cell.text.endsWith('%') ? cell.text.slice(0, -1).trim() : cell.text
    const bp = parseMoney(cleaned)

    if (bp === null) {
      return this.fail(
        key,
        cell.text,
        `We could not read "${cell.text}" as a discount. Please type a plain number — 5 for 5%, or 12.5 for 12.5%.`
      )
    }
    if (bp < 0 || bp > 10_000) {
      return this.fail(key, cell.text, 'A discount must be between 0% and 100%.')
    }
    return bp
  }

  /** An ISO date, YYYY-MM-DD. A real Excel date cell has already been resolved to one by readCell. */
  date(key: string): string | null | undefined {
    const { text } = this.cell(key)
    if (text === '') return undefined

    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      return this.fail(
        key,
        text,
        `We could not read "${text}" as a date. Please type it as 2027-03-01 — year, then month, then day.`
      )
    }
    const parsed = new Date(`${text}T12:00:00Z`)
    if (Number.isNaN(parsed.getTime())) {
      return this.fail(key, text, `"${text}" is not a real date. Please check it.`)
    }
    return text
  }

  /**
   * A BARCODE. Read as text, and refused if Excel has already got at it.
   *
   * A 13-digit barcode typed into a General cell becomes a NUMBER, and Excel renders it as 8.964E+12 —
   * and past 15 digits the double cannot even hold it, so the digits are gone before we ever see the
   * file. A barcode that has been through that is not a barcode; it is a number that used to be one, and
   * it will never scan again. So we stop, and say exactly what to change.
   */
  barcodes(key: string): string[] {
    const cell = this.cell(key)
    if (cell.text === '') return []

    if (cell.wasNumber && !/^\d{1,15}$/.test(cell.text)) {
      this.fail(
        key,
        cell.text,
        `Excel has turned this barcode into a number and may have changed it. Please format the barcode column as Text, then type the barcode again.`
      )
      return []
    }

    const found: string[] = []
    for (const part of cell.text.split(/[,;|\n]/)) {
      const barcode = part.trim()
      if (barcode === '') continue
      if (barcode.length > 64) {
        this.fail(key, barcode, 'This barcode is too long. A barcode may be up to 64 characters.')
        continue
      }
      if (!found.includes(barcode)) found.push(barcode)
    }
    return found
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE REFUSAL
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * MAY THIS SHOP STILL BE IMPORTED INTO AT ALL?
 *
 * Once the opening balances are in the books, or the shop has rung up its first real sale, the opening
 * figures FREEZE (see opening.ts). An import that ran anyway would rewrite the ground under every
 * profit report the owner has already read, and re-seed the average cost of stock that sales have
 * already been costed against — silently, with the trial balance still balancing.
 *
 * Refused at the door, in plain words, and refused again inside the transaction, because between the
 * preview and the click somebody may have made a sale.
 */
function assertImportable(db: DB): void {
  if (opening.getSetup(db).status === 'committed') {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Your opening balances have already been saved to the books, so they cannot be imported over. To correct a figure, use a stock adjustment — that way the change is recorded with a name and a reason against it.',
      'opening_setup.status = committed'
    )
  }

  if (opening.hasTraded(db)) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'This shop has already made sales or purchases, so the opening balances are now locked and cannot be imported over. To correct a figure, use a stock adjustment.',
      'a sale or purchase already exists: the opening balances are frozen'
    )
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// PARSE — writes nothing
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * READ THE FILE AND SAY WHAT WOULD HAPPEN. Nothing is written. Nothing is created. Not one row.
 *
 * `db` is here to READ: to tell a new stock code from one the shop already has, to find the department
 * that already exists rather than making a second one, and to notice a barcode that belongs to a
 * different item.
 */
export async function parseWorkbook(db: DB, buffer: Buffer): Promise<ImportPreview> {
  assertImportable(db)

  const workbook = new Workbook()
  try {
    await workbook.xlsx.load(buffer as unknown as ExcelBuffer)
  } catch (error) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'We could not open that file. Please make sure it is the Excel template, saved as .xlsx, and try again.',
      `exceljs failed to load the workbook: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  const stockSheet = findSheet(workbook, SHEET_STOCK)
  const udhaarSheet = findSheet(workbook, SHEET_UDHAAR)
  const duesSheet = findSheet(workbook, SHEET_DUES)
  const cashSheet = findSheet(workbook, SHEET_CASH)

  if (!stockSheet && !udhaarSheet && !duesSheet && !cashSheet) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'This does not look like the import template. We could not find a sheet called "Stock", "Customer Udhaar", "Supplier Dues" or "Cash and Bank" in it. Please download a fresh template and copy your figures into it.',
      `no recognisable sheet; found: ${workbook.worksheets.map((sheet) => sheet.name).join(', ')}`
    )
  }

  const errors = new ErrorSink()

  const stockRows = stockSheet ? parseStock(db, stockSheet, errors) : []
  const udhaarRows = udhaarSheet ? parseParty(db, udhaarSheet, 'customer', errors) : []
  const duesRows = duesSheet ? parseParty(db, duesSheet, 'supplier', errors) : []
  const cash = cashSheet ? parseCash(cashSheet, errors) : { cash: undefined, bank: undefined }

  return {
    stock: {
      rows: stockRows,
      newProducts: stockRows.filter((row) => row.isNew).length,
      existingProducts: stockRows.filter((row) => !row.isNew).length,
      openingLines: stockRows.filter((row) => row.qtyM > 0).length,
      totalValueMinor: stockRows.reduce((total, row) => total + row.lineValueMinor, 0)
    },
    udhaar: {
      rows: udhaarRows,
      newCustomers: udhaarRows.filter((row) => row.isNew).length,
      totalMinor: udhaarRows.reduce((total, row) => total + row.amount, 0)
    },
    dues: {
      rows: duesRows,
      newSuppliers: duesRows.filter((row) => row.isNew).length,
      totalMinor: duesRows.reduce((total, row) => total + row.amount, 0)
    },
    cash: cash.cash,
    bank: cash.bank,
    lookupsToCreate: collectLookupsToCreate(db, stockRows),
    errors: errors.rows
  }
}

/** Sheets are matched by name, ignoring case and spacing — "customer udhaar" is "Customer Udhaar". */
export function findSheet(workbook: Workbook, name: string): Worksheet | undefined {
  const wanted = normalizeHeader(name)
  return workbook.worksheets.find((sheet) => normalizeHeader(sheet.name) === wanted)
}

// ── SHEET 1: the stock ───────────────────────────────────────────────────────

/** StockKey -> the lookups list it feeds. The rest of the columns are not lookups-driven. */
const LOOKUP_COLUMNS: ReadonlyArray<{ key: StockKey; list: ImportLookupList }> = [
  { key: 'department', list: 'department' },
  { key: 'category', list: 'category' },
  { key: 'subCategory', list: 'sub_category' },
  { key: 'brand', list: 'brand' },
  { key: 'location', list: 'location' }
]

function parseStock(db: DB, sheet: Worksheet, errors: ErrorSink): StockRow[] {
  const columns = mapColumns(sheet, STOCK_COLUMNS, STOCK_ALIASES, errors)
  const headers = headerLabels(STOCK_COLUMNS)

  // Without a stock code there is nothing to match an item ON. Say so once, and stop — rather than
  // report the same thing against every one of 900 rows.
  if (columns.sku === undefined) {
    errors.add(
      sheet.name,
      1,
      'STOCK CODE',
      '',
      'This sheet has no STOCK CODE column, so we cannot tell which item each row is about. Please download a fresh template and copy your figures into it.'
    )
    return []
  }

  const rows: StockRow[] = []
  const meaningful = STOCK_COLUMNS.filter((column) => !column.ignored).map((column) => column.key)

  /** Stock code (lower-cased) -> the row it was first seen on. */
  const seenSku = new Map<string, number>()
  /** Barcode -> the row that claimed it. Two rows cannot own the same barcode. */
  const seenBarcode = new Map<string, number>()

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return // the header

    const reader = new RowReader(sheet.name, row, rowNumber, headers, columns, errors)
    if (reader.isBlank(meaningful)) return // a blank row is not a mistake

    const sku = reader.text('sku', 50)
    if (sku === undefined) {
      errors.add(sheet.name, rowNumber, 'STOCK CODE', '', 'This row has no stock code. Every item needs one — it is how the app recognises the item.')
      return
    }

    const duplicate = seenSku.get(sku.toLowerCase())
    if (duplicate !== undefined) {
      errors.add(
        sheet.name,
        rowNumber,
        'STOCK CODE',
        sku,
        `The stock code "${sku}" is already on row ${duplicate}. Please put each item on one row only — otherwise we would have to guess which row you meant, and one of them would silently win.`
      )
      return
    }
    seenSku.set(sku.toLowerCase(), rowNumber)

    const existing = products.findBySku(db, sku)

    // The sheet's ITEM NAME is IGNORED for an item that already exists (owner's rule). Renaming the
    // shop's catalogue is not something a spreadsheet full of numbers should do as a side effect.
    const name = reader.text('name', 200)
    if (!existing && name === undefined) {
      errors.add(sheet.name, rowNumber, 'ITEM NAME', '', `"${sku}" is a new stock code, so we need a name for it.`)
    }

    const itemType = readItemType(reader, existing?.itemType)

    const packing = reader.qty('packing')
    if (packing !== undefined && packing !== null && packing <= 0) {
      reader.reject('packing', 'A pack must hold at least one item. Leave PACKING blank if you buy this one at a time.')
    }

    const supplierPrice = reader.cost('supplierPrice')
    const discountBp = reader.percentBp('discount')
    const retailPrice = reader.money('retailPrice')
    const wholesalePrice = reader.money('wholesalePrice')
    const minStockM = reader.qty('reorderLevel')
    const qtyM = reader.qty('balanceQuantity')
    const barcodes = reader.barcodes('barcode')
    const batchNo = reader.text('batchNo', 100)
    const expiryDate = reader.date('expiry')

    // AN EXPIRY DATE WITH NO BATCH NUMBER IS A ROW THAT CANNOT BE IMPORTED.
    //
    // The opening service needs a batch to hang an expiry on, and it says so — but it said so from
    // deep inside applyImport's transaction, long AFTER the preview had told the owner the file was
    // clean. The whole import then died on one row, at the moment he pressed Import, with a message
    // that named no row he could go and fix. Everything a row cannot survive belongs in the PREVIEW,
    // beside its row number, while he still has the spreadsheet open.
    if (expiryDate && !batchNo) {
      reader.reject(
        'expiry',
        'This row has an expiry date but no batch number. An expiry belongs to a batch — add the batch number, or clear the expiry date.'
      )
    }

    for (const barcode of barcodes) {
      const claimedOn = seenBarcode.get(barcode)
      if (claimedOn !== undefined) {
        errors.add(sheet.name, rowNumber, 'BARCODE', barcode, `Barcode ${barcode} is already used on row ${claimedOn}. A barcode can only belong to one item, or the scanner would not know which one to ring up.`)
        continue
      }
      seenBarcode.set(barcode, rowNumber)

      // Already on this very product? Then it is not a clash — it is the barcode it already has.
      const owner = catalog.findProductByBarcode(db, barcode)
      if (owner && owner.product.id !== existing?.id) {
        errors.add(sheet.name, rowNumber, 'BARCODE', barcode, `Barcode ${barcode} already belongs to "${owner.product.name}". A barcode can only belong to one item, or the scanner would not know which one to ring up.`)
      }
    }

    // ── A SERVICE HAS NO SHELF. ─────────────────────────────────────────────────────────────────
    // A non-inventory item — a delivery charge, a repair — sells and earns, but it has no stock and it
    // can never appear on a stock report. An opening quantity of one would be a balance nobody will
    // ever see and nobody can ever sell, sitting in Inventory in the general ledger forever.
    if (itemType === 'non_inventory' && qtyM != null && qtyM > 0) {
      reader.reject(
        'balanceQuantity',
        `"${name ?? existing?.name ?? sku}" is a NON INVENTORY item — a service or a charge — so it cannot have a balance quantity. Either clear the quantity, or change ITEM TYPE to INVENTORY.`
      )
    }

    if (reader.failed) return

    // ── THE PRICE CHAIN. Both figures RECOMPUTED — never read from the sheet. ───────────────────
    //   SUPPLIER PRICE less DISCOUNT  ->  COST PRICE (of one pack)
    //   COST PRICE / PACKING          ->  UNIT COST  (of one base unit)  <- what stock is valued at
    //
    // Past the `failed` check above, nothing here is null: a cell that would not convert has already
    // taken the row out. A blank PACKING means a pack of one.
    const packSizeM = packing ?? ONE_UNIT
    const packCost = products.costFromSupplier(supplierPrice ?? 0, discountBp ?? 0)
    const unitCost = products.unitCostFromPack(packCost, packSizeM)
    const quantity = qtyM ?? 0

    // STOCK WITH NO COST IS NOT "FREE STOCK" — IT IS A MISSING NUMBER.
    //
    // `supplierPrice ?? 0` was silently valuing an opening stock line at ZERO whenever the SUPPLIER
    // PRICE cell was left blank — and a blank column is the single most likely thing to be missing
    // from a spreadsheet exported out of an old system.
    //
    // What it cost: the opening movement books Rs 0 of Inventory, the weighted average is seeded at
    // Rs 0, and every subsequent sale of that item posts COGS of ZERO — so the shop reports a 100%
    // profit margin on it, forever. The GL and the stock report agree (both are 0), every journal
    // balances, and the trial balance stays green. Nothing in the app would ever have noticed.
    //
    // The whole reason Opening Setup exists is to stop exactly that. So: a quantity with no cost is
    // an ERROR, named, with its row number — never a silent zero.
    if (quantity > 0 && (supplierPrice ?? 0) <= 0) {
      reader.reject(
        'supplierPrice',
        'This item has an opening quantity but no supplier price, so there is nothing to value the stock at. Enter what you paid for it — otherwise the shop would report 100% profit on every one you sell.'
      )
    }

    rows.push({
      row: rowNumber,
      sku,
      name: name ?? existing?.name ?? '',
      productId: existing?.id ?? null,
      isNew: !existing,
      itemType,
      nameOtherLang: reader.text('nameOtherLang', 200),
      sizeVolume: reader.text('sizeVolume', 100),
      lookupLabels: readLookupLabels(reader),
      packSizeM,
      packCost,
      unitCost,
      discountBp: discountBp ?? 0,
      retailPrice: retailPrice ?? undefined,
      wholesalePrice: wholesalePrice ?? undefined,
      minStockM: minStockM ?? undefined,
      qtyM: quantity,
      lineValueMinor: quantity > 0 ? lineValueMinor(quantity, unitCost) : 0,
      barcodes,
      // Batch and expiry belong ONLY to an item the shop has set up for batch tracking. On anything
      // else they are ignored — the Instructions sheet says so. Refusing the whole import over a batch
      // number typed onto a tin of beans would help nobody.
      batchNo: existing?.trackBatches ? (batchNo ?? null) : null,
      expiryDate: existing?.trackBatches ? (expiryDate ?? null) : null
    })
  })

  return rows
}

/**
 * WHAT ONE OPENING LINE IS WORTH, in 2-dp money.
 *
 * The SAME arithmetic, in the same order, with the same rounding, as opening.ts uses to value the line
 * and as stock.adjust() uses to post it. Rounded PER LINE — not summed raw and rounded once at the end
 * — because that is how the journal will post it. A preview that totals it any other way is a preview
 * that can promise a figure the books will not show.
 */
function lineValueMinor(qtyM: number, unitCost: number): number {
  return costToPriceMinor(stock.movementValueCost(qtyM, unitCost))
}

/**
 * INVENTORY or NON INVENTORY.
 *
 * A blank cell falls back to what the item ALREADY IS — not to the default. Blanking the ITEM TYPE
 * column on a re-upload must not quietly turn the shop's delivery charge into a stocked good.
 */
function readItemType(reader: RowReader, fallback: ItemType | undefined): ItemType {
  const text = reader.text('itemType', 30)
  if (text === undefined) return fallback ?? 'inventory'

  const normalized = normalizeHeader(text)
  if (normalized === 'inventory') return 'inventory'
  if (normalized === 'noninventory') return 'non_inventory'

  reader.reject(
    'itemType',
    `We did not understand "${text}". Please type INVENTORY for something you keep on a shelf, or NON INVENTORY for a service or a charge.`
  )
  return fallback ?? 'inventory'
}

function readLookupLabels(reader: RowReader): Partial<Record<ImportLookupList, string>> {
  const labels: Partial<Record<ImportLookupList, string>> = {}
  for (const { key, list } of LOOKUP_COLUMNS) {
    const label = reader.text(key, 100)
    if (label !== undefined) labels[list] = label
  }
  return labels
}

// ── SHEETS 2 and 3: udhaar and dues ──────────────────────────────────────────

function parseParty(
  db: DB,
  sheet: Worksheet,
  kind: 'customer' | 'supplier',
  errors: ErrorSink
): PartyRow[] {
  const columns = mapColumns(sheet, PARTY_COLUMNS, PARTY_ALIASES, errors)
  const headers = headerLabels(PARTY_COLUMNS)
  const who = kind === 'customer' ? 'customer' : 'supplier'

  if (columns.name === undefined || columns.amount === undefined) {
    errors.add(
      sheet.name,
      1,
      columns.name === undefined ? 'NAME' : 'AMOUNT OWED',
      '',
      `This sheet needs a NAME column and an AMOUNT OWED column. Please download a fresh template and copy your figures into it.`
    )
    return []
  }

  const rows: PartyRow[] = []
  const keys = PARTY_COLUMNS.map((column) => column.key)
  /** name+phone -> the row it was first seen on. One opening balance per person. */
  const seen = new Map<string, number>()

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return

    const reader = new RowReader(sheet.name, row, rowNumber, headers, columns, errors)
    if (reader.isBlank(keys)) return

    const name = reader.text('name', 200)
    if (name === undefined) {
      errors.add(sheet.name, rowNumber, 'NAME', '', `This row has an amount but no name. Please say which ${who} it belongs to.`)
      return
    }

    const phone = reader.text('phone', 50) ?? null
    const amount = reader.money('amount')

    if (amount === undefined) {
      errors.add(sheet.name, rowNumber, 'AMOUNT OWED', '', `Please enter how much ${name} owes. If they owe nothing, remove this row.`)
      return
    }
    if (amount !== null && amount <= 0) {
      errors.add(sheet.name, rowNumber, 'AMOUNT OWED', String(amount), `An amount of zero is not a debt. Please enter what ${name} owes, or remove this row.`)
      return
    }

    // ONE OPENING BALANCE PER PERSON. Two rows for Rashid would double what he owes, and he would be
    // chased for money he never borrowed.
    const identity = `${name.toLowerCase()}\u0000${(phone ?? '').toLowerCase()}`
    const duplicate = seen.get(identity)
    if (duplicate !== undefined) {
      errors.add(sheet.name, rowNumber, 'NAME', name, `"${name}" is already on row ${duplicate}. Please put the whole amount they owe on one row — two rows would double it.`)
      return
    }
    seen.set(identity, rowNumber)

    if (reader.failed) return

    const match = findParty(db, kind, name, phone)
    if (match === 'ambiguous') {
      errors.add(
        sheet.name,
        rowNumber,
        'NAME',
        name,
        `There is more than one ${who} called "${name}", so we cannot tell which one you mean. Please add their phone number.`
      )
      return
    }

    rows.push({
      row: rowNumber,
      name,
      phone,
      amount: amount as number,
      note: reader.text('note', 500) ?? null,
      partyId: match,
      isNew: match === null
    })
  })

  return rows
}

/**
 * WHICH PERSON IS THIS?
 *
 * Names are NOT unique, deliberately — in a Pakistani neighbourhood shop two customers really are both
 * called Muhammad Rashid, and the phone number is what tells them apart (see customers.ts). So the name
 * narrows it down and the phone decides, and the three ways that can end are all different:
 *
 *   nobody of that name              -> a new person. Create them.
 *   one of that name, no phone clash -> that is them. (An existing row with no phone number on it is
 *                                       not a different person — it is the same person, before anyone
 *                                       wrote their number down.)
 *   a different phone number         -> a DIFFERENT PERSON who happens to share a name. Create them.
 *   two of that name, nothing to
 *   tell them apart                  -> REFUSE, and ask for a phone number.
 *
 * That last one is the one that matters. Guessing would attach one man's debt to another man's ledger,
 * and he would be chased for money he never borrowed.
 */
function findParty(
  db: DB,
  kind: 'customer' | 'supplier',
  name: string,
  phone: string | null
): number | null | 'ambiguous' {
  const table = kind === 'customer' ? 'customers' : 'suppliers'

  const sameName = db
    .prepare(
      `SELECT id, COALESCE(phone, '') AS phone FROM ${table}
        WHERE LOWER(TRIM(name)) = LOWER(TRIM(@name))
        ORDER BY id`
    )
    .all({ name }) as Array<{ id: number; phone: string }>

  if (sameName.length === 0) return null

  const wanted = (phone ?? '').trim().toLowerCase()

  // No phone in the sheet: the name is all we have to go on. One match is them; two is a coin toss,
  // and we do not toss coins with a man's debts.
  if (wanted === '') {
    if (sameName.length === 1) return sameName[0]?.id ?? null
    return 'ambiguous'
  }

  const exact = sameName.filter((row) => row.phone.trim().toLowerCase() === wanted)
  if (exact.length === 1) return exact[0]?.id ?? null
  if (exact.length > 1) return 'ambiguous'

  // Nobody of that name has that number. If the only person of that name has NO number at all, this is
  // them — the shop simply never wrote it down. If they have a DIFFERENT number, it is somebody else.
  const unknownNumber = sameName.filter((row) => row.phone.trim() === '')
  if (unknownNumber.length === 1 && sameName.length === 1) return unknownNumber[0]?.id ?? null

  return null
}

// ── SHEET 4: cash and bank ───────────────────────────────────────────────────

function parseCash(
  sheet: Worksheet,
  errors: ErrorSink
): { cash: number | undefined; bank: number | undefined } {
  const columns = mapColumns(sheet, CASH_COLUMNS, CASH_ALIASES, errors)
  const headers = headerLabels(CASH_COLUMNS)

  const row = sheet.getRow(2)
  if (!row) return { cash: undefined, bank: undefined }

  const reader = new RowReader(sheet.name, row, 2, headers, columns, errors)

  // BLANK MEANS "DO NOT CHANGE THIS", not "set it to zero" (CLAUDE.md trap #18). A shop that typed its
  // till float into the wizard on Monday must not have it wiped by a Tuesday upload that only carried
  // the stock sheet. The Instructions sheet says this in words: type 0 if you truly have none.
  const cash = reader.money('cash')
  const bank = reader.money('bank')

  return { cash: cash ?? undefined, bank: bank ?? undefined }
}

// ── Lookups ──────────────────────────────────────────────────────────────────

/** Everything the sheet mentions that the shop does not have yet, in the order it first appeared. */
function collectLookupsToCreate(db: DB, rows: StockRow[]): Record<ImportLookupList, string[]> {
  const toCreate = emptyLookupMap()

  for (const list of IMPORT_LOOKUP_LISTS) {
    const existing = existingLookupLabels(db, list)
    const queued = new Set<string>()

    for (const row of rows) {
      const label = row.lookupLabels[list]
      if (label === undefined) continue

      const key = label.trim().toLowerCase()
      if (existing.has(key) || queued.has(key)) continue

      queued.add(key)
      toCreate[list].push(label)
    }
  }

  return toCreate
}

/**
 * The labels — and the codes — the shop already has on a list, INCLUDING the deactivated ones.
 *
 * An inactive lookup still occupies its code, and lookups.add() refuses a duplicate code outright. A
 * shop that retired "Bakery" last year and imports it again wants that same row back, not a crash.
 */
export function existingLookupLabels(db: DB, list: ImportLookupList): Map<string, number> {
  const map = new Map<string, number>()
  for (const lookup of lookups.list(db, list, true)) {
    map.set(lookup.label.trim().toLowerCase(), lookup.id)
    map.set(lookup.code.trim().toLowerCase(), lookup.id)
  }
  return map
}

export function emptyLookupMap(): Record<ImportLookupList, string[]> {
  return { department: [], category: [], sub_category: [], brand: [], location: [] }
}

// ── Small shared helpers ─────────────────────────────────────────────────────

export function headerLabels<K extends string>(
  columns: ReadonlyArray<ColumnSpec<K>>
): Record<string, string> {
  const labels: Record<string, string> = {}
  for (const column of columns) labels[column.key] = column.header
  return labels
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// APPLY — one transaction, or nothing
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * DO IT. In ONE transaction, or not at all.
 *
 *   1. create the lookups the sheet mentions and the shop does not have
 *   2. create the new items; update the ones that already exist (only the columns the sheet filled in)
 *   3. create the new customers and suppliers
 *   4. THROW AWAY THE PREVIOUS DRAFT and write this one
 *   5. cash and bank
 *
 * IT DOES NOT COMMIT THE OPENING BALANCES. It fills in the draft; the owner reviews it and presses
 * Commit himself. Importing a file and posting a shop's entire balance sheet to the ledger in the same
 * click, with nobody having looked at it, is not something this app is going to do.
 *
 * ── RE-UPLOADING REPLACES THE DRAFT, IT DOES NOT ADD TO IT ──────────────────────────────────────
 *
 * Step 4 is why. The owner will upload, spot a wrong figure, fix the spreadsheet and upload again — and
 * if the second upload APPENDED, the shop would open with double the stock it has, behind a perfectly
 * balanced journal that nothing downstream would ever question. The file is the truth; the draft is
 * rebuilt from it every time. (Regression-tested: uploading the same file twice must not double it.)
 */
export async function applyImport(
  db: DB,
  actor: User,
  buffer: Buffer,
  now = new Date()
): Promise<ImportResult> {
  assertImportable(db)

  // PARSED OUTSIDE THE TRANSACTION. exceljs is async, and better-sqlite3 refuses a transaction function
  // that returns a promise — so every await is finished before the first row is written.
  const preview = await parseWorkbook(db, buffer)

  if (preview.errors.length > 0) {
    const first = preview.errors[0] as ImportError
    const others = preview.errors.length - 1

    throw new AppError(
      ErrorCode.VALIDATION,
      others > 0
        ? `This file has ${preview.errors.length} problems that need fixing first. The first one is on the "${first.sheet}" sheet, row ${first.row}: ${first.message}`
        : `This file has a problem that needs fixing first. On the "${first.sheet}" sheet, row ${first.row}: ${first.message}`,
      `import refused: ${preview.errors.length} error(s); first: ${first.sheet}!${first.row} ${first.column} = ${JSON.stringify(first.value)}`
    )
  }

  const run = db.transaction((): ImportResult => {
    // Checked AGAIN, inside the transaction. Between the preview and this click, somebody at the second
    // till may have rung up a sale — and that freezes the opening balances.
    assertImportable(db)

    const lookupIds = createLookups(db, preview, now)
    const catalogue = writeProducts(db, actor, preview.stock.rows, lookupIds, now)

    const customerIds = writeParties(db, actor, 'customer', preview.udhaar.rows, now)
    const supplierIds = writeParties(db, actor, 'supplier', preview.dues.rows, now)

    clearDraft(db, preview)

    for (const row of preview.stock.rows) {
      if (row.qtyM <= 0) continue // a catalogue row: the item exists, it just has nothing on the shelf

      const productId = catalogue.idFor(row)
      opening.addStockLine(
        db,
        actor,
        {
          productId,
          qtyM: row.qtyM,
          unitCost: row.unitCost,
          batchNo: row.batchNo,
          expiryDate: row.expiryDate
        },
        now
      )
    }

    for (const row of preview.udhaar.rows) {
      opening.addReceivable(
        db,
        actor,
        { customerId: customerIds.get(row.row) as number, amount: row.amount, note: row.note },
        now
      )
    }

    for (const row of preview.dues.rows) {
      opening.addPayable(
        db,
        actor,
        { supplierId: supplierIds.get(row.row) as number, amount: row.amount, note: row.note },
        now
      )
    }

    // Only the figures the sheet actually carried. A blank cell leaves the draft's figure alone.
    const cashChanges: { openingCash?: number; openingBank?: number } = {}
    if (preview.cash !== undefined) cashChanges.openingCash = preview.cash
    if (preview.bank !== undefined) cashChanges.openingBank = preview.bank
    if (Object.keys(cashChanges).length > 0) opening.setCashAndBank(db, actor, cashChanges, now)

    const result: ImportResult = {
      productsCreated: catalogue.created,
      productsUpdated: catalogue.updated,
      barcodesAdded: catalogue.barcodesAdded,
      customersCreated: preview.udhaar.rows.filter((row) => row.isNew).length,
      suppliersCreated: preview.dues.rows.filter((row) => row.isNew).length,
      lookupsCreated: lookupIds.created,
      stockLines: preview.stock.rows.filter((row) => row.qtyM > 0).length,
      receivables: preview.udhaar.rows.length,
      payables: preview.dues.rows.length,
      summary: opening.getSummary(db, now)
    }

    // WHO imported this shop's entire opening position, WHEN, and how much of it. (CLAUDE.md §4)
    audit.record(
      db,
      actor,
      {
        action: 'opening.import',
        entity: 'opening_setup',
        entityId: 1,
        after: {
          productsCreated: result.productsCreated,
          productsUpdated: result.productsUpdated,
          customersCreated: result.customersCreated,
          suppliersCreated: result.suppliersCreated,
          lookupsCreated: result.lookupsCreated,
          stockLines: result.stockLines,
          stockValueMinor: result.summary.stockValueMinor,
          receivablesMinor: result.summary.receivablesMinor,
          payablesMinor: result.summary.payablesMinor,
          openingCashMinor: result.summary.openingCashMinor,
          openingBankMinor: result.summary.openingBankMinor
        }
      },
      now
    )

    return result
  })

  return run()
}

/**
 * THE PREVIOUS DRAFT, THROWN AWAY. See the note on applyImport — this is what stops a second upload
 * doubling the shop's stock.
 *
 * A direct DELETE, not a loop through opening.removeStockLine(): assertImportable() has already run
 * inside this transaction, so the freeze rule has been checked, and nothing here has been posted to the
 * books yet. These three tables are a WORKSHEET, not the ledger. If the transaction rolls back, the
 * owner's previous draft is still there, untouched.
 */
function clearDraft(db: DB, preview: ImportPreview): void {
  // REPLACE ONLY WHAT THE FILE ACTUALLY CARRIED.
  //
  // This used to delete all three worksheets unconditionally. So an owner who had hand-typed twenty
  // udhaar customers in the wizard, and then uploaded a spreadsheet of STOCK, lost all twenty — the
  // workbook never mentioned them, and the import wiped them anyway. The preview screen could not
  // even warn him: it reported what the FILE contained, not what the import was about to destroy.
  //
  // "Re-uploading replaces the draft" has to mean it replaces the part of the draft the file is
  // about. A file that says nothing about udhaar is not an instruction to delete the udhaar.
  //
  // (To clear a section deliberately, the wizard's own Remove button is right there.)
  if (preview.stock.rows.length > 0) db.prepare('DELETE FROM opening_stock_lines').run()
  if (preview.udhaar.rows.length > 0) db.prepare('DELETE FROM opening_receivables').run()
  if (preview.dues.rows.length > 0) db.prepare('DELETE FROM opening_payables').run()
}

// ── Lookups ──────────────────────────────────────────────────────────────────

type LookupIndex = {
  created: number
  /** list -> lowercased label/code -> id. */
  idOf: (list: ImportLookupList, label: string) => number | undefined
}

function createLookups(db: DB, preview: ImportPreview, now: Date): LookupIndex {
  const index = new Map<ImportLookupList, Map<string, number>>()
  let created = 0

  for (const list of IMPORT_LOOKUP_LISTS) {
    const known = existingLookupLabels(db, list)

    for (const label of preview.lookupsToCreate[list]) {
      const lookup = lookups.add(db, { listKey: list, label }, now)
      known.set(label.trim().toLowerCase(), lookup.id)
      created += 1
    }

    index.set(list, known)
  }

  return {
    created,
    idOf: (list, label) => index.get(list)?.get(label.trim().toLowerCase())
  }
}

// ── Products ─────────────────────────────────────────────────────────────────

type CatalogueWrite = {
  created: number
  updated: number
  barcodesAdded: number
  idFor: (row: StockRow) => number
}

type CreateProductArgs = Parameters<typeof products.create>[2]
type UpdateProductArgs = Parameters<typeof products.update>[2]

/**
 * Create what is new, update what is not.
 *
 * ── WHAT AN UPDATE MAY TOUCH, AND WHY IT IS SO SHORT ────────────────────────────────────────────
 *
 * ONLY THE COLUMNS THE SHEET ACTUALLY FILLED IN. A blank RETAIL PRICE means "I am not telling you about
 * the price of this", NOT "set the price to nothing" — and the pre-filled template has 340 blank price
 * cells in it by design. Posting the whole object back would wipe the price of every item the owner did
 * not happen to retype. (CLAUDE.md trap #18 — the same rule products.update() is built around.)
 *
 * The ITEM NAME is not touched at all on an existing item (owner's rule).
 *
 * AND THERE IS NO COST PRICE HERE. There is no cost price on UpdateProductInput either — it cannot be
 * written, by anyone, on purpose. Cost is the weighted average of what the shop PAID, derived from the
 * stock movements, and the opening movement seeds it at commit with a balanced journal behind it.
 */
function writeProducts(
  db: DB,
  actor: User,
  rows: StockRow[],
  lookupIds: LookupIndex,
  now: Date
): CatalogueWrite {
  const ids = new Map<number, number>() // sheet row -> product id
  let created = 0
  let updated = 0
  let barcodesAdded = 0

  const uomId = defaultSaleUomId(db)

  // THE SHOP'S OWN TAX MODE, read once for the whole import.
  //
  // An imported item used to land as 'exclusive' ALWAYS — the CreateProductInput schema's hardcoded
  // fallback — while an item typed in by hand honoured `tax.defaultMode`. So a shop that prices
  // INCLUSIVE (the shelf price is what the customer pays) got a spreadsheet full of items priced the
  // other way round, and every one of them would ring up with tax added on top. Nothing warned them.
  // The setting existed; the import path simply never read it (CLAUDE.md §4).
  //
  // A row can still say otherwise — this is the DEFAULT for rows that do not, which is all of them
  // today, because the sheet has no tax-mode column.
  const shopPriceEntryMode = settings.get<PriceEntryMode>(
    db,
    'tax.defaultMode',
    REGISTRY_DEFAULTS['tax.defaultMode'] as PriceEntryMode
  )

  for (const row of rows) {
    const lookupFor = (list: ImportLookupList): number | null => {
      const label = row.lookupLabels[list]
      return label === undefined ? null : (lookupIds.idOf(list, label) ?? null)
    }

    let productId: number

    if (row.productId === null) {
      const create: CreateProductArgs = {
        sku: row.sku,
        name: row.name,
        saleUomId: uomId,
        itemType: row.itemType,
        // The shop's own tax mode, not the schema's hardcoded 'exclusive' — see above.
        priceEntryMode: shopPriceEntryMode,
        // NO costPrice. Not an oversight — see the note above, and the file header.
        ...(row.nameOtherLang !== undefined ? { nameOtherLang: row.nameOtherLang } : {}),
        ...(row.sizeVolume !== undefined ? { sizeVolume: row.sizeVolume } : {}),
        ...(row.retailPrice !== undefined ? { retailPrice: row.retailPrice } : {}),
        ...(row.wholesalePrice !== undefined ? { wholesalePrice: row.wholesalePrice } : {}),
        ...(row.minStockM !== undefined ? { minStockM: row.minStockM } : {}),
        departmentId: lookupFor('department'),
        categoryId: lookupFor('category'),
        subCategoryId: lookupFor('sub_category'),
        brandId: lookupFor('brand'),
        locationId: lookupFor('location'),
        barcodes: row.barcodes
      }

      productId = products.create(db, actor, create, now).product.id
      created += 1
      barcodesAdded += row.barcodes.length
    } else {
      productId = row.productId

      // Built key by key. A key that is ABSENT is a column the sheet left blank, and products.update()
      // leaves an absent key's column exactly as it is.
      const update: UpdateProductArgs = { id: productId }
      if (row.nameOtherLang !== undefined) update.nameOtherLang = row.nameOtherLang
      if (row.sizeVolume !== undefined) update.sizeVolume = row.sizeVolume
      if (row.retailPrice !== undefined) update.retailPrice = row.retailPrice
      if (row.wholesalePrice !== undefined) update.wholesalePrice = row.wholesalePrice
      if (row.minStockM !== undefined) update.minStockM = row.minStockM
      if (row.lookupLabels.department !== undefined) update.departmentId = lookupFor('department')
      if (row.lookupLabels.category !== undefined) update.categoryId = lookupFor('category')
      if (row.lookupLabels.sub_category !== undefined) update.subCategoryId = lookupFor('sub_category')
      if (row.lookupLabels.brand !== undefined) update.brandId = lookupFor('brand')
      if (row.lookupLabels.location !== undefined) update.locationId = lookupFor('location')

      // ONLY IF THE SHEET ACTUALLY SAID SOMETHING ABOUT THE ITEM ITSELF.
      //
      // The pre-filled template invites the owner to type a QUANTITY and a COST against an item and
      // nothing else — and neither of those is a column on `products` (one becomes an opening stock
      // movement, the other values it). So the common case sends no product fields at all. Reporting
      // "340 items updated" when not one item's details changed is a lie, and it is the kind that makes
      // an owner distrust the whole screen.
      if (Object.keys(update).length > 1) {
        products.update(db, actor, update, now)
        updated += 1
      }

      // Add only the barcodes it does not already have. The others are the labels already on the shelf.
      const already = new Set(catalog.listBarcodes(db, productId).map((barcode) => barcode.barcode))
      for (const barcode of row.barcodes) {
        if (already.has(barcode)) continue
        catalog.addBarcode(db, { productId, barcode }, now)
        barcodesAdded += 1
      }
    }

    ids.set(row.row, productId)
  }

  return {
    created,
    updated,
    barcodesAdded,
    idFor: (row) => ids.get(row.row) as number
  }
}

/**
 * EVERY PRODUCT IS SOLD IN SOME UNIT, and every qty_m in the app is measured in it — `sale_uom_id` is
 * NOT NULL. The sheet does not carry one (its "SIZE (VOLUME) - UOM" column is free text, and goes to
 * size_volume), so an imported item gets the shop's default: Pieces.
 *
 * If the owner has renamed or retired Pieces we take whatever IS on their list rather than blocking the
 * import over a list edit. Only if the list is empty do we stop — and then we say what to do about it.
 * (The same shape as opening.ts's openingReasonCode, and for the same reason: no hardcoded dropdown
 * values, ever — CLAUDE.md §4.)
 */
function defaultSaleUomId(db: DB): number {
  const preferred = db
    .prepare(`SELECT id FROM lookups WHERE list_key = 'uom' AND code = 'pcs' AND is_active = 1`)
    .pluck()
    .get() as number | undefined

  if (preferred != null) return preferred

  const fallback = db
    .prepare(
      `SELECT id FROM lookups WHERE list_key = 'uom' AND is_active = 1 ORDER BY sort_order, id LIMIT 1`
    )
    .pluck()
    .get() as number | undefined

  if (fallback != null) return fallback

  throw new AppError(
    ErrorCode.VALIDATION,
    'Please add at least one unit — like Pieces — under Settings, Manage Lists, before importing your items.',
    'lookups(uom) is empty; products.sale_uom_id is NOT NULL'
  )
}

// ── Customers and suppliers ──────────────────────────────────────────────────

/**
 * sheet row -> the id of the person it is about. Created if they are new.
 *
 * NO CREDIT LIMIT is ever set from the sheet. A credit limit is a decision about how much udhaar
 * someone is ALLOWED to run up in future; the sheet only says what they ALREADY OWE. They are two
 * different numbers, and conflating them would silently cap — or uncap — a customer nobody agreed to.
 * Same reason there is no balance column: what a customer owes is derived from the ledger.
 */
function writeParties(
  db: DB,
  actor: User,
  kind: 'customer' | 'supplier',
  rows: PartyRow[],
  now: Date
): Map<number, number> {
  const ids = new Map<number, number>()

  for (const row of rows) {
    if (row.partyId !== null) {
      ids.set(row.row, row.partyId)
      continue
    }

    const id =
      kind === 'customer'
        ? customers.create(db, actor, { name: row.name, phone: row.phone }, now).id
        : suppliers.create(db, actor, { name: row.name, phone: row.phone }, now).id

    ids.set(row.row, id)
  }

  return ids
}
