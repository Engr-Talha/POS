import { z } from 'zod'
import type { ItemType, StockMovement } from './catalog'
import type { OpeningSummary } from './opening'

/**
 * THE IPC CONTRACT. The one place the renderer and the main process agree on.
 *
 * The renderer can ONLY reach main through the channels listed here, exposed through a
 * contextBridge whitelist in src/preload. There is no `require`, no `fs`, and no SQLite in the
 * renderer — not hidden, not "just for now". (CLAUDE.md §3)
 *
 * The CATALOG schemas (products, stock, barcodes, packs, suppliers, batches) live in
 * `shared/catalog.ts` and are used verbatim by the handlers. Only the few inputs that had no home
 * there are defined at the bottom of this file.
 */

export const IPC = {
  systemGetInfo: 'system:getInfo',
  systemDbSelfCheck: 'system:dbSelfCheck',
  updateCheck: 'update:check',
  updateStatus: 'update:status',

  appGetState: 'app:getState',

  licenseActivate: 'license:activate',

  authCreateFirstOwner: 'auth:createFirstOwner',
  authSignIn: 'auth:signIn',
  authSignInWithPin: 'auth:signInWithPin',
  authSignOut: 'auth:signOut',

  backupRun: 'backup:run',
  backupChooseFolder: 'backup:chooseFolder',
  backupRestore: 'backup:restore',

  lookupsList: 'lookups:list',
  lookupsAdd: 'lookups:add',
  lookupsUpdate: 'lookups:update',
  lookupsDeactivate: 'lookups:deactivate',

  settingsGetAll: 'settings:getAll',
  settingsSet: 'settings:set',

  ledgerTrialBalance: 'ledger:trialBalance',
  accountsList: 'accounts:list',

  auditList: 'audit:list',

  // ── Catalog: products ──────────────────────────────────────────────────────
  productsList: 'products:list',
  productsGet: 'products:get',
  productsCreate: 'products:create',
  productsUpdate: 'products:update',
  productsDeactivate: 'products:deactivate',
  productsCreateVariantGroup: 'products:createVariantGroup',
  productsListVariants: 'products:listVariants',

  // ── Stock — every figure here is DERIVED from stock_movements ──────────────
  stockLevels: 'stock:levels',
  stockLevel: 'stock:level',
  stockMovements: 'stock:movements',
  stockLowStock: 'stock:lowStock',
  stockNearExpiry: 'stock:nearExpiry',
  stockAdjust: 'stock:adjust',

  // ── Catalog: barcodes ──────────────────────────────────────────────────────
  catalogFindByBarcode: 'catalog:findByBarcode',
  catalogListBarcodes: 'catalog:listBarcodes',
  catalogAddBarcode: 'catalog:addBarcode',
  catalogReplaceBarcode: 'catalog:replaceBarcode',
  catalogBarcodeReplacements: 'catalog:barcodeReplacements',

  // ── Catalog: alternate packings ────────────────────────────────────────────
  catalogListPacks: 'catalog:listPacks',
  catalogSavePack: 'catalog:savePack',
  catalogDeletePack: 'catalog:deletePack',

  // ── Catalog: suppliers ─────────────────────────────────────────────────────
  catalogListSuppliers: 'catalog:listSuppliers',
  catalogGetSupplier: 'catalog:getSupplier',
  catalogCreateSupplier: 'catalog:createSupplier',
  catalogUpdateSupplier: 'catalog:updateSupplier',
  catalogListProductSuppliers: 'catalog:listProductSuppliers',
  catalogLinkSupplier: 'catalog:linkSupplier',
  catalogUnlinkSupplier: 'catalog:unlinkSupplier',

  // ── Catalog: batches ───────────────────────────────────────────────────────
  catalogListBatches: 'catalog:listBatches',
  catalogAddBatch: 'catalog:addBatch',

  // ── Opening Setup — what the shop ALREADY HAD on day one ───────────────────
  // Every WRITE below is OWNER-ONLY ('settings.manage'). The reads are 'report.view'.
  openingGetSummary: 'opening:getSummary',
  openingSetCashAndBank: 'opening:setCashAndBank',

  openingListStockLines: 'opening:listStockLines',
  openingAddStockLine: 'opening:addStockLine',
  openingUpdateStockLine: 'opening:updateStockLine',
  openingRemoveStockLine: 'opening:removeStockLine',

  openingListReceivables: 'opening:listReceivables',
  openingAddReceivable: 'opening:addReceivable',
  openingUpdateReceivable: 'opening:updateReceivable',
  openingRemoveReceivable: 'opening:removeReceivable',

  openingListPayables: 'opening:listPayables',
  openingAddPayable: 'opening:addPayable',
  openingUpdatePayable: 'opening:updatePayable',
  openingRemovePayable: 'opening:removePayable',

  /** THE ONE-WAY DOOR. Posts every opening journal and movement, in one transaction. */
  openingCommit: 'opening:commit',

  // ── Opening Setup: the Excel import ────────────────────────────────────────
  // The shop's whole life, migrated in one upload. THE RENDERER NEVER TOUCHES THE FILESYSTEM: it
  // cannot name a file, and none of these three take a path. Main opens the dialog, main reads the
  // bytes, main remembers which file the owner picked. (CLAUDE.md §3)
  //
  // The first two are READS and stay open on an expired licence — an owner in read-only mode must
  // still be able to export their catalogue. Only `applyImport` writes. (CLAUDE.md §6)
  openingDownloadTemplate: 'opening:downloadTemplate',
  openingPreviewImport: 'opening:previewImport',
  openingApplyImport: 'opening:applyImport',

  // ── Customers ──────────────────────────────────────────────────────────────
  // They exist now because opening udhaar has to be owed BY SOMEBODY. Note what is missing: any way
  // to write a balance. What a customer owes is DERIVED from the ledger, exactly as stock is derived
  // from the movements.
  customersList: 'customers:list',
  customersCreate: 'customers:create',
  customersUpdate: 'customers:update'
} as const

