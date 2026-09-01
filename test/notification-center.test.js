const test = require('node:test');
const assert = require('node:assert/strict');
const nc = require('../src/notification-center');
const { pushNotification } = require('../src/notification-log');

const slack = { type: 'notification', event: 'added', id: 481, app: 'Slack', appId: 'com.squirrel.slack.slack', title: 'AWS Security', body: 'Security Hub Finding\nap-northeast-1', timestamp: 1787922630000 };

test('normalizeSystemNotification: bridge message → SystemNotification', () => {
  assert.deepEqual(nc.normalizeSystemNotification(slack), {
    source: 'windows', event: 'added', windowsNotificationId: 481,
    app: { name: 'Slack', id: 'com.squirrel.slack.slack' },
    title: 'AWS Security', body: 'Security Hub Finding\nap-northeast-1', timestamp: 1787922630000,
    link: '', workspace: '', slack: null
  });
});

// Real Slack toast XML shape from wpndatabase.db (ids anonymized).
const slackXml = '<toast activationType="protocol" launch="slack://channel?id=C013RL7GN8H&amp;message=1788256300.509419&amp;team=T02J67MRB&amp;thread_ts=1788256035.112399&amp;origin=notification">'
  + '<header id="T02J67MRB" title="Ubiregi &amp; Co." activationType="protocol" arguments="slack://channel?team=T02J67MRB"></header>'
  + '<visual><binding template="ToastGeneric"><text hint-wrap="false" hint-maxLines="1">#to-team-dev</text>'
  + '<text hint-maxLines="10" hint-style="bodySubtle" hint-wrap="true">mai: help?</text></binding></visual><audio silent="true"/></toast>';

test('parseToastPayload: launch URI and header out of the raw toast XML, entities decoded', () => {
  assert.deepEqual(nc.parseToastPayload(slackXml), {
    launch: 'slack://channel?id=C013RL7GN8H&message=1788256300.509419&team=T02J67MRB&thread_ts=1788256035.112399&origin=notification',
    headerId: 'T02J67MRB',
    headerTitle: 'Ubiregi & Co.'
  });
  assert.deepEqual(nc.parseToastPayload(''), { launch: '', headerId: '', headerTitle: '' });
  assert.deepEqual(nc.parseToastPayload('<toast><visual/></toast>'), { launch: '', headerId: '', headerTitle: '' });
  // numeric entities decode too; a huge codepoint is left alone instead of throwing
  assert.equal(nc.parseToastPayload('<toast launch="a&#65;b&#x42;c&#1114112;"/>').launch, 'aAbBc&#1114112;');
});

test('parseSlackLaunch: slack:// URI → structured ids; other links → null', () => {
  assert.deepEqual(nc.parseSlackLaunch('slack://channel?id=C1&message=2.3&team=T9&thread_ts=4.5'),
    { teamId: 'T9', channelId: 'C1', messageTs: '2.3', threadTs: '4.5' });
  assert.deepEqual(nc.parseSlackLaunch('slack://channel?id=C1&team=T9'),
    { teamId: 'T9', channelId: 'C1', messageTs: '', threadTs: '' });
  assert.equal(nc.parseSlackLaunch('slack://open'), null);
  assert.equal(nc.parseSlackLaunch('ms-teams://l/message/x'), null);
  assert.equal(nc.parseSlackLaunch(''), null);
});

test('normalizeSystemNotification: payload XML → link / workspace / slack; passthrough on re-normalize', () => {
  const n = nc.normalizeSystemNotification({ ...slack, payload: slackXml });
  assert.equal(n.link.startsWith('slack://channel?id=C013RL7GN8H'), true);
  assert.equal(n.workspace, 'Ubiregi & Co.');
  assert.deepEqual(n.slack, { teamId: 'T02J67MRB', channelId: 'C013RL7GN8H', messageTs: '1788256300.509419', threadTs: '1788256035.112399' });
  // renderer re-normalizes main's broadcast: enriched fields survive without the raw payload
  const again = nc.normalizeSystemNotification({ type: 'notification', event: n.event, id: n.windowsNotificationId,
    app: n.app.name, appId: n.app.id, title: n.title, body: n.body, timestamp: n.timestamp,
    link: n.link, workspace: n.workspace, slack: n.slack });
  assert.deepEqual(again, n);
  // history entry carries the enrichment
  const entry = nc.toHistoryEntry(n);
  assert.equal(entry.workspace, 'Ubiregi & Co.');
  assert.equal(entry.link, n.link);
  assert.deepEqual(entry.slack, n.slack);
});

test('normalizeSystemNotification: rejects non-notifications, unknown events and bad ids', () => {
  assert.equal(nc.normalizeSystemNotification(null), null);
  assert.equal(nc.normalizeSystemNotification({ type: 'status', status: 'ready' }), null);
  assert.equal(nc.normalizeSystemNotification({ ...slack, event: 'exploded' }), null);
  assert.equal(nc.normalizeSystemNotification({ ...slack, id: 'abc' }), null);
  const removed = nc.normalizeSystemNotification({ type: 'notification', event: 'removed', id: 7 });
  assert.equal(removed.event, 'removed');
  assert.equal(removed.app.name, '');
  assert.ok(removed.timestamp > 0); // missing timestamp → now
});

