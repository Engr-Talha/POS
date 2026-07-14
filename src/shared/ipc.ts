import { z } from 'zod'
import type { StockMovement } from './catalog'

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
  catalogAddBatch: 'catalog:addBatch'
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
