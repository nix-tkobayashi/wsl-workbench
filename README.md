# WSL Workbench

Lightweight Windows Electron app for working in WSL:

- Left: WSL file explorer tree (shows the workspace contents directly)
- Upper right: minimal text editor (`Ctrl+S` to save, `Ctrl+F` / `Ctrl+H` find & replace) with
  inline image preview (**Copy Image** button / `Ctrl+C` puts the picture on the clipboard)
- Markdown preview (Preview / Edit toggle): GFM tables, Mermaid diagrams, images referenced by a
  relative path (`![](./shot.png)`) next to the file, and `Ctrl+F` search inside the preview
- Lower right: WSL terminal for Claude Code (◫ splits a tab into up to 8 side-by-side panes)
- Preview tabs like VS Code: a single click in the tree opens the file in a preview tab (italic
  label) that the next single-click reuses; double-click the file or the tab, or edit the buffer, to
  keep it open as a normal tab
- Landing screen on startup / New Window to pick a workspace
- Terminal: right-click to copy (selection) / paste, drag a tree item in to insert its path,
  paste an image with `Ctrl+V` or right-click (Claude Code reads it as `[Image #N]`), and press any key to restart after `exit`
- Files the text editor can't show (binary, or not UTF-8 — `.xlsx`, `.zip`, ...) open as a
  guidance tab with an **Open Anyway** button that shows the raw bytes read-only
- Tree auto-refreshes (files created in the terminal appear without a manual refresh)
- CPU / memory meters at the right of the title bar show the host PC's live usage (updated every
  2 seconds; hover for absolute memory numbers)
- English / Japanese UI (Language menu)
- Drag & drop to move within the tree, or copy in from Windows Explorer
- Multi-select in the tree: `Ctrl`+click / `Shift`+click / `Ctrl+A` (`Esc` clears), then Delete,
  drag to move (or into the terminal to insert all paths), or right-click for Open / Delete /
  Copy Path / Copy Relative Path on every selected item
- Workspace tabs: one window hosts multiple workspaces as tabs (`Ctrl+T` for a new tab). Drag a
  tab out of the window to split it into its own window, or drop it on another window's tab strip
  to merge — terminals and editor state survive the move (the view is re-parented, never reloaded)
- Multi-window; Exit (`Ctrl+W`) closes only the active tab (the window closes with its last tab)
- Resizable left/right and editor/terminal panes

## Download (Windows)

