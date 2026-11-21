// Task panels (issue #127): open GitHub issues/PRs and Backlog issues assigned to the user, shown
// to the right of the editor (Slack To-dos: src/slack-tasks.js). Runs in the main process only — the token is a workspace secret read
// here by key name and never crosses to the renderer.
//
// Kept free of Electron so it can be unit-tested: `fetch` is injected.
const crypto = require('crypto');
const { isValidKey } = require('./secret-keys');
const { backlogPanelId, BACKLOG_SPACES_MAX } = require('./task-view');

const GITHUB_API = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 20000;
const GITHUB_SEARCH_MAX_QUERY = 256;   // GitHub rejects longer search queries
const GITHUB_REPO_PAGES_MAX = 10;      // 1000 repos per owner is plenty for a picker
const GITHUB_SEARCH_PAGES_MAX = 10;    // the search API returns at most 1000 results per query
const GITHUB_SEARCH_REQUESTS_MAX = 20; // per refresh: stays under the 30 searches/minute limit
const BACKLOG_ISSUE_PAGES_MAX = 10;
const BACKLOG_CLOSED_STATUS_ID = 4;    // Backlog's built-in "Closed" (完了) status; it can't be deleted
const BACKLOG_DEFAULT_OPEN_STATUSES = [1, 2, 3];
const REPOS_MAX = 200; // the settings dialog refuses more, so nothing checked is dropped silently

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const SPACE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})$/;
const BACKLOG_DOMAINS = ['com', 'jp'];

// Only well-formed settings survive; anything else is dropped (= that provider is "not set").
function normalizeGithub(raw) {
  if (!raw || typeof raw !== 'object' || !isValidKey(raw.tokenKey)) return null;
  const repos = [...new Set((Array.isArray(raw.repos) ? raw.repos : []).filter((r) => typeof r === 'string' && REPO_RE.test(r)))];
  if (repos.length > REPOS_MAX) return null;
  return { tokenKey: raw.tokenKey, repos };
}

function normalizeBacklog(raw) {
  if (!raw || typeof raw !== 'object' || !isValidKey(raw.tokenKey)) return null;
  const space = typeof raw.space === 'string' ? raw.space.trim() : '';
  if (!SPACE_RE.test(space)) return null;
  const domain = BACKLOG_DOMAINS.includes(raw.domain) ? raw.domain : 'com';
  return { tokenKey: raw.tokenKey, space, domain };
}

// Several Backlog spaces, each shown in its own panel (issue #134). Settings saved before that
// held one space as an object. A space listed twice is kept once.
function normalizeBacklogList(raw) {
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const b = normalizeBacklog(item);
    if (!b || seen.has(backlogPanelId(b))) continue;
    seen.add(backlogPanelId(b));
    out.push(b);
    if (out.length === BACKLOG_SPACES_MAX) break;
  }
  return out;
}

// Slack To-dos (issue #133): only the secret that holds the session token and cookie.
function normalizeSlack(raw) {
  if (!raw || typeof raw !== 'object' || !isValidKey(raw.tokenKey)) return null;
  return { tokenKey: raw.tokenKey };
}

function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return { github: normalizeGithub(src.github), backlog: normalizeBacklogList(src.backlog), slack: normalizeSlack(src.slack) };
}

// A provider is shown only once it has everything needed to list tasks.
function isConfigured(provider, cfg) {
  if (!cfg) return false;
  if (provider === 'github') return !!cfg.tokenKey && Array.isArray(cfg.repos) && cfg.repos.length > 0;
  if (provider === 'backlog') return !!cfg.tokenKey && !!cfg.space;
  if (provider === 'slack') return !!cfg.tokenKey;
  return false;
}

// The settings dialog's Save / Remove applied to a workspace's (normalized) settings →
// { config } or { error }. GitHub and Slack have one entry each. Backlog has a list: `target` is
// the panel id of the space being edited (null = a space being added); a `value` of null removes it.
function applyConfigChange(config, provider, value, target = null) {
  const cur = normalizeConfig(config);
  if (provider === 'github' || provider === 'slack') {
    const next = provider === 'github' ? normalizeGithub(value) : normalizeSlack(value);
    if (value != null && !next) return { error: 'invalid' };
    return { config: { ...cur, [provider]: next } };
  }
  if (provider !== 'backlog') return { error: 'invalid' };
  const list = [...cur.backlog];
  const idx = typeof target === 'string' ? list.findIndex((b) => backlogPanelId(b) === target) : -1;
  if (value == null) {
    if (idx >= 0) list.splice(idx, 1); // already gone (removed in another window): nothing to do
    return { config: { ...cur, backlog: list } };
  }
  const next = normalizeBacklog(value);
  if (!next) return { error: 'invalid' };
  // The space being edited was removed or renamed in another window meanwhile: saving would bring
  // it back beside whatever replaced it.
  if (typeof target === 'string' && idx < 0) return { error: 'stale' };
  if (list.some((b, i) => i !== idx && backlogPanelId(b) === backlogPanelId(next))) return { error: 'duplicate' };
  if (idx >= 0) list[idx] = next;
  else if (list.length >= BACKLOG_SPACES_MAX) return { error: 'too-many' };
  else list.push(next);
  return { config: { ...cur, backlog: list } };
}

