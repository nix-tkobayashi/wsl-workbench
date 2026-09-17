const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'style.css'), 'utf8');

function ruleBody(selector) {
  const re = new RegExp(`(^|\\n)${selector.replace(/[.#]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const m = css.match(re);
  assert.ok(m, `style.css should define a ${selector} rule`);
  return m[2];
}

// The line-number gutter overlays the textarea's left edge. Chromium reveals a moved caret only up
// to the scrollport edge, so without scroll-padding Home leaves the line start hidden under the
// gutter (issue #83). The value must match the gutter-derived padding-left (renderGutter keeps the
// inline style in step; the stylesheet default equals the initial 52px padding).
test('#editor reserves scroll-padding-left for the gutter overlay (#83)', () => {
  const body = ruleBody('#editor');
  const m = body.match(/scroll-padding-left:\s*(\d+)px/);
  assert.ok(m, '#editor must set scroll-padding-left');
  const shared = ruleBody('#editor, #editorBackdrop');
  const pad = shared.match(/padding:\s*\d+px \d+px \d+px (\d+)px/);
  assert.ok(pad, 'shared editor rule must set a 4-value padding');
  assert.equal(m[1], pad[1], 'scroll-padding-left must equal the default padding-left');
});

// Find-in-preview paints matches with the CSS Custom Highlight API (issue #82).
test('preview find highlights are styled', () => {
  assert.match(css, /::highlight\(preview-find\)\s*\{[^}]*background/);
  assert.match(css, /::highlight\(preview-find-current\)\s*\{[^}]*background/);
});

// The renderer decides whether one more terminal pane fits from PANE_MIN_WIDTH / DIVIDER_WIDTH
// (issue #84); those constants must mirror the stylesheet, or the last pane gets clipped.
test('terminal split metrics in renderer.js match style.css', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const paneMin = js.match(/const PANE_MIN_WIDTH = (\d+)/);
  const divider = js.match(/const DIVIDER_WIDTH = (\d+)/);
  assert.ok(paneMin && divider, 'renderer.js must define PANE_MIN_WIDTH and DIVIDER_WIDTH');
  assert.match(ruleBody('.term-pane'), new RegExp(`min-width:\\s*${paneMin[1]}px`));
  assert.match(ruleBody('.term-divider'), new RegExp(`flex:\\s*0 0 ${divider[1]}px`));
});