test('detectCategory: keyword buckets', () => {
  assert.equal(nc.detectCategory('Slack'), 'communication');
  assert.equal(nc.detectCategory('Microsoft Teams'), 'communication');
  assert.equal(nc.detectCategory('Windows Security'), 'security');
  assert.equal(nc.detectCategory('Windows Update'), 'system');
  assert.equal(nc.detectCategory('Google Chrome'), 'other');
  assert.equal(nc.detectCategory(''), 'other');
});

test('toHistoryEntry + hasEntry: dedupe by windows id, terminal entries untouched', () => {
  const n = nc.normalizeSystemNotification(slack);
  const entry = nc.toHistoryEntry(n);
  assert.equal(entry.source, 'windows');
  assert.equal(entry.category, 'communication');
  assert.equal(entry.read, false);
  assert.deepEqual(entry.windows, { notificationId: 481, event: 'added', active: true });
  let list = pushNotification([], { source: 'terminal', paneId: 1, label: 'claude' });
  assert.equal(nc.hasEntry(list, n), false);
  list = pushNotification(list, entry);
  assert.equal(nc.hasEntry(list, n), true);
  assert.equal(nc.hasEntry(list, nc.normalizeSystemNotification({ ...slack, id: 482 })), false);
  assert.equal(nc.hasEntry(list, { source: 'terminal' }), false);
  assert.equal(nc.dedupeKey(n), 'windows:481');
});

test('bodyPreview / appInitial', () => {
  assert.equal(nc.bodyPreview('  a\n\n b   c '), 'a b c');
  assert.equal(nc.bodyPreview('x'.repeat(200)).length, 120);
  assert.ok(nc.bodyPreview('x'.repeat(200)).endsWith('…'));
  assert.equal(nc.appInitial('slack'), 'S');
  assert.equal(nc.appInitial(''), '?');
});

test('askPrompt: verbatim notification under a lead line', () => {
  const entry = nc.toHistoryEntry(nc.normalizeSystemNotification(slack));
  assert.equal(nc.askPrompt(entry, { lead: 'Look:' }),
    'Look:\n\nApp: Slack\nTitle: AWS Security\n\nSecurity Hub Finding\nap-northeast-1');
  const bare = nc.toHistoryEntry(nc.normalizeSystemNotification({ ...slack, title: '', body: '' }));
  assert.equal(nc.askPrompt(bare, { lead: 'L' }), 'L\n\nApp: Slack');
});

test('askPrompt: workspace and deep link lines when the toast payload provided them', () => {
  const entry = nc.toHistoryEntry(nc.normalizeSystemNotification({ ...slack, payload: slackXml }));
  const prompt = nc.askPrompt(entry, { lead: 'L' });
  assert.ok(prompt.includes('Workspace: Ubiregi & Co.\n'));
  assert.ok(prompt.includes('Link: slack://channel?id=C013RL7GN8H'));
  assert.ok(prompt.indexOf('App: Slack') < prompt.indexOf('Workspace:'));
});

test('exclusions: normalize, dedupe, bound', () => {
  assert.equal(nc.normalizeExclusionRule(null), null);
  assert.equal(nc.normalizeExclusionRule({ app: '  ', title: '' }), null);
  assert.deepEqual(nc.normalizeExclusionRule({ app: ' Slack ', junk: 1 }), { app: 'Slack', workspace: '', title: '' });
  assert.deepEqual(nc.normalizeExclusions([{ app: 'Slack' }, { app: 'slack' }, null, 'x', { workspace: 'Ubiregi' }]),
    [{ app: 'Slack', workspace: '', title: '' }, { workspace: 'Ubiregi', app: '', title: '' }]);
  assert.equal(nc.normalizeExclusions(Array.from({ length: 500 }, (_, i) => ({ app: `a${i}` }))).length, nc.MAX_EXCLUSIONS);
  assert.deepEqual(nc.normalizeExclusions('nope'), []);
});

test('sameExclusionRule: three-field case-insensitive identity; invalid rules equal nothing', () => {
  assert.equal(nc.sameExclusionRule({ app: 'Slack', title: '#Dev' }, { app: ' slack ', workspace: '', title: '#dev' }), true);
  assert.equal(nc.sameExclusionRule({ app: 'Slack' }, { app: 'Slack', title: '#dev' }), false);
  assert.equal(nc.sameExclusionRule({ app: 'Slack' }, { app: 'Slac' }), false); // identity, not substring
  assert.equal(nc.sameExclusionRule({}, {}), false);
  assert.equal(nc.sameExclusionRule({ app: 'Slack' }, null), false);
});

