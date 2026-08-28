// Main-process side of the Windows notification bridge (issue #73): spawns the helper, splits its
// stdout into NDJSON lines, and hands decoded messages to callbacks. The helper is optional — any
// failure here disables the feature and never touches app startup. `spawn` is injected so the
// runner is unit-testable with a fake child process.
// One stdout line → message object, or null for blank / malformed / non-object lines. Never throws.
function parseBridgeLine(line) {
  const text = String(line || '').trim();
  if (!text) return null;
  try {
    const msg = JSON.parse(text);
    return msg && typeof msg === 'object' && !Array.isArray(msg) && typeof msg.type === 'string' ? msg : null;
  } catch {
    return null;
  }
}

// Accumulates stdout chunks and yields complete lines; the trailing partial line waits for more.
// A line longer than `maxLine` (a corrupt helper never printing "\n") is discarded rather than
// buffered forever — the main-process heap must not depend on the helper behaving.
const MAX_LINE = 1024 * 1024;
function createLineSplitter(onLine, maxLine = MAX_LINE) {
  let rest = '';
  let dropping = false;
  return {
    push(chunk) {
      rest += String(chunk);
      let i;
      while ((i = rest.indexOf('\n')) >= 0) {
        const line = rest.slice(0, i);
        rest = rest.slice(i + 1);
        if (dropping) dropping = false; // the rest of the oversized line ended here
        else if (line.length <= maxLine) onLine(line); // a complete oversized line is dropped too
      }
      if (rest.length > maxLine) { rest = ''; dropping = true; }
    },
    flush() { const line = rest; rest = ''; if (line && !dropping) onLine(line); dropping = false; }
  };
}

// Restart policy: a helper that dies is restarted at most `maxRestarts` times, and a helper that
// exits with a code meaning "permanently unavailable" (no listener / access denied) is not
// restarted at all — retrying would only re-prompt the user. The status the exit maps to is kept
// actionable: 3 = the user has to allow notification access in Windows Settings.
const FATAL_EXIT_CODES = new Map([[2, 'unavailable'], [3, 'permission_required']]);

function createSystemNotificationBridge({
  spawn,
  command,
  args = [],
  onNotification = () => {},
  onStatus = () => {},
  onError = () => {},
  onDiagnostic = () => {},
  maxRestarts = 3,
  restartDelayMs = 1000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  let child = null;
  let restarts = 0;
  let stopped = false;
  let restartTimer = null;

  function handleMessage(msg) {
    if (!msg) return;
    if (msg.type === 'notification') onNotification(msg);
    else if (msg.type === 'status') onStatus({ status: String(msg.status || '') });
    else if (msg.type === 'error') onError({ code: String(msg.code || 'UNKNOWN'), message: String(msg.message || '') });
    else onDiagnostic(`unknown message type: ${msg.type}`);
  }

  function launch() {
    if (stopped) return;
    let proc;
    try {
      proc = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      onError({ code: 'SPAWN_FAILED', message: String(error && error.message || error) });
      onStatus({ status: 'unavailable' });
      return;
    }
    child = proc;
    const lines = createLineSplitter((line) => handleMessage(parseBridgeLine(line)));
    if (proc.stdout) {
      proc.stdout.setEncoding && proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => lines.push(chunk));
    }
    if (proc.stderr) {
      proc.stderr.setEncoding && proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk) => onDiagnostic(String(chunk).trim()));
    }
    // Node emits 'error' (e.g. powershell.exe missing) without a guaranteed 'exit', so the
    // lifecycle runs off whichever comes first — once.
    let ended = false;
    proc.on('error', (error) => {
      onError({ code: 'SPAWN_FAILED', message: String(error && error.message || error) });
      onExit(null);
    });
    proc.on('exit', onExit);
    function onExit(code) {
      if (ended) return;
      ended = true;
      lines.flush();
      if (child === proc) child = null;
      if (stopped) return;
      if (FATAL_EXIT_CODES.has(code)) { onStatus({ status: FATAL_EXIT_CODES.get(code) }); return; }
      if (restarts >= maxRestarts) {
        onError({ code: 'BRIDGE_EXITED', message: `bridge exited (${code}); restart limit reached` });
        onStatus({ status: 'unavailable' });
        return;
      }
      restarts++;
      onDiagnostic(`bridge exited (${code}); restart ${restarts}/${maxRestarts}`);
      onStatus({ status: 'restarting' });
      restartTimer = setTimeoutFn(launch, restartDelayMs);
    }
  }

  function start() {
    if (child || stopped) return;
    launch();
  }

  // Close stdin (the helper's cue to exit), then kill in case it does not.
  function stop() {
    stopped = true;
    if (restartTimer) { clearTimeoutFn(restartTimer); restartTimer = null; }
    const proc = child;
    child = null;
    if (!proc) return;
    try { proc.stdin && proc.stdin.end(); } catch {}
    try { proc.kill(); } catch {}
  }

  return { start, stop, get running() { return !!child; }, get restarts() { return restarts; }};
}

module.exports = { parseBridgeLine, createLineSplitter, createSystemNotificationBridge, FATAL_EXIT_CODES, MAX_LINE };
