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

    listSuppliers: (input) => ipcRenderer.invoke(IPC.catalogListSuppliers, input),
    getSupplier: (input) => ipcRenderer.invoke(IPC.catalogGetSupplier, input),
    createSupplier: (input) => ipcRenderer.invoke(IPC.catalogCreateSupplier, input),
    updateSupplier: (input) => ipcRenderer.invoke(IPC.catalogUpdateSupplier, input),
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

    commit: (input) => ipcRenderer.invoke(IPC.openingCommit, input)
  },

  // Note what is NOT here: any way to set what a customer owes. That figure is DERIVED from the
  // ledger, exactly as stock is derived from the movements. `creditLimit` is a limit, not a balance.
  customers: {
    list: (input) => ipcRenderer.invoke(IPC.customersList, input),
    create: (input) => ipcRenderer.invoke(IPC.customersCreate, input),
    update: (input) => ipcRenderer.invoke(IPC.customersUpdate, input)
  }
}

contextBridge.exposeInMainWorld('pos', api)
