// Slack To-dos for the task panels (issue #133). Slack has no public API for a user's To-dos
// (formerly "Later"), so this uses what the web client itself uses: the session token (xoxc-…)
// together with the `d` cookie (xoxd-…) and the `saved.list` method. Both values live in one
// workspace secret, read in the main process only.
//
// It is an unofficial API: every failure surfaces as a panel error and nothing else depends on it.
// Kept free of Electron so it can be unit-tested: `fetch` is injected.
const crypto = require('crypto');

const SLACK_API = 'https://slack.com/api';
const REQUEST_TIMEOUT_MS = 20000;
const SAVED_PAGE_SIZE = 50;
const SAVED_PAGES_MAX = 20;  // 1000 records (to-dos and plain saved items share the list); beyond: truncated
const ITEMS_MAX = 100;       // each new item costs a lookup or two; more than this is cut (truncated)
const TITLE_MAX = 200;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_ENTRIES_MAX = 2000;
const CACHE_ACCOUNTS_MAX = 4;

class SlackError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// The secret holds both values, in any layout (two lines, `key=value`, JSON…): they are found by
// their prefixes. The cookie is used as copied from the browser (already percent-encoded).
function parseSlackSecret(value) {
  const text = String(value || '');
  const token = /xoxc-[A-Za-z0-9-]+/.exec(text);
  const cookie = /xoxd-[A-Za-z0-9%+/=_.~-]+/.exec(text);
  if (!token || !cookie) throw new SlackError('slack-secret');
  return { token: token[0], cookie: cookie[0] };
}

const isTimeout = (err) => !!err && (err.name === 'TimeoutError' || err.name === 'AbortError');
const AUTH_ERRORS = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive', 'user_removed_from_team', 'two_factor_setup_required']);

