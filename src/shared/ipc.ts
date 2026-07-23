import { z } from 'zod'
import type { ItemType, StockMovement } from './catalog'
import type { OpeningSummary } from './opening'
import { PRICE_TIERS, SaleLineInput, type SaleDetail } from './sales'
import type { TaxMode } from './tax'
import { ROLES } from './rbac'
import type { Customer } from './customers'

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
  /** The Sell screen's typeahead. Gated at `catalog.search` (cashier) — see rbac.ts. */
  productsSearch: 'products:search',
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

  // ── Catalog: the product↔supplier LINK (the "Multiple Suppliers" panel) ─────
  // The supplier RECORD's own create/update/get/list are the canonical `supplier:*` channels below —
  // there is no `catalog:*Supplier` CRUD any more. These three are ONLY the product↔supplier link.
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

  // ── The ANYTIME product importer — bulk add/reprice the CATALOGUE on any day ──
  // A DIFFERENT importer from the opening trio above: it touches ONLY products and their lookups, never
  // posts a journal, never moves stock, never writes cost — so it is NOT frozen by a first sale. Owned
  // by a MANAGER ('product.manage'), not the owner, because it is a catalogue action. Same file-in-main
  // discipline as the opening trio: the renderer never names a file. Template + preview are READS and
  // stay open on an expired licence; only apply writes. (CLAUDE.md §3, §6)
  productImportTemplate: 'productImport:template',
  productImportPreview: 'productImport:preview',
  productImportApply: 'productImport:apply',

  // ── In-house barcodes + peel-and-stick labels ───────────────────────────────
  // Generate a valid EAN-13 for a loose item that carries none, and print a label sheet. Generation is
  // a catalogue WRITE ('product.manage' + assertWritable). Printing labels is an EXPORT — like a report
  // PDF, it stays open on an expired licence (CLAUDE.md §6): no assertWritable. The renderer names WHICH
  // items and how many copies; MAIN reads the barcode, the price and the label layout from settings.
  barcodeGenerate: 'barcode:generate',
  barcodeGenerateMissing: 'barcode:generateMissing',
  labelPrint: 'label:print',

  // ── Customers & the udhaar ledger (Phase 7) ────────────────────────────────
  // What a customer OWES is DERIVED from the ledger (opening + credit sales − payments), never stored,
  // exactly as stock is derived from movements. There is no channel that writes a balance, and there
  // never will be: `balance`, `listWithBalances` and `ledger` all recompute on read (CLAUDE.md trap #17).
  customersList: 'customers:list',
  customersListWithBalances: 'customers:listWithBalances',
  customersGet: 'customers:get',
  customersCreate: 'customers:create',
  customersUpdate: 'customers:update',
  customersDeactivate: 'customers:deactivate',
  customersLedger: 'customers:ledger',
  customersBalance: 'customers:balance',
  customersRecordPayment: 'customers:recordPayment',

  // ── Buying — suppliers, purchases (goods-received notes), the supplier ledger ─
  //
  // The mirror of customers + selling, pointing the other way: a supplier is OWED BY the shop where a
  // customer OWES it. WHAT THE SHOP OWES IS DERIVED, never stored (opening payable + Σ purchase payables
  // − Σ supplier_payments), and reconciles to the paisa with GL Accounts Payable — there is no channel
  // that writes a balance. The input schemas + row types live in '@shared/suppliers' and
  // '@shared/purchases' and are used verbatim by the handlers.
  //
  // Writes are 'supplier.manage' / 'purchase.manage' / 'supplier.pay'; reads 'supplier.view' /
  // 'purchase.view' (rbac.ts — the Manager owns products and purchases). Only the writes take
  // assertWritable() in MAIN; the reads keep working on an expired licence — a shop can still list its
  // suppliers, read a statement and export what it owes. (CLAUDE.md §6)
  supplierCreate: 'supplier:create',
  supplierUpdate: 'supplier:update',
  supplierDeactivate: 'supplier:deactivate',
  supplierGet: 'supplier:get',
  supplierList: 'supplier:list',

  purchaseCreate: 'purchase:create',
  purchaseList: 'purchase:list',
  purchaseGet: 'purchase:get',

  /**
   * PRINT OR SAVE THE A4 INVOICE FOR A PURCHASE — a full-page, letterhead invoice for a goods-received
   * note. A SALE prints its A4 invoice through the existing `saleComplete`/`printReceipt` path, switched
   * by `invoice.printFormat`; a purchase never printed at all before, so it gets its own channel.
   *
   * IT TAKES A PURCHASE ID, never a document — main reads the purchase from the database and builds the
   * paper from the frozen line totals, exactly as `printReceipt` reads a sale. `mode` is 'print' (to a
   * printer) or 'pdf' (main opens a save dialog and writes the PDF, for a shop with no A4 printer).
   *
   * An EXPORT: 'purchase.view', NO assertWritable() — printing/saving a bill you already received works
   * on an expired licence, the same as a report PDF. (CLAUDE.md §6.)
   */
  purchasePrintInvoice: 'purchase:printInvoice',

  // CANCEL A WRONGLY-KEYED BILL — `sales.voidSale` pointing the other way. The stock comes back OFF at
  // the cost it came ON at, the journal is contra-posted by mirroring the original's own lines, and the
  // document is MARKED, never deleted — it keeps its number and every line so the books can still
  // explain themselves. A WRITE: 'purchase.void' (a manager's) + assertWritable() in MAIN. The service
  // refuses a paid bill, one with supplier returns against it, an already-cancelled one and a locked
  // month — each with a sentence the shopkeeper can act on.
  purchaseVoid: 'purchase:void',

  // ── RETURNS TO SUPPLIER — goods going BACK, and the credit that follows ──────
  //
  // The mirror of `returns:*`, pointing the other way: a customer return takes stock IN and pays money
  // OUT; this sends stock BACK OUT and either lowers what the shop OWES ('supplier_credit' → DR Payable)
  // or brings a refund IN ('refund' → DR Cash/Bank). THE RENDERER SENDS INTENT, MAIN DECIDES THE MONEY:
  // a line says WHICH purchase line the goods came in on and HOW MANY go back — never what they are
  // worth. Main copies the purchase line's FROZEN 4-dp unit_cost, records the negative movement at THAT
  // cost and reads the movement's own frozen value back as the line total, so a tampered renderer cannot
  // send Rs 60 of tins back for a Rs 5,000 credit behind a balanced journal.
  //
  // `create` is the only WRITE — 'purchaseReturn.manage' (a manager's job, like the purchase it reverses)
  // plus assertWritable(). The three reads take 'purchase.view' and NOT assertWritable(): an expired shop
  // must still look a bill up and browse what it sent back. (CLAUDE.md §4, §6.)
  purchaseReturnCreate: 'purchaseReturn:create',
  purchaseReturnReturnableLines: 'purchaseReturn:returnableLines',
  purchaseReturnList: 'purchaseReturn:list',
  purchaseReturnGet: 'purchaseReturn:get',

  supplierLedgerBalance: 'supplierLedger:balance',
  supplierLedgerLedger: 'supplierLedger:ledger',
  supplierLedgerListWithBalances: 'supplierLedger:listWithBalances',
  supplierLedgerRecordPayment: 'supplierLedger:recordPayment',
  supplierLedgerGetPayment: 'supplierLedger:getPayment',

  // ── Users & roles — OWNER ONLY ('user.manage'), enforced in MAIN ────────────
  // Managing staff is the shop's keys: who may sell, void, override a price. A user is NEVER deleted
  // (last year's sale carries their name) — they are retired and restored. The shop must always keep an
  // active owner; the service refuses the write that would strand it. A password/PIN goes in, never out.
  usersList: 'users:list',
  usersCreate: 'users:create',
  usersUpdate: 'users:update',
  usersSetPassword: 'users:setPassword',
  usersSetPin: 'users:setPin',
  usersDeactivate: 'users:deactivate',
  usersReactivate: 'users:reactivate',

  // ── SELLING — the till ─────────────────────────────────────────────────────
  //
  // THE CART IS NOT IN THE DATABASE. `scan`, `addLine`, `updateLine` and `removeLine` do not write a
  // single row: the Sell screen holds the cart in memory and rings it up in ONE call. A cart that
  // lived as rows would mean a database write per keystroke on the busiest screen in the shop.
  //
  // So why are the cart operations here at all, rather than done in the renderer? Because
  // `addLine` carries a BUSINESS RULE — scanning the same tin twice bumps the quantity to 2 rather
  // than stacking a second row, *unless* the line carries a discount, an override, a batch or a
  // serial, which are paperwork that must not be silently folded together. That rule belongs in one
  // place. Re-implementing it in the renderer is how the screen and the receipt start to disagree.
  //
  // A cart that must SURVIVE (the customer went back for the milk) is a different thing: it is HELD.
  saleScan: 'sale:scan',
  saleAddLine: 'sale:addLine',
  saleUpdateLine: 'sale:updateLine',
  saleRemoveLine: 'sale:removeLine',

  saleHold: 'sale:hold',
  saleSaveQuote: 'sale:saveQuote',
  saleResume: 'sale:resume',
  /** The lines of a VOIDED sale, ready to re-ring as a corrected invoice. See services/sales.correctionLines. */
  saleCorrectionLines: 'sale:correctionLines',
  saleListHeld: 'sale:listHeld',
  saleDiscard: 'sale:discard',

  /** THE ONE THAT MATTERS. Number drawn, prices frozen, stock moved, journal posted — or none of it. */
  saleComplete: 'sale:complete',
  saleVoid: 'sale:void',

  saleList: 'sale:list',
  saleGet: 'sale:get',
  saleGetByInvoiceNo: 'sale:getByInvoiceNo',
  saleOutstandingCredit: 'sale:outstandingCredit',

  /**
   * THE OFFER, AS DATA — for a screen that wants to show a quote before it prints one.
   *
   * A READ. It draws no number, moves no stock and posts no journal, because a quote has done none of
   * those things. It REFUSES anything that is not a quote: a completed sale gets a RECEIPT, and printing
   * history as an "offer" with a validity date on money the shop has already banked says something
   * untrue. (services/sales.ts, quotationFor.)
   */
  saleQuotation: 'sale:quotation',

  // ── RETURNS — goods coming BACK, and the money that goes back with them ─────
  //
  // The inverse of a sale, and it obeys the same rules. THE RENDERER SENDS INTENT, MAIN DECIDES THE
  // MONEY: a return line says WHICH sale line came back and HOW MANY — never what to refund. Main reads
  // the FROZEN net/tax/cost off the original sale line and scales them, so a tampered renderer cannot
  // refund a television for one rupee behind a balanced journal. `create` is the only WRITE and is
  // SUPERVISOR-ONLY ('sale.refund'), enforced in MAIN; the three reads keep working on an expired
  // licence, because an expired shop must still look a sale up, browse its returns and reprint a credit
  // note. (CLAUDE.md §4, §6.)
  returnsCreate: 'returns:create',
  returnsReturnableLines: 'returns:returnableLines',
  returnsList: 'returns:list',
  returnsGet: 'returns:get',

  // ── PRINTING & THE CASH DRAWER ─────────────────────────────────────────────
  //
  // `printReceipt` takes a SALE ID, never a receipt. Main reads the sale from the database and builds
  // the paper itself. Handing the renderer a "print this ReceiptData" endpoint would let a tampered
  // renderer print a receipt for a sale that never happened, with any total it liked.
  printReceipt: 'printing:printReceipt',
  /**
   * THE QUOTATION, ON PAPER — a SALE ID in, exactly as printReceipt takes one, and for exactly the same
   * reason: main reads the quote from the database and builds the paper itself.
   *
   * A SEPARATE CHANNEL FROM printReceipt, not a flag on it. The two documents are two documents (see
   * printing/quotation.ts): a receipt is proof money changed hands, a quotation is an offer with nothing
   * paid. One channel behind an `isQuote` boolean is how a quote ends up printing as a receipt with a
   * blank invoice number, which is the exact bug this feature exists to close. Main refuses to print a
   * non-quote here, and refuses to print a quote as a receipt over there.
   *
   * No `isDuplicate`: re-printing an OFFER is not re-printing a receipt. There is no sale to double-count
   * and no money to claim twice, so there is nothing to stamp and nothing to audit.
   */
  printQuotation: 'printing:printQuotation',
  printOpenDrawer: 'printing:openDrawer',
  printListPrinters: 'printing:listPrinters',

  // ── SHIFTS & THE CASH DRAWER (Phase 6) ─────────────────────────────────────
  //
  // A shift is a drawer session: open with a float, ring the day through it, record the drawer events
  // that are NOT sales (a no-sale, a pay-in/out, a drop), and COUNT the till at close. THE RENDERER
  // SENDS INTENT; MAIN DECIDES THE MONEY — `expected_cash` and `variance` are DERIVED in main from the
  // shift's own documents and FROZEN at close, never sent by a caller. The input schemas and the row
  // types both live in '@shared/shifts' and are used verbatim by the handlers.
  //
  // open / close / cashMovement WRITE and are 'shift.manage' (a cashier's own gate — running the till is
  // a cashier's job; the control is the audit log and the Z-report variance, not a block). `current` is a
  // LIGHT READ the Sell screen leans on ('sale.create'): the till must know whether a drawer is open
  // before it rings anything up. list / get are MANAGER reads ('shift.view'). Only the three writes take
  // assertWritable() in MAIN; the reads keep working on an expired licence. (CLAUDE.md §6)
  shiftsOpen: 'shifts:open',
  shiftsClose: 'shifts:close',
  shiftsCurrent: 'shifts:current',
  shiftsCashMovement: 'shifts:cashMovement',
  shiftsList: 'shifts:list',
  shiftsGet: 'shifts:get',

  // ── REPORTS (Phase 8) — the payoff: read on screen, export to Excel / PDF ───
  //
  // A REPORT IS A READ, AND AN EXPORT IS AN EXPORT. All three are gated 'report.view' in MAIN and NONE
  // takes assertWritable(): an expired, read-only shop must still run every report and get its numbers
  // out as .xlsx / .pdf. Holding a shop's own figures hostage is the one thing read-only mode exists to
  // prevent (CLAUDE.md §6) — and "export your data" is exactly what it protects.
  //
  // The input is the discriminated `ReportRequest` ({ kind, ...that report's params }), validated in
  // MAIN. `get` returns the tagged report data for the screen. `exportExcel` / `exportPdf` build the
  // SAME report and then MAIN opens the save dialog, writes the file and returns the saved path (or null
  // if the owner closed the dialog). NEITHER export takes a path — the renderer has no filesystem to
  // name one on, exactly like the Excel-template export.
  reportsGet: 'reports:get',
  reportsExportExcel: 'reports:exportExcel',
  reportsExportPdf: 'reports:exportPdf',

  // ── EXPENSES (migration 0014) — the shop's money going OUT on the NON-STOCK cost of running the ──
  //
  // Rent, wages, bills, transport, repairs. A purchase brings stock IN and re-averages its cost; an
  // EXPENSE buys none — it is a running cost that lands straight in the Profit & Loss, paid NOW from
  // cash or bank as ONE balanced journal (DR the category's expense account, CR the tender). THE
  // RENDERER SENDS INTENT; MAIN DECIDES THE ACCOUNTS AND THE ACTOR: the input names WHAT it was for and
  // HOW it was paid (lookups ids the service re-validates), never a ledger account and never a userId.
  // The input schemas + row types live in '@shared/expenses' and are used verbatim by the handlers.
  //
  // create WRITES and is gated 'expense.manage' (manager) + assertWritable() in MAIN — an expired shop
  // cannot book a new expense until it renews. list / get are 'expense.view' (manager) READS and keep
  // working on an expired licence: it can still browse and export what it spent. (CLAUDE.md §6)
  expenseCreate: 'expense:create',
  expenseList: 'expense:list',
  expenseGet: 'expense:get',

  // ── LOYALTY POINTS (migration 0017) — what the shop OWES its regulars, in points ──────────────────
  //
  // A point is a PROMISE, and a promise is a LIABILITY (ACC.LOYALTY 2200) booked the moment it is
  // EARNED — never when it is redeemed. The balance is DERIVED: SUM(loyalty_movements.points), never a
  // `customers.points` column (CLAUDE.md §4, the same law as stock).
  //
  // EARNING AND REDEEMING ARE NOT HERE, AND THAT IS THE DESIGN. They are not free-standing acts a
  // renderer may ask for: points are earned BY a sale and spent as a TENDER ON one, so they ride inside
  // `sale:complete` (which sends `redeemPoints` — a POINT COUNT, never a rupee figure) and are written
  // inside that sale's ONE transaction. An endpoint that could mint or spend points on its own would be
  // a way to move a liability with no sale behind it.
  //
  // balance / history are READS gated 'loyalty.view' (cashier — the till must show what a customer has)
  // and take NO assertWritable(): an expired shop still reads its own books (CLAUDE.md §6). adjust is
  // the owner's hand correction — 'loyalty.adjust' (owner) + assertWritable(), a reason code from the
  // live lookups list, and audited by the service itself.
  loyaltyBalance: 'loyalty:balance',
  loyaltyHistory: 'loyalty:history',
  loyaltyAdjust: 'loyalty:adjust',

  // ── PROMOTIONS (migration 0018) — the shop's OWN offers, applied automatically at the till ────────
  //
  // "Buy 2 get 1 free", "10% off Sunday", "Rs 50 off tea". A PROMOTION IS A LINE DISCOUNT — it invents
  // no new money, no new journal leg and no new money column. The engine computes a discount, sales.ts
  // writes it into the `line_discount` that has existed since migration 0007, and it travels the road
  // already proven: priceCart re-resolves tax on what is ACTUALLY paid → DR Discounts Given (4200,
  // contra-income) → frozen onto the line, so a RETURN refunds what was really charged.
  //
  // THERE IS NO 'apply' HANDLER, AND THAT IS THE DESIGN — the same reasoning as loyalty's missing earn
  // and redeem. An offer is not a free-standing act a renderer may ask for: it is resolved inside
  // `sale:complete`, in MAIN, against the offers live at the sale's own instant, and frozen in that
  // sale's ONE transaction. A renderer that could name its own promotion discount could sell at any
  // price it liked (shared/promotions.ts).
  //
  // create / update / deactivate / setRules WRITE and are gated 'promotion.manage' (manager) +
  // assertWritable() — an offer is a standing decision to sell below the shelf price, so it is a
  // manager's call and every one of them is audited by the service itself. list / get / rules / active
  // are 'promotion.view' (cashier — the till must be able to say WHY a price changed) READS and take
  // NO assertWritable(): an expired shop still reads its own books (CLAUDE.md §6).
  promotionCreate: 'promotion:create',
  promotionUpdate: 'promotion:update',
  promotionDeactivate: 'promotion:deactivate',
  promotionSetRules: 'promotion:setRules',
  promotionList: 'promotion:list',
  promotionGet: 'promotion:get',
  promotionRules: 'promotion:rules',
  promotionActive: 'promotion:active',

  // WHICH OFFERS WOULD FIRE ON THIS CART, RIGHT NOW, AND WHAT THEY WOULD GIVE — so the Sell screen can
  // show "Sunday special −Rs 20" on the line and the cashier can tell the customer why the price
  // changed. A LOOK, NOT A SALE: it writes nothing, and `sale:complete` resolves the offers again for
  // itself at the instant the money is taken.
  //
  // It lives on the SALE side of this list, not the promotions side, because it prices a CART: it is
  // answered by the very same `priceCart` that freezes the sale, which is what stops the discount on the
  // screen and the discount on the receipt from ever drifting apart. Gated 'sale.create' — it is the
  // till's own question — and it takes no date: the clock is MAIN's.
  salePreviewPromotions: 'sale:previewPromotions',

  // ── CLOSING THE MONTH (the period lock) ───────────────────────────────────────────────────────────
  //
  // The lock itself is not new: `ledger.assertPeriodOpen` has been enforced on every journal since
  // migration 0002, and on every stock movement since. What was missing was a DOOR — no IPC, no screen,
  // so an owner could not actually close a month. These three are that door.
  //
  // Lock March and nothing new can be dated in March: no sale, no return, no purchase, no expense, no
  // stock adjustment. April is untouched. This is what stops last year's reported figures from quietly
  // changing after the accountant has signed them off.
  //
  // lock / unlock WRITE and are gated 'period.manage' (OWNER — CLAUDE.md §4 names the Owner for period
  // unlock) + assertWritable(), and BOTH are audited by the service. The unlock is the one that matters:
  // reopening a closed month is how books get quietly rewritten, and the log is the only thing that will
  // ever say who did it. `list` is a READ and takes NO assertWritable() — an expired shop still reads its
  // own books (CLAUDE.md §6).
  periodList: 'period:list',
  periodLock: 'period:lock',
  periodUnlock: 'period:unlock',

  // ── STOCK TAKE (migration 0019) — the counting sheet ──────────────────────────────────────────────
  //
  // The shop walks its shelves, writes down what is actually there, and the books are corrected to
  // match. THE DOCUMENT WRAPS THE ENGINE: `apply` calls `stock.adjust()` once per varying line — the
  // same engine the Stock screen's hand adjustment uses, which appends the movement, keeps the weighted
  // average honest and posts the balanced journal. There is no second path to stock, and no new
  // accounting (shared/stock-take.ts).
  //
  // A LINE CARRIES ONLY A PRODUCT AND A COUNT. It cannot send the expected figure, the variance, the
  // cost, a date or a user — MAIN reads what the books expect at that instant, freezes it, and derives
  // the counter from the session. A renderer that could name the expected figure could name its own
  // variance, which is to say it could hide a theft.
  //
  // The writes are gated 'stockTake.manage' (manager — a stock take is a batch of `stock.adjust`, which
  // is a manager's) + assertWritable(); `apply` is audited with the variance total against it, because a
  // big variance is a theft signal. list / get are 'stockTake.view' (supervisor) READS and take NO
  // assertWritable(): an expired shop still reads its own books.
  stockTakeCreate: 'stockTake:create',
  stockTakeSetCount: 'stockTake:setCount',
  stockTakeAddLines: 'stockTake:addLines',
  stockTakeRemoveLine: 'stockTake:removeLine',
  stockTakeMarkCounted: 'stockTake:markCounted',
  stockTakeApply: 'stockTake:apply',
  stockTakeCancel: 'stockTake:cancel',
  stockTakeList: 'stockTake:list',
  stockTakeGet: 'stockTake:get'
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

