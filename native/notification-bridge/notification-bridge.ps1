# WSL Workbench — Windows Notification Bridge (issue #73, Phase 1).
#
# Reads the Windows 11 notification center through the WinRT UserNotificationListener and streams
# every toast (Slack, Outlook, Teams, ...) to the Electron main process as NDJSON on stdout:
#   {"type":"status","status":"starting|permission_required|ready"}
#   {"type":"notification","event":"existing|added|removed","id":481,"app":"Slack","appId":"...",
#    "title":"...","body":"...","timestamp":1787922630000}
#   {"type":"error","code":"ACCESS_DENIED|LISTENER_UNAVAILABLE|POLL_FAILED","message":"..."}
# stdout is protocol only; diagnostics go to stderr.
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
  return @{ type = 'notification'; event = $event; id = [long]$n.Id; app = $appName; appId = $appId; title = $title; body = $body; timestamp = $ts }
}

# Snapshot → existing, then diff every poll: new ids → added, vanished ids → removed.
$known = @{}
$first = $true
$failures = 0
while (ParentAlive) {
  try {
    $list = Await $listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast) $listType
    $seen = @{}
    foreach ($n in $list) {
      $seen[[long]$n.Id] = $true
      if ($known.ContainsKey([long]$n.Id)) { continue }
      $known[[long]$n.Id] = $true
      $msg = ToMessage $n $(if ($first) { 'existing' } else { 'added' })
      if ($IgnoreApp -and $msg.app -eq $IgnoreApp) { continue }
      Emit $msg
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