// --- HTTP ---

class TaskError extends Error {
  constructor(code, detail = '') { super(detail || code); this.code = code; }
}

function httpErrorCode(provider, status, headers) {
  if (status === 401) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status === 403 && provider === 'github' && headers && headers.get && headers.get('x-ratelimit-remaining') === '0') return 'rate-limit';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  return `http-${status}`;
}

async function getJson(fetchImpl, provider, url, headers = {}) {
  let res;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw new TaskError(err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'network');
  }
  if (!res.ok) throw new TaskError(httpErrorCode(provider, res.status, res.headers));
  try { return await res.json(); } catch { throw new TaskError('bad-response'); }
}

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'wsl-workbench'
  };
}

// --- GitHub ---

// The checked repos are named in the query (`repo:`) while they fit in a few queries. Beyond that,
// or when GitHub refuses a named repo (422: deleted, or no longer visible to the token), the search
// covers everything assigned to / awaiting review from the user — two queries however many repos or
// owners are checked, far below the search API's 30 requests/minute. Either way the results are
// narrowed to the checked repos. Each query set asks twice: assigned to me, and open PRs awaiting
// my review.
const GITHUB_ROLE_QUERIES = [
  { role: 'assignee', base: 'is:open archived:false assignee:@me' },
  { role: 'reviewer', base: 'is:open is:pr archived:false user-review-requested:@me' } // me, not my teams
];
const GITHUB_REPO_CHUNKS_MAX = 3;