export type SystemInfo = {
  appName: string
  appVersion: string
  platform: string
  isPackaged: boolean
  dbPath: string
  logPath: string
}

export type DbSelfCheck = {
  sqliteVersion: string
  journalMode: string
  foreignKeys: boolean
  roundTripOk: boolean
}

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'up-to-date' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  /**
   * The cashier is NEVER shown an update error. No internet is the NORMAL case for this app —
   * it is an offline POS. This state exists for the Settings screen and the log file only.
   */
  | { state: 'error'; technical: string }

// ── Input schemas ────────────────────────────────────────────────────────────
// Every handler that takes user input validates it with one of these, in MAIN, before it reaches a
// service. The renderer is not trusted to have validated anything.

export const ActivateInput = z.object({
  key: z.string().min(1, 'Please paste your licence key.')
})

export const CreateFirstOwnerInput = z.object({
  username: z.string().trim().min(1).max(50),
  fullName: z.string().trim().min(1).max(100),
  password: z.string().min(8, 'Please choose a password of at least 8 characters.')
})

export const SignInInput = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1)
})

export const PinInput = z.object({
  pin: z.string().trim().min(4).max(12)
})

export const RestoreInput = z.object({
  backupPath: z.string().min(1)
})

export const LookupsListInput = z.object({
  listKey: z.string().min(1),
  includeInactive: z.boolean().optional()
})

export const LookupsAddInput = z.object({
  listKey: z.string().min(1),
  label: z.string().trim().min(1, 'Please enter a name.')
})

export const LookupsUpdateInput = z.object({
  id: z.number().int().positive(),
  // Only the fields the form actually edits. We NEVER post the whole object back — that is how the
  // saved logo and signature got wiped (trap #18). `.nullish()` for anything nullable.
  label: z.string().trim().min(1).optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional()
})

export const LookupsDeactivateInput = z.object({
  id: z.number().int().positive()
})

export const SettingsSetInput = z.object({
  key: z.string().min(1),
  value: z.unknown()
})

export const AuditListInput = z.object({
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(200).optional(),
  action: z.string().optional()
})

// ── Catalog inputs that had no home in shared/catalog.ts ─────────────────────
// Everything else the catalog handlers validate with — CreateProductInput, AdjustStockInput,
// ReplaceBarcodeInput and the rest — is imported straight from '@shared/catalog'. These are the
// leftovers: the plain id lookups, and the two report filters whose service inputs were plain TS
// types rather than schemas (an IPC input MUST be a schema — the renderer is not trusted).

const RowId = z.number().int().positive()
const Page = z.number().int().positive().optional()
const PageSize = z.number().int().positive().max(200).optional()

/** Deactivate — never delete. Last year's sale still points at the row. */
export const ProductDeactivateInput = z.object({ id: RowId })

/** The child panels of the product form: barcodes, packs, suppliers, replacements. */
export const ProductIdInput = z.object({ productId: RowId })

export const ListVariantsInput = z.object({ variantGroupId: RowId })

export const SupplierGetInput = z.object({ id: RowId })

