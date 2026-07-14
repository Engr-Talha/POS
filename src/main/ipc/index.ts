import { ipcMain, app, dialog, BrowserWindow } from 'electron'
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
  type StockAdjustResult,
  type NearExpiryItem,
  type SystemInfo
} from '@shared/ipc'
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
}
