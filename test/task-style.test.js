const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'style.css'), 'utf8');

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `style.css should define a ${selector} rule`);
  return m[2];
}

// Issue #129: every select/input in the task settings dialog is width:100%, so in the Backlog
// space row ([space name][domain]) the domain list took the whole row and the name field shrank
// to nothing. The first cell takes the free space; the others keep their own width.
test('task settings row: the first field takes the free space, the rest keep their own width', () => {
  const first = ruleBody('.task-row > :first-child');
  assert.match(first, /flex:\s*1/);
  assert.match(first, /min-width:\s*0/);
  const rest = ruleBody('.task-row > :not(:first-child)');
  assert.match(rest, /flex:\s*0 0 auto/);
  assert.match(rest, /width:\s*auto/, 'must override the dialog-wide width:100%');
  // ...and that override must come after the width:100% rule it has to beat on equal terms.
  assert.ok(css.indexOf('.task-row > :not(:first-child)') > css.indexOf('.task-modal-box select, .task-modal-box input[type="text"]'));
});

// Issue #130: a task row is [task (shrinks, opens the browser)][→ (fixed, types the URL)].
test('task list row keeps the insert button visible beside a shrinkable task', () => {
  assert.match(ruleBody('.task-item-row'), /display:\s*flex/);
  const item = ruleBody('.task-item');
  assert.match(item, /flex:\s*1 1 auto/);
  assert.match(item, /min-width:\s*0/);
  assert.match(ruleBody('.task-btn'), /flex:\s*0 0 auto/);
});
