const { test } = require('node:test');
const assert = require('node:assert/strict');
const tasks = require('../src/tasks');

// A fake fetch: routes are matched by URL substring, in order; every call is recorded.
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const route = routes.find((r) => (typeof r.match === 'function' ? r.match(url) : url.includes(r.match)));
    if (!route) throw new Error(`unexpected ${url}`);
    if (route.throws) throw route.throws;
    const status = route.status || 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Map(Object.entries(route.headers || {})),
      json: async () => (typeof route.body === 'function' ? route.body(url) : route.body)
    };
  };
  impl.calls = calls;
  return impl;
}

test('normalizeConfig keeps only well-formed settings', () => {
  assert.deepEqual(tasks.normalizeConfig(null), { github: null, gitlab: null, backlog: [], slack: null });
  const cfg = tasks.normalizeConfig({
    github: { tokenKey: 'GH_TOKEN', repos: ['a/b', 'a/b', 'bad repo', 'x/../y', 5, 'org/r.e-p_o'] },
    backlog: { tokenKey: 'BL_KEY', space: ' myspace ', domain: 'jp' }
  });
  assert.deepEqual(cfg.github, { tokenKey: 'GH_TOKEN', repos: ['a/b', 'org/r.e-p_o'] });
  // Settings saved before issue #134 hold one space as an object: it becomes a list of one.
  assert.deepEqual(cfg.backlog, [{ tokenKey: 'BL_KEY', space: 'myspace', domain: 'jp', projects: [] }]);
  assert.equal(cfg.slack, null);
  assert.equal(tasks.normalizeGithub({ tokenKey: '../x', repos: ['a/b'] }), null);
  assert.equal(tasks.normalizeBacklog({ tokenKey: 'K', space: 'evil.com/x' }), null);
  assert.equal(tasks.normalizeBacklog({ tokenKey: 'K', space: 's', domain: 'evil' }).domain, 'com');
});

test('isConfigured needs a token and repos (GitHub) / a space (Backlog)', () => {
  assert.equal(tasks.isConfigured('github', { tokenKey: 'T', repos: [] }), false);
  assert.equal(tasks.isConfigured('github', { tokenKey: 'T', repos: ['a/b'] }), true);
  assert.equal(tasks.isConfigured('backlog', { tokenKey: 'T', space: 's', domain: 'com' }), true);
  assert.equal(tasks.isConfigured('backlog', null), false);
  assert.equal(tasks.isConfigured('other', { tokenKey: 'T' }), false);
});

test('githubSearchQueries names the repos while they fit in a few queries', () => {
  const qs = tasks.githubSearchQueries(['o/b', 'o/a', 'p/c']);
  assert.equal(qs.length, 2);
  for (const { q } of qs) assert.deepEqual(q.match(/repo:\S+/g), ['repo:o/a', 'repo:o/b', 'repo:p/c']);
});

test('githubSearchQueries drops the repo list when it needs more than a few queries (or all is asked)', () => {
  const many = Array.from({ length: 100 }, (_, i) => `organization-${String(i).padStart(3, '0')}/repository`);
  for (const qs of [tasks.githubSearchQueries(many), tasks.githubSearchQueries(['o/r'], { all: true })]) {
    assert.equal(qs.length, 2);
    for (const { q } of qs) assert.ok(!/repo:|user:/.test(q), q);
    assert.ok(qs.find((x) => x.role === 'assignee').q.includes('assignee:@me'));
    const reviewer = qs.find((x) => x.role === 'reviewer').q;
    assert.ok(reviewer.includes('is:pr') && reviewer.includes('user-review-requested:@me') && reviewer.includes('is:open'));
  }
  const fits = Array.from({ length: 6 }, (_, i) => `org/repository-${i}`);
  for (const { q } of tasks.githubSearchQueries(fits)) assert.ok(q.length <= tasks.GITHUB_SEARCH_MAX_QUERY);
});

test('fetchGithubTasks retries without repo names when GitHub refuses one (422)', async () => {
  const hit = { html_url: 'https://github.com/o/r/issues/1', number: 1, repository_url: 'https://api.github.com/repos/o/r', updated_at: '2026-01-01T00:00:00Z' };
  const f = fakeFetch([
    { match: 'repo%3A', status: 422 },
    { match: 'assignee%3A%40me', body: { items: [hit] } },
    { match: 'review-requested', body: { items: [] } }
  ]);
  const { items } = await tasks.fetchGithubTasks({ token: 't', repos: ['o/r', 'o/gone'], fetchImpl: f });
  assert.deepEqual(items.map((i) => i.ref), ['o/r#1']);
});