No Node.js needed to run. Grab one of these from the [**latest release**](https://github.com/nix-tkobayashi/wsl-workbench/releases/latest):

- **Installer** — `WSL Workbench Setup <version>.exe` (NSIS). Installs per-user, adds Start Menu / desktop shortcuts, and registers `.wslwb-workspace` files. Recommended.
- **Portable** — `WSL Workbench <version>.exe`. A single self-contained exe; just run it.
- **Zip** — `WSL Workbench-<version>-win.zip`. Extract anywhere and run `WSL Workbench.exe`.

Requires WSL. On first launch, choose a workspace (Open Workspace / Open Workspace File).
The builds are **self-signed**, so Windows may show **"Unknown publisher"** / a SmartScreen warning on first run. To remove it (and to enable in-app updates), trust the publisher once — see [Trusting the publisher](#trusting-the-publisher-unknown-publisher-warning).
Check **Help > About WSL Workbench** for your version and update notifications.

## Run from source

```powershell
npm install
npm start
```

## Test

```powershell
npm test
```

## Build on Windows

```powershell
npm install
npm run dist:zip   # extract-and-run zip -> dist/WSL Workbench-<version>-win.zip
npm run dist       # NSIS installer + portable exe
```

Output examples:

```text
dist/WSL Workbench-0.4.0-win.zip
dist/WSL Workbench Setup 0.4.0.exe
dist/WSL Workbench 0.4.0.exe
```

## Code signing

Release builds are signed with a **self-signed** certificate (publisher `WSL Workbench`). This is
enough for trusted/internal distribution but does not clear SmartScreen for the general public.

### Trusting the publisher ("Unknown publisher" warning)

On a PC that has not yet trusted the certificate, Windows shows **Publisher: Unknown publisher** (and
a SmartScreen warning) when you run the installer. This is expected for a self-signed build — it is not
a sign that the file is broken. You have two choices:

- **Just install it (quick):** on the SmartScreen prompt choose **More info → Run anyway**. The UAC
  prompt still says "Unknown publisher", but it installs. Note: this path does **not** enable the
  in-app updater (see below).
- **Trust the publisher (recommended):** removes the warning *and* enables in-app updates. Do this once
  per machine:
  1. Download **`wsl-workbench.cer`** from the [latest release](https://github.com/nix-tkobayashi/wsl-workbench/releases/latest).
  2. In the folder containing the `.cer`, open PowerShell and run:

     ```powershell
     Import-Certificate -FilePath .\wsl-workbench.cer -CertStoreLocation Cert:\CurrentUser\Root
     Import-Certificate -FilePath .\wsl-workbench.cer -CertStoreLocation Cert:\CurrentUser\TrustedPublisher
     ```

     The first line pops a **"add to Trusted Root"** confirmation dialog — choose **Yes**. For all users
     instead of the current user, use `Cert:\LocalMachine\…` from an **admin** PowerShell.
  3. Run the installer again — the publisher now shows as **WSL Workbench** and the warning is gone.

> Security note: this trusts a self-signed certificate you (the distributor) created. Only do it for
> builds you trust. The in-app **Help → About → Download and install** updater requires this trust step,
> because it refuses to run an installer whose signature does not chain to a trusted root.

To produce signed builds yourself, create a code-signing cert, export a `.pfx`, and point
electron-builder at it via env vars (never commit the `.pfx`):

```powershell
$env:CSC_LINK="C:\path\to\wsl-workbench.pfx"
$env:CSC_KEY_PASSWORD="<pfx password>"
npm run dist        # and/or: npm run dist:zip
```

For public distribution without the trust step, use a CA-issued OV/EV certificate or Azure Trusted Signing.

## Defaults

```text
Distro: Ubuntu
Path: /home/<user>/projects
```

Override:

```powershell
$env:WSLWB_DISTRO="Ubuntu"
$env:WSLWB_PATH="/home/<user>/projects/my-repo"
$env:WSLWB_HOME_PATH="/home/<user>"   # default location of the Open Workspace dialog
npm start
```

Opening a folder from another WSL distro (e.g. `Ubuntu-22.04`) is supported — the distro is taken from the selected path.

## dots integration (preview)

Lets an MCP client — intended for **dots** via a plugin and Secure MCP Tunnel — read terminals you
**explicitly share** (stage A) and, when you also allow it, type into the CLI running in them
(stage B). Off by default. Built from the dots integration design handoffs (v1.0 and Stage B
v1.1, kept outside the repo). Security gate record:
[`docs/dots-stage-b-security-gate.md`](docs/dots-stage-b-security-gate.md).
Tunnel / dot setup (Windows, tested): [`docs/dots-adapter-tunnel-setup.md`](docs/dots-adapter-tunnel-setup.md).

```
dot -> plugin -> Secure MCP Tunnel -> MCP adapter (stdio) -> user-only named pipe -> Workbench main (broker / input arbiter) -> existing pane PTY
```

### Reading (stage A)

1. **Integration > Enable dots Integration** (confirmation). Workbench creates a 256-bit pairing
   key in `%APPDATA%\wsl-workbench\integration\pairing.key` (ACL = your user SID, verified with
   `icacls`) and starts the pipe. On Windows the pipe is created by a small helper with a DACL that
   admits only your account and denies network logons (verified at start; see the gate record).
2. Focus a pane, press **⇪** and turn **Read Sharing** ON (confirmation). Each pane has two
   independent switches, both **OFF by default and with no time limit**: *Read Sharing* and
   *Input* (stage B, below). The badge always shows the state — **Sharing OFF** / **Read ON · Input
   OFF** / **Read ON · Input ON** (+ capture paused / AI input paused / confirm pending). The same
   menu pauses / resumes capture and clears retained output.
   - A switch stays ON until you turn it off, the terminal's process ends or the pane closes, the
     integration is turned off, or Workbench exits. Nothing is saved: after a restart or a restored
     pane, both switches are OFF.
   - Turning Read Sharing OFF turns Input OFF too, stops capture and discards retained output.
3. **Integration > Connection Status... > Copy Adapter Config** copies an `mcpServers` entry
   (`WSL Workbench.exe` in Node mode + `src/mcp/adapter.js`). No secret is in its args or env.

Tools: `workbench_capabilities`, `workbench_list_sessions`, `workbench_get_session`,
`workbench_read_output` (normalized, untrusted text captured since sharing began; 1 MiB / 10 min per
pane, 16 MiB total, memory only; opaque cursors; explicit gaps; best-effort redaction).

### Typing into an existing CLI (stage B, `api_version` 1.1)

Needs, all at once: the restricted pipe verified (status dialog: *Input transport*), **Integration
> Allow Terminal Input (dots)** turned on (off by default), a healthy operation journal, and per pane:
Read Sharing ON, **⇪ > CLI Input Profile** chosen, then the **⇪ > Input** switch ON (confirmation; no
time limit). Input turns OFF by itself — and must be turned on again — when Read Sharing goes OFF,
the CLI profile changes, or **the shell prompt comes back** (Workbench's shell reports its cwd with
OSC 7 at every prompt, so the CLI the input was approved for has exited); see *Limits of CLI change
detection* below. Turning Input OFF stops any pending AI input (unconfirmed → failed; already
dispatched → `outcome_unknown`, never re-sent). Then `workbench_write_input` and
`workbench_get_operation` are listed (never `run_command` / `cancel_operation`;
`command_execution` stays false).

- Prefer `input_contract: "actions-v1"` with `action.type: "text_and_submit"` and the session's
  `input_profile`. Legacy top-level `text` / `key` still work (single-line).
- Every operation is confirmed in a Workbench dialog: first the text (check the CLI shows its normal
  prompt with an empty input line), then Enter separately (check the input line). Dialogs expire
  after 60 s. Typing in the pane or **Take Over** stops the remaining AI input and pauses AI input
  until **Resume AI Input**.
- `delivered` = the PTY library accepted the bytes; CLI acceptance / completion stay `unknown`.
  Anything stopped after dispatch is `outcome_unknown` and is never re-sent, completed, or undone.
  Re-sending the same `idempotency_key` only looks the operation up (24 h).
- Text: ≤ 8192 UTF-8 bytes, no CR / LF (single-line profiles) / Tab / ESC / C0 / C1 / lone
  surrogates, never normalized. Only profile-verified keys are accepted.
- Journal (`integration\journal\operations.jsonl`): state + keyed digests only, fsync per step,
  HMAC-protected (key in DPAPI); a crash never replays — accepted-only → failed, after intent →
  outcome_unknown. No prompt text in journal, audit, or results.

CLI profiles (measured in an empty temp folder with a new PTY, prompt 「ツールを使わず、OKとだけ返してください」):

| Profile | CLI | Result |
| --- | --- | --- |
| `codex.0.160.composer.single-line` | codex-cli 0.160.0 (WSL2) | text, ~600 ms, `\r` → submitted; text+`\r` in one write → not submitted. Verified (Enter only). |
| `claude-code.2.1.prompt.single-line` | Claude Code 2.1.287 (Windows ConPTY → wsl.exe) | text, ~600 ms, `\r` → submitted; text+`\r` in one write → also submitted (still sent separately). Verified (Enter only), 2026-10-03, in an empty folder the user trusted themselves. |

### Running tunnel-client with Workbench (v0.27.0)

**Integration > Secure MCP Tunnel (tunnel-client)** starts the OpenAI `tunnel-client` in the
background and stops it (with the adapter it launched) when Workbench quits. Off by default.

1. **Choose tunnel-client.exe...** and **Choose Profile (YAML)...** (e.g.
   `%APPDATA%\tunnel-client\wsl-workbench.yaml`). Workbench runs
   `tunnel-client run --profile-file <yaml> --control-plane.api-key env:CONTROL_PLANE_API_KEY`
   hidden, with the exe's folder as the working directory.
2. **Set API Key...** — a runtime key limited to Tunnels Read + Use. It is encrypted with DPAPI
   (Electron `safeStorage`) into `%APPDATA%\wsl-workbench\integration\tunnel.key.enc`, the file
   ACL is reset to your user SID, and the saved copy is decrypted once to verify. If encryption, the
   ACL, or decryption fails, nothing is saved / started — there is no plaintext fallback.
3. **Start with Workbench** — from then on tunnel-client starts when the app starts (only while the
   dots integration is on) and when the integration is turned on; turning the integration off or
   quitting stops it. **Start Now** / **Stop**, **Replace API Key...**, **Delete API Key...** are in
   the same menu.

- tunnel-client runs inside a Windows **Job Object** with *kill on job close*, created by a small
  helper (Windows PowerShell `Add-Type`, official Win32 APIs; same approach as the pipe relay). The
  helper joins the job before starting tunnel-client, so tunnel-client, the adapter wrapper, and
  everything below are in it. The helper ends the job when Workbench's end of its stdin closes or
  the Workbench process exits, so the whole tree ends on a **normal quit, integration off, a crash,
  or a forced kill** of Workbench. If the job can't be set up, nothing is started.
- No double start: the helper refuses to start while any `tunnel-client` process is already
  running (for example one started by hand, or a leftover); the status shows its pid.
- The key goes from Workbench to the helper over stdin and into tunnel-client's environment block
  only — never into Workbench's own environment (so WSL, terminals and AI CLIs never inherit it),
  the helper's argv / environment, `settings.json`, or logs.
- tunnel-client passes its environment to the stdio MCP command it starts, so Workbench starts only
  profiles whose `mcp.commands[].command` are `.cmd` / `.bat` wrappers that clear the key **before
  anything else runs** (checked before every start; HTTP-only profiles pass):
  ```bat
  @echo off
  set CONTROL_PLANE_API_KEY=
  set ELECTRON_RUN_AS_NODE=1
  "%LOCALAPPDATA%\Programs\wsl-workbench\WSL Workbench.exe" "%LOCALAPPDATA%\Programs\wsl-workbench\resources\app.asar\src\mcp\adapter.js"
  ```
  The adapter also drops the variable at start, as a second layer.
- Starting the tunnel never shares a pane or allows input: those stay the per-pane ⇪ actions.
- tunnel-client's output goes to `integration\diag\tunnel-client.log` (reset above 5 MiB). Status
  (starting / running / pid / last exit / last error) is in **Connection Status...**. An automatic
  start that fails (no key, missing exe/profile, wrapper keeps the key, decryption error, another
  tunnel-client running) is shown there; it is not retried.

Verified on Windows 11 (2026-10-02, dev build, dummy key, control plane unreachable so nothing left
the machine): auto start → helper → tunnel-client → `adapter.cmd` → adapter (the wrapper saw no
`CONTROL_PLANE*` variable); integration off, normal quit, `taskkill /F` of only the Workbench main
process, and `taskkill /F` of only the helper each left no tunnel-client / wrapper / adapter
process; restarting right after a forced kill ran exactly one tunnel-client; with a hand-started
tunnel-client running, the app refused (`already_running`).

### Everyday use: Sharing ON/OFF with a saved default (v0.32.0)

1. **Integration > Enable dots Integration** — terminal input is enabled with it (over the verified
   pipe; **Allow Terminal Input** turns just input off again).
2. **Integration > Default for Sharing...** (asked automatically the first time): *Read only* /
   *Read + input (each send confirmed)* / *Read + input, no confirmation*. Saved with this one
   consent dialog.
3. Per pane, **⇪ > Sharing** ON / OFF — nothing else. With input in the default, the CLI started in
   the pane (Claude Code / Codex, from its own banner) gets input and, if chosen, skip-confirmation;
   the profile is picked automatically. When the CLI exits (shell prompt) input goes off; when a CLI
   starts again while the pane is still shared, input follows it.

- Unverified versions stay read-only (badge: *input waits*) until **⇪ > Allow Compatible Behaviour
  for X.Y.Z...** once; other majors stay read-only. A CLI started before Sharing ON shows *version
  unknown* (restart it, or **⇪ > Confirm the CLI Version**).
- Nothing is shared after a restart; **⇪ > Stop input** and typing in the pane stop AI input; the
  CLIs' own trust / permission prompts are never answered. **⇪ > Individual Switches** keeps the
  per-switch controls.

### CLI versions and input profiles (v0.31.0)

A profile describes a CLI family and its input method (one line, text and Enter as separate
writes, the submit delay). The versions it was actually measured with are listed separately
(`verified_versions`, also in `capabilities`); a profile is never "verified for all of 2.x".
Profile IDs are unchanged.

| CLI in the pane | Input |
| --- | --- |
| a verified version | allowed as before |
| same major, not verified (for 0.x: same minor) | blocked until you choose **⇪ > Allow Compatible Behaviour for X.Y.Z...** once; remembered per version |
| another major / another CLI | blocked (the profile has to be measured again) |
| unknown | blocked until identified |

- The version is taken only from the pane's own output (the CLI's startup banner, shown as "seen in
  this pane") or from you (**⇪ > Confirm the CLI Version (yourself)...**, "confirmed by you", verified
  versions only). Running `claude --version` in another process is never used: PATH can start a
  different install (an old one was found this way). If the CLI started before sharing, either
  confirm it yourself or restart it while Read Sharing is on.
- A new CLI or a different version appearing in the pane (banner) or the shell prompt returning
  turns Input (and skipping confirmations) OFF; turn it on again for the new target. Approving
  compatible behaviour never turns sharing, input or skipping confirmations on.
- `get_session.input_profile.cli_version` = `{ value, source: pane_output | user_confirmed | unknown,
  status }`.

**Staged result after Enter.** `get_operation` keeps its structured fields (no tool update needed)
and adds a text line: *Observation (advisory): CLI acceptance = observed / pending / not_confirmed /
unknown, response = …*. Only output captured after Enter counts (an earlier "esc to interrupt" or
reply never does); acceptance = the CLI's busy line, response = a reply marker after it (Claude Code
only; Codex: unknown). `not_confirmed` / `unknown` never mean "not sent"; nothing is re-sent and no
extra Enter is pressed. Limits: the markers are screen text and can change with a CLI update (then
`not_confirmed` / `unknown`), hook messages can look like a reply, and a full-screen redraw after
Enter may repaint old lines.

### Skipping the send confirmation (per pane, opt-in, v0.30.0)

**⇪ > Skip Send Confirmation (this pane only)...** (only while Input is ON) makes text AND Enter
requested by dots for that pane go out without Workbench's two dialogs, after a one-time consent.
The badge turns red — **Read ON · Input ON · NO CONFIRMATION** — with a **Stop input** button.

- Bound to that pane incarnation, its read grant, the current input period and the selected CLI
  profile; never shared with other panes and never persisted. Turns OFF with Input OFF, Read
  Sharing OFF, a CLI profile change, the shell prompt returning (CLI exited), the terminal ending,
  the dots integration or terminal input turning off, or Workbench exiting.
- Only the dialogs are skipped. Still enforced: target / permission / profile revalidation right
  before the text and right before Enter, the write order and the profile's submit delay,
  idempotency (no duplicate sends), the operation journal and audit (`auto_confirmed`), and your
  typing / Take Over stopping AI input.
- Operations that were already waiting when you turned it on keep their dialogs. Turning it off
  (or any OFF above, or typing in the pane) stops what has not been sent; a partly sent operation
  is `outcome_unknown` and is never re-sent.
- It never answers Claude Code's / Codex's own trust or permission prompts, and ChatGPT / dot side
  approvals are separate. Workbench cannot always tell that the CLI moved to another input screen
  (see below) — use it only while you watch the pane.

### Limits of CLI change detection

Workbench cannot see which program runs in the foreground of a WSL terminal (the PTY belongs to
`wsl.exe`). Input is turned OFF on the signals it can trust — PTY exit / replacement, CLI profile
change, and the shell prompt reappearing (OSC 7 from Workbench's own `PROMPT_COMMAND`). Not covered:
a CLI that starts another interactive program without returning to the shell (e.g. a nested CLI or
`exec`), shells whose prompt does not run Workbench's `PROMPT_COMMAND` (zsh / fish, or a bashrc that
overwrites it), and a CLI that itself prints OSC 7 (Input would turn OFF right away — the safe
direction). The per-send confirmation shows the exact text and asks you to check the CLI's prompt
first; that check remains the final safeguard. Options if needed: (a) a short "re-confirm after N
minutes idle" rule for Input only, (b) shell integration that also reports the foreground command
(OSC 133 / 633), (c) per-CLI prompt fingerprints in the profile.

### Connection diagnostics (v0.26.1)

When the adapter reports `APP_UNAVAILABLE`, the message now says how far the last handshake got,
e.g. `(last attempt: stage=pipe-open, reason=peer-close)`. Stages: `connecting` → `pipe-open` →
`hello-received` → `auth-sent` → `auth-ok`; reasons: `timeout`, `peer-close`, `socket-error`
(with `code`), `bad-hello`, `bad-server-proof`, `unexpected-message`, `protocol-*`.

- Adapter: stderr (`[wswb-adapter] {...}`) and `integration\diag\adapter-YYYY-MM-DD.jsonl`.
  Since v0.28.1 it also records every `tools/list` answer (`tools_list`: returned tool names, count,
  and why input tools were in or out — `input_on`, `input_off`, `app_unavailable`, …) and every
  `initialize` (`mcp_initialize`: client name + protocol version). Never arguments, output, or keys.
- Workbench (`integration\audit\audit-*.jsonl`): `broker_listening` (relay or plain pipe, endpoint),
  `connection_accepted`, `hello_sent`, `auth_failed` (now also `peer-closed-before-auth`),
  `connected`; relay: `relay_ready`, `relay_accepted`, `relay_handed_off` / `relay_handoff_failed`,
  `relay_conn_error` (exception type only), `relay_peer_closed` / `relay_local_closed` (byte
  counts), `relay_error`. Relayed lines carry `relay_id`.
- Only stages, reasons, error codes, timings and byte counts are logged — never the secret,
  nonces or proofs.

Reading them: adapter `pipe-open / peer-close` with no `connection_accepted` in the audit log means
something other than this Workbench answered on that pipe; `relay_accepted` without `hello_sent`
means the hand-off to the broker stalled.

### Verification status (v0.26.0)

- `npm test`: stage A (A01–A07, X01, X02) and stage B mock acceptance (B01–B05, B07–B10 at mock
  level, output schemas validated), plus the real adapter over stdio.
- Windows 11 / Electron 42 in Node mode, temp userData: restricted pipe DACL (helper + independent
  client read), squatting refused, wrong key refused, and adapter → `write_input` → two confirmations
  → text and Enter as separate writes → `delivered` with a fake PTY.
- **Not yet verified:** the running app UI (B11), real Claude Code / Codex sessions inside
  Workbench (B12), other-user / remote clients, and a real dot / plugin / Secure MCP Tunnel (X03).
  Input is implemented and tested, **dot connection unconfirmed**.

## Notes

Internal tree drag and drop performs move/rename via Windows UNC path:

```text
\\wsl.localhost\Ubuntu\...
```

The editor is intentionally minimal. Test file editing and drag/drop operations in a throwaway directory before using it on important repositories.

## v0.13.4

- The file tree now shows **git status colors** (VS Code-like): untracked files green, modified/staged files amber, and folders containing changes a muted amber. Piggybacks on the existing branch-badge poll — no extra processes.
- The tree's and Markdown preview's scrollbars now render dark like the rest of the UI.

## v0.13.3

- **Terminal splits**: the ◫ button splits the active terminal tab into up to 3 side-by-side panes, each its own shell. Drag the divider to resize; hover a pane for its close button; the focused pane gets the accent outline (and receives tree-path drops / image pastes).
- **Clickable URLs in the terminal**: http(s) URLs underline on hover and open in your default browser.
- Even thinner (1px) dividers between the tree, editor, and terminal (the drag target stays wide).
- Removed the **Start Claude** toolbar button (start your CLI from the terminal instead).

## v0.13.2

- Markdown preview now renders **GFM pipe tables** (with `:--`/`:-:`/`--:` column alignment, `\|` escapes, and GFM row-continuation rules).

## v0.13.1

- Fixed the editor tab strip being squeezed by its own scrollbars when many files are open. The strip no longer shows scrollbars; scroll the tabs with the mouse wheel (the active tab still scrolls into view automatically).

## v0.13.0

- **Single instance**: launching the app again (app icon or a `.wslwb-workspace` file) no longer boots a second full Electron (saving hundreds of MB) — the running instance opens a new window instead.
- **Session restore**: the app reopens the last workspace on startup, and each workspace remembers which files were open (and which was active).
- **Recent Workspaces** on the start screen — the last 100, with a filter box on top (type a path fragment; Enter opens the single match).
- **Word wrap** toggle in the editor bar. Line numbers stay visible and correctly aligned with wrapped lines.
- **Undo protection**: reloads after external changes (e.g. the AI CLI editing an open file) and Replace / Replace All are now single undoable edits — Ctrl+Z restores the previous buffer. Preview toggling no longer clears undo history.

## v0.12.3

- Fixed a right-click in the terminal pasting the clipboard when a mouse-reporting app (e.g. Claude Code) was running: right-click is now left to the app in that mode, so it no longer pastes over the app's own selection. At a normal prompt, right-click still copies the selection (or pastes when there's none). Ctrl+V pastes in either mode.