test('exclusions: every non-empty rule field must match, case-insensitive substring', () => {
  const flat = { app: 'Slack', workspace: 'Ubiregi & Co.', title: '#to-team-dev' };
  assert.equal(nc.matchesExclusion(flat, { app: 'slack' }), true);
  assert.equal(nc.matchesExclusion(flat, { app: 'Slack', workspace: 'ubiregi' }), true);
  assert.equal(nc.matchesExclusion(flat, { app: 'Slack', workspace: 'Ubiregi & Co.', title: 'to-team' }), true);
  assert.equal(nc.matchesExclusion(flat, { app: 'Teams' }), false);
  assert.equal(nc.matchesExclusion(flat, { app: 'Slack', title: '#general' }), false);
  assert.equal(nc.matchesExclusion(flat, {}), false); // empty rule matches nothing
  assert.equal(nc.matchesExclusion({}, { app: 'Slack' }), false);
  assert.equal(nc.isExcluded(flat, [{ app: 'Teams' }, { title: 'team-dev' }]), true);
  assert.equal(nc.isExcluded(flat, []), false);
  assert.equal(nc.isExcluded(flat, null), false);
});

test('routes: normalize requires ids + workspace + paneId; one route per channel; bounded', () => {
  const full = { teamId: 'T1', channelId: 'C1', workspace: 'Ubuntu:/home/x', paneId: 'uuid-1', pane: 'oncall', autoSend: true, workspaceName: 'Acme', channelName: '#alerts' };
  assert.deepEqual(nc.normalizeRoute({ ...full, junk: 1 }), full);
  assert.equal(nc.normalizeRoute({ ...full, paneId: ' ' }), null);
  assert.equal(nc.normalizeRoute({ ...full, channelId: '' }), null);
  assert.equal(nc.normalizeRoute(null), null);
  assert.equal(nc.normalizeRoute({ ...full, pane: '' }).pane, ''); // display label is optional
  assert.equal(nc.normalizeRoute({ ...full, autoSend: 'yes' }).autoSend, false); // strict boolean opt-in
  const dup = nc.normalizeRoutes([full, { ...full, paneId: 'uuid-2' }, { ...full, channelId: 'C2' }]);
  assert.equal(dup.length, 2);
  assert.equal(dup[0].paneId, 'uuid-1'); // first route for a channel wins
  assert.equal(nc.normalizeRoutes(Array.from({ length: 300 }, (_, i) => ({ ...full, channelId: `C${i}` }))).length, nc.MAX_ROUTES);
  assert.equal(nc.routeChannelKey(full), 'T1:C1');
});

test('routes: findRoute matches exact team+channel; autoAskAllowed throttles per interval', () => {
  const routes = nc.normalizeRoutes([{ teamId: 'T1', channelId: 'C1', workspace: 'w', paneId: 'p' }]);
  assert.equal(nc.findRoute(routes, { teamId: 'T1', channelId: 'C1' }), routes[0]);
  assert.equal(nc.findRoute(routes, { teamId: 'T1', channelId: 'C2' }), null);
  assert.equal(nc.findRoute(routes, { teamId: '', channelId: 'C1' }), null);
  assert.equal(nc.findRoute(routes, null), null);
  assert.equal(nc.autoAskAllowed(undefined, 1000), true);
  assert.equal(nc.autoAskAllowed(1000, 1000 + nc.AUTO_ASK_INTERVAL_MS - 1), false);
  assert.equal(nc.autoAskAllowed(1000, 1000 + nc.AUTO_ASK_INTERVAL_MS), true);
  assert.equal(nc.workspaceKey('Ubuntu', '/home/x'), 'Ubuntu:/home/x');
});

test('sanitizeForPaste: strips control chars; newlines only under bracketed paste', () => {
  const raw = 'a\x1b]9;x\x07b\r\nc\td\u0085e';
  assert.equal(nc.sanitizeForPaste(raw, { multiline: true }), 'a]9;xb\nc\tde');
  assert.equal(nc.sanitizeForPaste(raw), 'a]9;xb c de');
  assert.equal(nc.sanitizeForPaste('rm -rf /\n\n\necho hi\n'), 'rm -rf / echo hi');
  assert.equal(nc.sanitizeForPaste(null), '');
});

test('missingFromSnapshot: active buffered ids absent from a fresh snapshot', () => {
  const buf = [
    { source: 'windows', event: 'added', windowsNotificationId: 1 },
    { source: 'windows', event: 'removed', windowsNotificationId: 2 },
    { source: 'windows', event: 'existing', windowsNotificationId: 3 },
    { source: 'terminal' }
  ];
  assert.deepEqual(nc.missingFromSnapshot(buf, new Set([3])), [1]);
  assert.deepEqual(nc.missingFromSnapshot(buf, [1, 3]), []);
  assert.deepEqual(nc.missingFromSnapshot(null, new Set()), []);
});
