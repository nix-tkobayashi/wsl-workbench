const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const i18n = require('../src/i18n');

test('exposes both supported languages', () => {
  assert.deepEqual(i18n.SUPPORTED_LANGS, ['en', 'ja']);
  assert.ok(i18n.translations.en);
  assert.ok(i18n.translations.ja);
});

test('en and ja have identical key sets (no missing translations)', () => {
  const en = Object.keys(i18n.translations.en).sort();
  const ja = Object.keys(i18n.translations.ja).sort();
  assert.deepEqual(ja, en);
});

test('t() returns the requested language', () => {
  assert.equal(i18n.t('ja', 'ctx.newFile'), '新規ファイル');
  assert.equal(i18n.t('en', 'ctx.newFile'), 'New File');
});

test('t() falls back to English then to the raw key', () => {
  // unknown lang -> English
  assert.equal(i18n.t('fr', 'ctx.newFile'), 'New File');
  // unknown key -> the key itself
  assert.equal(i18n.t('en', 'does.not.exist'), 'does.not.exist');
});

test('normalizeLang clamps to a supported language', () => {
  assert.equal(i18n.normalizeLang('ja'), 'ja');
  assert.equal(i18n.normalizeLang('en'), 'en');
  assert.equal(i18n.normalizeLang('xx'), 'en');
  assert.equal(i18n.normalizeLang(undefined), 'en');
});

// Regression for the bug where i18n.js declared a top-level `const api`, which collided in the
// renderer with the non-configurable `window.api` exposed by the preload (SyntaxError, broke i18n).
// The file must keep itself fully scoped (IIFE) and define no top-level `api`.
test('i18n.js is self-scoped and declares no top-level `api` (renderer collision guard)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n.js'), 'utf8');
  const firstCode = src.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('//'));
  assert.ok(firstCode.startsWith('(function'), 'i18n.js should be wrapped in an IIFE');
  assert.ok(!/(^|\n)\s*(const|let|var)\s+api\b/.test(src), 'i18n.js must not declare a top-level `api`');
});

// Loading the source as a classic script must set window.i18n even when a non-configurable global
// `api` (like contextBridge's) already exists, without throwing.
test('i18n.js sets window.i18n when a non-configurable global `api` is present', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n.js'), 'utf8');
  const sandbox = { window: {}, module: undefined };
  vm.createContext(sandbox);
  Object.defineProperty(sandbox, 'api', { value: { bridge: true }, configurable: false, writable: false });
  assert.doesNotThrow(() => vm.runInContext(src, sandbox, { filename: 'i18n.js' }));
  assert.ok(sandbox.window.i18n, 'window.i18n should be defined');
  assert.equal(sandbox.window.i18n.t('ja', 'ctx.rename'), '名前を変更');
});