## v0.12.2

- Open files now detect changes on disk (e.g. edits made by the AI CLI in the terminal): files with no unsaved edits reload automatically, while files with unsaved edits are flagged with ⚠ and reload only when you click the tab and confirm.
- The tree header shows the workspace's current git branch (with a `*` when there are uncommitted changes).
- Markdown files (`.md`) get a **Preview / Edit** toggle in the editor bar. Links open in your default browser.
- Thinner dividers between the tree, editor, and terminal panes.

## v0.12.1

- The viewer and terminal scrollbars now render dark to match the always-dark UI (they were showing as light bars when the Windows "app mode" was Light).
- Fixed the editor's line numbers being overprinted by long lines when scrolling horizontally; text now scrolls under the line-number gutter.

## v0.12.0

- Paste a clipboard image into the file tree to save it as a PNG. It goes into the clicked folder, or the workspace root when you click the path header / empty space (the target folder is marked on the path header).
- Paste a clipboard image into the terminal to hand it to an AI CLI (e.g. Claude Code) as `[Image #N]`. The image is bridged into the WSL clipboard, so the distro needs `wl-clipboard` (Wayland/WSLg) or `xclip` (X11) installed.
- Drag an image/file onto the tree — including the top-level (root) area — now works; fixed the "no drop" ✖ cursor over empty tree space.
- Start screen: **Clone Repository…** — clone a Git repo into a chosen folder and open it as the workspace.
- The toolbar now shows the workspace as `parent/leaf` (e.g. `[richka/aws-infra]`) so sibling workspaces with the same name are distinguishable.
- Fixed terminal text overlapping the scrollbar (added right padding).

