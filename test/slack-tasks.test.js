const { test } = require('node:test');
const assert = require('node:assert/strict');
const slack = require('../src/slack-tasks');

const SECRET = 'xoxc = xoxc-111-222-abc\nxoxd = xoxd-AbC%2Bdef%3D';

// A fake fetch for the Slack Web API: one handler per method, given the form parameters.
function fakeSlack(handlers) {
  const calls = [];
  const impl = async (url, opts) => {
    const method = url.split('/api/')[1];
    const params = Object.fromEntries(new URLSearchParams(opts.body));
    calls.push({ method, params, headers: opts.headers, http: opts.method, redirect: opts.redirect });
    const h = handlers[method];
    if (!h) throw new Error(`unexpected ${method}`);
    const out = typeof h === 'function' ? h(params) : h;
    if (out && out.throws) throw out.throws;
    const status = (out && out.status) || 200;
    return { ok: status >= 200 && status < 300, status, json: async () => { if (out && out.jsonThrows) throw out.jsonThrows; return out && out.body !== undefined ? out.body : out; } };
  };
  impl.calls = calls;
  impl.count = (method) => calls.filter((c) => c.method === method).length;
  return impl;
}

const AUTH = { ok: true, url: 'https://Example.slack.com/', team: 'Example' };
const saved = (items, cursor = '') => ({ ok: true, saved_items: items, response_metadata: { next_cursor: cursor } });
const todo = (over = {}) => ({ item_id: 'C0AAA', item_type: 'message', ts: '1700000000.000100', state: 'in_progress', todo_state: 'to_do', is_archived: false, date_due: 0, date_created: 100, ...over });

test('parseSlackSecret finds the token and the cookie in any layout, and needs both', () => {
  assert.deepEqual(slack.parseSlackSecret(SECRET), { token: 'xoxc-111-222-abc', cookie: 'xoxd-AbC%2Bdef%3D' });
  assert.deepEqual(slack.parseSlackSecret('{"d":"xoxd-zz%2F1","token":"xoxc-9-8"}'), { token: 'xoxc-9-8', cookie: 'xoxd-zz%2F1' });
  for (const bad of ['', 'xoxc-1-2', 'xoxd-abc', 'xoxp-1-2 xoxd-abc', null]) {
    assert.throws(() => slack.parseSlackSecret(bad), (err) => err.code === 'slack-secret');
  }
  // Nothing after the cookie value (a line break, a quote, a `;`) leaks into the Cookie header.
  assert.equal(slack.parseSlackSecret('xoxc-1-2\r\nxoxd-abc;\r\nX-Evil: 1').cookie, 'xoxd-abc');
});

test('slackPlainText turns Slack markup into one plain line', () => {
  assert.equal(slack.slackPlainText('Hi <@U123|taro> see <#C1|general> and <https://example.com/a|the doc>'), 'Hi @taro see #general and the doc');
  assert.equal(slack.slackPlainText('<@U123> <#C1> <https://example.com/a> <!here> <!subteam^S1|@devs>'), '@user #channel https://example.com/a @here @devs');
  assert.equal(slack.slackPlainText('a &lt;b&gt; &amp;amp; c\n\n  d'), 'a <b> &amp; c d');
  assert.equal(slack.slackPlainText('x'.repeat(300)).length, 200);
  assert.ok(slack.slackPlainText('x'.repeat(300)).endsWith('…'));
  assert.equal(slack.slackPlainText(null), '');
});

