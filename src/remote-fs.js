// The tree / editor / git operations of a remote workspace (see remote-workspace.js), mirroring
// the local IPC handlers in main.js: same arguments, same return shapes, same validation. `agent`
// is a RemoteAgent (anything with request(op, args)). No Electron here, so it is unit-testable
// against a locally spawned agent.
const fs = require('fs');
const path = require('path');
const { looksBinary } = require('./file-types');
const { isHiddenTreeName } = require('./wsl-paths');
const { parseGitInfoOutput } = require('./git-status');

const TEXT_MAX = 1024 * 1024;
const COPY_FILE_MAX = 100 * 1024 * 1024; // files travel base64 in one JSON line

function badName(name) {
  return typeof name !== 'string' || !name || name.includes('/') || name.includes('\\') || name === '.' || name === '..';
}

function sortTreeEntries(wslPath, entries) {
  return entries
    .filter((e) => !isHiddenTreeName(e.name, e.isFile))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
    .map((e) => ({ name: e.name, path: path.posix.join(wslPath, e.name), type: e.isDir ? 'directory' : 'file', hasChildren: e.isDir }));
}

async function readDirTree(agent, wslPath) {
  const entries = await agent.request('readdir', { path: wslPath });
  return { name: path.posix.basename(wslPath) || '/', path: wslPath, type: 'directory', children: sortTreeEntries(wslPath, entries) };
}

async function treeSignature(agent, paths) {
  const res = await agent.request('readdirs', { paths });
  return paths.map((p) => {
    const entries = res[p];
    if (!entries) return `${p}|MISSING`;
    const names = entries.filter((e) => !isHiddenTreeName(e.name, e.isFile))
      .map((e) => `${e.isDir ? 'd' : 'f'}:${e.name}`).sort();
    return `${p}|${names.join(',')}`;
  }).join('\n');
}

async function readText(agent, wslPath, force) {
  const r = await agent.request('read', { path: wslPath, max: TEXT_MAX });
  if (!r) return { text: '', unsupported: false, tooLarge: false };
  if (r.tooLarge) return { text: '[File is larger than 1MB. Editor skipped.]', unsupported: false, tooLarge: true };
  const bytes = Buffer.from(r.b64, 'base64');
  if (force !== true && looksBinary(bytes)) return { text: '', unsupported: true, tooLarge: false };
  return { text: bytes.toString('utf8'), unsupported: false, tooLarge: false };
}

async function statFile(agent, wslPath) {
  const s = await agent.request('stat', { path: wslPath });
  return s && s.isFile ? { mtimeMs: s.mtimeMs, size: s.size } : null;
}

async function readDataUrl(agent, wslPath, max, mime, tooLargeMessage) {
  const r = await agent.request('read', { path: wslPath, max }, { timeoutMs: 120000 });
  if (!r) throw new Error(`File not found: ${wslPath}`);
  if (r.tooLarge) throw new Error(tooLargeMessage);
  return `data:${mime};base64,${r.b64}`;
}

async function writeText(agent, wslPath, content) {
  const b64 = Buffer.from(content ?? '', 'utf8').toString('base64');
  const after = await agent.request('write', { path: wslPath, b64, mode: 'existing' });
  return { ok: true, mtimeMs: after ? after.mtimeMs : null, size: after ? after.size : null };
}

async function gitInfo(agent, wslPath, script) {
  let res;
  try { res = await agent.request('sh', { cwd: wslPath, script, timeout: 10 }, { timeoutMs: 15000 }); } catch { return null; }
  if (!res || res.code !== 0) return null;
  const parsed = parseGitInfoOutput(res.stdout);
  if (!parsed) return null;
  return { branch: parsed.branch, dirty: parsed.rawCount > 0, statuses: parsed.statuses, remoteUrl: parsed.remoteUrl };
}

async function move(agent, sourcePath, targetDirPath) {
  if (!sourcePath || !targetDirPath) throw new Error('sourcePath and targetDirPath are required.');
  if (sourcePath === targetDirPath || targetDirPath.startsWith(sourcePath + '/')) {
    throw new Error('Cannot move a directory into itself.');
  }
  if (!(await agent.request('exists', { path: sourcePath }))) throw new Error(`Source not found: ${sourcePath}`);
  await agent.request('rename', { src: sourcePath, dst: path.posix.join(targetDirPath, path.posix.basename(sourcePath)) });
  return { ok: true };
}

