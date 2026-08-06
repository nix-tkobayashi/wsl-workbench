const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, Menu, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const i18n = require('./i18n');
const { imageMimeForPath } = require('./file-types');
const { normalizeVersion, isNewer } = require('./version');

const RELEASES_API = 'https://api.github.com/repos/nix-tkobayashi/wsl-workbench/releases/latest';
const RELEASES_PAGE = 'https://github.com/nix-tkobayashi/wsl-workbench/releases/latest';
const REPO_URL = 'https://github.com/nix-tkobayashi/wsl-workbench';

const DEFAULT_DISTRO = process.env.WSLWB_DISTRO || 'Ubuntu';
// WSLg with systemd sets XDG_RUNTIME_DIR to /run/user/<uid> but leaves the Wayland socket under
// /mnt/wslg/runtime-dir, so wl-copy/wl-paste (hence Claude Code's clipboard image paste) can't find
// it. When the default socket is missing but WSLg's exists, point WAYLAND_DISPLAY at the real one.
// Shared by the terminal's login shell (so CLIs inside inherit it) and the image-bridge command.
const WSLG_WAYLAND_FIX =
  'if [ -S /mnt/wslg/runtime-dir/wayland-0 ] && [ ! -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/wayland-0" ]; ' +
  'then export WAYLAND_DISPLAY=/mnt/wslg/runtime-dir/wayland-0; fi';
// Every prompt reports the shell's cwd via OSC 7, so the renderer can start splits/new tabs in the
// directory the user is actually in. Literal % in $PWD is sent as %25 so the renderer's
// percent-decode is lossless; a $PWD containing control characters is not reported at all (a BEL/ESC
// in the path would terminate the OSC early or inject an escape sequence — such a cwd just keeps the
// previous tracked value). A PROMPT_COMMAND inherited from the login profile is kept by appending
// it. A user bashrc that later overwrites PROMPT_COMMAND just disables the tracking — splits then
// fall back to the workspace root, the pre-tracking behavior.
const CWD_PROMPT_EXPORT =
  'export PROMPT_COMMAND=\'case "$PWD" in *[[:cntrl:]]*) ;; *) printf "\\033]7;file://%s\\007" "${PWD//%/%25}";; esac\'"${PROMPT_COMMAND:+; $PROMPT_COMMAND}"';
const DEFAULT_WSL_PATH = process.env.WSLWB_PATH || `/home/${os.userInfo().username}/projects`;
const DEFAULT_WSL_HOME_PATH = process.env.WSLWB_HOME_PATH || `/home/${os.userInfo().username}`;
const WSL_FS_TIMEOUT_MS = Math.max(1000, Number(process.env.WSLWB_FS_TIMEOUT_MS) || 5000);

const { WORKSPACE_EXT } = require('./workspace-args'); // single source for the extension + argv parsing
const { shellCdCommand } = require('./terminal-actions'); // inherited-cwd `cd` for terminal:start
const { tabTitleForWorkspace, classifyTabDrop, nextActiveTab, shellWindowTitle } = require('./tab-shell');

// --- Tabbed windows: every BrowserWindow is a thin shell (its own webContents renders only the
// tab strip + window controls), and each open workspace is a WebContentsView child. A view keeps
// the same webContents for its whole life, so dragging a tab to another window (or tearing it off
// into a new one) re-parents the view without reloading — terminals (ptys), the editor, and all
// renderer state survive the move. ---
const TABSTRIP_H = 34; // must match the strip height in tabstrip.html
const windowState = new Map(); // BrowserWindow id -> { tabs: [view webContents id...], activeId }
const viewState = new Map();   // view webContents id -> { view, workspace, terminals, showLanding, attention, winId }
// Most-recently-focused window ids, front first. Electron exposes no z-order, so this stands in
// for it when a tab drop lands where two windows' strips overlap (classifyTabDrop picks the first
// hit, which must be the front-most strip).
const windowFocusOrder = [];

// --- Language / settings persistence ---
let currentLang = 'en';

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch { return {}; }
}
function writeSettings(patch) {
  try {
    const next = { ...readSettings(), ...patch };
    // Atomic write (temp file + rename): session saves hit this frequently, and a crash mid-write
    // must not leave settings.json truncated — readSettings() would silently reset to {} and the
    // next write would permanently drop everything else (language, recents, sessions).
    const target = settingsPath();
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, target);
  } catch (error) {
    console.error('Failed to write settings:', error);
  }
}
function initLanguage() {
  const saved = readSettings().lang;
  if (saved) { currentLang = i18n.normalizeLang(saved); return; }
  // First run: follow the OS/Electron locale, default to English.
  currentLang = String(app.getLocale() || '').toLowerCase().startsWith('ja') ? 'ja' : 'en';
}
function setLanguage(lang) {
  const next = i18n.normalizeLang(lang);
  if (next === currentLang) return;
  currentLang = next;
  writeSettings({ lang: currentLang });
  buildAppMenu();
  // Workspace views localize their whole UI; shells re-localize tab titles via tabs:state.
  for (const state of viewState.values()) {
    if (!state.view.webContents.isDestroyed()) state.view.webContents.send('lang:changed', currentLang);
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) { win.webContents.send('lang:changed', currentLang); pushTabsState(win); }
  }
}
const tr = (key) => i18n.t(currentLang, key);

function defaultWorkspace() {
  return { distro: DEFAULT_DISTRO, wslPath: DEFAULT_WSL_PATH };
}

// findWorkspaceArg comes from workspace-args.js too (unit-tested; it also parses the argv the
// 'second-instance' event forwards, which carries Chromium switches).
const { findWorkspaceArg } = require('./workspace-args');
const { initialWindowState } = require('./startup-workspace');
const { withTimeout } = require('./async-timeout');

function readWorkspaceFile(filePath, fallback = defaultWorkspace()) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  return normalizeWorkspace(data, fallback);
}

function normalizeWorkspace(next = {}, fallback = defaultWorkspace()) {
  return {
    distro: next.distro || fallback.distro || DEFAULT_DISTRO,
    wslPath: next.wslPath || fallback.wslPath || DEFAULT_WSL_PATH
  };
}

// Per-view state for an IPC sender (a workspace view's webContents). `win` is the view's CURRENT
// owner window — resolved through our own registry, not BrowserWindow.fromWebContents, because a
// tear-off re-parents the view and the registry is what tracks that.
function getStateForWebContents(webContents) {
  const state = viewState.get(webContents.id);
  if (!state) throw new Error('View state not found.');
  const win = state.winId != null ? BrowserWindow.fromId(state.winId) : null;
  if (!win || win.isDestroyed()) throw new Error('Window not found.');
  return { win, state };
}

// The window an IPC sender belongs to: a shell strip sends from the window's own webContents,
// a workspace view resolves through the registry.
function windowForSender(sender) {
  const state = viewState.get(sender.id);
  if (state) return state.winId != null ? BrowserWindow.fromId(state.winId) : null;
  return BrowserWindow.fromWebContents(sender);
}

// The focused window plus its ACTIVE TAB's view state (menu actions target the visible workspace).
function getFocusedWindowAndState() {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (!win) return { win: null, state: null };
  const ws = windowState.get(win.id);
  return { win, state: (ws && viewState.get(ws.activeId)) || null };
}

// Forward a menu action to the focused window's ACTIVE workspace view (the shell webContents
// only renders the tab strip and knows nothing about trees or terminals).
function sendToFocusedWindow(channel) {
  const { state } = getFocusedWindowAndState();
  if (state && !state.view.webContents.isDestroyed()) state.view.webContents.send(channel);
}

function getDefaultOpenWorkspacePath(distro = DEFAULT_DISTRO) {
  // Prefer the WSL user home in the Windows directory picker.
  // Example: \\wsl.localhost\Ubuntu\home\skype
  return wslPathToWindowsFsPath(distro, DEFAULT_WSL_HOME_PATH);
}

// Track opened workspaces in settings: `recentWorkspaces` feeds the landing screen's quick-open
// list, `lastWorkspace` lets the next launch restore where the user left off.
const RECENT_WORKSPACES_MAX = 12;
function rememberWorkspace(ws) {
  const workspace = normalizeWorkspace(ws);
  const key = `${workspace.distro}:${workspace.wslPath}`;
  const prev = readSettings().recentWorkspaces;
  const list = Array.isArray(prev) ? prev : [];
  const next = [workspace, ...list.filter((e) => e && `${e.distro}:${e.wslPath}` !== key)].slice(0, RECENT_WORKSPACES_MAX);
  writeSettings({ recentWorkspaces: next, lastWorkspace: workspace });
}

