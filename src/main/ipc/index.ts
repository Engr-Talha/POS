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
  type StockAdjustResult,
  type NearExpiryItem,
  type SystemInfo,
  type OpeningWizardState,
  type ImportPreview,
  type ImportResult
} from '@shared/ipc'
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
  // Writes are gated on 'settings.manage' — the ONLY screen that creates a customer today is the
  // owner-only opening wizard, so this is the honest gate for what actually exists. Phase 7 puts a
  // customer in front of a cashier at the till, and that needs its own 'customer.manage' permission in
  // shared/rbac.ts. Opening a gate later is safe; shipping one too wide is not.
  handle(IPC.customersList, CustomerListInput, (input) => {
    session.requirePermissionOf('report.view')
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
}
