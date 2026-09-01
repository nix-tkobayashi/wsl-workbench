# WSL Workbench — Windows Notification Bridge (issue #73, Phase 1).
#
# Reads the Windows 11 notification center through the WinRT UserNotificationListener and streams
# every toast (Slack, Outlook, Teams, ...) to the Electron main process as NDJSON on stdout:
#   {"type":"status","status":"starting|permission_required|ready"}
#   {"type":"notification","event":"existing|added|removed","id":481,"app":"Slack","appId":"...",
#    "title":"...","body":"...","timestamp":1787922630000,"payload":"<toast ...>...</toast>"}
#   {"type":"error","code":"ACCESS_DENIED|LISTENER_UNAVAILABLE|POLL_FAILED","message":"..."}
# stdout is protocol only; diagnostics go to stderr.
#
# `payload` is the raw toast XML from the Windows notification database (wpndatabase.db), which
# keeps what the listener API drops: the activation deep link (launch="slack://channel?id=...&
# team=...") and the toast header (Slack workspace name). Read-only through the in-box
# winsqlite3.dll — no dependency to ship — and best-effort: any failure means an empty payload,
# never a dropped notification.
#
# Why PowerShell instead of the C# helper the design sketches: it needs no .NET SDK, no build step
# and no package identity, so the portable and NSIS builds ship the same single file. The price is
# that NotificationChanged never fires for an unpackaged process, so the listener is polled (the
# call is cheap — one WinRT query every PollMs; CPU stays ~0%). Verified on Windows 11 26200:
# RequestAccessAsync / GetNotificationsAsync work from plain Windows PowerShell 5.1 without a
# package identity or UI thread (access is granted per host process, Settings > Privacy & security
# > Notifications > "Let apps access notifications").
param(
  [int]$ParentPid = 0,           # exit when this process is gone (the Electron main process)
  [int]$PollMs = 2000,
  [string]$IgnoreApp = ''        # our own toasts: they already exist as terminal notifications
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$out = [Console]::Out

function Emit([hashtable]$msg) {
  $out.WriteLine(($msg | ConvertTo-Json -Compress -Depth 4))
  $out.Flush()
}
function Diag([string]$text) { [Console]::Error.WriteLine("[notification-bridge] $text") }
function ParentAlive {
  if ($ParentPid -le 0) { return $true }
  try { $null = Get-Process -Id $ParentPid -ErrorAction Stop; return $true } catch { return $false }
}

Emit @{ type = 'status'; status = 'starting' }

try {
  $null = [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.Foundation.IAsyncOperation`1, Windows.Foundation, ContentType = WindowsRuntime]
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
  $listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
} catch {
  Emit @{ type = 'error'; code = 'LISTENER_UNAVAILABLE'; message = "$($_.Exception.Message)" }
  exit 2
}

function Await($op, [type]$resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
  $task.Wait()
  return $task.Result
}

$accessType = [Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus]
$listType = [System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]]

# --- Toast payload lookup (issue #75). The listener's UserNotification.Id IS Notification.Id in
# %LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db (verified on Windows 11 26200), so
# the raw toast XML is one indexed SELECT away. WAL-mode concurrent readers are SQLite's normal
# case; the connection is opened read-only per poll batch and closed right after.
$WPN_DB = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Notifications\wpndatabase.db'
$PAYLOAD_MAX = 65536
$script:sqliteReady = $false
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WinSqlite {
  [DllImport("winsqlite3.dll", EntryPoint="sqlite3_open_v2", CallingConvention=CallingConvention.Cdecl)]
  public static extern int Open(byte[] filename, out IntPtr db, int flags, IntPtr vfs);
  [DllImport("winsqlite3.dll", EntryPoint="sqlite3_close_v2", CallingConvention=CallingConvention.Cdecl)]
  public static extern int Close(IntPtr db);
  [DllImport("winsqlite3.dll", EntryPoint="sqlite3_prepare_v2", CallingConvention=CallingConvention.Cdecl)]
  public static extern int Prepare(IntPtr db, byte[] sql, int nByte, out IntPtr stmt, IntPtr tail);
  [DllImport("winsqlite3.dll", EntryPoint="sqlite3_step", CallingConvention=CallingConvention.Cdecl)]
  public static extern int Step(IntPtr stmt);
  [DllImport("winsqlite3.dll", EntryPoint="sqlite3_finalize", CallingConvention=CallingConvention.Cdecl)]
  public static extern int Finalize(IntPtr stmt);
  [DllImport("winsqlite3.dll", EntryPoint="sqlite3_column_blob", CallingConvention=CallingConvention.Cdecl)]
  public static extern IntPtr ColumnBlob(IntPtr stmt, int col);
  [DllImport("winsqlite3.dll", EntryPoint="sqlite3_column_bytes", CallingConvention=CallingConvention.Cdecl)]
  public static extern int ColumnBytes(IntPtr stmt, int col);
}
'@
  $script:sqliteReady = (Test-Path $WPN_DB)
  if (-not $script:sqliteReady) { Diag "wpndatabase.db not found; notifications carry no payload" }
} catch {
  Diag "winsqlite3 unavailable ($($_.Exception.Message)); notifications carry no payload"
}

function Utf8Z([string]$s) { [System.Text.Encoding]::UTF8.GetBytes($s + [char]0) }

# id → toast XML string for the given notification ids; ids without a row (already purged) or with
# an oversized payload are simply absent from the result.
function LookupPayloads($ids) {
  $map = @{}
  if (-not $script:sqliteReady -or @($ids).Count -eq 0) { return $map }
  $db = [IntPtr]::Zero
  try {
    if ([WinSqlite]::Open((Utf8Z $WPN_DB), [ref]$db, 1, [IntPtr]::Zero) -ne 0) { return $map } # 1 = SQLITE_OPEN_READONLY
    foreach ($id in @($ids)) {
      $stmt = [IntPtr]::Zero
      try {
        if ([WinSqlite]::Prepare($db, (Utf8Z "SELECT Payload FROM Notification WHERE Id = $([long]$id)"), -1, [ref]$stmt, [IntPtr]::Zero) -ne 0) { continue }
        if ([WinSqlite]::Step($stmt) -ne 100) { continue } # 100 = SQLITE_ROW
        $n = [WinSqlite]::ColumnBytes($stmt, 0)
        if ($n -le 0 -or $n -gt $PAYLOAD_MAX) { continue }
        $buf = New-Object byte[] $n
        [System.Runtime.InteropServices.Marshal]::Copy([WinSqlite]::ColumnBlob($stmt, 0), $buf, 0, $n)
        $map[[long]$id] = [System.Text.Encoding]::UTF8.GetString($buf)
      } catch {
        Diag "payload lookup failed for $($id): $($_.Exception.Message)"
      } finally {
        if ($stmt -ne [IntPtr]::Zero) { $null = [WinSqlite]::Finalize($stmt) }
      }
    }
  } catch {
    Diag "payload lookup failed: $($_.Exception.Message)"
  } finally {
    if ($db -ne [IntPtr]::Zero) { $null = [WinSqlite]::Close($db) }
  }
  return $map
}

$access = Await $listener.RequestAccessAsync() $accessType
if ("$access" -ne 'Allowed') {
  Emit @{ type = 'status'; status = 'permission_required' }
  Emit @{ type = 'error'; code = 'ACCESS_DENIED'; message = "Notification access is $access. Enable it under Settings > Privacy & security > Notifications." }
  exit 3
}

function ToMessage($n, [string]$event) {
  $texts = @()
  try {
    $binding = $n.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
    if ($binding) { $texts = @($binding.GetTextElements() | ForEach-Object { "$($_.Text)".Trim() } | Where-Object { $_ }) }
  } catch { Diag "text elements unavailable for $($n.Id): $($_.Exception.Message)" }
  $title = if ($texts.Count -gt 0) { $texts[0] } else { '' }
  $body = if ($texts.Count -gt 1) { ($texts[1..($texts.Count - 1)] -join "`n") } else { '' }
  $appName = ''; $appId = ''
  try { $appName = "$($n.AppInfo.DisplayInfo.DisplayName)"; $appId = "$($n.AppInfo.AppUserModelId)" } catch {}
  $ts = 0
  try { $ts = [long]([DateTimeOffset]$n.CreationTime).ToUnixTimeMilliseconds() } catch {}
  return @{ type = 'notification'; event = $event; id = [long]$n.Id; app = $appName; appId = $appId; title = $title; body = $body; timestamp = $ts; payload = '' }
}

# Snapshot → existing, then diff every poll: new ids → added, vanished ids → removed.
$known = @{}
$first = $true
$failures = 0
while (ParentAlive) {
  try {
    $list = Await $listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast) $listType
    $seen = @{}
    $fresh = @()
    foreach ($n in $list) {
      $seen[[long]$n.Id] = $true
      if ($known.ContainsKey([long]$n.Id)) { continue }
      $known[[long]$n.Id] = $true
      $msg = ToMessage $n $(if ($first) { 'existing' } else { 'added' })
      if ($IgnoreApp -and $msg.app -eq $IgnoreApp) { continue }
      $fresh += , $msg
    }
    if ($fresh.Count -gt 0) {
      $payloads = LookupPayloads(@($fresh | ForEach-Object { $_.id }))
      foreach ($msg in $fresh) {
        if ($payloads.ContainsKey($msg.id)) { $msg.payload = $payloads[$msg.id] }
        Emit $msg
      }
    }
    foreach ($id in @($known.Keys)) {
      if (-not $seen.ContainsKey($id)) { $known.Remove($id); Emit @{ type = 'notification'; event = 'removed'; id = [long]$id } }
    }
    if ($first) { $first = $false; Emit @{ type = 'status'; status = 'ready' } }
    $failures = 0
  } catch {
    $failures++
    Diag "poll failed ($failures): $($_.Exception.Message)"
    if ($failures -ge 5) { Emit @{ type = 'error'; code = 'POLL_FAILED'; message = "$($_.Exception.Message)" }; exit 4 }
  }
  Start-Sleep -Milliseconds $PollMs
}
Diag 'parent process gone, exiting'
exit 0