test('fetchGithubTasks keeps only checked repos, merges roles, sorts by updated, sends the token as a header', async () => {
  const issue = (n, updated, extra = {}, repo = 'o/r') => ({ html_url: `https://github.com/${repo}/issues/${n}`, number: n, title: `t${n}`,
    repository_url: `https://api.github.com/repos/${repo}`, updated_at: updated, ...extra });
  const f = fakeFetch([
    { match: (u) => u.includes('assignee%3A%40me'), body: { items: [issue(1, '2026-01-01T00:00:00Z'), issue(2, '2026-03-01T00:00:00Z', { pull_request: {} }), issue(9, '2026-05-01T00:00:00Z', {}, 'o/unchecked')] } },
    { match: (u) => u.includes('user-review-requested%3A%40me'), body: { items: [issue(2, '2026-03-01T00:00:00Z', { pull_request: {} }), issue(3, '2026-02-01T00:00:00Z', { pull_request: {}, draft: true })] } }
  ]);
  const { items, truncated } = await tasks.fetchGithubTasks({ token: 'tok', repos: ['o/r'], fetchImpl: f });
  assert.equal(truncated, false);
  assert.deepEqual(items.map((i) => i.ref), ['o/r#2', 'o/r#3', 'o/r#1']);
  assert.deepEqual(items[0].roles, ['assignee', 'reviewer']);
  assert.equal(items[0].kind, 'pr');
  assert.equal(items[1].draft, true);
  assert.equal(items[2].kind, 'issue');
  assert.equal(f.calls.length, 2);
  for (const c of f.calls) {
    assert.ok(c.url.startsWith('https://api.github.com/search/issues?'));
    assert.equal(c.opts.headers.Authorization, 'Bearer tok');
    assert.ok(!c.url.includes('tok'));
  }
});

test('fetchGithubTasks pages through full result pages', async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ html_url: `https://github.com/o/r/issues/${i}`, number: i, title: 'x',
    repository_url: 'https://api.github.com/repos/o/r', updated_at: '2026-01-01T00:00:00Z' }));
  const f = fakeFetch([
    { match: (u) => u.includes('assignee%3A%40me') && u.endsWith('&page=1'), body: { items: full } },
    { match: (u) => u.includes('assignee%3A%40me') && u.endsWith('&page=2'), body: { items: [{ ...full[0], html_url: 'https://github.com/o/r/issues/500', number: 500 }] } },
    { match: 'review-requested', body: { items: [] } }
  ]);
  const { items } = await tasks.fetchGithubTasks({ token: 't', repos: ['o/r'], fetchImpl: f });
  assert.equal(items.length, 101);
  assert.equal(f.calls.length, 3);
});

test('GitHub errors map to codes (auth, rate limit, network)', async () => {
  const run = (route) => tasks.fetchGithubTasks({ token: 't', repos: ['o/r'], fetchImpl: fakeFetch([{ match: 'api.github.com', ...route }]) });
  await assert.rejects(run({ status: 401 }), { code: 'auth' });
  await assert.rejects(run({ status: 403, headers: { 'x-ratelimit-remaining': '0' } }), { code: 'rate-limit' });
  await assert.rejects(run({ status: 403 }), { code: 'forbidden' });
  await assert.rejects(run({ status: 502 }), { code: 'http-502' });
  await assert.rejects(run({ throws: new TypeError('fetch failed') }), { code: 'network' });
  await assert.rejects(run({ throws: Object.assign(new Error('t'), { name: 'TimeoutError' }) }), { code: 'timeout' });
});

test('fetchGithubOwners lists the account first, then its organizations', async () => {
  const f = fakeFetch([
    { match: '/user/orgs', body: [{ login: 'zeta' }, { login: 'alpha' }] },
    { match: '/user', body: { login: 'me' } }
  ]);
  assert.deepEqual(await tasks.fetchGithubOwners({ token: 't', fetchImpl: f }), { login: 'me', owners: ['me', 'alpha', 'zeta'] });
  const noOrgs = fakeFetch([{ match: '/user/orgs', status: 403 }, { match: '/user', body: { login: 'me' } }]);
  assert.deepEqual((await tasks.fetchGithubOwners({ token: 't', fetchImpl: noOrgs })).owners, ['me']);
});

test('fetchGithubRepos pages through an org (or the account) and skips archived repos', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ full_name: `org/r${String(i).padStart(3, '0')}` }));
  const f = fakeFetch([
    { match: (u) => u.endsWith('&page=1'), body: page1 },
    { match: (u) => u.endsWith('&page=2'), body: [{ full_name: 'org/z-last' }, { full_name: 'org/old', archived: true }] }
  ]);
  const repos = await tasks.fetchGithubRepos({ token: 't', owner: 'org', login: 'me', fetchImpl: f });
  assert.equal(repos.length, 101);
  assert.ok(!repos.includes('org/old'));
  assert.ok(f.calls[0].url.startsWith('https://api.github.com/orgs/org/repos?'));
  const user = fakeFetch([{ match: '/orgs/someone/', status: 404 }, { match: '/users/someone/repos', body: [{ full_name: 'someone/pub' }] }]);
  assert.deepEqual(await tasks.fetchGithubRepos({ token: 't', owner: 'someone', login: 'me', fetchImpl: user }), ['someone/pub']);
  const mine = fakeFetch([{ match: '/user/repos', body: [{ full_name: 'me/a' }] }]);
  assert.deepEqual(await tasks.fetchGithubRepos({ token: 't', owner: 'me', login: 'me', fetchImpl: mine }), ['me/a']);
  assert.deepEqual(await tasks.fetchGithubRepos({ token: 't', owner: 'ME', login: 'me', fetchImpl: mine }), ['me/a']);
  await assert.rejects(tasks.fetchGithubRepos({ token: 't', owner: '../x', login: 'me', fetchImpl: mine }), { code: 'bad-owner' });
});

