const test = require('node:test');
const assert = require('node:assert/strict');
const nc = require('../src/notification-center');
const { pushNotification } = require('../src/notification-log');

const slack = { type: 'notification', event: 'added', id: 481, app: 'Slack', appId: 'com.squirrel.slack.slack', title: 'AWS Security', body: 'Security Hub Finding\nap-northeast-1', timestamp: 1787922630000 };

test('normalizeSystemNotification: bridge message → SystemNotification', () => {
  assert.deepEqual(nc.normalizeSystemNotification(slack), {
    source: 'windows', event: 'added', windowsNotificationId: 481,
    app: { name: 'Slack', id: 'com.squirrel.slack.slack' },
    title: 'AWS Security', body: 'Security Hub Finding\nap-northeast-1', timestamp: 1787922630000
  });
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
