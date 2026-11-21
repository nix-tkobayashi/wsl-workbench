// Task panels (issues #127, #133, #134): GitHub tasks, the tasks of each Backlog space and Slack
// To-dos, each in its own resizable panel to the right of the editor. Loaded after renderer.js and
// uses its globals (config, t, secretsWs, activeTerminal). The main process holds the tokens and
// makes the API calls; this side only names the secret that holds a token.
(function () {
  const PROVIDERS = ['github', 'backlog', 'slack'];
  const REFRESH_MS = 5 * 60 * 1000;
  const HIDDEN_KEY = 'taskPanelsHidden';
  const view = window.taskView;
  const row = document.getElementById('editorRow');
  const emptyConfig = () => ({ github: null, backlog: [], slack: null });

  let taskConfig = emptyConfig();
  let gen = 0; // bumped on every workspace change: results for the previous one are dropped
  const freshState = () => ({ loading: false, items: null, truncated: false, error: null, at: null });
  // The panels on screen, left to right (view.panelList of the settings): id -> { id, provider,
  // title, cfg, root, handle, state }. A Backlog space has its own panel ('backlog:<space>.<domain>').
  const panels = new Map();
  const shownPanels = () => (config && !readHidden() ? [...panels.values()] : []);

  function readHidden() { try { return localStorage.getItem(HIDDEN_KEY) === '1'; } catch { return false; } }
  function writeHidden(on) { try { localStorage.setItem(HIDDEN_KEY, on ? '1' : '0'); } catch {} }
  function readWidth(p) {
    const read = (key) => { const n = parseInt(localStorage.getItem(key), 10); return Number.isFinite(n) ? n : null; };
    try {
      // A Backlog space without a width of its own starts at the one saved before spaces had
      // their own panels.
      const own = read(`taskPaneWidth:${p.id}`);
      if (own != null) return own;
      const legacy = p.provider === 'backlog' ? read('taskPaneWidth:backlog') : null;
      return legacy != null ? legacy : view.PANEL_DEFAULT;
    } catch { return view.PANEL_DEFAULT; }
  }
  function writeWidth(p, w) { try { localStorage.setItem(`taskPaneWidth:${p.id}`, String(w)); } catch {} }

  // Show the panels (none set up = just the editor) at their saved widths, fitted so the editor
  // keeps its minimum width.
  function layoutPanels() {
    const rowWidth = row.getBoundingClientRect().width;
    const shown = shownPanels();
    for (const p of panels.values()) {
      p.root.classList.toggle('hidden', !shown.includes(p));
      p.handle.classList.toggle('hidden', !shown.includes(p));
    }
    const widths = rowWidth > 0 ? view.fitPanelWidths(shown.map(readWidth), rowWidth) : shown.map(readWidth);
    shown.forEach((p, i) => { p.root.style.width = `${widths[i]}px`; });
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

  // Backlog issues and Slack to-dos: [ref] / title / [status] [due].
  function plainItemEl(item) {
    const btn = el('button', 'task-item');
    btn.title = item.url;
    const meta = el('div', 'task-meta');
    if (item.status) meta.appendChild(el('span', 'task-status', item.status));
    if (item.due) {
      const due = el('span', 'task-due', t('tasks.due').replace('{date}', item.due));
      if (view.isOverdue(item.due)) due.classList.add('overdue');
      meta.appendChild(due);
    }
    if (item.ref) {
      const line1 = el('div', 'task-line1');
      line1.appendChild(el('span', 'task-ref', item.ref));
      btn.appendChild(line1);
    }
    btn.append(el('div', 'task-item-title', item.title || t('tasks.untitled')), meta);
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
    const node = p.provider === 'github' ? githubItemEl(item) : plainItemEl(item);
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
    const root = p.root;
    const st = p.state;
    p.handle.title = t('ui.dragToResize');
    const title = root.querySelector('.task-title');
    title.textContent = p.title;
    title.title = p.tip || p.title;
    root.classList.toggle('loading', st.loading);
    const refreshBtn = root.querySelector('.task-refresh');
    refreshBtn.disabled = st.loading;
    refreshBtn.title = t('tasks.refresh');
    root.querySelector('.task-settings').title = t('tasks.settings');
    root.querySelector('.task-count').textContent = st.items ? `(${st.items.length})` : '';
    root.querySelector('.task-updated').textContent = st.at ? t('tasks.updatedAt').replace('{time}', view.timeLabel(st.at)) : '';
    const msg = root.querySelector('.task-message');
    let text = '';
    if (st.error) text = errorText(st.error);
    else if (st.items && st.truncated) text = t('tasks.truncated'); // before "empty": an empty partial list proves nothing
    else if (st.items && !st.items.length) text = t(p.provider === 'slack' ? 'tasks.emptyTodos' : 'tasks.empty');
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

  // `fresh`: a manual ⟳ — skip cached lookups (Backlog's status list, Slack's message texts).
  async function refresh(p, fresh = false) {
    if (!shownPanels().includes(p)) return;
    const st = p.state;
    if (st.loading) return;
    const myGen = gen;
    st.loading = true;
    render(p);
    let res;
    try { res = await window.api.tasksList(p.id, secretsWs(), fresh); } catch { res = { ok: false, error: 'network' }; }
    // The workspace changed meanwhile (its own refresh is under way), or the panel's settings did.
    if (myGen !== gen || panels.get(p.id) !== p || p.state !== st) return;
    st.loading = false;
    if (res && res.ok) { st.items = res.items || []; st.truncated = !!res.truncated; st.error = null; st.at = new Date(); }
    else st.error = (res && res.error) || 'network';
    render(p);
  }

  function createPanel(desc) {
    const handle = el('div', 'resizer vertical task-resizer');
    const root = el('section', 'task-pane');
    root.dataset.panel = desc.id;
    const head = el('div', 'task-head');
    const refreshBtn = el('button', 'task-btn task-refresh', '⟳');
    const settingsBtn = el('button', 'task-btn task-settings', '⚙');
    head.append(el('span', 'task-title'), el('span', 'task-count'), el('span', 'task-updated'), refreshBtn, settingsBtn);
    root.append(head, el('div', 'task-message hidden'), el('div', 'task-list'));
    const p = { ...desc, root, handle, state: freshState() };
    refreshBtn.addEventListener('click', () => refreshOne(p.id));
    settingsBtn.addEventListener('click', () => openSettings(p.provider, p.id));
    initResizer(p);
    return p;
  }

  // Make the panels on screen those of `next` settings: new ones are created, removed ones go,
  // and one whose settings changed drops its list (it belongs to the old settings).
  function applyConfig(next) {
    taskConfig = next || emptyConfig();
    const wanted = view.panelList(taskConfig);
    const ids = new Set(wanted.map((d) => d.id));
    // Panels added, removed or in another order (a space removed and added again elsewhere).
    const changed = [...panels.keys()].join('\n') !== wanted.map((d) => d.id).join('\n');
    // A resize under way ends first, while every panel is still in place to be measured: the
    // handles are about to move, which drops the pointer capture.
    if (changed) for (const p of panels.values()) if (p.endDrag) p.endDrag();
    for (const [id, p] of panels) {
      if (ids.has(id)) continue;
      p.root.remove();
      p.handle.remove();
      panels.delete(id);
    }
    for (const desc of wanted) {
      const p = panels.get(desc.id);
      if (!p) { panels.set(desc.id, createPanel(desc)); continue; }
      if (JSON.stringify(p.cfg) !== JSON.stringify(desc.cfg)) { p.cfg = desc.cfg; p.state = freshState(); }
      p.title = desc.title;
      p.tip = desc.tip;
    }
    // Put them in order only when needed: moving a node drops the keyboard focus in it.
    if (changed) {
      const ordered = wanted.map((d) => panels.get(d.id));
      panels.clear();
      for (const p of ordered) { panels.set(p.id, p); row.append(p.handle, p.root); }
    }
    for (const p of panels.values()) render(p);
    layoutPanels();
  }

  // Re-read the settings first: another window on the same workspace may have changed them
  // (a panel set up there appears here, one removed there disappears).
  async function reloadConfig() {
    if (!config) return false;
    const myGen = gen;
    let res;
    try { res = await window.api.tasksGetConfig(); } catch { return false; }
    if (myGen !== gen || !res) return false;
    applyConfig(res.config);
    return true;
  }

  async function refreshAll() {
    if (await reloadConfig()) for (const p of panels.values()) refresh(p);
  }
  // The reload may also have brought in a panel set up in another window, or emptied one whose
  // settings changed there: those load too.
  async function refreshOne(id) {
    if (!(await reloadConfig())) return;
    if (panels.has(id)) refresh(panels.get(id), true);
    refreshMissing();
  }
  // Every panel that has neither a list nor an error to show yet.
  function refreshMissing() {
    for (const p of panels.values()) if (!p.state.items && !p.state.error) refresh(p);
  }

  // After a workspace is applied: its own settings, panels and a first fetch.
  async function applyWorkspace() {
    const myGen = ++gen;
    if (closeDialog) closeDialog();
    applyConfig(emptyConfig());
    if (!config) return;
    let res;
    try { res = await window.api.tasksGetConfig(); } catch { return; }
    if (myGen !== gen || !res) return;
    applyConfig(res.config);
    for (const p of panels.values()) refresh(p);
  }

  function toggleVisible() {
    if (!config) return;
    // Nothing to show or hide: don't store a "hidden" that would swallow the first panel set up.
    if (!panels.size) { alert(t('tasks.noneConfigured')); return; }
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
    const handle = p.handle;
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      try { handle.setPointerCapture(event.pointerId); } catch {}
      document.body.classList.add('resizing');
      const target = p.root;
      const right = target.getBoundingClientRect().right;
      const rowWidth = row.getBoundingClientRect().width;
      const others = () => shownPanels().filter((o) => o !== p);
      const othersWidth = others().reduce((sum, o) => sum + o.root.getBoundingClientRect().width + 1, 0);
      let width = target.getBoundingClientRect().width;
      const onMove = (moveEvent) => {
        if (moveEvent.buttons === 0) { onEnd(); return; }
        width = view.clampPanelWidth(right - moveEvent.clientX, rowWidth, othersWidth);
        target.style.width = `${width}px`;
      };
      const onEnd = () => {
        p.endDrag = null;
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onEnd);
        handle.removeEventListener('pointercancel', onEnd);
        try { handle.releasePointerCapture(event.pointerId); } catch {}
        document.body.classList.remove('resizing');
        // Save what is on screen for every shown panel (the others may be fitted below their saved
        // widths), so the next layout reproduces it instead of re-fitting the drag away.
        writeWidth(p, Math.round(width));
        for (const o of others()) writeWidth(o, Math.round(o.root.getBoundingClientRect().width));
      };
      p.endDrag = onEnd;
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

  // Slack: the channels whose to-dos are shown (issue #136). None checked = every to-do.
  function slackForm(current, tokenSel, ws) {
    const checked = new Set(current && Array.isArray(current.channels) ? current.channels : []);
    let channels = [];
    let seq = 0;
    let listHint = null;
    const search = document.createElement('input');
    search.type = 'text';
    search.spellcheck = false;
    search.placeholder = t('tasks.searchChannels');
    const list = el('div', 'task-repo-list');
    const countEl = el('span', 'task-hint');
    const updateCount = () => {
      countEl.textContent = checked.size ? t('tasks.checkedChannels').replace('{n}', String(checked.size)) : t('tasks.allChannels');
    };

    // Checked channels are always listed, also while the lookup is loading or failing and when
    // Slack no longer returns one (left, archived) — shown by id then — so it can be unchecked.
    function renderChannels(hint = null) {
      listHint = hint;
      list.textContent = '';
      if (hint) list.appendChild(el('div', 'task-hint', hint));
      const known = new Set(channels.map((c) => c.id));
      const all = [...channels, ...[...checked].filter((id) => !known.has(id)).map((id) => ({ id, name: id, unknown: true }))];
      const shown = view.filterChannels(all, search.value, checked);
      if (!shown.length) { if (!hint) list.appendChild(el('div', 'task-hint', t('tasks.noChannels'))); return; }
      for (const c of shown) {
        const label = el('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = checked.has(c.id);
        box.addEventListener('change', () => { if (box.checked) checked.add(c.id); else checked.delete(c.id); updateCount(); });
        label.append(box, el('span', null, c.unknown ? c.name : `#${c.name}`));
        list.appendChild(label);
      }
    }

    async function loadChannels() {
      const my = ++seq;
      channels = [];
      if (!tokenSel.value) { renderChannels(t('tasks.chooseSecretFirst')); return; }
      renderChannels(t('tasks.loading'));
      let res;
      try { res = await window.api.tasksSlackChannels(tokenSel.value, ws); } catch { res = { ok: false, error: 'network' }; }
      if (my !== seq) return;
      if (!res || !res.ok) { renderChannels(errorText((res && res.error) || 'network')); return; }
      channels = res.channels || [];
      renderChannels(res.truncated ? t('tasks.channelsTruncated') : null);
    }

    // Another secret may be another Slack workspace: its channels are not these, and ids checked
    // here would hide every channel to-do there.
    tokenSel.addEventListener('change', () => { checked.clear(); updateCount(); loadChannels(); });
    search.addEventListener('input', () => renderChannels(listHint));
    modalBody.append(field(t('tasks.slackChannels'), search, t('tasks.slackChannelsHint')), list, countEl);
    updateCount();
    loadChannels();

    return () => {
      if (checked.size > view.SLACK_CHANNELS_MAX) return { error: t('tasks.err.tooManyChannels').replace('{max}', String(view.SLACK_CHANNELS_MAX)) };
      return { value: { tokenKey: null, channels: [...checked] } };
    };
  }

  const NEW_SPACE = 'new';
  let settingsSeq = 0; // only the latest open request builds the dialog
  // `target` (Backlog): the panel id of the space to edit, or NEW_SPACE to add one. From the menu
  // (no target) the dialog opens on the first space, or on a new one when there is none.
  async function openSettings(provider, target = null) {
    if (!config || !PROVIDERS.includes(provider)) return;
    const my = ++settingsSeq;
    const ws = secretsWs();
    let res;
    try { res = await window.api.tasksGetConfig(); } catch { return; }
    if (my !== settingsSeq || !res || !sameSecretsWs(ws)) return;
    if (closeDialog) closeDialog(); // one dialog at a time (its Escape handler goes with it)
    const cfg = res.config || emptyConfig();
    const keys = res.secretKeys || [];
    const spaces = Array.isArray(cfg.backlog) ? cfg.backlog : [];
    let current;
    if (provider === 'backlog') {
      const found = target && target !== NEW_SPACE ? spaces.find((b) => view.backlogPanelId(b) === target) : null;
      // The space asked for is gone (removed or renamed in another window): no dialog on some other
      // space — the panels catch up with the settings instead.
      if (target && target !== NEW_SPACE && !found) { applyConfig(cfg); refreshMissing(); return; }
      // Asked for a new space: a blank form even when the list has filled up meanwhile (saving
      // then says so) — never some existing space's form to overwrite.
      current = found || (target === NEW_SPACE ? null : spaces[0]) || null;
    } else {
      current = cfg[provider] || null;
    }
    const editing = provider === 'backlog' && current ? view.backlogPanelId(current) : null;

    modalTitle.textContent = t(`tasks.settingsTitle.${provider}`);
    modalBody.textContent = '';
    modalError.textContent = '';
    clearBtn.classList.toggle('hidden', !current);
    saveBtn.disabled = false;

    let focusFirst = null;
    // Backlog with spaces set up: which one this dialog edits, or a new one.
    if (provider === 'backlog' && spaces.length) {
      const options = spaces.map((b) => [view.backlogPanelId(b), `${b.space}.backlog.${b.domain}`]);
      if (spaces.length < view.BACKLOG_SPACES_MAX || !current) options.push([NEW_SPACE, t('tasks.addSpace')]);
      const which = select(options, editing || NEW_SPACE);
      // Close first: until the other space's form is up, Save / Remove must not act on this one.
      which.addEventListener('change', () => { const next = which.value; close(); openSettings('backlog', next); });
      modalBody.appendChild(field(t('tasks.whichSpace'), which));
      focusFirst = which;
    }
    const tokenSel = select([['', t('tasks.chooseSecret')], ...keys.map((k) => [k, k])], current ? current.tokenKey : '');
    modalBody.appendChild(field(t('tasks.token'), tokenSel, keys.length ? t(`tasks.tokenHint.${provider}`) : t('tasks.noSecrets')));
    const getValue = provider === 'github' ? githubForm(current, tokenSel, ws)
      : provider === 'backlog' ? backlogForm(current)
        : slackForm(current, tokenSel, ws);

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
      try { out = await window.api.tasksSetConfig({ provider, value, workspace: ws, target: editing }); } catch { out = { ok: false, error: 'network' }; }
      saveBtn.disabled = false;
      const open = closeDialog === close; // the dialog may have been closed while saving
      if (!out || !out.ok) { if (open) modalError.textContent = errorText((out && out.error) || 'network'); return; }
      if (open) close();
      // Saved: apply it even if the dialog was closed meanwhile (the workspace is still this one).
      if (!sameSecretsWs(ws)) return;
      if (value) writeHidden(false); // a panel just set up is shown
      applyConfig(out.config);
      // The saved panel starts over even with unchanged settings (its secret may have a new value).
      const savedId = !value ? null : provider === 'backlog' ? view.backlogPanelId(value) : provider;
      const saved = savedId ? panels.get(savedId) : null;
      if (saved) { saved.state = freshState(); render(saved); }
      layoutPanels();
      // That panel, and any other shown without a list yet.
      for (const p of panels.values()) if (p === saved || !p.state.items) refresh(p);
    };

    saveBtn.onclick = () => {
      if (!tokenSel.value) { modalError.textContent = t('tasks.err.token'); return; }
      const r = getValue();
      if (r.error) { modalError.textContent = r.error; return; }
      apply({ ...r.value, tokenKey: tokenSel.value });
    };
    clearBtn.onclick = () => {
      if (!confirm(t(`tasks.confirmClear.${provider}`))) return;
      apply(null);
    };
    cancelBtn.onclick = close;
    modal.addEventListener('keydown', onKey);
    modal.classList.remove('hidden');
    (focusFirst || tokenSel).focus();
  }

  function init() {
    window.api.onMenuToggleTaskPanels(toggleVisible);
    window.api.onMenuTaskSettings((provider) => openSettings(provider));
    // Re-fit on any change of the editor row's width: window resize, or the tree divider drag.
    let fitQueued = false;
    new ResizeObserver(() => {
      if (fitQueued) return;
      fitQueued = true;
      requestAnimationFrame(() => { fitQueued = false; layoutPanels(); });
    }).observe(row);
    window.api.onLangChanged(() => { for (const p of panels.values()) render(p); }); // runs after renderer's handler switched currentLang
    setInterval(() => { if (!document.hidden) refreshAll(); }, REFRESH_MS);
    // Back from minimized: catch up if the last refresh is stale.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      const stale = shownPanels().some((p) => !p.state.at || Date.now() - p.state.at.getTime() >= REFRESH_MS);
      if (stale) refreshAll();
    });
  }

  init();
  window.taskPanels = { applyWorkspace, openSettings, refresh: refreshAll };
})();