## v0.11.0

- Terminal tabs can be renamed by double-clicking.
- The toolbar shows the open workspace's directory name (e.g. `[test003]`).
- Fixed multi-line text being pasted twice into the terminal (right-click / Ctrl+V).

## v0.10.0

- Editor tabs scroll horizontally instead of squeezing when many files are open; the active tab stays in view.
- Terminal: fixed the bottom row being cut off.
- About dialog: added a link to the GitHub repository.

## v0.9.0

- File viewer: find & replace (Ctrl+F / Ctrl+H) with match highlighting, a match counter, case-sensitivity toggle, and Replace / Replace All.
- File viewer: line numbers down the left side of the editor.

## v0.8.0

- Custom title bar (VS Code / Cursor style): the menu now sits in the top toolbar of a frameless window, with the app icon at the left and custom minimize / maximize / close controls at the right.
- The current workspace directory moved from the toolbar to a header at the top of the file tree.

## v0.7.0

- One-click in-app update: Help → About now offers **Download and install** when a newer release exists. It downloads the installer from the latest GitHub release (with a progress bar), verifies its Authenticode signature (trusted chain + publisher pinned to the running app), then runs it and restarts the app.
- Shift+Enter in the terminal inserts a newline like Alt+Enter, so CLIs (e.g. Claude Code) treat it as a newline rather than submit.
- Directory tree font size now matches the editor and terminal.

