// Preload of the API key window (sandboxed). Exposes only submit / cancel; main accepts the message
// only from that window's webContents.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('keyInput', {
  submit: (value) => ipcRenderer.send('tunnel-key:submit', String(value)),
  cancel: () => ipcRenderer.send('tunnel-key:cancel')
});
