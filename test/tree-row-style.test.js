const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The tree row is a flexbox: [twisty][icon][name]. The two gutter cells must not shrink — otherwise
// narrowing the tree pane compresses them only on the rows whose names overflow, so rows at the same
// depth end up with different gutter widths and their names stop lining up.
const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'style.css'), 'utf8');

function ruleBody(selector) {
  const re = new RegExp(`(^|\\n)\\s*${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`);
  const m = css.match(re);
  assert.ok(m, `style.css should define a ${selector} rule`);
  return m[2];
}

test('tree row gutter cells are fixed-size (flex:none) so rows stay aligned when the pane narrows', () => {
  for (const selector of ['.twisty', '.icon']) {
    const body = ruleBody(selector);
    assert.match(body, /flex:\s*none/, `${selector} must set flex:none`);
    assert.match(body, /width:\s*\d/, `${selector} must keep an explicit width`);
  }
});

test('tree row name is the only shrinkable cell and ellipsizes', () => {
  const body = ruleBody('.name');
  assert.doesNotMatch(body, /flex:\s*none/, '.name must stay shrinkable');
  assert.match(body, /min-width:\s*0/, '.name needs min-width:0 to shrink below its content');
  assert.match(body, /overflow:\s*hidden/);
  assert.match(body, /text-overflow:\s*ellipsis/);
});

test('tree row stays a single-line flex container', () => {
  const body = ruleBody('.row');
  assert.match(body, /display:\s*flex/);
  assert.match(body, /white-space:\s*nowrap/);
});