test('fetchBacklogTasks lists my open issues across every non-closed status', async () => {
  const f = fakeFetch([
    { match: '/users/myself', body: { id: 42 } },
    { match: (u) => /\/projects\?/.test(u), body: [{ id: 7 }, { id: 8 }] },
    { match: '/projects/7/statuses', body: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 99 }] },
    { match: '/projects/8/statuses', body: [{ id: 1 }, { id: 4 }] },
    { match: '/issues?', body: [
      { issueKey: 'PRJ-1', summary: 'old', status: { id: 1, name: '未対応' }, dueDate: '2026-01-05T00:00:00Z', updated: '2026-01-01T00:00:00Z' },
      { issueKey: 'PRJ-2', summary: 'new', status: { id: 99, name: 'レビュー中' }, dueDate: null, updated: '2026-02-01T00:00:00Z' },
      { issueKey: 'PRJ-3', summary: 'done', status: { id: 4, name: '完了' }, updated: '2026-03-01T00:00:00Z' }
    ] }
  ]);
  const { items } = await tasks.fetchBacklogTasks({ apiKey: 'k&y', space: 'myspace', domain: 'jp', fetchImpl: f, statusCache: new Map() });
  assert.deepEqual(items.map((i) => i.ref), ['PRJ-2', 'PRJ-1']);
  assert.equal(items[0].url, 'https://myspace.backlog.jp/view/PRJ-2');
  assert.equal(items[1].due, '2026-01-05');
  assert.equal(items[1].status, '未対応');
  const issuesUrl = f.calls.find((c) => c.url.includes('/issues?')).url;
  assert.ok(issuesUrl.startsWith('https://myspace.backlog.jp/api/v2/issues?apiKey=k%26y&'));
  const params = new URL(issuesUrl).searchParams;
  assert.deepEqual(params.getAll('assigneeId[]'), ['42']);
  assert.deepEqual(params.getAll('statusId[]'), ['1', '2', '3', '99']);
});

test('fetchBacklogTasks fails rather than guess when statuses cannot be listed, and rejects a bad space', async () => {
  const f = fakeFetch([
    { match: '/users/myself', body: { id: 1 } },
    { match: (u) => /\/projects\?/.test(u), body: [{ id: 5 }] },
    { match: '/projects/5/statuses', status: 429 },
    { match: '/issues?', body: [] }
  ]);
  await assert.rejects(tasks.fetchBacklogTasks({ apiKey: 'k', space: 's', domain: 'com', fetchImpl: f, statusCache: new Map() }), { code: 'rate-limit' });
  assert.ok(!f.calls.some((c) => c.url.includes('/issues?')));
  await assert.rejects(tasks.fetchBacklogTasks({ apiKey: 'k', space: 'x.evil.com/', domain: 'com', fetchImpl: f, statusCache: new Map() }), { code: 'bad-space' });
  const unauth = fakeFetch([{ match: '/users/myself', status: 401 }]);
  await assert.rejects(tasks.fetchBacklogTasks({ apiKey: 'k', space: 's', domain: 'com', fetchImpl: unauth, statusCache: new Map() }), { code: 'auth' });
});

test('fetchBacklogTasks pages with offset until a short page', async () => {
  const page = (n, from) => Array.from({ length: n }, (_, i) => ({ issueKey: `P-${from + i}`, summary: 's', status: { id: 1, name: 'Open' }, updated: '2026-01-01T00:00:00Z' }));
  const f = fakeFetch([
    { match: '/users/myself', body: { id: 1 } },
    { match: (u) => /\/projects\?/.test(u), body: [] },
    { match: (u) => u.includes('/issues?') && u.endsWith('offset=0'), body: page(100, 0) },
    { match: (u) => u.includes('/issues?') && u.endsWith('offset=100'), body: page(3, 100) }
  ]);
  const { items, truncated } = await tasks.fetchBacklogTasks({ apiKey: 'k', space: 's', domain: 'com', fetchImpl: f, statusCache: new Map() });
  assert.equal(items.length, 103);
  assert.equal(truncated, false);
});

test('normalizeGithub refuses more repos than the cap instead of dropping some', () => {
  const repos = Array.from({ length: tasks.REPOS_MAX + 1 }, (_, i) => `o/r${i}`);
  assert.equal(tasks.normalizeGithub({ tokenKey: 'T', repos }), null);
  assert.equal(tasks.normalizeGithub({ tokenKey: 'T', repos: repos.slice(1) }).repos.length, tasks.REPOS_MAX);
});

test('fetchGithubTasks reports truncation (incomplete results or the 1000-result cap)', async () => {
  const f = fakeFetch([{ match: 'api.github.com', body: { incomplete_results: true, items: [] } }]);
  assert.equal((await tasks.fetchGithubTasks({ token: 't', repos: ['o/r'], fetchImpl: f })).truncated, true);
  const full = Array.from({ length: 100 }, (_, i) => ({ html_url: `https://github.com/o/r/issues/${i}`, number: i,
    repository_url: 'https://api.github.com/repos/o/r', updated_at: '2026-01-01T00:00:00Z' }));
  const capped = fakeFetch([{ match: 'api.github.com', body: { items: full } }]);
  const res = await tasks.fetchGithubTasks({ token: 't', repos: ['o/r'], fetchImpl: capped });
  assert.equal(res.truncated, true);
  assert.equal(capped.calls.length, tasks.GITHUB_SEARCH_REQUESTS_MAX); // stops at the per-refresh budget
});

