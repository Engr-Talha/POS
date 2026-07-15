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
  ImportResult,
  ScanBarcodeInput,
  ScannedItem,
  CartAddLineInput,
  CartUpdateLineInput,
  CartRemoveLineInput,
  ListHeldInput,
  OutstandingCreditInput,
  OpenDrawerInput,
  PrintReceiptInput,
  ReturnableLinesInput,
  CompleteSaleResponse,
  PrintOutcome,
  DrawerOutcome,
  PrinterInfo,
  CustomerWithBalance,
  CustomerDeactivateInput,
  CustomerBalanceInput,
  UserListInput,
  CreateUserInput,
  UpdateUserInput,
  SetUserPasswordInput,
  SetUserPinInput,
  UserIdInput
} from './ipc'
import type {
  CompleteSaleInput,
  DiscardSaleInput,
  HoldSaleInput,
  ResumeSaleInput,
  SaleByInvoiceNoInput,
  SaleDetail,
  SaleGetInput,
  SaleLineInput,
  SaleListInput,
  SaleListItem,
  SaveQuoteInput,
  VoidSaleInput
} from './sales'
import type {
  CreateReturnInput,
  ListReturnsInput,
  GetReturnInput,
  ReturnDetail,
  ReturnableSale,
  ReturnListItem
} from './returns'
import type {
  CommitOpeningInput,
  CustomerGetInput,
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
  UpdateOpeningStockLineInput
} from './opening'
// The canonical Phase-7 customer contract. `list` / `get` still take the '@shared/opening' schemas
// above; everything that carries the new profile fields, the ledger and payments comes from here.
import type {
  Customer,
  CreateCustomerInput,
  UpdateCustomerInput,
  CustomerLedgerInput,
  CustomerLedgerPage,
  CustomerPayment,
  RecordCustomerPaymentInput
} from './customers'
import type {
  Shift,
  ShiftDetail,
  ShiftListItem,
  ZReport,
  CashMovement,
  OpenShiftInput,
  CloseShiftInput,
  CashMovementInput,
  ListShiftsInput,
  GetShiftInput
} from './shifts'
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
import type { AuditEntry, BackupResult, Lookup, User } from './types'
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
    /**
     * Paginated, searches name AND phone (two customers really are both called Muhammad Rashid).
     * Gated 'sale.create' in MAIN — NOT 'report.view' — because the TILL needs it: a credit (udhaar)
     * sale must name the customer, and a cashier who cannot list customers cannot take udhaar. Returns
     * plain customer records — no balance, no cost.
     */
    list: (input: CustomerListInput) => Promise<Result<PagedResult<Customer>>>
    /**
     * THE PHASE-7 CUSTOMERS SCREEN: every customer WITH their derived udhaar balance. Manager-gated
     * ('report.view') — this is the aging of the shop's receivables, not a till lookup. The balance is
     * computed only for the page's rows, never the whole table (assume 100k+ customers).
     */
    listWithBalances: (input: CustomerListInput) => Promise<Result<PagedResult<CustomerWithBalance>>>
    /** One customer record by id — the same fields as `list`, for resolving a `customerId`. */
    get: (input: CustomerGetInput) => Promise<Result<Customer>>
    create: (input: CreateCustomerInput) => Promise<Result<Customer>>
    /** Send ONLY the fields the form edited. (Trap #18.) */
    update: (input: UpdateCustomerInput) => Promise<Result<Customer>>
    /** Retire — never delete. Last year's credit sale still points at the row. */
    deactivate: (input: CustomerDeactivateInput) => Promise<Result<Customer>>
    /**
     * ONE PAGE of the running udhaar statement, OLDEST FIRST, with a running balance per row — it reads
     * like a bank statement. The page also carries the current derived `balance` and `creditLimit` for
     * the header. Correct whichever screen recorded a payment (CLAUDE.md trap #17).
     */
    ledger: (input: CustomerLedgerInput) => Promise<Result<CustomerLedgerPage>>
    /** What the customer owes RIGHT NOW — DERIVED on read (opening + credit sales − payments). */
    balance: (input: CustomerBalanceInput) => Promise<Result<number>>
    /**
     * Record an udhaar repayment. Posts DR Cash/Bank · CR Receivable in ONE transaction and audits WHO
     * took the money, WHEN. A split settlement (part cash, part cheque) is TWO calls, one per method.
     * Overpayment is allowed — the balance goes negative, the shop owes them. `userId` and `at` come
     * from MAIN, never the renderer.
     */
    recordPayment: (input: RecordCustomerPaymentInput) => Promise<Result<CustomerPayment>>
  }

  /**
   * USERS & ROLES — OWNER ONLY. Every method is gated 'user.manage' in MAIN; the UI hiding a button is
   * a courtesy, not a control (CLAUDE.md §4). A user is NEVER deleted — retired and restored — so last
   * year's sale keeps a name on it, and the shop must always keep one active owner (the service refuses
   * the write that would strand it). A password or PIN goes IN but NEVER comes back: the only thing the
   * renderer ever learns is whether a PIN is set (`User.hasPin`).
   */
  users: {
    /** Paginated. Shows active AND retired staff, so the owner can reactivate someone they re-hired. */
    list: (input: UserListInput) => Promise<Result<PagedResult<User>>>
    create: (input: CreateUserInput) => Promise<Result<User>>
    /** Send ONLY the fields the form edited (trap #18). The last active owner cannot be demoted. */
    update: (input: UpdateUserInput) => Promise<Result<User>>
    setPassword: (input: SetUserPasswordInput) => Promise<Result<User>>
    /** Set the counter quick-switch PIN, or clear it with `pin: null`. No two active staff share a PIN. */
    setPin: (input: SetUserPinInput) => Promise<Result<User>>
    /** Retire — never delete. The last active owner cannot be retired. */
    deactivate: (input: UserIdInput) => Promise<Result<User>>
    reactivate: (input: UserIdInput) => Promise<Result<User>>
  }

  /**
   * THE TILL. The busiest screen in the shop, and the one that must never make the cashier wait.
   *
   * ── THE RENDERER SENDS INTENT. MAIN DECIDES THE MONEY. ─────────────────────────────────────────
   *
   * Look at what a cart line CANNOT carry: `net`, `taxAmount`, `gross`, `unitCost`, `at`. Main resolves
   * the price from the catalog, the tax from the product, the cost from the weighted average and the
   * time from its own clock, and FREEZES all of them onto the sale line. If the renderer could post its
   * own totals, a tampered renderer could sell a Rs 200,000 television for Rs 1 behind a perfectly
   * balanced journal, and every report in the app would agree that it happened. (shared/sales.ts.)
   *
   * The two exceptions are deliberate, permissioned and audited: an OPEN ITEM (there is no catalog row
   * to read a price from — that is what an open item IS) and a PRICE OVERRIDE.
   *
   * ── THE CART LIVES IN THE SCREEN, NOT IN THE DATABASE. ─────────────────────────────────────────
   *
   * `scan`, `addLine`, `updateLine` and `removeLine` write NOTHING. The Sell screen holds the cart in
   * React state and rings it up in one `complete()` call. A cart that lived as rows would be a database
   * write per keystroke on the hot path.
   *
   * ── HOW TO SHOW THE RUNNING TOTAL, WITHOUT REINVENTING THE MONEY ───────────────────────────────
   *
   * Do NOT write new arithmetic. Each line's net/tax/gross comes from `computeLineTax()` in
   * shared/tax.ts — the SAME pure function main freezes the line with, so the two cannot drift. And the
   * grand total with a cart discount is not a new formula either; it is the invariant the sale service
   * is property-tested against:
   *
   *     grandTotal === SUM(line.gross, before the cart discount) − cartDiscount     — exact, to the paisa.
   *
   * `complete()` returns the authoritative frozen sale regardless, so the screen is only ever
   * *predicting* what main will do — and predicting it with main's own functions.
   */
  sales: {
    /**
     * THE HOT PATH. One indexed lookup — the same two B-tree seeks whether the shop has 100 items or
     * 100,000. Resolves product barcodes AND pack barcodes: scanning the carton returns the carton's
     * price and `qtyM: 24000`, because stock is measured in base units and always has been.
     *
     * An unknown barcode is `{ ok: true, data: null }` — NOT an error. A loyalty card swiped at the
     * till is an everyday event, and the cashier gets "not found", not a red box.
     *
     * A carton with NO SELLING PRICE is refused: it carries the supplier's barcode so a delivery can be
     * booked in, and ringing it up would give away a free carton. (CLAUDE.md §4, Selling.)
     */
    scan: (input: ScanBarcodeInput) => Promise<Result<ScannedItem | null>>

    /**
     * Add a line. Pure — cart in, cart out, nothing written.
     *
     * Scanning the same tin twice makes it qty 2 rather than two rows — UNLESS the line carries a
     * discount, an override, a batch or a serial, which are paperwork and must not be silently folded
     * together. That rule lives in main so the screen and the receipt cannot disagree about it.
     */
    addLine: (input: CartAddLineInput) => Promise<Result<SaleLineInput[]>>
    /** Change a line in place: quantity, discount, override, serials. Not WHAT it is — that is a re-scan. */
    updateLine: (input: CartUpdateLineInput) => Promise<Result<SaleLineInput[]>>
    removeLine: (input: CartRemoveLineInput) => Promise<Result<SaleLineInput[]>>

    /**
     * PARK THE CART — the customer went back for the milk, and the queue is moving.
     *
     * NO INVOICE NUMBER, no stock movement, no journal. Nothing has happened yet, and that is exactly
     * what keeps the numbering gapless: a number is drawn only on completion.
     */
    hold: (input: HoldSaleInput) => Promise<Result<SaleDetail>>
    /** A price the shop offered, which may never become a sale. Also takes no number. (PLAN.md §2.) */
    saveQuote: (input: SaveQuoteInput) => Promise<Result<SaleDetail>>
    /**
     * Pick a parked cart back up. It comes back as CART LINES, re-priced from the catalog when it is
     * rung up — a cart held before this morning's price change is sold at this morning's price.
     */
    resume: (input: ResumeSaleInput) => Promise<Result<SaleLineInput[]>>
    /** The hold tray. Parked carts, or quotations. */
    listHeld: (input: ListHeldInput) => Promise<Result<SaleListItem[]>>
    /** Throw a parked cart away. Only 'held' and 'quote' rows are ever deleted; history is not. */
    discard: (input: DiscardSaleInput) => Promise<Result<boolean>>

    /**
     * RING IT UP — and then print, and then open the drawer.
     *
     * The sale is COMMITTED before a single byte reaches the printer: number drawn, prices frozen,
     * stock moved, journal balanced, payments written — all of it in ONE transaction, or none of it.
     *
     * SO A PRINTER JAM CANNOT LOSE A SALE. If the receipt does not print, this still returns
     * `{ ok: true }` with `print.printed === false` and a sentence to show the cashier. Show them a
     * warning and a "Print again" button — never a red error box, because the money DID go through.
     */
    complete: (input: CompleteSaleInput) => Promise<Result<CompleteSaleResponse>>

    /**
     * CANCEL A COMPLETED SALE. Supervisor-only, enforced in MAIN.
     *
     * It REVERSES: a contra journal is posted and the stock goes back at the cost it left at. It does
     * NOT delete, and the sale KEEPS its invoice number forever. A book that renumbers itself around a
     * cancellation cannot be audited. The reason code is required by the database itself.
     */
    void: (input: VoidSaleInput) => Promise<Result<SaleDetail>>

    /** The sales list — paginated and indexed. Assume years of trading at 1000+ sales a day. */
    list: (input: SaleListInput) => Promise<Result<PagedResult<SaleListItem>>>
    get: (input: SaleGetInput) => Promise<Result<SaleDetail>>
    /** The returns desk's first move: the number printed on the receipt in the customer's hand. */
    getByInvoiceNo: (input: SaleByInvoiceNoInput) => Promise<Result<SaleDetail>>

    /**
     * What this customer already owes — read BEFORE taking a credit sale, so the cashier can see the
     * udhaar before adding to it. What happens when they are over their limit is the SETTING
     * `selling.creditLimit` (warn or block), enforced in MAIN.
     */
    outstandingCredit: (input: OutstandingCreditInput) => Promise<Result<number>>
  }

  /**
   * RETURNS — goods coming BACK, and the money that goes back with them.
   *
   * A return is the inverse of a sale and obeys the same disciplines. THE RENDERER SENDS INTENT, MAIN
   * DECIDES THE MONEY: a return line says WHICH sale line came back and HOW MANY — it does NOT say what
   * to refund. Main reads the FROZEN net/tax/cost off the original sale line, scales them to the returned
   * quantity, and freezes the result, so a tampered renderer cannot refund a Rs 200,000 television for
   * one rupee behind a balanced journal. The clock and the approver are MAIN's, never the renderer's.
   * (shared/returns.ts.)
   *
   * `create` is the ONLY write and is SUPERVISOR-ONLY ('sale.refund'), enforced in MAIN — the UI hiding
   * a button is a courtesy, not a control (CLAUDE.md §4). The three reads keep working on an expired
   * licence: an expired shop must still look a sale up, browse its returns and reprint a credit note. It
   * simply cannot refund a new one until it renews. (CLAUDE.md §6.)
   */
  returns: {
    /**
     * PROCESS A RETURN. Supervisor-only, enforced in MAIN. ONE transaction: the refund is frozen from
     * the original sale, the balanced journal posts, restocked lines come back at the cost they left at,
     * and it is audited with a reason code. Returns the frozen return, ready for the credit note.
     */
    create: (input: CreateReturnInput) => Promise<Result<ReturnDetail>>
    /**
     * THE RETURNS DESK'S FIRST MOVE: look a sale up — by its id, or by the invoice number printed on the
     * customer's receipt — and see, per line, what was sold, what has already come back, and what remains
     * returnable, with the frozen figures the picker needs to show what a refund is worth.
     */
    returnableLines: (input: ReturnableLinesInput) => Promise<Result<ReturnableSale>>
    /** The returns history — paginated and indexed. Manager-gated ('report.view'); assume years of trading. */
    list: (input: ListReturnsInput) => Promise<Result<PagedResult<ReturnListItem>>>
    /** One return, with its lines and a few joined labels — the return detail screen and the credit note. */
    get: (input: GetReturnInput) => Promise<Result<ReturnDetail>>
  }

  /**
   * THE PRINTER AND THE CASH DRAWER.
   *
   * `printReceipt` takes a SALE ID — never a receipt. Main reads the sale from the database and builds
   * the paper itself. A "print this ReceiptData" endpoint would let a tampered renderer print a receipt
   * for a sale that never happened, with any total it liked.
   *
   * Neither of these is blocked by an expired licence. Reprinting a receipt is an EXPORT, and opening
   * the till gets the shop its own cash out of its own box. Read-only mode stops NEW sales; it never
   * holds anything they already have hostage. (CLAUDE.md §6.)
   */
  printing: {
    /**
     * Print (or REPRINT) the receipt for a sale. A reprint is stamped DUPLICATE and is audit-logged —
     * "just print it again" is how one sale's receipt ends up in two customers' hands.
     *
     * `printed: false` is not an error. It means the paper did not come out; the sale is untouched.
     */
    printReceipt: (input: PrintReceiptInput) => Promise<Result<PrintOutcome>>

    /**
     * A NO-SALE DRAWER OPEN — opening the till with no sale behind it.
     *
     * A CLASSIC THEFT VECTOR, and treated as one: it needs the `drawer.no_sale` permission (supervisor),
     * it needs a reason code from the `no_sale_reason` list, and it is ALWAYS audit-logged with who,
     * when and why — whether or not the drawer physically opened.
     */
    openDrawer: (input: OpenDrawerInput) => Promise<Result<DrawerOutcome>>

    /** The printers the OS can see, for the Settings dropdown. Owner picks; nobody types a name. */
    listPrinters: () => Promise<Result<PrinterInfo[]>>
  }

  /**
   * SHIFTS & THE CASH DRAWER — the till's trading day.
   *
   * A shift is a drawer session: a cashier opens it with a starting float, rings the day's sales and
   * refunds through it, records the drawer events that are NOT sales (a no-sale pop, petty cash in or
   * out, a drop to the safe), and at close COUNTS the drawer against what the books say should be there.
   * The over/short is the single most watched number in a shop.
   *
   * THE RENDERER SENDS INTENT; MAIN DECIDES THE MONEY. No input carries `expectedCash` or `variance` —
   * those are DERIVED in main from the shift's own documents and FROZEN at close, exactly as a sale line
   * freezes its net/tax. The clock is main's too: nothing here is timestamped by a caller.
   *
   * PERMISSIONS, enforced in MAIN (this interface is not a security boundary — hiding a button is a
   * courtesy, not a control):
   *   open / close / cashMovement  'shift.manage' (cashier). Running the till is a cashier's job; the
   *                                 control is the audit log and the variance, not a block. WRITES.
   *   current                      'sale.create' (cashier). A LIGHT READ the Sell screen leans on to know
   *                                 whether a drawer is open before it rings anything up.
   *   list / get                   'shift.view' (manager). The shift history and a historical Z-report.
   * Only the writes are blocked on an expired licence; every read keeps working. (CLAUDE.md §6.)
   */
  shifts: {
    /** OPEN a shift with a starting float. Refused while one is already open — one drawer, one session. */
    open: (input: OpenShiftInput) => Promise<Result<Shift>>
    /**
     * CLOSE the open shift by handing main the physically COUNTED cash. Main computes expected + variance,
     * freezes them onto the row together, and returns the shift with its frozen Z-report. Over/short is
     * RECORDED, never posted to the ledger — a miscount must not silently adjust GL Cash.
     */
    close: (input: CloseShiftInput) => Promise<Result<{ shift: Shift; zReport: ZReport }>>
    /** The one open shift (no close time yet), or null. The Sell screen's read to know a drawer is open. */
    current: () => Promise<Result<Shift | null>>
    /**
     * Record a drawer event that is NOT a sale: a no-sale pop, cash in, cash out, or a drop to the safe.
     * Posts the balanced journal (NONE for a no-sale, which moves no money). A no-sale and a pay-out each
     * REQUIRE a reason code from the owner's own list — the two theft vectors — and all are audited.
     */
    cashMovement: (input: CashMovementInput) => Promise<Result<CashMovement>>
    /** The shifts list — paginated and indexed, newest first. Assume a shift a day for years. */
    list: (input: ListShiftsInput) => Promise<Result<PagedResult<ShiftListItem>>>
    /** ONE shift with its cash movements and its Z-report — the shift detail screen. */
    get: (input: GetShiftInput) => Promise<Result<ShiftDetail>>
  }
}
