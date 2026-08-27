/**
 * The only bridge between the app and Node.
 *
 * Context isolation stays on and nodeIntegration off; the renderer gets this
 * narrow, explicit surface instead of `require`.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('benseditorDesktop', {
  version: process.versions.electron,

  openProjectDialog: () => ipcRenderer.invoke('dialog:openProject'),
  chooseFolder: (title) => ipcRenderer.invoke('dialog:chooseFolder', title),
  saveFileDialog: (options) => ipcRenderer.invoke('dialog:saveFile', options),

  readProject: (root) => ipcRenderer.invoke('fs:readProject', root),
  writeProject: (root, project) => ipcRenderer.invoke('fs:writeProject', root, project),
  writeFile: (target, contents) => ipcRenderer.invoke('fs:writeFile', target, contents),
  showItemInFolder: (target) => ipcRenderer.invoke('shell:showItem', target),
});
