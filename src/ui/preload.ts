/**
 * Preload скрипт: contextIsolation + sandbox.
 * Отдаёт рендереру только узкий список через contextBridge.
 */

import electron from 'electron'

const { contextBridge, ipcRenderer } = electron

contextBridge.exposeInMainWorld('dsmap', {
  onEvent: (cb: (e: unknown) => void) => {
    const handler = (_e: unknown, data: unknown) => cb(data)
    ipcRenderer.on('event', handler)
    return { unsubscribe: () => ipcRenderer.removeListener('event', handler) }
  },
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch: unknown) => ipcRenderer.invoke('config:set', patch),
})
