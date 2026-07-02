// Workspace-file detection in a process argv, shared by first launch and the single-instance
// 'second-instance' forward (whose argv also carries Chromium switches and the exe path).
// Extracted from main.js so the parsing is unit-testable without loading Electron.
const fs = require('fs');
const path = require('path');

const WORKSPACE_EXT = 'wslwb-workspace';
const WORKSPACE_EXTENSIONS = new Set([`.${WORKSPACE_EXT}`, '.json']);

// A real workspace file: matching extension AND an existing regular file — so switches like
// --enable-features or stale/mistyped paths in argv never get treated as a workspace.
function isWorkspaceFile(filePath) {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  if (!WORKSPACE_EXTENSIONS.has(ext)) return false;
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

function findWorkspaceArg(argv = process.argv) {
  return argv.find((arg) => isWorkspaceFile(arg));
}

module.exports = { WORKSPACE_EXT, WORKSPACE_EXTENSIONS, isWorkspaceFile, findWorkspaceArg };