test('fetchBacklogTasks reuses the status list within the hour', async () => {
  const f = fakeFetch([
    { match: '/users/myself', body: { id: 1 } },
    { match: (u) => /\/projects\?/.test(u), body: [{ id: 5 }] },
    { match: '/projects/5/statuses', body: [{ id: 77 }] },
    { match: '/issues?', body: [] }
  ]);
  const statusCache = new Map();
  await tasks.fetchBacklogTasks({ apiKey: 'k', space: 's', domain: 'com', fetchImpl: f, statusCache });
  await tasks.fetchBacklogTasks({ apiKey: 'k', space: 's', domain: 'com', fetchImpl: f, statusCache });
  assert.equal(f.calls.filter((c) => c.url.includes('/statuses')).length, 1);
  const params = new URL(f.calls.at(-1).url).searchParams;
  assert.deepEqual(params.getAll('statusId[]'), ['1', '2', '3', '77']);
});

test('fetchGithubTasks asks every query\'s first page before any second page', async () => {
  const full = (role) => Array.from({ length: 100 }, (_, i) => ({ html_url: `https://github.com/o/r/issues/${role}${i}`, number: i,
    repository_url: 'https://api.github.com/repos/o/r', updated_at: '2026-01-01T00:00:00Z' }));
  const f = fakeFetch([
    { match: 'user-review-requested', body: { items: full(2) } },
    { match: 'assignee', body: { items: full(1) } }
  ]);
  await tasks.fetchGithubTasks({ token: 't', repos: ['o/r'], fetchImpl: f });
  const pages = f.calls.slice(0, 4).map((c) => `${c.url.includes('user-review') ? 'R' : 'A'}${new URL(c.url).searchParams.get('page')}`);
  assert.deepEqual(pages, ['A1', 'R1', 'A2', 'R2']);
});

test('fetchBacklogTasks with fresh re-reads the status list', async () => {
  const f = fakeFetch([
    { match: '/users/myself', body: { id: 1 } },
    { match: (u) => /\/projects\?/.test(u), body: [{ id: 5 }] },
    { match: '/projects/5/statuses', body: [{ id: 77 }] },
    { match: '/issues?', body: [] }
  ]);
  const statusCache = new Map();
  await tasks.fetchBacklogTasks({ apiKey: 'k', space: 's', domain: 'com', fetchImpl: f, statusCache });
  await tasks.fetchBacklogTasks({ apiKey: 'k', space: 's', domain: 'com', fresh: true, fetchImpl: f, statusCache });
  assert.equal(f.calls.filter((c) => c.url.includes('/statuses')).length, 2);
});

test('truncation is reported only when there really is more than the cap', async () => {
  const gh = Array.from({ length: 100 }, (_, i) => ({ html_url: `https://github.com/o/r/issues/${i}`, number: i,
    repository_url: 'https://api.github.com/repos/o/r', updated_at: '2026-01-01T00:00:00Z' }));
  const exact = fakeFetch([{ match: 'assignee', body: { total_count: 1000, items: gh } }, { match: 'user-review', body: { items: [] } }]);
  assert.equal((await tasks.fetchGithubTasks({ token: 't', repos: ['o/r'], fetchImpl: exact })).truncated, false);
  const done = fakeFetch([{ match: 'assignee', body: { total_count: 100, items: gh } }, { match: 'user-review', body: { items: [] } }]);
  await tasks.fetchGithubTasks({ token: 't', repos: ['o/r'], fetchImpl: done });
  assert.equal(done.calls.length, 2); // a full page that total_count says is the last: no page 2
  const page = Array.from({ length: 100 }, (_, i) => ({ issueKey: `P-${i}`, status: { id: 1 }, updated: '2026-01-01T00:00:00Z' }));
  const routes = (more) => fakeFetch([
    { match: '/users/myself', body: { id: 1 } },
    { match: (u) => /\/projects\?/.test(u), body: [] },
    { match: (u) => u.includes('/issues?') && u.endsWith('offset=1000'), body: more ? [page[0]] : [] },
    { match: '/issues?', body: page }
  ]);
  assert.equal((await tasks.fetchBacklogTasks({ apiKey: 'k', space: 's', domain: 'com', fetchImpl: routes(false), statusCache: new Map() })).truncated, false);
  assert.equal((await tasks.fetchBacklogTasks({ apiKey: 'k', space: 's', domain: 'com', fetchImpl: routes(true), statusCache: new Map() })).truncated, true);
});