async function create(agent, parentDirPath, name, type) {
  if (!parentDirPath || !name) throw new Error('parentDirPath and name are required.');
  if (badName(name)) throw new Error('Invalid name.');
  const target = path.posix.join(parentDirPath, name);
  if (await agent.request('exists', { path: target })) throw new Error(`Already exists: ${name}`);
  if (type === 'directory') await agent.request('mkdir', { path: target });
  else await agent.request('write', { path: target, b64: '', mode: 'new' });
  return { ok: true };
}

async function rename(agent, sourcePath, newName) {
  if (!sourcePath || !newName) throw new Error('sourcePath and newName are required.');
  if (badName(newName)) throw new Error('Invalid name.');
  const dstPath = path.posix.join(path.posix.dirname(sourcePath), newName);
  if (!(await agent.request('exists', { path: sourcePath }))) throw new Error(`Source not found: ${sourcePath}`);
  await agent.request('rename', { src: sourcePath, dst: dstPath });
  return { ok: true, path: dstPath };
}

async function remove(agent, targetPath) {
  if (!targetPath) throw new Error('targetPath is required.');
  if (!(await agent.request('exists', { path: targetPath }))) throw new Error(`Target not found: ${targetPath}`);
  await agent.request('delete', { path: targetPath }, { timeoutMs: 120000 });
  return { ok: true };
}

async function requireDir(agent, dirPath) {
  const s = await agent.request('stat', { path: dirPath });
  if (!s || !s.isDir) throw new Error(`Target directory not found: ${dirPath}`);
}

// Exclusive create with `base.png`, `base-1.png`, ... like the local clipboard-image save.
async function saveImage(agent, targetDirPath, png, base) {
  if (!targetDirPath) throw new Error('targetDirPath is required.');
  await requireDir(agent, targetDirPath);
  const b64 = png.toString('base64');
  let name = `${base}.png`;
  for (let i = 1; ; i++) {
    try {
      await agent.request('write', { path: path.posix.join(targetDirPath, name), b64, mode: 'new' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      name = `${base}-${i}.png`;
    }
  }
  return { ok: true, name, path: path.posix.join(targetDirPath, name) };
}

// Upload local (Windows) files/folders dropped on the tree. Same rules as copyRecursiveSafeSync:
// never overwrite, skip system profile files, report every skip.
async function copyExternal(agent, sourcePaths, targetDirPath, { shouldSkip = () => false, isAds = () => false } = {}) {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) throw new Error('sourcePaths are required.');
  if (!targetDirPath) throw new Error('targetDirPath is required.');
  await requireDir(agent, targetDirPath);
  const result = { copied: [], skipped: [] };
  const copy = async (source, destination) => {
    if (shouldSkip(source)) { result.skipped.push({ source, reason: 'system profile file' }); return; }
    let stat;
    try { stat = fs.statSync(source); } catch (error) { result.skipped.push({ source, reason: error.code || error.message }); return; }
    if (await agent.request('exists', { path: destination })) { result.skipped.push({ source, reason: 'destination exists' }); return; }
    if (stat.isDirectory()) {
      try { await agent.request('mkdir', { path: destination }); } catch (error) { result.skipped.push({ source, reason: error.code || error.message }); return; }
      let entries;
      try { entries = fs.readdirSync(source, { withFileTypes: true }); } catch (error) { result.skipped.push({ source, reason: error.code || error.message }); return; }
      for (const entry of entries) await copy(path.join(source, entry.name), path.posix.join(destination, entry.name));
      result.copied.push(destination);
      return;
    }
    if (stat.isFile()) {
      if (stat.size > COPY_FILE_MAX) { result.skipped.push({ source, reason: 'larger than 100MB' }); return; }
      try {
        const b64 = fs.readFileSync(source).toString('base64');
        await agent.request('write', { path: destination, b64, mode: 'new' }, { timeoutMs: 300000 });
        result.copied.push(destination);
      } catch (error) {
        result.skipped.push({ source, reason: error.code || error.message });
      }
      return;
    }
    result.skipped.push({ source, reason: 'not a regular file or directory' });
  };
  for (const sourcePath of sourcePaths) {
    if (isAds(sourcePath)) continue;
    if (!fs.existsSync(sourcePath)) { result.skipped.push({ source: sourcePath, reason: 'source not found' }); continue; }
    await copy(sourcePath, path.posix.join(targetDirPath, path.basename(sourcePath)));
  }
  if (result.copied.length === 0 && result.skipped.length > 0) {
    const first = result.skipped[0];
    throw new Error(`No files were copied. First skipped item: ${first.source} (${first.reason})`);
  }
  return { ok: true, copied: result.copied, skipped: result.skipped };
}

module.exports = {
  readDirTree, treeSignature, readText, statFile, readDataUrl, writeText, gitInfo,
  move, create, rename, remove, saveImage, copyExternal
};
