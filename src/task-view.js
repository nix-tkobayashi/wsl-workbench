// Pure helpers for the task panels (issue #127), shared by the renderer (task-panels.js) and the
// unit tests: panel width limits, repository filtering for the settings dialog, and labels.
(function () {
  const PANEL_MIN = 180;
  const EDITOR_MIN = 240;
  const PANEL_DEFAULT = 280;
  const REPOS_MAX = 200; // same cap as src/tasks.js (main refuses more)

  // What the editor keeps when the panels' minimums don't fit beside its own minimum: a quarter of
  // the row, at most its minimum.
  const editorFloor = (rowWidth) => Math.min(EDITOR_MIN, Math.floor(rowWidth / 4));

  // Width of a task panel being dragged: its left edge follows the pointer, within limits that
  // keep the editor (and the other open panel) usable. `rowWidth` is the editor row's width.
  // In a row too narrow for that, the panel may go below its minimum but never past the row, so
  // the other panel's buttons are never pushed out of sight.
  function clampPanelWidth(width, rowWidth, otherPanelsWidth = 0) {
    const room = Math.max(0, rowWidth - otherPanelsWidth - 1); // 1px: this panel's resizer
    const soft = room - EDITOR_MIN;
    // Narrow: no wider than the minimum (as fitPanelWidths lays it out), and never past the row.
    // ...and, in a row with room for an editor, never into the part fitPanelWidths keeps for it.
    const max = soft >= PANEL_MIN ? soft
      : rowWidth >= 2 * EDITOR_MIN ? Math.max(0, Math.min(PANEL_MIN, room - editorFloor(rowWidth)))
        : Math.min(room, PANEL_MIN);
    const min = Math.min(PANEL_MIN, max);
    const w = Number.isFinite(width) ? width : PANEL_DEFAULT;
    return Math.round(Math.max(min, Math.min(max, w)));
  }

  // Widths of the shown panels (saved widths, left to right) for an editor row of `rowWidth`.
  // When they don't all fit beside the editor's minimum, every panel shrinks in proportion (not
  // below its own minimum); when even the minimums don't fit, the editor gives way, and in a row too
  // narrow for that the panels share it evenly — their total never exceeds the row, so no panel is
  // clipped off (its header keeps the buttons and shortens the title).
  function fitPanelWidths(saved, rowWidth) {
    const ws = saved.map((w) => (Number.isFinite(w) ? Math.max(PANEL_MIN, w) : PANEL_DEFAULT));
    const available = Math.max(0, rowWidth - EDITOR_MIN - ws.length); // 1px resizer per panel
    const total = ws.reduce((a, b) => a + b, 0);
    if (total <= available) return ws.map(Math.round);
    const row = Math.max(0, rowWidth - ws.length);
    // The minimums don't fit beside the editor's minimum: the editor gives way — but in a row that
    // has room for one it keeps EDITOR_FLOOR of it (many panels, e.g. several Backlog spaces,
    // would otherwise leave it nothing), and the panels share the rest evenly, below their minimum.
    const atMinimums = row - ws.length * PANEL_MIN; // what panels at their minimums leave the editor
    if (ws.length * PANEL_MIN > available && rowWidth >= 2 * EDITOR_MIN && atMinimums < editorFloor(rowWidth)) {
      return ws.map(() => Math.floor((row - editorFloor(rowWidth)) / ws.length));
    }
    // Not even the minimums fit (very narrow row): the panels split the whole row evenly.
    if (ws.length * PANEL_MIN > row) return ws.map(() => Math.floor(row / ws.length));
    // Proportional shares; a panel whose share is below its minimum gets the minimum and the rest
    // is shared again among the others, so the total never passes `available`.
    const out = ws.map(() => null);
    let left = available;
    let open = ws.map((_, i) => i);
    for (;;) {
      const sum = open.reduce((a, i) => a + ws[i], 0);
      const small = open.filter((i) => (ws[i] * left) / sum < PANEL_MIN);
      if (!small.length) { for (const i of open) out[i] = Math.floor((ws[i] * left) / sum); return out; }
      for (const i of small) { out[i] = PANEL_MIN; left -= PANEL_MIN; }
      open = open.filter((i) => !small.includes(i));
      if (!open.length) return out;
    }
  }

  // Settings dialog: case-insensitive substring match on "owner/name"; checked repos first.
  function filterRepos(repos, query, checked = new Set()) {
    const q = String(query || '').trim().toLowerCase();
    const hits = repos.filter((r) => !q || r.toLowerCase().includes(q));
    return [...hits.filter((r) => checked.has(r)), ...hits.filter((r) => !checked.has(r))];
  }

  // Settings dialog, Slack channels ({ id, name }): case-insensitive substring match on the name;
  // checked channels first.
  function filterChannels(channels, query, checked = new Set()) {
    const q = String(query || '').trim().replace(/^#/, '').toLowerCase();
    const hits = channels.filter((c) => !q || String(c.name).toLowerCase().includes(q));
    return [...hits.filter((c) => checked.has(c.id)), ...hits.filter((c) => !checked.has(c.id))];
  }

  // "YYYY-MM-DD" due date → whether it has passed (before today, local time).
  function isOverdue(due, now = new Date()) {
    if (typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return false;
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return due < today;
  }

  // "HH:MM" of the last refresh, for the panel header.
  function timeLabel(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // A task's URL as it may be typed into the terminal (issue #130): an http(s) URL on one line,
  // with no whitespace or control characters — nothing in it can act as Enter or split the
  // command line. Anything else gives '' (nothing is typed).
  function terminalUrl(url) {
    if (typeof url !== 'string' || !/^https?:\/\/[^\s\u0000-\u001f\u007f-\u009f]+$/.test(url)) return '';
    return url;
  }

  const SLACK_CHANNELS_MAX = 200; // channels checked for the Slack panel (main refuses more)
  const BACKLOG_SPACES_MAX = 5; // panels beside the editor: more would leave no room to read any

  // The id of a Backlog space's panel (issue #134): one panel per space. Lower case, as a space
  // is the host name of its address.
  function backlogPanelId(cfg) {
    return `backlog:${String((cfg && cfg.space) || '').toLowerCase()}.${(cfg && cfg.domain) || 'com'}`;
  }

  // The panels a workspace's settings give, left to right: GitHub, each Backlog space, Slack.
  // Shared by the renderer (which draws them) and main (which resolves a panel id to its settings).
  function panelList(config) {
    const c = config && typeof config === 'object' ? config : {};
    const out = [];
    const gh = c.github;
    if (gh && gh.tokenKey && Array.isArray(gh.repos) && gh.repos.length) out.push({ id: 'github', provider: 'github', title: 'GitHub', cfg: gh });
    const seen = new Set();
    for (const b of Array.isArray(c.backlog) ? c.backlog : []) {
      if (!b || !b.tokenKey || !b.space || seen.has(backlogPanelId(b))) continue;
      seen.add(backlogPanelId(b));
      out.push({ id: backlogPanelId(b), provider: 'backlog', title: `Backlog: ${b.space}`, tip: `${b.space}.backlog.${b.domain}`, cfg: b });
    }
    // The same name on backlog.com and backlog.jp: the titles say which is which.
    const names = out.filter((p) => p.provider === 'backlog').map((p) => p.cfg.space.toLowerCase());
    for (const p of out) {
      if (p.provider === 'backlog' && names.filter((n) => n === p.cfg.space.toLowerCase()).length > 1) p.title = `Backlog: ${p.tip}`;
    }
    if (c.slack && c.slack.tokenKey) out.push({ id: 'slack', provider: 'slack', title: 'Slack', cfg: c.slack });
    return out;
  }

  const taskView = { SLACK_CHANNELS_MAX, filterChannels, BACKLOG_SPACES_MAX, backlogPanelId, panelList, REPOS_MAX, PANEL_MIN, EDITOR_MIN, PANEL_DEFAULT, clampPanelWidth, fitPanelWidths, filterRepos, isOverdue, timeLabel, terminalUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = taskView;
  if (typeof window !== 'undefined') window.taskView = taskView;
})();
