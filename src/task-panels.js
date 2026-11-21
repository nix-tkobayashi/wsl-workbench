// Task panels (issue #127): GitHub and Backlog tasks assigned to the user, each in its own
// resizable panel to the right of the editor. Loaded after renderer.js and uses its globals
// (config, t, secretsWs, activeTerminal). The main process holds the tokens and makes the API calls; this side
// only names the secret that holds a token.
(function () {
  const PROVIDERS = ['github', 'backlog'];
  const REFRESH_MS = 5 * 60 * 1000;
  const HIDDEN_KEY = 'taskPanelsHidden';
  const view = window.taskView;
  const row = document.getElementById('editorRow');
  const pane = (p) => document.getElementById(`taskPane-${p}`);
  const resizer = (p) => document.getElementById(`taskResizer-${p}`);

  let taskConfig = { github: null, backlog: null };
  let gen = 0; // bumped on every workspace change: results for the previous one are dropped
  const freshState = () => ({ loading: false, items: null, truncated: false, error: null, at: null });
  const state = { github: freshState(), backlog: freshState() };

  function readHidden() { try { return localStorage.getItem(HIDDEN_KEY) === '1'; } catch { return false; } }
  function writeHidden(on) { try { localStorage.setItem(HIDDEN_KEY, on ? '1' : '0'); } catch {} }
  function readWidth(p) {
    try { const n = parseInt(localStorage.getItem(`taskPaneWidth:${p}`), 10); return Number.isFinite(n) ? n : view.PANEL_DEFAULT; } catch { return view.PANEL_DEFAULT; }
  }
  function writeWidth(p, w) { try { localStorage.setItem(`taskPaneWidth:${p}`, String(w)); } catch {} }

  function configured(p) {
    const c = taskConfig[p];
    if (!c || !c.tokenKey) return false;
    return p === 'github' ? Array.isArray(c.repos) && c.repos.length > 0 : !!c.space;
  }
  const isShown = (p) => !!config && !readHidden() && configured(p);

  // Show the configured panels (none configured = just the editor) at their saved widths, fitted
  // so the editor keeps its minimum width.
  function layoutPanels() {
    const rowWidth = row.getBoundingClientRect().width;
    const shown = PROVIDERS.filter(isShown);
    for (const p of PROVIDERS) {
      pane(p).classList.toggle('hidden', !shown.includes(p));
      resizer(p).classList.toggle('hidden', !shown.includes(p));
    }
    const widths = rowWidth > 0 ? view.fitPanelWidths(shown.map(readWidth), rowWidth) : shown.map(readWidth);
    shown.forEach((p, i) => { pane(p).style.width = `${widths[i]}px`; });
  }

  function errorText(code) {
    const key = `tasks.error.${code}`;
    const text = t(key);
    return text === key ? t('tasks.error.generic').replace('{code}', String(code)) : text;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function githubItemEl(item) {
    const btn = el('button', 'task-item');
    btn.title = item.url;
    const line1 = el('div', 'task-line1');
    for (const role of item.roles) {
      const mark = el('span', `task-mark ${role}`, role === 'reviewer' ? '◆' : '●');
      mark.title = t(`tasks.role.${role}`);
      line1.appendChild(mark);
    }
    line1.appendChild(el('span', 'task-kind', item.kind === 'pr' ? (item.draft ? t('tasks.kind.draft') : 'PR') : 'Issue'));
    line1.appendChild(el('span', 'task-ref', item.ref));
    btn.append(line1, el('div', 'task-item-title', item.title));
    return btn;
  }

  function backlogItemEl(item) {
    const btn = el('button', 'task-item');
    btn.title = item.url;
    const line1 = el('div', 'task-line1');
    line1.appendChild(el('span', 'task-ref', item.ref));
    const meta = el('div', 'task-meta');
    if (item.status) meta.appendChild(el('span', 'task-status', item.status));
    if (item.due) {
      const due = el('span', 'task-due', t('tasks.due').replace('{date}', item.due));
      if (view.isOverdue(item.due)) due.classList.add('overdue');
      meta.appendChild(due);
    }
    btn.append(line1, el('div', 'task-item-title', item.title), meta);
    return btn;
  }

  // Type a task's URL into the focused terminal pane, without Enter (issue #130) — as the
  // secrets panel's → does with a secret's path.
  function insertUrl(url) {
    const text = view.terminalUrl(url);
    const entry = activeTerminal();
    if (!text || !entry || entry.exited) return;
    entry.term.paste(text);
    entry.term.focus();
  }

  // One list row: the task itself (click = open in the browser) and its → button.
  function itemRowEl(p, item) {
    const wrap = el('div', 'task-item-row');
    const node = p === 'github' ? githubItemEl(item) : backlogItemEl(item);
    node.dataset.id = item.id;
    node.addEventListener('click', () => window.api.openExternal(item.url));
    const insert = el('button', 'task-btn task-insert', '→');
    insert.dataset.id = item.id;
    insert.title = t('tasks.insertUrl');
    insert.disabled = !view.terminalUrl(item.url);
    insert.addEventListener('click', () => insertUrl(item.url));
    wrap.append(node, insert);
    return wrap;
  }

  function render(p) {
    const root = pane(p);
    const st = state[p];
    root.classList.toggle('loading', st.loading);
    root.querySelector('.task-refresh').disabled = st.loading;
    root.querySelector('.task-count').textContent = st.items ? `(${st.items.length})` : '';
    root.querySelector('.task-updated').textContent = st.at ? t('tasks.updatedAt').replace('{time}', view.timeLabel(st.at)) : '';
    const msg = root.querySelector('.task-message');
    let text = '';
    if (st.error) text = errorText(st.error);
    else if (st.items && st.truncated) text = t('tasks.truncated'); // before "empty": an empty partial list proves nothing
    else if (st.items && !st.items.length) text = t('tasks.empty');
    else if (!st.items && st.loading) text = t('tasks.loading');
    msg.textContent = text;
    msg.classList.toggle('hidden', !text);
    msg.classList.toggle('error', !!st.error);
    const list = root.querySelector('.task-list');
    // Keep keyboard focus on the same task across a re-render (e.g. the 5-minute refresh).
    const active = list.contains(document.activeElement) ? document.activeElement : null;
    const focused = active ? active.dataset.id : null;
    const focusedCls = active && active.classList.contains('task-insert') ? '.task-insert' : '.task-item';
    list.textContent = '';
    for (const item of st.items || []) {
      const node = itemRowEl(p, item);
      list.appendChild(node);
      if (focused && item.id === focused) node.querySelector(focusedCls).focus();
    }
  }

  // `fresh`: a manual ⟳ — skip cached lookups (Backlog's status list).
  async function refresh(p, fresh = false) {
    if (!isShown(p)) return;
    const st = state[p];
    if (st.loading) return;
    const myGen = gen;
    st.loading = true;
    render(p);
    let res;
    try { res = await window.api.tasksList(p, secretsWs(), fresh); } catch { res = { ok: false, error: 'network' }; }
    if (myGen !== gen) return; // the workspace changed meanwhile; its own refresh is under way
    st.loading = false;
    if (res && res.ok) { st.items = res.items || []; st.truncated = !!res.truncated; st.error = null; st.at = new Date(); }
    else st.error = (res && res.error) || 'network';
    render(p);
  }

  // Re-read the settings first: another window on the same workspace may have changed them
  // (a panel set up there appears here, one removed there disappears).
  async function reloadConfig() {
    if (!config) return false;
    const myGen = gen;
    let res;
    try { res = await window.api.tasksGetConfig(); } catch { return false; }
    if (myGen !== gen || !res) return false;
    const next = res.config || { github: null, backlog: null };
    for (const p of PROVIDERS) {
      if (JSON.stringify(next[p]) !== JSON.stringify(taskConfig[p])) { taskConfig[p] = next[p]; resetState(p); }
    }
    layoutPanels();
    return true;
  }

  async function refreshAll() {
    if (await reloadConfig()) PROVIDERS.forEach((p) => refresh(p));
  }
  async function refreshOne(p) {
    if (await reloadConfig()) refresh(p, true);
  }

  function resetState(p) {
    state[p] = freshState();
    render(p);
  }

  // After a workspace is applied: its own settings, panels and a first fetch.
  async function applyWorkspace() {
    const myGen = ++gen;
    if (closeDialog) closeDialog();
    taskConfig = { github: null, backlog: null };
    PROVIDERS.forEach(resetState);
    layoutPanels();
    if (!config) return;
    let res;
    try { res = await window.api.tasksGetConfig(); } catch { return; }
    if (myGen !== gen || !res) return;
    taskConfig = res.config || { github: null, backlog: null };
    layoutPanels();
    PROVIDERS.forEach((p) => refresh(p));
  }

  function toggleVisible() {
    if (!config) return;
    // Nothing to show or hide: don't store a "hidden" that would swallow the first panel set up.
    if (!PROVIDERS.some(configured)) { alert(t('tasks.noneConfigured')); return; }
    if (readHidden()) {
      writeHidden(false);
      layoutPanels();
      refreshAll();
    } else {
      writeHidden(true);
      layoutPanels();
    }
  }

  // Drag the bar on a panel's left edge: the panel's width follows the pointer (pointer capture,
  // as the other resizers, so an iframe preview can't swallow the release).
  function initResizer(p) {
    const handle = resizer(p);
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      try { handle.setPointerCapture(event.pointerId); } catch {}
      document.body.classList.add('resizing');
      const target = pane(p);
      const right = target.getBoundingClientRect().right;
      const rowWidth = row.getBoundingClientRect().width;
      const others = PROVIDERS.filter((o) => o !== p && isShown(o))
        .reduce((sum, o) => sum + pane(o).getBoundingClientRect().width + 1, 0);
      let width = target.getBoundingClientRect().width;
      const onMove = (moveEvent) => {
        if (moveEvent.buttons === 0) { onEnd(); return; }
        width = view.clampPanelWidth(right - moveEvent.clientX, rowWidth, others);
        target.style.width = `${width}px`;
      };
      const onEnd = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onEnd);
        handle.removeEventListener('pointercancel', onEnd);
        try { handle.releasePointerCapture(event.pointerId); } catch {}
        document.body.classList.remove('resizing');
        // Save what is on screen for every shown panel (the other may be fitted below its saved
        // width), so the next layout reproduces it instead of re-fitting the drag away.
        writeWidth(p, Math.round(width));
        for (const o of PROVIDERS) if (o !== p && isShown(o)) writeWidth(o, Math.round(pane(o).getBoundingClientRect().width));
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onEnd);
      handle.addEventListener('pointercancel', onEnd);
    });
  }

  // --- Settings dialog ---

  const modal = document.getElementById('taskSettingsModal');
  const modalTitle = document.getElementById('taskSettingsTitle');
  const modalBody = document.getElementById('taskSettingsBody');
  const modalError = document.getElementById('taskSettingsError');
  const saveBtn = document.getElementById('taskSettingsSave');
  const clearBtn = document.getElementById('taskSettingsClear');
  const cancelBtn = document.getElementById('taskSettingsCancel');
  let closeDialog = null;

  function field(labelText, control, hint) {
    const label = el('label', 'secret-field');
    label.appendChild(el('span', null, labelText));
    label.appendChild(control);
    if (hint) label.appendChild(el('span', 'task-hint', hint));
    return label;
  }

  function select(options, value) {
    const s = document.createElement('select');
    for (const [v, text] of options) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = text;
      s.appendChild(o);
    }
    if (value != null && options.some(([v]) => v === value)) s.value = value;
    return s;
  }

  function githubForm(current, tokenSel, ws) {
    const checked = new Set(current ? current.repos : []);
    let login = null;
    let repos = [];
    let seq = 0;
    // A free-text field with suggestions, not a fixed list: fine-grained tokens can't list their
    // organizations (GET /user/orgs returns nothing), so the name must be typeable.
    const ownerSel = document.createElement('input');
    ownerSel.type = 'text';
    ownerSel.spellcheck = false;
    ownerSel.placeholder = t('tasks.ownerPlaceholder');
    const ownerList = document.createElement('datalist');
    ownerList.id = 'taskOwnerList';
    ownerSel.setAttribute('list', ownerList.id);
    ownerSel.disabled = true;
    const search = document.createElement('input');
    search.type = 'text';
    search.spellcheck = false;
    search.placeholder = t('tasks.searchRepos');
    const list = el('div', 'task-repo-list');
    const countEl = el('span', 'task-hint');
    const updateCount = () => { countEl.textContent = t('tasks.checkedCount').replace('{n}', String(checked.size)); };

    // `hint` (loading / an error) shows above the list. Checked repos are always listed (any
    // owner), also while the lookup is loading or failing, so one GitHub no longer returns —
    // deleted, or out of the token's reach — can still be unchecked.
    let repoHint = null;
    function renderRepos(hint = null) {
      repoHint = hint;
      list.textContent = '';
      if (hint) list.appendChild(el('div', 'task-hint', hint));
      const shown = view.filterRepos([...new Set([...repos, ...checked])], search.value, checked);
      if (!shown.length) { if (!hint) list.appendChild(el('div', 'task-hint', t('tasks.noRepos'))); return; }
      for (const r of shown) {
        const label = el('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = checked.has(r);
        box.addEventListener('change', () => { if (box.checked) checked.add(r); else checked.delete(r); updateCount(); });
        label.append(box, el('span', null, r));
        list.appendChild(label);
      }
    }

    async function loadRepos() {
      const my = ++seq;
      const owner = ownerSel.value.trim();
      repos = [];
      if (!owner) { renderRepos(t('tasks.chooseOwner')); return; }
      renderRepos(t('tasks.loading'));
      let res;
      try { res = await window.api.tasksGithubRepos({ tokenKey: tokenSel.value, owner, login, workspace: ws }); } catch { res = { ok: false, error: 'network' }; }
      if (my !== seq) return;
      if (!res || !res.ok) { renderRepos(errorText((res && res.error) || 'network')); return; }
      repos = res.repos || [];
      // GitHub names are case-insensitive: a checked name whose case changed (a rename) follows
      // the current spelling instead of showing up twice.
      const current = new Map(repos.map((r) => [r.toLowerCase(), r]));
      for (const c of [...checked]) {
        const now = current.get(c.toLowerCase());
        if (now && now !== c) { checked.delete(c); checked.add(now); }
      }
      updateCount();
      renderRepos();
    }

    async function loadOwners() {
      const my = ++seq;
      login = null;
      repos = [];
      ownerList.textContent = '';
      ownerSel.disabled = true;
      if (!tokenSel.value) { renderRepos(t('tasks.chooseSecretFirst')); return; }
      renderRepos(t('tasks.loading'));
      let res;
      try { res = await window.api.tasksGithubOwners(tokenSel.value, ws); } catch { res = { ok: false, error: 'network' }; }
      if (my !== seq) return;
      if (!res || !res.ok) { renderRepos(errorText((res && res.error) || 'network')); return; }
      login = res.login;
      // Suggestions: the account, its organizations, and owners of repos already checked.
      const owners = [...new Set([...res.owners, ...[...checked].map((r) => r.split('/')[0])])];
      for (const o of owners) {
        const opt = document.createElement('option');
        opt.value = o;
        if (o === login) opt.label = `${o} ${t('tasks.personal')}`;
        ownerList.appendChild(opt);
      }
      // Start on the owner of an already checked repo, else the account itself.
      const firstOwner = [...checked].map((r) => r.split('/')[0])[0];
      ownerSel.value = firstOwner || login;
      ownerSel.disabled = false;
      loadRepos();
    }

    tokenSel.addEventListener('change', loadOwners);
    ownerSel.addEventListener('change', loadRepos);
    ownerSel.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); loadRepos(); } });
    search.addEventListener('input', () => renderRepos(repoHint));

    const ownerRow = el('div', 'task-row');
    ownerRow.append(ownerSel, ownerList);
    modalBody.append(field(t('tasks.owner'), ownerRow), field(t('tasks.repos'), search), list, countEl);
    updateCount();
    loadOwners();

    return () => {
      if (!checked.size) return { error: t('tasks.err.repos') };
      if (checked.size > view.REPOS_MAX) return { error: t('tasks.err.tooManyRepos').replace('{max}', String(view.REPOS_MAX)) };
      return { value: { tokenKey: tokenSel.value, repos: [...checked] } };
    };
  }

  function backlogForm(current) {
    const space = document.createElement('input');
    space.type = 'text';
    space.spellcheck = false;
    space.placeholder = 'example';
    space.value = current ? current.space : '';
    const domain = select([['com', 'backlog.com'], ['jp', 'backlog.jp']], current ? current.domain : 'com');
    const preview = el('span', 'task-hint');
    const update = () => {
      // Pasting the space's URL fills both fields.
      const m = /([A-Za-z0-9][A-Za-z0-9-]*)\.backlog\.(com|jp)/i.exec(space.value);
      if (m) { space.value = m[1]; domain.value = m[2].toLowerCase(); }
      const name = space.value.trim();
      preview.textContent = name ? `https://${name}.backlog.${domain.value}/` : '';
    };
    space.addEventListener('input', update);
    domain.addEventListener('change', update);
    update();
    const spaceRow = el('div', 'task-row');
    spaceRow.append(space, domain);
    modalBody.append(field(t('tasks.space'), spaceRow), preview);
    return () => {
      const name = space.value.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(name)) return { error: t('tasks.err.space') };
      return { value: { tokenKey: null, space: name, domain: domain.value } };
    };
  }

  let settingsSeq = 0; // only the latest open request builds the dialog
  async function openSettings(p) {
    if (!config) return;
    const my = ++settingsSeq;
    const ws = secretsWs();
    let res;
    try { res = await window.api.tasksGetConfig(); } catch { return; }
    if (my !== settingsSeq || !res || !sameSecretsWs(ws)) return;
    if (closeDialog) closeDialog(); // one dialog at a time (its Escape handler goes with it)
    const current = (res.config || {})[p] || null;
    const keys = res.secretKeys || [];

    modalTitle.textContent = t(`tasks.settingsTitle.${p}`);
    modalBody.textContent = '';
    modalError.textContent = '';
    clearBtn.classList.toggle('hidden', !current);
    saveBtn.disabled = false;

    const tokenSel = select([['', t('tasks.chooseSecret')], ...keys.map((k) => [k, k])], current ? current.tokenKey : '');
    modalBody.appendChild(field(t('tasks.token'), tokenSel, keys.length ? t(`tasks.tokenHint.${p}`) : t('tasks.noSecrets')));
    const getValue = p === 'github' ? githubForm(current, tokenSel, ws) : backlogForm(current);

    const close = () => {
      modal.classList.add('hidden');
      modal.removeEventListener('keydown', onKey);
      modalBody.textContent = '';
      if (closeDialog === close) closeDialog = null;
    };
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
    closeDialog = close;

    const apply = async (value) => {
      saveBtn.disabled = true;
      let out;
      try { out = await window.api.tasksSetConfig({ provider: p, value, workspace: ws }); } catch { out = { ok: false, error: 'network' }; }
      saveBtn.disabled = false;
      const open = closeDialog === close; // the dialog may have been closed while saving
      if (!out || !out.ok) { if (open) modalError.textContent = errorText((out && out.error) || 'network'); return; }
      if (open) close();
      // Saved: apply it even if the dialog was closed meanwhile (the workspace is still this one).
      if (!sameSecretsWs(ws)) return;
      if (value) writeHidden(false); // a panel just set up is shown
      // Adopt the saved settings; a panel whose settings another window changed meanwhile drops
      // its old list too.
      for (const q of PROVIDERS) {
        if (q === p || JSON.stringify(out.config[q]) !== JSON.stringify(taskConfig[q])) resetState(q);
      }
      taskConfig = out.config;
      layoutPanels();
      // This panel, and the other one if it just became visible without a list yet.
      PROVIDERS.forEach((q) => { if (q === p || !state[q].items) refresh(q); });
    };

    saveBtn.onclick = () => {
      if (!tokenSel.value) { modalError.textContent = t('tasks.err.token'); return; }
      const r = getValue();
      if (r.error) { modalError.textContent = r.error; return; }
      apply({ ...r.value, tokenKey: tokenSel.value });
    };
    clearBtn.onclick = () => {
      if (!confirm(t(`tasks.confirmClear.${p}`))) return;
      apply(null);
    };
    cancelBtn.onclick = close;
    modal.addEventListener('keydown', onKey);
    modal.classList.remove('hidden');
    tokenSel.focus();
  }

  function init() {
    for (const p of PROVIDERS) {
      initResizer(p);
      pane(p).querySelector('.task-refresh').addEventListener('click', () => refreshOne(p));
      pane(p).querySelector('.task-settings').addEventListener('click', () => openSettings(p));
      render(p);
    }
    window.api.onMenuToggleTaskPanels(toggleVisible);
    window.api.onMenuTaskSettings(openSettings);
    // Re-fit on any change of the editor row's width: window resize, or the tree divider drag.
    let fitQueued = false;
    new ResizeObserver(() => {
      if (fitQueued) return;
      fitQueued = true;
      requestAnimationFrame(() => { fitQueued = false; layoutPanels(); });
    }).observe(row);
    window.api.onLangChanged(() => PROVIDERS.forEach(render)); // runs after renderer's handler switched currentLang
    setInterval(() => { if (!document.hidden) refreshAll(); }, REFRESH_MS);
    // Back from minimized: catch up if the last refresh is stale.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      const stale = PROVIDERS.some((p) => isShown(p) && (!state[p].at || Date.now() - state[p].at.getTime() >= REFRESH_MS));
      if (stale) refreshAll();
    });
  }

  init();
  window.taskPanels = { applyWorkspace, openSettings, refresh: refreshAll };
})();
