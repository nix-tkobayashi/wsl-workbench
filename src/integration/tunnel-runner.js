// Runs the user's OpenAI tunnel-client (Secure MCP Tunnel) next to Workbench: started when the app
// starts (opt-in), stopped when it quits. Electron-free (OS protection, ACLs, process control are
// injected) so it is unit-tested.
//
// The runtime API key:
//  - is stored only as <userData>/integration/tunnel.key.enc, encrypted by the OS (DPAPI via Electron
//    safeStorage), with the file ACL reset to the current user. If encryption, the ACL, or decryption
//    fails, nothing is saved / nothing is started — there is no plaintext fallback.
//  - is decrypted only to hand it to the job helper over stdin, which puts it in tunnel-client's
//    environment block alone. It is never put in process.env (so WSL, terminals and AI CLIs started
//    by Workbench never inherit it), any argv or other environment, settings.json, or logs. The MCP
//    wrapper tunnel-client starts must clear it first (checked before every start).
// tunnel-client runs in a kill-on-close Job Object (tunnel-job.js): its whole tree ends when
// Workbench ends, including a crash or a forced kill.
// Starting the tunnel never shares a pane or allows input; those stay separate user actions.

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { helperArgs, requestLines, parseHelperLine } = require('./tunnel-job');

const KEY_FILE = 'tunnel.key.enc';
const LOG_FILE = 'tunnel-client.log';
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const KEY_ENV = 'CONTROL_PLANE_API_KEY';
const MAX_KEY_LENGTH = 512;

// A runtime key is one printable-ASCII token (no spaces / line breaks that would corrupt the env).
function normalizeKey(input) {
  const key = String(input == null ? '' : input).trim();
  if (!key) throw new Error('The API key is empty.');
  if (key.length > MAX_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(key)) throw new Error('The API key has an unexpected format.');
  return key;
}

// tunnel-client hands its environment (with the key) to every stdio MCP command it starts. Only
// run profiles whose commands are .cmd / .bat wrappers that clear the key before anything else
// runs (the adapter then never receives it). HTTP MCP servers (no command) are fine.
const CLEAR_RE = new RegExp(`^set\\s+"?${KEY_ENV}="?\\s*$`, 'i');

const KEY_ASSIGN_RE = new RegExp(`(^|[\\s&|(])set\\s+"?${KEY_ENV}=`, 'i');

// True when the wrapper clears the key before anything runs and never brings it back afterwards
// (no setlocal / endlocal scope that would restore it, no later assignment of the key).
function wrapperClearsKey(text) {
  const lines = String(text).split(/\r?\n/).map((raw) => raw.trim().replace(/^@/, ''));
  if (lines.some((line) => /(^|[^A-Za-z0-9_])(setlocal|endlocal)([^A-Za-z0-9_]|$)/i.test(line))) return false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || /^echo\s+off$/i.test(line)) continue;
    // cmd ignores the rest of a comment line (checked on Windows 11), but comments with separators
    // are refused anyway: nothing unusual before the key is cleared.
    if (/^(rem(\s|$)|::)/i.test(line)) { if (/[&|]/.test(line)) return false; continue; }
    if (CLEAR_RE.test(line)) return !lines.slice(i + 1).some((l) => KEY_ASSIGN_RE.test(l));
    if (/^set\s+"?[A-Za-z_][A-Za-z0-9_]*=/i.test(line) && !/[&|<>^%!()]/.test(line)) continue; // plain assignments
    return false; // something runs before the key is cleared
  }
  return false;
}

