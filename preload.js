const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tachylite', {
  getInitialFile: () => ipcRenderer.invoke('file:initial'),
  openFile: () => ipcRenderer.invoke('file:open'),
  reloadIfChanged: (payload) => ipcRenderer.invoke('file:reload-if-changed', payload),
  saveFile: (payload) => ipcRenderer.invoke('file:save', payload),
  saveFileAs: (payload) => ipcRenderer.invoke('file:save-as', payload),
  exportHtml: (payload) => ipcRenderer.invoke('file:export-html', payload),
  exportFile: (payload) => ipcRenderer.invoke('file:export', payload),
  exportPdf: (payload) => ipcRenderer.invoke('file:export-pdf', payload),
  openTarget: (href) => ipcRenderer.invoke('shell:open-target', href),
  writeClipboard: (payload) => ipcRenderer.invoke('clipboard:write', payload),
  getSpellcheckEnabled: () => ipcRenderer.invoke('spellcheck:get-enabled'),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),
  newWindow: () => ipcRenderer.invoke('window:new'),
  confirmCloseDocument: (fileName) => ipcRenderer.invoke('document:confirm-close', fileName),
  zoomIn: () => ipcRenderer.invoke('zoom:in'),
  zoomOut: () => ipcRenderer.invoke('zoom:out'),
  zoomReset: () => ipcRenderer.invoke('zoom:reset'),
  onThemeChanged: (callback) => {
    const listener = (_event, theme) => {
      callback(theme);
    };

    ipcRenderer.on('theme:changed', listener);
    return () => ipcRenderer.removeListener('theme:changed', listener);
  },
  onSpellcheckEnabledChanged: (callback) => {
    const listener = (_event, enabled) => {
      callback(enabled);
    };

    ipcRenderer.on('spellcheck:enabled-changed', listener);
    return () => ipcRenderer.removeListener('spellcheck:enabled-changed', listener);
  },
  sendCloseState: (requestId, snapshot) => ipcRenderer.send('document:close-state', requestId, snapshot),
  onCloseStateRequest: (callback) => {
    const listener = (_event, requestId) => {
      callback(requestId);
    };

    ipcRenderer.on('document:request-close-state', listener);
    return () => ipcRenderer.removeListener('document:request-close-state', listener);
  },
  onCloseApproved: (callback) => {
    const listener = () => {
      callback();
    };

    ipcRenderer.on('document:close-approved', listener);
    return () => ipcRenderer.removeListener('document:close-approved', listener);
  },
  onEditorCommand: (callback) => {
    const listener = (_event, command, payload) => {
      callback(command, payload || {});
    };

    ipcRenderer.on('editor-command', listener);
    return () => ipcRenderer.removeListener('editor-command', listener);
  },
  onCommand: (callback) => {
    const listener = (_event, command, payload) => {
      callback(command, payload);
    };

    ipcRenderer.on('app-command', listener);
    return () => ipcRenderer.removeListener('app-command', listener);
  }
});
