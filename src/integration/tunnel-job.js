// Windows: launch tunnel-client inside a Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, so the
// whole tree (tunnel-client, the adapter wrapper it starts, everything below) ends when Workbench
// ends — also when Workbench crashes or is killed, not only on a normal quit.
//
// Node cannot create job objects, so a small helper does it with the official Win32 APIs
// (CreateJobObjectW / SetInformationJobObject / AssignProcessToJobObject), compiled on the fly by
// Windows PowerShell's Add-Type (C#, .NET Framework — same approach as pipe-relay.js). The helper
// puts ITSELF in the job before starting tunnel-client, so every descendant is in the job from its
// first instruction (no breakaway allowed). The helper holds the only job handle; the handle closes
// when the helper exits for any reason, and Windows then kills everything left in the job.
// The helper ends (and with it the job) when:
//   - its stdin reaches EOF or receives STOP (Workbench quit, crashed, or was killed: the OS closes
//     Workbench's end of the pipe),
//   - the Workbench process (PARENT pid) exits — a second, independent watch,
//   - tunnel-client exits by itself.
//
// main -> helper (stdin, one line each, values base64 UTF-8):
//   "EXE <b64>" "CWD <b64>" "CMDLINE <b64>" "LOG <b64>" "LOGMAX <n>" "PARENT <pid>" "KEY <b64>" "GO"
//   then nothing (EOF / STOP = stop).
// helper -> main (stdout): "STARTED <pid>" | "ERROR <code> [<detail>]" | "EXIT <code>".
// The key is read from stdin and put only into tunnel-client's environment block; it is never in
// the helper's argv or environment, nor in any log line.
// Before starting, the helper refuses when any tunnel-client process already runs for this user
// session (ERROR already_running <pids>), so a restart can never run two tunnels side by side.