function setCurrentWorkspaceForView(state, next) {
  if (!state) return;
  state.workspace = normalizeWorkspace(next, state.workspace);
  state.showLanding = false;
  // NOT remembered here: the renderer may still reject this switch (dirty-tab discard prompt).
  // rememberWorkspace() runs on terminal:start, which only fires once a workspace is really applied.
  const wc = state.view.webContents;
  if (!wc.isDestroyed()) wc.send('workspace:changed', { ...state.workspace });
  const win = state.winId != null ? BrowserWindow.fromId(state.winId) : null;
  if (win) pushTabsState(win); // the tab label follows the workspace
}

const { wslPathToWindowsFsPath, parseSelectedPath, isNtfsAdsPath, isZoneIdentifierName } = require('./wsl-paths');
const { copyFileContentsSync } = require('./fs-copy');


function safeStat(fullPath) {
  try { return fs.statSync(fullPath); } catch { return null; }
}

const SKIP_EXTERNAL_NAMES = new Set([
  'NTUSER.DAT',
  'ntuser.dat',
  'ntuser.ini',
  'UsrClass.dat',
  'pagefile.sys',
  'hiberfil.sys',
  'swapfile.sys'
]);

function shouldSkipExternalPath(source) {
  const base = path.basename(source);
  if (SKIP_EXTERNAL_NAMES.has(base)) return true;
  if (/^ntuser\.dat/i.test(base)) return true;
  if (/^UsrClass\.dat/i.test(base)) return true;
  return false;
}

function copyRecursiveSafeSync(source, destination, result) {
  if (shouldSkipExternalPath(source)) {
    result.skipped.push({ source, reason: 'system profile file' });
    return;
  }

  let stat;
  try {
    stat = fs.statSync(source);
  } catch (error) {
    result.skipped.push({ source, reason: error.code || error.message });
    return;
  }

  if (safeStat(destination)) {
    result.skipped.push({ source, reason: 'destination exists' });
    return;
  }

  if (stat.isDirectory()) {
    try {
      fs.mkdirSync(destination, { recursive: false });
    } catch (error) {
      result.skipped.push({ source, reason: error.code || error.message });
      return;
    }

    let entries;
    try {
      entries = fs.readdirSync(source, { withFileTypes: true });
    } catch (error) {
      result.skipped.push({ source, reason: error.code || error.message });
      return;
    }

    for (const entry of entries) {
      const childSource = path.join(source, entry.name);
      const childDestination = path.join(destination, entry.name);
      copyRecursiveSafeSync(childSource, childDestination, result);
    }
    result.copied.push(destination);
    return;
  }

  if (stat.isFile()) {
    try {
      // Not fs.copyFileSync: that maps to Win32 CopyFile, which drags NTFS alternate data streams
      // along, and WSL's 9P server materializes them as literal `name:stream` junk files on ext4
      // (Zone.Identifier on downloaded files, #47). Copy only the default stream instead.
      copyFileContentsSync(source, destination);
      result.copied.push(destination);
    } catch (error) {
      result.skipped.push({ source, reason: error.code || error.message });
    }
    return;
  }

  result.skipped.push({ source, reason: 'not a regular file or directory' });
}

// Entries the tree never shows: Git internals, plus the `name:Zone.Identifier` files Windows
// Explorer leaves in a WSL directory when it copies a downloaded file's Mark-of-the-Web stream
// onto ext4 (#57). They carry no content, cannot be created by this app (it strips ADS while
// copying, #47) and their name renders as garbled next to the real file. Also applied to the
// change signature below, so a stray one appearing does not trigger a tree refresh either.
// Only regular files are hidden: such a name on a directory is a real one the user made, since
// the stream residue is always a plain file.
function isHiddenTreeEntry(entry) {
  return entry.name.startsWith('.git') || (entry.isFile() && isZoneIdentifierName(entry.name));
}

async function readDirTree({ distro = DEFAULT_DISTRO, wslPath = DEFAULT_WSL_PATH }) {
  const fullPath = wslPathToWindowsFsPath(distro, wslPath);
  let stat;
  try {
    stat = await withTimeout(
      fs.promises.stat(fullPath),
      WSL_FS_TIMEOUT_MS,
      `WSL path did not respond within ${WSL_FS_TIMEOUT_MS}ms: ${fullPath}`
    );
  } catch (error) {
    if (error && error.code === 'ETIMEDOUT') throw error;
    stat = null;
  }
  if (!stat) throw new Error(`Path not found: ${fullPath}`);
  const dirEntries = await withTimeout(
    fs.promises.readdir(fullPath, { withFileTypes: true }),
    WSL_FS_TIMEOUT_MS,
    `WSL directory did not respond within ${WSL_FS_TIMEOUT_MS}ms: ${fullPath}`
  );
  const entries = dirEntries
    .filter((entry) => !isHiddenTreeEntry(entry))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((entry) => {
      const childWslPath = path.posix.join(wslPath, entry.name);
      return {
        name: entry.name,
        path: childWslPath,
        type: entry.isDirectory() ? 'directory' : 'file',
        hasChildren: entry.isDirectory()
      };
    });
  return { name: path.posix.basename(wslPath) || '/', path: wslPath, type: 'directory', children: entries };
}

// Security hardening shared by the shell and every workspace view: never let content (e.g. a link
// in the Markdown preview) open an Electron window or navigate away from our page. http(s) targets
// are handed to the OS browser; everything else is denied. This also backstops any click path
// (middle-click, window.open) that the renderer's own link handler doesn't intercept.
function hardenWebContents(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
}

// A shell window: frameless, its own webContents renders only the tab strip (drag region, tabs,
// window controls). Workspace views are attached below the strip by addTab().
function createShellWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 880,
    minHeight: 560,
    frame: false,
    autoHideMenuBar: true, // the real menu is kept for accelerators; the strip has no menu row
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  windowState.set(win.id, { tabs: [], activeId: null });
  windowFocusOrder.unshift(win.id); // a new window opens in front

  win.on('focus', () => {
    const i = windowFocusOrder.indexOf(win.id);
    if (i > 0) { windowFocusOrder.splice(i, 1); windowFocusOrder.unshift(win.id); }
  });

  win.on('closed', () => {
    // Destroy every view still parented here (a re-parented view has already changed winId).
    for (const [id, state] of viewState) {
      if (state.winId === win.id) destroyView(id);
    }
    windowState.delete(win.id);
    const i = windowFocusOrder.indexOf(win.id);
    if (i >= 0) windowFocusOrder.splice(i, 1);
  });

  const relayout = () => layoutViews(win);
  win.on('resize', relayout);
  win.on('maximize', () => { relayout(); sendMaximized(win); });
  win.on('unmaximize', () => { relayout(); sendMaximized(win); });

  hardenWebContents(win.webContents);
  win.loadFile(path.join(__dirname, 'tabstrip.html'));
  return win;
}

// Keep the strip's custom maximize/restore button glyph in sync with the actual window state.
function sendMaximized(win) {
  if (!win.isDestroyed()) win.webContents.send('window:maximized', win.isMaximized());
}

// A workspace view: the full existing single-page app (tree/editor/terminals) in a
// WebContentsView. Its webContents is the stable identity every per-workspace IPC keys on.
function createWorkspaceView(initialWorkspace = defaultWorkspace(), { showLanding = false } = {}) {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      plugins: true // Chromium's built-in PDF viewer (used by the editor's PDF preview iframe)
    }
  });
  const wc = view.webContents;
  viewState.set(wc.id, {
    view,
    workspace: normalizeWorkspace(initialWorkspace),
    terminals: new Map(), // terminal id -> pty (multiple terminal tabs per workspace)
    showLanding,
    attention: 0, // panes in this view currently waiting for user input (OSC 9)
    winId: null
  });
  hardenWebContents(wc);
  // Views created after the startup update check completed still get the notification (the
  // pre-load webContents.send from checkForUpdatesInBackground is lost if the page isn't ready).
  wc.on('did-finish-load', () => {
    if (startupUpdate && !wc.isDestroyed()) wc.send('update:available', { version: startupUpdate.version });
  });
  wc.loadFile(path.join(__dirname, 'index.html'));
  return view;
}