// ── In-house barcodes + labels ───────────────────────────────────────────────
/** Generate an EAN-13 for ONE loose item that has none. */
export const BarcodeGenerateInput = z.object({ productId: RowId })
/** Generate for every item without a barcode, or just the given ids. Empty/absent = all of them. */
export const BarcodeGenerateMissingInput = z.object({ productIds: z.array(RowId).optional() })
/** Which items to print labels for, and how many stickers of each. */
export const LabelPrintInput = z.object({
  items: z
    .array(z.object({ productId: RowId, copies: z.number().int().min(1).max(100) }))
    .min(1, 'Choose at least one item to print a label for.')
})
export type BarcodeGenerateInput = z.infer<typeof BarcodeGenerateInput>
export type BarcodeGenerateMissingInput = z.infer<typeof BarcodeGenerateMissingInput>
export type LabelPrintInput = z.infer<typeof LabelPrintInput>
export type BarcodeGenerateResult = { productId: number; barcode: string }
export type GenerateMissingResult = { generated: number; alreadyHad: number }
export type LabelPrintResult = { printedCount: number; skippedNoBarcode: string[]; path: string | null }

// SupplierGetInput ({ id }) is the canonical supplier read input and lives in '@shared/suppliers' —
// the `supplier:get` handler and the Suppliers screen import it from there. It is NOT redeclared here.

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