test('links are built only on the workspace address Slack reports', () => {
  assert.equal(slack.slackBaseUrl('https://Example.slack.com/'), 'https://example.slack.com');
  assert.equal(slack.slackBaseUrl('https://corp.enterprise.slack.com/'), 'https://corp.enterprise.slack.com');
  for (const bad of ['http://example.slack.com/', 'https://slack.com.evil.example/', 'https://evil.example/?x=.slack.com', 'nonsense', undefined]) {
    assert.throws(() => slack.slackBaseUrl(bad), (err) => err.code === 'bad-response');
  }
  assert.equal(slack.slackMessageUrl('https://example.slack.com', 'C0AAA', '1700000000.000100'), 'https://example.slack.com/archives/C0AAA/p1700000000000100');
  assert.equal(slack.slackMessageUrl('https://example.slack.com', 'C0AAA', '1700000001.000200', '1700000000.000100'),
    'https://example.slack.com/archives/C0AAA/p1700000001000200?thread_ts=1700000000.000100&cid=C0AAA');
  // A file's permalink is used only when it is on the workspace's address.
  assert.equal(slack.slackFileUrl('https://example.slack.com', 'https://example.slack.com/files/U1/F1/a.pdf'), 'https://example.slack.com/files/U1/F1/a.pdf');
  for (const bad of ['https://evil.example/files/U1/F1/a.pdf', 'http://example.slack.com/files/x', 'https://user@example.slack.com/x', 'https://example.slack.com:8443/files/x', 'blob:https://example.slack.com/1234', 'https://example.slack.com/a\nb', undefined]) {
    assert.equal(slack.slackFileUrl('https://example.slack.com', bad), 'https://example.slack.com');
  }
  // A thread's first message is a plain link.
  assert.equal(slack.slackMessageUrl('https://example.slack.com', 'C0AAA', '1700000000.000100', '1700000000.000100'), 'https://example.slack.com/archives/C0AAA/p1700000000000100');
});

test('isOpenTodo keeps to-dos in progress only', () => {
  assert.equal(slack.isOpenTodo(todo()), true);
  assert.equal(slack.isOpenTodo(todo({ todo_state: undefined })), true); // an older record
  assert.equal(slack.isOpenTodo(todo({ todo_state: 'saved' })), false);
  assert.equal(slack.isOpenTodo(todo({ state: 'completed' })), false);
  assert.equal(slack.isOpenTodo(todo({ state: 'archived' })), false);
  assert.equal(slack.isOpenTodo(todo({ is_archived: true })), false);
  assert.equal(slack.isOpenTodo(null), false);
});

test('sortTodos puts the soonest due date first, undated last, newest first among equals', () => {
  const ids = slack.sortTodos([
    { id: 'none-old', due: null, created: 1 }, { id: 'late', due: '2026-12-01', created: 5 },
    { id: 'none-new', due: null, created: 9 }, { id: 'soon', due: '2026-11-01', created: 2 }, { id: 'soon-new', due: '2026-11-01', created: 3 }
  ]).map((i) => i.id);
  assert.deepEqual(ids, ['soon-new', 'soon', 'late', 'none-new', 'none-old']);
});

test('fetchSlackTasks lists open to-dos with channel, text, due date and link; token in the body, cookie in the header', async () => {
  const due = Math.floor(new Date(2026, 10, 30, 12, 0).getTime() / 1000);
  const f = fakeSlack({
    'auth.test': AUTH,
    'saved.list': saved([
      todo({ date_due: due }),
      todo({ item_id: 'C0BBB', ts: '1700000005.000500', date_created: 200 }), // a thread reply
      todo({ ts: '1700000009.000900', state: 'completed' }),
      todo({ ts: '1700000010.001000', todo_state: 'saved' }),
      todo({ item_id: 'F0FILE', item_type: 'file', ts: undefined })
    ]),
    'conversations.info': (p) => ({ ok: true, channel: p.channel === 'C0AAA' ? { name: 'general' } : { is_im: true } }),
    'conversations.history': (p) => ({ ok: true, messages: p.channel === 'C0AAA' ? [{ ts: p.latest, text: 'Please <https://example.com|review> this' }] : [{ ts: '1700000000.000001', text: 'the parent' }] }),
    'conversations.replies': (p) => ({ ok: true, messages: [{ ts: p.ts, text: 'a reply', thread_ts: '1700000000.000001' }] }),
    'files.info': { ok: true, file: { title: 'Spec <draft>.pdf', permalink: 'https://example.slack.com/files/U1/F0FILE/spec.pdf' } }
  });
  const res = await slack.fetchSlackTasks({ secret: SECRET, fetchImpl: f, cache: new Map() });
  assert.equal(res.truncated, false);
  assert.equal(res.team, 'Example');
  assert.deepEqual(res.items.map((i) => [i.ref, i.title, i.due, i.url]), [
    ['#general', 'Please review this', '2026-11-30', 'https://example.slack.com/archives/C0AAA/p1700000000000100'],
    ['DM', 'a reply', null, 'https://example.slack.com/archives/C0BBB/p1700000005000500?thread_ts=1700000000.000001&cid=C0BBB'],
    ['File', 'Spec <draft>.pdf', null, // a file's title is plain text, not message markup
      'https://example.slack.com/files/U1/F0FILE/spec.pdf']
  ]);
  assert.equal(new Set(res.items.map((i) => i.id)).size, 3);
  for (const call of f.calls) {
    assert.equal(call.redirect, 'error'); // the token is never re-sent to a redirect target
    assert.equal(call.http, 'POST');
    assert.equal(call.params.token, 'xoxc-111-222-abc');
    assert.equal(call.headers.Cookie, 'd=xoxd-AbC%2Bdef%3D');
  }
});

