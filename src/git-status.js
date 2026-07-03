// Parses the combined `git branch/toplevel/status --porcelain` output produced by main.js's
// git:info command into { branch, statuses, truncated }. Pure string logic, extracted so the
// porcelain parsing (renames, directory entries, quoted paths, truncation) is unit-testable.
const path = require('path');

// Bound the payload for pathological change sets (decoration degrades gracefully to a subset).
const MAX_STATUS_ENTRIES = 2000;

// stdout layout: line 0 = branch (or short SHA), line 1 = repo toplevel (absolute WSL path),
// lines 2.. = `XY <path>` porcelain v1 entries. Paths there are relative to the toplevel.
function parseGitInfoOutput(stdout) {
  const lines = String(stdout || '').split('\n');
  const branch = (lines[0] || '').trim();
  if (!branch) return null;
  const toplevel = (lines[1] || '').trim();
  const statuses = [];
  let rawCount = 0; // every status line, including ones skipped/capped below — drives `dirty`
  let truncated = false;
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length < 4) continue;
    rawCount++;
    if (statuses.length >= MAX_STATUS_ENTRIES) { truncated = true; continue; }
    const code = line.slice(0, 2);
    let p = line.slice(3);
    // Renames/copies read `XY old -> new`; the tree should color the path that exists now. Only
    // R/C codes are split — an ordinary file whose NAME contains " -> " must stay intact. When a
    // renamed path ITSELF contains " -> ", porcelain v1 is ambiguous (multiple candidate
    // delimiters); skip such entries rather than tint a wrong path (rawCount still counts them).
    if (/[RC]/.test(code)) {
      const parts = p.split(' -> ');
      if (parts.length !== 2) continue;
      p = parts[1];
    }
    // With core.quotepath=false only control-character names still come C-quoted; skip those
    // rather than decorate a wrong (escaped) path.
    if (p.startsWith('"')) continue;
    // An untracked DIRECTORY is one `dir/` entry (default --untracked-files=normal); keep the
    // dir flag so consumers can prefix-match files revealed beneath it.
    const dir = p.endsWith('/');
    if (dir) p = p.slice(0, -1);
    if (!p) continue;
    statuses.push({ code, dir, path: toplevel ? path.posix.join(toplevel, p) : p });
  }
  return { branch, statuses, rawCount, truncated };
}

module.exports = { parseGitInfoOutput, MAX_STATUS_ENTRIES };