test('normalizeConfig keeps several Backlog spaces (each once, up to the cap) and the Slack secret', () => {
  const cfg = tasks.normalizeConfig({
    backlog: [
      { tokenKey: 'K1', space: 'one', domain: 'com' },
      { tokenKey: 'K2', space: 'ONE', domain: 'com' }, // the same space again
      { tokenKey: 'K3', space: 'one', domain: 'jp' },  // another space: a different domain
      { tokenKey: 'K4', space: 'bad space' },
      null
    ],
    slack: { tokenKey: 'SLACK', extra: 1 }
  });
  assert.deepEqual(cfg.backlog, [{ tokenKey: 'K1', space: 'one', domain: 'com', projects: [] }, { tokenKey: 'K3', space: 'one', domain: 'jp', projects: [] }]);
  assert.deepEqual(cfg.slack, { tokenKey: 'SLACK', channels: [] });
  assert.equal(tasks.normalizeSlack({ tokenKey: '../x' }), null);
  const many = Array.from({ length: 20 }, (_, i) => ({ tokenKey: 'K', space: `s${i}`, domain: 'com' }));
  assert.equal(tasks.normalizeConfig({ backlog: many }).backlog.length, 5);
  assert.equal(tasks.isConfigured('slack', { tokenKey: 'SLACK' }), true);
  assert.equal(tasks.isConfigured('slack', null), false);
});

test('applyConfigChange adds, edits and removes one Backlog space without touching the others', () => {
  const a = { tokenKey: 'KA', space: 'alpha', domain: 'com', projects: [] };
  const b = { tokenKey: 'KB', space: 'beta', domain: 'jp', projects: [7, 8] };
  let cfg = tasks.applyConfigChange(null, 'backlog', a).config;
  cfg = tasks.applyConfigChange(cfg, 'backlog', b).config;
  assert.deepEqual(cfg.backlog, [a, b]);
  // The same space again (any case) is refused, whether added or renamed onto.
  assert.deepEqual(tasks.applyConfigChange(cfg, 'backlog', { ...a, space: 'ALPHA' }), { error: 'duplicate' });
  assert.deepEqual(tasks.applyConfigChange(cfg, 'backlog', { ...a, tokenKey: 'KB' }, 'backlog:beta.jp'), { error: 'duplicate' });
  // Editing keeps the position; saving a space unchanged is not a duplicate of itself.
  const edited = tasks.applyConfigChange(cfg, 'backlog', { ...a, tokenKey: 'KA2' }, 'backlog:alpha.com').config;
  assert.deepEqual(edited.backlog, [{ ...a, tokenKey: 'KA2' }, b]);
  const renamed = tasks.applyConfigChange(cfg, 'backlog', { tokenKey: 'KA', space: 'gamma', domain: 'com' }, 'backlog:alpha.com').config;
  assert.deepEqual(renamed.backlog.map((x) => x.space), ['gamma', 'beta']);
  // Removing one leaves the other; removing one that is already gone changes nothing.
  assert.deepEqual(tasks.applyConfigChange(cfg, 'backlog', null, 'backlog:alpha.com').config.backlog, [b]);
  assert.deepEqual(tasks.applyConfigChange(cfg, 'backlog', null, 'backlog:gone.com').config.backlog, [a, b]);
  assert.deepEqual(tasks.applyConfigChange(cfg, 'backlog', { tokenKey: 'K', space: 'bad space' }), { error: 'invalid' });
  // An edit of a space another window removed meanwhile does not bring it back.
  assert.deepEqual(tasks.applyConfigChange(cfg, 'backlog', a, 'backlog:gone.com'), { error: 'stale' });
  const full = { backlog: Array.from({ length: 5 }, (_, i) => ({ tokenKey: 'K', space: `s${i}`, domain: 'com' })) };
  assert.deepEqual(tasks.applyConfigChange(full, 'backlog', a), { error: 'too-many' });
  assert.equal(tasks.applyConfigChange(full, 'backlog', a, 'backlog:s0.com').config.backlog[0].space, 'alpha'); // an edit still fits
});

test('applyConfigChange sets and clears GitHub and Slack, leaving the rest alone', () => {
  const base = { backlog: [{ tokenKey: 'KA', space: 'alpha', domain: 'com' }] };
  const withSlack = tasks.applyConfigChange(base, 'slack', { tokenKey: 'SLACK' }).config;
  assert.deepEqual(withSlack.slack, { tokenKey: 'SLACK', channels: [] });
  assert.equal(withSlack.backlog.length, 1);
  assert.equal(tasks.applyConfigChange(withSlack, 'slack', null).config.slack, null);
  assert.deepEqual(tasks.applyConfigChange(base, 'slack', { tokenKey: '' }), { error: 'invalid' });
  assert.deepEqual(tasks.applyConfigChange(base, 'github', { tokenKey: 'T', repos: ['a/b'] }).config.github, { tokenKey: 'T', repos: ['a/b'] });
  assert.deepEqual(tasks.applyConfigChange(base, 'other', {}), { error: 'invalid' });
});