// ── The ANYTIME product importer — bulk add/reprice the CATALOGUE ─────────────
//
// A DIFFERENT importer from the opening one above. It touches ONLY the catalogue: it never posts a
// journal, never moves stock, never writes cost. So it is safe to run on a live, trading shop, and it
// carries NO balance-quantity and NO cost/supplier-price columns — a bulk sheet that wrote stock or
// cost would revalue the shelf with no journal behind it, and the GL and the stock report would drift
// silently (CLAUDE.md §4, §5). These shapes MIRROR services/product-import.ts; the handlers are
// annotated with them, so a service that drifts from this contract breaks the build here.

/** What happens to an existing product a row matches. The owner's per-import choice. Default 'skip'. */
export type OnExisting = 'skip' | 'update-prices'

/**
 * How one row was classified. Everything but 'error' also appears in the preview table.
 *   create        a new stock code — the item will be created.
 *   update        an existing item, in 'update-prices' mode, whose price differs.
 *   skip-exists   an existing item, in 'skip' mode — left completely untouched.
 *   skip-nochange an existing item, in 'update-prices' mode, whose prices already match the sheet.
 *   error         the row cannot be imported. The reason is in `errors`, by row number.
 */
export type ProductImportClassification =
  | 'create'
  | 'update'
  | 'skip-exists'
  | 'skip-nochange'
  | 'error'