/** The stock list. Mirrors stock.StockLevelsInput — the handler's types tie the two together. */
export const StockLevelsInput = z.object({
  page: Page,
  pageSize: PageSize,
  /** Matches sku or name. */
  search: z.string().trim().max(100).optional(),
  categoryId: RowId.optional(),
  /** onHandM <= minStockM. */
  belowReorderOnly: z.boolean().optional(),
  includeInactive: z.boolean().optional(),
  sortBy: z.enum(['name', 'sku', 'on_hand']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional()
})

/** The re-order report. Same filters, minus the flag it hardcodes. */
export const LowStockInput = StockLevelsInput.omit({ belowReorderOnly: true })

/**
 * NEAR EXPIRY. `days` only — the service's `asOf` is deliberately NOT exposed: letting the renderer
 * choose "today" would let it decide what has expired, and expiry is not the renderer's opinion.
 */
export const NearExpiryInput = z.object({
  days: z.number().int().min(0).max(3650).optional(),
  productId: RowId.optional(),
  page: Page,
  pageSize: PageSize
})

// ── Opening Setup: the one input that had no home in shared/opening.ts ───────
// Everything else the opening handlers validate with — OpeningCashInput, UpdateOpeningStockLineInput,
// CommitOpeningInput and the rest — is imported straight from '@shared/opening', as are the customer
// schemas. This is the leftover: `opening.listReceivables` / `listPayables` take a plain TS type
// (`PartyListArgs`), and an IPC input MUST be a schema — the renderer is not trusted.

export const OpeningPartyListInput = z.object({
  page: Page,
  pageSize: PageSize
})

// ── Opening Setup result type that crosses the boundary ──────────────────────

/**
 * WHAT THE WIZARD RENDERS: the summary, plus whether it may still be TOUCHED.
 *
 * `opening.getSummary()` in main returns exactly `OpeningSummary` — the figures. But the figures alone
 * do not tell the screen whether it is a form or a receipt. The freeze rule (services/opening.ts) locks
 * the opening balances the moment the shop makes its first real sale or purchase, and a wizard that
 * cannot see that lets the owner type for an hour and only then be told "no". So the handler composes
 * the two reads — `getSummary()` and `hasTraded()` — into one payload, and the screen never has to
 * work the rule out for itself. (Neither is a security boundary: main refuses the write regardless.)
 */
export type OpeningWizardState = OpeningSummary & {
  /** True once a real sale or purchase exists. An opening entry or an adjustment is not trading. */
  hasTraded: boolean
  /** May the worksheet still be changed? False once committed, OR once the shop has traded. */
  canEdit: boolean
}

// ── The Excel import: what crosses the boundary ──────────────────────────────
//
// `shared/` cannot import from `main/`, so the import service's result shapes are MIRRORED here, and
// the handlers in main/ipc are annotated with them. That annotation is the whole point: if
// services/excel-import.ts ever drops or renames a field the screen reads, THE BUILD BREAKS HERE —
// rather than the review table quietly rendering an empty column over the shop's opening balances.
// (Same device as StockAdjustResult and NearExpiryItem below.)

/** The lists a Stock row can add to. Every dropdown in this app is lookups-driven. (CLAUDE.md §4) */
export type ImportLookupList = 'department' | 'category' | 'sub_category' | 'brand' | 'location'

/**
 * ONE PROBLEM, IN ONE CELL, in words a shopkeeper can act on — never a stack trace, never "ZodError".
 * `row` is the row number AS EXCEL SHOWS IT, because that is the only row number the owner can see.
 */
export type ImportError = {
  sheet: string
  row: number
  column: string
  value: string
  message: string
}

/**
 * One line of the Stock sheet, as it WOULD land. Nothing has been written to produce this.
 *
 * Read the scales twice — they are three DIFFERENT integer scales and mixing them is how a shop's
 * books get quietly falsified: `retailPrice` is 2-dp MONEY (minor units), `unitCost`/`packCost` are
 * 4-dp COST (ten-thousandths), and `qtyM`/`packSizeM`/`minStockM` are 3-dp QUANTITY (thousandths).
 * Format with formatMoney / formatCost / formatQty — never with plain arithmetic.
 */
export type ImportStockRow = {
  row: number
  sku: string
  name: string
  /** Null = this stock code is new, and the item will be created. */
  productId: number | null
  isNew: boolean
  itemType: ItemType
  nameOtherLang: string | undefined
  sizeVolume: string | undefined
  lookupLabels: Partial<Record<ImportLookupList, string>>
  /** 3-dp qty. The pack the item is BOUGHT in: a carton of 24 is 24000. */
  packSizeM: number
  /** 4-dp cost of ONE PACK, after the discount. DERIVED — the sheet's own COST PRICE is thrown away. */
  packCost: number
  /** 4-dp cost of ONE BASE UNIT. DERIVED. What the opening stock movement is valued at. */
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
  /** 2-dp money. Rounded EXACTLY as the commit will round it, so the preview cannot promise a figure
   *  the books will not show. */
  lineValueMinor: number
  barcodes: string[]
  batchNo: string | null
  expiryDate: string | null
}

/** One line of the Customer Udhaar or Supplier Dues sheet. `amount` is 2-dp money, always positive. */
export type ImportPartyRow = {
  row: number
  name: string
  phone: string | null
  amount: number
  note: string | null
  /** Null = this person is new, and will be created. */
  partyId: number | null
  isNew: boolean
}

/**
 * WHAT WOULD HAPPEN IF THE OWNER SAYS YES. Not one row was written to produce it.
 *
 * `errors` MUST BE EMPTY or the import is refused — by MAIN, not by the screen. A disabled button is a
 * courtesy; `applyImport` re-reads the file and refuses it again on its own.
 */
export type ImportPreview = {
  /** The file the owner picked, so the screen can name it back to them. The NAME only — never a path:
   *  the renderer has no business knowing where anything is on disk, and no way to act on it if it did. */
  fileName: string
  stock: {
    rows: ImportStockRow[]
    newProducts: number
    existingProducts: number
    /** How many rows carry an opening quantity. The rest are catalogue-only. */
    openingLines: number
    /** 2-dp money. The sum of the lines — what Inventory would be debited with. */
    totalValueMinor: number
  }
  udhaar: { rows: ImportPartyRow[]; newCustomers: number; totalMinor: number }
  dues: { rows: ImportPartyRow[]; newSuppliers: number; totalMinor: number }
  /** 2-dp money. Undefined = the cell was blank, so the figure already in the draft is left alone. */
  cash: number | undefined
  bank: number | undefined
  /** Departments, categories, brands… the sheet mentions that the shop does not have yet. */
  lookupsToCreate: Record<ImportLookupList, string[]>
  /** EMPTY, or the import is refused. Every problem in the file — not just the first. */
  errors: ImportError[]
}

/**
 * WHAT THE IMPORT ACTUALLY DID.
 *
 * `summary` is the DRAFT as it now stands. NOTHING IS IN THE BOOKS YET — the owner still reviews it and
 * presses Commit himself. Importing a file and posting a shop's entire balance sheet to the ledger in
 * the same click, with nobody having looked at it, is not something this app does.
 */
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
  summary: OpeningSummary
}

