// Pure logic for the workspace tab strip (tab titles, drop classification, ordering), separated
// from Electron so it can be unit-tested. Dual-exported: require() in the main process and the
// tests, window.tabShell in the tab-strip renderer. IIFE so nothing leaks to global scope.
(function () {
  // Tab label for a workspace view: the last two path segments ("parent/leaf", matching the
  // in-view workspace name), or the localized "new tab" word while the view shows the landing
  // screen (no workspace applied yet).
  function tabTitleForWorkspace({ wslPath = '', showLanding = false } = {}, landingWord = 'New Tab') {
    if (showLanding || !wslPath) return landingWord;
    const segs = String(wslPath).split('/').filter(Boolean);
    return segs.slice(-2).join('/') || '/';
  }

  // Where a dragged tab landed, from its drop point in SCREEN coordinates and every window's
  // strip rectangle: back on its own strip (reorder), on another window's strip (merge into that
  // window), or anywhere else (tear off into a new window). Windows are tested in the given order,
  // so pass them front-most first when strips can overlap.
  function classifyTabDrop({ point = { x: 0, y: 0 }, windows = [], sourceWinId = null } = {}) {
    for (const w of windows) {
      const inStrip = point.x >= w.x && point.x < w.x + w.width &&
        point.y >= w.y && point.y < w.y + w.stripHeight;
      if (inStrip) return w.id === sourceWinId ? { type: 'reorder', winId: w.id } : { type: 'merge', winId: w.id };
    }
    return { type: 'outside' };
  }

  // Insertion index for a tab dropped at pointer x, given the other tabs' center x positions:
  // it lands after every tab whose center the pointer has passed.
  function insertionIndex(centers = [], x = 0) {
    let n = 0;
    for (const c of centers) if (x > c) n++;
    return n;
  }

  // Which tab becomes active when `closingId` is removed: the active tab stays unless it is the
  // one closing; then its right neighbor, else the new last tab; null when none remain.
  function nextActiveTab(tabs = [], closingId = null, activeId = null) {
    if (closingId !== activeId) return activeId;
    const i = tabs.indexOf(closingId);
    const rest = tabs.filter((t) => t !== closingId);
    if (!rest.length) return null;
    if (i < 0) return activeId;
    return rest[Math.min(i, rest.length - 1)];
  }

  // Window (taskbar / Alt+Tab) title: the active tab's workspace plus the attention mark when any
  // tab's CLI is waiting for input — a background window stays identifiable either way.
  function shellWindowTitle({ activeTitle = '', attentionCount = 0 } = {}) {
    const base = activeTitle ? `${activeTitle} — WSL Workbench` : 'WSL Workbench';
    return attentionCount > 0 ? `● ${base}` : base;
  }

  const tabShell = { tabTitleForWorkspace, classifyTabDrop, insertionIndex, nextActiveTab, shellWindowTitle };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = tabShell;
  }
  if (typeof window !== 'undefined') {
    window.tabShell = tabShell;
  }
})();