function destroyView(id) {
  const state = viewState.get(id);
  if (!state) return;
  for (const ptyProc of state.terminals.values()) {
    try { ptyProc.kill(); } catch {}
  }
  viewState.delete(id);
  try { state.view.webContents.close(); } catch {}
}

// Every view of a window shares the same bounds (the area under the strip); only the active one
// is visible. Sized on every window resize and on attach.
function layoutViews(win) {
  const ws = windowState.get(win.id);
  if (!ws || win.isDestroyed()) return;
  const [width, height] = win.getContentSize();
  const bounds = { x: 0, y: TABSTRIP_H, width, height: Math.max(0, height - TABSTRIP_H) };
  for (const id of ws.tabs) {
    const state = viewState.get(id);
    if (state) state.view.setBounds(bounds);
  }
}

// Push the full strip model to a shell (tabs, active tab, aggregated attention) and mirror the
// aggregate on the window title (Alt+Tab) + taskbar overlay. One source of truth: main.
function pushTabsState(win) {
  const ws = windowState.get(win.id);
  if (!ws || win.isDestroyed()) return;
  const tabs = ws.tabs.map((id) => {
    const state = viewState.get(id);
    const landing = !!(state && state.showLanding);
    return {
      id,
      title: tabTitleForWorkspace(
        { wslPath: state ? state.workspace.wslPath : '', showLanding: landing },
        tr('tabs.newTab')
      ),
      // Hover tooltip: the untruncated identity of the tab (full workspace path; ellipsized
      // labels and same-named leaf directories are both disambiguated by it).
      tooltip: landing || !state ? tr('tabs.newTab') : `${state.workspace.distro}: ${state.workspace.wslPath}`,
      attention: !!(state && state.attention > 0)
    };
  });
  const attentionTotal = ws.tabs.reduce((n, id) => n + ((viewState.get(id) || {}).attention || 0), 0);
  const active = tabs.find((tab) => tab.id === ws.activeId);
  win.webContents.send('tabs:state', {
    tabs,
    activeId: ws.activeId,
    lang: currentLang,
    title: shellWindowTitle({ activeTitle: active ? active.title : '', attentionCount: attentionTotal })
  });
  updateWindowOverlay(win, attentionTotal);
}

// The overlay dot travels from a workspace renderer as a data URL once (canvas-drawn); reuse it
// for every window. setOverlayIcon is a no-op outside Windows and must never break the caller.
let attentionIconDataUrl = null;
function updateWindowOverlay(win, attentionTotal) {
  try {
    if (attentionTotal > 0 && attentionIconDataUrl) {
      const image = nativeImage.createFromDataURL(attentionIconDataUrl);
      if (!image.isEmpty()) win.setOverlayIcon(image, tr('attention.waiting'));
    } else {
      win.setOverlayIcon(null, '');
    }
  } catch {}
}

function addTab(win, viewId, { activate = true } = {}) {
  const ws = windowState.get(win.id);
  const state = viewState.get(viewId);
  if (!ws || !state || win.isDestroyed()) return;
  ws.tabs.push(viewId);
  state.winId = win.id;
  win.contentView.addChildView(state.view);
  layoutViews(win);
  if (activate || ws.tabs.length === 1) activateTab(win, viewId);
  else { state.view.setVisible(false); pushTabsState(win); }
}

function activateTab(win, viewId) {
  const ws = windowState.get(win.id);
  if (!ws || !ws.tabs.includes(viewId)) return;
  ws.activeId = viewId;
  for (const id of ws.tabs) {
    const state = viewState.get(id);
    if (state) state.view.setVisible(id === viewId);
  }
  const active = viewState.get(viewId);
  if (active && !active.view.webContents.isDestroyed()) active.view.webContents.focus();
  pushTabsState(win);
}

// Remove a tab from its window: destroy=true closes the workspace (tab ×, Ctrl+W), destroy=false
// keeps the view alive for re-parenting (tear-off / merge). Closing the last tab closes the window.
function removeTab(win, viewId, { destroy = true } = {}) {
  const ws = windowState.get(win.id);
  const state = viewState.get(viewId);
  if (!ws || !ws.tabs.includes(viewId)) return;
  const nextId = nextActiveTab(ws.tabs, viewId, ws.activeId);
  ws.tabs = ws.tabs.filter((id) => id !== viewId);
  if (state) {
    try { win.contentView.removeChildView(state.view); } catch {}
    state.winId = null;
  }
  if (destroy) destroyView(viewId);
  if (!ws.tabs.length) { win.close(); return; }
  if (nextId != null && nextId !== ws.activeId) activateTab(win, nextId);
  else pushTabsState(win);
}

// Public window factory (same signature as before the tab refactor): a shell with one workspace tab.
function createWindow(initialWorkspace = defaultWorkspace(), { showLanding = false } = {}) {
  const win = createShellWindow();
  const view = createWorkspaceView(initialWorkspace, { showLanding });
  addTab(win, view.webContents.id, { activate: true });
  buildAppMenu();
  return win;
}

async function openWorkspaceDialog(win, state) {
  if (!win || !state) return;
  const result = await dialog.showOpenDialog(win, {
    title: tr('dialog.openWorkspace'),
    defaultPath: getDefaultOpenWorkspacePath(state.workspace.distro),
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return;
  const parsed = parseSelectedPath(result.filePaths[0]);
  setCurrentWorkspaceForView(state, {
    // Use the distro from the selected path (supports non-default distros like Ubuntu-22.04);
    // fall back to the current distro for drive (/mnt) selections.
    distro: parsed.distro || state.workspace.distro,
    wslPath: parsed.wslPath
  });
}

async function openWorkspaceFileDialog(win, state) {
  if (!win || !state) return;
  const result = await dialog.showOpenDialog(win, {
    title: tr('dialog.openWorkspaceFile'),
    properties: ['openFile'],
    filters: [
      { name: tr('filter.workspace'), extensions: [WORKSPACE_EXT, 'json'] },
      { name: tr('filter.allFiles'), extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths[0]) return;
  try {
    setCurrentWorkspaceForView(state, readWorkspaceFile(result.filePaths[0], state.workspace));
  } catch (error) {
    dialog.showErrorBox(tr('dialog.openFileFailed'), error.message || String(error));
  }
}

// Only trust https URLs on github.com (never trust an arbitrary URL from the API response).
function isGithubHttpsUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'github.com';
  } catch {
    return false;
  }
}

function safeReleaseUrl(url) {
  return isGithubHttpsUrl(url) ? url : RELEASES_PAGE;
}

// Pick the NSIS one-click installer asset (e.g. "WSL.Workbench.Setup.0.6.0.exe") — not the portable build.
function pickInstallerAsset(assets) {
  if (!Array.isArray(assets)) return null;
  const asset = assets.find((a) =>
    a && typeof a.name === 'string' &&
    /setup/i.test(a.name) && a.name.toLowerCase().endsWith('.exe') &&
    isGithubHttpsUrl(a.browser_download_url));
  return asset ? { name: path.basename(asset.name), url: asset.browser_download_url } : null;
}

// Fetch the latest release version from GitHub (best-effort, short timeout).
async function fetchLatestRelease() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'wsl-workbench' },
      signal: controller.signal
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      version: normalizeVersion(data.tag_name),
      url: safeReleaseUrl(data.html_url),
      installer: pickInstallerAsset(data.assets)
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Refuse to execute an installer unless it is Authenticode-signed by the same publisher as the
// running app (matched on certificate subject so it survives a self-signed cert renewal). This
// guards against running arbitrary bytes if the release/GitHub account is ever compromised.
function verifyInstallerSignature(installerPath) {
  try {
    const script =
      "$ErrorActionPreference='Stop';" +
      '$a=Get-AuthenticodeSignature -LiteralPath $env:WB_INSTALLER;' +
      '$b=Get-AuthenticodeSignature -LiteralPath $env:WB_SELF;' +
      '[pscustomobject]@{it=$a.SignerCertificate.Subject;is=$a.Status.ToString();st=$b.SignerCertificate.Subject}|ConvertTo-Json -Compress';
    const ps = require('child_process').spawnSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env: { ...process.env, WB_INSTALLER: installerPath, WB_SELF: process.execPath }, timeout: 20000, encoding: 'utf8' });
    if (ps.status !== 0 || !ps.stdout) return { ok: false, reason: 'verification failed' };
    const info = JSON.parse(ps.stdout.trim());
    if (!info.it) return { ok: false, reason: 'installer is not signed' };
    // Require a trusted certificate chain — this is the real cryptographic guarantee (a tampered
    // installer is HashMismatch; a forged self-signed cert is untrusted). The chain is trusted only
    // if the user installed the publisher cert into their trust store (the documented install step).
    if (info.is !== 'Valid') return { ok: false, reason: `untrusted (${info.is})` };
    // Defense in depth: when the running app is itself signed, pin the installer to the same publisher
    // so a different, unrelated trusted cert cannot be substituted.
    if (info.st && String(info.it).toLowerCase() !== String(info.st).toLowerCase()) {
      return { ok: false, reason: 'publisher mismatch' };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message || 'verification error' };
  }
}