// ── Catalog result types that cross the boundary ─────────────────────────────
// `shared/` cannot import from `main/`, so the two service result shapes that had no row type in
// shared/catalog.ts are declared here. The handlers annotate their return types with these, so if a
// service's shape ever drifts from this contract the build fails rather than the renderer.

/** What stock.adjust() gives back: the movement, and the two derived figures after it. */
export type StockAdjustResult = {
  movement: StockMovement
  /** DERIVED — re-summed from the movements after this one landed. */
  onHandM: number
  /** 4-dp weighted-average cost after the movement. */
  avgCost: number
  /** Null when the movement had no value to post (a free sample moves stock, not money). */
  journalId: number | null
}

/** A row of the near-expiry report: stock the shop is about to have to throw away. */
export type NearExpiryItem = {
  productId: number
  sku: string
  name: string
  batchId: number
  batchNo: string
  expiryDate: string
  /** Negative once the batch is already past its date. */
  daysToExpiry: number
  expired: boolean
  /** qty_m still on the shelf. */
  onHandM: number
  /** 2-dp money minor units — what the shop stands to lose. */
  valueMinor: number
}

export type ActivateInput = z.infer<typeof ActivateInput>
export type CreateFirstOwnerInput = z.infer<typeof CreateFirstOwnerInput>
export type SignInInput = z.infer<typeof SignInInput>
export type PinInput = z.infer<typeof PinInput>
export type RestoreInput = z.infer<typeof RestoreInput>
export type LookupsListInput = z.infer<typeof LookupsListInput>
export type LookupsAddInput = z.infer<typeof LookupsAddInput>
export type LookupsUpdateInput = z.infer<typeof LookupsUpdateInput>
export type LookupsDeactivateInput = z.infer<typeof LookupsDeactivateInput>
export type SettingsSetInput = z.infer<typeof SettingsSetInput>
export type AuditListInput = z.infer<typeof AuditListInput>
export type ProductDeactivateInput = z.infer<typeof ProductDeactivateInput>
export type ProductIdInput = z.infer<typeof ProductIdInput>
export type ListVariantsInput = z.infer<typeof ListVariantsInput>
export type SupplierGetInput = z.infer<typeof SupplierGetInput>
export type StockLevelsInput = z.infer<typeof StockLevelsInput>
export type LowStockInput = z.infer<typeof LowStockInput>
export type NearExpiryInput = z.infer<typeof NearExpiryInput>
export type OpeningPartyListInput = z.infer<typeof OpeningPartyListInput>