/** One product row as it WOULD land. `retailPrice`/`wholesalePrice` are 2-dp money; blank = untouched. */
export type ProductImportRow = {
  row: number
  sku: string
  name: string
  /** Null = this stock code is new, and the item will be created. */
  productId: number | null
  classification: ProductImportClassification
  itemType: ItemType
  nameOtherLang: string | undefined
  sizeVolume: string | undefined
  lookupLabels: Partial<Record<ImportLookupList, string>>
  /** 2-dp money. Undefined = the cell was blank, so the item's price is left exactly as it is. */
  retailPrice: number | undefined
  wholesalePrice: number | undefined
  /** 3-dp qty. RE ORDER LEVEL. */
  minStockM: number | undefined
  barcodes: string[]
}

/**
 * WHAT WOULD HAPPEN. Nothing is written to produce it. `errors` MUST be empty or the import is refused
 * by MAIN. `fileName` is the NAME the owner picked — never a path. `onExisting` echoes the mode this
 * preview was computed under, so apply can refuse a mismatched mode and ask for a re-preview.
 */
export type ProductImportPreview = {
  fileName: string
  rows: ProductImportRow[]
  toCreate: number
  toUpdate: number
  toSkip: number
  lookupsToCreate: Record<ImportLookupList, string[]>
  onExisting: OnExisting
  errors: ImportError[]
}

