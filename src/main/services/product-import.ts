import { Workbook, type Worksheet } from 'exceljs'
import type { DB } from '../db'
import type { User } from '@shared/types'
import { AppError, ErrorCode } from '@shared/result'
import type { ItemType, PriceEntryMode, Product } from '@shared/catalog'
import { REGISTRY_DEFAULTS } from '@shared/settings-registry'
import * as audit from './audit'
import * as catalog from './catalog'
import * as lookups from './lookups'
import * as products from './products'
import * as settings from './settings'
import {
  ErrorSink,
  RowReader,
  emptyLookupMap,
  existingLookupLabels,
  findSheet,
  headerLabels,
  mapColumns,
  normalizeHeader,
  type ExcelBuffer,
  type ImportError,
  type ImportLookupList,
  IMPORT_LOOKUP_LISTS
} from './excel-import'
import type {
  OnExisting,
  ProductImportClassification,
  ProductImportPreview as ProductImportPreviewContract,
  ProductImportResult,
  ProductImportRow
} from '@shared/ipc'
import { PRODUCT_SHEET, PRODUCT_COLUMNS, type ProductKey } from './product-template'

/**
 * THE ANYTIME PRODUCT IMPORTER — bulk add-or-update the CATALOGUE, on any day, forever.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SEPARATE IMPORTER FROM excel-import.ts, AND WHAT MAKES IT SAFE TO RUN ANY DAY
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * excel-import.ts is the OPENING-BALANCE importer. It posts opening stock movements and opening
 * journals, so it is LOCKED the moment the shop records its first sale or purchase (opening.hasTraded).
 * A live, trading shop can never touch it again.
 *
 * This importer is different in kind. It touches ONLY the products table (via products.create /
 * products.update) and the lookups the catalogue references. It:
 *
 *      NEVER posts a journal.
 *      NEVER moves stock — it writes no stock_movement, ever.
 *      NEVER writes cost.
 *
 * That is the whole reason it is allowed to run on a trading shop: nothing it does can move the
 * general ledger or the stock valuation, so there is no opening balance to freeze and nothing to drift.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THE SHEET DELIBERATELY DOES NOT CARRY — and why
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * BALANCE QUANTITY / opening stock — NOT a column here. A live shop changes stock through Stock →
 * Adjust or a purchase, each of which posts a stock movement AND a balanced journal (DR Inventory /
 * CR …). A bulk sheet that wrote stock would revalue the shelf with no movement and no journal, the
 * GL and the stock report would silently disagree, and the trial balance would still balance — so
 * nothing would catch it (CLAUDE.md §4). Stock is DERIVED; it is never typed here.
 *
 * COST PRICE / UNIT COST / SUPPLIER PRICE — NOT columns here, and even if a legacy sheet carried them
 * we would READ AND THROW THEM AWAY. cost_price is the weighted average of stock_movements.unit_cost —
 * DERIVED, never typed (CLAUDE.md §5). A product created here seeds cost_price at 0, exactly as the
 * product FORM does for an item created with no purchase yet (CreateProductInput.costPrice defaults to
 * 0). It is then re-averaged by the first purchase, through a movement with a journal behind it.
 * products.update() does not accept costPrice at all — it is not in its UPDATABLE map — so an update
 * from this importer physically cannot revalue existing stock.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE FLOAT TRAP — the same one, disarmed the same way
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Excel hands you floats: a price cell showing 199.999 is a JS double by the time it reaches us. Every
 * numeric cell is read as TEXT (RowReader, shared verbatim with excel-import.ts) and converted with
 * parseMoney — and a cell that will not convert EXACTLY is REJECTED by row number, never rounded. There
 * is no parseFloat and no Number() in this file, and there must never be one. (CLAUDE.md §3.)
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * PARSE, THEN APPLY — and the transaction in between
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 *   parseProductWorkbook()  WRITES NOTHING. Returns what WOULD happen for every row, plus EVERY error
 *                           at once (the MAX_ERRORS-bounded ErrorSink), so the owner fixes the whole
 *                           file in one pass.
 *   applyProductImport()    re-parses, REFUSES if there is a single error, then does the lot in ONE
 *                           transaction. exceljs is async and better-sqlite3 transactions are strictly
 *                           sync, so the parse finishes BEFORE the transaction opens — exactly as
 *                           excel-import.ts explains at its top.
 */

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE CONTRACT
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export type { OnExisting, ProductImportResult } from '@shared/ipc'

