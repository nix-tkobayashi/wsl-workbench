// Pure rules for multi-selection in the file tree (issue #93). No DOM here so the rules are
// unit-testable; renderer.js owns the rows and applies the results.
//
// Ctrl+click toggles a row in the selection, Shift+click selects the visible range from the anchor,
// and a plain click resets the selection to the clicked row. Delete / drag-move / terminal drop /
// Copy Path then act on every selected item.
(function () {
  function isUnder(p, dir) {
    return p === dir || p.startsWith(dir === '/' ? '/' : dir + '/');
  }

  function parentOf(p) {
    return p.split('/').slice(0, -1).join('/') || '/';
  }

  // Selection after Shift+click: every visible row from `anchor` to `target` inclusive, in tree
  // order (`ordered` is the visible rows top to bottom). Without a usable anchor, just the target.
  function range(ordered, anchor, target) {
    const list = Array.isArray(ordered) ? ordered : [];
    const end = list.indexOf(target);
    if (end < 0) return [];
    const start = list.indexOf(anchor);
    if (start < 0) return [target];
    return list.slice(Math.min(start, end), Math.max(start, end) + 1);
  }

  // Drop paths that sit inside another selected directory: deleting or moving the parent already
  // takes them along, and acting on them again would fail ("not found") after the parent is gone.
  // Order is kept; duplicates collapse.
  function topLevel(paths) {
    const list = [...new Set(Array.isArray(paths) ? paths : [])];
    return list.filter((p) => !list.some((other) => other !== p && isUnder(p, other)));
  }

  // Plan moving the selected `paths` into `targetDir`. Returns
  //   moves: [{ source, dest }] to perform, in order
  //   invalid: directories that cannot go there because the target is inside them
  // Items already directly in targetDir, and a drop onto the dragged item itself, are skipped
  // silently (both are no-ops, as with a single-item drag).
  function planMove(paths, targetDir) {
    const moves = [];
    const invalid = [];
    for (const source of topLevel(paths)) {
      if (source === targetDir || parentOf(source) === targetDir) continue;
      if (isUnder(targetDir, source)) { invalid.push(source); continue; }
      const leaf = source.split('/').filter(Boolean).pop() || source;
      moves.push({ source, dest: targetDir === '/' ? `/${leaf}` : `${targetDir}/${leaf}` });
    }
    return { moves, invalid };
  }

  // Paths relative to `root` (the workspace), for Copy Relative Path. Paths outside it stay absolute;
  // the root itself becomes ".".
  function relativeTo(root, p) {
    if (p === root) return '.';
    if (root && isUnder(p, root)) return p.slice(root === '/' ? 1 : root.length + 1);
    return p;
  }

  const treeSelection = { isUnder, range, topLevel, planMove, relativeTo };
  if (typeof module !== 'undefined' && module.exports) module.exports = treeSelection;
  if (typeof window !== 'undefined') window.treeSelectionRules = treeSelection;
})();