/** What the product import actually did. No stock, no journal, no cost was touched to produce it. */
export type ProductImportResult = {
  created: number
  updated: number
  skipped: number
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

// ═════════════════════════════════════════════════════════════════════════════
// SELLING — the inputs that had no home in shared/sales.ts
// ═════════════════════════════════════════════════════════════════════════════
//
// Everything the sale handlers validate with — HoldSaleInput, CompleteSaleInput, VoidSaleInput,
// SaleListInput and the rest — is imported straight from '@shared/sales'. These are the leftovers:
// the scanner, the three cart transforms, and the two plain-id reads. An IPC input MUST be a schema;
// the renderer is not trusted, and neither is a future LAN client.

/**
 * THE SCANNER'S HOT PATH. A barcode, and which price column to read it at.
 *
 * `minLength` is deliberately NOT enforced here — `scanner.minLength` is a SETTING that stops a stray
 * keypress being read as a scan, and it belongs to the screen that owns the keyboard. Main's job is to
 * answer the question it was asked. An unknown barcode comes back as `null`, not as an error: a
 * loyalty card swiped at the till is a Tuesday, not a fault.
 */
export const ScanBarcodeInput = z.object({
  barcode: z.string().trim().min(1, 'Please scan or type a barcode.').max(64),
  /** Which price column. Switching off retail is gated on `selling.wholesaleTierRole` in MAIN. */
  tier: z.enum(PRICE_TIERS).optional(),
  /** Phase 7 seam: a per-customer agreed price would be read against this. */
  customerId: RowId.nullish()
})

/**
 * THE FIELDS OF A CART LINE A CASHIER MAY ACTUALLY CHANGE.
 *
 * Deliberately NOT `Partial<SaleLineInput>`. You cannot change WHAT a line is — swapping `productId`
 * on line 3 would leave the merge rule in `addLine` describing a line that no longer exists, and a
 * "changed" line is really a remove and an add. Quantity, discount, override and serials are the only
 * things a till ever edits in place.
 */
export const CartLineChanges = z.object({
  qtyM: z.number().int().positive('Please enter a quantity.').optional(),
  lineDiscount: z.number().int().min(0).optional(),
  discountReasonCode: z.string().trim().min(1).max(50).nullish(),
  priceOverride: z.number().int().min(0).nullish(),
  serials: z.array(z.string().trim().min(1).max(100)).optional()
})

/** The three cart transforms are PURE: cart in, cart out. No database, no clock, no row written. */
export const CartAddLineInput = z.object({
  cart: z.array(SaleLineInput),
  line: SaleLineInput
})

export const CartUpdateLineInput = z.object({
  cart: z.array(SaleLineInput),
  index: z.number().int().min(0),
  changes: CartLineChanges
})

export const CartRemoveLineInput = z.object({
  cart: z.array(SaleLineInput),
  index: z.number().int().min(0)
})

/** The hold tray on the Sell screen — parked carts, or quotations. */
export const ListHeldInput = z.object({
  status: z.enum(['held', 'quote']).default('held')
})

/** What this customer already owes. Read BEFORE a credit sale, so the cashier sees the udhaar. */
export const OutstandingCreditInput = z.object({ customerId: RowId })

/**
 * PRINT A COPY OF A SALE'S RECEIPT.
 *
 * NOTE WHAT IT DOES NOT TAKE: an `isDuplicate` flag. That is deliberate, and it is a security boundary.
 *
 * Every print the RENDERER can ask for is a REPRINT. It is stamped DUPLICATE and it is written to the
 * audit log — always, with no way to opt out. The service's `receiptFor()` only logs `sale.reprint`
 * when `isDuplicate` is true, so an endpoint that let the caller pass `false` would hand the renderer
 * unlimited un-stamped, UN-AUDITED copies of any receipt in the shop. A second un-stamped "original" is
 * indistinguishable from the customer's real one — which is exactly what someone returning goods
 * against a stranger's sale needs.
 *
 * The ONE un-stamped original in this app is printed by `sale:complete`, inside the same call that
 * created the sale. It cannot be replayed: asking for it again would mean ringing up another sale.
 */
export const PrintReceiptInput = z.object({ id: RowId })

/**
 * PRINT OR SAVE THE A4 INVOICE FOR A PURCHASE.
 *
 * A PURCHASE ID and a MODE, and nothing else: main reads the purchase from the database and builds the
 * paper from the frozen line totals, exactly as PrintReceiptInput does for a sale. `mode` picks the
 * printer ('print') or a save dialog that writes a PDF ('pdf') — for a shop with no A4 printer that
 * emails the invoice instead. On 'pdf' the outcome carries the saved path (null if the dialog was closed).
 */
export const PurchasePrintInvoiceInput = z.object({
  id: RowId,
  mode: z.enum(['print', 'pdf']).default('print')
})

/**
 * PRINT THE QUOTATION FOR A QUOTE — the offer, in the customer's hand.
 *
 * A SALE ID, and nothing else, for the same reason PrintReceiptInput takes one: main reads the document
 * out of the database and builds the paper itself. A "print this QuotationData" endpoint would let a
 * tampered renderer print any prices it liked on the shop's own paper and call it the shop's offer.
 *
 * NO `isDuplicate`, and unlike the receipt's that is not a security decision — there is simply nothing to
 * stamp. A reprinted OFFER is not a second receipt: no money has been taken, no number has been drawn,
 * and there is nothing to double-count. (See QuotationData in shared/sales.ts.)
 */
export const PrintQuotationInput = z.object({ id: RowId })

/**
 * OPENING THE TILL WITH NO SALE — a classic theft vector, and the reason this input exists at all.
 *
 * The reason code is REQUIRED, and MAIN checks it against the ACTIVE rows of the `no_sale_reason`
 * lookup list — never a hardcoded dropdown (CLAUDE.md §4). That list has no seeded rows yet (the
 * `cash_movements` table it belongs with is Phase 6), so on a fresh shop the owner adds its reasons in
 * Settings → Manage Lists like any other list. The generic lookups endpoints already serve it.
 */
export const OpenDrawerInput = z.object({
  /** lookups('no_sale_reason').code. */
  reasonCode: z.string().trim().min(1, 'Please choose a reason.').max(50),
  /** Free text on top of the code — "customer wanted change for a 5000 note". */
  reasonText: z.string().trim().max(500).nullish()
})

// ═════════════════════════════════════════════════════════════════════════════
// RETURNS — the one leftover input that had no home in shared/returns.ts
// ═════════════════════════════════════════════════════════════════════════════
//
// CreateReturnInput / ListReturnsInput / GetReturnInput are the canonical returns contract and live in
// '@shared/returns'; the handlers import those verbatim. This is the leftover: `returnableLines(db, ref)`
// takes a plain `number | string`, and an IPC input MUST be a schema — the renderer is not trusted, and
// neither is a future LAN client.

/**
 * THE RETURNS DESK'S FIRST MOVE — look a sale up to see what may still come back.
 *
 * `ref` is EITHER the internal sale id (a number) OR the invoice number printed on the customer's
 * receipt (a string). The service dispatches on the type exactly as it does today: a number is read as a
 * sale id, anything else as an invoice number — so "123" typed into the box finds invoice "123", never
 * sale-row 123. One field, mapped 1:1 to the service, so the handler stays a thin passthrough.
 */
export const ReturnableLinesInput = z.object({
  ref: z.union([
    RowId,
    z.string().trim().min(1, 'Please enter the sale or invoice number.').max(64)
  ])
})

// ═════════════════════════════════════════════════════════════════════════════
// RETURNS TO SUPPLIER — the same leftover, mirrored
// ═════════════════════════════════════════════════════════════════════════════
//
// CreatePurchaseReturnInput / ListPurchaseReturnsInput / GetPurchaseReturnInput are the canonical
// contract and live in '@shared/purchase-returns'; the handlers import those verbatim. This is the
// leftover, for the same reason as ReturnableLinesInput above: `returnablePurchaseLines(db, purchaseId)`
// takes a plain `number`, and an IPC input MUST be a schema — the renderer is not trusted, and neither
// is a future LAN client.

/**
 * THE RETURN-TO-SUPPLIER SCREEN'S FIRST MOVE — look a purchase up to see what may still go back.
 *
 * Only an id, no union: unlike a customer holding a receipt, this flow starts from the purchase the
 * manager already has open on screen. The supplier's own bill number is not unique across suppliers —
 * two distributors may both issue "INV-001" — so it is not a lookup key here.
 */
export const ReturnablePurchaseLinesInput = z.object({ purchaseId: RowId })

// ── What the scanner gives back ──────────────────────────────────────────────

/**
 * WHAT THE SELL SCREEN NEEDS THE INSTANT A BARCODE COMES IN.
 *
 * Mirrored from `services/sales.ts` because `shared/` cannot import from `main/`. The handler is
 * annotated with THIS type, so if the service's shape ever drifts the BUILD BREAKS here rather than
 * the till quietly showing a blank price. (Same device as StockAdjustResult.)
 *
 * READ THE SCALES. `unitPrice` is 2-dp MONEY (minor units); `qtyM` and `onHandM` are 3-dp QUANTITY
 * (thousandths). They are not interchangeable and mixing them is how a shop's books get falsified.
 */
export type ScannedItem = {
  productId: number
  name: string
  nameOtherLang: string | null
  /**
   * Set when a PACK barcode was scanned (a carton). Pass it straight back on the cart line — the
   * line is then priced at the CARTON's price and moves 24 PIECES of stock. That is the whole of
   * "buy in cartons, sell in pieces".
   */
  packId: number | null
  /** The pack's unit, for the cart chip: "Carton". Null for a plain item. */
  packLabel: string | null
  /** 3-dp qty of BASE units this ONE scan sells. A plain item: 1000. A carton of 24: 24000. */
  qtyM: number
  /** 2-dp money — the price of ONE of what was scanned (one piece, or one whole carton). */
  unitPrice: number
  taxRateBp: number
  taxMode: TaxMode
  /** Sold by weight — the Sell screen asks the scale, not the keyboard. */
  isWeighted: boolean
  /** ONLY a flagged item prompts for an IMEI. A tin of beans still scans in one keystroke. */
  trackSerials: boolean
  uom: string | null
  /**
   * A SERVICE OR A BAG CHARGE HAS NO SHELF, and `onHandM` is 0 for it — the same 0 a tin that has run
   * out reports. Without this field the Sell screen cannot tell those two apart, and it would warn
   * "not enough stock" on every delivery fee the shop charged. A warning that cries wolf is one the
   * cashier learns to click through, which is worse than no warning at all.
   */
  itemType: ItemType
  /** DERIVED from the movements, never stored. Shown so the cashier can see they are about to oversell. */
  onHandM: number
}

// ── What printing gives back ─────────────────────────────────────────────────
//
// `shared/` cannot import from `main/`, so the printer's result shapes are declared HERE and
// printing/printer.ts imports them back. That is the point: if the printer's shape ever drifts from
// what the Sell screen reads, THE BUILD BREAKS — rather than the cashier silently never being told
// their receipt did not print. (Same device as StockAdjustResult.)

/**
 * DID IT PRINT? A `problem` is not an error — the sale is SAVED either way.
 *
 * A printer jam must never lose a completed sale, so a failed print comes back as DATA on a successful
 * call, and the screen turns it into a warning and a "Print again" button. It is never a red box that
 * makes a cashier think the money did not go through.
 */
export type PrintOutcome = {
  printed: boolean
  copies: number
  /** Null = the system default printer. */
  printerName: string | null
  /** Cashier-readable, and actionable. Null when it printed. */
  problem: string | null
}

/**
 * The result of printing OR saving a purchase's A4 invoice.
 *
 *   mode 'print' -> `print` carries the PrintOutcome (never an error — a jam is a warning, not a failure).
 *   mode 'pdf'   -> `savedPath` is where the PDF was written, or null if the owner closed the save dialog.
 *
 * Exactly one of the two is populated per call; the other is null.
 */
export type PurchasePrintOutcome = {
  mode: 'print' | 'pdf'
  print: PrintOutcome | null
  savedPath: string | null
}

/** Did the drawer open? Same contract, same reason: never an error, always the truth. */
export type DrawerOutcome = {
  opened: boolean
  problem: string | null
}

/**
 * For the Settings dropdown — so the owner PICKS their printer instead of mistyping its name.
 *
 * `name` is what the OS understands and what goes into the `printer.name` setting; `displayName` is
 * what the shopkeeper recognises. There is deliberately NO `isDefault` flag: Electron dropped it from
 * its own PrinterInfo, and guessing at it from the platform-specific `options` bag would be a flag that
 * is right on one machine and wrong on the next. It is not needed anyway — an EMPTY `printer.name`
 * already means "use the system default", so the dropdown's blank entry is the default printer.
 */
export type PrinterInfo = {
  name: string
  displayName: string
  /** The OS's longer description — tells two similarly-named printers apart. */
  description: string
}

/**
 * WHAT COMES BACK FROM RINGING UP A SALE.
 *
 * The sale is COMMITTED before a single byte goes to the printer. `print` and `drawer` are what the
 * hardware then did — reported, never thrown. If `print.printed` is false the shop still made the
 * sale, the customer still paid, and the books are still right; they just need to press Print again.
 */
export type CompleteSaleResponse = {
  sale: SaleDetail
  /** The balanced journal this sale posted. */
  journalId: number
  print: PrintOutcome
  /** Kicked only on a CASH sale, and only when `drawer.enabled` is on. */
  drawer: DrawerOutcome
}

// ═════════════════════════════════════════════════════════════════════════════
// CUSTOMERS & USERS — the leftover inputs, and one mirrored result type
// ═════════════════════════════════════════════════════════════════════════════
//
// The customer CREATE / UPDATE / PAYMENT / LEDGER schemas are the canonical Phase-7 contract and live in
// '@shared/customers'; the LIST / GET schemas live in '@shared/opening'. The handlers import those
// straight. Defined HERE are only the leftovers that had no home: the plain-id customer writes, and the
// user-admin inputs — because services/users.ts keeps its own schemas PRIVATE, and an IPC input MUST be
// a schema (the renderer is not trusted, and neither is a future LAN client).

/** Retire a customer — never delete; last year's credit sale still points at the row. */
export const CustomerDeactivateInput = z.object({ id: RowId })

/** What a customer owes RIGHT NOW — derived on read. Just the id; the figure comes back as a number. */
export const CustomerBalanceInput = z.object({ customerId: RowId })

/**
 * THE CUSTOMERS LIST WITH BALANCES — mirrored from services/customer-ledger.ts, because `shared/` cannot
 * import from `main/`. The handler is annotated with this, so if the service's shape ever drifts the
 * BUILD BREAKS here rather than the screen rendering a blank balance column. (Same device as
 * ScannedItem / StockAdjustResult.) `balance` is 2-dp money; positive = the customer owes the shop.
 */
export type CustomerWithBalance = Customer & { balance: number }

// ── Buying — the leftover supplier inputs with no home in shared/suppliers.ts ──
//
// The supplier CREATE / UPDATE / LIST / LEDGER / PAYMENT schemas are the canonical contract and live in
// '@shared/suppliers'; the purchase schemas in '@shared/purchases'. The handlers import those straight.
// Defined HERE are only the leftovers — the plain-id supplier writes and reads, mirroring
// CustomerDeactivateInput / CustomerBalanceInput. An IPC input MUST be a schema; the renderer is not
// trusted, and neither is a future LAN client.

/** Retire a supplier — never delete; last year's purchase still points at the row. */
export const SupplierDeactivateInput = z.object({ id: RowId })

/** What the shop owes a supplier RIGHT NOW — derived on read. Just the id; the figure comes back as a number. */
export const SupplierBalanceInput = z.object({ supplierId: RowId })

/** Read one supplier payment by its id — for the payment receipt. */
export const SupplierPaymentGetInput = z.object({ id: RowId })

// ── Users & roles — OWNER ONLY ─────────────────────────────────────────────────
// The SERVICE does the real validation — length against the `security.*` SETTINGS, username
// uniqueness, the last-owner guard, PIN collision. These schemas are the gate at the boundary. Password
// length is deliberately NOT bounded below here: the service enforces the minimum against
// `security.minPasswordLength`, so an owner who demands 12-character passwords gets 12. (CLAUDE.md §4.)

export const UserListInput = z.object({ page: Page, pageSize: PageSize })

export const CreateUserInput = z.object({
  username: z.string().trim().min(1, 'Please enter a username.').max(40),
  fullName: z.string().trim().min(1, 'Please enter the full name of the staff member.').max(120),
  role: z.enum(ROLES),
  password: z.string().max(200, 'That password is too long.')
})

/** Edit — ONLY the fields the form sent (trap #18). `id` names the user; the rest are the changes. */
export const UpdateUserInput = z.object({
  id: RowId,
  fullName: z
    .string()
    .trim()
    .min(1, 'Please enter the full name of the staff member.')
    .max(120)
    .optional(),
  role: z.enum(ROLES).optional()
})

export const SetUserPasswordInput = z.object({
  id: RowId,
  password: z.string().max(200, 'That password is too long.')
})

/**
 * Set the counter quick-switch PIN, or CLEAR it with `pin: null`. The precise rule — digits only, and
 * EXACTLY `security.pinLength` characters, and unique among active staff — is the service's, so the
 * friendly "A PIN must be exactly 4 digits" message comes from there. `.nullable()` (not `.nullish()`)
 * on purpose: clearing a PIN must be a DELIBERATE null, never a forgotten field.
 */
export const SetUserPinInput = z.object({
  id: RowId,
  pin: z.string().trim().max(20).nullable()
})

/** Retire or restore a staff member — never delete. */
export const UserIdInput = z.object({ id: RowId })

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
export type StockLevelsInput = z.infer<typeof StockLevelsInput>
export type LowStockInput = z.infer<typeof LowStockInput>
export type NearExpiryInput = z.infer<typeof NearExpiryInput>
export type OpeningPartyListInput = z.infer<typeof OpeningPartyListInput>
export type ScanBarcodeInput = z.infer<typeof ScanBarcodeInput>
export type CartLineChanges = z.infer<typeof CartLineChanges>
export type CartAddLineInput = z.infer<typeof CartAddLineInput>
export type CartUpdateLineInput = z.infer<typeof CartUpdateLineInput>
export type CartRemoveLineInput = z.infer<typeof CartRemoveLineInput>
export type ListHeldInput = z.infer<typeof ListHeldInput>
export type OutstandingCreditInput = z.infer<typeof OutstandingCreditInput>
export type PrintReceiptInput = z.infer<typeof PrintReceiptInput>
export type PrintQuotationInput = z.infer<typeof PrintQuotationInput>
export type PurchasePrintInvoiceInput = z.infer<typeof PurchasePrintInvoiceInput>
export type OpenDrawerInput = z.infer<typeof OpenDrawerInput>
export type ReturnableLinesInput = z.infer<typeof ReturnableLinesInput>
export type ReturnablePurchaseLinesInput = z.infer<typeof ReturnablePurchaseLinesInput>
export type CustomerDeactivateInput = z.infer<typeof CustomerDeactivateInput>
export type CustomerBalanceInput = z.infer<typeof CustomerBalanceInput>
export type SupplierDeactivateInput = z.infer<typeof SupplierDeactivateInput>
export type SupplierBalanceInput = z.infer<typeof SupplierBalanceInput>
export type SupplierPaymentGetInput = z.infer<typeof SupplierPaymentGetInput>
export type UserListInput = z.infer<typeof UserListInput>
export type CreateUserInput = z.infer<typeof CreateUserInput>
export type UpdateUserInput = z.infer<typeof UpdateUserInput>
export type SetUserPasswordInput = z.infer<typeof SetUserPasswordInput>
export type SetUserPinInput = z.infer<typeof SetUserPinInput>
export type UserIdInput = z.infer<typeof UserIdInput>
