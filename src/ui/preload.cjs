/**
 * Preload: contextIsolation + sandbox.
 * Печатается CommonJS намеренно: sandboxed-preload в Electron грузится как CJS,
 * и ESM-файл тихо падает с «Cannot use import statement outside a module» —
 * окно остаётся живым, но без моста и без единой ошибки на экране.
 */

const { contextBridge, ipcRenderer } = require('electron')

function channel(name, cb) {
  const handler = (_event, data) => cb(data)
  ipcRenderer.on(name, handler)
  return () => ipcRenderer.removeListener(name, handler)
}

contextBridge.exposeInMainWorld('dsmap', {
  onEvent: (cb) => ({ unsubscribe: channel('event', cb) }),
  onStatus: (cb) => ({ unsubscribe: channel('status', cb) }),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
})