async function slackCall(fetchImpl, creds, method, params = {}) {
  const body = new URLSearchParams({ token: creds.token, ...params }).toString();
  let res;
  try {
    res = await fetchImpl(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8', Cookie: `d=${creds.cookie}`, 'User-Agent': 'wsl-workbench' },
      body,
      redirect: 'error', // never re-send the session token to wherever a redirect points
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (err) {
    throw new SlackError(isTimeout(err) ? 'timeout' : 'network');
  }
  if (res.status === 429) throw new SlackError('rate-limit');
  if (res.status === 401 || res.status === 403) throw new SlackError('auth');
  if (!res.ok) throw new SlackError(`http-${res.status}`);
  let data;
  // The time limit also covers reading the body.
  try { data = await res.json(); } catch (err) { throw new SlackError(isTimeout(err) ? 'timeout' : 'bad-response'); }
  if (!data || typeof data !== 'object') throw new SlackError('bad-response');
  if (!data.ok) {
    const error = typeof data.error === 'string' ? data.error : 'unknown';
    if (AUTH_ERRORS.has(error)) throw new SlackError('auth');
    if (error === 'ratelimited') throw new SlackError('rate-limit');
    // An error name from Slack, shown as a code: letters, digits and _ only.
    throw new SlackError(`slack-${error.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'unknown'}`);
  }
  return data;
}

// Slack's message markup → one line of plain text for a list row.
function slackPlainText(text, max = TITLE_MAX) {
  const s = String(text || '')
    .replace(/<([^<>]*)>/g, (_all, inner) => {
      const bar = inner.indexOf('|');
      const target = bar < 0 ? inner : inner.slice(0, bar);
      const label = bar < 0 ? '' : inner.slice(bar + 1);
      if (target.startsWith('#')) return label ? `#${label}` : '#channel';
      if (target.startsWith('@')) return label ? `@${label}` : '@user';
      if (target.startsWith('!')) return label || `@${target.slice(1).split('^')[0]}`;
      return label || target;
    })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return oneLine(s, max);
}

// Plain text (a file's title or name: no markup in it) → one line for a list row.
function oneLine(text, max = TITLE_MAX) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s;
}

// The workspace's own address from auth.test, the only host links are built on.
function slackBaseUrl(url) {
  let u;
  try { u = new URL(String(url || '')); } catch { throw new SlackError('bad-response'); }
  if (u.protocol !== 'https:' || !/^[a-z0-9][a-z0-9.-]*\.slack\.com$/i.test(u.hostname)) throw new SlackError('bad-response');
  return `https://${u.hostname.toLowerCase()}`;
}

const CHANNEL_RE = /^[CDG][A-Z0-9]{2,20}$/;
const TS_RE = /^\d{1,12}\.\d{1,9}$/;

// The message's permalink, as Slack builds it (no request needed). A thread reply carries its thread.
function slackMessageUrl(base, channel, ts, threadTs = null) {
  const link = `${base}/archives/${channel}/p${ts.replace('.', '')}`;
  return threadTs && TS_RE.test(threadTs) && threadTs !== ts ? `${link}?thread_ts=${threadTs}&cid=${channel}` : link;
}

// A file's own permalink, when it is a one-line link on the workspace's address; else the workspace.
function slackFileUrl(base, permalink) {
  if (typeof permalink !== 'string' || /[\s\u0000-\u001f\u007f-\u009f]/.test(permalink)) return base;
  let u;
  try { u = new URL(permalink); } catch { return base; }
  // https on the same host and port (a blob: URL would share the origin).
  return u.protocol === 'https:' && u.origin === base && !u.username && !u.password ? u.href : base;
}

// Unix seconds → local "YYYY-MM-DD" (0 / missing = no due date).
function dueDate(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const d = new Date(seconds * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// An open to-do: not completed, not archived, and not merely "saved" (the bookmark half of the
// former Later list). `todo_state` is absent on older records, which were all to-dos.
function isOpenTodo(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.item_id !== 'string') return false;
  if (raw.is_archived || raw.state !== 'in_progress') return false;
  return raw.todo_state == null || raw.todo_state === 'to_do';
}

// Due date first (soonest on top, undated last), then newest.
function sortTodos(items) {
  return items.sort((a, b) => {
    if (a.due !== b.due) { if (!a.due) return 1; if (!b.due) return -1; return a.due < b.due ? -1 : 1; }
    return (b.created || 0) - (a.created || 0);
  });
}

// Per credentials: message texts and channel names, so the 5-minute refresh costs one or two
// requests instead of two per item. A manual refresh (`fresh`) re-reads everything.
const slackCache = new Map(); // sha256(token) -> Map(key -> { value, at })
function cacheFor(creds, cache) {
  const key = crypto.createHash('sha256').update(creds.token).digest('hex');
  let m = cache.get(key);
  // Most recently used last; the oldest goes when there are too many (a renewed session token
  // would otherwise leave its predecessors' message texts in memory for good).
  if (m) cache.delete(key); else m = new Map();
  cache.set(key, m);
  while (cache.size > CACHE_ACCOUNTS_MAX) cache.delete(cache.keys().next().value);
  return m;
}
// `run`: { seq, fresh } of the refresh asking. A manual refresh (`fresh`) reuses only what it
// loaded itself (or a later refresh did), so a channel shared by several to-dos is still looked up
// once; otherwise anything younger than the TTL will do.
let refreshSeq = 0;
async function cached(store, key, run, load) {
  const hit = store.get(key);
  if (hit && (run.fresh ? hit.seq >= run.seq : Date.now() - hit.at < CACHE_TTL_MS)) return hit.value;
  // Stamped with when the lookup started: an answer is as old as its question. A slower lookup of
  // an older refresh never replaces a newer one's answer.
  const at = Date.now();
  const value = await load();
  const now = store.get(key);
  if (!now || now.seq <= run.seq) {
    store.delete(key); // re-inserted as the newest
    while (store.size >= CACHE_ENTRIES_MAX) store.delete(store.keys().next().value); // the oldest go, one by one
    store.set(key, { value, at, seq: run.seq });
  }
  return value;
}

async function channelLabel(fetchImpl, creds, channel) {
  const data = await slackCall(fetchImpl, creds, 'conversations.info', { channel });
  const c = data.channel || {};
  if (c.is_im) return 'DM';
  if (c.is_mpim) return 'Group DM';
  return typeof c.name === 'string' && c.name ? `#${c.name}` : '';
}

// The saved message itself: a channel message comes from the history; a thread reply (which the
// history does not list) from its thread.
async function messageInfo(fetchImpl, creds, channel, ts) {
  const pick = (data) => (Array.isArray(data.messages) ? data.messages : []).find((m) => m && m.ts === ts) || null;
  // (Given a reply's own ts, conversations.replies returns that reply — checked against Slack.)
  let msg = pick(await slackCall(fetchImpl, creds, 'conversations.history', { channel, latest: ts, oldest: ts, inclusive: 'true', limit: '1' }));
  if (!msg) msg = pick(await slackCall(fetchImpl, creds, 'conversations.replies', { channel, ts, latest: ts, oldest: ts, inclusive: 'true', limit: '1' }));
  if (!msg) return { title: '', threadTs: null };
  let title = slackPlainText(msg.text);
  if (!title && Array.isArray(msg.files) && msg.files[0]) title = oneLine(msg.files[0].title || msg.files[0].name);
  return { title, threadTs: typeof msg.thread_ts === 'string' ? msg.thread_ts : null };
}

// One list row for a saved record. A lookup that fails (a channel left, a message deleted) still
// gives a row — the to-do exists — except for errors that fail every request (auth, rate limit,
// no network), which fail the refresh.
const FATAL = new Set(['auth', 'rate-limit', 'network', 'timeout']);
async function todoItem(fetchImpl, creds, base, store, run, raw) {
  const soft = async (fn, fallback) => {
    try { return await fn(); } catch (err) { if (err && FATAL.has(err.code)) throw err; return fallback; }
  };
  const common = { due: dueDate(raw.date_due), created: Number.isFinite(raw.date_created) ? raw.date_created : 0, status: '' };
  if (raw.item_type === 'message' && CHANNEL_RE.test(raw.item_id) && typeof raw.ts === 'string' && TS_RE.test(raw.ts)) {
    const ref = await soft(() => cached(store, `c:${raw.item_id}`, run, () => channelLabel(fetchImpl, creds, raw.item_id)), '');
    const info = await soft(() => cached(store, `m:${raw.item_id}:${raw.ts}`, run, () => messageInfo(fetchImpl, creds, raw.item_id, raw.ts)), { title: '', threadTs: null });
    return { ...common, id: `${raw.item_id}:${raw.ts}`, ref, title: info.title, url: slackMessageUrl(base, raw.item_id, raw.ts, info.threadTs) };
  }
  if (raw.item_type === 'file' && /^F[A-Z0-9]{2,20}$/.test(raw.item_id)) {
    const info = await soft(() => cached(store, `f:${raw.item_id}`, run, async () => {
      const file = (await slackCall(fetchImpl, creds, 'files.info', { file: raw.item_id })).file || {};
      return { title: oneLine(file.title || file.name), permalink: file.permalink };
    }), { title: '', permalink: null });
    // Checked against the workspace's address of this refresh, not the one when it was cached.
    return { ...common, id: raw.item_id, ref: 'File', title: info.title, url: slackFileUrl(base, info.permalink) };
  }
  if (raw.item_type === 'reminder' && /^Rm[A-Z0-9]{2,20}$/.test(raw.item_id)) {
    const title = await soft(() => cached(store, `r:${raw.item_id}`, run, async () => {
      const data = await slackCall(fetchImpl, creds, 'reminders.info', { reminder: raw.item_id });
      return slackPlainText((data.reminder || {}).text);
    }), '');
    return { ...common, id: raw.item_id, ref: 'To-do', title, url: base };
  }
  return { ...common, id: `${String(raw.item_type || 'item').slice(0, 20)}:${raw.item_id.slice(0, 40)}`, ref: '', title: '', url: base };
}

// → { items, truncated, team }: the user's open to-dos, soonest due first.
async function fetchSlackTasks({ secret, fresh = false, fetchImpl = fetch, cache = slackCache }) {
  const creds = parseSlackSecret(secret);
  const auth = await slackCall(fetchImpl, creds, 'auth.test');
  const base = slackBaseUrl(auth.url);
  const store = cacheFor(creds, cache);
  const run = { seq: ++refreshSeq, fresh: !!fresh };
  const open = [];
  let truncated = false;
  let cursor = '';
  for (let page = 0; page < SAVED_PAGES_MAX; page++) {
    const data = await slackCall(fetchImpl, creds, 'saved.list', { limit: String(SAVED_PAGE_SIZE), ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(data.saved_items)) throw new SlackError('bad-response');
    open.push(...data.saved_items.filter(isOpenTodo));
    cursor = data.response_metadata && typeof data.response_metadata.next_cursor === 'string' ? data.response_metadata.next_cursor : '';
    if (!cursor) break;
    if (page === SAVED_PAGES_MAX - 1) truncated = true;
  }
  // Each record once, in list order (soonest due first), and only then the cap: what is cut is the
  // far end of the list, not whatever Slack happened to return last.
  const seen = new Set();
  let wanted = open.filter((raw) => {
    const key = `${raw.item_type}:${raw.item_id}:${raw.ts || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  wanted = sortTodos(wanted.map((raw) => ({ raw, due: dueDate(raw.date_due), created: Number.isFinite(raw.date_created) ? raw.date_created : 0 }))).map((x) => x.raw);
  if (wanted.length > ITEMS_MAX) { wanted.length = ITEMS_MAX; truncated = true; }
  const items = [];
  for (const raw of wanted) items.push(await todoItem(fetchImpl, creds, base, store, run, raw)); // one request at a time: Slack rate-limits per method
  return { items: sortTodos(items), truncated, team: typeof auth.team === 'string' ? auth.team.slice(0, 80) : '' };
}

module.exports = { SAVED_PAGES_MAX, SlackError, parseSlackSecret, slackPlainText, slackBaseUrl, slackMessageUrl, slackFileUrl, dueDate, isOpenTodo, sortTodos, fetchSlackTasks, ITEMS_MAX };
