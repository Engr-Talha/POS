import { ipcMain, app, dialog, BrowserWindow } from 'electron'
import type { OpenDialogOptions, SaveDialogOptions } from 'electron'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ZodType } from 'zod'
import {
  IPC,
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
  OpeningPartyListInput,
  ScanBarcodeInput,
  CartAddLineInput,
  CartUpdateLineInput,
  CartRemoveLineInput,
  ListHeldInput,
  OutstandingCreditInput,
  OpenDrawerInput,
  PrintReceiptInput,
  type StockAdjustResult,
  type NearExpiryItem,
  type SystemInfo,
  type OpeningWizardState,
  type ImportPreview,
  type ImportResult,
  type ScannedItem,
  type CompleteSaleResponse,
  type PrintOutcome,
  type DrawerOutcome,
  type PrinterInfo
} from '@shared/ipc'
import {
  CompleteSaleInput,
  DiscardSaleInput,
  HoldSaleInput,
  ResumeSaleInput,
  SaleByInvoiceNoInput,
  SaleGetInput,
  SaleListInput,
  SaveQuoteInput,
  VoidSaleInput,
  type SaleDetail,
  type SaleLineInput
} from '@shared/sales'
import {
  CommitOpeningInput,
  CreateCustomerInput,
  CustomerListInput,
  DeleteOpeningPayableInput,
  DeleteOpeningReceivableInput,
  DeleteOpeningStockLineInput,
  OpeningCashInput,
  OpeningPayableInput,
  OpeningReceivableInput,
  OpeningStockLineInput,
  OpeningStockListInput,
  UpdateOpeningPayableInput,
  UpdateOpeningReceivableInput,
  UpdateOpeningStockLineInput,
  UpdateCustomerInput
} from '@shared/opening'
import {
  CreateProductInput,
  UpdateProductInput,
  ProductListInput,
  ProductGetInput,
  CreateVariantGroupInput,
  AdjustStockInput,
  StockLevelInput,
  StockMovementListInput,
  ResolveBarcodeInput,
  AddBarcodeInput,
  ReplaceBarcodeInput,
  SaveProductPackInput,
  DeleteProductPackInput,
  CreateSupplierInput,
  UpdateSupplierInput,
  SupplierListInput,
  SaveProductSupplierInput,
  DeleteProductSupplierInput,
  CreateBatchInput,
  BatchListInput,
  type PagedResult
} from '@shared/catalog'
import { ok, err, AppError, ErrorCode, type Result } from '@shared/result'
import type { AppState } from '../services/app-state'
import { getAppState } from '../services/app-state'
import { databaseSelfCheck } from '../services/system'
import { getDb, getDbPath, isClockTampered } from '../db/instance'
import { check as checkForUpdates } from '../updater'
import { getMachineId } from '../security/machine-id'
import * as session from '../security/session'
import * as auth from '../services/auth'
import * as licenseService from '../services/license'
import * as backupService from '../services/backup'
import * as lookupsService from '../services/lookups'
import * as auditService from '../services/audit'
import * as settingsService from '../services/settings'
import * as ledgerService from '../services/ledger'
import * as productsService from '../services/products'
import * as stockService from '../services/stock'
import * as catalogService from '../services/catalog'
import * as openingService from '../services/opening'
import * as customersService from '../services/customers'
import * as excelTemplateService from '../services/excel-template'
import * as excelImportService from '../services/excel-import'
import * as salesService from '../services/sales'
import * as printer from '../printing/printer'
import log from '../logger'

/**
 * THE IPC LAYER IS THIN. (CLAUDE.md §3)
 *
 * A handler does exactly four things: validate the input, check permission, call a service, wrap the
 * result. There is NO business logic here — that lives in services/, which knows nothing about
 * Electron and can therefore be tested directly and, one day, served over a LAN.
 *
 * Every handler returns a Result envelope. Nothing throws across the IPC boundary, and no stack
 * trace ever reaches the screen.
 */

function state(): AppState {
  return getAppState(getDb(), getMachineId(), { clockTampered: isClockTampered() })
}

/**
 * Guard for anything that CHANGES data.
 *
 * Reads, reports, exports and BACKUPS never call this — an expired shop must always be able to get
 * its own numbers out. We do not hold their data hostage (CLAUDE.md §6).
 */
function assertWritable(): void {
  licenseService.assertCanWrite(state().license)
}