test('normalizeSlack keeps the checked channels (well-formed ids, each once) and refuses more than the cap', () => {
  assert.deepEqual(tasks.normalizeSlack({ tokenKey: 'S', channels: ['C0AAA', 'C0AAA', 'G0PRIV', 'D0DM', 'c0low', '../x', 5, null] }),
    { tokenKey: 'S', channels: ['C0AAA', 'G0PRIV'] });
  assert.deepEqual(tasks.normalizeSlack({ tokenKey: 'S', channels: 'C0AAA' }), { tokenKey: 'S', channels: [] });
  const many = Array.from({ length: 201 }, (_, i) => `C0${String(i).padStart(4, '0')}`);
  assert.equal(tasks.normalizeSlack({ tokenKey: 'S', channels: many }), null);
  assert.equal(tasks.normalizeSlack({ tokenKey: 'S', channels: many.slice(0, 200) }).channels.length, 200);
  // Saving the filter goes through the same check.
  assert.deepEqual(tasks.applyConfigChange(null, 'slack', { tokenKey: 'S', channels: ['C0AAA'] }).config.slack, { tokenKey: 'S', channels: ['C0AAA'] });
  assert.deepEqual(tasks.applyConfigChange(null, 'slack', { tokenKey: 'S', channels: many }), { error: 'invalid' });
});

test('normalizeBacklog keeps the checked projects (positive integer ids, each once) and refuses more than the cap', () => {
  const base = { tokenKey: 'K', space: 's', domain: 'com' };
  assert.deepEqual(tasks.normalizeBacklog({ ...base, projects: [7, 7, 8, 0, -1, 1.5, '9', null] }).projects, [7, 8]);
  assert.deepEqual(tasks.normalizeBacklog({ ...base, projects: 7 }).projects, []);
  assert.deepEqual(tasks.normalizeBacklog(base).projects, []); // settings saved before the filter existed
  const many = Array.from({ length: 101 }, (_, i) => i + 1);
  assert.equal(tasks.normalizeBacklog({ ...base, projects: many }), null);
  assert.equal(tasks.normalizeBacklog({ ...base, projects: many.slice(0, 100) }).projects.length, 100);
  // Editing a space's projects keeps it the same space (same panel).
  const cfg = tasks.applyConfigChange({ backlog: [base] }, 'backlog', { ...base, projects: [7] }, 'backlog:s.com').config;
  assert.deepEqual(cfg.backlog, [{ ...base, projects: [7] }]);
});

test('fetchBacklogTasks with projects picked asks only their issues and statuses', async () => {
  const f = fakeFetch([
    { match: '/users/myself', body: { id: 42 } },
    { match: (u) => /\/projects\?/.test(u), body: [{ id: 7 }, { id: 8 }, { id: 9 }] },
    { match: '/projects/7/statuses', body: [{ id: 1 }, { id: 4 }, { id: 70 }] },
    { match: '/projects/9/statuses', body: [{ id: 1 }, { id: 90 }] },
    { match: '/issues?', body: [{ issueKey: 'A-1', summary: 's', status: { id: 70, name: 'Custom' }, updated: '2026-01-01T00:00:00Z' }] }
  ]);
  const cache = new Map();
  // 11 was picked but is gone (archived, deleted): skipped, not an error.
  const { items } = await tasks.fetchBacklogTasks({ apiKey: 'k', space: 's', domain: 'com', projects: [9, 7, 11], fetchImpl: f, statusCache: cache });
  assert.deepEqual(items.map((i) => i.ref), ['A-1']);
  assert.ok(!f.calls.some((c) => c.url.includes('/projects/8/statuses'))); // nothing asked of the one left out
  const params = new URL(f.calls.find((c) => c.url.includes('/issues?')).url).searchParams;
  assert.deepEqual(params.getAll('projectId[]'), ['7', '9']);
  assert.deepEqual(params.getAll('statusId[]'), ['1', '2', '3', '70', '90']);
  // The status list is cached per set of picked projects: another set asks again, the same doesn't.
  const before = f.calls.filter((c) => c.url.includes('/statuses')).length;
  await tasks.fetchBacklogTasks({ apiKey: 'k', space: 's', domain: 'com', projects: [7, 9, 11], fetchImpl: f, statusCache: cache });
  assert.equal(f.calls.filter((c) => c.url.includes('/statuses')).length, before);
  await tasks.fetchBacklogTasks({ apiKey: 'k', space: 's', domain: 'com', projects: [7], fetchImpl: f, statusCache: cache });
  assert.equal(f.calls.filter((c) => c.url.includes('/statuses')).length, before + 1);
  // No projects picked: no projectId filter, as before.
  await tasks.fetchBacklogTasks({ apiKey: 'k', space: 's', domain: 'com', fetchImpl: fakeFetch([
    { match: '/users/myself', body: { id: 42 } }, { match: (u) => /\/projects\?/.test(u), body: [] },
    { match: (u) => { if (u.includes('/issues?')) assert.equal(new URL(u).searchParams.getAll('projectId[]').length, 0); return u.includes('/issues?'); }, body: [] }
  ]), statusCache: new Map() });
});

test('fetchBacklogTasks lists nothing (and asks no issues) when every picked project is gone', async () => {
  const f = fakeFetch([
    { match: '/users/myself', body: { id: 42 } },
    { match: (u) => /\/projects\?/.test(u), body: [{ id: 7 }] },
    { match: '/issues?', body: [{ issueKey: 'A-1', summary: 's', status: { id: 1, name: 'Open' } }] }
  ]);
  const res = await tasks.fetchBacklogTasks({ apiKey: 'k', space: 's', domain: 'com', projects: [11], fetchImpl: f, statusCache: new Map() });
  assert.deepEqual(res, { items: [], truncated: false });
  assert.ok(!f.calls.some((c) => c.url.includes('/issues?'))); // an unfiltered query would list every project's
});