test('fetchSlackTasks reuses message texts and channel names until a manual refresh', async () => {
  const f = fakeSlack({
    'auth.test': AUTH,
    'saved.list': saved([todo(), todo({ ts: '1700000002.000200' })]),
    'conversations.info': { ok: true, channel: { name: 'general' } },
    'conversations.history': (p) => ({ ok: true, messages: [{ ts: p.latest, text: 'hello' }] })
  });
  const cache = new Map();
  await slack.fetchSlackTasks({ secret: SECRET, fetchImpl: f, cache });
  assert.deepEqual([f.count('conversations.info'), f.count('conversations.history')], [1, 2]); // one channel, two messages
  await slack.fetchSlackTasks({ secret: SECRET, fetchImpl: f, cache });
  assert.deepEqual([f.count('conversations.info'), f.count('conversations.history'), f.count('saved.list')], [1, 2, 2]);
  await slack.fetchSlackTasks({ secret: SECRET, fetchImpl: f, cache, fresh: true });
  assert.deepEqual([f.count('conversations.info'), f.count('conversations.history')], [2, 4]); // the shared channel: once per refresh
  // Another account's cache is its own.
  await slack.fetchSlackTasks({ secret: 'xoxc-other-1 xoxd-other', fetchImpl: f, cache });
  assert.equal(f.count('conversations.history'), 6);
});

test('fetchSlackTasks keeps a to-do whose message cannot be read, but fails on errors that fail everything', async () => {
  const base = { 'auth.test': AUTH, 'saved.list': saved([todo()]), 'conversations.info': { ok: false, error: 'channel_not_found' }, 'conversations.history': { ok: false, error: 'channel_not_found' } };
  const res = await slack.fetchSlackTasks({ secret: SECRET, fetchImpl: fakeSlack(base), cache: new Map() });
  assert.deepEqual(res.items.map((i) => [i.ref, i.title, i.url]), [['', '', 'https://example.slack.com/archives/C0AAA/p1700000000000100']]);
  const code = (handlers) => slack.fetchSlackTasks({ secret: SECRET, fetchImpl: fakeSlack({ ...base, ...handlers }), cache: new Map() }).then(() => null, (err) => err.code);
  assert.equal(await code({ 'conversations.history': { ok: false, error: 'ratelimited' } }), 'rate-limit');
  assert.equal(await code({ 'conversations.info': { status: 429, body: {} } }), 'rate-limit');
  assert.equal(await code({ 'auth.test': { ok: false, error: 'invalid_auth' } }), 'auth');
  assert.equal(await code({ 'saved.list': { ok: false, error: 'unknown_method' } }), 'slack-unknown_method');
  assert.equal(await code({ 'saved.list': { ok: true } }), 'bad-response');
  assert.equal(await code({ 'auth.test': { ok: true, url: 'https://evil.example/' } }), 'bad-response');
  assert.equal(await code({ 'auth.test': { throws: Object.assign(new Error('t'), { name: 'TimeoutError' }) } }), 'timeout');
  assert.equal(await code({ 'auth.test': { throws: new Error('boom') } }), 'network');
  // The time limit running out while the body is read is a timeout too — and fails the refresh
  // rather than leaving a row without its text.
  assert.equal(await code({ 'conversations.history': { jsonThrows: Object.assign(new Error('t'), { name: 'TimeoutError' }) } }), 'timeout');
  assert.equal(await code({ 'saved.list': { jsonThrows: new SyntaxError('not json') } }), 'bad-response');
  assert.equal(await slack.fetchSlackTasks({ secret: 'no tokens here', fetchImpl: fakeSlack({}) }).then(() => null, (err) => err.code), 'slack-secret');
});

