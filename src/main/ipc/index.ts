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
  SupplierDeactivateInput,
  SupplierBalanceInput,
  SupplierPaymentGetInput,
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
  PrintQuotationInput,
  ReturnableLinesInput,
  ReturnablePurchaseLinesInput,
  CustomerDeactivateInput,
  CustomerBalanceInput,
  UserListInput,
  CreateUserInput,
  UpdateUserInput,
  SetUserPasswordInput,
  SetUserPinInput,
  UserIdInput,
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
  type PrinterInfo,
  type CustomerWithBalance
} from '@shared/ipc'
import {
  CompleteSaleInput,
  DiscardSaleInput,
  HoldSaleInput,
  PreviewPromotionsInput,
  ResumeSaleInput,
  SaleByInvoiceNoInput,
  SaleGetInput,
  SaleListInput,
  SaleQuotationInput,
  SaveQuoteInput,
  VoidSaleInput,
  type SaleDetail,
  type SaleLineInput
} from '@shared/sales'
import { CreateReturnInput, ListReturnsInput, GetReturnInput } from '@shared/returns'
import {
  OpenShiftInput,
  CloseShiftInput,
  CashMovementInput,
  ListShiftsInput,
  GetShiftInput
} from '@shared/shifts'
import {
  CommitOpeningInput,
  CustomerGetInput,
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
  UpdateOpeningStockLineInput
} from '@shared/opening'
// The canonical Phase-7 customer schemas — the create/update ones carry the new profile fields
// (business_name, tax_number, notes, price_tier) that the old '@shared/opening' minimal schemas would
// silently STRIP before they ever reached the service. The ledger + payment schemas are new here.
import {
  CreateCustomerInput,
  UpdateCustomerInput,
  CustomerLedgerInput,
  RecordCustomerPaymentInput,
  type CustomerLedgerPage,
  type CustomerPayment
} from '@shared/customers'
// The BUYING contract — the mirror of customers + sales. The supplier record, the goods-received note and
// the running payable statement. These are the SINGLE home of the supplier record schemas now that the
// duplicate product-supplier CRUD in '@shared/catalog' is gone, so no aliasing is needed any more.
import {
  SupplierInput,
  UpdateSupplierInput,
  SupplierListInput,
  SupplierGetInput,
  RecordSupplierPaymentInput,
  SupplierLedgerInput,
  type SupplierPayment,
  type SupplierLedgerPage,
  type SupplierWithBalance
} from '@shared/suppliers'
import {
  CreatePurchaseInput,
  ListPurchasesInput,
  GetPurchaseInput,
  VoidPurchaseInput
} from '@shared/purchases'
import {
  CreatePurchaseReturnInput,
  ListPurchaseReturnsInput,
  GetPurchaseReturnInput
} from '@shared/purchase-returns'
import { CreateExpenseInput, ListExpensesInput, GetExpenseInput } from '@shared/expenses'
import { AdjustPointsInput, LoyaltyBalanceInput, LoyaltyHistoryInput } from '@shared/loyalty'
import {
  CreatePromotionInput,
  DeactivatePromotionInput,
  GetPromotionInput,
  ListPromotionRulesInput,
  ListPromotionsInput,
  SetPromotionRulesInput,
  UpdatePromotionInput,
  type PromotionDetail
} from '@shared/promotions'
// CLOSING THE MONTH. The lock has been enforced since migration 0002; these are the door to it.
import { ListPeriodsInput, LockPeriodInput, UnlockPeriodInput } from '@shared/periods'
// THE COUNTING SHEET (migration 0019). A line carries a product and a count — never the expected
// figure, the variance, the cost, a date or a user. MAIN freezes all of those.
import {
  AddStockTakeLinesInput,
  ApplyStockTakeInput,
  CancelStockTakeInput,
  CreateStockTakeInput,
  ListStockTakesInput,
  RemoveStockTakeLineInput,
  SetCountInput,
  StockTakeIdInput
} from '@shared/stock-take'
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
  SaveProductSupplierInput,
  DeleteProductSupplierInput,
  CreateBatchInput,
  BatchListInput,
  type PagedResult
} from '@shared/catalog'
import { ok, err, AppError, ErrorCode, type Result } from '@shared/result'
import { ReportRequest } from '@shared/reports'
import { REPORT_TITLES, type ReportPayload } from '@shared/report-export'
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
import * as customerLedgerService from '../services/customer-ledger'
import * as suppliersService from '../services/suppliers'
import * as purchasesService from '../services/purchases'
import * as supplierLedgerService from '../services/supplier-ledger'
import * as usersService from '../services/users'
import * as excelTemplateService from '../services/excel-template'
import * as excelImportService from '../services/excel-import'
import * as salesService from '../services/sales'
import * as returnsService from '../services/returns'
import * as purchaseReturnsService from '../services/purchase-returns'
import * as shiftsService from '../services/shifts'
import * as expensesService from '../services/expenses'
import * as loyaltyService from '../services/loyalty'
import * as promotionsService from '../services/promotions'
import * as periodsService from '../services/periods'
import * as stockTakeService from '../services/stock-take'
import * as printer from '../printing/printer'
import * as reportsService from '../services/reports'
import { reportToXlsxBuffer } from '../services/reports-excel'
import { reportToPdfBuffer } from '../services/reports-pdf'
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
// REPORT EXPORTS — the owner picks where the .xlsx / .pdf goes, MAIN writes it
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * A report file name the owner can find again: "Sales Summary - 2026-07-15.xlsx". The title comes from
 * the one data-driven `REPORT_TITLES` map (so a screen, a sheet and a file all say the same thing), with
 * the characters Windows forbids in a filename (`\ / : * ? " < > |`) swapped for spaces.
 */
