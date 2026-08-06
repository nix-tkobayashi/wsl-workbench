// Tab strip renderer: draws the tabs pushed by the main process (tabs:state is the single source
// of truth) and reports user intent back (activate/close/new/drop). All drag geometry decisions
// that involve OTHER windows happen in main — this script only knows its own strip.
(function () {
  const tabsEl = document.getElementById('tabs');
  const newTabBtn = document.getElementById('newTab');
  const winMax = document.getElementById('winMax');

  let lang = 'en';
  let lastState = { tabs: [], activeId: null };
  let dragging = null; // { id, el, startX, startY, moved } while a tab drag is in progress
  let pendingState = null; // a tabs:state that arrived mid-drag; applied on drag end

  const t = (key) => window.i18n.t(lang, key);

  function render(state) {
    if (dragging) { pendingState = state; return; } // never rebuild under an active drag
    lastState = state;
    lang = window.i18n.normalizeLang(state.lang);
    document.title = state.title || 'WSL Workbench';
    newTabBtn.title = t('menu.newTab');
    tabsEl.textContent = '';
    for (const tab of state.tabs) {
      const el = document.createElement('div');
      el.className = 'wtab' + (tab.id === state.activeId ? ' active' : '') + (tab.attention ? ' attention' : '');
      el.dataset.id = String(tab.id);
      const title = document.createElement('span');
      title.className = 'wtab-title';
      title.textContent = tab.title;
      const close = document.createElement('span');
      close.className = 'wtab-close';
      close.textContent = '×';
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        window.api.tabsClose(tab.id);
      });
      el.append(title, close);
      el.addEventListener('pointerdown', (event) => onTabPointerDown(event, tab.id, el));
      // Middle-click closes, like every tabbed UI.
      el.addEventListener('auxclick', (event) => {
        if (event.button === 1) window.api.tabsClose(tab.id);
      });
      tabsEl.appendChild(el);
    }
  }

  // Drag lifecycle on one tab. Activation happens on pointerdown (like Chrome); a real drag starts
  // once the pointer moves past a small threshold. Pointer capture keeps move/up events flowing to
  // the tab even outside the window, and pointerup's screen coordinates are what main classifies.
  function onTabPointerDown(event, id, el) {
    if (event.button !== 0) return;
    window.api.tabsActivate(id);
    dragging = { id, el, startX: event.clientX, startY: event.clientY, moved: false };
    el.setPointerCapture(event.pointerId);

    const onMove = (move) => {
      if (!dragging) return;
      const dx = move.clientX - dragging.startX;
      const dy = move.clientY - dragging.startY;
      if (!dragging.moved && Math.hypot(dx, dy) < 5) return;
      dragging.moved = true;
      el.classList.add('dragging');
      el.style.transform = `translateX(${dx}px)`;
      // Outside the strip band = tear-off intent; dim the tab as feedback.
      const outside = move.clientY < -8 || move.clientY > 42 || move.clientX < 0 || move.clientX > window.innerWidth;
      el.classList.toggle('tearing', outside);
    };

    const finish = (up, cancelled) => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      const wasDrag = dragging && dragging.moved;
      dragging = null;
      el.classList.remove('dragging', 'tearing');
      el.style.transform = '';
      if (wasDrag && !cancelled) {
        // Insertion index among the OTHER tabs, from their centers vs. the pointer (strip-local).
        const centers = [...tabsEl.querySelectorAll('.wtab')]
          .filter((node) => node !== el)
          .map((node) => { const r = node.getBoundingClientRect(); return r.left + r.width / 2; });
        window.api.tabsDrop({
          id,
          screenX: up.screenX,
          screenY: up.screenY,
          toIndex: window.tabShell.insertionIndex(centers, up.clientX)
        });
      }
      if (pendingState) { const s = pendingState; pendingState = null; render(s); }
    };
    const onUp = (up) => finish(up, false);
    const onCancel = (up) => finish(up, true);

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
  }

  newTabBtn.addEventListener('click', () => window.api.tabsNew());

  // Custom window controls (frameless window), same wiring the workspace toolbar used to have.
  document.getElementById('winMin').addEventListener('click', () => window.api.windowMinimize());
  winMax.addEventListener('click', () => window.api.windowToggleMaximize());
  document.getElementById('winClose').addEventListener('click', () => window.api.windowClose());
  window.api.onWindowMaximized((isMax) => { winMax.innerHTML = isMax ? '&#xE923;' : '&#xE922;'; });
  // Double-click on the empty drag area toggles maximize (standard title-bar behavior).
  document.getElementById('dragSpace').addEventListener('dblclick', () => window.api.windowToggleMaximize());

  window.api.onTabsState((state) => render(state));
  window.api.onLangChanged(() => { /* strings arrive re-localized in the next tabs:state */ });
  window.api.tabsReady();
})();