## v0.6.0

- Terminal tabs: multiple terminals per window (+ to add, × to close); Start Claude opens a new tab.
- Editor tabs: open multiple files at once, each with its own unsaved state; Ctrl+S saves the active tab.
- Moved the menu into the top toolbar (native menu bar hidden to save vertical space); Save Workspace now sits below Open Workspace File.
- Terminal right-click copy/paste fixed (handled on mousedown; clipboard routed through the main process for the sandboxed preload).

## v0.5.0

- Renamed the workspace file extension to `.wslwb-workspace` and the environment variables to `WSLWB_DISTRO` / `WSLWB_PATH` / `WSLWB_HOME_PATH`. The old `.nwl-workspace` extension and `NWL_*` / `CWL_*` variables were removed.
- Save Workspace now defaults the filename to the workspace directory name (e.g. `test003.wslwb-workspace`).

## v0.4.0

- Renamed the app to **WSL Workbench** (repo `wsl-workbench`).
- Added Help > About with version display and update check.
- Added image preview, terminal right-click copy/paste, terminal restart after exit, English/Japanese UI, and non-default WSL distro support.
- Added a test suite (`npm test`) and a `dist:zip` build target.

## v0.3.0

- Renamed app to Nix Workbench Lite.
- Added editable file viewer and Save button.
- Added Ctrl+S support.
- Added resizable panes.
- Kept Electron `^42.4.1` and electron-builder `^26.15.3`.
- Renderer remains hardened with `contextIsolation: true` and `nodeIntegration: false`.