function chunkTerms(terms, budget) {
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const term of terms) {
    const part = ` ${term}`.length;
    if (cur.length && len + part > budget) { chunks.push(cur); cur = []; len = 0; }
    cur.push(term);
    len += part;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// `all`: skip the repo: qualifiers (the fallback described above).
function githubSearchQueries(repos, { all = false } = {}) {
  const longestBase = Math.max(...GITHUB_ROLE_QUERIES.map((q) => q.base.length));
  // Several repo: qualifiers are ORed by the search API.
  let chunks = all ? [] : chunkTerms([...repos].sort().map((r) => `repo:${r}`), GITHUB_SEARCH_MAX_QUERY - longestBase);
  if (all || chunks.length > GITHUB_REPO_CHUNKS_MAX) chunks = [[]];
  const out = [];
  for (const chunk of chunks) {
    for (const { role, base } of GITHUB_ROLE_QUERIES) out.push({ role, q: [base, ...chunk].join(' ') });
  }
  return out;
}

function repoFromApiUrl(url) {
  const m = /\/repos\/([^/]+\/[^/]+)$/.exec(String(url || ''));
  return m ? m[1] : '';
}

function githubItem(raw, role) {
  const repo = repoFromApiUrl(raw.repository_url);
  return {
    id: raw.html_url,
    url: raw.html_url,
    ref: `${repo}#${raw.number}`,
    title: String(raw.title || ''),
    kind: raw.pull_request ? 'pr' : 'issue',
    draft: !!raw.draft,
    roles: [role],
    updated: raw.updated_at || null
  };
}

// Merge results of all queries: one entry per issue/PR, with every role it matched.
// Only items of the checked repos (`repos`) are kept.
function mergeGithubResults(results, repos) {
  const wanted = new Set(repos.map((r) => r.toLowerCase()));
  const byUrl = new Map();
  for (const { role, items } of results) {
    for (const raw of items || []) {
      if (!raw || typeof raw.html_url !== 'string') continue;
      if (!wanted.has(repoFromApiUrl(raw.repository_url).toLowerCase())) continue;
      const existing = byUrl.get(raw.html_url);
      if (existing) { if (!existing.roles.includes(role)) existing.roles.push(role); continue; }
      byUrl.set(raw.html_url, githubItem(raw, role));
    }
  }
  return sortByUpdated([...byUrl.values()]);
}

// → { items, truncated }: `truncated` when GitHub couldn't return every match (its 1000-result
// cap, or incomplete_results), so the panel can say the list may be partial.
async function fetchGithubTasks({ token, repos, fetchImpl = fetch }) {
  if (!repos.length) return { items: [], truncated: false };
  try {
    return await runGithubSearch(fetchImpl, githubHeaders(token), repos, githubSearchQueries(repos));
  } catch (err) {
    if (!err || err.code !== 'http-422') throw err;
    return runGithubSearch(fetchImpl, githubHeaders(token), repos, githubSearchQueries(repos, { all: true }));
  }
}

async function runGithubSearch(fetchImpl, headers, repos, queries) {
  const results = [];
  let truncated = false;
  let requests = 0;
  // Page by page across all queries (every query's newest page first), one request at a time: the
  // request budget is never spent on one query's old results while another's new ones go unasked.
  let pending = queries.map((query) => ({ ...query, page: 1 }));
  while (pending.length) {
    const next = [];
    for (const query of pending) {
      if (requests >= GITHUB_SEARCH_REQUESTS_MAX) { truncated = true; break; }
      requests++;
      const url = `${GITHUB_API}/search/issues?q=${encodeURIComponent(query.q)}&sort=updated&order=desc&per_page=100&page=${query.page}`;
      const data = await getJson(fetchImpl, 'github', url, headers);
      const items = Array.isArray(data.items) ? data.items : [];
      results.push({ role: query.role, items });
      if (data.incomplete_results) truncated = true;
      if (items.length < 100 || data.total_count <= query.page * 100) continue; // all fetched
      if (query.page === GITHUB_SEARCH_PAGES_MAX) { if (!(data.total_count <= query.page * 100)) truncated = true; continue; }
      next.push({ ...query, page: query.page + 1 });
    }
    if (requests >= GITHUB_SEARCH_REQUESTS_MAX && next.length) { truncated = true; break; }
    pending = next;
  }
  return { items: mergeGithubResults(results, repos), truncated };
}

// The account itself first, then its organizations.
async function fetchGithubOwners({ token, fetchImpl = fetch }) {
  const headers = githubHeaders(token);
  const me = await getJson(fetchImpl, 'github', `${GITHUB_API}/user`, headers);
  let orgs = [];
  try {
    const data = await getJson(fetchImpl, 'github', `${GITHUB_API}/user/orgs?per_page=100`, headers);
    orgs = Array.isArray(data) ? data.map((o) => o && o.login).filter((l) => typeof l === 'string') : [];
  } catch { /* a token without org read access still lists the user's own repos */ }
  const login = me && typeof me.login === 'string' ? me.login : null;
  if (!login) throw new TaskError('bad-response');
  return { login, owners: [login, ...orgs.filter((o) => o !== login).sort((a, b) => a.localeCompare(b))] };
}

// GitHub logins are case-insensitive.
const sameLogin = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

async function fetchGithubRepos({ token, owner, login, fetchImpl = fetch }) {
  if (!OWNER_RE.test(String(owner || ''))) throw new TaskError('bad-owner');
  const headers = githubHeaders(token);
  // Own account: its private repos too. An organization: every repo the token can see. Another
  // user's handle (not an organization → 404): their public repos.
  let base = sameLogin(owner, login)
    ? `${GITHUB_API}/user/repos?affiliation=owner&sort=full_name`
    : `${GITHUB_API}/orgs/${encodeURIComponent(owner)}/repos?type=all&sort=full_name`;
  const repos = [];
  for (let page = 1; page <= GITHUB_REPO_PAGES_MAX; page++) {
    let data;
    try {
      data = await getJson(fetchImpl, 'github', `${base}&per_page=100&page=${page}`, headers);
    } catch (err) {
      if (page !== 1 || sameLogin(owner, login) || !err || err.code !== 'not-found' || base.includes('/users/')) throw err;
      base = `${GITHUB_API}/users/${encodeURIComponent(owner)}/repos?type=owner&sort=full_name`;
      data = await getJson(fetchImpl, 'github', `${base}&per_page=100&page=${page}`, headers);
    }
    if (!Array.isArray(data)) throw new TaskError('bad-response');
    for (const r of data) {
      if (r && typeof r.full_name === 'string' && REPO_RE.test(r.full_name) && !r.archived) repos.push(r.full_name);
    }
    if (data.length < 100) break;
  }
  return [...new Set(repos)].sort((a, b) => a.localeCompare(b));
}

// --- Backlog ---

function backlogBase(space, domain) {
  if (!SPACE_RE.test(String(space || '')) || !BACKLOG_DOMAINS.includes(domain)) throw new TaskError('bad-space');
  return `https://${space}.backlog.${domain}`;
}

// The API key goes in the query string — that is how Backlog's API authenticates with one.
function backlogUrl(base, apiPath, apiKey, params = []) {
  const qs = [['apiKey', apiKey], ...params].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `${base}/api/v2${apiPath}?${qs}`;
}

// Every status id that isn't "Closed", across the projects the user can see (projects may add
// custom statuses). One request at a time (Backlog rate-limits per user), and a failure fails the
// refresh: guessing would silently hide issues sitting in an unlisted custom status.
// Cached per space and key for an hour: the per-project calls would otherwise spend the user's
// rate limit on every refresh.
const BACKLOG_STATUS_TTL_MS = 60 * 60 * 1000;
const backlogStatusCache = new Map(); // `${base}\n${sha256(apiKey)}` -> { ids, at }
// `fresh` (a manual refresh) skips the cache, so a just-added custom status shows up on ⟳.
async function backlogOpenStatusIds(fetchImpl, base, apiKey, cache = backlogStatusCache, fresh = false) {
  const key = `${base}\n${crypto.createHash('sha256').update(apiKey).digest('hex')}`;
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < BACKLOG_STATUS_TTL_MS) return hit.ids;
  const ids = await listBacklogOpenStatusIds(fetchImpl, base, apiKey);
  cache.set(key, { ids, at: Date.now() });
  return ids;
}