export type ProductImportOptions = {
  onExisting: OnExisting
}

/**
 * The preview the SERVICE returns. It is the shared contract WITHOUT `fileName` — main stamps the file
 * name on in the IPC handler, exactly as it does for the opening importer, because the renderer never
 * learns a path and the service never sees one. (CLAUDE.md §3.)
 */
export type ProductImportPreview = Omit<ProductImportPreviewContract, 'fileName'>

/** One product row, as it would land — the shared contract row. */
export type ProductRow = ProductImportRow

/** How one row was classified. See the shared contract for the meaning of each value. */
export type RowClassification = ProductImportClassification

/** exceljs is async; the transaction is sync. The parse finishes before the transaction opens. */
type CreateProductArgs = Parameters<typeof products.create>[2]
type UpdateProductArgs = Parameters<typeof products.update>[2]

/** StockKey-style key -> the lookups list it feeds. */
const LOOKUP_COLUMNS: ReadonlyArray<{ key: ProductKey; list: ImportLookupList }> = [
  { key: 'department', list: 'department' },
  { key: 'category', list: 'category' },
  { key: 'subCategory', list: 'sub_category' },
  { key: 'brand', list: 'brand' },
  { key: 'location', list: 'location' }
]

/**
 * The headers each column answers to: the template's own, plus what the owner's old POS is likely to
 * call it. A legacy export lines up with no re-arranging; an unrecognised column is IGNORED. These are
 * a subset of the opening importer's STOCK_ALIASES, kept in step deliberately so a shop that has one
 * export can use either importer with it.
 */
const PRODUCT_ALIASES: Record<ProductKey, string[]> = {
  sku: ['stockcode', 'sku', 'itemcode', 'productcode', 'code'],
  name: ['itemname', 'name', 'productname', 'itemdescription', 'description'],
  nameOtherLang: ['otherlanguagename', 'otherlanguage', 'urduname', 'urdu', 'alternatename'],
  department: ['department', 'dept'],
  category: ['category'],
  subCategory: ['subcategory'],
  brand: ['brand'],
  location: ['location', 'shelf', 'aisle', 'rack'],
  sizeVolume: ['sizevolumeuom', 'sizevolume', 'size', 'volume', 'uom', 'unit'],
  retailPrice: ['retailprice', 'retail', 'saleprice', 'sellingprice', 'salerate'],
  wholesalePrice: ['wholesaleprice', 'wholesale', 'wholesalerate'],
  reorderLevel: ['reorderlevel', 'reorder', 'minstock', 'minimumstock', 'reorderqty'],
  barcode: ['barcode', 'barcodes', 'ean', 'upc'],
  itemType: ['itemtype', 'type']
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// PARSE — writes nothing
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * READ THE FILE AND SAY WHAT WOULD HAPPEN. Nothing is written — not one product, not one lookup.
 *
 * `db` is here to READ: to tell a new stock code from one the shop already has, to notice a barcode
 * that belongs to a different item, and to find the lookups that already exist rather than queue a
 * duplicate.
 *
 * There is NO assertImportable() here — deliberately. Unlike the opening importer, this one is not
 * frozen by a first sale, because it never touches the ledger or stock.
 */
export async function parseProductWorkbook(
  db: DB,
  buffer: Buffer,
  opts: ProductImportOptions
): Promise<ProductImportPreview> {
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

  const sheet = findSheet(workbook, PRODUCT_SHEET)
  if (!sheet) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'This does not look like the items template. We could not find a sheet called "Items" in it. Please download a fresh template and copy your figures into it.',
      `no "Items" sheet; found: ${workbook.worksheets.map((s) => s.name).join(', ')}`
    )
  }

  const errors = new ErrorSink()
  const rows = parseRows(db, sheet, opts, errors)

  return {
    rows,
    toCreate: rows.filter((r) => r.classification === 'create').length,
    toUpdate: rows.filter((r) => r.classification === 'update').length,
    toSkip: rows.filter((r) => r.classification === 'skip-exists' || r.classification === 'skip-nochange')
      .length,
    lookupsToCreate: collectLookupsToCreate(db, rows),
    onExisting: opts.onExisting,
    errors: errors.rows
  }
}

