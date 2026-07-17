const { app, BrowserWindow, Menu, dialog, ipcMain, shell, clipboard } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');

const APP_USER_MODEL_ID = 'com.tachylite.app';
const ZOOM_LEVEL_MIN = -6;
const ZOOM_LEVEL_MAX = 6;
const ZOOM_LEVEL_STEP = 0.5;
const RECENT_FILES_LIMIT = 10;

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

let mainWindow = null;
const appWindows = new Set();
const initialFilePaths = new Map();
const appIconPath = path.join(__dirname, 'assets', 'icon.ico');
const closeApprovedWindows = new WeakSet();
const closePromptWindows = new WeakSet();
let spellcheckEnabled = true;
let selectedTheme = 'light';
let recentFiles = [];

const themes = [
  { id: 'light', label: 'Light' },
  { id: 'paper', label: 'Paper' },
  { id: 'dusk', label: 'Dusk' },
  { id: 'contrast', label: 'High Contrast' }
];

function normalizeTheme(theme) {
  return themes.some((item) => item.id === theme) ? theme : 'light';
}

function normalizeRecentFilePath(filePath) {
  if (!filePath) return null;
  return path.normalize(filePath);
}

function findFilePathFromArgs(args) {
  const exePath = path.normalize(process.execPath).toLowerCase();
  const exeName = path.basename(process.execPath).toLowerCase();

  return args
    .find((arg) => {
      if (!arg || arg.startsWith('-')) return false;
      const normalized = path.normalize(arg).toLowerCase();
      if (normalized === exePath || normalized === exeName || path.extname(normalized) === '.asar') return false;
      return true;
    });
}

function findInitialFilePath() {
  return findFilePathFromArgs(process.argv.slice(1));
}

function preferencesPath() {
  return path.join(app.getPath('userData'), 'preferences.json');
}

async function loadPreferences() {
  try {
    const preferences = JSON.parse(await fs.readFile(preferencesPath(), 'utf8'));
    spellcheckEnabled = preferences.spellcheckEnabled !== false;
    selectedTheme = normalizeTheme(preferences.theme);
    recentFiles = Array.isArray(preferences.recentFiles)
      ? preferences.recentFiles.map(normalizeRecentFilePath).filter(Boolean).slice(0, RECENT_FILES_LIMIT)
      : [];
  } catch (_error) {
    spellcheckEnabled = true;
    selectedTheme = 'light';
    recentFiles = [];
  }
}

async function writePreferences() {
  const preferences = {
    spellcheckEnabled,
    theme: selectedTheme,
    recentFiles
  };

  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(preferencesPath(), `${JSON.stringify(preferences, null, 2)}\n`, 'utf8');
}

function activeAppWindow() {
  const focused = BrowserWindow.getFocusedWindow();

  if (focused && appWindows.has(focused) && !focused.isDestroyed()) {
    return focused;
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }

  return Array.from(appWindows).find((win) => !win.isDestroyed()) || null;
}

function forEachAppWindow(callback) {
  appWindows.forEach((win) => {
    if (!win.isDestroyed()) {
      callback(win);
    }
  });
}

function applySpellcheckPreference(win = null) {
  if (!win) {
    forEachAppWindow(applySpellcheckPreference);
    return;
  }

  if (!win || win.isDestroyed()) return;

  win.webContents.session.setSpellCheckerEnabled(spellcheckEnabled);
  win.webContents.send('spellcheck:enabled-changed', spellcheckEnabled);
}

function applyThemePreference(win = null) {
  if (!win) {
    forEachAppWindow(applyThemePreference);
    return;
  }

  if (!win || win.isDestroyed()) return;

  win.webContents.send('theme:changed', selectedTheme);
}

async function setSpellcheckEnabled(enabled, win = null) {
  spellcheckEnabled = Boolean(enabled);
  applySpellcheckPreference();

  try {
    await writePreferences();
  } catch (_error) {
    // Preference persistence should not block the editor menu action.
  }
}

async function setTheme(theme, win = null) {
  selectedTheme = normalizeTheme(theme);
  applyThemePreference(win || null);
  createMenu();

  try {
    await writePreferences();
  } catch (_error) {
    // Preference persistence should not block theme changes.
  }

  return selectedTheme;
}