test('fetchSlackTasks follows the cursor and reports a list cut short', async () => {
  let n = 0;
  const page = (p) => {
    const start = p.cursor ? Number(p.cursor) : 0;
    const items = Array.from({ length: 50 }, (_, i) => todo({ ts: `17000${String(start + i).padStart(5, '0')}.000100` }));
    n++;
    return saved(items, String(start + 50)); // always another page
  };
  const f = fakeSlack({
    'auth.test': AUTH, 'saved.list': page,
    'conversations.info': { ok: true, channel: { name: 'general' } },
    'conversations.history': (p) => ({ ok: true, messages: [{ ts: p.latest, text: 't' }] })
  });
  const res = await slack.fetchSlackTasks({ secret: SECRET, fetchImpl: f, cache: new Map() });
  assert.equal(n, slack.SAVED_PAGES_MAX);
  assert.equal(res.items.length, slack.ITEMS_MAX);
  assert.equal(res.truncated, true);
  assert.deepEqual(f.calls.filter((c) => c.method === 'saved.list').map((c) => c.params.cursor).slice(0, 4), [undefined, '50', '100', '150']);
});

test('fetchSlackTasks cuts the far end of the list (latest due), and lists a record returned twice once', async () => {
  const day = (n) => Math.floor(new Date(2027, 0, 1 + n, 12, 0).getTime() / 1000);
  // 120 to-dos, returned latest-due first, each also returned a second time.
  const all = Array.from({ length: 120 }, (_, i) => todo({ ts: `17000${String(i).padStart(5, '0')}.000100`, date_due: day(120 - i) }));
  const pages = [all.slice(0, 50), all.slice(50, 100), [...all.slice(100), ...all.slice(0, 30)]];
  const f = fakeSlack({
    'auth.test': AUTH,
    'saved.list': (p) => { const n = p.cursor ? Number(p.cursor) : 0; return saved(pages[n], n < 2 ? String(n + 1) : ''); },
    'conversations.info': { ok: true, channel: { name: 'general' } },
    'conversations.history': (p) => ({ ok: true, messages: [{ ts: p.latest, text: 't' }] })
  });
  const res = await slack.fetchSlackTasks({ secret: SECRET, fetchImpl: f, cache: new Map() });
  assert.equal(res.items.length, 100);
  assert.equal(res.truncated, true);
  assert.equal(new Set(res.items.map((i) => i.id)).size, 100);
  assert.equal(res.items[0].due, slack.dueDate(day(1)));   // the soonest is kept…
  assert.equal(res.items[99].due, slack.dueDate(day(100))); // …and the 20 latest are what is cut
  assert.equal(f.count('conversations.history'), 100);      // nothing is looked up for the cut ones
});

