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

function uncToWsl(distro, inputPath) {
  if (!inputPath) return inputPath;

  // Already a WSL/Linux path.
  if (inputPath.startsWith('/')) return inputPath;

  // WSL UNC path: \\wsl.localhost\Ubuntu\home\... or \\wsl$\Ubuntu\home\...
  const normalized = inputPath.replace(/\\/g, '/');
  const candidates = [
    `//wsl.localhost/${distro}`.toLowerCase(),
    `//wsl$/${distro}`.toLowerCase()
  ];
  const lower = normalized.toLowerCase();
  for (const prefix of candidates) {
    if (lower.startsWith(prefix)) {
      const rest = normalized.slice(prefix.length);
      return rest.startsWith('/') ? rest : `/${rest}`;
    }
  }

  // Native Windows path selected from the Open Directory dialog.
  // Use WSL's automatic /mnt/<drive> mount so both tree and terminal use the same directory.
  const drivePath = windowsDrivePathToWsl(inputPath);
  if (drivePath) return drivePath;

  return inputPath;
}

module.exports = { wslToUnc, wslPathToWindowsFsPath, windowsDrivePathToWsl, uncToWsl };