function persistRecentFiles() {
  if (app.isReady()) {
    createMenu();
  }

  writePreferences().catch(() => {
    // Recent files are a convenience; failed persistence should not block opening.
  });
}

function rememberRecentFile(filePath) {
  const normalized = normalizeRecentFilePath(filePath);
  if (!normalized) return;

  recentFiles = [
    normalized,
    ...recentFiles.filter((item) => item.toLowerCase() !== normalized.toLowerCase())
  ].slice(0, RECENT_FILES_LIMIT);

  app.addRecentDocument(normalized);
  persistRecentFiles();
}

function forgetRecentFile(filePath) {
  const normalized = normalizeRecentFilePath(filePath);
  if (!normalized) return;

  const nextFiles = recentFiles.filter((item) => item.toLowerCase() !== normalized.toLowerCase());
  if (nextFiles.length === recentFiles.length) return;

  recentFiles = nextFiles;
  persistRecentFiles();
}

function clearRecentFiles() {
  recentFiles = [];
  app.clearRecentDocuments();
  persistRecentFiles();
}

async function filePayload(filePath, content) {
  const baseDir = path.dirname(filePath);
  const stats = await fs.stat(filePath);

  return {
    filePath,
    fileName: path.basename(filePath),
    baseDirUrl: pathToFileURL(`${baseDir}${path.sep}`).href,
    diskMtimeMs: stats.mtimeMs,
    content: content.replace(/^\uFEFF/, '')
  };
}

async function readMarkdownFile(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  rememberRecentFile(filePath);
  return filePayload(filePath, content);
}

