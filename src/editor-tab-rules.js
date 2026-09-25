// Pure rules for VS Code-style preview tabs in the editor (issue #87). No DOM here so the rules
// are unit-testable; renderer.js owns the tab elements and applies the plan.
//
// A single click in the file tree opens the file in a *preview* tab (italic label). There is at
// most one preview tab: the next single-click on another file reuses it (the previous preview file
// closes, the new one takes its slot). A double-click on a tree file, a double-click on the tab, or
// an edit in the buffer *keeps* the tab (promotes it to a normal, permanent tab).
(function () {
  // Decide how opening `path` lands in the strip. `tabs` is the current strip order, each
  // { path, preview, dirty }. `preview` is how the user asked for it (single click = true).
  //   activate: already open (as is)            promote: already open as preview, asked to keep
  //   replace:  take over the preview tab at replacePath   append: add a new tab at the end
  function planOpen(tabs, path, { preview = false } = {}) {
    const list = Array.isArray(tabs) ? tabs : [];
    const existing = list.find((t) => t && t.path === path);
    if (existing) return { action: existing.preview && !preview ? 'promote' : 'activate' };
    // A dirty preview tab is never replaced (edits promote it, but guard the invariant anyway).
    const slot = preview ? list.find((t) => t && t.preview && !t.dirty) : null;
    return slot ? { action: 'replace', replacePath: slot.path } : { action: 'append' };
  }

  // Ordered tab list with `oldPath` swapped for `next` in place (the strip keeps its order, so the
  // replaced preview tab's neighbours don't move). Returns a new array.
  function replaceInOrder(entries, oldPath, next) {
    const list = Array.isArray(entries) ? entries : [];
    return list.map((e) => (e && e.path === oldPath ? next : e));
  }

  const editorTabRules = { planOpen, replaceInOrder };
  if (typeof module !== 'undefined' && module.exports) module.exports = editorTabRules;
  if (typeof window !== 'undefined') window.editorTabRules = editorTabRules;
})();
