import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type { PosApi } from '@shared/api'

/**
 * THE WHITELIST. This file is a security boundary, not a convenience layer.
 *
 * Every capability the renderer has is listed here, explicitly, one function at a time. There is no
 * generic `invoke(channel, args)` escape hatch — that would hand the renderer the entire IPC surface
 * and make this file decorative. If a screen needs something new, it gets added here on purpose.
 *
 * NOTHING from Node crosses this line: no fs, no path, no better-sqlite3, not even ipcRenderer.
 * The renderer gets plain functions that return plain data.
 */
const api: PosApi = {
  system: {
    getInfo: () => ipcRenderer.invoke(IPC.systemGetInfo),
    dbSelfCheck: () => ipcRenderer.invoke(IPC.systemDbSelfCheck)
  },

  updates: {
    check: () => ipcRenderer.invoke(IPC.updateCheck),

    onStatus: (callback) => {
      const listener = (_event: unknown, status: Parameters<typeof callback>[0]): void =>
        callback(status)
      ipcRenderer.on(IPC.updateStatus, listener)
      return () => ipcRenderer.removeListener(IPC.updateStatus, listener)
    }
  },

  app: {
    getState: () => ipcRenderer.invoke(IPC.appGetState)
  },

  license: {
    activate: (input) => ipcRenderer.invoke(IPC.licenseActivate, input)
  },

  auth: {
    createFirstOwner: (input) => ipcRenderer.invoke(IPC.authCreateFirstOwner, input),
    signIn: (input) => ipcRenderer.invoke(IPC.authSignIn, input),
    signInWithPin: (input) => ipcRenderer.invoke(IPC.authSignInWithPin, input),
    signOut: () => ipcRenderer.invoke(IPC.authSignOut)
  },

  backup: {
    run: () => ipcRenderer.invoke(IPC.backupRun),
    chooseFolder: () => ipcRenderer.invoke(IPC.backupChooseFolder),
    restore: (input) => ipcRenderer.invoke(IPC.backupRestore, input)
  },

  lookups: {
    list: (input) => ipcRenderer.invoke(IPC.lookupsList, input),
    add: (input) => ipcRenderer.invoke(IPC.lookupsAdd, input),
    update: (input) => ipcRenderer.invoke(IPC.lookupsUpdate, input),
    deactivate: (input) => ipcRenderer.invoke(IPC.lookupsDeactivate, input)
  },

  settings: {
    getAll: () => ipcRenderer.invoke(IPC.settingsGetAll),
    set: (input) => ipcRenderer.invoke(IPC.settingsSet, input)
  },

  ledger: {
    trialBalance: () => ipcRenderer.invoke(IPC.ledgerTrialBalance),
    accounts: () => ipcRenderer.invoke(IPC.accountsList)
  },

  audit: {
    list: (input) => ipcRenderer.invoke(IPC.auditList, input)
  },

  products: {
    list: (input) => ipcRenderer.invoke(IPC.productsList, input),
    get: (input) => ipcRenderer.invoke(IPC.productsGet, input),
    create: (input) => ipcRenderer.invoke(IPC.productsCreate, input),
    update: (input) => ipcRenderer.invoke(IPC.productsUpdate, input),
    deactivate: (input) => ipcRenderer.invoke(IPC.productsDeactivate, input),
    createVariantGroup: (input) => ipcRenderer.invoke(IPC.productsCreateVariantGroup, input),
    listVariants: (input) => ipcRenderer.invoke(IPC.productsListVariants, input)
  },

  // Every one of these is a READ of a figure derived from stock_movements — except `adjust`, which
  // is the only way anything in this app moves stock at all. There is no `setStock`, deliberately.
  stock: {
    levels: (input) => ipcRenderer.invoke(IPC.stockLevels, input),
    level: (input) => ipcRenderer.invoke(IPC.stockLevel, input),
    movements: (input) => ipcRenderer.invoke(IPC.stockMovements, input),
    lowStock: (input) => ipcRenderer.invoke(IPC.stockLowStock, input),
    nearExpiry: (input) => ipcRenderer.invoke(IPC.stockNearExpiry, input),
    adjust: (input) => ipcRenderer.invoke(IPC.stockAdjust, input)
  },

  catalog: {
    findByBarcode: (input) => ipcRenderer.invoke(IPC.catalogFindByBarcode, input),
    listBarcodes: (input) => ipcRenderer.invoke(IPC.catalogListBarcodes, input),
    addBarcode: (input) => ipcRenderer.invoke(IPC.catalogAddBarcode, input),
    replaceBarcode: (input) => ipcRenderer.invoke(IPC.catalogReplaceBarcode, input),
    barcodeReplacements: (input) => ipcRenderer.invoke(IPC.catalogBarcodeReplacements, input),

    listPacks: (input) => ipcRenderer.invoke(IPC.catalogListPacks, input),
    savePack: (input) => ipcRenderer.invoke(IPC.catalogSavePack, input),
    deletePack: (input) => ipcRenderer.invoke(IPC.catalogDeletePack, input),

    listProductSuppliers: (input) => ipcRenderer.invoke(IPC.catalogListProductSuppliers, input),
    linkSupplier: (input) => ipcRenderer.invoke(IPC.catalogLinkSupplier, input),
    unlinkSupplier: (input) => ipcRenderer.invoke(IPC.catalogUnlinkSupplier, input),

    listBatches: (input) => ipcRenderer.invoke(IPC.catalogListBatches, input),
    addBatch: (input) => ipcRenderer.invoke(IPC.catalogAddBatch, input)
  },

  // THE OPENING SETUP — what the shop already had on day one. Every write here is OWNER ONLY, and that
  // is enforced in MAIN, not by this file and not by the screen. `commit` posts the shop's entire
  // day-one balance sheet into the ledger in one transaction, and it only ever runs once.
  opening: {
    getSummary: () => ipcRenderer.invoke(IPC.openingGetSummary),
    setCashAndBank: (input) => ipcRenderer.invoke(IPC.openingSetCashAndBank, input),

    listStockLines: (input) => ipcRenderer.invoke(IPC.openingListStockLines, input),
    addStockLine: (input) => ipcRenderer.invoke(IPC.openingAddStockLine, input),
    updateStockLine: (input) => ipcRenderer.invoke(IPC.openingUpdateStockLine, input),
    removeStockLine: (input) => ipcRenderer.invoke(IPC.openingRemoveStockLine, input),

    listReceivables: (input) => ipcRenderer.invoke(IPC.openingListReceivables, input),
    addReceivable: (input) => ipcRenderer.invoke(IPC.openingAddReceivable, input),
    updateReceivable: (input) => ipcRenderer.invoke(IPC.openingUpdateReceivable, input),
    removeReceivable: (input) => ipcRenderer.invoke(IPC.openingRemoveReceivable, input),

    listPayables: (input) => ipcRenderer.invoke(IPC.openingListPayables, input),
    addPayable: (input) => ipcRenderer.invoke(IPC.openingAddPayable, input),
    updatePayable: (input) => ipcRenderer.invoke(IPC.openingUpdatePayable, input),
    removePayable: (input) => ipcRenderer.invoke(IPC.openingRemovePayable, input),

    commit: (input) => ipcRenderer.invoke(IPC.openingCommit, input),

    // THE EXCEL IMPORT. Look at what these three do NOT take: a file path. The renderer cannot name a
    // file, because it has no filesystem to name one on — main opens the dialog, main reads the bytes,
    // and main remembers which file the owner picked. The screen only ever says "the one he chose".
    downloadTemplate: () => ipcRenderer.invoke(IPC.openingDownloadTemplate),
    previewImport: () => ipcRenderer.invoke(IPC.openingPreviewImport),
    applyImport: () => ipcRenderer.invoke(IPC.openingApplyImport)
  },

  // Note what is NOT here: any way to set what a customer owes. That figure is DERIVED from the ledger,
  // exactly as stock is derived from movements — `balance`, `listWithBalances` and `ledger` recompute it
  // on read, they never write it. `creditLimit` is a limit, not a balance. `recordPayment` posts a
  // repayment (DR cash/bank, CR receivable) — it lowers the derived balance, it does not set it.
  customers: {
    list: (input) => ipcRenderer.invoke(IPC.customersList, input),
    listWithBalances: (input) => ipcRenderer.invoke(IPC.customersListWithBalances, input),
    get: (input) => ipcRenderer.invoke(IPC.customersGet, input),
    create: (input) => ipcRenderer.invoke(IPC.customersCreate, input),
    update: (input) => ipcRenderer.invoke(IPC.customersUpdate, input),
    deactivate: (input) => ipcRenderer.invoke(IPC.customersDeactivate, input),
    ledger: (input) => ipcRenderer.invoke(IPC.customersLedger, input),
    balance: (input) => ipcRenderer.invoke(IPC.customersBalance, input),
    recordPayment: (input) => ipcRenderer.invoke(IPC.customersRecordPayment, input)
  },

  // BUYING — the mirror of customers + selling. A supplier is OWED BY the shop; a purchase brings stock
  // IN at a real landed cost. Note what is NOT here: any way to SET what the shop owes. That figure is
  // DERIVED from the ledger (opening payable + purchase payables − payments) — `balance`,
  // `listWithBalances` and `ledger` recompute it on read; `recordPayment` posts a payable paid down (DR
  // Payable, CR Cash/Bank), lowering the derived balance, never setting it. Permissions are enforced in
  // MAIN, not by this file: 'supplier.manage' / 'purchase.manage' / 'supplier.pay' for the writes.
  suppliers: {
    list: (input) => ipcRenderer.invoke(IPC.supplierList, input),
    get: (input) => ipcRenderer.invoke(IPC.supplierGet, input),
    create: (input) => ipcRenderer.invoke(IPC.supplierCreate, input),
    update: (input) => ipcRenderer.invoke(IPC.supplierUpdate, input),
    deactivate: (input) => ipcRenderer.invoke(IPC.supplierDeactivate, input)
  },

  // A purchase (goods-received note). The renderer says WHAT was received, HOW MANY and at WHAT COST;
  // MAIN freezes each line's value from the stock movement it creates, computes the payable and posts one
  // balanced journal. `create` is the only write. A renderer that could post its own totals could book a
  // truckload of stock in for one rupee behind a perfectly balanced journal.
  purchases: {
    create: (input) => ipcRenderer.invoke(IPC.purchaseCreate, input),
    list: (input) => ipcRenderer.invoke(IPC.purchaseList, input),
    get: (input) => ipcRenderer.invoke(IPC.purchaseGet, input)
  },

  // Goods going BACK to the supplier, and the credit that follows. `create` sends only WHICH purchase
  // line and HOW MANY — never a cost or a total: main copies the purchase line's frozen unit_cost and
  // decides every figure. The actor and the clock are MAIN's too.
  purchaseReturns: {
    create: (input) => ipcRenderer.invoke(IPC.purchaseReturnCreate, input),
    returnableLines: (input) => ipcRenderer.invoke(IPC.purchaseReturnReturnableLines, input),
    list: (input) => ipcRenderer.invoke(IPC.purchaseReturnList, input),
    get: (input) => ipcRenderer.invoke(IPC.purchaseReturnGet, input)
  },

  // The running account the shop keeps WITH each supplier, and the dues it pays back. `recordPayment`'s
  // userId and timestamp come from MAIN's session and clock — never the renderer.
  supplierLedger: {
    balance: (input) => ipcRenderer.invoke(IPC.supplierLedgerBalance, input),
    ledger: (input) => ipcRenderer.invoke(IPC.supplierLedgerLedger, input),
    listWithBalances: (input) => ipcRenderer.invoke(IPC.supplierLedgerListWithBalances, input),
    recordPayment: (input) => ipcRenderer.invoke(IPC.supplierLedgerRecordPayment, input),
    getPayment: (input) => ipcRenderer.invoke(IPC.supplierLedgerGetPayment, input)
  },

  // USERS & ROLES — OWNER ONLY, enforced in MAIN (this whitelist is a security boundary, but not THE
  // one — the 'user.manage' gate lives in the handler). A password or PIN goes IN but never comes back;
  // the renderer only ever learns whether a PIN is set (User.hasPin). A user is retired, never deleted.
  users: {
    list: (input) => ipcRenderer.invoke(IPC.usersList, input),
    create: (input) => ipcRenderer.invoke(IPC.usersCreate, input),
    update: (input) => ipcRenderer.invoke(IPC.usersUpdate, input),
    setPassword: (input) => ipcRenderer.invoke(IPC.usersSetPassword, input),
    setPin: (input) => ipcRenderer.invoke(IPC.usersSetPin, input),
    deactivate: (input) => ipcRenderer.invoke(IPC.usersDeactivate, input),
    reactivate: (input) => ipcRenderer.invoke(IPC.usersReactivate, input)
  },

  // THE TILL. Look at what a cart line CANNOT carry across this line: net, taxAmount, gross, unitCost,
  // or a timestamp. The renderer says WHAT was scanned and HOW MANY; MAIN decides what it costs, what
  // tax it bears, what it cost the shop, and when it happened. A renderer that could post its own
  // totals could sell a television for one rupee behind a perfectly balanced journal.
  //
  // `scan`, `addLine`, `updateLine` and `removeLine` write nothing — the cart lives in the screen.
  // `complete` is the one that draws the invoice number, moves the stock and posts the journal.
  sales: {
    scan: (input) => ipcRenderer.invoke(IPC.saleScan, input),

    addLine: (input) => ipcRenderer.invoke(IPC.saleAddLine, input),
    updateLine: (input) => ipcRenderer.invoke(IPC.saleUpdateLine, input),
    removeLine: (input) => ipcRenderer.invoke(IPC.saleRemoveLine, input),

    hold: (input) => ipcRenderer.invoke(IPC.saleHold, input),
    saveQuote: (input) => ipcRenderer.invoke(IPC.saleSaveQuote, input),
    resume: (input) => ipcRenderer.invoke(IPC.saleResume, input),
    listHeld: (input) => ipcRenderer.invoke(IPC.saleListHeld, input),
    discard: (input) => ipcRenderer.invoke(IPC.saleDiscard, input),

    complete: (input) => ipcRenderer.invoke(IPC.saleComplete, input),
    void: (input) => ipcRenderer.invoke(IPC.saleVoid, input),

    list: (input) => ipcRenderer.invoke(IPC.saleList, input),
    get: (input) => ipcRenderer.invoke(IPC.saleGet, input),
    getByInvoiceNo: (input) => ipcRenderer.invoke(IPC.saleGetByInvoiceNo, input),
    outstandingCredit: (input) => ipcRenderer.invoke(IPC.saleOutstandingCredit, input),
    quotation: (input) => ipcRenderer.invoke(IPC.saleQuotation, input)
  },

  // RETURNS — the inverse of a sale. Look at what a return line CANNOT carry across this line: net,
  // taxAmount, gross, unitCost, a timestamp, or who approved it. The renderer says WHICH sale line came
  // back and HOW MANY; MAIN reads the frozen figures off the original sale, decides the refund, stamps
  // the clock and derives the approver. `create` is the only write, and it is supervisor-gated in MAIN.
  returns: {
    create: (input) => ipcRenderer.invoke(IPC.returnsCreate, input),
    returnableLines: (input) => ipcRenderer.invoke(IPC.returnsReturnableLines, input),
    list: (input) => ipcRenderer.invoke(IPC.returnsList, input),
    get: (input) => ipcRenderer.invoke(IPC.returnsGet, input)
  },

  // The printer and the cash drawer. `printReceipt` and `printQuotation` BOTH take a SALE ID — the
  // renderer cannot hand main a document to print, because a renderer that could would be able to print
  // a receipt for a sale that never happened, or an "offer" at prices the shop never gave. Main reads the
  // row from the database and builds the paper itself. They are two channels because they are two
  // documents: main refuses to print a quote as a receipt, or a completed sale as an offer.
  printing: {
    printReceipt: (input) => ipcRenderer.invoke(IPC.printReceipt, input),
    printQuotation: (input) => ipcRenderer.invoke(IPC.printQuotation, input),
    openDrawer: (input) => ipcRenderer.invoke(IPC.printOpenDrawer, input),
    listPrinters: () => ipcRenderer.invoke(IPC.printListPrinters)
  },

  // SHIFTS & THE CASH DRAWER — the till's trading day. Open with a float, record the drawer events that
  // are NOT sales (a no-sale, cash in/out, a drop to the safe), and COUNT the drawer at close. The
  // renderer sends INTENT; MAIN derives `expectedCash`/`variance` and freezes them — no total crosses
  // this line. `current` is the light read the Sell screen leans on to know a drawer is open; `open`,
  // `close` and `cashMovement` are the writes; `list`/`get` are the manager-gated reports. Every
  // permission is enforced in MAIN — this whitelist is a boundary, not the security check.
  shifts: {
    open: (input) => ipcRenderer.invoke(IPC.shiftsOpen, input),
    close: (input) => ipcRenderer.invoke(IPC.shiftsClose, input),
    current: () => ipcRenderer.invoke(IPC.shiftsCurrent),
    cashMovement: (input) => ipcRenderer.invoke(IPC.shiftsCashMovement, input),
    list: (input) => ipcRenderer.invoke(IPC.shiftsList, input),
    get: (input) => ipcRenderer.invoke(IPC.shiftsGet, input)
  },

  // REPORTS — read on screen, or export to Excel / PDF. All three are READS/EXPORTS gated 'report.view'
  // in MAIN and never blocked by an expired licence (CLAUDE.md §6). `get` returns the tagged report data
  // ({ kind, data }); `exportExcel` / `exportPdf` return the saved file path, or null if the owner closed
  // the save dialog. The renderer passes only { kind, params } and NEVER a file path — MAIN owns the
  // filesystem: it opens the save dialog, writes the bytes and reports back where they went.
  reports: {
    get: (params) => ipcRenderer.invoke(IPC.reportsGet, params),
    exportExcel: (params) => ipcRenderer.invoke(IPC.reportsExportExcel, params),
    exportPdf: (params) => ipcRenderer.invoke(IPC.reportsExportPdf, params)
  },

  // EXPENSES — money going OUT on the non-stock cost of running the shop (rent, wages, bills, transport,
  // repairs). The renderer says WHAT it was for and HOW it was paid; MAIN maps those to ledger accounts,
  // stamps the actor from the session, and posts one balanced journal. `create` is the only write (gated
  // 'expense.manage' + assertWritable() in MAIN, not by this whitelist); `list` and `get` are reads.
  expenses: {
    create: (input) => ipcRenderer.invoke(IPC.expenseCreate, input),
    list: (input) => ipcRenderer.invoke(IPC.expenseList, input),
    get: (input) => ipcRenderer.invoke(IPC.expenseGet, input)
  },

  // LOYALTY POINTS — what the shop owes its regulars. NO earn and NO redeem here, on purpose: points are
  // earned BY a sale and spent as a TENDER on one, so both ride inside `sale:complete` and land in that
  // sale's ONE transaction. `balance` and `history` are reads; `adjust` is the owner's hand correction
  // (gated 'loyalty.adjust' + assertWritable() in MAIN, not by this whitelist).
  loyalty: {
    balance: (input) => ipcRenderer.invoke(IPC.loyaltyBalance, input),
    history: (input) => ipcRenderer.invoke(IPC.loyaltyHistory, input),
    adjust: (input) => ipcRenderer.invoke(IPC.loyaltyAdjust, input)
  }
}

contextBridge.exposeInMainWorld('pos', api)
