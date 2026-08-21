// Preload bridge (contextIsolation-safe). The window's native backgroundColor
// is what shows through when a resize outpaces the web view's repaint, so the
// renderer reports its theme here and the main process keeps the native color
// in step — otherwise dark mode flashes a white strip on every drag-resize.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nashDesktop', {
  /** Set the native window background. Hex only, e.g. "#020617". */
  setBackgroundColor: (color) => ipcRenderer.send('set-background-color', color),
});