test('the cache keeps only the most recently used accounts', async () => {
  const f = fakeSlack({
    'auth.test': AUTH, 'saved.list': saved([todo()]),
    'conversations.info': { ok: true, channel: { name: 'general' } },
    'conversations.history': (p) => ({ ok: true, messages: [{ ts: p.latest, text: 't' }] })
  });
  const cache = new Map();
  for (let i = 0; i < 7; i++) await slack.fetchSlackTasks({ secret: `xoxc-acct-${i} xoxd-c`, fetchImpl: f, cache });
  assert.equal(cache.size, 4);
  const before = f.count('conversations.history');
  await slack.fetchSlackTasks({ secret: 'xoxc-acct-6 xoxd-c', fetchImpl: f, cache }); // still cached
  assert.equal(f.count('conversations.history'), before);
  await slack.fetchSlackTasks({ secret: 'xoxc-acct-0 xoxd-c', fetchImpl: f, cache }); // long gone
  assert.equal(f.count('conversations.history'), before + 1);
});

test('fetchSlackTasks with channels picked shows their messages, and always what is outside channels', async () => {
  const f = fakeSlack({
    'auth.test': AUTH,
    'saved.list': saved([
      todo({ item_id: 'C0PICK', ts: '1700000001.000100', date_created: 9 }),
      todo({ item_id: 'C0OTHER', ts: '1700000002.000100', date_created: 8 }),
      todo({ item_id: 'C0OTHER', ts: '1700000003.000100', date_created: 7 }),
      todo({ item_id: 'D0DM', ts: '1700000004.000100', date_created: 6 }),
      todo({ item_id: 'G0MPIM', ts: '1700000005.000100', date_created: 5 }),
      todo({ item_id: 'C0GONE', ts: '1700000006.000100', date_created: 4 }),
      todo({ item_id: 'F0FILE', item_type: 'file', ts: undefined, date_created: 3 })
    ]),
    'conversations.info': (p) => {
      if (p.channel === 'C0GONE') return { ok: false, error: 'channel_not_found' };
      return { ok: true, channel: p.channel === 'D0DM' ? { is_im: true } : p.channel === 'G0MPIM' ? { is_mpim: true, name: 'mpdm-a--b-1' } : { name: p.channel.toLowerCase() } };
    },
    'conversations.history': (p) => ({ ok: true, messages: [{ ts: p.latest, text: `in ${p.channel}` }] }),
    'users.conversations': { ok: true, channels: [{ id: 'G0MPIM', is_mpim: true }], response_metadata: { next_cursor: '' } },
    'files.info': { ok: true, file: { title: 'Spec.pdf' } }
  });
  const cache = new Map();
  const res = await slack.fetchSlackTasks({ secret: SECRET, channels: ['C0PICK'], fetchImpl: f, cache });
  assert.deepEqual(res.items.map((i) => [i.ref, i.title]), [['#c0pick', 'in C0PICK'], ['DM', 'in D0DM'], ['Group DM', 'in G0MPIM'], ['File', 'Spec.pdf']]);
  // Nothing is asked about the channels left out (nor about one that is gone): group DMs are known
  // from the user's own list of them, read once and reused by the next refresh.
  assert.deepEqual(f.calls.filter((c) => c.method === 'conversations.history').map((c) => c.params.channel), ['C0PICK', 'D0DM', 'G0MPIM']);
  assert.deepEqual(f.calls.filter((c) => c.method === 'conversations.info').map((c) => c.params.channel), ['C0PICK', 'D0DM', 'G0MPIM']);
  assert.deepEqual(f.calls.filter((c) => c.method === 'users.conversations').map((c) => c.params.types), ['mpim']);
  await slack.fetchSlackTasks({ secret: SECRET, channels: ['C0PICK'], fetchImpl: f, cache });
  assert.equal(f.count('users.conversations'), 1);
  // No channels picked: everything, as before.
  const all = await slack.fetchSlackTasks({ secret: SECRET, channels: [], fetchImpl: f, cache: new Map() });
  assert.equal(all.items.length, 7);
});