test('fetchBacklogProjects lists the space\'s projects by key', async () => {
  const f = fakeFetch([{ match: (u) => /\/projects\?/.test(u), body: [{ id: 9, projectKey: 'ZED', name: 'Zed\n project' }, { id: 7, projectKey: 'ALPHA', name: 'Alpha' }, { projectKey: 'NOID' }, null] }]);
  const list = await tasks.fetchBacklogProjects({ apiKey: 'k&y', space: 'myspace', domain: 'jp', fetchImpl: f });
  assert.deepEqual(list, [{ id: 7, key: 'ALPHA', name: 'Alpha' }, { id: 9, key: 'ZED', name: 'Zed project' }]);
  assert.ok(f.calls[0].url.startsWith('https://myspace.backlog.jp/api/v2/projects?apiKey=k%26y&archived=false'));
  await assert.rejects(tasks.fetchBacklogProjects({ apiKey: 'k', space: 'x.evil.com/', domain: 'com', fetchImpl: f }), { code: 'bad-space' });
  await assert.rejects(tasks.fetchBacklogProjects({ apiKey: 'k', space: 's', domain: 'com', fetchImpl: fakeFetch([{ match: '/projects', status: 401 }]) }), { code: 'auth' });
});

test('normalizeGitlab keeps the secret and a well-formed host (gitlab.com when empty)', () => {
  assert.deepEqual(tasks.normalizeGitlab({ tokenKey: 'GL' }), { tokenKey: 'GL', host: 'gitlab.com' });
  assert.deepEqual(tasks.normalizeGitlab({ tokenKey: 'GL', host: '  ' }), { tokenKey: 'GL', host: 'gitlab.com' });
  assert.deepEqual(tasks.normalizeGitlab({ tokenKey: 'GL', host: 'GitLab.Example.com', extra: 1 }), { tokenKey: 'GL', host: 'gitlab.example.com' });
  // A pasted address leaves its host; the https port is dropped.
  assert.equal(tasks.gitlabHost('https://gitlab.example.com:8443/group/project/-/issues'), 'gitlab.example.com:8443');
  assert.equal(tasks.gitlabHost('gitlab.example.com:443'), 'gitlab.example.com');
  assert.equal(tasks.gitlabHost('localhost'), 'localhost');
  for (const bad of ['http://gitlab.example.com', 'user@gitlab.example.com', 'gitlab.example.com?x', 'a b', '-x.com', 'x-.com', 'a..b', 'host:0', 'host:99999', 'host:', '[::1]', `${'a'.repeat(64)}.com`, 5]) {
    assert.equal(tasks.normalizeGitlab({ tokenKey: 'GL', host: bad }), null, String(bad));
  }
  assert.equal(tasks.normalizeGitlab({ tokenKey: '../x' }), null);
  assert.equal(tasks.isConfigured('gitlab', { tokenKey: 'GL', host: 'gitlab.com' }), true);
  assert.equal(tasks.isConfigured('gitlab', null), false);
  // Set and cleared like GitHub and Slack, leaving the rest alone.
  const base = tasks.normalizeConfig({ slack: { tokenKey: 'S' } });
  const withGitlab = tasks.applyConfigChange(base, 'gitlab', { tokenKey: 'GL', host: 'https://GitLab.example.com/' }).config;
  assert.deepEqual(withGitlab.gitlab, { tokenKey: 'GL', host: 'gitlab.example.com' });
  assert.deepEqual(withGitlab.slack, { tokenKey: 'S', channels: [] });
  assert.equal(tasks.applyConfigChange(withGitlab, 'gitlab', null).config.gitlab, null);
  assert.deepEqual(tasks.applyConfigChange(base, 'gitlab', { tokenKey: 'GL', host: 'bad host' }), { error: 'invalid' });
  for (const bad of ['https://', '/gitlab', 'https:///x']) assert.equal(tasks.gitlabHost(bad), null, bad);
  // A secret about to go to a host other than gitlab.com is confirmed, unless that pair is already saved.
  const own = { tokenKey: 'GL', host: 'gitlab.example.com' };
  assert.equal(tasks.gitlabNeedsConfirm(null, { tokenKey: 'GL', host: 'gitlab.com' }), false);
  assert.equal(tasks.gitlabNeedsConfirm(own, { tokenKey: 'OTHER', host: 'gitlab.com' }), false);
  assert.equal(tasks.gitlabNeedsConfirm(null, own), true);
  assert.equal(tasks.gitlabNeedsConfirm(own, { ...own }), false);
  assert.equal(tasks.gitlabNeedsConfirm(own, { ...own, tokenKey: 'OTHER' }), true);
  assert.equal(tasks.gitlabNeedsConfirm(own, { ...own, host: 'evil.example' }), true);
  assert.equal(tasks.gitlabNeedsConfirm({ tokenKey: 'GL', host: 'gitlab.com' }, own), true);
  assert.equal(tasks.gitlabNeedsConfirm(own, null), false);
});