// YAML features this reader does not interpret; a profile using any of them is refused (fail
// closed) rather than risk missing a `command` key: escapes in double quotes, tags, anchors /
// aliases, merge keys, complex keys, block scalars after a key.
function yamlTooComplex(text) {
  return /"[^"\n]*\\/.test(text)
    || /(^|[\s,\[{:-])[!&*][^\s]/.test(text)
    || /<<\s*:/.test(text)
    || /(^|[\s\[{,-])\?(\s|$)/m.test(text)
    || /^[\s-]*:(\s|$)/m.test(text)
    || /:[ \t]*[|>][-+0-9]*[ \t]*$/m.test(text);
}

// The stdio commands in a profile YAML (mcp.commands[].command), block or flow style, any key case;
// quotes stripped. Returns null (refuse) when the profile can't be read reliably.
function profileCommands(yaml) {
  const lines = [];
  for (const line of String(yaml).split(/\r?\n/)) {
    const hash = line.search(/(^|\s)#/);
    if (hash < 0) { lines.push(line); continue; }
    const before = line.slice(0, hash);
    if (/["']/.test(before)) return null; // a '#' after a quote may be inside a string: can't tell
    lines.push(before);
  }
  const text = lines.join('\n');
  if (yamlTooComplex(text)) return null;
  const keyRe = /(^|[\s{,\[-])["']?command["']?[ \t]*:/gi;
  const valueRe = /^[ \t]*("([^"\\]*)"|'([^']*)'|([^\s"'&*|>!%@`{\[,}\]][^,}\]\n]*?))[ \t]*(?=$|[,}\]\n])/;
  const out = [];
  let m;
  while ((m = keyRe.exec(text))) {
    const rest = text.slice(m.index + m[0].length);
    const v = valueRe.exec(rest);
    if (!v) return null;
    const value = (v[2] != null ? v[2] : v[3] != null ? v[3] : v[4]).trim();
    if (!value) return null;
    out.push(value);
  }
  return out;
}

function checkProfileIsolation(profileFile, readFile = (f) => fs.readFileSync(f, 'utf8'), platform = process.platform) {
  let yaml;
  try { yaml = readFile(profileFile); } catch { return { ok: false, reason: 'The tunnel-client profile could not be read.' }; }
  const commands = profileCommands(yaml);
  if (!commands) return { ok: false, reason: 'The MCP commands in the tunnel-client profile could not be verified; write them as plain `command: "C:/.../adapter.cmd"` entries.' };
  for (const command of commands) {
    // tunnel-client splits the command on spaces and runs it from its own folder: only an absolute
    // drive path without whitespace is checked against the same file that will run.
    const absolute = platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(command) : command.startsWith('/');
    if (!absolute || /\s/.test(command) || /(^|[\\/])\.\.?([\\/]|$)/.test(command)) {
      return { ok: false, reason: `The MCP command ${command} must be an absolute path without spaces (for example C:/Users/<you>/wswb-mcp/adapter.cmd).` };
    }
    if (!/\.(cmd|bat)$/i.test(command)) {
      return { ok: false, reason: `The MCP command ${command} would receive the API key. Use a .cmd wrapper whose first command is "set ${KEY_ENV}=".` };
    }
    let text;
    try { text = readFile(command); } catch { return { ok: false, reason: `The MCP wrapper ${command} could not be read.` }; }
    if (!wrapperClearsKey(text)) {
      return { ok: false, reason: `The MCP wrapper ${command} must clear the key before it starts the adapter: add "set ${KEY_ENV}=" right after "@echo off".` };
    }
  }
  return { ok: true };
}

// Windows: end tunnel-client together with the adapter it launched (cmd.exe -> Workbench in Node mode).
// Synchronous so it also works from app 'will-quit'. Returns true when the process is gone
// (taskkill exit 128 = no such process, i.e. it already exited).
function defaultKillTree(pid, platform = process.platform) {
  if (platform === 'win32') {
    const r = childProcess.spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
    return !r.error && (r.status === 0 || r.status === 128);
  }
  try { process.kill(pid, 'SIGTERM'); return true; } catch (error) { return error.code === 'ESRCH'; }
}

class TunnelRunner {
  constructor({
    dir, platform = process.platform,
    readConfig = () => ({}), writeConfig = () => {},
    keyStore, // { available(): bool, encrypt(string): Buffer, decrypt(Buffer): string }
    restrictAcl = async () => {}, // (file) => Promise; rejects when the file can't be limited to the user
    spawn = childProcess.spawn, killTree = (pid) => defaultKillTree(pid, platform),
    baseEnv = () => process.env, audit = { record() {} }, onChange = () => {}, now = Date.now,
    canRun = () => true, // main: the dots integration is on. Checked by every start path.
    parentPid = process.pid // the job helper ends the tunnel when this process is gone
  }) {
    this.parentPid = parentPid;
    this.tunnelPid = null;
    this.canRun = canRun;
    this.dir = dir;
    this.platform = platform;
    this.readConfig = readConfig;
    this.writeConfig = writeConfig;
    this.keyStore = keyStore;
    this.restrictAcl = restrictAcl;
    this.spawnImpl = spawn;
    this.killTree = killTree;
    this.baseEnv = baseEnv;
    this.audit = audit;
    this.onChange = onChange;
    this.now = now;
    this.child = null;
    this.state = 'stopped'; // stopped | running | exited | error
    this.startedAt = null;
    this.lastExit = null; // { code, signal, at }
    this.lastError = null;
    this.stoppedChildren = new WeakSet(); // children we ended on purpose
  }

  get keyPath() { return path.join(this.dir, KEY_FILE); }
  get logPath() { return path.join(this.dir, 'diag', LOG_FILE); }
  get running() { return !!this.child; }

  config() {
    const c = this.readConfig() || {};
    return {
      autoStart: !!c.autoStart,
      exePath: typeof c.exePath === 'string' ? c.exePath : '',
      profileFile: typeof c.profileFile === 'string' ? c.profileFile : ''
    };
  }

  setConfig(patch) { this.writeConfig({ ...this.config(), ...patch }); this.onChange(); }

  hasKey() { return fs.existsSync(this.keyPath); }

  encryptionAvailable() {
    try { return !!(this.keyStore && this.keyStore.available()); } catch { return false; }
  }

  // Encrypt, write to a temp file, lock its ACL, verify it decrypts, then replace the old key.
  async setKey(input) {
    const key = normalizeKey(input);
    if (!this.encryptionAvailable()) throw new Error('OS encryption (DPAPI) is unavailable; the key was not saved.');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.keyPath}.${process.pid}.${this.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, this.keyStore.encrypt(key), { mode: 0o600, flag: 'wx' });
      await this.restrictAcl(tmp);
      if (this.keyStore.decrypt(fs.readFileSync(tmp)) !== key) throw new Error('The encrypted key could not be verified.');
      fs.renameSync(tmp, this.keyPath);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch {}
      this.audit.record({ event: 'tunnel_key_save_failed', reason: String(error.message || error).slice(0, 200) });
      throw error;
    }
    this.audit.record({ event: 'tunnel_key_saved' });
    this.onChange();
    // A replaced key takes effect right away for a running tunnel (never a second one beside it).
    if (this.running) {
      if (!this.stop('key_replaced')) throw new Error(`The key was saved, but the running tunnel-client could not be stopped: ${this.lastError}`);
      this.start('key_replaced');
    }
  }

  deleteKey() {
    const stopped = !this.running || this.stop('key_deleted');
    try { fs.unlinkSync(this.keyPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.audit.record({ event: 'tunnel_key_deleted' });
    this.onChange();
    if (!stopped) throw new Error(`The key was deleted, but the running tunnel-client could not be stopped: ${this.lastError}`);
  }

  loadKey() {
    if (!this.encryptionAvailable()) throw new Error('OS encryption (DPAPI) is unavailable.');
    let data;
    try { data = fs.readFileSync(this.keyPath); } catch (error) {
      throw new Error(error.code === 'ENOENT' ? 'No API key is saved.' : 'The saved API key could not be read.');
    }
    let key;
    try { key = this.keyStore.decrypt(data); } catch { throw new Error('The saved API key could not be decrypted.'); }
    return normalizeKey(key);
  }

  fail(message, reason) {
    this.state = 'error';
    this.lastError = message;
    this.audit.record({ event: 'tunnel_start_failed', reason: String(reason || message).slice(0, 200) });
    this.onChange();
    return false;
  }

  // Returns true when the job helper was launched (tunnel-client starts inside it). Never throws.
  start(reason = 'user') {
    if (this.child) return true;
    if (!this.canRun()) return this.fail('The dots integration is off; tunnel-client is not started.', 'integration_off');
    const { exePath, profileFile } = this.config();
    if (!exePath || !fs.existsSync(exePath)) return this.fail('tunnel-client.exe is not set or was not found.', 'no_exe');
    if (!profileFile || !fs.existsSync(profileFile)) return this.fail('The tunnel-client profile (YAML) is not set or was not found.', 'no_profile');
    const isolation = checkProfileIsolation(profileFile, undefined, this.platform);
    if (!isolation.ok) return this.fail(isolation.reason, 'wrapper_keeps_key');
    let key;
    try { key = this.loadKey(); } catch (error) { return this.fail(error.message, 'key_unavailable'); }
    // The helper's own environment never holds the key (it comes over stdin, see tunnel-job.js).
    const env = { ...this.baseEnv() };
    // ... nor any variable that would make tunnel-client load another profile or add MCP commands
    // that bypass the wrapper check (env overrides the YAML).
    for (const name of Object.keys(env)) {
      const n = name.toUpperCase();
      if (n === KEY_ENV || n.startsWith('TUNNEL_CLIENT_') || n.startsWith('MCP_') || n.startsWith('CONTROL_PLANE_') || n.startsWith('HARPOON_')) delete env[name];
    }
    let logPath = null;
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true, mode: 0o700 });
      let size = 0;
      try { size = fs.statSync(this.logPath).size; } catch {}
      if (size > LOG_MAX_BYTES) fs.writeFileSync(this.logPath, '', { mode: 0o600 });
      fs.appendFileSync(this.logPath, `\n--- ${new Date(this.now()).toISOString()} start (${reason}) ---\n`, { mode: 0o600 });
      logPath = this.logPath;
    } catch { logPath = null; }
    let child;
    try {
      child = this.spawnImpl('powershell.exe', helperArgs(), { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.stdin.on('error', () => {});
      for (const line of requestLines({
        exe: exePath,
        cwd: path.dirname(exePath),
        args: ['run', '--profile-file', profileFile, '--control-plane.api-key', `env:${KEY_ENV}`],
        logPath,
        logMax: LOG_MAX_BYTES,
        parentPid: this.parentPid,
        key
      })) child.stdin.write(`${line}\n`);
      // stdin stays open: its EOF (Workbench gone) is what makes the helper end the job.
    } catch (error) {
      if (child) { try { this.killTree(child.pid); } catch {} }
      return this.fail(`tunnel-client could not be started: ${error.message || error}`, 'spawn_failed');
    } finally {
      key = null;
    }
    this.child = child;
    this.state = 'starting';
    this.tunnelPid = null;
    this.startedAt = this.now();
    this.lastError = null;
    let helperError = null;
    let exitCode = null;
    let pending = '';
    if (child.stdout) {
      child.stdout.setEncoding && child.stdout.setEncoding('ascii');
      child.stdout.on('data', (data) => {
        pending += data;
        if (pending.length > 65536) pending = pending.slice(-65536);
        let nl;
        while ((nl = pending.indexOf('\n')) >= 0) {
          const ev = parseHelperLine(pending.slice(0, nl));
          pending = pending.slice(nl + 1);
          if (!ev || this.child !== child) continue;
          if (ev.type === 'started') {
            this.state = 'running';
            this.tunnelPid = ev.pid;
            this.audit.record({ event: 'tunnel_running', pid: ev.pid });
            this.onChange();
          } else if (ev.type === 'error') helperError = ev;
          else if (ev.type === 'exit') exitCode = ev.code;
        }
      });
    }
    if (child.stderr) child.stderr.on('data', () => {}); // compiler / host noise; never the key
    let ended = false;
    const end = (code, signal, error) => {
      if (ended) return;
      ended = true;
      if (this.child === child) this.child = null;
      if (this.child) return; // a newer tunnel-client already runs; this exit is old news
      this.tunnelPid = null;
      const expected = this.stoppedChildren.has(child);
      const tunnelCode = exitCode != null ? exitCode : code;
      this.lastExit = { code: tunnelCode == null ? null : tunnelCode, signal: signal || null, at: this.now() };
      if (error) {
        this.state = 'error';
        this.lastError = `tunnel-client could not be started: ${error.message || error}`;
        this.audit.record({ event: 'tunnel_start_failed', reason: String(error.code || error.message || error).slice(0, 200) });
      } else if (expected) {
        this.state = 'stopped';
      } else if (helperError) {
        this.state = 'error';
        this.lastError = helperError.code === 'already_running'
          ? `Another tunnel-client is already running (pid ${helperError.detail}); stop it first.`
          : `tunnel-client could not be started (${helperError.code}${helperError.detail ? `: ${helperError.detail}` : ''}).`;
        this.audit.record({ event: 'tunnel_start_failed', reason: helperError.code });
      } else {
        this.state = 'exited';
        this.lastError = `tunnel-client exited (code ${tunnelCode == null ? signal : tunnelCode}).`;
        this.audit.record({ event: 'tunnel_exited', code: tunnelCode == null ? String(signal) : tunnelCode });
      }
      this.onChange();
    };
    child.once('error', (error) => end(null, null, error));
    child.once('exit', (code, signal) => end(code, signal, null));
    this.audit.record({ event: 'tunnel_started', reason, pid: child.pid });
    this.onChange();
    return true;
  }

  // Returns true when tunnel-client (and its process tree) was ended. On failure the child stays
  // tracked (still 'running', so Stop can be retried) and lastError says why.
  stop(reason = 'user') {
    const child = this.child;
    if (!child) return true;
    this.stoppedChildren.add(child);
    let killed = false;
    // Only a whole-tree kill counts: ending tunnel-client alone could leave its adapter running.
    try { killed = !!(child.pid && this.killTree(child.pid)); } catch { killed = false; }
    if (!killed) {
      this.stoppedChildren.delete(child);
      this.lastError = `tunnel-client (pid ${child.pid}) could not be stopped.`;
      this.audit.record({ event: 'tunnel_stop_failed', reason, pid: child.pid });
      this.onChange();
      return false;
    }
    this.audit.record({ event: 'tunnel_stopped', reason, pid: child.pid });
    // The 'exit' event finishes the bookkeeping; mark it now so a quitting app reports it right.
    this.child = null;
    this.state = 'stopped';
    this.onChange();
    return true;
  }

  // App start / integration turned on: start only when the user opted in.
  autoStart() {
    if (!this.config().autoStart || this.running) return false;
    return this.start('auto');
  }

  status() {
    const c = this.config();
    return {
      state: this.state,
      pid: this.child ? this.tunnelPid : null,
      helperPid: this.child ? this.child.pid : null,
      startedAt: this.child ? this.startedAt : null,
      lastExit: this.lastExit,
      lastError: this.lastError,
      hasKey: this.hasKey(),
      encryptionAvailable: this.encryptionAvailable(),
      autoStart: c.autoStart,
      exePath: c.exePath,
      profileFile: c.profileFile,
      logPath: this.logPath
    };
  }
}

module.exports = { TunnelRunner, normalizeKey, defaultKillTree, wrapperClearsKey, profileCommands, checkProfileIsolation, KEY_FILE, KEY_ENV };