test('the channel filter applies before the cap', async () => {
  const picked = Array.from({ length: 3 }, (_, i) => todo({ item_id: 'C0PICK', ts: `17100${String(i).padStart(5, '0')}.000100` }));
  const noise = Array.from({ length: 47 }, (_, i) => todo({ item_id: 'C0NOISE', ts: `17000${String(i).padStart(5, '0')}.000100` }));
  const f = fakeSlack({
    'auth.test': AUTH,
    'saved.list': (p) => saved(p.cursor === '3' ? picked : noise, p.cursor === '3' ? '' : String(Number(p.cursor || 0) + 1)), // 141 others, then the 3
    'users.conversations': { ok: true, channels: [], response_metadata: { next_cursor: '' } },
    'conversations.info': (p) => ({ ok: true, channel: { name: p.channel.toLowerCase() } }),
    'conversations.history': (p) => ({ ok: true, messages: [{ ts: p.latest, text: 't' }] })
  });
  const res = await slack.fetchSlackTasks({ secret: SECRET, channels: ['C0PICK'], fetchImpl: f, cache: new Map() });
  assert.equal(res.items.length, 3);
  assert.equal(res.truncated, false);
  assert.equal(f.count('conversations.info'), 1); // the picked channel only
  // A list of group DMs that can't be read fails the refresh rather than hiding them silently.
  // ...and it is read only when some message needs it: picked channels, DMs and files don't.
  const handlers = { 'auth.test': AUTH, 'users.conversations': { ok: false, error: 'missing_scope' },
    'conversations.info': { ok: true, channel: { name: 'x' } }, 'conversations.history': (p) => ({ ok: true, messages: [{ ts: p.latest, text: 't' }] }), 'files.info': { ok: true, file: { title: 'f' } } };
  const clear = fakeSlack({ ...handlers, 'saved.list': saved([...picked, todo({ item_id: 'D0DM' }), todo({ item_id: 'F0FILE', item_type: 'file', ts: undefined })]) });
  assert.equal((await slack.fetchSlackTasks({ secret: SECRET, channels: ['C0PICK'], fetchImpl: clear, cache: new Map() })).items.length, 5);
  assert.equal(clear.count('users.conversations'), 0);
  const bad = fakeSlack({ ...handlers, 'saved.list': saved([...picked, todo({ item_id: 'C0MAYBE' })]) });
  assert.equal(await slack.fetchSlackTasks({ secret: SECRET, channels: ['C0PICK'], fetchImpl: bad, cache: new Map() }).then(() => null, (e) => e.code), 'slack-missing_scope');
});

test('fetchSlackChannels lists the channels the user is in, by name, across pages', async () => {
  const f = fakeSlack({
    'users.conversations': (p) => (p.cursor
      ? { ok: true, channels: [{ id: 'C0BBB', name: 'alpha' }, { id: 'C0ARCH', name: 'old', is_archived: true }, { id: 'bad id', name: 'x' }, { id: 'G0MPIM', name: 'mpdm-a--b-1', is_mpim: true }], response_metadata: { next_cursor: '' } }
      : { ok: true, channels: [{ id: 'C0AAA', name: 'zeta' }, { id: 'G0PRIV', name: 'private-one', is_private: true }], response_metadata: { next_cursor: 'next' } })
  });
  const res = await slack.fetchSlackChannels({ secret: SECRET, fetchImpl: f });
  assert.deepEqual(res, { channels: [{ id: 'C0BBB', name: 'alpha' }, { id: 'G0PRIV', name: 'private-one' }, { id: 'C0AAA', name: 'zeta' }], truncated: false });
  assert.equal(f.calls[0].params.types, 'public_channel,private_channel');
  assert.equal(f.calls[0].params.exclude_archived, 'true');
  assert.deepEqual(f.calls.map((c) => c.params.cursor), [undefined, 'next']);
  const err = await slack.fetchSlackChannels({ secret: SECRET, fetchImpl: fakeSlack({ 'users.conversations': { ok: false, error: 'invalid_auth' } }) }).then(() => null, (e) => e.code);
  assert.equal(err, 'auth');
});
