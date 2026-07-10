// Pure path-conversion helpers shared by the main process. Kept dependency-free so they can be
// unit-tested without Electron. All functions are string transforms (no filesystem access).

function wslToUnc(distro, wslPath) {
  const clean = wslPath.replace(/^\/+/, '').replace(/\//g, '\\');
  return `\\\\wsl.localhost\\${distro}\\${clean}`;
}

function wslPathToWindowsFsPath(distro, wslPath) {
  // Native WSL path -> \\wsl.localhost\Distro\...
  // Windows-mounted path (/mnt/c/...) -> C:\...
  // Some Windows versions cannot reliably traverse /mnt/c via the WSL UNC provider.
  const match = String(wslPath || '').match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
  if (match) {
    const drive = match[1].toUpperCase();
    const rest = (match[2] || '').replace(/\//g, '\\');
    return `${drive}:\\${rest}`;
  }
  return wslToUnc(distro, wslPath);
}

function windowsDrivePathToWsl(windowsPath) {
  // Convert C:\Users\name\project -> /mnt/c/Users/name/project
  const match = windowsPath.match(/^([a-zA-Z]):\\?(.*)$/);
  if (!match) return null;
  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/\\/g, '/').replace(/^\/+/, '');
  return `/mnt/${drive}${rest ? `/${rest}` : ''}`;
}

// Parse a path chosen from the Windows dialog into { distro, wslPath }.
// The distro is read FROM the path's \\wsl.localhost\<distro>\... segment (any distro name,
// e.g. Ubuntu-22.04), so opening a folder in a non-default distro works. distro is null for
// drive paths (/mnt/<drive>) and already-WSL paths, meaning "keep the current distro".
function parseSelectedPath(inputPath) {
  if (!inputPath) return { distro: null, wslPath: inputPath };

  // Already a WSL/Linux path.
  if (inputPath.startsWith('/')) return { distro: null, wslPath: inputPath };

  // WSL UNC path: \\wsl.localhost\<distro>\... or \\wsl$\<distro>\... (one distro segment).
  const normalized = inputPath.replace(/\\/g, '/');
  const match = normalized.match(/^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i);
  if (match) {
    return { distro: match[1], wslPath: match[2] || '/' };
  }

  // Native Windows drive path selected from the dialog -> /mnt/<drive> mount.
  const drivePath = windowsDrivePathToWsl(inputPath);
  if (drivePath) return { distro: null, wslPath: drivePath };

  return { distro: null, wslPath: inputPath };
}

// True when a Windows path names an NTFS alternate data stream (e.g. `report.pptx:Zone.Identifier`,
// the Mark-of-the-Web stream on browser-downloaded files) rather than a real file. A colon in the
// final path segment is the ADS marker: NTFS forbids colons in regular file names, and WSL's 9P
// server escapes Linux-side colons to a private-use codepoint before they appear in a UNC path,
// so no legitimately named file trips this.
function isNtfsAdsPath(windowsPath) {
  const segment = String(windowsPath || '').split(/[\\/]/).pop();
  return segment.includes(':');
}

// Back-compat wrapper: convert a selected path to a WSL path. The `distro` argument is no longer
// used for matching (the distro is read from the path itself); callers that need the distro should
// use parseSelectedPath instead.
function uncToWsl(_distro, inputPath) {
  return parseSelectedPath(inputPath).wslPath;
}

module.exports = { wslToUnc, wslPathToWindowsFsPath, windowsDrivePathToWsl, uncToWsl, parseSelectedPath, isNtfsAdsPath };