async function saveMarkdownFile({ filePath, fileName, content, title, win = activeAppWindow() }) {
  let targetPath = filePath;

  if (!targetPath) {
    const result = await dialog.showSaveDialog(win || undefined, {
      title,
      defaultPath: fileName || 'Untitled.md',
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown', 'mdc'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    targetPath = result.filePath;
  }

  await fs.writeFile(targetPath, content, 'utf8');
  rememberRecentFile(targetPath);
  return { canceled: false, file: await filePayload(targetPath, content) };
}

function exportDefaultPath(filePath, fileName, extension) {
  const source = filePath || fileName || 'Untitled.md';
  const parsed = path.parse(source);

  return path.join(parsed.dir || '', `${parsed.name || 'Untitled'}.${extension}`);
}

const exportTypes = {
  html: {
    title: 'Export HTML',
    extension: 'html',
    filters: [
      { name: 'HTML', extensions: ['html', 'htm'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  },
  markdown: {
    title: 'Export Markdown',
    extension: 'md',
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdc'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  },
  text: {
    title: 'Export Plain Text',
    extension: 'txt',
    filters: [
      { name: 'Text', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  }
};

async function exportTextFile({ type, filePath, fileName, content, win = activeAppWindow() }) {
  const config = exportTypes[type];

  if (!config) {
    return { canceled: true, error: 'Unsupported export type.' };
  }

  const result = await dialog.showSaveDialog(win || undefined, {
    title: config.title,
    defaultPath: exportDefaultPath(filePath, fileName, config.extension),
    filters: config.filters
  });

  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

  await fs.writeFile(result.filePath, content || '', 'utf8');
  return { canceled: false, filePath: result.filePath, type };
}

async function exportHtmlFile({ filePath, fileName, html, win = activeAppWindow() }) {
  return exportTextFile({
    type: 'html',
    filePath,
    fileName,
    content: html,
    win
  });
}

async function exportPdfFile({ filePath, fileName, html, win = activeAppWindow() }) {
  const result = await dialog.showSaveDialog(win || undefined, {
    title: 'Export PDF',
    defaultPath: exportDefaultPath(filePath, fileName, 'pdf'),
    filters: [
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

  const pdfWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      javascript: false,
      nodeIntegration: false,
      sandbox: true
    }
  });

  try {
    await pdfWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html || '')}`);
    const pdf = await pdfWindow.webContents.printToPDF({
      marginsType: 1,
      pageSize: 'A4',
      printBackground: true
    });

    await fs.writeFile(result.filePath, pdf);
    return { canceled: false, filePath: result.filePath, type: 'pdf' };
  } finally {
    if (!pdfWindow.isDestroyed()) {
      pdfWindow.close();
    }
  }
}

function sendCommand(command, payload = undefined, win = activeAppWindow()) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('app-command', command, payload);
}

function clampZoomLevel(level) {
  return Math.max(ZOOM_LEVEL_MIN, Math.min(ZOOM_LEVEL_MAX, level));
}

function adjustZoom(webContents, delta) {
  if (!webContents || webContents.isDestroyed()) {
    return 0;
  }

  const nextLevel = clampZoomLevel(webContents.getZoomLevel() + delta);
  webContents.setZoomLevel(nextLevel);
  return nextLevel;
}

function resetZoom(webContents) {
  if (!webContents || webContents.isDestroyed()) {
    return 0;
  }

  webContents.setZoomLevel(0);
  return 0;
}

async function openLinkTarget(href) {
  try {
    const target = new URL(href);

    if (target.protocol === 'file:') {
      await shell.openPath(fileURLToPath(target));
      return;
    }
  } catch (_error) {
    // Fall back to Electron's external opener below.
  }

  await shell.openExternal(href);
}

function requestDocumentCloseState(win) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      resolve({ dirty: false });
      return;
    }

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const channel = 'document:close-state';

    const cleanup = () => {
      clearTimeout(timeout);
      ipcMain.removeListener(channel, listener);
    };

    const listener = (event, responseId, snapshot) => {
      if (event.sender !== win.webContents || responseId !== requestId) return;

      cleanup();
      resolve(snapshot || { dirty: false });
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve({ dirty: false });
    }, 1500);

    ipcMain.on(channel, listener);
    win.webContents.send('document:request-close-state', requestId);
  });
}

function approveWindowClose(win) {
  if (!win || win.isDestroyed()) return;

  closeApprovedWindows.add(win);
  win.webContents.send('document:close-approved');
  win.close();
}

async function confirmWindowClose(event, win) {
  if (!win || win.isDestroyed() || closeApprovedWindows.has(win)) {
    return;
  }

  event.preventDefault();

  if (closePromptWindows.has(win)) {
    return;
  }

  closePromptWindows.add(win);

  try {
    const snapshot = await requestDocumentCloseState(win);

    if (!snapshot.dirty) {
      approveWindowClose(win);
      return;
    }

    const dirtyTabs = Array.isArray(snapshot.tabs)
      ? snapshot.tabs.filter((tab) => tab && tab.dirty)
      : [snapshot].filter((tab) => tab && tab.dirty);
    const fileName = dirtyTabs.length === 1
      ? dirtyTabs[0].fileName || 'Untitled.md'
      : `${dirtyTabs.length} documents`;
    const result = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      title: 'Unsaved Changes',
      message: `Save changes to ${fileName} before closing?`,
      detail: dirtyTabs.length === 1
        ? "Your changes will be lost if you don't save them."
        : "Unsaved tab changes will be lost if you don't save them."
    });

    if (result.response === 2) {
      return;
    }

    if (result.response === 0) {
      for (const tab of dirtyTabs) {
        try {
          const saveResult = await saveMarkdownFile({
            filePath: tab.filePath,
            fileName: tab.fileName || 'Untitled.md',
            content: tab.content || '',
            title: 'Save Markdown File',
            win
          });

          if (saveResult.canceled) {
            return;
          }
        } catch (error) {
          await dialog.showMessageBox(win, {
            type: 'error',
            buttons: ['OK'],
            title: 'Save Failed',
            message: `Could not save ${tab.fileName || 'Untitled.md'}.`,
            detail: error.message
          });
          return;
        }
      }
    }

    approveWindowClose(win);
  } finally {
    closePromptWindows.delete(win);
  }
}

async function openFileInWindow(filePath, win = activeAppWindow()) {
  if (!filePath) return;

  if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) {
    createWindow(filePath);
    return;
  }

  try {
    const file = await readMarkdownFile(filePath);
    win.webContents.send('app-command', 'open-file', file);

    if (win.isMinimized()) {
      win.restore();
    }

    win.focus();
  } catch (_error) {
    forgetRecentFile(filePath);
    // Ignore failed association launches so the existing editor session is not disrupted.
  }
}

function createMenu() {
  const recentFileMenu = recentFiles.length > 0
    ? [
        ...recentFiles.map((filePath) => ({
          label: filePath,
          click: () => openFileInWindow(filePath)
        })),
        { type: 'separator' },
        { label: 'Clear Recent', click: clearRecentFiles }
      ]
    : [{ label: 'No Recent Files', enabled: false }];

  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+N', click: () => sendCommand('new-tab') },
        { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow() },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => sendCommand('close-tab') },
        { type: 'separator' },
        { label: 'Open...', accelerator: 'CmdOrCtrl+O', click: () => sendCommand('open') },
        { label: 'Open Recent', submenu: recentFileMenu },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => sendCommand('save') },
        { label: 'Save As...', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendCommand('save-as') },
        {
          label: 'Export',
          submenu: [
            { label: 'HTML...', accelerator: 'CmdOrCtrl+Alt+E', click: () => sendCommand('export-html') },
            { label: 'PDF...', click: () => sendCommand('export-pdf') },
            { label: 'Markdown...', click: () => sendCommand('export-markdown') },
            { label: 'Plain Text...', click: () => sendCommand('export-text') }
          ]
        },
        { type: 'separator' },
        process.platform === 'darwin'
          ? { role: 'close' }
          : { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Preview Mode', accelerator: 'CmdOrCtrl+1', click: () => sendCommand('mode:preview') },
        { label: 'Split View', accelerator: 'CmdOrCtrl+2', click: () => sendCommand('mode:split') },
        { label: 'Raw Mode', accelerator: 'CmdOrCtrl+3', click: () => sendCommand('mode:raw') },
        { type: 'separator' },
        { label: 'Find', accelerator: 'CmdOrCtrl+F', click: () => sendCommand('find') },
        { label: 'Toggle Outline', accelerator: 'CmdOrCtrl+Shift+O', click: () => sendCommand('toggle-outline') },
        { type: 'separator' },
        {
          label: 'Theme',
          submenu: themes.map((theme) => ({
            label: theme.label,
            type: 'radio',
            checked: selectedTheme === theme.id,
            click: () => setTheme(theme.id)
          }))
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' }
      ]
    }
  ];

  if (process.platform === 'darwin') {
    template.unshift({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showEditorContextMenu(webContents, params = {}) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  const hostWindow = BrowserWindow.fromWebContents(webContents) || mainWindow;
  const template = [];
  const editFlags = params.editFlags || {};
  const dictionarySuggestions = Array.isArray(params.dictionarySuggestions)
    ? params.dictionarySuggestions
    : [];
  const isEditable = Boolean(params.isEditable);
  const linkURL = params.linkURL || '';
  const misspelledWord = params.misspelledWord || '';
  const selectionText = params.selectionText || '';
  const sendEditorCommand = (command, payload = {}) => {
    webContents.send('editor-command', command, payload);
  };

  if (linkURL) {
    template.push(
      {
        label: 'Open Link',
        click: () => {
          openLinkTarget(linkURL);
        }
      },
      {
        label: 'Copy Link',
        click: () => {
          clipboard.writeText(linkURL);
        }
      },
      { type: 'separator' }
    );
  }

  if (isEditable && spellcheckEnabled && misspelledWord) {
    const suggestions = dictionarySuggestions.slice(0, 6);

    if (suggestions.length > 0) {
      suggestions.forEach((suggestion) => {
        template.push({
          label: suggestion,
          click: () => webContents.replaceMisspelling(suggestion)
        });
      });
    } else {
      template.push({
        label: 'No Suggestions',
        enabled: false
      });
    }

    template.push(
      { type: 'separator' },
      {
        label: `Add "${misspelledWord}" to Dictionary`,
        click: () => {
          webContents.session.addWordToSpellCheckerDictionary(misspelledWord);
        }
      },
      { type: 'separator' }
    );
  }

  if (isEditable) {
    template.push(
      {
        label: 'Formatting',
        submenu: [
          { label: 'Bold', accelerator: 'CmdOrCtrl+B', click: () => sendEditorCommand('format:bold') },
          { label: 'Italic', accelerator: 'CmdOrCtrl+I', click: () => sendEditorCommand('format:italic') },
          { label: 'Strikethrough', click: () => sendEditorCommand('format:strike') },
          { label: 'Inline Code', click: () => sendEditorCommand('format:inline-code') },
          { type: 'separator' },
          { label: 'Heading 1', click: () => sendEditorCommand('format:heading', { level: 1 }) },
          { label: 'Heading 2', click: () => sendEditorCommand('format:heading', { level: 2 }) },
          { label: 'Heading 3', click: () => sendEditorCommand('format:heading', { level: 3 }) },
          { type: 'separator' },
          { label: 'Bulleted List', click: () => sendEditorCommand('format:bullet-list') },
          { label: 'Numbered List', click: () => sendEditorCommand('format:numbered-list') },
          { label: 'Block Quote', click: () => sendEditorCommand('format:quote') },
          { label: 'Code Block', click: () => sendEditorCommand('format:code-block') },
          { type: 'separator' },
          { label: 'Insert Link', click: () => sendEditorCommand('format:link') }
        ]
      },
      {
        label: 'Copy as Markdown',
        click: () => sendEditorCommand('copy:markdown')
      },
      {
        label: 'Copy as HTML',
        click: () => sendEditorCommand('copy:html')
      },
      { type: 'separator' }
    );

    template.push(
      { role: 'undo', enabled: Boolean(editFlags.canUndo) },
      { role: 'redo', enabled: Boolean(editFlags.canRedo) },
      { type: 'separator' },
      { role: 'cut', enabled: Boolean(editFlags.canCut) },
      { role: 'copy', enabled: Boolean(editFlags.canCopy) },
      { role: 'paste', enabled: Boolean(editFlags.canPaste) },
      { role: 'delete', enabled: Boolean(editFlags.canDelete) },
      { type: 'separator' },
      {
        label: 'Spell Check',
        type: 'checkbox',
        checked: spellcheckEnabled,
        click: (menuItem) => {
          setSpellcheckEnabled(menuItem.checked, hostWindow);
        }
      },
      { type: 'separator' },
      { role: 'selectAll', enabled: Boolean(editFlags.canSelectAll) }
    );
  } else {
    if (selectionText) {
      template.push(
        { role: 'copy' },
        {
          label: 'Copy as Markdown',
          click: () => sendEditorCommand('copy:markdown')
        },
        {
          label: 'Copy as HTML',
          click: () => sendEditorCommand('copy:html')
        },
        { type: 'separator' }
      );
    }

    template.push({
      label: 'Spell Check',
      type: 'checkbox',
      checked: spellcheckEnabled,
      click: (menuItem) => {
        setSpellcheckEnabled(menuItem.checked, hostWindow);
      }
    });
  }

  const menu = Menu.buildFromTemplate(template);

  if (hostWindow) {
    menu.popup({ window: hostWindow });
  } else {
    menu.popup();
  }
}

function createWindow(initialFilePath = null) {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#f7f8f6',
    icon: appIconPath,
    title: 'Tachylite',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: spellcheckEnabled
    }
  });

  if (process.platform === 'win32') {
    win.setAppDetails({
      appId: APP_USER_MODEL_ID,
      appIconPath,
      appIconIndex: 0,
      relaunchCommand: process.execPath,
      relaunchDisplayName: 'Tachylite'
    });
  }

  appWindows.add(win);
  mainWindow = win;
  const mainWebContents = win.webContents;
  const webContentsId = mainWebContents.id;

  if (initialFilePath) {
    initialFilePaths.set(webContentsId, initialFilePath);
  }

  win.once('ready-to-show', () => {
    win.show();
  });

  win.on('focus', () => {
    mainWindow = win;
    sendCommand('check-external-changes', undefined, win);
  });

  win.on('close', (event) => confirmWindowClose(event, win));

  win.on('closed', () => {
    appWindows.delete(win);
    initialFilePaths.delete(webContentsId);

    if (mainWindow === win) {
      mainWindow = activeAppWindow();
    }
  });

  mainWebContents.on('context-menu', (_event, params) => {
    showEditorContextMenu(mainWebContents, params);
  });

  mainWebContents.once('did-finish-load', () => {
    applySpellcheckPreference(win);
    applyThemePreference(win);
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

ipcMain.handle('file:initial', async (event) => {
  const initialPath = initialFilePaths.get(event.sender.id) || null;
  initialFilePaths.delete(event.sender.id);

  if (!initialPath) {
    return { canceled: true };
  }

  try {
    return { canceled: false, file: await readMarkdownFile(initialPath) };
  } catch (error) {
    return { canceled: true, error: error.message };
  }
});

ipcMain.handle('file:open', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || activeAppWindow();
  const result = await dialog.showOpenDialog(win || undefined, {
    title: 'Open Markdown File',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdc'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  const files = await Promise.all(result.filePaths.map(readMarkdownFile));
  return { canceled: false, file: files[0], files };
});

ipcMain.handle('file:reload-if-changed', async (_event, { filePath, diskMtimeMs }) => {
  if (!filePath) {
    return { changed: false };
  }

  try {
    const stats = await fs.stat(filePath);

    if (Number(stats.mtimeMs) <= Number(diskMtimeMs || 0)) {
      return { changed: false, diskMtimeMs: stats.mtimeMs };
    }

    return { changed: true, file: await readMarkdownFile(filePath) };
  } catch (error) {
    return { changed: false, error: error.message };
  }
});

ipcMain.handle('file:save', async (event, { filePath, fileName, content }) => {
  const win = BrowserWindow.fromWebContents(event.sender) || activeAppWindow();

  return saveMarkdownFile({
    filePath,
    fileName: fileName || (filePath ? path.basename(filePath) : 'Untitled.md'),
    content,
    title: 'Save Markdown File',
    win
  });
});

ipcMain.handle('file:save-as', async (event, { filePath, fileName, content }) => {
  const win = BrowserWindow.fromWebContents(event.sender) || activeAppWindow();
  const result = await dialog.showSaveDialog(win || undefined, {
    title: 'Save Markdown File As',
    defaultPath: filePath || fileName || 'Untitled.md',
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdc'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

  await fs.writeFile(result.filePath, content, 'utf8');
  rememberRecentFile(result.filePath);
  return { canceled: false, file: await filePayload(result.filePath, content) };
});

ipcMain.handle('file:export-html', async (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender) || activeAppWindow();
  return exportHtmlFile({ ...payload, win });
});

ipcMain.handle('file:export', async (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender) || activeAppWindow();
  return exportTextFile({ ...payload, win });
});

ipcMain.handle('file:export-pdf', async (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender) || activeAppWindow();
  return exportPdfFile({ ...payload, win });
});

ipcMain.handle('shell:open-target', async (_event, href) => {
  try {
    const target = new URL(href);

    if (['http:', 'https:', 'mailto:'].includes(target.protocol)) {
      await openLinkTarget(target.href);
      return { ok: true };
    }

    if (target.protocol === 'file:') {
      await shell.openPath(fileURLToPath(target));
      return { ok: true };
    }
  } catch (error) {
    return { ok: false, error: error.message };
  }

  return { ok: false, error: 'Unsupported link target.' };
});

ipcMain.handle('spellcheck:get-enabled', () => {
  return spellcheckEnabled;
});

ipcMain.handle('theme:get', () => {
  return selectedTheme;
});

ipcMain.handle('theme:set', async (_event, theme) => {
  return setTheme(theme);
});

ipcMain.handle('clipboard:write', (_event, payload) => {
  clipboard.write({
    text: payload.text || '',
    html: payload.html || undefined
  });
  return { ok: true };
});

ipcMain.handle('document:confirm-close', async (event, fileName = 'Untitled.md') => {
  const win = BrowserWindow.fromWebContents(event.sender) || activeAppWindow();
  const result = await dialog.showMessageBox(win || undefined, {
    type: 'warning',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Unsaved Changes',
    message: `Save changes to ${fileName || 'Untitled.md'} before closing this tab?`,
    detail: 'Your changes will be lost if you do not save them.'
  });

  return ['save', 'discard', 'cancel'][result.response] || 'cancel';
});

ipcMain.handle('window:new', () => {
  createWindow();
  return { ok: true };
});

ipcMain.handle('zoom:in', (event) => {
  return adjustZoom(event.sender, ZOOM_LEVEL_STEP);
});

ipcMain.handle('zoom:out', (event) => {
  return adjustZoom(event.sender, -ZOOM_LEVEL_STEP);
});

ipcMain.handle('zoom:reset', (event) => {
  return resetZoom(event.sender);
});

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  openFileInWindow(filePath);
});

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const filePath = findFilePathFromArgs(argv);
    if (filePath) {
      openFileInWindow(filePath);
    } else if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }

      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    await loadPreferences();
    createMenu();
    createWindow(findInitialFilePath());

    app.on('activate', () => {
      if (Array.from(appWindows).filter((win) => !win.isDestroyed()).length === 0) {
        createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
