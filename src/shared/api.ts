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
  NearExpiryItem,
  OpeningPartyListInput,
  OpeningWizardState,
  ImportPreview,
  ImportResult
} from './ipc'
import type {
  CommitOpeningInput,
  CreateCustomerInput,
  Customer,
  CustomerListInput,
  DeleteOpeningPayableInput,
  DeleteOpeningReceivableInput,
  DeleteOpeningStockLineInput,
  OpeningCashInput,
  OpeningPayable,
  OpeningPayableInput,
  OpeningReceivable,
  OpeningReceivableInput,
  OpeningSetup,
  OpeningStockLine,
  OpeningStockLineInput,
  OpeningStockListInput,
  UpdateOpeningPayableInput,
  UpdateOpeningReceivableInput,
  UpdateOpeningStockLineInput,
  UpdateCustomerInput
} from './opening'
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

  /**
   * THE OPENING SETUP WIZARD — what the shop ALREADY HAD on the day it started using this app.
   *
   * Without it the books believe the shop began with nothing, and the first tin sold — a tin bought
   * last year — shows 100% profit, because as far as the ledger knows it cost nothing.
   *
   * OWNER ONLY. Every write below is gated on `settings.manage` in MAIN, not here. Everything except
   * the three reads changes the shop's books, and `commit` posts all of them at once.
   *
   * ADD / UPDATE / REMOVE are worksheet edits. NOTHING is in the books until `commit`, and after
   * `commit` nothing on this list can be changed at all — see `OpeningWizardState.canEdit`.
   */
  opening: {
    /**
     * The review screen, and the wizard's own state. A READ: it keeps working on an expired licence.
     * `canEdit` is composed in main from the freeze rule — see OpeningWizardState.
     */
    getSummary: () => Promise<Result<OpeningWizardState>>

    /**
     * Cash in the till, money in the bank, and the date the balances are AS AT.
     * Send ONLY the fields the step actually edited — a whole object posted back with `openingBank: 0`
     * because the form never loaded it is how a bank balance gets wiped. (Trap #18.)
     */
    setCashAndBank: (input: OpeningCashInput) => Promise<Result<OpeningSetup>>

    /** The stock sheet, paginated — a shop may open with thousands of lines. */
    listStockLines: (input: OpeningStockListInput) => Promise<Result<PagedResult<OpeningStockLine>>>
    /**
     * One line: "I have 40 of these and they cost me 91.0417 each."
     * `unitCost` is the 4-dp COST — what the shop PAID. A retail price here would state the cost a
     * hundred times too low and quietly falsify every profit report the shop ever runs.
     * Batch and expiry are OPTIONAL, and only for a product flagged `track_batches`.
     */
    addStockLine: (input: OpeningStockLineInput) => Promise<Result<OpeningStockLine>>
    updateStockLine: (input: UpdateOpeningStockLineInput) => Promise<Result<OpeningStockLine>>
    removeStockLine: (input: DeleteOpeningStockLineInput) => Promise<Result<boolean>>

    /** CUSTOMER UDHAAR: what customers already owe the shop. One row per customer. */
    listReceivables: (
      input: OpeningPartyListInput
    ) => Promise<Result<PagedResult<OpeningReceivable>>>
    addReceivable: (input: OpeningReceivableInput) => Promise<Result<OpeningReceivable>>
    updateReceivable: (input: UpdateOpeningReceivableInput) => Promise<Result<OpeningReceivable>>
    removeReceivable: (input: DeleteOpeningReceivableInput) => Promise<Result<boolean>>

    /** SUPPLIER DUES: what the shop already owes suppliers. One row per supplier. */
    listPayables: (input: OpeningPartyListInput) => Promise<Result<PagedResult<OpeningPayable>>>
    addPayable: (input: OpeningPayableInput) => Promise<Result<OpeningPayable>>
    updatePayable: (input: UpdateOpeningPayableInput) => Promise<Result<OpeningPayable>>
    removePayable: (input: DeleteOpeningPayableInput) => Promise<Result<boolean>>

    /**
     * THE ONE-WAY DOOR. Posts every opening stock movement and every opening journal — balanced,
     * against Opening Balance Equity — in ONE transaction. It cannot be undone and it cannot be run
     * twice: a second commit would post the whole opening balance AGAIN, with the trial balance still
     * balancing perfectly, and nothing downstream would ever catch it. Main refuses it on `status`.
     */
    commit: (input: CommitOpeningInput) => Promise<Result<OpeningWizardState>>

    // ── THE EXCEL IMPORT — a shop's whole life, migrated in one upload ────────────────────────────
    //
    // NOT ONE OF THESE THREE TAKES A FILE PATH, and that is the point. The renderer cannot name a file
    // and has no filesystem to name it on: main opens the dialog, main reads the bytes, and main
    // remembers which file the owner picked. All the screen can say is "the one the user chose".
    // (CLAUDE.md §3 — no fs in the renderer, not hidden, not "just for now".)

    /**
     * Build the Excel template — PRE-FILLED with every item the shop already has — and save it wherever
     * the owner says. Returns the path it was written to, so the screen can tell them where it went, or
     * NULL if they closed the save dialog.
     *
     * This is an EXPORT, and it keeps working on an expired licence. A shop that cannot get its own
     * catalogue out of the app is a shop we have taken hostage. (CLAUDE.md §6)
     */
    downloadTemplate: () => Promise<Result<string | null>>

    /**
     * Pick the filled-in file and say WHAT WOULD HAPPEN. WRITES NOTHING — not one row, not one lookup.
     * NULL = they closed the file picker.
     *
     * `errors` is every problem in the whole file, not just the first: the owner has one spreadsheet
     * open, and being told about one broken cell at a time is how people give up and type 900 rows in
     * by hand instead. If it is non-empty, the import is refused — and refused again by MAIN even if
     * the screen offers the button anyway.
     */
    previewImport: () => Promise<Result<ImportPreview | null>>

    /**
     * DO IT — using the file they just previewed, so they do not have to find it twice.
     *
     * OWNER ONLY, and one transaction: every item, every customer, every supplier and the whole draft,
     * or none of it. A half-imported shop — some items in, some not, stock that does not match the
     * ledger — is worse than no import at all, because nobody can tell which half is real.
     *
     * IT DOES NOT COMMIT THE OPENING BALANCES. It fills in the draft. The owner reviews it and presses
     * Commit himself — that door is still ahead of him, and it only opens once.
     *
     * NULL = there was no previewed file and they closed the file picker.
     */
    applyImport: () => Promise<Result<ImportResult | null>>
  }

  /**
   * CUSTOMERS — minimal on purpose. The customer ledger, loyalty and per-customer pricing are Phase 7.
   * This exists now because opening udhaar has to be owed BY SOMEBODY.
   *
   * NOTE WHAT IS ABSENT: a balance. There is no field to type one into and no endpoint that writes
   * one. What a customer owes is DERIVED from the ledger, exactly as stock is derived from movements.
   * `creditLimit` is a different thing entirely: how much udhaar they are ALLOWED to run up.
   */
  customers: {
    /** Paginated. Searches name AND phone — two customers really are both called Muhammad Rashid. */
    list: (input: CustomerListInput) => Promise<Result<PagedResult<Customer>>>
    create: (input: CreateCustomerInput) => Promise<Result<Customer>>
    /** Send ONLY the fields the form edited. (Trap #18.) */
    update: (input: UpdateCustomerInput) => Promise<Result<Customer>>
  }
}