function parseRows(
  db: DB,
  sheet: Worksheet,
  opts: ProductImportOptions,
  errors: ErrorSink
): ProductRow[] {
  const columns = mapColumns(sheet, PRODUCT_COLUMNS, PRODUCT_ALIASES, errors)
  const headers = headerLabels(PRODUCT_COLUMNS)

  // Without a stock code there is nothing to match an item ON. Say so once, and stop.
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

  const rows: ProductRow[] = []
  const meaningful = PRODUCT_COLUMNS.map((c) => c.key)

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

    // MATCH BY STOCK CODE FIRST. Only if there is no SKU match do we fall back to a barcode — a
    // barcode a row carries may already be on file against an existing item (see below).
    let existing = products.findBySku(db, sku)

    const barcodes = reader.barcodes('barcode')

    // BARCODE FALLBACK MATCH. If the stock code is new to us but the row carries a barcode that already
    // belongs to a product, that product IS the item — the owner exported it under a different code, or
    // is re-keying it. We match it rather than create a second product wearing the same barcode.
    if (!existing) {
      for (const barcode of barcodes) {
        const owner = catalog.findProductByBarcode(db, barcode)
        if (owner) {
          existing = products.findBySku(db, owner.product.sku)
          break
        }
      }
    }

    // The sheet's ITEM NAME is IGNORED for an item that already exists (mirrors the opening importer).
    const name = reader.text('name', 200)
    if (!existing && name === undefined) {
      errors.add(sheet.name, rowNumber, 'ITEM NAME', '', `"${sku}" is a new stock code, so we need a name for it.`)
    }

    const itemType = readItemType(reader, existing?.itemType)
    const retailPrice = reader.money('retailPrice')
    const wholesalePrice = reader.money('wholesalePrice')
    const minStockM = reader.qty('reorderLevel')

    // BARCODE CLASH. Refused here, in the PREVIEW, so the owner sees it beside its row rather than
    // hitting it mid-transaction. Two rows claiming the same barcode; or a barcode already on file
    // against a DIFFERENT product. On the matched item's own barcode there is no clash.
    for (const barcode of barcodes) {
      const claimedOn = seenBarcode.get(barcode)
      if (claimedOn !== undefined) {
        errors.add(sheet.name, rowNumber, 'BARCODE', barcode, `Barcode ${barcode} is already used on row ${claimedOn}. A barcode can only belong to one item, or the scanner would not know which one to ring up.`)
        continue
      }
      seenBarcode.set(barcode, rowNumber)

      const owner = catalog.findProductByBarcode(db, barcode)
      if (owner && owner.product.id !== existing?.id) {
        errors.add(sheet.name, rowNumber, 'BARCODE', barcode, `Barcode ${barcode} already belongs to "${owner.product.name}". A barcode can only belong to one item, or the scanner would not know which one to ring up.`)
      }
    }

    // A SERVICE HAS NO SHELF — but this importer never writes stock anyway, so item type is only ever
    // a plain classification here. Nothing more to guard than the label being one we understand
    // (readItemType has already rejected an unknown one).

    if (reader.failed) return

    rows.push({
      row: rowNumber,
      sku,
      name: name ?? existing?.name ?? '',
      productId: existing?.id ?? null,
      classification: classify(existing, opts, retailPrice, wholesalePrice),
      itemType,
      nameOtherLang: reader.text('nameOtherLang', 200),
      sizeVolume: reader.text('sizeVolume', 100),
      lookupLabels: readLookupLabels(reader),
      retailPrice: retailPrice ?? undefined,
      wholesalePrice: wholesalePrice ?? undefined,
      minStockM: minStockM ?? undefined,
      barcodes
    })
  })

  return rows
}