const glIssue = (over = {}) => ({ iid: 1, title: 'An issue', web_url: 'https://gitlab.example.com/g/p/-/issues/1', references: { full: 'g/p#1' }, updated_at: '2026-11-01T00:00:00Z', ...over });
const glMr = (over = {}) => ({ iid: 5, title: 'A merge request', web_url: 'https://gitlab.example.com/g/p/-/merge_requests/5', references: { full: 'g/p!5' }, updated_at: '2026-11-02T00:00:00Z', ...over });

test('fetchGitlabTasks lists issues and merge requests assigned to the user, and those to review', async () => {
  const f = fakeFetch([
    { match: '/api/v4/user', body: { id: 42, username: 'me' } },
    { match: '/api/v4/issues?', body: [glIssue(), glIssue({ iid: 2, web_url: 'javascript:alert(1)' }), glIssue({ iid: 3, web_url: 'https://u:p@gitlab.example.com/x' }), null] },
    { match: 'merge_requests?scope=assigned_to_me', body: [glMr(), glMr({ iid: 6, draft: true, web_url: 'https://gitlab.example.com/g/p/-/merge_requests/6', references: null, updated_at: '2026-11-05T00:00:00Z' })] },
    { match: 'reviewer_id=42', body: [glMr(), glMr({ iid: 7, work_in_progress: true, web_url: 'https://gitlab.example.com/g/q/-/merge_requests/7', references: { full: 'g/q!7' }, updated_at: '2026-11-03T00:00:00Z' })] }
  ]);
  const res = await tasks.fetchGitlabTasks({ token: 'glpat-x', host: 'gitlab.example.com', fetchImpl: f });
  assert.equal(res.truncated, false);
  // Newest update first; one entry per merge request, with both roles when it matched both.
  assert.deepEqual(res.items.map((i) => [i.ref, i.kind, i.draft, i.roles, i.title]), [
    ['!6', 'mr', true, ['assignee'], 'A merge request'],
    ['g/q!7', 'mr', true, ['reviewer'], 'A merge request'],
    ['g/p!5', 'mr', false, ['assignee', 'reviewer'], 'A merge request'],
    ['g/p#1', 'issue', false, ['assignee'], 'An issue']
  ]);
  assert.equal(res.items[3].url, 'https://gitlab.example.com/g/p/-/issues/1');
  assert.deepEqual(f.calls.map((c) => c.url), [
    'https://gitlab.example.com/api/v4/user',
    'https://gitlab.example.com/api/v4/issues?scope=assigned_to_me&state=opened&order_by=updated_at&sort=desc&per_page=100&page=1',
    'https://gitlab.example.com/api/v4/merge_requests?scope=assigned_to_me&state=opened&order_by=updated_at&sort=desc&per_page=100&page=1',
    'https://gitlab.example.com/api/v4/merge_requests?scope=all&reviewer_id=42&state=opened&order_by=updated_at&sort=desc&per_page=100&page=1'
  ]);
  for (const call of f.calls) {
    assert.equal(call.opts.headers['PRIVATE-TOKEN'], 'glpat-x');
    assert.equal(call.opts.redirect, 'error'); // the token is never sent on to a redirect target
  }
});

test('fetchGitlabTasks follows pages, reports a list cut short, and maps errors', async () => {
  const page = (url) => Array.from({ length: 100 }, (_, i) => glIssue({ iid: i, web_url: `https://gitlab.com/g/p/-/issues/${/&page=(\d+)/.exec(url)[1]}-${i}` }));
  const f = fakeFetch([
    { match: '/api/v4/user', body: { id: 1 } },
    { match: '/api/v4/issues?', body: page },
    { match: 'merge_requests', body: [] }
  ]);
  const res = await tasks.fetchGitlabTasks({ token: 't', host: 'gitlab.com', fetchImpl: f });
  assert.equal(res.items.length, tasks.GITLAB_PAGES_MAX * 100);
  assert.equal(res.truncated, true);
  assert.equal(f.calls.filter((c) => c.url.includes('/issues?')).length, tasks.GITLAB_PAGES_MAX);
  const code = (routes, host = 'gitlab.com') => tasks.fetchGitlabTasks({ token: 't', host, fetchImpl: fakeFetch(routes) }).then(() => null, (err) => err.code);
  assert.equal(await code([{ match: '/user', status: 401 }]), 'auth');
  assert.equal(await code([{ match: '/user', status: 403 }]), 'forbidden');
  assert.equal(await code([{ match: '/user', status: 429 }]), 'rate-limit');
  assert.equal(await code([{ match: '/user', body: { message: 'x' } }]), 'bad-response');
  assert.equal(await code([{ match: '/user', body: { id: 1 } }, { match: '/issues', body: { message: 'x' } }]), 'bad-response');
  assert.equal(await code([{ match: '/user', throws: new Error('redirect') }]), 'network');
  // Only a host as the settings hold it: nothing is asked of anything else.
  for (const bad of ['evil.example/x', 'https://gitlab.com', 'GitLab.com', '', null]) assert.equal(await code([], bad), 'bad-host');
});
