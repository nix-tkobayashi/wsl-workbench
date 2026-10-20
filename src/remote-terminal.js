// Remote terminals (prototype): a workspace listed in settings.json `remoteTerminals` runs its
// terminal over ssh on another host (e.g. an EC2 instance) instead of in the local distro. Only the
// terminal moves — the file tree, editor, and git badge still read the local workspace. ssh is run
// inside the workspace's distro, so the distro's ~/.ssh/config (ProxyCommand for SSM, keys, agent)
// applies. Pure logic, separated from main.js so it can be unit-tested.
//
// settings.json:
//   "remoteTerminals": [
//     { "wslPath": "/home/me/projects/app", "distro": "Ubuntu", "host": "ec2-dev", "dir": "/home/ec2-user/app" }
//   ]
// `distro` is optional (matches any distro); `dir` is optional (the remote login directory).

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const trimSlash = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

// A host is passed to ssh as one argv element after `--`, so a leading '-' can't become an option;
// whitespace/control characters are still rejected because they can only be a typo here.
function validHost(host) {
  return typeof host === 'string' && host.length > 0 && !host.startsWith('-') && !/[\s\x00-\x1f\x7f]/.test(host);
}
function validDir(dir) {
  return dir === undefined || dir === '' || (typeof dir === 'string' && dir.startsWith('/') && !/[\x00-\x1f\x7f]/.test(dir));
}

// The remote mapping for a workspace, or null when its terminal stays local. Malformed entries are
// skipped (never half-applied).
function findRemoteTerminal(entries, workspace) {
  if (!Array.isArray(entries) || !workspace || typeof workspace.wslPath !== 'string') return null;
  const wsPath = trimSlash(workspace.wslPath);
  for (const e of entries) {
    if (!e || typeof e.wslPath !== 'string' || !validHost(e.host) || !validDir(e.dir)) continue;
    if (e.distro && e.distro !== workspace.distro) continue;
    if (trimSlash(e.wslPath) !== wsPath) continue;
    return { host: e.host, dir: e.dir || '' };
  }
  return null;
}

// wsl.exe argv that opens an interactive ssh session (-t: the remote side gets a pty, so resize and
// full-screen CLIs work) and runs `script` in a remote login bash. `script` is the same shell text a
// local terminal runs (cwd reporting, inherited cd, launch). ServerAlive* drops a dead connection
// in ~2 minutes instead of hanging the pane.
function remoteTerminalArgs(distro, remote, script) {
  const parts = [];
  // A missing remote dir must not run the launch command somewhere else: fall back to a bare shell.
  if (remote.dir) parts.push(`cd -- ${shq(remote.dir)} || { echo ${shq(`[remote] cannot cd to ${remote.dir}`)}; exec bash; }`);
  parts.push(script);
  return [
    '-d', distro, '--exec', 'ssh', '-t',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4',
    '--', remote.host,
    `bash -lc ${shq(parts.join('; '))}`
  ];
}

module.exports = { findRemoteTerminal, remoteTerminalArgs, validHost };
