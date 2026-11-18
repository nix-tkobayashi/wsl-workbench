// "Free WSL memory" (#125): WSL2 keeps the Linux page cache instead of handing it back to Windows,
// so VmmemWSL grows toward the VM's memory cap even when processes use far less. Dropping the
// clean page cache (after `sync`, so nothing dirty is lost) and compacting free pages lets free
// page reporting return the memory to Windows — without stopping any process. The VM is shared by
// every distro, so running this in one local distro frees memory for all of them.
//
// Pure helpers (script, args, /proc/meminfo parsing) so the main process wiring stays thin and
// this logic is unit-testable.

// Run as root via `wsl.exe -u root` (no sudo password). Prints /proc/meminfo before and after
// between markers. compact_memory is best effort (absent on some kernels); a failed sync (exit 4)
// or drop_caches (exit 3) is a real error, so success is never reported over unflushed data.
const RECLAIM_SCRIPT = [
  'echo "@@BEFORE"', 'cat /proc/meminfo',
  'sync || exit 4',
  'echo 1 > /proc/sys/vm/drop_caches || exit 3',
  'echo 1 > /proc/sys/vm/compact_memory 2>/dev/null',
  'echo "@@AFTER"', 'cat /proc/meminfo'
].join('; ');

function reclaimArgs(distro) {
  return ['-d', distro, '-u', 'root', '--exec', 'sh', '-c', RECLAIM_SCRIPT];
}

// /proc/meminfo → { MemTotal: bytes, Cached: bytes, ... } (values are in kB).
function parseMeminfo(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^(\w+(?:\(\w+\))?):\s+(\d+)(?:\s+kB)?\s*$/.exec(line.trim());
    if (m) out[m[1]] = Number(m[2]) * 1024;
  }
  return out;
}

// The page cache the kernel can drop: Cached (minus shared memory, which drop_caches cannot free)
// plus Buffers.
function cacheBytes(info) {
  return Math.max(0, (info.Cached || 0) - (info.Shmem || 0)) + (info.Buffers || 0);
}

// Script stdout → { before, after, freedBytes, availableAfter, totalBytes }, or null when either
// snapshot is missing (the script failed before printing it).
function parseReclaimOutput(stdout) {
  const text = String(stdout || '').replace(/\r/g, '');
  const b = text.indexOf('@@BEFORE');
  const a = text.indexOf('@@AFTER');
  if (b < 0 || a < 0 || a < b) return null;
  const before = parseMeminfo(text.slice(b + '@@BEFORE'.length, a));
  const after = parseMeminfo(text.slice(a + '@@AFTER'.length));
  if (!before.MemTotal || !after.MemTotal) return null;
  return {
    before,
    after,
    freedBytes: Math.max(0, cacheBytes(before) - cacheBytes(after)),
    availableAfter: after.MemAvailable || 0,
    totalBytes: after.MemTotal
  };
}

function formatGB(bytes) {
  return (Math.max(0, bytes || 0) / (1024 * 1024 * 1024)).toFixed(1);
}

module.exports = { RECLAIM_SCRIPT, reclaimArgs, parseMeminfo, cacheBytes, parseReclaimOutput, formatGB };
