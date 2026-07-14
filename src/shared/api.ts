import type { Result } from './result'
import type {
  SystemInfo,
  DbSelfCheck,
  UpdateStatus,
  ActivateInput,
  CreateFirstOwnerInput,
  SignInInput,
  PinInput,
  RestoreInput,
  LookupsListInput,
  LookupsAddInput,
  LookupsUpdateInput,
  LookupsDeactivateInput,
  SettingsSetInput,
  AuditListInput,
  ProductDeactivateInput,
  ProductIdInput,
  ListVariantsInput,
  SupplierGetInput,
  StockLevelsInput,
  LowStockInput,
  NearExpiryInput,
  StockAdjustResult,
  NearExpiryItem
} from './ipc'
import type {
  AddBarcodeInput,
  AdjustStockInput,
  Batch,
  BatchListInput,
  BarcodeMatch,
  BarcodeReplacement,
  CreateBatchInput,
  CreateProductInput,
  CreateSupplierInput,
  CreateVariantGroupInput,
  DeleteProductPackInput,
  DeleteProductSupplierInput,
  PagedResult,
  Product,
  ProductBarcode,
  ProductDetail,
  ProductGetInput,
  ProductListInput,
  ProductListItem,
  ProductPack,
  ProductSupplier,
  ReplaceBarcodeInput,
  ResolveBarcodeInput,
  SaveProductPackInput,
  SaveProductSupplierInput,
  StockLevel,
  StockLevelInput,
  StockMovement,
  StockMovementListInput,
  Supplier,
  SupplierListInput,
  UpdateProductInput,
  UpdateSupplierInput,
  VariantGroup
} from './catalog'
import type { AuditEntry, BackupResult, Lookup } from './types'
import type { Account, TrialBalance } from './accounting'
import type { AppState } from './app-state'

/**
 * The shape of `window.pos` — the ENTIRE surface the renderer has.
 *
 * It lives in `shared/` rather than in preload so the renderer can be typed against it without
 * dragging Electron's Node-flavoured types into the browser build. The preload declares
 * `const api: PosApi`, so if a method here has no implementation, the build fails.
 *
 * Every capability is listed explicitly. There is deliberately NO generic `invoke(channel, args)`
 * escape hatch — that would hand the renderer the whole IPC surface and make the whitelist a
 * decoration. (CLAUDE.md §3)
 */
export interface PosApi {
  system: {
    getInfo: () => Promise<Result<SystemInfo>>
    dbSelfCheck: () => Promise<Result<DbSelfCheck>>
  }

  updates: {
    check: () => Promise<Result<UpdateStatus>>
    onStatus: (callback: (status: UpdateStatus) => void) => () => void
  }

  /** What screen should we be on? Answered by MAIN, never worked out in the renderer. */
  app: {
    getState: () => Promise<Result<AppState>>
  }

  license: {
    activate: (input: ActivateInput) => Promise<Result<AppState>>
  }

  auth: {
    createFirstOwner: (input: CreateFirstOwnerInput) => Promise<Result<AppState>>
    signIn: (input: SignInInput) => Promise<Result<AppState>>
    signInWithPin: (input: PinInput) => Promise<Result<AppState>>
    signOut: () => Promise<Result<AppState>>
  }

  backup: {
    /** Always allowed — even on an expired licence. Their data is never held hostage. */
    run: () => Promise<Result<BackupResult>>
    chooseFolder: () => Promise<Result<string | null>>
    restore: (input: RestoreInput) => Promise<Result<{ restoredFrom: string; safetyCopy: string }>>
  }

  lookups: {
    list: (input: LookupsListInput) => Promise<Result<Lookup[]>>
    add: (input: LookupsAddInput) => Promise<Result<Lookup>>
    update: (input: LookupsUpdateInput) => Promise<Result<Lookup>>
    deactivate: (input: LookupsDeactivateInput) => Promise<Result<boolean>>
  }

  settings: {
    getAll: () => Promise<Result<Record<string, unknown>>>
    set: (input: SettingsSetInput) => Promise<Result<Record<string, unknown>>>
  }

  ledger: {
    /** Reading the books is a READ — it keeps working on an expired licence, deliberately. */
    trialBalance: () => Promise<Result<TrialBalance>>
    accounts: () => Promise<Result<Account[]>>
  }

  audit: {
    list: (
      input: AuditListInput
    ) => Promise<Result<{ rows: AuditEntry[]; total: number; page: number; pageSize: number }>>
  }

