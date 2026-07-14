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
  }
}

contextBridge.exposeInMainWorld('pos', api)