// Spawn the installer detached, then quit so it can replace the running app. Quit only once spawn
// has actually started (a missing/quarantined file emits 'error' first).
function launchInstallerAndQuit(installerPath) {
  return new Promise((resolve, reject) => {
    const child = require('child_process').spawn(installerPath, [], { detached: true, stdio: 'ignore' });
    let settled = false;
    child.once('error', (error) => { if (!settled) { settled = true; reject(error); } });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      child.unref();
      app.quit();
      resolve();
    }, 500);
  });
}

// Download the installer to a temp file (reporting progress to the window), verify its signature,
// launch it, and quit. The NSIS one-click installer relaunches the app when it finishes.
let updateInProgress = false;
async function downloadAndInstallUpdate(win, installer) {
  if (updateInProgress) return;
  updateInProgress = true;
  const { pipeline } = require('stream/promises');
  const { Readable } = require('stream');
  // Progress UI lives in the workspace renderer, so route to the window's active view (the shell
  // webContents only draws the tab strip).
  const send = (payload) => {
    const ws = win && !win.isDestroyed() ? windowState.get(win.id) : null;
    const state = ws ? viewState.get(ws.activeId) : null;
    if (state && !state.view.webContents.isDestroyed()) state.view.webContents.send('update:progress', payload);
  };
  const setBar = (frac) => { if (win && !win.isDestroyed()) win.setProgressBar(frac); };
  const dest = path.join(app.getPath('temp'), installer.name);
  const controller = new AbortController();
  let stallTimer = null;
  const armStall = () => { if (stallTimer) clearTimeout(stallTimer); stallTimer = setTimeout(() => controller.abort(), 60000); };
  try {
    send({ phase: 'download', received: 0, total: 0 });
    armStall();
    const res = await fetch(installer.url, { headers: { 'User-Agent': 'wsl-workbench' }, signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    let received = 0;
    const source = Readable.fromWeb(res.body);
    source.on('data', (chunk) => {
      received += chunk.length;
      armStall();
      send({ phase: 'download', received, total });
      setBar(total > 0 ? received / total : -1);
    });
    // pipeline cleans up both streams (and the dest file) on any error, including an abort.
    await pipeline(source, fs.createWriteStream(dest), { signal: controller.signal });
    clearTimeout(stallTimer);
    setBar(-1);

    const verdict = verifyInstallerSignature(dest);
    if (!verdict.ok) throw new Error(`${tr('update.untrusted')} (${verdict.reason})`);

    send({ phase: 'launching' });
    await launchInstallerAndQuit(dest);
  } catch (error) {
    updateInProgress = false;
    clearTimeout(stallTimer);
    setBar(-1);
    try { fs.unlinkSync(dest); } catch {}
    send({ phase: 'error', message: error.message || String(error) });
    dialog.showErrorBox(tr('update.failed'), error.message || String(error));
  }
}

// Startup update check: fetched once, cached, and pushed to every window so the menubar can show
// an "update available" button next to Help. Its click handler (update:install below) reuses the
// same one-click download/verify/install path as the About dialog.
let startupUpdate = null;
async function checkForUpdatesInBackground() {
  const latest = await fetchLatestRelease();
  if (!latest || !latest.version || !isNewer(latest.version, app.getVersion())) return;
  startupUpdate = latest;
  // The update button lives in the workspace toolbar, so notify views (not shells).
  for (const state of viewState.values()) {
    if (!state.view.webContents.isDestroyed()) state.view.webContents.send('update:available', { version: latest.version });
  }
}

ipcMain.handle('update:install', (event) => {
  const latest = startupUpdate;
  if (!latest) return { ok: false };
  const win = windowForSender(event.sender);
  if (latest.installer) downloadAndInstallUpdate(win, latest.installer);
  else shell.openExternal(latest.url || RELEASES_PAGE).catch(() => {});
  return { ok: true };
});

// "About" dialog: shows the current version, checks GitHub for the latest, and offers to open the
// release page when a newer version exists.
async function showAboutDialog(win) {
  const current = app.getVersion();
  const latest = await fetchLatestRelease();

  const lines = [`${tr('about.currentVersion')}: ${current}`];
  // Buttons and a parallel list of click actions (null = just dismiss). Index 0 is the default.
  const buttons = [];
  const actions = [];
  const addButton = (label, fn) => { buttons.push(label); actions.push(fn || null); };

  if (latest && latest.version) {
    lines.push(`${tr('about.latestVersion')}: ${latest.version}`);
    if (isNewer(latest.version, current)) {
      lines.push('', tr('about.updateAvailable'));
      const target0 = win && !win.isDestroyed() ? win : null;
      if (latest.installer) addButton(tr('about.downloadInstall'), () => downloadAndInstallUpdate(target0, latest.installer));
      else addButton(tr('about.openReleasePage'), () => shell.openExternal(latest.url).catch(() => {}));
    } else {
      lines.push('', tr('about.upToDate'));
    }
  } else {
    lines.push('', tr('about.checkFailed'));
  }
  lines.push('', `GitHub: ${REPO_URL}`);
  addButton(tr('about.github'), () => shell.openExternal(REPO_URL).catch(() => {}));
  addButton(tr('about.close'), null);

  const target = win && !win.isDestroyed() ? win : null;
  const opts = {
    type: 'info',
    title: tr('menu.about'),
    message: 'WSL Workbench',
    detail: lines.join('\n'),
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1
  };
  const result = target ? await dialog.showMessageBox(target, opts) : await dialog.showMessageBox(opts);
  const fn = actions[result.response];
  if (fn) fn();
}

function buildAppMenu() {
  const template = [
    {
      label: tr('menu.workspace'),
      submenu: [
        {
          label: tr('menu.newWindow'),
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            createWindow(defaultWorkspace(), { showLanding: true });
          }
        },
        {
          label: tr('menu.newTab'),
          accelerator: 'CmdOrCtrl+T',
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (!win || !windowState.has(win.id)) return;
            const view = createWorkspaceView(defaultWorkspace(), { showLanding: true });
            addTab(win, view.webContents.id, { activate: true });
          }
        },
        {
          label: tr('menu.openWorkspace'),
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            const { win, state } = getFocusedWindowAndState();
            openWorkspaceDialog(win, state);
          }
        },
        {
          label: tr('menu.openWorkspaceFile'),
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => {
            const { win, state } = getFocusedWindowAndState();
            openWorkspaceFileDialog(win, state);
          }
        },
        {
          label: tr('menu.saveWorkspace'),
          accelerator: 'CmdOrCtrl+Shift+S',
          click: async () => {
            const { win, state } = getFocusedWindowAndState();
            if (!win || !state) return;
            // Default the filename to the workspace directory name, e.g. test003.wslwb-workspace.
            const dirName = String(state.workspace.wslPath || '').split('/').filter(Boolean).pop() || 'workspace';
            const result = await dialog.showSaveDialog(win, {
              title: tr('dialog.saveWorkspace'),
              defaultPath: `${dirName}.${WORKSPACE_EXT}`,
              filters: [
                { name: tr('filter.workspace'), extensions: [WORKSPACE_EXT, 'json'] },
                { name: tr('filter.allFiles'), extensions: ['*'] }
              ]
            });
            if (result.canceled || !result.filePath) return;
            fs.writeFileSync(result.filePath, JSON.stringify({ ...state.workspace, app: 'WSL Workbench', version: 1 }, null, 2), 'utf8');
          }
        },
        { type: 'separator' },
        {
          label: tr('menu.refresh'),
          accelerator: 'F5',
          click: () => sendToFocusedWindow('menu:refreshTree')
        },
        {
          label: tr('menu.restartTerminal'),
          click: () => sendToFocusedWindow('menu:restartTerminal')
        },
        { type: 'separator' },
        {
          label: tr('menu.exit'),
          accelerator: 'CmdOrCtrl+W',
          // Close only the active TAB of the window this menu acted on (the window itself closes
          // with its last tab; window-all-closed then quits the app as before).
          click: (_item, focusedWindow) => {
            const win = focusedWindow || BrowserWindow.getFocusedWindow();
            if (!win || win.isDestroyed()) return;
            const ws = windowState.get(win.id);
            if (ws && ws.activeId != null) removeTab(win, ws.activeId, { destroy: true });
            else win.close();
          }
        }
      ]
    },
    {
      label: tr('menu.edit'),
      submenu: [
        { role: 'undo', label: tr('menu.undo') },
        { role: 'redo', label: tr('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: tr('menu.cut') },
        { role: 'copy', label: tr('menu.copy') },
        { role: 'paste', label: tr('menu.paste') },
        { role: 'selectAll', label: tr('menu.selectAll') }
      ]
    },
    {
      label: tr('menu.view'),
      submenu: [
        { role: 'reload', label: tr('menu.reload') },
        { role: 'forceReload', label: tr('menu.forceReload') },
        { role: 'toggleDevTools', label: tr('menu.toggleDevTools') },
        { type: 'separator' },
        { role: 'resetZoom', label: tr('menu.resetZoom') },
        { role: 'zoomIn', label: tr('menu.zoomIn') },
        { role: 'zoomOut', label: tr('menu.zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: tr('menu.toggleFullscreen') }
      ]
    },
    {
      label: tr('menu.language'),
      submenu: [
        {
          label: tr('menu.english'),
          type: 'radio',
          checked: currentLang === 'en',
          click: () => setLanguage('en')
        },
        {
          label: tr('menu.japanese'),
          type: 'radio',
          checked: currentLang === 'ja',
          click: () => setLanguage('ja')
        }
      ]
    },
    {
      label: tr('menu.help'),
      submenu: [
        {
          label: tr('menu.about'),
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            showAboutDialog(win);
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Single instance: launching the exe again (app icon, .wslwb-workspace double-click) must not boot
// a whole second Electron — main + GPU + utility processes cost hundreds of MB per instance. The
// second launch forwards its argv here and exits; this first instance opens the requested window
// (only a renderer process is added, everything else is shared).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const workspaceFile = findWorkspaceArg(argv);
    if (workspaceFile) {
      try {
        createWindow(readWorkspaceFile(workspaceFile), { showLanding: false });
        return;
      } catch (error) {
        dialog.showErrorBox(tr('dialog.openFileFailed'), error.message || String(error));
      }
    }
    // Plain re-launch: a fresh landing window (recents are one click away). Not the last workspace —
    // that's already open in this instance, so restoring it here would just duplicate the window.
    createWindow(defaultWorkspace(), { showLanding: true });
  });

  app.whenReady().then(() => {
    initLanguage();
    checkForUpdatesInBackground(); // fire-and-forget; windows are notified when a newer release exists
    const workspaceFile = findWorkspaceArg(process.argv);
    if (workspaceFile) {
      try {
        // Launched via a workspace file (e.g. file association): open it directly.
        createWindow(readWorkspaceFile(workspaceFile), { showLanding: false });
        return;
      } catch (error) {
        dialog.showErrorBox(tr('dialog.openFileFailed'), error.message || String(error));
      }
    }
    // Never synchronously touch a WSL UNC path before the first BrowserWindow exists. A stopped or
    // wedged WSL provider can otherwise block the main process while it holds the single-instance
    // lock, making every later launch appear to do nothing. The renderer validates the restored
    // workspace through readDirTree(), which is asynchronous and time-limited.
    const initial = initialWindowState(readSettings(), defaultWorkspace());
    createWindow(normalizeWorkspace(initial.workspace), { showLanding: initial.showLanding });
  });
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(defaultWorkspace(), { showLanding: true }); });

ipcMain.handle('window:new', (_event, workspace) => {
  // Used by the tree's "Open in New Window": the directory is already chosen, so skip landing.
  createWindow(normalizeWorkspace(workspace), { showLanding: false });
  return { ok: true };
});

ipcMain.handle('config:get', (event) => {
  const { state } = getStateForWebContents(event.sender);
  return { ...normalizeWorkspace(state.workspace), showLanding: !!state.showLanding, lang: currentLang };
});

ipcMain.handle('workspace:openDirectory', (event) => {
  const { win, state } = getStateForWebContents(event.sender);
  return openWorkspaceDialog(win, state);
});

ipcMain.handle('workspace:openFile', (event) => {
  const { win, state } = getStateForWebContents(event.sender);
  return openWorkspaceFileDialog(win, state);
});

// The directory `git clone <url>` creates: the URL's last path segment without a trailing .git.
// Handles https URLs and scp-style (git@host:user/repo.git); returns '' if none can be derived.
function repoDirNameFromUrl(url) {
  const trimmed = String(url).trim().replace(/[/\\]+$/, '');
  const last = trimmed.split(/[/\\:]/).pop() || '';
  const name = last.replace(/\.git$/i, '');
  return (name === '.' || name === '..') ? '' : name;
}

// Run `git clone` inside the distro. url/name are passed as argv (never through a shell) so a hostile
// URL can't inject commands; `--` stops git from reading either as an option. GIT_TERMINAL_PROMPT=0 +
// GIT_ASKPASS=/bin/true make auth failures error out instead of hanging on a prompt with no TTY.
function runWslGitClone(distro, parentDirPath, url, name) {
  return new Promise((resolve) => {
    const args = ['-d', distro, '--cd', parentDirPath, '--',
      'env', 'GIT_TERMINAL_PROMPT=0', 'GIT_ASKPASS=/bin/true', 'git', 'clone', '--', url, name];
    const child = require('child_process').spawn('wsl.exe', args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => resolve({ ok: false, message: String(err.message || err) }));
    child.on('close', (code) => resolve({ ok: code === 0, message: stderr.trim() }));
  });
}

// Clone a repo into the chosen parent folder, then open the cloned directory as the workspace.
ipcMain.handle('workspace:clone', async (event, { distro = DEFAULT_DISTRO, parentDirPath, url } = {}) => {
  const { state } = getStateForWebContents(event.sender);
  if (!url || !url.trim()) throw new Error('Repository URL is required.');
  if (!parentDirPath) throw new Error('Destination folder is required.');
  const cleanUrl = url.trim();
  const name = repoDirNameFromUrl(cleanUrl);
  if (!name) throw new Error('Could not determine a folder name from the URL.');
  const targetWslPath = path.posix.join(parentDirPath, name);
  const targetFsPath = wslPathToWindowsFsPath(distro, targetWslPath);
  if (safeStat(targetFsPath)) throw new Error(`Already exists: ${name}`);

  const res = await runWslGitClone(distro, parentDirPath, cleanUrl, name);
  if (!res.ok) throw new Error(res.message || 'git clone failed.');
  if (!safeStat(targetFsPath)) throw new Error('Clone succeeded but the folder was not found.');

  setCurrentWorkspaceForView(state, { distro, wslPath: targetWslPath });
  return { ok: true, wslPath: targetWslPath, name };
});

// Recent workspaces for the landing screen, filtered to directories that still exist.
ipcMain.handle('workspace:recent', () => {
  const list = readSettings().recentWorkspaces;
  if (!Array.isArray(list)) return [];
  // Do not probe every \\wsl.localhost entry while rendering the landing screen. Stale entries are
  // harmless: selecting one goes through the asynchronous, time-limited tree load and rolls back.
  return list.filter((e) => e && e.wslPath)
    .map((e) => ({ distro: e.distro || DEFAULT_DISTRO, wslPath: e.wslPath }));
});

// Open one of the recent workspaces (clicked on the landing screen).
ipcMain.handle('workspace:openRecent', (event, { distro = DEFAULT_DISTRO, wslPath } = {}) => {
  const { state } = getStateForWebContents(event.sender);
  if (!wslPath) throw new Error('wslPath is required.');
  // applyWorkspace() validates this through readDirTree() and rolls back on failure. Doing a
  // synchronous stat here would freeze the Electron main process when WSL is unresponsive.
  setCurrentWorkspaceForView(state, { distro, wslPath });
  return { ok: true };
});

// --- Editor session persistence: which files were open per workspace, restored on reopen. ---
const SESSION_TABS_MAX = 15;
const SESSION_KEYS_MAX = 20;
ipcMain.on('session:save', (_event, { key, tabs, active } = {}) => {
  if (typeof key !== 'string' || !key) return;
  const cleanTabs = (Array.isArray(tabs) ? tabs : []).filter((p) => typeof p === 'string').slice(0, SESSION_TABS_MAX);
  const sessions = { ...(readSettings().sessions || {}) };
  sessions[key] = { tabs: cleanTabs, active: typeof active === 'string' ? active : null, ts: Date.now() };
  // Cap stored workspaces, dropping the least recently saved.
  const keys = Object.keys(sessions).sort((a, b) => (sessions[b].ts || 0) - (sessions[a].ts || 0));
  for (const k of keys.slice(SESSION_KEYS_MAX)) delete sessions[k];
  writeSettings({ sessions });
});
ipcMain.handle('session:get', (_event, { key } = {}) => {
  if (typeof key !== 'string' || !key) return null;
  return (readSettings().sessions || {})[key] || null;
});

// Re-assert renderer state as the source of truth (e.g. the user cancelled a discard prompt, or a
// workspace failed to load) without re-broadcasting or restarting the terminal.
ipcMain.handle('workspace:resync', (event, { workspace, showLanding = false } = {}) => {
  const { win, state } = getStateForWebContents(event.sender);
  if (workspace) state.workspace = normalizeWorkspace(workspace, state.workspace);
  state.showLanding = !!showLanding;
  pushTabsState(win); // the tab label follows the re-asserted workspace / landing state
  return { ok: true };
});

// Clipboard via the main process: the `clipboard` module is not available in a sandboxed preload,
// so the renderer reaches it through these IPC channels. sendSync keeps the renderer API synchronous.
ipcMain.on('clipboard:writeText', (event, text) => {
  clipboard.writeText(String(text ?? ''));
  event.returnValue = true;
});
ipcMain.on('clipboard:readText', (event) => {
  event.returnValue = clipboard.readText();
});
// True when the clipboard holds a bitmap image (e.g. a screenshot). Lets the renderer decide whether
// a paste in the tree/terminal should be handled as an image instead of text.
ipcMain.on('clipboard:hasImage', (event) => {
  event.returnValue = !clipboard.readImage().isEmpty();
});

// Bridge the clipboard image into the WSL distro's own clipboard as PNG. Claude Code reads the OS
// clipboard on Ctrl+V (via wl-copy/xclip) and shows it as [Image #N]; a Windows-side clipboard image
// (BMP over WSLg) isn't visible to it, so we push a PNG in ourselves, then the renderer sends Ctrl+V.
// The PNG is staged to a temp file (not piped straight into a tool) so that if wl-copy is present but
// its Wayland server is unreachable, we can still fall through to xclip on the same bytes. stdout/
// stderr go to /dev/null so the daemon wl-copy/xclip forks doesn't hold spawnSync's pipes open.
// Returns { ok }; the renderer reports failure to the user (it does not write a file).
ipcMain.handle('clipboard:pushImageToWsl', (_event, { distro = DEFAULT_DISTRO } = {}) => {
  const image = clipboard.readImage();
  if (image.isEmpty()) return { ok: false, reason: 'no-image' };
  const script = `${WSLG_WAYLAND_FIX}; ` +
    'tmp=$(mktemp --suffix=.png) || exit 4; cat > "$tmp"; rc=3; ' +
    'if command -v wl-copy >/dev/null 2>&1; then wl-copy --type image/png < "$tmp" >/dev/null 2>&1 && rc=0; fi; ' +
    'if [ $rc -ne 0 ] && command -v xclip >/dev/null 2>&1; then xclip -selection clipboard -t image/png -i "$tmp" >/dev/null 2>&1 && rc=0; fi; ' +
    'rm -f "$tmp"; exit $rc';
  const res = require('child_process').spawnSync(
    'wsl.exe', ['-d', distro, '--exec', 'bash', '-lc', script],
    { input: image.toPNG(), timeout: 10000 }
  );
  if (res.error) return { ok: false, reason: String(res.error.message || res.error) };
  if (res.status !== 0) return { ok: false, reason: `exit-${res.status}` };
  return { ok: true };
});

// Custom window controls (frameless window): the tab strip's min/max/close buttons drive these.
ipcMain.on('window:minimize', (event) => {
  windowForSender(event.sender)?.minimize();
});
ipcMain.on('window:toggleMaximize', (event) => {
  const win = windowForSender(event.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('window:close', (event) => {
  windowForSender(event.sender)?.close();
});

// Attention state from a workspace view (panes whose AI CLI finished and waits for input, OSC 9).
// Stored per view, then mirrored per window: a dot on the view's tab, the aggregated count on the
// window title and the taskbar icon overlay — the right tab and the right window stay identifiable
// even when hidden. The dot image is drawn by the renderer (canvas → data URL).
ipcMain.on('window:attention', (event, { count = 0, icon = '' } = {}) => {
  const state = viewState.get(event.sender.id);
  if (!state) return;
  state.attention = Math.max(0, Number(count) || 0);
  if (icon) attentionIconDataUrl = String(icon);
  const win = state.winId != null ? BrowserWindow.fromId(state.winId) : null;
  if (win && !win.isDestroyed()) pushTabsState(win);
});

// Pop a top-level application menu's submenu at a screen position, so the in-app toolbar buttons
// can show the real menus (the native menu bar itself is hidden via autoHideMenuBar). index maps
// to the application menu's top-level order: 0 Workspace, 1 Edit, 2 View, 3 Language, 4 Help.
// A workspace view's coordinates are view-relative, so its strip-height offset is added back.
ipcMain.on('menu:popup', (event, { index, x, y } = {}) => {
  const win = windowForSender(event.sender);
  const appMenu = Menu.getApplicationMenu();
  if (!win || !appMenu) return;
  const yOffset = viewState.has(event.sender.id) ? TABSTRIP_H : 0;
  const item = appMenu.items[index];
  if (item && item.submenu) {
    item.submenu.popup({ window: win, x: Math.round(x || 0), y: Math.round((y || 0) + yOffset) });
  }
});

// --- Tab strip IPC (sender = a shell window's own webContents) ---
ipcMain.on('tabs:ready', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  pushTabsState(win);
  sendMaximized(win);
});
ipcMain.on('tabs:activate', (event, { id } = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) activateTab(win, id);
});
ipcMain.on('tabs:close', (event, { id } = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) removeTab(win, id, { destroy: true });
});
ipcMain.on('tabs:new', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const view = createWorkspaceView(defaultWorkspace(), { showLanding: true });
  addTab(win, view.webContents.id, { activate: true });
});

// A tab was dropped after a drag: back on its own strip at toIndex (reorder), on another window's
// strip (merge: re-parent the view there), or anywhere else (tear off into a new window at the
// cursor). The drop point is classified in screen coordinates against every shell's strip rect.
ipcMain.on('tabs:drop', (event, { id, screenX = 0, screenY = 0, toIndex = -1 } = {}) => {
  const sourceWin = BrowserWindow.fromWebContents(event.sender);
  const ws = sourceWin && windowState.get(sourceWin.id);
  if (!ws || !ws.tabs.includes(id)) return;
  // Front-most first (see windowFocusOrder): classifyTabDrop picks the first strip hit, and where
  // strips overlap the visible one must win.
  const zIndex = new Map(windowFocusOrder.map((winId, i) => [winId, i]));
  const windows = BrowserWindow.getAllWindows()
    .filter((w) => !w.isDestroyed() && windowState.has(w.id))
    .sort((a, b) => (zIndex.get(a.id) ?? Infinity) - (zIndex.get(b.id) ?? Infinity))
    .map((w) => ({ id: w.id, ...w.getContentBounds(), stripHeight: TABSTRIP_H }));
  const verdict = classifyTabDrop({
    point: { x: Math.round(screenX), y: Math.round(screenY) },
    windows,
    sourceWinId: sourceWin.id
  });
  if (verdict.type === 'reorder') {
    if (toIndex < 0) return;
    const rest = ws.tabs.filter((t) => t !== id);
    rest.splice(Math.min(Math.max(0, toIndex), rest.length), 0, id);
    ws.tabs = rest;
    pushTabsState(sourceWin);
  } else if (verdict.type === 'merge') {
    const target = BrowserWindow.fromId(verdict.winId);
    if (!target || target.isDestroyed()) return;
    removeTab(sourceWin, id, { destroy: false });
    addTab(target, id, { activate: true });
    target.focus();
  } else {
    // Tear-off. A single-tab window is already its own window: dragging it out is a no-op.
    if (ws.tabs.length <= 1) return;
    removeTab(sourceWin, id, { destroy: false });
    const win = createShellWindow();
    win.setPosition(Math.max(0, Math.round(screenX - 120)), Math.max(0, Math.round(screenY - 10)));
    addTab(win, id, { activate: true });
    win.focus();
  }
});

ipcMain.handle('tree:read', (_event, args) => readDirTree(args));

// Cheap fingerprint of the given directories' entries, used by the renderer to detect
// changes made outside the app (e.g. files created from the terminal) and refresh the tree.
// fs.watch does not work over \\wsl.localhost UNC paths, so the renderer polls this instead.
ipcMain.handle('tree:signature', async (_event, { distro = DEFAULT_DISTRO, paths = [] }) => {
  const parts = [];
  for (const wslPath of paths) {
    const fullPath = wslPathToWindowsFsPath(distro, wslPath);
    try {
      const entries = await fs.promises.readdir(fullPath, { withFileTypes: true });
      const names = entries
        .filter((entry) => !isHiddenTreeEntry(entry))
        .map((entry) => `${entry.isDirectory() ? 'd' : 'f'}:${entry.name}`)
        .sort();
      parts.push(`${wslPath}|${names.join(',')}`);
    } catch {
      parts.push(`${wslPath}|MISSING`);
    }
  }
  return parts.join('\n');
});

ipcMain.handle('file:read', (_event, { distro = DEFAULT_DISTRO, wslPath }) => {
  const fullPath = wslPathToWindowsFsPath(distro, wslPath);
  const stat = safeStat(fullPath);
  if (!stat || !stat.isFile()) return '';
  if (stat.size > 1024 * 1024) return '[File is larger than 1MB. Editor skipped.]';
  return fs.readFileSync(fullPath, 'utf8');
});

// Modification fingerprint of a file (mtime + size), used by the renderer to notice when an open
// editor file was changed on disk (e.g. by an AI CLI in the terminal) so it can reload it.
ipcMain.handle('file:stat', (_event, { distro = DEFAULT_DISTRO, wslPath } = {}) => {
  if (!wslPath) return null;
  const stat = safeStat(wslPathToWindowsFsPath(distro, wslPath));
  return stat && stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : null;
});

// Read an image file as a data: URL for the renderer's <img> preview.
ipcMain.handle('file:readImage', (_event, { distro = DEFAULT_DISTRO, wslPath }) => {
  const fullPath = wslPathToWindowsFsPath(distro, wslPath);
  const stat = safeStat(fullPath);
  if (!stat || !stat.isFile()) throw new Error(`File not found: ${wslPath}`);
  if (stat.size > 16 * 1024 * 1024) throw new Error('Image is larger than 16MB.');
  const data = fs.readFileSync(fullPath).toString('base64');
  return `data:${imageMimeForPath(wslPath)};base64,${data}`;
});

// Read a PDF as a data: URL for the renderer's PDF preview iframe (Chromium's built-in viewer).
ipcMain.handle('file:readPdf', (_event, { distro = DEFAULT_DISTRO, wslPath }) => {
  const fullPath = wslPathToWindowsFsPath(distro, wslPath);
  const stat = safeStat(fullPath);
  if (!stat || !stat.isFile()) throw new Error(`File not found: ${wslPath}`);
  if (stat.size > 50 * 1024 * 1024) throw new Error('PDF is larger than 50MB.');
  const data = fs.readFileSync(fullPath).toString('base64');
  return `data:application/pdf;base64,${data}`;
});

ipcMain.handle('file:write', (_event, { distro = DEFAULT_DISTRO, wslPath, content }) => {
  if (!wslPath) throw new Error('wslPath is required.');
  const fullPath = wslPathToWindowsFsPath(distro, wslPath);
  const stat = safeStat(fullPath);
  if (!stat || !stat.isFile()) throw new Error(`File not found: ${wslPath}`);
  fs.writeFileSync(fullPath, content ?? '', 'utf8');
  // Return the new fingerprint so the renderer can update its baseline and not mistake this very
  // save for an external change on the next poll.
  const after = safeStat(fullPath);
  return { ok: true, mtimeMs: after ? after.mtimeMs : null, size: after ? after.size : null };
});

// Open an http(s) link (e.g. clicked in the Markdown preview) in the user's default browser. Only
// web schemes are allowed so a document can't launch arbitrary local protocols.
ipcMain.handle('shell:openExternal', (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  return { ok: true };
});

// Current git branch (or short SHA when detached) plus the working tree's porcelain status, for
// the tree-header badge AND the tree's per-file git coloring. One spawn serves both. Returns null
// when the workspace isn't a git repo or git is unavailable.
const { parseGitInfoOutput } = require('./git-status');
ipcMain.handle('git:info', (_event, { distro = DEFAULT_DISTRO, wslPath } = {}) => {
  if (!wslPath) return null;
  const script =
    'b=$(git branch --show-current 2>/dev/null); ' +
    '[ -z "$b" ] && b=$(git rev-parse --short HEAD 2>/dev/null); ' +
    '[ -z "$b" ] && exit 0; ' +
    'echo "$b"; git rev-parse --show-toplevel 2>/dev/null; ' +
    // Remote URL (origin, else the first remote) for the repo-link icon; always exactly one line
    // (possibly empty) so the porcelain lines below stay at a fixed offset for the parser.
    'git remote get-url origin 2>/dev/null || git remote get-url "$(git remote 2>/dev/null | head -n1)" 2>/dev/null || echo; ' +
    // quotepath=false keeps UTF-8 names (e.g. Japanese) unescaped so tree paths match.
    'git -c core.quotepath=false status --porcelain 2>/dev/null';
  const res = require('child_process').spawnSync(
    'wsl.exe', ['-d', distro, '--cd', wslPath, '--exec', 'bash', '-lc', script],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 10 * 1024 * 1024 }
  );
  if (res.error || res.status !== 0) return null;
  const parsed = parseGitInfoOutput(res.stdout);
  if (!parsed) return null;
  // dirty counts EVERY porcelain line (rawCount), including entries the parser skipped (C-quoted
  // control-char names) or capped — the badge must not claim clean when git said otherwise.
  return { branch: parsed.branch, dirty: parsed.rawCount > 0, statuses: parsed.statuses, remoteUrl: parsed.remoteUrl };
});

ipcMain.handle('fs:move', (_event, { distro = DEFAULT_DISTRO, sourcePath, targetDirPath }) => {
  if (!sourcePath || !targetDirPath) throw new Error('sourcePath and targetDirPath are required.');
  if (sourcePath === targetDirPath || targetDirPath.startsWith(sourcePath + '/')) {
    throw new Error('Cannot move a directory into itself.');
  }
  const src = wslPathToWindowsFsPath(distro, sourcePath);
  const dst = wslPathToWindowsFsPath(distro, path.posix.join(targetDirPath, path.posix.basename(sourcePath)));
  if (!safeStat(src)) throw new Error(`Source not found: ${sourcePath}`);
  if (safeStat(dst)) throw new Error(`Destination already exists: ${path.posix.basename(dst)}`);
  fs.renameSync(src, dst);
  return { ok: true };
});

ipcMain.handle('fs:create', (_event, { distro = DEFAULT_DISTRO, parentDirPath, name, type = 'file' }) => {
  if (!parentDirPath || !name) throw new Error('parentDirPath and name are required.');
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') throw new Error('Invalid name.');
  const target = wslPathToWindowsFsPath(distro, path.posix.join(parentDirPath, name));
  if (safeStat(target)) throw new Error(`Already exists: ${name}`);
  if (type === 'directory') {
    fs.mkdirSync(target);
  } else {
    fs.writeFileSync(target, '', { flag: 'wx' });
  }
  return { ok: true };
});

ipcMain.handle('fs:rename', (_event, { distro = DEFAULT_DISTRO, sourcePath, newName }) => {
  if (!sourcePath || !newName) throw new Error('sourcePath and newName are required.');
  if (newName.includes('/') || newName.includes('\\') || newName === '.' || newName === '..') throw new Error('Invalid name.');
  const src = wslPathToWindowsFsPath(distro, sourcePath);
  const dstPath = path.posix.join(path.posix.dirname(sourcePath), newName);
  const dst = wslPathToWindowsFsPath(distro, dstPath);
  if (!safeStat(src)) throw new Error(`Source not found: ${sourcePath}`);
  if (safeStat(dst)) throw new Error(`Already exists: ${newName}`);
  fs.renameSync(src, dst);
  return { ok: true, path: dstPath };
});

ipcMain.handle('fs:delete', (_event, { distro = DEFAULT_DISTRO, targetPath }) => {
  if (!targetPath) throw new Error('targetPath is required.');
  const target = wslPathToWindowsFsPath(distro, targetPath);
  if (!safeStat(target)) throw new Error(`Target not found: ${targetPath}`);
  fs.rmSync(target, { recursive: true, force: false });
  return { ok: true };
});

ipcMain.handle('fs:reveal', async (_event, { distro = DEFAULT_DISTRO, targetPath }) => {
  if (!targetPath) throw new Error('targetPath is required.');
  const target = wslPathToWindowsFsPath(distro, targetPath);
  if (!safeStat(target)) throw new Error(`Target not found: ${targetPath}`);
  shell.showItemInFolder(target);
  return { ok: true };
});

// Two-digit zero-pad for the timestamp used in pasted-image filenames.
function pad2(n) { return String(n).padStart(2, '0'); }

// Save the clipboard's bitmap image as a PNG into the given WSL directory. Used by both the tree
// (explicit paste-to-save) and the terminal (so an AI CLI can reference the saved path). Returns the
// created file's WSL path so the renderer can refresh/insert it.
ipcMain.handle('fs:saveClipboardImage', (_event, { distro = DEFAULT_DISTRO, targetDirPath } = {}) => {
  if (!targetDirPath) throw new Error('targetDirPath is required.');
  const image = clipboard.readImage();
  if (image.isEmpty()) throw new Error('No image in clipboard.');
  const targetDir = wslPathToWindowsFsPath(distro, targetDirPath);
  const targetStat = safeStat(targetDir);
  if (!targetStat || !targetStat.isDirectory()) throw new Error(`Target directory not found: ${targetDirPath}`);

  const now = new Date();
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  const base = `pasted-image-${stamp}`;
  const png = image.toPNG();
  // Exclusive create ('wx') so a name collision (or a symlink planted between check and write) can't
  // clobber an existing file; on EEXIST, try the next suffix.
  let name = `${base}.png`;
  for (let i = 1; ; i++) {
    try {
      fs.writeFileSync(path.join(targetDir, name), png, { flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      name = `${base}-${i}.png`;
    }
  }
  return { ok: true, name, path: path.posix.join(targetDirPath, name) };
});

ipcMain.handle('fs:copyExternal', (_event, { distro = DEFAULT_DISTRO, sourcePaths = [], targetDirPath }) => {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) throw new Error('sourcePaths are required.');
  if (!targetDirPath) throw new Error('targetDirPath is required.');
  const targetDir = wslPathToWindowsFsPath(distro, targetDirPath);
  const targetStat = safeStat(targetDir);
  if (!targetStat || !targetStat.isDirectory()) throw new Error(`Target directory not found: ${targetDirPath}`);

  const result = { copied: [], skipped: [] };
  for (const sourcePath of sourcePaths) {
    // Explorer drags of browser-downloaded files also enumerate the file's NTFS Zone.Identifier
    // stream (Mark of the Web) as its own `name:Zone.Identifier` entry; ext4 has no ADS concept,
    // so copying it would materialize a junk file next to the real one. Exclude silently rather
    // than record a skip, so a real copy failure stays first in the reported skip list.
    if (isNtfsAdsPath(sourcePath)) continue;
    const sourceStat = safeStat(sourcePath);
    if (!sourceStat) {
      result.skipped.push({ source: sourcePath, reason: 'source not found' });
      continue;
    }
    const destination = path.join(targetDir, path.basename(sourcePath));
    copyRecursiveSafeSync(sourcePath, destination, result);
  }

  if (result.copied.length === 0 && result.skipped.length > 0) {
    const first = result.skipped[0];
    throw new Error(`No files were copied. First skipped item: ${first.source} (${first.reason})`);
  }

  return { ok: true, copied: result.copied, skipped: result.skipped };
});

ipcMain.handle('folder:pick', async (event) => {
  const { win, state } = getStateForWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: tr('dialog.openWorkspace'),
    defaultPath: getDefaultOpenWorkspacePath(state.workspace.distro),
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const selected = result.filePaths[0];
  const parsed = parseSelectedPath(selected);
  return { windowsPath: selected, wslPath: parsed.wslPath, distro: parsed.distro || state.workspace.distro };
});

ipcMain.on('terminal:start', (event, { id, distro, wslPath, command = '', cwd = '' }) => {
  const { win, state } = getStateForWebContents(event.sender);
  // pty output goes to the VIEW's webContents (event.sender): it is the stable endpoint that
  // survives the tab being re-parented to another window mid-session.
  const wc = event.sender;
  const workspace = normalizeWorkspace({ distro, wslPath }, state.workspace);
  state.workspace = workspace;
  pushTabsState(win); // the tab label follows the applied workspace
  // The renderer starts a terminal only after a workspace switch is really applied (a rejected
  // dirty-tab discard never gets here), so THIS is where recents/lastWorkspace are recorded.
  rememberWorkspace(workspace);
  const existing = state.terminals.get(id);
  if (existing) {
    try { existing.kill(); } catch {}
  }
  // Repair the Wayland env first so CLIs in the shell (e.g. Claude Code) can read clipboard images.
  // `cwd` (the source pane's tracked cwd for splits / new tabs / restarts) is applied as a
  // best-effort `cd` on top of the workspace-root --cd, so a bad path lands at the root, not in an
  // error. The workspace itself is NOT changed by an inherited cwd.
  const launch = command ? `${command}; exec bash` : 'exec bash';
  const parts = [WSLG_WAYLAND_FIX, CWD_PROMPT_EXPORT];
  const cd = shellCdCommand(cwd);
  if (cd) parts.push(cd);
  parts.push(launch);
  const args = ['-d', workspace.distro, '--cd', workspace.wslPath, '--exec', 'bash', '-lc', parts.join('; ')];
  const ptyProc = pty.spawn('wsl.exe', args, {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: os.homedir(),
    env: process.env
  });
  state.terminals.set(id, ptyProc);
  ptyProc.onData((data) => {
    if (state.terminals.get(id) !== ptyProc) return; // ignore output from a superseded pty
    if (!wc.isDestroyed()) wc.send('terminal:data', { id, data });
  });
  ptyProc.onExit(() => {
    if (state.terminals.get(id) !== ptyProc) return; // superseded by a newer pty for this id; ignore its late exit
    state.terminals.delete(id);
    if (!wc.isDestroyed()) {
      wc.send('terminal:data', { id, data: `\r\n\x1b[90m${tr('terminal.exited')}\x1b[0m\r\n` });
      wc.send('terminal:exit', { id });
    }
  });
});

ipcMain.on('terminal:write', (event, { id, data }) => {
  const { state } = getStateForWebContents(event.sender);
  const ptyProc = state.terminals.get(id);
  if (ptyProc) ptyProc.write(data);
});

ipcMain.on('terminal:resize', (event, { id, cols, rows }) => {
  const { state } = getStateForWebContents(event.sender);
  const ptyProc = state.terminals.get(id);
  if (ptyProc && cols && rows) ptyProc.resize(cols, rows);
});

ipcMain.on('terminal:close', (event, { id }) => {
  const { state } = getStateForWebContents(event.sender);
  const ptyProc = state.terminals.get(id);
  if (ptyProc) {
    try { ptyProc.kill(); } catch {}
  }
  state.terminals.delete(id);
});