  /**
   * THE CATALOG — the legacy "Item Detail" screen.
   *
   * Note what is NOT here: any way to write a stock figure. `create` and `update` have no stock
   * field, and there is no `setStock`. Stock is SUM(stock_movements.qty_m), and the only way to move
   * it is `stock.adjust`, which demands a reason code and writes the cashier's name against it.
   * `ProductDetail.stock` and `ProductListItem.onHandM` are derived on read, and are READ-ONLY.
   */
  products: {
    /** Paginated. Search matches stock code, item name, the Urdu name, and barcodes. */
    list: (input: ProductListInput) => Promise<Result<PagedResult<ProductListItem>>>
    /** Everything the product form needs — product, barcodes, packs, suppliers, batches, stock. */
    get: (input: ProductGetInput) => Promise<Result<ProductDetail>>
    create: (input: CreateProductInput) => Promise<Result<ProductDetail>>
    /** Send ONLY the fields the form edited. A whole object posted back wipes what it never loaded. */
    update: (input: UpdateProductInput) => Promise<Result<ProductDetail>>
    /** Never a delete: last year's sale still points at this row and its receipt must still print. */
    deactivate: (input: ProductDeactivateInput) => Promise<Result<Product>>
    createVariantGroup: (input: CreateVariantGroupInput) => Promise<Result<VariantGroup>>
    listVariants: (input: ListVariantsInput) => Promise<Result<Product[]>>
  }

  stock: {
    /** Paginated stock list. Every figure DERIVED from movements — no stored stock column exists. */
    levels: (input: StockLevelsInput) => Promise<Result<PagedResult<StockLevel>>>
    /** One item's BALANCE QUANTITY panel. `onHandM` is the on-hand figure. Read-only. */
    level: (input: StockLevelInput) => Promise<Result<StockLevel>>
    /** The legacy "SHOW HISTORY" panel: this item's movements, newest first. Paginated. */
    movements: (input: StockMovementListInput) => Promise<Result<PagedResult<StockMovement>>>
    /** The re-order report: everything at or below its re-order level. */
    lowStock: (input: LowStockInput) => Promise<Result<PagedResult<StockLevel>>>
    /** Batches about to expire (and every batch already past its date). */
    nearExpiry: (input: NearExpiryInput) => Promise<Result<PagedResult<NearExpiryItem>>>
    /**
     * THE ONLY WAY STOCK EVER CHANGES BY HAND. Signed qtyM, mandatory reason code from
     * lookups('adjustment_reason'). Posts the movement, the journal and the audit row together.
     */
    adjust: (input: AdjustStockInput) => Promise<Result<StockAdjustResult>>
  }

  catalog: {
    /**
     * THE SCANNER'S HOT PATH. Resolves against product barcodes AND pack barcodes — a carton
     * barcode returns the product and its pack, so one scan sells 24 pieces at the carton price.
     *
     * An unknown code returns `{ ok: true, data: null }`, NOT an error. A shopper's loyalty card
     * swiped at the till is an everyday event, not a fault, and the cashier gets "not found" rather
     * than a red error box.
     */
    findByBarcode: (input: ResolveBarcodeInput) => Promise<Result<BarcodeMatch | null>>
    listBarcodes: (input: ProductIdInput) => Promise<Result<ProductBarcode[]>>
    addBarcode: (input: AddBarcodeInput) => Promise<Result<ProductBarcode>>
    /**
     * The legacy "REPLACE BARCODE" panel. The old code is DEMOTED, never deleted — the tins already
     * on the shelf carry it, and they must keep scanning at the counter for as long as they exist.
     */
    replaceBarcode: (
      input: ReplaceBarcodeInput
    ) => Promise<
      Result<{ old: ProductBarcode; new: ProductBarcode; replacement: BarcodeReplacement }>
    >
    barcodeReplacements: (input: ProductIdInput) => Promise<Result<BarcodeReplacement[]>>

    /** ALTERNATE PACKINGS: each pack has its own cost, retail, wholesale and barcode. */
    listPacks: (input: ProductIdInput) => Promise<Result<ProductPack[]>>
    savePack: (input: SaveProductPackInput) => Promise<Result<ProductPack>>
    deletePack: (input: DeleteProductPackInput) => Promise<Result<boolean>>

    listSuppliers: (input: SupplierListInput) => Promise<Result<PagedResult<Supplier>>>
    getSupplier: (input: SupplierGetInput) => Promise<Result<Supplier>>
    createSupplier: (input: CreateSupplierInput) => Promise<Result<Supplier>>
    updateSupplier: (input: UpdateSupplierInput) => Promise<Result<Supplier>>
    /** MULTIPLE SUPPLIERS: each with its own supplier item code and its own price. */
    listProductSuppliers: (input: ProductIdInput) => Promise<Result<ProductSupplier[]>>
    linkSupplier: (input: SaveProductSupplierInput) => Promise<Result<ProductSupplier>>
    unlinkSupplier: (input: DeleteProductSupplierInput) => Promise<Result<boolean>>

    listBatches: (input: BatchListInput) => Promise<Result<PagedResult<Batch>>>
    addBatch: (input: CreateBatchInput) => Promise<Result<Batch>>
  }
}