function handle<TIn, TOut>(
  channel: string,
  schema: ZodType<TIn> | null,
  fn: (input: TIn) => TOut | Promise<TOut>
): void {
  ipcMain.handle(channel, async (_event, rawInput: unknown): Promise<Result<TOut>> => {
    try {
      log.info(`[ipc] ${channel}`)

      let input = rawInput as TIn
      if (schema) {
        const parsed = schema.safeParse(rawInput)
        if (!parsed.success) {
          const first = parsed.error.issues[0]?.message
          log.warn(`[ipc] ${channel} rejected bad input: ${parsed.error.message}`)
          return err(
            ErrorCode.VALIDATION,
            first ?? 'Some of the information entered is not valid. Please check and try again.',
            parsed.error.message
          )
        }
        input = parsed.data
      }

      return ok(await fn(input))
    } catch (error) {
      if (error instanceof AppError) {
        log.warn(`[ipc] ${channel} -> ${error.code}: ${error.message}`)
        return err(error.code, error.userMessage, error.message)
      }

      const e = error as Error
      log.error(`[ipc] ${channel} CRASHED: ${e.stack ?? e.message}`)
      return err(
        ErrorCode.UNKNOWN,
        'Something went wrong. Please try again — if it keeps happening, contact support.',
        e.stack ?? e.message
      )
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE EXCEL IMPORT — the file the owner picked, and why MAIN is the only one who knows where it is
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * THE FILE, REMEMBERED BETWEEN "PREVIEW" AND "IMPORT".
 *
 * The owner picks a file, reads the review screen, and presses Import. Making him find the same file a
 * second time in a Windows file dialog is how the wrong file gets picked on the second go.
 *
 * SO THE PATH LIVES HERE, IN MAIN — and nowhere else. None of the three import handlers takes a path
 * as an argument, deliberately: a renderer that could name a file could name ANY file, and hand main a
 * path to read that no user ever chose. The renderer cannot say WHICH file. It can only say "the one
 * the user picked", and main is the one holding it. (CLAUDE.md §3)
 *
 * The HASH is what makes "the one the user picked" mean something. See the note in openingApplyImport.
 *
 * AND IT IS STAMPED WITH WHO PICKED IT. A PIN sign-in switches user without a sign-out, so this outlives
 * the session that created it: without `userId`, the next owner at the till could press Import and apply
 * a file the LAST owner chose and he has never seen. He is sent to the file picker instead.
 */
let pickedImportFile: { path: string; hash: string; userId: number } | null = null

function hashOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/** The one place a file is chosen. Returns null when the owner closes the dialog — not an error. */
async function pickImportFile(): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: 'Choose your filled-in template',
    filters: [{ name: 'Excel file', extensions: ['xlsx'] }],
    properties: ['openFile'],
    buttonLabel: 'Open'
  }

  const window = BrowserWindow.getFocusedWindow()
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)

  if (result.canceled) return null
  return result.filePaths[0] ?? null
}

/**
 * The bytes. A file that has been moved, renamed or deleted since it was chosen is an EVERYDAY event —
 * not a crash — and the owner gets a sentence he can act on rather than "Something went wrong".
 */
function readImportFile(path: string): Buffer {
  try {
    return readFileSync(path)
  } catch (error) {
    pickedImportFile = null // whatever we were holding, it is not there any more
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'We could not open that file. It may have been moved, renamed or deleted since you chose it. Please choose it again.',
      `readFileSync failed for ${path}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/** A filename a shopkeeper can find again next week. No colons or slashes — Windows refuses them. */
function templateFileName(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  return `Opening balances template - ${day}.xlsx`
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE PRINTER AND THE DRAWER — and the rule that outranks both
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// A PRINTER JAM MUST NEVER LOSE A COMPLETED SALE.
//
// By the time any of this runs, `sales.complete()` has already committed: the money is taken, the stock
// has moved, the journal has posted and the invoice number is drawn. Out of paper is a Tuesday. So the
// two functions below NEVER THROW — they come back and SAY what the hardware did, and the sale stands
// either way. The cashier is shown a warning and a Print again button; they are never shown a red box
// that makes them think the money did not go through, because it did.

/** Everything the printer needs, and every bit of it from SETTINGS. Not one constant. (CLAUDE.md §4) */
function printOptions(db: ReturnType<typeof getDb>): printer.PrintReceiptOptions {
  return {
    width: printer.resolveWidth(settingsService.get<string>(db, 'printer.receiptWidth', '80mm')),
    printerName: settingsService.get<string>(db, 'printer.name', ''),
    copies: printer.clampCopies(settingsService.get<number>(db, 'printer.copies', 1))
  }
}

/**
 * Build the receipt from the DATABASE and print it. Never throws.
 *
 * `receiptFor()` is what stamps a reprint DUPLICATE and writes the `sale.reprint` audit row — so the
 * paper and the log are produced by the same call, and a receipt cannot be reprinted without a trace.
 */
async function printSaleReceipt(
  db: ReturnType<typeof getDb>,
  actor: Parameters<typeof salesService.receiptFor>[1],
  saleId: number,
  isDuplicate: boolean
): Promise<PrintOutcome> {
  try {
    const receipt = salesService.receiptFor(db, actor, { id: saleId, isDuplicate })
    return await printer.printReceipt(receipt, printOptions(db))
  } catch (error) {
    // Building the receipt failed — not printing it. The sale is still SAVED, so this is still not an
    // error the cashier is allowed to mistake for a failed sale.
    const technical = error instanceof Error ? error.message : String(error)
    log.error(`[printer] could not build the receipt for sale ${saleId}: ${technical}`)

    return {
      printed: false,
      copies: 0,
      printerName: null,
      problem:
        'The sale is saved, but the receipt could not be prepared. Please try printing it again from the sales list.'
    }
  }
}

/**
 * Kick the drawer — but only on a CASH sale, and only if the shop has the drawer switched on
 * (`drawer.enabled`). A card sale does not open the till, because no cash is going into it.
 *
 * "Which payment was cash" is read from the LOOKUPS table, never hardcoded: `payment_method` is a
 * lookups list like every other dropdown in this app, and a shop may well have added 'Cash (USD)'.
 * We match on the CODE, which is what survives a row being re-seeded. (CLAUDE.md §4)
 */
async function kickDrawerForSale(
  db: ReturnType<typeof getDb>,
  sale: SaleDetail
): Promise<DrawerOutcome> {
  if (!settingsService.get<boolean>(db, 'drawer.enabled', true)) {
    return { opened: false, problem: null } // switched off in Settings. Not a fault — a choice.
  }

  const cashMethodIds = new Set(
    lookupsService
      .list(db, 'payment_method', true)
      .filter((method) => method.code === 'cash')
      .map((method) => method.id)
  )

  const tookCash = sale.payments.some((payment) => cashMethodIds.has(payment.methodLookupId))
  if (!tookCash) return { opened: false, problem: null }

  return printer.openCashDrawer({
    kickCode: settingsService.get<string>(db, 'drawer.kickCode', ''),
    printerName: settingsService.get<string>(db, 'printer.name', '')
  })
}

/**
 * THE REASON THE TILL WAS OPENED WITH NO SALE — and it had better be on the list.
 *
 * Mirrors `assertAdjustmentReason` in services/stock.ts exactly: the code must be an ACTIVE row of a
 * lookups list. NEVER a hardcoded dropdown (CLAUDE.md §4).
 *
 * The `no_sale_reason` list has no SEEDED rows yet — it belongs with `cash_movements`, which is Phase 6
 * — so on a fresh shop it is empty and the owner fills it in Settings → Manage Lists like any other
 * list. The generic `lookups:list` / `lookups:add` handlers already serve it (they take the list key as
 * data), so this needs no new endpoint. The message below says exactly that, in words an owner can act
 * on, rather than failing with "unknown reason code".
 */
function assertNoSaleReason(db: ReturnType<typeof getDb>, code: string): void {
  const row = db
    .prepare(
      `SELECT code FROM lookups WHERE list_key = 'no_sale_reason' AND code = ? AND is_active = 1`
    )
    .get(code) as { code: string } | undefined

  if (!row) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Please choose a reason for opening the till from the list. An owner can set these up in Settings → Manage Lists.',
      `unknown or inactive no_sale_reason code "${code}"`
    )
  }
}

export function registerIpcHandlers(): void {
  // ── System ────────────────────────────────────────────────────────────────
  handle<void, SystemInfo>(IPC.systemGetInfo, null, () => ({
    appName: app.getName(),
    appVersion: app.getVersion(),
    platform: process.platform,
    isPackaged: app.isPackaged,
    dbPath: getDbPath(),
    logPath: log.transports.file.getFile().path
  }))

  handle(IPC.systemDbSelfCheck, null, () => databaseSelfCheck(getDb()))
  handle(IPC.updateCheck, null, () => checkForUpdates())

  // ── App state — what screen should we be on? ───────────────────────────────
  handle(IPC.appGetState, null, () => state())

  // ── Licence ───────────────────────────────────────────────────────────────
  handle(IPC.licenseActivate, ActivateInput, (input) => {
    licenseService.activate(getDb(), input.key, getMachineId())
    return state()
  })

  // ── Auth ──────────────────────────────────────────────────────────────────
  handle(IPC.authCreateFirstOwner, CreateFirstOwnerInput, (input) => {
    const owner = auth.createFirstOwner(getDb(), input)
    session.signIn(owner) // straight in — no point making them log in to the account they just made
    return state()
  })

  handle(IPC.authSignIn, SignInInput, (input) => {
    const user = auth.signIn(getDb(), input.username, input.password)
    session.signIn(user)
    return state()
  })

  handle(IPC.authSignInWithPin, PinInput, (input) => {
    const user = auth.signInWithPin(getDb(), input.pin)
    session.signIn(user)
    return state()
  })

  handle(IPC.authSignOut, null, () => {
    session.signOut()
    return state()
  })

  // ── Backup ────────────────────────────────────────────────────────────────
  // NOTE: no assertWritable() here, deliberately. Backing up is ALWAYS allowed, even on an expired
  // licence. A business that cannot get its own books out is a business we have taken hostage.
  handle(IPC.backupChooseFolder, null, async () => {
    session.requirePermissionOf('backup.run')
    const window = BrowserWindow.getFocusedWindow()
    const result = window
      ? await dialog.showOpenDialog(window, {
          title: 'Choose where to save backups',
          properties: ['openDirectory', 'createDirectory'],
          buttonLabel: 'Save backups here'
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })

    if (result.canceled || !result.filePaths[0]) return null
    settingsService.set(getDb(), 'backup.directory', result.filePaths[0])
    return result.filePaths[0]
  })

  handle(IPC.backupRun, null, async () => {
    const user = session.requirePermissionOf('backup.run')
    const db = getDb()

    const directory =
      settingsService.get<string | null>(db, 'backup.directory', null) ??
      app.getPath('documents')

    const result = await backupService.backupTo(db, directory)

    settingsService.set(db, 'backup.lastRunAt', result.at)
    auditService.record(db, user, { action: 'backup.run', entity: 'backup', entityId: result.path })

    return result
  })

  handle(IPC.backupRestore, RestoreInput, (input) => {
    // Owner only. Restore OVERWRITES the shop's live data — it is the most dangerous button here.
    const user = session.requirePermissionOf('backup.restore')

    const outcome = backupService.restoreFrom(getDbPath(), input.backupPath)
    auditService.record(getDb(), user, {
      action: 'backup.restore',
      entity: 'backup',
      entityId: input.backupPath,
      after: { safetyCopy: outcome.safetyCopy }
    })

    // The database file underneath us has just been swapped. Restarting is the only honest way to
    // pick it up — every open statement and cached page is now stale.
    setTimeout(() => {
      app.relaunch()
      app.exit(0)
    }, 500)

    return outcome
  })

  // ── Lookups — every dropdown in the app ───────────────────────────────────
  handle(IPC.lookupsList, LookupsListInput, (input) =>
    lookupsService.list(
      getDb(),
      input.listKey as lookupsService.LookupList,
      input.includeInactive ?? false
    )
  )

  handle(IPC.lookupsAdd, LookupsAddInput, (input) => {
    const user = session.requirePermissionOf('lookups.manage')
    assertWritable()

    const added = lookupsService.add(getDb(), {
      listKey: input.listKey as lookupsService.LookupList,
      label: input.label
    })

    auditService.record(getDb(), user, {
      action: 'lookup.add',
      entity: 'lookup',
      entityId: added.id,
      after: added
    })

    return added
  })

  handle(IPC.lookupsUpdate, LookupsUpdateInput, (input) => {
    const user = session.requirePermissionOf('lookups.manage')
    assertWritable()

    const { id, ...changes } = input
    const updated = lookupsService.update(getDb(), id, changes)

    auditService.record(getDb(), user, {
      action: 'lookup.update',
      entity: 'lookup',
      entityId: id,
      after: updated
    })

    return updated
  })

  handle(IPC.lookupsDeactivate, LookupsDeactivateInput, (input) => {
    const user = session.requirePermissionOf('lookups.manage')
    assertWritable()

    lookupsService.deactivate(getDb(), input.id)
    auditService.record(getDb(), user, {
      action: 'lookup.deactivate',
      entity: 'lookup',
      entityId: input.id
    })

    return true
  })

  // ── Settings ──────────────────────────────────────────────────────────────
  handle(IPC.settingsGetAll, null, () => settingsService.getAll(getDb()))

  handle(IPC.settingsSet, SettingsSetInput, (input) => {
    const user = session.requirePermissionOf('settings.manage')
    assertWritable()

    const before = settingsService.get(getDb(), input.key, null)
    settingsService.set(getDb(), input.key, input.value)

    // Settings changes are audited: currency, tax rate and invoice numbering all move money.
    auditService.record(getDb(), user, {
      action: 'settings.change',
      entity: 'setting',
      entityId: input.key,
      before,
      after: input.value
    })

    return settingsService.getAll(getDb())
  })

  // ── Ledger ────────────────────────────────────────────────────────────────
  // Reading the books is a READ. It keeps working on an expired licence, deliberately.
  handle(IPC.ledgerTrialBalance, null, () => {
    session.requirePermissionOf('report.view')
    return ledgerService.trialBalance(getDb())
  })

  handle(IPC.accountsList, null, () => {
    session.requirePermissionOf('report.view')
    return getDb()
      .prepare(
        `SELECT id, code, name, type, is_contra AS isContra, is_system AS isSystem, is_active AS isActive
         FROM accounts ORDER BY code`
      )
      .all()
  })

  // ── Audit log ─────────────────────────────────────────────────────────────
  handle(IPC.auditList, AuditListInput, (input) => {
    session.requirePermissionOf('audit.view')
    return auditService.list(getDb(), input)
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // CATALOG — products, stock, barcodes, packs, suppliers, batches
  //
  // Two rules run through every handler below, and they are not symmetrical:
  //
  //   READS  check a permission and NOTHING else. No assertWritable(). A shop whose licence has
  //          expired can still open its catalog, read its stock, and export its numbers. We warn
  //          them; we do not hold their data hostage. (CLAUDE.md §6)
  //
  //   WRITES check a permission AND assertWritable(), and every one of them lands in the audit log.
  //          The product/stock services audit themselves (they were given the actor for exactly
  //          that reason); the catalog service does not, so the writes below record their own.
  //          Auditing twice would be as bad as not auditing at all — a log nobody trusts.
  //
  // There is no stock field anywhere in here. Stock is SUM(stock_movements.qty_m) and the only door
  // into it is stock:adjust, which will not move a single unit without a reason code.
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Products ──────────────────────────────────────────────────────────────
  handle(IPC.productsList, ProductListInput, (input) => {
    session.requirePermissionOf('report.view')
    return productsService.list(getDb(), input)
  })

  handle(IPC.productsGet, ProductGetInput, (input) => {
    session.requirePermissionOf('report.view')
    return productsService.getById(getDb(), input.id)
  })

  handle(IPC.productsCreate, CreateProductInput, (input) => {
    const user = session.requirePermissionOf('product.manage')
    assertWritable()
    // The service audits product.create itself — it has the actor. Do not log it twice here.
    return productsService.create(getDb(), user, input)
  })

  handle(IPC.productsUpdate, UpdateProductInput, (input) => {
    const user = session.requirePermissionOf('product.manage')
    assertWritable()
    // Only the fields the form actually sent arrive here — see UpdateProductInput. The service
    // audits product.update, and raises a separate product.price_change when a price moved.
    return productsService.update(getDb(), user, input)
  })

  handle(IPC.productsDeactivate, ProductDeactivateInput, (input) => {
    const user = session.requirePermissionOf('product.manage')
    assertWritable()
    return productsService.deactivate(getDb(), user, input.id)
  })

  handle(IPC.productsCreateVariantGroup, CreateVariantGroupInput, (input) => {
    const user = session.requirePermissionOf('product.manage')
    assertWritable()
    return productsService.createVariantGroup(getDb(), user, input)
  })

  handle(IPC.productsListVariants, ListVariantsInput, (input) => {
    session.requirePermissionOf('report.view')
    return productsService.listVariants(getDb(), input.variantGroupId)
  })

  // ── Stock — DERIVED, always. Reading it never needs a licence. ─────────────
  handle(IPC.stockLevels, StockLevelsInput, (input) => {
    session.requirePermissionOf('report.view')
    return stockService.stockLevels(getDb(), input)
  })

  handle(IPC.stockLevel, StockLevelInput, (input) => {
    session.requirePermissionOf('report.view')
    // The product form's BALANCE QUANTITY box. Re-summed from the movements on every read, which is
    // why it cannot drift from the item's own history.
    return stockService.stockLevel(getDb(), input.productId)
  })

  handle(IPC.stockMovements, StockMovementListInput, (input) => {
    session.requirePermissionOf('report.view')
    return stockService.listMovements(getDb(), input)
  })

  handle(IPC.stockLowStock, LowStockInput, (input) => {
    session.requirePermissionOf('report.view')
    return stockService.lowStock(getDb(), input)
  })

  // Annotated with the SHARED result type on purpose: `shared/` cannot import from `main/`, so this
  // line is what ties stock.NearExpiryRow to the NearExpiryItem the renderer is typed against. If
  // the service's shape ever drifts, the build breaks here rather than the screen breaking later.
  handle<NearExpiryInput, PagedResult<NearExpiryItem>>(
    IPC.stockNearExpiry,
    NearExpiryInput,
    (input) => {
      session.requirePermissionOf('report.view')
      return stockService.nearExpiry(getDb(), input)
    }
  )

  /**
   * THE ONLY DOOR INTO STOCK.
   *
   * There is no "set stock to N" endpoint in this app and there never will be. You post a signed
   * movement with a reason code, and the balance re-sums itself. The service does the movement, the
   * balanced journal and the audit row in ONE transaction — a locked period rolls back all three.
   */
  handle<AdjustStockInput, StockAdjustResult>(IPC.stockAdjust, AdjustStockInput, (input) => {
    const user = session.requirePermissionOf('stock.adjust')
    assertWritable()
    return stockService.adjust(getDb(), user, input)
  })

  // ── Barcodes ──────────────────────────────────────────────────────────────
  /**
   * The scanner. Gated at `sale.create`, NOT `report.view` — a cashier is the one holding the gun,
   * and a catalog a cashier cannot scan is a till that cannot sell. This is the one catalog read
   * below manager level, and it is deliberate.
   *
   * An unknown code is `null`, not an error: a loyalty card swiped at the till is a Tuesday, not a
   * fault, and the cashier deserves "not found" rather than a red box.
   */
  handle(IPC.catalogFindByBarcode, ResolveBarcodeInput, (input) => {
    session.requirePermissionOf('sale.create')
    return catalogService.findProductByBarcode(getDb(), input.barcode)
  })

  handle(IPC.catalogListBarcodes, ProductIdInput, (input) => {
    session.requirePermissionOf('report.view')
    return catalogService.listBarcodes(getDb(), input.productId)
  })

  handle(IPC.catalogAddBarcode, AddBarcodeInput, (input) => {
    const user = session.requirePermissionOf('product.manage')
    assertWritable()

    const added = catalogService.addBarcode(getDb(), input)
    auditService.record(getDb(), user, {
      action: 'product.barcode_add',
      entity: 'product',
      entityId: input.productId,
      after: added
    })

    return added
  })

  /**
   * REPLACE BARCODE. The old code is demoted, never deleted — the stock already on the shelf carries
   * it and has to keep scanning. `userId` is a real FK to users, so the session user goes in.
   */
  handle(IPC.catalogReplaceBarcode, ReplaceBarcodeInput, (input) => {
    const user = session.requirePermissionOf('product.manage')
    assertWritable()

    const outcome = catalogService.replaceBarcode(getDb(), input, user.id)
    auditService.record(getDb(), user, {
      action: 'product.barcode_replace',
      entity: 'product',
      entityId: input.productId,
      before: { barcode: input.oldBarcode },
      after: { barcode: input.newBarcode, oldStillScans: true }
    })

    return outcome
  })

  handle(IPC.catalogBarcodeReplacements, ProductIdInput, (input) => {
    session.requirePermissionOf('report.view')
    return catalogService.listBarcodeReplacements(getDb(), input.productId)
  })

  // ── Alternate packings ────────────────────────────────────────────────────
  handle(IPC.catalogListPacks, ProductIdInput, (input) => {
    session.requirePermissionOf('report.view')
    return catalogService.listPacks(getDb(), input.productId)
  })

  handle(IPC.catalogSavePack, SaveProductPackInput, (input) => {
    const user = session.requirePermissionOf('product.manage')
    assertWritable()

    const saved = catalogService.savePack(getDb(), input)
    // A pack carries its own price and its own barcode, so saving one is a price change in all but
    // name. It gets a row in the log like any other.
    auditService.record(getDb(), user, {
      action: 'product.pack_save',
      entity: 'product',
      entityId: input.productId,
      after: saved
    })

    return saved
  })

  handle(IPC.catalogDeletePack, DeleteProductPackInput, (input) => {
    const user = session.requirePermissionOf('product.manage')
    assertWritable()

    catalogService.deletePack(getDb(), input.id)
    auditService.record(getDb(), user, {
      action: 'product.pack_delete',
      entity: 'product_pack',
      entityId: input.id
    })

    return true
  })

  // ── Suppliers ─────────────────────────────────────────────────────────────
  handle(IPC.catalogListSuppliers, SupplierListInput, (input) => {
    session.requirePermissionOf('report.view')
    return catalogService.listSuppliers(getDb(), input)
  })

  handle(IPC.catalogGetSupplier, SupplierGetInput, (input) => {
    session.requirePermissionOf('report.view')
    return catalogService.getSupplier(getDb(), input.id)
  })

  handle(IPC.catalogCreateSupplier, CreateSupplierInput, (input) => {
    const user = session.requirePermissionOf('purchase.manage')
    assertWritable()

    const supplier = catalogService.createSupplier(getDb(), input)
    auditService.record(getDb(), user, {
      action: 'supplier.create',
      entity: 'supplier',
      entityId: supplier.id,
      after: supplier
    })

    return supplier
  })

  handle(IPC.catalogUpdateSupplier, UpdateSupplierInput, (input) => {
    const user = session.requirePermissionOf('purchase.manage')
    assertWritable()

    const before = catalogService.getSupplier(getDb(), input.id)
    const after = catalogService.updateSupplier(getDb(), input)

    auditService.record(getDb(), user, {
      action: 'supplier.update',
      entity: 'supplier',
      entityId: input.id,
      before,
      after
    })

    return after
  })

  handle(IPC.catalogListProductSuppliers, ProductIdInput, (input) => {
    session.requirePermissionOf('report.view')
    return catalogService.listSuppliersForProduct(getDb(), input.productId)
  })

  handle(IPC.catalogLinkSupplier, SaveProductSupplierInput, (input) => {
    const user = session.requirePermissionOf('product.manage')
    assertWritable()

    const link = catalogService.linkSupplierToProduct(getDb(), input)
    auditService.record(getDb(), user, {
      action: 'product.supplier_link',
      entity: 'product',
      entityId: input.productId,
      after: link
    })

    return link
  })

  handle(IPC.catalogUnlinkSupplier, DeleteProductSupplierInput, (input) => {
    const user = session.requirePermissionOf('product.manage')
    assertWritable()

    catalogService.unlinkSupplierFromProduct(getDb(), input.id)
    auditService.record(getDb(), user, {
      action: 'product.supplier_unlink',
      entity: 'product_supplier',
      entityId: input.id
    })

    return true
  })

  // ── Batches ───────────────────────────────────────────────────────────────
  handle(IPC.catalogListBatches, BatchListInput, (input) => {
    session.requirePermissionOf('report.view')
    return catalogService.listBatches(getDb(), input)
  })

  handle(IPC.catalogAddBatch, CreateBatchInput, (input) => {
    const user = session.requirePermissionOf('product.manage')
    assertWritable()

    const batch = catalogService.addBatch(getDb(), input)
    auditService.record(getDb(), user, {
      action: 'product.batch_add',
      entity: 'product',
      entityId: input.productId,
      after: batch
    })

    return batch
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // OPENING SETUP — what the shop ALREADY HAD on day one
  //
  // Without this the books believe the shop began life with nothing, and every report is wrong from
  // the first day: the first tin sold — a tin bought last year — shows 100% profit, because as far as
  // the ledger knows it cost nothing.
  //
  // OWNER ONLY. Every write below is gated on 'settings.manage', which only an Owner has. This is not
  // a "products" screen a manager keeps tidy; it is the shop's day-one balance sheet, and `commit`
  // posts the lot into the general ledger. The reads are 'report.view' and never call assertWritable()
  // — an expired shop can still SEE its opening balances and export them. (CLAUDE.md §6.)
  //
  // NOTHING here is in the books until `commit`. The opening_* tables are a WORKSHEET: the owner can
  // come back to it over three evenings with a stock sheet in their hand. That is why the add/update/
  // remove handlers below do not each write an audit row — they change no money, no stock and no
  // ledger. The single audit row that matters is written by `commit`, and it freezes the entire
  // day-one balance sheet with a name and a time against it.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * The review screen — and the wizard's own state.
   *
   * TWO reads composed into one payload: the figures (`getSummary`) and whether the sheet may still be
   * touched (`hasTraded`). The freeze rule locks the opening balances the moment the shop makes its
   * first real sale or purchase; a wizard that could not see that would let the owner type for an hour
   * and only then be told no. `canEdit` is a COURTESY to the screen — main refuses the write anyway.
   */
  handle<void, OpeningWizardState>(IPC.openingGetSummary, null, () => {
    session.requirePermissionOf('report.view')
    const db = getDb()

    const summary = openingService.getSummary(db)
    const hasTraded = openingService.hasTraded(db)

    return { ...summary, hasTraded, canEdit: summary.status !== 'committed' && !hasTraded }
  })

  handle(IPC.openingSetCashAndBank, OpeningCashInput, (input) => {
    const user = session.requirePermissionOf('settings.manage')
    assertWritable()
    // Only the fields the step actually sent are written — see OpeningCashInput. (Trap #18.)
    return openingService.setCashAndBank(getDb(), user, input)
  })

  // ── The stock sheet ────────────────────────────────────────────────────────
  handle(IPC.openingListStockLines, OpeningStockListInput, (input) => {
    session.requirePermissionOf('report.view')
    return openingService.listStockLines(getDb(), input)
  })

  handle(IPC.openingAddStockLine, OpeningStockLineInput, (input) => {
    const user = session.requirePermissionOf('settings.manage')
    assertWritable()
    return openingService.addStockLine(getDb(), user, input)
  })

  handle(IPC.openingUpdateStockLine, UpdateOpeningStockLineInput, (input) => {
    const user = session.requirePermissionOf('settings.manage')
    assertWritable()
    return openingService.updateStockLine(getDb(), user, input)
  })

  handle(IPC.openingRemoveStockLine, DeleteOpeningStockLineInput, (input) => {
    const user = session.requirePermissionOf('settings.manage')
    assertWritable()
    openingService.removeStockLine(getDb(), user, input)
    return true
  })

  // ── Customer udhaar (receivables) ──────────────────────────────────────────
  handle(IPC.openingListReceivables, OpeningPartyListInput, (input) => {
    session.requirePermissionOf('report.view')
    return openingService.listReceivables(getDb(), input)
  })

  handle(IPC.openingAddReceivable, OpeningReceivableInput, (input) => {
    const user = session.requirePermissionOf('settings.manage')
    assertWritable()
    return openingService.addReceivable(getDb(), user, input)
  })

  handle(IPC.openingUpdateReceivable, UpdateOpeningReceivableInput, (input) => {
    const user = session.requirePermissionOf('settings.manage')
    assertWritable()
    return openingService.updateReceivable(getDb(), user, input)
  })

  handle(IPC.openingRemoveReceivable, DeleteOpeningReceivableInput, (input) => {
    const user = session.requirePermissionOf('settings.manage')
    assertWritable()
    openingService.removeReceivable(getDb(), user, input)
    return true
  })

  // ── Supplier dues (payables) ───────────────────────────────────────────────
  handle(IPC.openingListPayables, OpeningPartyListInput, (input) => {
    session.requirePermissionOf('report.view')
    return openingService.listPayables(getDb(), input)
  })

  handle(IPC.openingAddPayable, OpeningPayableInput, (input) => {
    const user = session.requirePermissionOf('settings.manage')
    assertWritable()
    return openingService.addPayable(getDb(), user, input)
  })

  handle(IPC.openingUpdatePayable, UpdateOpeningPayableInput, (input) => {
    const user = session.requirePermissionOf('settings.manage')
    assertWritable()
    return openingService.updatePayable(getDb(), user, input)
  })

  handle(IPC.openingRemovePayable, DeleteOpeningPayableInput, (input) => {
    const user = session.requirePermissionOf('settings.manage')
    assertWritable()
    openingService.removePayable(getDb(), user, input)
    return true
  })

  /**
   * COMMIT — the one-way door, and the most consequential write in this app after a restore.
   *
   * Posts every opening stock movement and every opening journal, balanced against Opening Balance
   * Equity, in ONE transaction. If a single line fails, the whole thing rolls back and the shop still
   * has its draft — a half-posted opening balance would be an inventory that does not match the ledger,
   * with no way to tell which half was real.
   *
   * A SECOND COMMIT WOULD NOT FAIL LOUDLY. It would succeed, posting the entire opening balance again —
   * double the stock, double the cash, double the equity — with the trial balance still balancing
   * perfectly, because two balanced journals balance. The service refuses it on `status`, inside the
   * transaction, which is what makes a double-click or a re-sent IPC message safe.
   *
   * The AUDIT ROW IS WRITTEN BY THE SERVICE (`opening.commit`, with the whole day-one balance sheet in
   * it). It is not written again here: a log that records the same act twice is a log nobody trusts.
   */
  handle<CommitOpeningInput, OpeningWizardState>(IPC.openingCommit, CommitOpeningInput, (input) => {
    const user = session.requirePermissionOf('settings.manage')
    assertWritable()

    const summary = openingService.commit(getDb(), user, input)
    log.info(
      `[opening] committed by ${user.username} (${user.role}): ` +
        `stock=${summary.stockValueMinor} cash=${summary.openingCashMinor} bank=${summary.openingBankMinor} ` +
        `udhaar=${summary.receivablesMinor} dues=${summary.payablesMinor} obe=${summary.openingBalanceEquityMinor}`
    )

    // The door is shut now, and it does not reopen. Say so, in the same shape the wizard already reads.
    return { ...summary, hasTraded: openingService.hasTraded(getDb()), canEdit: false }
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // THE EXCEL IMPORT — a shop's whole life, migrated in one upload
  //
  // The owner exports his old POS's item list to Excel, fills in what he has, and uploads it. Out of it
  // come his catalogue, his opening stock, his customers' udhaar, his suppliers' dues and the cash in
  // his till — as a DRAFT he then reviews and commits himself.
  //
  // THE ASYMMETRY THAT MATTERS HERE (CLAUDE.md §6):
  //
  //   downloadTemplate  is an EXPORT.        Permission, NO assertWritable().
  //   previewImport     WRITES NOTHING.      Permission, NO assertWritable().
  //   applyImport       writes.              Permission AND assertWritable().
  //
  // An owner whose licence has lapsed can still download his catalogue and still see what an import
  // would do. He simply cannot apply it until he renews. We warn them; we do not hold their data
  // hostage — and "export your data" is the one thing read-only mode exists to protect.
  //
  // ALL THREE ARE OWNER-ONLY ('settings.manage'). This is not a catalogue screen a manager keeps tidy;
  // it is the shop's day-one balance sheet, and the same gate is already on every other step of this
  // wizard. Opening a gate later is safe; shipping one too wide is not.
  //
  // NONE OF THE THREE TAKES AN ARGUMENT. There is no path to validate because the renderer never gets
  // to name one — see `pickedImportFile`.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * THE TEMPLATE — pre-filled with every item the shop already has, so the owner types numbers, not
   * names. Retyping 340 item names into a spreadsheet is how 340 items get imported twice under two
   * spellings.
   *
   * The dialog comes FIRST and the workbook is built after it: a shop with 100k items should not sit
   * through a build it is about to cancel. If the build fails, no file is written and the owner gets a
   * plain sentence — the Result envelope, like everything else.
   */
  handle<void, string | null>(IPC.openingDownloadTemplate, null, async () => {
    session.requirePermissionOf('settings.manage')
    // NO assertWritable(). This is an export, and an expired shop must still be able to get its own
    // catalogue out. (CLAUDE.md §6)

    const options: SaveDialogOptions = {
      title: 'Save the import template',
      defaultPath: join(app.getPath('documents'), templateFileName(new Date())),
      filters: [{ name: 'Excel file', extensions: ['xlsx'] }],
      buttonLabel: 'Save template'
    }

    const window = BrowserWindow.getFocusedWindow()
    const chosen = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)

    if (chosen.canceled || !chosen.filePath) return null

    const workbook = await excelTemplateService.buildTemplate(getDb())
    writeFileSync(chosen.filePath, workbook)

    log.info(`[opening] import template written to ${chosen.filePath}`)
    return chosen.filePath
  })

  /**
   * WHAT WOULD HAPPEN. Nothing is written to answer this question — not one row, not one lookup.
   *
   * Every problem in the file comes back at once, by row number, in plain language. Not the first one
   * and then stop: the owner has one spreadsheet open, and being told about one broken cell at a time —
   * upload, fix, upload, fix — across a 900-row sheet is how people give up and type it all in by hand.
   *
   * The file is REMEMBERED here, on a successful read, so that Import does not send him hunting for it
   * again. A file that would not open at all is not remembered — there is nothing to import.
   */
  handle<void, ImportPreview | null>(IPC.openingPreviewImport, null, async () => {
    const user = session.requirePermissionOf('settings.manage')
    // NO assertWritable(). parseWorkbook() reads the file and the database and writes NOTHING.

    const path = await pickImportFile()
    if (path === null) return null // they closed the dialog. Not an error — a Tuesday.

    const buffer = readImportFile(path)
    const preview = await excelImportService.parseWorkbook(getDb(), buffer)

    pickedImportFile = { path, hash: hashOf(buffer), userId: user.id }

    log.info(
      `[opening] previewed ${basename(path)}: ${preview.stock.rows.length} stock row(s), ` +
        `${preview.stock.openingLines} with an opening quantity, ` +
        `${preview.udhaar.rows.length} udhaar, ${preview.dues.rows.length} dues, ` +
        `${preview.errors.length} problem(s)`
    )

    // The screen is told the file's NAME, never its path — so the owner can see at a glance that he
    // picked this month's sheet and not last month's. A name is something to read; a path would be
    // something the renderer could act on, and the renderer has no filesystem to act on it with.
    return { ...preview, fileName: basename(path) }
  })

  /**
   * DO IT — in ONE transaction, or not at all.
   *
   * ── WHAT YOU REVIEWED IS WHAT YOU IMPORT ─────────────────────────────────────────────────────────
   *
   * The file is read AGAIN here, and its hash is checked against the one that was previewed. If the
   * spreadsheet has been edited in between, we STOP and send him back to the review screen.
   *
   * Both of the alternatives are worse, and quietly so. Import the remembered BYTES, and the fix he
   * just made in Excel is silently thrown away — he watches "340 items imported" and never learns his
   * correction did not land. Import the NEW bytes without a word, and the shop's entire opening balance
   * sheet is written from figures nobody has looked at, while the screen in front of him still shows
   * the old ones. Neither of those can be caught downstream: the journals balance either way.
   *
   * So: same file, or look again. It costs him one click in a case that should be rare.
   *
   * The audit row is written by the SERVICE — inside the transaction, with the actor and the whole
   * balance sheet on it. It is not written a second time here. A log that records the same act twice is
   * a log nobody trusts. (See ipc/audit-contract.test.ts.)
   *
   * AND IT DOES NOT COMMIT. It fills in the draft. The one-way door is still ahead of him.
   */
  handle<void, ImportResult | null>(IPC.openingApplyImport, null, async () => {
    const user = session.requirePermissionOf('settings.manage')
    assertWritable()

    // THE FILE *HE* PREVIEWED. Not the one the last owner previewed before handing over the till — see
    // the note on pickedImportFile. If there is nothing of his remembered — main was restarted, or a
    // different user picked it — we ask for the file rather than leave him with a button that does
    // nothing, and rather than apply a file he has never laid eyes on.
    const remembered = pickedImportFile?.userId === user.id ? pickedImportFile : null
    const path = remembered?.path ?? (await pickImportFile())
    if (path === null) return null

    const buffer = readImportFile(path)

    if (remembered && hashOf(buffer) !== remembered.hash) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'This file has changed since you looked at it, so what is on the screen is no longer what is in the file. Please preview it again, check the figures, and then import.',
        `import file changed on disk between preview and apply: ${path}`
      )
    }

    const result = await excelImportService.applyImport(getDb(), user, buffer)

    log.info(
      `[opening] imported ${basename(path)} by ${user.username} (${user.role}): ` +
        `products +${result.productsCreated}/~${result.productsUpdated} ` +
        `barcodes +${result.barcodesAdded} lookups +${result.lookupsCreated} ` +
        `customers +${result.customersCreated} suppliers +${result.suppliersCreated} ` +
        `stockLines=${result.stockLines} value=${result.summary.stockValueMinor} ` +
        `udhaar=${result.summary.receivablesMinor} dues=${result.summary.payablesMinor} — ` +
        `DRAFT ONLY, not committed`
    )

    // Deliberately still remembered: re-importing the same file is safe (it REPLACES the draft rather
    // than adding to it — regression-tested), and springing a file dialog on a second click would be a
    // worse surprise than doing the harmless thing twice.
    return result
  })

  // ── Customers ─────────────────────────────────────────────────────────────
  // Minimal on purpose: the customer ledger, loyalty and per-customer pricing are Phase 7. Customers
  // exist NOW because opening udhaar has to be owed BY SOMEBODY.
  //
  // THERE IS NO ENDPOINT HERE THAT WRITES A BALANCE, and there never will be. What a customer owes is
  // DERIVED from the ledger, exactly as stock is derived from the movements. `creditLimit` is a
  // different thing: how much udhaar they are ALLOWED to run up. A limit, not a debt.
  //
  // Writes are gated on 'settings.manage' — a cashier cannot invent a customer at the till, which is
  // how udhaar quietly gets written off to "Ali". A new credit customer is added by the owner. Phase 7
  // puts a customer LEDGER in front of a cashier, and that needs its own 'customer.manage' permission in
  // shared/rbac.ts. Opening a gate later is safe; shipping one too wide is not.
  //
  // ── THE READ IS 'sale.create', AND IT HAS TO BE (Phase 5). ─────────────────────────────────────────
  //
  // It was 'report.view' (manager). But CREDIT (UDHAAR) IS A PAYMENT METHOD ON THE TILL, and
  // `selling.requireCustomerForCredit` defaults to ON — so a credit sale must NAME the customer. A
  // cashier who cannot list customers cannot name one, and therefore cannot take udhaar at all: the
  // single most common credit workflow in a Pakistani shop, closed to the only role that mans the till.
  //
  // Main's own contract already assumed this. `sale:outstandingCredit` is gated on 'sale.create' and its
  // doc says "read BEFORE taking a credit sale, so the cashier can see the udhaar before adding to it" —
  // an endpoint that was unreachable, because nothing gave the cashier a customer id to pass it.
  //
  // What this exposes is name, phone, address, type and CREDIT LIMIT — every field a cashier needs to
  // decide whether to give someone credit, and not one figure about what the shop pays for anything.
  // No cost, no margin. (Contrast `products.list`, which carries `costPrice` and therefore stays at
  // 'report.view': a name-search at the till needs its own narrow endpoint, not a wider gate on this one.)
  handle(IPC.customersList, CustomerListInput, (input) => {
    session.requirePermissionOf('sale.create')
    return customersService.list(getDb(), input)
  })

  handle(IPC.customersCreate, CreateCustomerInput, (input) => {
    const user = session.requirePermissionOf('settings.manage')
    assertWritable()
    // The service audits customer.create itself — it has the actor. Do not log it twice here.
    return customersService.create(getDb(), user, input)
  })

  handle(IPC.customersUpdate, UpdateCustomerInput, (input) => {
    const user = session.requirePermissionOf('settings.manage')
    assertWritable()
    // Only the fields the form sent arrive here. The service audits customer.update, with a before/after
    // of exactly the fields that were touched.
    return customersService.update(getDb(), user, input)
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // SELLING — the till
  //
  // THE AUDIT CONTRACT (see ipc/audit-contract.test.ts): services/sales.ts AUDITS ITSELF. It writes
  // sale.discount.over_threshold, sale.price_override, sale.negative_stock, sale.void, sale.reprint and
  // sale.discard from inside its own transactions, where it has the actor and the before/after. So NOT
  // ONE handler below logs a second row. A log that records the same act twice is a log nobody trusts.
  //
  // The one audit row written HERE is drawer.no_sale — because there is no service behind it. The
  // drawer is hardware, and printing/printer.ts has no database.
  //
  // WRITES take assertWritable(). READS do not — an expired shop can still look up a sale, reprint a
  // receipt and export its numbers. It simply cannot ring up new ones. (CLAUDE.md §6)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * THE SCANNER. Gated at `sale.create` — the cashier is the one holding the gun.
   *
   * A READ: no assertWritable(). An unknown barcode comes back as `null`, not an error.
   *
   * Annotated with the SHARED ScannedItem on purpose: `shared/` cannot import from `main/`, so this
   * line is what ties the service's shape to the one the Sell screen is typed against. If the service
   * drifts, the build breaks HERE rather than the till quietly showing a blank price.
   */
  handle<ScanBarcodeInput, ScannedItem | null>(IPC.saleScan, ScanBarcodeInput, (input) => {
    session.requirePermissionOf('sale.create')
    return salesService.scanBarcode(getDb(), input.barcode, {
      ...(input.tier === undefined ? {} : { tier: input.tier }),
      ...(input.customerId === undefined ? {} : { customerId: input.customerId })
    })
  })

  // ── The cart: PURE. No database, no clock, not one row written. ────────────
  //
  // These are here — rather than in the renderer — because `addLine` carries a BUSINESS RULE: scanning
  // the same tin twice bumps the quantity instead of stacking a second row, unless the line carries a
  // discount, an override, a batch or a serial, which are paperwork that must not be folded together.
  // One rule, one place. No assertWritable(): changing an array in memory is not a write, and a cashier
  // at an expired shop may still build a cart — they simply cannot ring it up.

  handle<CartAddLineInput, SaleLineInput[]>(IPC.saleAddLine, CartAddLineInput, (input) => {
    session.requirePermissionOf('sale.create')
    return salesService.addLine(input.cart, input.line)
  })

  handle<CartUpdateLineInput, SaleLineInput[]>(IPC.saleUpdateLine, CartUpdateLineInput, (input) => {
    session.requirePermissionOf('sale.create')
    return salesService.updateLine(input.cart, input.index, input.changes)
  })

  handle<CartRemoveLineInput, SaleLineInput[]>(IPC.saleRemoveLine, CartRemoveLineInput, (input) => {
    session.requirePermissionOf('sale.create')
    return salesService.removeLine(input.cart, input.index)
  })

  // ── Hold, quote, resume, discard ───────────────────────────────────────────

  handle(IPC.saleHold, HoldSaleInput, (input) => {
    const user = session.requirePermissionOf('sale.create')
    assertWritable()
    // No invoice number, no stock movement, no journal. Nothing has happened yet — which is exactly
    // what keeps the numbering gapless.
    return salesService.hold(getDb(), user, input)
  })

  handle(IPC.saleSaveQuote, SaveQuoteInput, (input) => {
    const user = session.requirePermissionOf('sale.create')
    assertWritable()
    return salesService.saveQuote(getDb(), user, input)
  })

  /**
   * Pick a parked cart back up — as CART LINES, ready to ring up.
   *
   * It deliberately does NOT come back as a priced sale. `complete()` RE-PRICES it from the catalog, so
   * a cart parked before this morning's price change is sold at this morning's price. Handing the screen
   * yesterday's frozen prices would be handing it a lie it would then try to charge.
   */
  handle<ResumeSaleInput, SaleLineInput[]>(IPC.saleResume, ResumeSaleInput, (input) => {
    session.requirePermissionOf('sale.create')
    return salesService.toCartLines(salesService.resume(getDb(), input))
  })

  handle(IPC.saleListHeld, ListHeldInput, (input) => {
    session.requirePermissionOf('sale.create')
    return salesService.listHeld(getDb(), input.status)
  })

  handle(IPC.saleDiscard, DiscardSaleInput, (input) => {
    const user = session.requirePermissionOf('sale.create')
    assertWritable()
    // The service audits sale.discard itself — it has the actor and the cart it threw away.
    salesService.discard(getDb(), user, input)
    return true
  })

  /**
   * ═══ RING IT UP ═══════════════════════════════════════════════════════════
   *
   * THE ORDER OF THESE THREE STEPS IS THE WHOLE POINT, AND IT IS NOT NEGOTIABLE.
   *
   *   1. THE SALE COMMITS.  One transaction: the number is drawn, every price/tax/cost is frozen, the
   *      stock moves, the journal balances, the payments are written. If ANY of it fails, ALL of it
   *      rolls back — including the invoice number, which the next sale then takes. There are no gaps.
   *
   *   2. THE RECEIPT PRINTS — or it does not.  The money is already in the books. A jam, an empty
   *      paper roll, a printer someone unplugged: none of them may undo step 1. So printing CANNOT
   *      throw from here. It returns an outcome, and the outcome travels back to the screen as DATA on
   *      a SUCCESSFUL call.
   *
   *   3. THE DRAWER OPENS — on a cash sale, if the shop has it switched on. Same rule: it cannot fail
   *      the sale.
   *
   * The cashier therefore sees "Sale saved — the receipt did not print. [Print again]" and NEVER a red
   * error box, because a red box after a customer has handed over Rs 5000 makes a cashier take the
   * money back out of the till and ring it up a second time.
   */
  handle<CompleteSaleInput, CompleteSaleResponse>(
    IPC.saleComplete,
    CompleteSaleInput,
    async (input) => {
      const user = session.requirePermissionOf('sale.create')
      assertWritable()

      const db = getDb()

      // 1. THE SALE. Everything that can refuse this sale refuses it in here — the discount threshold,
      // the negative-stock rule, the credit limit, the price-override role, a locked period. The
      // service also writes every audit row this sale needs. If it throws, nothing happened.
      const result = salesService.complete(db, user, input)

      log.info(
        `[sale] ${result.sale.invoiceNo} completed by ${user.username} (${user.role}): ` +
          `${result.sale.lines.length} line(s) total=${result.sale.grandTotal} ` +
          `paid=${result.sale.paidTotal} change=${result.sale.changeDue} ` +
          `journal=${result.journalId}` +
          (result.sale.hadNegativeStock ? ' — SOLD BELOW ZERO STOCK' : '')
      )

      // 2. and 3. Hardware. FROM HERE NOTHING MAY THROW — the sale is in the books.
      const print = await printer.printReceipt(result.receipt, printOptions(db))
      const drawer = await kickDrawerForSale(db, result.sale)

      return { sale: result.sale, journalId: result.journalId, print, drawer }
    }
  )

  /**
   * VOID. SUPERVISOR ONLY — and the check is here, in MAIN, not in a hidden button.
   *
   * `requirePermissionOf('sale.void')` asks about the user who is SIGNED IN. A cashier who needs a void
   * gets a supervisor to sign in (PIN quick-switch), which is the same act as a supervisor turning the
   * key — and it puts the supervisor's own name and role on the audit row, which is the entire point of
   * requiring one. The service re-checks the role independently; the two agree.
   *
   * The service posts the reversing journal, puts the stock back at the cost it left at, and audits
   * `sale.void` with the reason. The sale KEEPS its invoice number, forever.
   */
  handle(IPC.saleVoid, VoidSaleInput, (input) => {
    const user = session.requirePermissionOf('sale.void')
    assertWritable()
    return salesService.voidSale(getDb(), user, input)
  })

  // ── Reading sales ─────────────────────────────────────────────────────────
  // All READS. No assertWritable(): an expired shop can still look up every sale it ever made and get
  // its numbers out. We warn them; we do not hold their books hostage. (CLAUDE.md §6)

  /**
   * The whole shop's takings, paginated. `report.view` — a MANAGER's view.
   *
   * Deliberately a wider gate than the two lookups below it: browsing every sale in the shop, by every
   * cashier, with totals, is a report. Opening a gate later is safe; shipping one too wide is not.
   */
  handle(IPC.saleList, SaleListInput, (input) => {
    session.requirePermissionOf('report.view')
    return salesService.list(getDb(), input)
  })

  /**
   * ONE sale. `sale.create` — a CASHIER's gate, and deliberately so: this and `getByInvoiceNo` are what
   * the returns desk and the reprint button are built on. A cashier holding a customer's receipt must be
   * able to look that sale up. They still cannot browse the shop's takings — that is `saleList` above.
   */
  handle(IPC.saleGet, SaleGetInput, (input) => {
    session.requirePermissionOf('sale.create')
    return salesService.getById(getDb(), input)
  })

  handle(IPC.saleGetByInvoiceNo, SaleByInvoiceNoInput, (input) => {
    session.requirePermissionOf('sale.create')
    return salesService.getByInvoiceNo(getDb(), input)
  })

  /** The customer's udhaar, read BEFORE a credit sale is taken — so the cashier sees it first. */
  handle(IPC.saleOutstandingCredit, OutstandingCreditInput, (input) => {
    session.requirePermissionOf('sale.create')
    return salesService.outstandingCredit(getDb(), input.customerId)
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // PRINTING & THE CASH DRAWER
  //
  // NEITHER OF THESE CALLS assertWritable(), and that is a decision, not an oversight.
  //
  // The line between a "read" and a "write" in this app is whether it changes THE BOOKS — money, stock,
  // the ledger. It is not "does it touch any table at all": a reprint writes an audit row, and a reprint
  // is manifestly an export, which read-only mode exists to PROTECT (CLAUDE.md §6).
  //
  //   printReceipt   Reprinting a receipt for the customer in front of you is an export of a sale that
  //                  already happened. Blocking it would hold their own records hostage.
  //   openDrawer     Opens a physical box with the shop's OWN CASH in it. It posts no journal, moves no
  //                  stock and changes no total. Refusing to let a shopkeeper open his till because his
  //                  licence lapsed is the hostage behaviour §6 forbids, in its most literal form — and
  //                  the drawer has a key on the front anyway. It stays supervisor-gated and audited.
  //
  // On an expired licence no sale can complete, so the automatic cash-sale kick never fires. The only
  // remaining door into the drawer is the supervisor-authorised, audited no-sale — which is exactly the
  // control we want.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * PRINT, OR REPRINT, THE RECEIPT FOR A SALE.
   *
   * IT TAKES A SALE ID, NOT A RECEIPT. Main reads the sale from the database and builds the paper from
   * the FROZEN line columns. A "print this ReceiptData" endpoint would let a tampered renderer print a
   * receipt for a sale that never happened, with any total it liked, on the shop's own paper.
   *
   * `isDuplicate` (the default) stamps it DUPLICATE and writes the `sale.reprint` audit row inside the
   * service — because "just print it again" is how one sale's receipt ends up in two customers' hands.
   *
   * A failure comes back as `{ ok: true, data: { printed: false, problem } }`. The sale is not at stake.
   */
  handle<PrintReceiptInput, PrintOutcome>(IPC.printReceipt, PrintReceiptInput, async (input) => {
    const user = session.requirePermissionOf('sale.create')
    // ALWAYS a duplicate. The renderer cannot ask for an un-stamped, un-audited original — see
    // PrintReceiptInput. The only original is the one sale:complete prints as it creates the sale.
    return printSaleReceipt(getDb(), user, input.id, true)
  })

  /**
   * OPENING THE TILL WITH NO SALE BEHIND IT.
   *
   * A CLASSIC THEFT VECTOR (PLAN.md §4), and it is treated as one:
   *
   *   the `drawer.no_sale` permission  — SUPERVISOR and above. A cashier cannot do this alone.
   *   a reason code from the lookups   — checked against the ACTIVE `no_sale_reason` rows.
   *   an audit row, ALWAYS             — who, when, and why.
   *
   * THE AUDIT ROW IS WRITTEN BEFORE THE DRAWER IS ASKED TO OPEN, and it is written even if the drawer
   * then does not open. The event being recorded is that a supervisor AUTHORISED the till to be opened
   * with no sale — that is the thing an owner reads this log to find. Whether the solenoid fired is a
   * hardware detail, and a drawer that "did not open" is not an alibi.
   */
  handle<OpenDrawerInput, DrawerOutcome>(IPC.printOpenDrawer, OpenDrawerInput, async (input) => {
    const user = session.requirePermissionOf('drawer.no_sale')
    const db = getDb()

    assertNoSaleReason(db, input.reasonCode)

    auditService.record(db, user, {
      action: 'drawer.no_sale',
      entity: 'drawer',
      reasonCode: input.reasonCode,
      ...(input.reasonText == null ? {} : { reasonText: input.reasonText })
    })

    log.warn(
      `[drawer] NO-SALE open by ${user.username} (${user.role}) — reason: ${input.reasonCode}`
    )

    return printer.openCashDrawer({
      kickCode: settingsService.get<string>(db, 'drawer.kickCode', ''),
      printerName: settingsService.get<string>(db, 'printer.name', '')
    })
  })

  /** The Settings dropdown, so the owner PICKS their printer rather than mistyping its name. */
  handle<void, PrinterInfo[]>(IPC.printListPrinters, null, () => {
    session.requirePermissionOf('settings.manage')
    return printer.listPrinters()
  })
}