const HELPER_CS = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class WswbTunnelJob {
  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct IO_COUNTERS {
    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll")]
  private static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

  private const int JobObjectExtendedLimitInformation = 9;
  private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
  private const uint HANDLE_FLAG_INHERIT = 1;
  private static readonly object OutLock = new object();
  private static readonly object LogLock = new object();
  private static Stream Out;
  private static IntPtr Job = IntPtr.Zero;
  private static FileStream Log;
  private static long LogLeft;

  private static void Emit(string line) {
    byte[] b = Encoding.ASCII.GetBytes(line + "\n");
    lock (OutLock) { try { Out.Write(b, 0, b.Length); Out.Flush(); } catch (Exception) { } }
  }

  private static string Dec(string b64) { return Encoding.UTF8.GetString(Convert.FromBase64String(b64)); }

  private static void EndAll() {
    if (Job != IntPtr.Zero) TerminateJobObject(Job, 1); // ends this helper too
    Environment.Exit(1);
  }

  private static void ToLog(string line) {
    if (line == null || Log == null) return;
    byte[] b = Encoding.UTF8.GetBytes(line + "\n");
    lock (LogLock) {
      if (LogLeft <= 0) return;
      try { Log.Write(b, 0, b.Length); Log.Flush(); LogLeft -= b.Length; } catch (Exception) { }
    }
  }

  public static int Run() {
    Out = Console.OpenStandardOutput();
    StreamReader input = new StreamReader(Console.OpenStandardInput(), Encoding.ASCII);
    string exe = null, cwd = null, cmdline = "", logPath = null, key = null;
    int parent = 0;
    long logMax = 5 * 1024 * 1024;
    while (true) {
      string line = input.ReadLine();
      if (line == null) return 1; // Workbench went away before GO
      if (line == "GO") break;
      int sp = line.IndexOf(' ');
      string k = sp < 0 ? line : line.Substring(0, sp);
      string v = sp < 0 ? "" : line.Substring(sp + 1);
      try {
        if (k == "EXE") exe = Dec(v);
        else if (k == "CWD") cwd = Dec(v);
        else if (k == "CMDLINE") cmdline = Dec(v);
        else if (k == "LOG") logPath = Dec(v);
        else if (k == "LOGMAX") logMax = long.Parse(v);
        else if (k == "PARENT") parent = int.Parse(v);
        else if (k == "KEY") key = Dec(v);
      } catch (Exception) { Emit("ERROR bad_request"); return 2; }
    }
    if (exe == null || key == null || parent <= 0) { Emit("ERROR bad_request"); return 2; }

    // Never two tunnels: any tunnel-client still running (a manual one, or a leftover) blocks the start.
    List<string> running = new List<string>();
    foreach (Process p in Process.GetProcessesByName("tunnel-client")) { running.Add(p.Id.ToString()); }
    if (running.Count > 0) { Emit("ERROR already_running " + string.Join(",", running.ToArray())); return 3; }

    Process watched;
    try { watched = Process.GetProcessById(parent); } catch (Exception) { Emit("ERROR parent_gone"); return 4; }

    Job = CreateJobObjectW(IntPtr.Zero, null);
    if (Job == IntPtr.Zero) { Emit("ERROR job_create " + Marshal.GetLastWin32Error()); return 5; }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(Job, JobObjectExtendedLimitInformation, ref info, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) {
      Emit("ERROR job_limit " + Marshal.GetLastWin32Error()); return 5;
    }
    if (!AssignProcessToJobObject(Job, GetCurrentProcess())) { Emit("ERROR job_assign " + Marshal.GetLastWin32Error()); return 5; }

    // tunnel-client gets its own redirected stdio; it must not inherit Workbench's pipe ends.
    for (int which = -10; which >= -12; which--) {
      IntPtr h = GetStdHandle(which);
      if (h != IntPtr.Zero && h != new IntPtr(-1)) SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0);
    }

    if (logPath != null) {
      try { Log = new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite); LogLeft = logMax; } catch (Exception) { Log = null; }
    }

    ProcessStartInfo psi = new ProcessStartInfo(exe, cmdline);
    psi.UseShellExecute = false;
    psi.CreateNoWindow = true;
    psi.RedirectStandardInput = true;
    psi.RedirectStandardOutput = true;
    psi.RedirectStandardError = true;
    if (cwd != null) psi.WorkingDirectory = cwd;
    psi.EnvironmentVariables["CONTROL_PLANE_API_KEY"] = key;
    key = null;
    Process child = new Process();
    child.StartInfo = psi;
    child.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { ToLog(e.Data); };
    child.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { ToLog(e.Data); };
    try { child.Start(); } catch (Exception e) { Emit("ERROR start_failed " + Convert.ToBase64String(Encoding.UTF8.GetBytes(e.Message))); return 6; }
    psi.EnvironmentVariables.Remove("CONTROL_PLANE_API_KEY");
    child.BeginOutputReadLine();
    child.BeginErrorReadLine();
    Emit("STARTED " + child.Id);

    Thread stdinWatch = new Thread(delegate() {
      try {
        while (true) {
          string l = input.ReadLine();
          if (l == null || l == "STOP") break;
        }
      } catch (Exception) { }
      EndAll();
    });
    stdinWatch.IsBackground = true;
    stdinWatch.Start();
    Thread parentWatch = new Thread(delegate() {
      try { watched.WaitForExit(); } catch (Exception) { }
      EndAll();
    });
    parentWatch.IsBackground = true;
    parentWatch.Start();

    child.WaitForExit();
    Emit("EXIT " + child.ExitCode);
    return 0; // the job handle closes with this process: whatever tunnel-client left behind ends too
  }
}
`;

function encodedCommand() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    HELPER_CS,
    "'@",
    'exit [WswbTunnelJob]::Run()'
  ].join('\n');
  return Buffer.from(script, 'utf16le').toString('base64');
}

function helperArgs() { return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand()]; }

// CommandLineToArgvW / MSVCRT quoting for one argument.
function quoteWindowsArg(arg) {
  const s = String(arg);
  if (s && !/[\s"]/.test(s)) return s;
  let out = '"';
  let backslashes = 0;
  for (const ch of s) {
    if (ch === '\\') { backslashes++; continue; }
    if (ch === '"') { out += '\\'.repeat(backslashes * 2 + 1) + '"'; backslashes = 0; continue; }
    out += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`;
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

// The request lines main writes to the helper's stdin (the key last, then GO).
function requestLines({ exe, cwd, args, logPath, logMax, parentPid, key }) {
  const lines = [`EXE ${b64(exe)}`, `CWD ${b64(cwd)}`, `CMDLINE ${b64(args.map(quoteWindowsArg).join(' '))}`];
  if (logPath) lines.push(`LOG ${b64(logPath)}`, `LOGMAX ${Number(logMax) | 0}`);
  lines.push(`PARENT ${Number(parentPid) | 0}`, `KEY ${b64(key)}`, 'GO');
  return lines;
}

// helper stdout line -> event
function parseHelperLine(line) {
  const parts = String(line).trim().split(' ');
  if (parts[0] === 'STARTED' && /^\d+$/.test(parts[1] || '')) return { type: 'started', pid: Number(parts[1]) };
  if (parts[0] === 'EXIT' && /^-?\d+$/.test(parts[1] || '')) return { type: 'exit', code: Number(parts[1]) };
  if (parts[0] === 'ERROR' && /^[a-z_]{1,40}$/.test(parts[1] || '')) {
    let detail = parts.slice(2).join(' ');
    if (parts[1] === 'start_failed') { try { detail = Buffer.from(detail, 'base64').toString('utf8'); } catch {} }
    return { type: 'error', code: parts[1], detail: detail.slice(0, 200) };
  }
  return null;
}

module.exports = { HELPER_CS, encodedCommand, helperArgs, quoteWindowsArg, requestLines, parseHelperLine };
