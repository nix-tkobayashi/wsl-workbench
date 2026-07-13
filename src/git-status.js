// Parses the combined `git branch/toplevel/status --porcelain` output produced by main.js's
// git:info command into { branch, remoteUrl, statuses, truncated }. Pure string logic, extracted so the
// porcelain parsing (renames, directory entries, quoted paths, truncation) is unit-testable.
const path = require('path');

// Bound the payload for pathological change sets (decoration degrades gracefully to a subset).
const MAX_STATUS_ENTRIES = 2000;

// Turns a git remote URL (https, ssh://, or scp-like git@host:path) into a browsable https URL,
// or null when it isn't web-mappable (e.g. a local filesystem remote). Trailing `.git` and `/`
// are stripped; scp/ssh forms map host+path onto https, which is how GitHub/GitLab/Bitbucket
// expose their repos on the web.
function remoteWebUrl(remote) {
  const u = String(remote || '').trim();
  if (!u) return null;
  // http(s) remotes are already web addresses: keep the scheme and any explicit port (self-hosted
  // servers often serve on one), drop only credentials. ssh/scp forms map onto https://host/path;
  // an ssh port there is the ssh daemon's, not the web server's, so it is dropped.
  let scheme = 'https';
  let m = u.match(/^(https?):\/\/(?:[^\s/@]+@)?([^\s/@]+)\/(.+)$/i);              // https://[user@]host[:port]/path
  if (m) {
    scheme = m[1].toLowerCase();
    m = [m[0], m[2], m[3]];
  } else {
    m = u.match(/^ssh:\/\/(?:[^\s/@]+@)?([^\s/:]+)(?::\d+)?\/(.+)$/i)             // ssh://[user@]host[:port]/path
      || u.match(/^(?:[^\s/@]+@)([^\s/:]+):(.+)$/);                               // git@host:path (scp-like)
    if (!m) return null;
  }
  const path = m[2].replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!path) return null;
  return `${scheme}://${m[1]}/${path}`;
}

// stdout layout: line 0 = branch (or short SHA), line 1 = repo toplevel (absolute WSL path),
// line 2 = remote URL (empty when the repo has no remote), lines 3.. = `XY <path>` porcelain v1
// entries. Paths there are relative to the toplevel.
function parseGitInfoOutput(stdout) {
  const lines = String(stdout || '').split('\n');
  const branch = (lines[0] || '').trim();
  if (!branch) return null;
  const toplevel = (lines[1] || '').trim();
  const remoteUrl = remoteWebUrl(lines[2]);
  const statuses = [];
  let rawCount = 0; // every status line, including ones skipped/capped below — drives `dirty`
  let truncated = false;
  for (let i = 3; i < lines.length; i++) {
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
  return { branch, remoteUrl, statuses, rawCount, truncated };
}

module.exports = { parseGitInfoOutput, remoteWebUrl, MAX_STATUS_ENTRIES };
