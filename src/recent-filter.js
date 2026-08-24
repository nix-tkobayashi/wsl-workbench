// Landing-screen recent-workspace filtering, separated from the DOM so it can be unit-tested. IIFE
// (nothing leaks into the renderer global scope); dual-exported for require() in tests and
// window.recentFilter in the renderer.
(function () {
  // Display label for a recent entry — the same string the landing list shows and matches on.
  function recentLabel(item) {
    return `${item.distro}:${item.wslPath}`;
  }

  // Case-insensitive substring filter. The query is split on whitespace and EVERY term must appear
  // somewhere in the label ("nix lite" matches "Ubuntu:/home/u/projects/nix/nix-workbench-lite"),
  // so a path can be narrowed by fragments in any order. An empty/blank query returns all entries;
  // input order is preserved (most recent first).
  function filterRecentWorkspaces(items, query) {
    const list = Array.isArray(items) ? items.filter((e) => e && e.wslPath) : [];
    const terms = String(query == null ? '' : query).toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return list;
    return list.filter((item) => {
      const label = recentLabel(item).toLowerCase();
      return terms.every((term) => label.includes(term));
    });
  }

  const recentFilter = { recentLabel, filterRecentWorkspaces };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = recentFilter;
  }
  if (typeof window !== 'undefined') {
    window.recentFilter = recentFilter;
  }
})();
