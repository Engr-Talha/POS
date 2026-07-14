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
    add: (input) => ipcRenderer.invoke(IPC.lookupsAdd, input)
  },

  audit: {
    list: (input) => ipcRenderer.invoke(IPC.auditList, input)
  }
}

contextBridge.exposeInMainWorld('pos', api)