function reportFileName(kind: ReportPayload['kind'], ext: 'xlsx' | 'pdf', now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const safeTitle = REPORT_TITLES[kind].replace(/[\\/:*?"<>|]/g, ' ')
  return `${safeTitle} - ${day}.${ext}`
}

/**
 * Let the owner choose WHERE to save an exported report, then write it there. Returns the saved path, or
 * null if they closed the dialog — not an error, a Tuesday.
 *
 * THE RENDERER NEVER NAMES A PATH (CLAUDE.md §3): main opens the save dialog and owns the filesystem, the
 * same rule the Excel-template export follows. The buffer is built AFTER the dialog is confirmed, so a
 * cancelled export never pays for the render — a PDF spins up a headless window, which is not free.
 */
async function saveReportFile(
  defaultFileName: string,
  filter: { name: string; extensions: string[] },
  build: () => Promise<Buffer>
): Promise<string | null> {
  const options: SaveDialogOptions = {
    title: 'Save report',
    defaultPath: join(app.getPath('documents'), defaultFileName),
    filters: [filter],
    buttonLabel: 'Save report'
  }

  const window = BrowserWindow.getFocusedWindow()
  const chosen = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options)

  if (chosen.canceled || !chosen.filePath) return null

  writeFileSync(chosen.filePath, await build())
  return chosen.filePath
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
 * Build the QUOTATION from the DATABASE and print it. Never throws — same contract as the receipt above,
 * and for a gentler reason: nothing is at stake but paper. No money has been taken and no number drawn.
 *
 * `quotationFor()` REFUSES anything that is not a quote — a completed sale gets a receipt, not an offer
 * with a validity date stapled to money the shop has already banked. That check lives in the service, so
 * the paper and the refusal come from the same call.
 */
async function printSaleQuotation(
  db: ReturnType<typeof getDb>,
  actor: Parameters<typeof salesService.quotationFor>[1],
  saleId: number
): Promise<PrintOutcome> {
  try {
    const quotation = salesService.quotationFor(db, actor, { id: saleId })
    return await printer.printQuotation(quotation, printOptions(db))
  } catch (error) {
    const technical = error instanceof Error ? error.message : String(error)
    log.error(`[printer] could not build the quotation for sale ${saleId}: ${technical}`)

    return {
      printed: false,
      copies: 0,
      printerName: null,
      problem:
        'The quotation is saved, but it could not be prepared for printing. Please try again from the Quotations list.'
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

  // ── The product↔supplier LINK (the "Multiple Suppliers" panel) ─────────────
  // The supplier RECORD's create/update/get/list are the canonical `supplier:*` handlers further down.
  // These three touch ONLY product_suppliers — the code and price THIS supplier uses for THIS product.
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

  // ═══════════════════════════════════════════════════════════════════════════
  // CUSTOMERS & THE UDHAAR LEDGER (Phase 7)
  //
  // WHAT A CUSTOMER OWES IS DERIVED, NEVER STORED — opening udhaar + credit sales − payments, exactly as
  // stock is the sum of its movements. No handler here writes a balance. `balance`, `listWithBalances`
  // and `ledger` all recompute on read, and they can never disagree with the credit-limit check on the
  // till because they share ONE function — sales.outstandingCredit — which is the literal trap #17.
  //
  // PERMISSIONS — and why they are deliberately NOT uniform:
  //
  //   list, get            'sale.create'.  The TILL needs these. Credit (udhaar) is a payment method and
  //                        `selling.requireCustomerForCredit` defaults ON, so a credit sale must NAME the
  //                        customer — a cashier who cannot look one up cannot take udhaar, the commonest
  //                        credit workflow in a Pakistani shop. They expose name/phone/address/type and
  //                        CREDIT LIMIT — nothing about what the shop pays. `get` shows STRICTLY LESS than
  //                        `list` (one row), so it is not gated tighter than `list`.
  //   listWithBalances,    'report.view'.  These expose what customers OWE — the aging of the shop's
  //   ledger, balance       receivables, manager-level report data, not a till lookup.
  //   create/update/       'settings.manage' (owner).  Kept from the existing gate: a cashier must not be
  //   deactivate           able to invent a customer at the till and quietly write udhaar off to "Ali".
  //                        The finer gate this really wants is a 'customer.manage' (manager) permission in
  //                        shared/rbac.ts — out of this task's file scope. Add it later and relax these to
  //                        it. Opening a gate later is safe; shipping one too wide is not.
  //   recordPayment        'sale.create'.  The cashier at the counter takes the repayment. It posts a real
  //                        journal (DR Cash raises the drawer's EXPECTED cash) and is audited — a faked
  //                        payment cannot make udhaar vanish without also making the till short.
  //
  // The services audit their own writes (customer.create/update, customer.payment). No handler double-logs.
  // WRITES call assertWritable(); an expired shop can still list, read a ledger and export — never ring up.
  // ═══════════════════════════════════════════════════════════════════════════

  handle(IPC.customersList, CustomerListInput, (input) => {
    session.requirePermissionOf('sale.create')
    return customersService.list(getDb(), input)
  })

  // Annotated with the SHARED result type: `shared/` cannot import from `main/`, so this line ties the
  // service's CustomerWithBalance to the one the screen is typed against. Drift breaks the build here.
  handle<CustomerListInput, PagedResult<CustomerWithBalance>>(
    IPC.customersListWithBalances,
    CustomerListInput,
    (input) => {
      session.requirePermissionOf('report.view')
      return customerLedgerService.listWithBalances(getDb(), input)
    }
  )

  handle(IPC.customersGet, CustomerGetInput, (input) => {
    session.requirePermissionOf('sale.create')
    return customersService.getById(getDb(), input.id)
  })

  handle(IPC.customersCreate, CreateCustomerInput, (input) => {
    const user = session.requirePermissionOf('settings.manage')
    assertWritable()
    // Validated with the CANONICAL '@shared/customers' schema, so the new profile fields (business name,
    // tax number, notes, price tier) actually flow through. The service audits customer.create itself.
    return customersService.create(getDb(), user, input)
  })

  handle(IPC.customersUpdate, UpdateCustomerInput, (input) => {
    const user = session.requirePermissionOf('settings.manage')
    assertWritable()
    // Only the fields the form sent arrive here (trap #18). The service audits customer.update, with a
    // before/after of exactly the fields that were touched.
    return customersService.update(getDb(), user, input)
  })

  handle(IPC.customersDeactivate, CustomerDeactivateInput, (input) => {
    const user = session.requirePermissionOf('settings.manage')
    assertWritable()
    // Retire, never delete — the service flips is_active via the same audited update path.
    return customersService.deactivate(getDb(), user, input.id)
  })

  handle<CustomerLedgerInput, CustomerLedgerPage>(
    IPC.customersLedger,
    CustomerLedgerInput,
    (input) => {
      session.requirePermissionOf('report.view')
      return customerLedgerService.ledger(getDb(), input)
    }
  )

  handle<CustomerBalanceInput, number>(IPC.customersBalance, CustomerBalanceInput, (input) => {
    session.requirePermissionOf('report.view')
    return customerLedgerService.balance(getDb(), input.customerId)
  })

  handle<RecordCustomerPaymentInput, CustomerPayment>(
    IPC.customersRecordPayment,
    RecordCustomerPaymentInput,
    (input) => {
      const user = session.requirePermissionOf('sale.create')
      assertWritable()
      // ONE transaction: customer_payments row → DR Cash/Bank · CR Receivable → audit 'customer.payment'.
      // The service does it all and audits itself — do not log a second row here.
      return customerLedgerService.recordPayment(getDb(), user, input)
    }
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // BUYING — suppliers, purchases (goods-received notes) and the supplier ledger
  //
  // The mirror of the customers + selling side, pointing the other way: a supplier is OWED BY the shop
  // where a customer OWES it. WHAT THE SHOP OWES A SUPPLIER IS DERIVED, NEVER STORED — opening payable +
  // Σ (purchase.grand_total − paid_total) − Σ supplier_payments, exactly as stock is the sum of its
  // movements. No handler here writes a balance: `balance`, `listWithBalances` and `ledger` all recompute
  // on read (CLAUDE.md trap #17), and they reconcile to the paisa with GL Accounts Payable.
  //
  // The services AUDIT THEMSELVES (supplier.create/update, purchase.create, supplier.payment) from inside
  // their own transactions, where they hold the actor and the before/after — so NOT ONE handler below
  // logs a second row. A log that records the same act twice is a log nobody trusts.
  //
  // PERMISSIONS (rbac.ts) — the Manager owns products and purchases, so buying is a manager's job:
  //   supplier.manage   create / update / retire a supplier          (WRITES)
  //   supplier.view     read the supplier record, ledger, balances   (reads)
  //   purchase.manage   receive goods — create a purchase / GRN       (WRITE)
  //   purchase.view     read the purchase history                    (reads)
  //   supplier.pay      pay down what the shop owes a supplier        (WRITE)
  //
  // WRITES call assertWritable(): an expired shop cannot receive goods or pay a supplier until it renews.
  // READS do not — it can still list its suppliers, read a statement and export what it owes. (CLAUDE.md §6)
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Suppliers ──────────────────────────────────────────────────────────────
  handle(IPC.supplierCreate, SupplierInput, (input) => {
    const user = session.requirePermissionOf('supplier.manage')
    assertWritable()
    // The service audits supplier.create itself — it has the actor. Do not log it twice here.
    return suppliersService.create(getDb(), user, input)
  })

  handle(IPC.supplierUpdate, UpdateSupplierInput, (input) => {
    const user = session.requirePermissionOf('supplier.manage')
    assertWritable()
    // Only the fields the form actually sent arrive here (trap #18). The service audits supplier.update.
    return suppliersService.update(getDb(), user, input)
  })

  handle(IPC.supplierDeactivate, SupplierDeactivateInput, (input) => {
    const user = session.requirePermissionOf('supplier.manage')
    assertWritable()
    // Retire, never delete — last year's purchase and this supplier's opening payable point at the row.
    // The service flips is_active through the same audited update path.
    return suppliersService.deactivate(getDb(), user, input.id)
  })

  handle(IPC.supplierGet, SupplierGetInput, (input) => {
    session.requirePermissionOf('supplier.view')
    return suppliersService.getById(getDb(), input.id)
  })

  handle(IPC.supplierList, SupplierListInput, (input) => {
    session.requirePermissionOf('supplier.view')
    return suppliersService.list(getDb(), input)
  })

  // ── Purchases — a goods-received note ──────────────────────────────────────
  handle(IPC.purchaseCreate, CreatePurchaseInput, (input) => {
    const user = session.requirePermissionOf('purchase.manage')
    assertWritable()
    // ONE transaction: stock in at the landed cost (re-averaging the weighted cost), one balanced journal
    // (DR Inventory/Input Tax, CR tenders/Payable), audit purchase.create. The service does it all and
    // audits itself — do not log a second row here.
    return purchasesService.createPurchase(getDb(), user, input)
  })

  handle(IPC.purchaseList, ListPurchasesInput, (input) => {
    session.requirePermissionOf('purchase.view')
    return purchasesService.listPurchases(getDb(), input)
  })

  handle(IPC.purchaseGet, GetPurchaseInput, (input) => {
    session.requirePermissionOf('purchase.view')
    return purchasesService.getPurchase(getDb(), input.id)
  })

  /**
   * CANCEL A WRONGLY-KEYED BILL. MANAGER ONLY — and the check is here, in MAIN, not in a hidden button.
   *
   * `sales.voidSale` pointing the other way. The service takes the stock back off at each ORIGINAL
   * movement's own frozen unit_cost (never today's weighted average), contra-posts the journal by
   * mirroring the original's own lines, MARKS the document rather than deleting it, and audits
   * `purchase.void` with a reason code from the owner's own void_reason list. The bill KEEPS its number
   * and every line, forever.
   *
   * It refuses — with a shopkeeper-readable sentence each time — a bill that has already been paid (a
   * contra cannot un-spend real money; record a supplier return instead), one with goods already
   * returned against it, one already cancelled, and a locked month. The service re-checks the role
   * independently; the two agree.
   */
  handle(IPC.purchaseVoid, VoidPurchaseInput, (input) => {
    const user = session.requirePermissionOf('purchase.void')
    assertWritable()
    return purchasesService.voidPurchase(getDb(), user, input)
  })

  // ── Returns to supplier — goods going BACK, and the credit that follows ─────
  //
  // The mirror of the `returns:*` handlers below, pointing the other way. THE RENDERER SENDS INTENT,
  // MAIN DECIDES THE MONEY: a line says WHICH purchase line the goods came in on and HOW MANY go back —
  // never what they are worth. The service copies the purchase line's FROZEN 4-dp unit_cost, records the
  // negative movement at THAT cost onto the batch the goods arrived on, reads the movement's own frozen
  // value back as the line total, hands the input tax back pro-rata, posts ONE balanced journal
  // (CR Inventory + CR Input Tax, DR Payable or the refund tender) and AUDITS ITSELF with
  // 'purchase.return' — so NOT ONE handler here logs a second row (ipc/audit-contract.test.ts).
  //
  //   create   'purchaseReturn.manage' — a manager's job, like the purchase it reverses — AND
  //            assertWritable(): an expired shop cannot send goods back until it renews.
  //   reads    'purchase.view' and NOTHING else. No assertWritable() — an expired shop must still look a
  //            bill up and browse what it sent back. Its data is never hostage. (CLAUDE.md §6)

  handle(IPC.purchaseReturnCreate, CreatePurchaseReturnInput, (input) => {
    const user = session.requirePermissionOf('purchaseReturn.manage')
    assertWritable()
    // ONE transaction: the negative movements at the frozen cost, the pro-rata input tax, the balanced
    // journal, audit 'purchase.return'. The service does it all and audits itself — no second row here.
    return purchaseReturnsService.createPurchaseReturn(getDb(), user, input)
  })

  /**
   * What can still go back on a purchase: received / already returned / returnable per line, with the
   * frozen cost the goods will leave at. 'purchase.view' — the same gate as `purchase:get`, which this
   * is built on: reading a bill back is reading a bill back.
   */
  handle(IPC.purchaseReturnReturnableLines, ReturnablePurchaseLinesInput, (input) => {
    session.requirePermissionOf('purchase.view')
    return purchaseReturnsService.returnablePurchaseLines(getDb(), input.purchaseId)
  })

  handle(IPC.purchaseReturnList, ListPurchaseReturnsInput, (input) => {
    session.requirePermissionOf('purchase.view')
    return purchaseReturnsService.listPurchaseReturns(getDb(), input)
  })

  handle(IPC.purchaseReturnGet, GetPurchaseReturnInput, (input) => {
    session.requirePermissionOf('purchase.view')
    return purchaseReturnsService.getPurchaseReturn(getDb(), input)
  })

  // ── The supplier ledger — the running account, and the dues paid back ──────
  // Annotated with the SHARED result types on purpose (the customer-ledger pattern): the annotation ties
  // each handler to the '@shared/suppliers' shape the screen is typed against, so a service that ever
  // drifted would break the build HERE rather than the statement rendering a blank column.
  handle<SupplierListInput, PagedResult<SupplierWithBalance>>(
    IPC.supplierLedgerListWithBalances,
    SupplierListInput,
    (input) => {
      session.requirePermissionOf('supplier.view')
      return supplierLedgerService.listWithBalances(getDb(), input)
    }
  )

  handle<SupplierLedgerInput, SupplierLedgerPage>(
    IPC.supplierLedgerLedger,
    SupplierLedgerInput,
    (input) => {
      session.requirePermissionOf('supplier.view')
      return supplierLedgerService.ledger(getDb(), input)
    }
  )

  handle<SupplierBalanceInput, number>(IPC.supplierLedgerBalance, SupplierBalanceInput, (input) => {
    session.requirePermissionOf('supplier.view')
    return supplierLedgerService.balance(getDb(), input.supplierId)
  })

  handle<RecordSupplierPaymentInput, SupplierPayment>(
    IPC.supplierLedgerRecordPayment,
    RecordSupplierPaymentInput,
    (input) => {
      const user = session.requirePermissionOf('supplier.pay')
      assertWritable()
      // ONE transaction: supplier_payments row → DR Accounts Payable · CR Cash/Bank → audit
      // 'supplier.payment'. The service does it all and audits itself — do not log a second row here.
      return supplierLedgerService.recordPayment(getDb(), user, input)
    }
  )

  handle<SupplierPaymentGetInput, SupplierPayment>(
    IPC.supplierLedgerGetPayment,
    SupplierPaymentGetInput,
    (input) => {
      session.requirePermissionOf('supplier.view')
      return supplierLedgerService.getPayment(getDb(), input.id)
    }
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // USERS & ROLES — OWNER ONLY
  //
  // Every handler is gated 'user.manage' (owner) in MAIN — the renderer is not a security boundary
  // (CLAUDE.md §4). The service audits every write (user.create / update / set_password / set_pin /
  // clear_pin / deactivate / reactivate) with the actor's name and role, and NEVER writes a password or
  // PIN into the row — so no handler logs a second time. A user is NEVER deleted: retire and restore, so
  // last year's sale keeps a name on it. The service refuses any write that would leave the shop with no
  // active owner.
  //
  // WRITES call assertWritable(): an expired shop cannot hire, retire or re-PIN staff until it renews.
  // `list` is a READ and does not — the owner can still see who holds the keys to the shop.
  // ═══════════════════════════════════════════════════════════════════════════

  handle(IPC.usersList, UserListInput, (input) => {
    session.requirePermissionOf('user.manage')
    return usersService.list(getDb(), input.page, input.pageSize)
  })

  handle(IPC.usersCreate, CreateUserInput, (input) => {
    const actor = session.requirePermissionOf('user.manage')
    assertWritable()
    return usersService.create(getDb(), actor, input)
  })

  handle(IPC.usersUpdate, UpdateUserInput, (input) => {
    const actor = session.requirePermissionOf('user.manage')
    assertWritable()
    // `id` names the user; only the other fields the form sent are the changes (trap #18).
    const { id, ...changes } = input
    return usersService.update(getDb(), actor, id, changes)
  })

  handle(IPC.usersSetPassword, SetUserPasswordInput, (input) => {
    const actor = session.requirePermissionOf('user.manage')
    assertWritable()
    return usersService.setPassword(getDb(), actor, input.id, input.password)
  })

  handle(IPC.usersSetPin, SetUserPinInput, (input) => {
    const actor = session.requirePermissionOf('user.manage')
    assertWritable()
    // pin === null CLEARS it. Digits + exact length are checked by the service against security.pinLength.
    return usersService.setPin(getDb(), actor, input.id, input.pin)
  })

  handle(IPC.usersDeactivate, UserIdInput, (input) => {
    const actor = session.requirePermissionOf('user.manage')
    assertWritable()
    return usersService.deactivate(getDb(), actor, input.id)
  })

  handle(IPC.usersReactivate, UserIdInput, (input) => {
    const actor = session.requirePermissionOf('user.manage')
    assertWritable()
    return usersService.reactivate(getDb(), actor, input.id)
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

  // WHICH OF THE SHOP'S OWN OFFERS WOULD FIRE ON THIS CART, AND WHAT THEY WOULD GIVE (migration 0018).
  //
  // A LOOK, NOT A SALE — it writes nothing, so no assertWritable(): a cashier at an expired shop may
  // still build a cart and see its offers, they simply cannot ring it up (CLAUDE.md §6). MAIN computes
  // the discount through the very same `priceCart` that freezes the sale, and `sale:complete` resolves
  // the offers AGAIN for itself when the money is actually taken. The renderer never computes a
  // promotion discount — one that could would be one that could sell at any price it liked.
  handle(IPC.salePreviewPromotions, PreviewPromotionsInput, (input) => {
    const user = session.requirePermissionOf('sale.create')
    return salesService.previewPromotions(getDb(), user, input)
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

  /**
   * THE OFFER, AS DATA. A READ — no assertWritable().
   *
   * Nothing about it changes the books: a quote draws no number, moves no stock and posts no journal, so
   * there is nothing for read-only mode to protect. An expired shop showing a customer a quote it already
   * saved is the export §6 explicitly keeps working; refusing it would hold their own offer hostage.
   *
   * `sale.create` — the CASHIER's gate, matching `sale:get`, which this is the quote-shaped twin of. The
   * cashier who saved the quote is the one standing in front of the customer asking for it back.
   *
   * The service refuses anything that is not a quote. That check is in MAIN, not here and not in the UI.
   */
  handle(IPC.saleQuotation, SaleQuotationInput, (input) => {
    const user = session.requirePermissionOf('sale.create')
    return salesService.quotationFor(getDb(), user, input)
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // RETURNS — goods coming BACK, and the money that goes back with them
  //
  // The inverse of a sale, and it obeys the same disciplines. THE RENDERER SENDS INTENT, MAIN DECIDES
  // THE MONEY: a return line says WHICH sale line came back and HOW MANY — never what to refund. The
  // service reads the FROZEN net/tax/cost off the original sale line, scales them, posts the balanced
  // journal and the restock movement, and AUDITS ITSELF with `sale.return` — so NOT ONE handler below
  // logs a second row (the same contract the sales handlers keep; see ipc/audit-contract.test.ts).
  //
  // The asymmetry that runs through the whole app (CLAUDE.md §6):
  //   create        SUPERVISOR gate AND assertWritable() — an expired shop cannot refund until it renews.
  //   the three reads  a permission and NOTHING else. An expired shop can still look a sale up to return
  //                    against, browse its returns and reprint a credit note — its data is never hostage.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * PROCESS A RETURN. SUPERVISOR ONLY — the same gate, and the same shape, as `sale:void`.
   *
   * `requirePermissionOf('sale.refund')` asks about the user who is SIGNED IN. A cashier who needs to
   * process a return gets a supervisor to sign in (PIN quick-switch) — the same act as a supervisor
   * turning the key — which puts the supervisor's own name and role on the return and on the audit row.
   * The service re-checks the role independently and FREEZES the refund from the original sale, so a
   * tampered renderer cannot refund a Rs 200,000 television for one rupee behind a balanced journal.
   */
  handle(IPC.returnsCreate, CreateReturnInput, (input) => {
    const user = session.requirePermissionOf('sale.refund')
    assertWritable()
    return returnsService.createReturn(getDb(), user, input)
  })

  // ── Reading returns ─────────────────────────────────────────────────────────
  // All READS. No assertWritable(): an expired shop can still look a sale up, browse its returns and
  // export its numbers. It simply cannot refund a new one. (CLAUDE.md §6)

  /**
   * THE RETURNS DESK'S FIRST MOVE: look a sale up — by its id, or by the number printed on the
   * customer's receipt — and show, per line, what may still come back. `sale.create` — a CASHIER's
   * gate, exactly like the `sale:get` / `sale:getByInvoiceNo` reads this is built on: a cashier holding
   * a receipt must be able to look the sale up. The refund itself still needs a supervisor above.
   */
  handle(IPC.returnsReturnableLines, ReturnableLinesInput, (input) => {
    session.requirePermissionOf('sale.create')
    return returnsService.returnableLines(getDb(), input.ref)
  })

  /**
   * THE RETURNS LIST — paginated and indexed. `report.view`, a MANAGER's view, matching `sale:list`:
   * browsing every return the shop has made, with totals, is a report, not a till lookup.
   */
  handle(IPC.returnsList, ListReturnsInput, (input) => {
    session.requirePermissionOf('report.view')
    return returnsService.listReturns(getDb(), input)
  })

  /**
   * ONE return, with its lines — the return detail screen and the credit note. `sale.create`, matching
   * `sale:get`: a cashier reprinting a customer's credit note must be able to read it back.
   */
  handle(IPC.returnsGet, GetReturnInput, (input) => {
    session.requirePermissionOf('sale.create')
    return returnsService.getReturn(getDb(), input)
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
   * PRINT THE QUOTATION FOR A QUOTE — the thing a quote could not do before.
   *
   * IT TAKES A SALE ID, NOT A QUOTATION, exactly as printReceipt does: main reads the quote from the
   * database and builds the paper from the frozen lines. A tampered renderer cannot print its own prices
   * on the shop's paper and call it the shop's offer.
   *
   * NO assertWritable(), for the same reason the receipt reprint has none — and less is at stake here
   * than there. Handing a customer a quote takes no money, moves no stock and posts no journal; it is an
   * export of something the shop already saved. (See the block comment above.)
   *
   * NOT AUDITED, and that is deliberate. A reprint is logged because "print it again" is how ONE SALE'S
   * receipt reaches two customers' hands — there is a number and money behind it to be double-claimed.
   * An offer has neither. Printing it twice is a shopkeeper handing out a second price list.
   *
   * `printed: false` is not an error. The quote is saved regardless; the screen offers Print again.
   */
  handle<PrintQuotationInput, PrintOutcome>(
    IPC.printQuotation,
    PrintQuotationInput,
    async (input) => {
      const user = session.requirePermissionOf('sale.create')
      return printSaleQuotation(getDb(), user, input.id)
    }
  )

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

  // ═══════════════════════════════════════════════════════════════════════════
  // SHIFTS & THE CASH DRAWER (Phase 6)
  //
  // A shift is a drawer session: a cashier opens it with a float, rings the day through it, records the
  // drawer events that are NOT sales (a no-sale, a pay-in/out, a drop to the safe), and COUNTS the till
  // at close. THE RENDERER SENDS INTENT; MAIN DECIDES THE MONEY — `expectedCash` and `variance` are
  // DERIVED in main from the shift's own documents and FROZEN at close, never sent by the caller.
  //
  // THE SERVICE AUDITS ITSELF. openShift / closeShift / recordCashMovement each write their own audit row
  // (shift.open, shift.close, cash.movement) from inside their transaction, where they hold the actor and
  // the before/after. So NOT ONE handler below logs a second row — the same contract every other service
  // keeps (see ipc/audit-contract.test.ts). A log that records the same act twice is a log nobody trusts.
  //
  // PERMISSIONS — deliberately NOT uniform (rbac.ts), and the asymmetry that runs through the app:
  //   open, close,      'shift.manage' (CASHIER). Running the till is a cashier's job; the control is the
  //   cashMovement       audit log and the Z-report variance, NOT a block. WRITES — assertWritable().
  //   current           'sale.create' (CASHIER). A LIGHT READ the TILL leans on: the Sell screen must know
  //                      whether a drawer is open before it rings anything up. No assertWritable() — an
  //                      expired shop can still SEE its shift state.
  //   list, get         'shift.view' (MANAGER). The shift history and a historical Z-report are a
  //                      reporting act. READS — no assertWritable(); an expired shop still exports them.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * OPEN A SHIFT with a starting float. The service validates again, posts NO journal (the float is cash
   * already in the till, not a fresh accounting event), and audits shift.open itself. It refuses to open
   * a second shift while one is live — one drawer, one session.
   */
  handle(IPC.shiftsOpen, OpenShiftInput, (input) => {
    const user = session.requirePermissionOf('shift.manage')
    assertWritable()
    return shiftsService.openShift(getDb(), user, input)
  })

  /**
   * CLOSE THE OPEN SHIFT. The cashier hands over the physically COUNTED cash; main computes the expected
   * cash from the shift's own documents, freezes counted / expected / variance onto the row together, and
   * audits shift.close. Over/short is RECORDED, never posted — a miscount must not adjust GL Cash. Returns
   * the shift with its frozen Z-report.
   */
  handle(IPC.shiftsClose, CloseShiftInput, (input) => {
    const user = session.requirePermissionOf('shift.manage')
    assertWritable()
    return shiftsService.closeShift(getDb(), user, input)
  })

  /**
   * IS A SHIFT OPEN? The one shift with no close time, or null. A LIGHT READ the Sell screen leans on —
   * gated 'sale.create', the cashier's own gate, because the till must know before it rings anything up.
   * No assertWritable(): reading the shift state is never held hostage. (CLAUDE.md §6)
   */
  handle(IPC.shiftsCurrent, null, () => {
    session.requirePermissionOf('sale.create')
    return shiftsService.currentOpenShift(getDb())
  })

  /**
   * RECORD A DRAWER MOVEMENT that is not a sale. Requires an OPEN shift. In ONE transaction: the movement
   * row, its balanced journal (NONE for a no-sale, which moves no money), and the cash.movement audit row
   * carrying the type and reason. A no-sale and a pay-out each demand a live reason code from the owner's
   * own list — the two theft vectors — which the service checks against the active lookups rows.
   */
  handle(IPC.shiftsCashMovement, CashMovementInput, (input) => {
    const user = session.requirePermissionOf('shift.manage')
    assertWritable()
    return shiftsService.recordCashMovement(getDb(), user, input)
  })

  // ── Reading shifts — MANAGER-gated ('shift.view'). No assertWritable(): an expired shop can still
  //    browse its shift history and export a historical Z-report. (CLAUDE.md §6) ──────────────────────

  /** THE SHIFTS LIST — paginated and indexed, newest first. Assume a shift a day for years. */
  handle(IPC.shiftsList, ListShiftsInput, (input) => {
    session.requirePermissionOf('shift.view')
    return shiftsService.listShifts(getDb(), input)
  })

  /** ONE SHIFT with its cash movements and its Z-report — the shift detail screen. */
  handle(IPC.shiftsGet, GetShiftInput, (input) => {
    session.requirePermissionOf('shift.view')
    return shiftsService.getShift(getDb(), input)
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // REPORTS (Phase 8) — the payoff. Nine reports, on screen and out to Excel / PDF.
  //
  // A REPORT IS A READ, AND AN EXPORT IS AN EXPORT — so all three below are gated 'report.view' and
  // NONE calls assertWritable(). An expired, read-only shop must still run every report and get its
  // numbers out as .xlsx / .pdf; holding a shop's own figures hostage is the one thing read-only mode
  // exists to prevent (CLAUDE.md §6). The line this app draws is "does it change THE BOOKS" — a report
  // reads frozen numbers, and an export writes a file the OWNER chose; neither touches money or stock.
  //
  // The three route through ONE dispatch, reportsService.buildReport, which tags the bare report data
  // with its kind. So the screen, the spreadsheet and the printout are always built from the same table
  // and can never disagree about a number. NEITHER export takes a path: main opens the save dialog,
  // writes the bytes and returns where they went — the renderer has no filesystem to name one on.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * RUN A REPORT FOR THE SCREEN. A read — no assertWritable() — returning the tagged report data
   * ({ kind, data }) so the renderer can render the right shape. Annotated with the SHARED ReportPayload
   * on purpose: `shared/` cannot import from `main/`, so this line ties buildReport's shape to the one
   * the screen is typed against — drift breaks the build here, not the report later.
   */
  handle<ReportRequest, ReportPayload>(IPC.reportsGet, ReportRequest, (input) => {
    session.requirePermissionOf('report.view')
    return reportsService.buildReport(getDb(), input)
  })

  /**
   * EXPORT A REPORT TO EXCEL — a workbook the owner opens and totals himself. An EXPORT, never a write:
   * gated 'report.view', no assertWritable(). Builds the report, then lets the owner choose where the
   * .xlsx goes; returns the saved path, or null if they closed the save dialog.
   */
  handle<ReportRequest, string | null>(IPC.reportsExportExcel, ReportRequest, async (input) => {
    session.requirePermissionOf('report.view')

    const payload = reportsService.buildReport(getDb(), input)
    const path = await saveReportFile(
      reportFileName(payload.kind, 'xlsx', new Date()),
      { name: 'Excel file', extensions: ['xlsx'] },
      () => reportToXlsxBuffer(payload)
    )

    if (path) log.info(`[reports] ${payload.kind} exported to Excel: ${path}`)
    return path
  })

  /**
   * EXPORT A REPORT TO A4 PDF — laid out to be printed and filed. An EXPORT, never a write: gated
   * 'report.view', no assertWritable(). The shop name on the page comes from Settings (`shop.name`), the
   * same figure the receipt uses. Returns the saved path, or null if they closed the save dialog.
   */
  handle<ReportRequest, string | null>(IPC.reportsExportPdf, ReportRequest, async (input) => {
    session.requirePermissionOf('report.view')

    const db = getDb()
    const payload = reportsService.buildReport(db, input)
    const shopName = settingsService.get<string>(db, 'shop.name', 'My Shop')
    const path = await saveReportFile(
      reportFileName(payload.kind, 'pdf', new Date()),
      { name: 'PDF file', extensions: ['pdf'] },
      () => reportToPdfBuffer(payload, shopName)
    )

    if (path) log.info(`[reports] ${payload.kind} exported to PDF: ${path}`)
    return path
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPENSES (migration 0014) — the shop's money going OUT on the NON-STOCK cost of running the place
  //
  // Rent, wages, bills, transport, repairs. A purchase brings stock IN and re-averages its cost; an
  // EXPENSE buys none — it is a running cost that lands straight in the Profit & Loss, paid NOW from
  // cash or bank as ONE balanced journal (DR the category's expense account, CR the tender). THE
  // RENDERER SENDS INTENT; MAIN DECIDES THE ACCOUNTS AND THE ACTOR — the input names WHAT it was for and
  // HOW it was paid (lookups ids the service re-validates against the live lists), never a ledger account
  // and never a userId; `user` comes from the session in MAIN.
  //
  // THE SERVICE AUDITS ITSELF ('expense.create') from inside its own transaction, where it holds the
  // actor. So the create handler below does NOT log a second row — the same contract every other service
  // keeps (see ipc/audit-contract.test.ts). A log that records the same act twice is a log nobody trusts.
  //
  // PERMISSIONS (rbac.ts) — booking and reviewing the shop's running costs are a manager's job, like a
  // purchase:
  //   expense.manage   record an expense            (WRITE  — assertWritable())
  //   expense.view     read the expense history     (reads  — no assertWritable())
  // Only the write is blocked on an expired licence; the reads keep working — an expired shop can still
  // browse and export what it spent. (CLAUDE.md §6)
  // ═══════════════════════════════════════════════════════════════════════════

  handle(IPC.expenseCreate, CreateExpenseInput, (input) => {
    const user = session.requirePermissionOf('expense.manage')
    assertWritable()
    // ONE transaction: the expenses row → DR the category's expense account · CR the tender → audit
    // 'expense.create'. The service does it all and audits itself — do not log a second row here.
    return expensesService.createExpense(getDb(), user, input)
  })

  handle(IPC.expenseList, ListExpensesInput, (input) => {
    session.requirePermissionOf('expense.view')
    return expensesService.listExpenses(getDb(), input)
  })

  handle(IPC.expenseGet, GetExpenseInput, (input) => {
    session.requirePermissionOf('expense.view')
    return expensesService.getExpense(getDb(), input.id)
  })

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // LOYALTY POINTS — a liability booked when EARNED; the balance is DERIVED (migration 0017)
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  //
  // There is no earn and no redeem handler ON PURPOSE. Points are earned BY a sale and spent as a
  // TENDER on one, so both ride inside `sale:complete` and are written in that sale's ONE transaction.
  // A standalone endpoint would be a way to mint or spend a liability with no sale behind it.
  //
  //   loyalty.view     read a balance / a statement   (reads  — NO assertWritable(): an expired shop
  //                                                    still reads its own books, CLAUDE.md §6)
  //   loyalty.adjust   the owner's hand correction    (WRITE  — assertWritable())

  handle(IPC.loyaltyBalance, LoyaltyBalanceInput, (input) => {
    session.requirePermissionOf('loyalty.view')
    return loyaltyService.balance(getDb(), input)
  })

  handle(IPC.loyaltyHistory, LoyaltyHistoryInput, (input) => {
    session.requirePermissionOf('loyalty.view')
    return loyaltyService.history(getDb(), input)
  })

  handle(IPC.loyaltyAdjust, AdjustPointsInput, (input) => {
    // Moving a liability by hand is the OWNER's call, and the UI is not a security boundary.
    const user = session.requirePermissionOf('loyalty.adjust')
    assertWritable()

    // ONE transaction: the movement → the balanced journal → the audit row. THE SERVICE AUDITS ITSELF
    // ('loyalty.adjust') from inside it, and enforces the reason code against the owner's own live
    // lookups list — do not log a second row here.
    return loyaltyService.adjustPoints(getDb(), user, input)
  })

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // PROMOTIONS (migration 0018) — the shop's OWN offers, applied automatically at the till
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  //
  // A PROMOTION IS A LINE DISCOUNT. It invents no new money, no journal leg and no money column: the
  // engine computes a discount, sales.ts writes it into the `line_discount` that has existed since
  // migration 0007, and it travels the road already proven (priceCart re-resolves tax on what is
  // ACTUALLY paid → DR Discounts Given 4200 → frozen onto the line, so a RETURN refunds what was
  // really charged).
  //
  // THERE IS NO 'apply' HANDLER, ON PURPOSE — the same reasoning as loyalty's missing earn/redeem. An
  // offer is resolved inside `sale:complete`, in MAIN, against the offers live at the sale's own
  // instant, and frozen in that sale's ONE transaction. A renderer that could name its own promotion
  // discount could sell at any price it liked.
  //
  // THE SERVICES AUDIT THEMSELVES ('promotion.create' / 'promotion.update' / 'promotion.deactivate')
  // from inside their own transactions — do NOT log a second row here (see ipc/audit-contract.test.ts).
  //
  // PERMISSIONS (rbac.ts) — an offer is a standing decision to sell below the shelf price, so writing
  // one is a manager's job; READING one is a cashier's, because the till must be able to tell the
  // customer WHY the price changed:
  //   promotion.manage   create / edit / switch off / set what it applies to  (WRITES — assertWritable)
  //   promotion.view     read the offers                                      (reads — NO assertWritable:
  //                                                                            an expired shop still
  //                                                                            reads its own books,
  //                                                                            CLAUDE.md §6)

  handle(IPC.promotionCreate, CreatePromotionInput, (input) => {
    const user = session.requirePermissionOf('promotion.manage')
    assertWritable()
    return promotionsService.createPromotion(getDb(), user, input)
  })

  handle(IPC.promotionUpdate, UpdatePromotionInput, (input) => {
    const user = session.requirePermissionOf('promotion.manage')
    assertWritable()
    return promotionsService.updatePromotion(getDb(), user, input)
  })

  handle(IPC.promotionDeactivate, DeactivatePromotionInput, (input) => {
    const user = session.requirePermissionOf('promotion.manage')
    assertWritable()
    // An offer is switched OFF, never deleted: last March's sales must still explain themselves.
    return promotionsService.deactivatePromotion(getDb(), user, input)
  })

  handle(IPC.promotionSetRules, SetPromotionRulesInput, (input) => {
    const user = session.requirePermissionOf('promotion.manage')
    assertWritable()
    // WHAT an offer applies to is as much a part of it as its percentage — changing it from "one tin"
    // to "everything" is the single most expensive edit here, and the service audits it as an update.
    return promotionsService.setRules(getDb(), user, input)
  })

  handle(IPC.promotionList, ListPromotionsInput, (input) => {
    session.requirePermissionOf('promotion.view')
    return promotionsService.listPromotions(getDb(), input)
  })

  handle(IPC.promotionGet, GetPromotionInput, (input) => {
    session.requirePermissionOf('promotion.view')
    return promotionsService.getPromotion(getDb(), input)
  })

  handle(IPC.promotionRules, ListPromotionRulesInput, (input) => {
    session.requirePermissionOf('promotion.view')
    return promotionsService.listRules(getDb(), input)
  })

  // WHAT IS RUNNING RIGHT NOW — for the Sell screen's "why did the price change?" and the offers
  // screen's "which of these is live today?".
  //
  // IT TAKES NO DATE. The clock is MAIN's (see shared/sales.ts) — a caller that could name the day
  // could ask what Sunday's prices are on a Tuesday and show the customer a price the till will not
  // honour. `activeFor` reads the offers live at THIS instant, which is the only day that can be sold.
  handle<void, PromotionDetail[]>(IPC.promotionActive, null, () => {
    session.requirePermissionOf('promotion.view')
    return promotionsService.activeFor(getDb(), new Date())
  })

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // CLOSING THE MONTH — the door to a lock that has been enforced since migration 0002
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  //
  // Nothing about the ENFORCEMENT is here. `ledger.assertPeriodOpen` already refuses every journal and
  // every stock movement dated in a locked month. These handlers are the way an owner finally reaches
  // it. Both writes are OWNER-only and audited by the service — the unlock especially: reopening a
  // closed month is how books get quietly rewritten.

  handle(IPC.periodList, ListPeriodsInput, (input) => {
    // A READ, and NO assertWritable(). An expired shop still reads its own books (CLAUDE.md §6) — and
    // it is exactly the shop most likely to be looking at which months are closed.
    session.requirePermissionOf('period.manage')
    return periodsService.list(getDb(), input)
  })

  handle(IPC.periodLock, LockPeriodInput, (input) => {
    const user = session.requirePermissionOf('period.manage')
    assertWritable()
    return periodsService.lock(getDb(), user, input)
  })

  handle(IPC.periodUnlock, UnlockPeriodInput, (input) => {
    const user = session.requirePermissionOf('period.manage')
    assertWritable()
    // REOPENING A CLOSED MONTH. Owner-only and audited with the journal count against it — the
    // difference between reopening a quiet month and reopening the shop's busiest quarter.
    return periodsService.unlock(getDb(), user, input)
  })

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // STOCK TAKE — the counting sheet (migration 0019)
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  //
  // THE DOCUMENT WRAPS THE ENGINE. `apply` calls stock.adjust() once per varying line; there is no
  // second path to stock and no new accounting here. Note what a line CANNOT send: the expected
  // figure, the variance, the cost, a date, a user. MAIN freezes all of them.

  handle(IPC.stockTakeCreate, CreateStockTakeInput, (input) => {
    const user = session.requirePermissionOf('stockTake.manage')
    assertWritable()
    return stockTakeService.create(getDb(), user, input)
  })

  handle(IPC.stockTakeSetCount, SetCountInput, (input) => {
    const user = session.requirePermissionOf('stockTake.manage')
    assertWritable()
    return stockTakeService.setCount(getDb(), user, input)
  })

  handle(IPC.stockTakeAddLines, AddStockTakeLinesInput, (input) => {
    const user = session.requirePermissionOf('stockTake.manage')
    assertWritable()
    return stockTakeService.addLines(getDb(), user, input)
  })

  handle(IPC.stockTakeRemoveLine, RemoveStockTakeLineInput, (input) => {
    session.requirePermissionOf('stockTake.manage')
    assertWritable()
    return stockTakeService.removeLine(getDb(), input)
  })

  handle(IPC.stockTakeMarkCounted, StockTakeIdInput, (input) => {
    session.requirePermissionOf('stockTake.manage')
    assertWritable()
    return stockTakeService.markCounted(getDb(), input)
  })

  handle(IPC.stockTakeApply, ApplyStockTakeInput, (input) => {
    const user = session.requirePermissionOf('stockTake.manage')
    assertWritable()
    // THE ONE THAT MOVES STOCK AND MONEY. Audited by the service with the variance total against it —
    // a big variance is a theft signal, and that row is what the leakage report and the owner read.
    return stockTakeService.apply(getDb(), user, input)
  })

  handle(IPC.stockTakeCancel, CancelStockTakeInput, (input) => {
    const user = session.requirePermissionOf('stockTake.manage')
    assertWritable()
    // Cancelled, never deleted: an abandoned sheet is evidence too.
    return stockTakeService.cancel(getDb(), user, input)
  })

  handle(IPC.stockTakeList, ListStockTakesInput, (input) => {
    session.requirePermissionOf('stockTake.view')
    return stockTakeService.list(getDb(), input)
  })

  handle(IPC.stockTakeGet, StockTakeIdInput, (input) => {
    session.requirePermissionOf('stockTake.view')
    return stockTakeService.get(getDb(), input)
  })
}