async function listBacklogOpenStatusIds(fetchImpl, base, apiKey) {
  const projects = await getJson(fetchImpl, 'backlog', backlogUrl(base, '/projects', apiKey, [['archived', 'false']]));
  if (!Array.isArray(projects)) throw new TaskError('bad-response');
  const ids = new Set(BACKLOG_DEFAULT_OPEN_STATUSES);
  for (const p of projects) {
    if (!p || !Number.isInteger(p.id)) continue;
    const list = await getJson(fetchImpl, 'backlog', backlogUrl(base, `/projects/${p.id}/statuses`, apiKey));
    for (const st of Array.isArray(list) ? list : []) {
      if (st && Number.isInteger(st.id) && st.id !== BACKLOG_CLOSED_STATUS_ID) ids.add(st.id);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

function backlogItem(base, raw) {
  const key = String(raw.issueKey || '');
  return {
    id: key,
    url: `${base}/view/${encodeURIComponent(key)}`,
    ref: key,
    title: String(raw.summary || ''),
    status: raw.status && typeof raw.status.name === 'string' ? raw.status.name : '',
    due: typeof raw.dueDate === 'string' ? raw.dueDate.slice(0, 10) : null,
    updated: raw.updated || null
  };
}

// → { items, truncated } (truncated: more than the 1000 issues fetched).
async function fetchBacklogTasks({ apiKey, space, domain, fresh = false, fetchImpl = fetch, statusCache = backlogStatusCache }) {
  const base = backlogBase(space, domain);
  const me = await getJson(fetchImpl, 'backlog', backlogUrl(base, '/users/myself', apiKey));
  if (!me || !Number.isInteger(me.id)) throw new TaskError('bad-response');
  const statusIds = await backlogOpenStatusIds(fetchImpl, base, apiKey, statusCache, fresh);
  const params = [['assigneeId[]', me.id], ...statusIds.map((id) => ['statusId[]', id]),
    ['sort', 'updated'], ['order', 'desc'], ['count', 100]];
  const issues = [];
  let truncated = false;
  for (let page = 0; page < BACKLOG_ISSUE_PAGES_MAX; page++) {
    const batch = await getJson(fetchImpl, 'backlog', backlogUrl(base, '/issues', apiKey, [...params, ['offset', page * 100]]));
    if (!Array.isArray(batch)) throw new TaskError('bad-response');
    issues.push(...batch);
    if (batch.length < 100) break;
    if (page === BACKLOG_ISSUE_PAGES_MAX - 1) {
      // A full last page: only "more" if one more issue exists past it.
      const probe = await getJson(fetchImpl, 'backlog', backlogUrl(base, '/issues', apiKey,
        [...params.filter(([k]) => k !== 'count'), ['count', 1], ['offset', (page + 1) * 100]]));
      truncated = Array.isArray(probe) && probe.length > 0;
    }
  }
  const items = sortByUpdated(issues.filter((i) => i && i.issueKey && !(i.status && i.status.id === BACKLOG_CLOSED_STATUS_ID))
    .map((i) => backlogItem(base, i)));
  return { items, truncated };
}

// --- shared ---

function sortByUpdated(items) {
  const ts = (v) => { const n = Date.parse(v || ''); return Number.isNaN(n) ? 0 : n; };
  return items.sort((a, b) => ts(b.updated) - ts(a.updated));
}

module.exports = {
  TaskError,
  normalizeConfig,
  normalizeGithub,
  normalizeBacklog,
  normalizeBacklogList,
  normalizeSlack,
  applyConfigChange,
  isConfigured,
  githubSearchQueries,
  mergeGithubResults,
  fetchGithubTasks,
  fetchGithubOwners,
  fetchGithubRepos,
  backlogBase,
  fetchBacklogTasks,
  sortByUpdated,
  GITHUB_SEARCH_MAX_QUERY,
  GITHUB_SEARCH_REQUESTS_MAX,
  REPOS_MAX
};
