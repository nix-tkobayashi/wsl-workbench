// Landing-screen recent-workspace filtering, separated from the DOM so it can be unit-tested. IIFE
// (nothing leaks into the renderer global scope); dual-exported for require() in tests and
// window.recentFilter in the renderer.
(function () {
  // Where a workspace lives, for display: `WSL:<distro>` or `SSH:<host>` (a remote workspace is
  // stored as distro `ssh:<host>`), so local and remote entries are told apart at a glance (#116).
  // Display only — stored keys keep the raw `distro:wslPath`.
  function workspaceKind(distro) {
    const d = String(distro == null ? '' : distro);
    return d.startsWith('ssh:') ? `SSH:${d.slice(4)}` : `WSL:${d}`;
  }

  // `WSL:Ubuntu:/home/me/app` / `SSH:ec2-dev:/home/ec2-user/app`.
  function workspaceLabel(ws) {
    return `${workspaceKind(ws && ws.distro)}:${(ws && ws.wslPath) || ''}`;
  }

  // Display label for a recent entry — the same string the landing list shows and matches on.
  function recentLabel(item) {
    return workspaceLabel(item);
  }

  // Case-insensitive substring filter. The query is split on whitespace and EVERY term must appear
  // somewhere in the label ("nix lite" matches "WSL:Ubuntu:/home/u/projects/nix/nix-workbench-lite"),
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

  const recentFilter = { workspaceKind, workspaceLabel, recentLabel, filterRecentWorkspaces };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = recentFilter;
  }
  if (typeof window !== 'undefined') {
    window.recentFilter = recentFilter;
  }
})();