/**
 * WHAT WOULD HAPPEN TO THIS ROW.
 *
 *   new stock code                                     -> 'create'
 *   exists, mode = skip                                -> 'skip-exists'   (untouched)
 *   exists, mode = update-prices, a price DIFFERS      -> 'update'
 *   exists, mode = update-prices, prices IDENTICAL     -> 'skip-nochange' (nothing to do)
 *
 * A blank price cell means "I am not telling you about this price", not "make it zero" — so a blank
 * retail with a filled wholesale still counts as a change if the wholesale differs, and a row with both
 * blank is 'skip-nochange' (there is nothing to update). (CLAUDE.md trap #18.)
 */
function classify(
  existing: Product | null,
  opts: ProductImportOptions,
  retailPrice: number | null | undefined,
  wholesalePrice: number | null | undefined
): RowClassification {
  if (!existing) return 'create'
  if (opts.onExisting === 'skip') return 'skip-exists'

  const retailChanges = retailPrice != null && retailPrice !== existing.retailPrice
  const wholesaleChanges = wholesalePrice != null && wholesalePrice !== existing.wholesalePrice

  return retailChanges || wholesaleChanges ? 'update' : 'skip-nochange'
}

/**
 * INVENTORY or NON INVENTORY. A blank cell falls back to what the item ALREADY IS — not the default —
 * so blanking the column on a re-upload does not quietly turn a service into a stocked good.
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

/**
 * Everything the sheet mentions that the shop does not have yet, in the order it first appeared. Only
 * rows that are NOT being skipped can create a lookup — a 'skip-exists' row is left entirely untouched,
 * so its department is not the sheet's business.
 */
