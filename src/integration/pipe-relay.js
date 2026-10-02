// Windows: a named pipe whose DACL admits ONLY the current user (and explicitly denies NETWORK
// logons), created with PIPE_REJECT_REMOTE_CLIENTS and FILE_FLAG_FIRST_PIPE_INSTANCE.
//
// Node/libuv cannot set a pipe's security descriptor, so a small helper does it with the official
// Win32 APIs (CreateNamedPipeW + ConvertStringSecurityDescriptorToSecurityDescriptorW), compiled
// on the fly by Windows PowerShell's Add-Type (C#, .NET Framework — no extra install). The helper
// is a CHILD of the main process: main talks to it over the child's stdio (anonymous pipes), so
// the relay itself is not reachable by anyone else. It frames each pipe client as a connection id:
//   helper -> main: "READY <sid> <sddl>" | "O <id>" | "D <id> <base64>" | "C <id>" | "E <base64 message>"
//   main -> helper: "D <id> <base64>" | "C <id>"
// Before any client is accepted the helper reads the pipe's DACL back and main verifies it is
// exactly { deny NETWORK, allow <current user SID> }, protected (no inheritance), and that the
// helper runs as that same SID. Any failure rejects the listener (the caller keeps input off).
// The existing mutual HMAC handshake still runs inside every relayed connection.

const { spawn } = require('child_process');
const { Duplex } = require('stream');

