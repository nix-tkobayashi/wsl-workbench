const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isWorkspaceFile, findWorkspaceArg, WORKSPACE_EXT } = require('../src/workspace-args');

// Real files on disk: isWorkspaceFile requires an existing regular file, not just the extension.
let dir;
let wsFile;
let jsonFile;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wslwb-args-'));
  wsFile = path.join(dir, `proj.${WORKSPACE_EXT}`);
  jsonFile = path.join(dir, 'proj.json');
  fs.writeFileSync(wsFile, '{}');
  fs.writeFileSync(jsonFile, '{}');
  fs.mkdirSync(path.join(dir, `folder.${WORKSPACE_EXT}`)); // extension-named directory: not a file
});
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('finds the workspace file among second-instance style argv noise', () => {
  const argv = ['C:\\app\\WSL Workbench.exe', '--allow-file-access-from-files', '--original-process-start-time=123', wsFile];
  assert.equal(findWorkspaceArg(argv), wsFile);
});

test('accepts .json workspace files too', () => {
  assert.equal(findWorkspaceArg(['exe', jsonFile]), jsonFile);
});

test('ignores extension-matching paths that do not exist', () => {
  assert.equal(findWorkspaceArg(['exe', path.join(dir, `missing.${WORKSPACE_EXT}`)]), undefined);
});

test('ignores a directory whose name matches the extension', () => {
  assert.equal(findWorkspaceArg(['exe', path.join(dir, `folder.${WORKSPACE_EXT}`)]), undefined);
});

test('returns undefined for plain launches (switches and exe only)', () => {
  assert.equal(findWorkspaceArg(['C:\\app\\WSL Workbench.exe', '--no-sandbox']), undefined);
});

test('isWorkspaceFile rejects empty/other extensions', () => {
  assert.equal(isWorkspaceFile(''), false);
  assert.equal(isWorkspaceFile(null), false);
  const txt = path.join(dir, 'a.txt');
  fs.writeFileSync(txt, 'x');
  assert.equal(isWorkspaceFile(txt), false);
});
