// CPU / memory usage math for the toolbar performance meters (#69). The sampling itself lives in
// the main process (os.cpus() / totalmem / freemem of the Windows host); these pure functions keep
// the percentage math unit-testable. CPU load is the non-idle share of the tick delta between two
// snapshots — the first sample after startup has no delta and reports 0.
function cpuTotals(cpus) {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus || []) {
    const times = cpu && cpu.times ? cpu.times : {};
    for (const key of Object.keys(times)) total += times[key] || 0;
    idle += times.idle || 0;
  }
  return { idle, total };
}

function clampPct(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function cpuPercent(prev, next) {
  if (!prev || !next) return 0;
  const dTotal = next.total - prev.total;
  const dIdle = next.idle - prev.idle;
  if (!(dTotal > 0)) return 0;
  return clampPct((1 - dIdle / dTotal) * 100);
}

function memPercent(used, total) {
  if (!(total > 0)) return 0;
  return clampPct((used / total) * 100);
}

module.exports = { cpuTotals, cpuPercent, memPercent };