const HELPER_CS = String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class WswbPipeRelay {
  [StructLayout(LayoutKind.Sequential)]
  private struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern SafePipeHandle CreateNamedPipeW(string name, uint openMode, uint pipeMode, uint maxInstances, uint outSize, uint inSize, uint timeout, ref SECURITY_ATTRIBUTES sa);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr sd, IntPtr size);
  [DllImport("kernel32.dll")]
  private static extern IntPtr LocalFree(IntPtr mem);

  private const uint PIPE_ACCESS_DUPLEX = 0x3;
  private const uint FILE_FLAG_OVERLAPPED = 0x40000000;
  private const uint FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
  private const uint PIPE_REJECT_REMOTE_CLIENTS = 0x8;
  private static readonly object OutLock = new object();
  private static readonly Dictionary<int, NamedPipeServerStream> Conns = new Dictionary<int, NamedPipeServerStream>();
  private static Stream Out;
  private static int NextId = 1;
  private static int MaxConns = 4;
  private static string PipePath;
  private static string Sddl;

  private static string B64(string s) { return Convert.ToBase64String(Encoding.UTF8.GetBytes(s ?? "")); }

  private static void Emit(string line) {
    byte[] b = Encoding.ASCII.GetBytes(line + "\n");
    lock (OutLock) { Out.Write(b, 0, b.Length); Out.Flush(); }
  }

  private static NamedPipeServerStream Create(bool first) {
    IntPtr sd;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(Sddl, 1, out sd, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
      sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
      sa.lpSecurityDescriptor = sd;
      sa.bInheritHandle = 0;
      uint open = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0);
      SafePipeHandle h = CreateNamedPipeW(PipePath, open, PIPE_REJECT_REMOTE_CLIENTS, (uint)MaxConns, 65536, 65536, 0, ref sa);
      if (h.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      return new NamedPipeServerStream(PipeDirection.InOut, true, false, h);
    } finally {
      LocalFree(sd);
    }
  }

  private static void Pump(int id, NamedPipeServerStream conn) {
    byte[] buf = new byte[16384];
    try {
      while (true) {
        int n = conn.Read(buf, 0, buf.Length);
        if (n <= 0) break;
        Emit("D " + id + " " + Convert.ToBase64String(buf, 0, n));
      }
    } catch (Exception) {
    } finally {
      bool present;
      lock (Conns) { present = Conns.Remove(id); }
      if (present) Emit("C " + id);
      try { conn.Dispose(); } catch (Exception) { }
    }
  }

  private static void ReadStdin() {
    StreamReader r = new StreamReader(Console.OpenStandardInput(), Encoding.ASCII);
    while (true) {
      string line = r.ReadLine();
      if (line == null) Environment.Exit(0);
      string[] p = line.Split(' ');
      if (p.Length < 2) continue;
      int id;
      if (!int.TryParse(p[1], out id)) continue;
      NamedPipeServerStream conn;
      lock (Conns) { if (!Conns.TryGetValue(id, out conn)) conn = null; }
      if (conn == null) continue;
      if (p[0] == "D" && p.Length == 3) {
        try { byte[] data = Convert.FromBase64String(p[2]); conn.Write(data, 0, data.Length); conn.Flush(); }
        catch (Exception) { Close(id, conn); }
      } else if (p[0] == "C") {
        Close(id, conn);
      }
    }
  }

  private static void Close(int id, NamedPipeServerStream conn) {
    lock (Conns) { Conns.Remove(id); }
    try { conn.Dispose(); } catch (Exception) { }
  }

  public static int Run(string pipePath, string sddl, int maxConns) {
    PipePath = pipePath;
    Sddl = sddl;
    MaxConns = maxConns;
    Out = Console.OpenStandardOutput();
    NamedPipeServerStream next;
    try {
      next = Create(true);
      string actual = next.GetAccessControl().GetSecurityDescriptorSddlForm(AccessControlSections.Access);
      Emit("READY " + WindowsIdentity.GetCurrent().User.Value + " " + actual);
    } catch (Exception e) {
      Emit("E " + B64(e.Message));
      return 2;
    }
    Thread input = new Thread(ReadStdin);
    input.IsBackground = true;
    input.Start();
    while (true) {
      try { next.WaitForConnection(); } catch (Exception e) { Emit("E " + B64(e.Message)); return 3; }
      int id;
      lock (Conns) { id = NextId++; Conns[id] = next; }
      Emit("O " + id);
      NamedPipeServerStream conn = next;
      int cid = id;
      Thread t = new Thread(delegate() { Pump(cid, conn); });
      t.IsBackground = true;
      t.Start();
      while (true) {
        lock (Conns) { if (Conns.Count < MaxConns) break; }
        Thread.Sleep(200);
      }
      try { next = Create(false); } catch (Exception e) { Emit("E " + B64(e.Message)); return 4; }
    }
  }
}
`;

const SID_RE = /^S-1-5-21-\d+-\d+-\d+-\d+$/;
const isFullRights = (r) => r === 'FA' || r === 'GA' || String(r).toLowerCase() === '0x1f01ff';

function sddlFor(sid) { return `D:P(D;;FA;;;NU)(A;;FA;;;${sid})`; }

// Verify the DACL read back from the live pipe: protected, exactly deny NETWORK + allow <sid>.
function verifyDacl(sddl, sid) {
  const m = /^D:([A-Z]*)((?:\([^)]*\))*)$/.exec(String(sddl || '').trim());
  if (!m || !m[1].includes('P')) return { ok: false, reason: 'DACL is not protected' };
  const aces = [...m[2].matchAll(/\(([^)]*)\)/g)].map((x) => x[1].split(';'));
  if (aces.length !== 2) return { ok: false, reason: `expected 2 ACEs, found ${aces.length}` };
  const deny = aces.find((a) => a[0] === 'D');
  const allow = aces.find((a) => a[0] === 'A');
  if (!deny || !['NU', 'S-1-5-2'].includes(deny[5]) || !isFullRights(deny[2])) return { ok: false, reason: 'NETWORK deny ACE missing' };
  if (!allow || allow[5] !== sid || !isFullRights(allow[2])) return { ok: false, reason: 'user allow ACE missing' };
  if (deny[1] || allow[1]) return { ok: false, reason: 'unexpected ACE flags' };
  return { ok: true };
}

function encodedCommand(pipePath, sid, maxConnections) {
  if (!/^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/.test(pipePath)) throw new Error('Invalid pipe path.');
  if (!SID_RE.test(sid)) throw new Error('Invalid user SID.');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    HELPER_CS,
    "'@",
    `exit [WswbPipeRelay]::Run('${pipePath}', '${sddlFor(sid)}', ${Number(maxConnections) | 0})`
  ].join('\n');
  return Buffer.from(script, 'utf16le').toString('base64');
}

class RelayConnection extends Duplex {
  constructor(id, sendLine) {
    super();
    this.relayId = id;
    this.sendLine = sendLine;
    this.remoteClosed = false;
  }
  _read() {}
  _write(chunk, _enc, cb) {
    this.sendLine(`D ${this.relayId} ${Buffer.from(chunk).toString('base64')}`);
    cb();
  }
  _final(cb) { cb(); }
  _destroy(err, cb) {
    if (!this.remoteClosed) this.sendLine(`C ${this.relayId}`);
    cb(err);
  }
}

// Returns a listenWith(onConnection) for createBrokerServer. Rejects unless the DACL verified.
function createSecurePipeListener({ pipePath, sid, maxConnections = 4, spawnFn = spawn, readyTimeoutMs = 45000, onLog = () => {} }) {
  return (onConnection) => new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand(pipePath, sid, maxConnections)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    const conns = new Map();
    let ready = false;
    let settled = false;
    let pending = '';
    const sendLine = (line) => { if (child.stdin.writable) child.stdin.write(`${line}\n`); };
    const settle = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    const kill = () => { try { child.kill(); } catch {} };
    const timer = setTimeout(() => { kill(); settle(reject, new Error('The secure pipe helper did not start in time.')); }, readyTimeoutMs);

    child.on('error', (error) => settle(reject, error));
    child.on('exit', (code) => {
      for (const conn of conns.values()) { conn.remoteClosed = true; conn.destroy(); }
      conns.clear();
      settle(reject, new Error(`The secure pipe helper exited (${code}).`));
      if (ready) onLog({ event: 'relay_exited', reason: String(code) });
    });
    child.stderr.on('data', () => {}); // compiler / host noise; never contains client data
    child.stdout.setEncoding('ascii');
    child.stdout.on('data', (data) => {
      pending += data;
      if (pending.length > 4 * 1024 * 1024 && !pending.includes('\n')) { kill(); return; }
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl).replace(/\r$/, '');
        pending = pending.slice(nl + 1);
        handle(line);
      }
    });

    function handle(line) {
      const parts = line.split(' ');
      if (!ready) {
        if (parts[0] === 'READY' && parts.length === 3) {
          const verdict = parts[1] === sid ? verifyDacl(parts[2], sid) : { ok: false, reason: 'helper runs as a different user' };
          if (!verdict.ok) { kill(); settle(reject, new Error(`Pipe DACL verification failed: ${verdict.reason}`)); return; }
          ready = true;
          settle(resolve, {
            sddl: parts[2],
            close: () => { try { child.stdin.end(); } catch {} kill(); }
          });
        } else if (parts[0] === 'E') {
          kill();
          settle(reject, new Error(`Secure pipe helper failed: ${Buffer.from(parts[1] || '', 'base64').toString('utf8')}`));
        }
        return; // ignore host noise before READY
      }
      const id = Number(parts[1]);
      if (!Number.isInteger(id)) return;
      if (parts[0] === 'O') {
        const conn = new RelayConnection(id, sendLine);
        conns.set(id, conn);
        conn.on('close', () => conns.delete(id));
        onConnection(conn);
      } else if (parts[0] === 'D' && parts.length === 3) {
        const conn = conns.get(id);
        if (conn) conn.push(Buffer.from(parts[2], 'base64'));
      } else if (parts[0] === 'C') {
        const conn = conns.get(id);
        if (conn) { conn.remoteClosed = true; conn.push(null); conn.destroy(); }
      }
    }
  });
}

module.exports = { createSecurePipeListener, verifyDacl, sddlFor, encodedCommand, RelayConnection, HELPER_CS };