function collectLookupsToCreate(db: DB, rows: ProductRow[]): Record<ImportLookupList, string[]> {
  const toCreate = emptyLookupMap()

  for (const list of IMPORT_LOOKUP_LISTS) {
    const existing = existingLookupLabels(db, list)
    const queued = new Set<string>()

    for (const row of rows) {
      if (!appliesLookups(row)) continue
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

/** Does this row write any product fields (and therefore possibly need a lookup created for it)? */
function appliesLookups(row: ProductRow): boolean {
  return row.classification === 'create'
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// APPLY — one transaction, or nothing
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * DO IT. In ONE transaction, or not at all.
 *
 * Re-parses (exceljs is async, the transaction is sync), REFUSES if there is a single error — a
 * half-imported catalogue is worse than none, because nobody can tell which half is real — and then:
 *
 *   1. creates the lookups the sheet mentions and the shop does not have
 *   2. creates the new items (cost_price seeds at 0 via CreateProductInput; NO stock, NO journal)
 *   3. in 'update-prices' mode, updates ONLY the price of existing items whose price differs
 *
 * NO STOCK MOVEMENT AND NO JOURNAL is posted by any of this. products.create writes a products row and
 * its barcodes; products.update writes only the price columns. Neither posts to stock_movements or the
 * journal. That is the property that separates this from the opening importer, and it is regression-
 * tested (product-import.test.ts).
 */
export async function applyProductImport(
  db: DB,
  actor: User,
  buffer: Buffer,
  opts: ProductImportOptions,
  now = new Date()
): Promise<ProductImportResult> {
  // PARSED OUTSIDE THE TRANSACTION. Every await is finished before the first row is written.
  const preview = await parseProductWorkbook(db, buffer, opts)

  if (preview.errors.length > 0) {
    const first = preview.errors[0] as ImportError
    const others = preview.errors.length - 1

    throw new AppError(
      ErrorCode.VALIDATION,
      others > 0
        ? `This file has ${preview.errors.length} problems that need fixing first. The first one is on row ${first.row}: ${first.message}`
        : `This file has a problem that needs fixing first. On row ${first.row}: ${first.message}`,
      `product import refused: ${preview.errors.length} error(s); first: row ${first.row} ${first.column} = ${JSON.stringify(first.value)}`
    )
  }

  const run = db.transaction((): ProductImportResult => {
    const lookupIds = createLookups(db, preview, now)
    const uomId = defaultSaleUomId(db)

    // The shop's own tax mode, read ONCE. An imported item honours it, exactly as a hand-typed one
    // does — a shop that prices inclusive must not get a spreadsheet full of exclusive items that ring
    // up with tax added on top (the bug excel-import.ts documents).
    const shopPriceEntryMode = settings.get<PriceEntryMode>(
      db,
      'tax.defaultMode',
      REGISTRY_DEFAULTS['tax.defaultMode'] as PriceEntryMode
    )

    let created = 0
    let updated = 0
    let skipped = 0

    for (const row of preview.rows) {
      const lookupFor = (list: ImportLookupList): number | null => {
        const label = row.lookupLabels[list]
        return label === undefined ? null : (lookupIds.idOf(list, label) ?? null)
      }

      if (row.classification === 'create') {
        const create: CreateProductArgs = {
          sku: row.sku,
          name: row.name,
          saleUomId: uomId,
          itemType: row.itemType,
          priceEntryMode: shopPriceEntryMode,
          // NO costPrice — it defaults to 0 in the schema, exactly as the product form leaves it for
          // an item created with no purchase yet. Cost is DERIVED; it is never typed here.
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

        products.create(db, actor, create, now)
        created += 1
        continue
      }

      if (row.classification === 'update') {
        // ONLY THE PRICE. Nothing else — not the name, not the category, not the cost. Sending any
        // other field would wipe what the sheet did not carry (CLAUDE.md trap #18), and costPrice is
        // not even accepted by products.update (its UPDATABLE map omits it — that is the silent-
        // revaluation bug, foreclosed at the type level).
        const update: UpdateProductArgs = { id: row.productId as number }
        if (row.retailPrice !== undefined) update.retailPrice = row.retailPrice
        if (row.wholesalePrice !== undefined) update.wholesalePrice = row.wholesalePrice

        // products.update() already audits a product.price_change (who, when, before, after) — good,
        // and we do NOT duplicate it. Only call if there is actually a price to write.
        if (Object.keys(update).length > 1) {
          products.update(db, actor, update, now)
          updated += 1
        } else {
          skipped += 1
        }
        continue
      }

      // 'skip-exists' and 'skip-nochange' both leave the item completely untouched.
      skipped += 1
    }

    const result: ProductImportResult = { created, updated, skipped }

    // ONE audit row for the import itself — who did it, when, and the counts. The per-item price
    // changes are already audited by products.update; this is the "a bulk import ran" record.
    audit.record(
      db,
      actor,
      {
        action: 'product.import',
        entity: 'product',
        entityId: 0,
        after: {
          onExisting: opts.onExisting,
          created: result.created,
          updated: result.updated,
          skipped: result.skipped
        }
      },
      now
    )

    return result
  })

  return run()
}

// ── Lookups ──────────────────────────────────────────────────────────────────

type LookupIndex = {
  created: number
  idOf: (list: ImportLookupList, label: string) => number | undefined
}

function createLookups(db: DB, preview: ProductImportPreview, now: Date): LookupIndex {
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

/**
 * EVERY PRODUCT IS SOLD IN SOME UNIT — sale_uom_id is NOT NULL. The sheet does not carry one, so an
 * imported item gets the shop's default: Pieces, or whatever IS on the list if that has been renamed.
 * Only an empty unit list stops us, and then we say what to do. (Mirrors excel-import.ts's
 * defaultSaleUomId — no hardcoded dropdown, ever, CLAUDE.md §4.)
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