## v0.3.1

- Added Windows Explorer drag-and-drop support.
- Dropping Explorer files/directories onto a tree directory copies them into WSL.
- Internal tree drag-and-drop still moves files/directories.
- Existing destination names are not overwritten.


## v0.3.7

- Explorer drag-and-drop now skips locked Windows profile/system files such as `NTUSER.DAT`.
- Copy errors for individual files are skipped instead of aborting the whole drop operation.
- Existing destination names are still not overwritten.


## v0.3.7

- Added right-click context menu in the file tree.
- New File / New Folder.
- Rename.
- Delete file or directory recursively after confirmation.

- Right-click menu includes Reveal in Explorer.


## v0.3.7

- Fixed blank screen after adding the context menu by loading renderer after the menu DOM exists.


## v0.3.7

- Added Workspace menu.
- Open Workspace selects a folder and changes the current WSL working directory.
- Save Workspace writes the current distro and WSL path to a JSON file.



## v0.3.7

- Added multi-window support.
- Workspace > New Window opens another independent window.
- Tree context menu > Open in New Window opens the selected directory as a new workspace.
- Each window has its own WSL terminal session and workspace root.


## v0.3.11

- Fixed Open Workspace and New Window path handling for native Windows paths such as `C:\Users\...`.
- Windows paths are now converted to WSL paths such as `/mnt/c/Users/...` before loading the tree and starting the terminal.


## v0.3.11

- Fixed workspace paths selected from Windows Open Directory dialog.
- `/mnt/c/...` workspaces now use the native `C:\...` path for the file tree/editor while the terminal still starts in `/mnt/c/...` inside WSL.


## v0.3.11

- Changed the default starting location for Open Workspace to the WSL user home such as \\wsl.localhost\Ubuntu\home\<user>.
- Added NWL_WSL_HOME_PATH so the initial Open Workspace location can be overridden.

## Workspace files

- `Workspace > Save Workspace...` saves the current workspace as `*.wslwb-workspace`.
- `Workspace > Open Workspace File...` loads a saved workspace and switches the current window to that directory.
- When the NSIS installer build is installed, `*.wslwb-workspace` is registered as a WSL Workbench workspace file. Double-clicking it starts the app with that workspace.
- Portable builds may not register the file association automatically; use `Open Workspace File...` in that case.


