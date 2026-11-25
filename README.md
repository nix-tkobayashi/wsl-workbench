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
- **Free WSL Memory** (View menu, or click the MEM meter; v0.42.0): WSL2 keeps the Linux page cache
  instead of returning it to Windows, so `VmmemWSL` grows toward its cap. After a confirmation this
  runs `sync`, `drop_caches` and `compact_memory` as root (`wsl.exe -u root`) and shows how much
  cache was freed — no process is stopped. The VM is shared, so it helps every distro. Task Manager
  catches up within tens of seconds to minutes (free page reporting); `autoMemoryReclaim=gradual`
  under `[experimental]` in `.wslconfig` does this automatically.
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

## Workspace secrets (v0.36.0)

Keep credentials (AWS keys, tokens…) per workspace without putting a file in the repository.

- **Open the panel**: the 🔑 button in the tree header, **View > Secrets Panel**, or `Ctrl+Shift+K`. It sits at the bottom of the tree pane; whether it is shown is remembered per workspace.
- **Key = file name, value = file contents.** Keys use letters, digits, `.`, `_`, `-` (1–64 chars). Each row has `→` (insert path), 👁 (show the value for 10 s), ✎ (edit), 🗑 (delete); `+ Add` creates one.
- **Storage**: values are encrypted by Windows (DPAPI, via Electron `safeStorage`) under `%APPDATA%\wsl-workbench\secrets\` — nothing is written into the workspace.
- **Handing a secret to a CLI**: `→` (or double-click the row, or the 🔑 button in the terminal tab strip) writes a plaintext copy to WSL tmpfs — `/run/user/<uid>/wb-secrets/<folder>-<id>/<key>` (`/dev/shm/wslwb-<uid>/…` when `/run/user/<uid>` is missing), mode `0600` in `0700` directories — and types its path into the focused terminal without Enter. Ask the CLI to "use this file".
- The copies are removed when the app quits. The path is fixed per workspace and key, and the copies handed out before are re-created at the next start (v0.40.0: for every local recent workspace at app start, before any ssh connection — so an ssh `ProxyCommand` that sources one works right after a restart; remote hosts' copies when their workspace is opened), so a path given to a CLI earlier keeps working after a restart.
- **Paste value…** (terminal 🔑 menu) types the value itself after a warning — it becomes input to the running program and stays in the scrollback; the path is usually enough.
- **Import**: if the workspace has a `.credentials/` folder, the panel offers to import its files (UTF-8 text) and then asks whether to delete the plaintext originals.

### Sharing secrets between PCs (v0.41.0)

Share a workspace's secrets with your other PCs through a folder synced by **Google Drive for desktop** (or OneDrive / Dropbox) — the app never calls a cloud API, the desktop client syncs the file.

- **☁** in the Secrets panel header → **Share via Synced Folder…**: pick the synced folder (e.g. `G:\My Drive\wsl-workbench`), a **share name** (use the same name on every PC — the workspace path may differ) and a **passphrase** (8+ characters, the same on every PC; stored on each PC with DPAPI).
- The file `<folder>/<share name>.wbsecrets` is encrypted with the passphrase (scrypt + AES-256-GCM); the local store stays DPAPI-encrypted as before.
- Sync runs when the panel lists secrets (opening the workspace / panel) and after every add, edit, delete or import; **Sync Now** in the ☁ menu forces one. The status line under the header shows the last sync or the error.
- Merge is per key, newest edit wins; a deletion or rename on one PC removes the key on the others (copies handed out there are removed too).
- **Stop Sharing on This PC** keeps both the local secrets and the shared file. Changing the passphrase does not re-encrypt existing files.

## Task panels: GitHub / GitLab / Backlog / Slack (v0.43.0)

Open tasks assigned to you, in resizable panels to the right of the editor (GitHub, GitLab, then one panel
per Backlog space, then Slack; the terminal keeps the full width below). A panel appears only once it is set up, so with neither
set up the window looks as before. Settings are per workspace.

- **Set up**: View → *GitHub Tasks Settings…* / *GitLab Tasks Settings…* / *Backlog Tasks Settings…* / *Slack To-dos Settings…* (or ⚙ on a panel). The
  token is one of the workspace's secrets, picked by name — its value stays in the main process and
  is never shown or written anywhere else.
  - GitHub: a personal access token (classic: `repo`, `read:org`; fine-grained: Issues and Pull
    requests read). Pick an organization (or your account), search, and check repositories (up to 200; type an organization name if a
    fine-grained token does not list it). Listed:
    open issues/PRs in the checked repositories assigned to you (●), and open PRs requesting your
    review (◆).
  - GitLab (v0.48.0): a personal access token with the `read_api` scope, and the host — empty for
    gitlab.com, or a self-managed instance's host name (always https; an instance under a path
    such as `example.com/gitlab` is not supported). Listed: open issues and merge requests
    assigned to you (●), and open merge requests you are a reviewer of (◆ — GitLab keeps you as
    reviewer after you approve, so those stay listed), across every project the token can see.
    Saving a host other than gitlab.com asks for confirmation first: the token is sent there.
  - Backlog: an API key and the space (`xxx` of `https://xxx.backlog.com` / `.jp`; pasting the URL
    fills both). Listed: open issues (any status but Closed) assigned to you, with status and due date.
    *Projects to show* (v0.47.0) limits the list to the projects you check, out of the space's
    (none checked = all).
    Several spaces (v0.45.0): each has its own panel and its own API key. In the dialog, *Space to
    set up* picks the space to edit or *+ Add a space…*; *Remove* drops only that space.
  - Slack To-dos (v0.45.0): your open to-dos (the list formerly called *Later*), soonest due first,
    with the channel and the start of the message; an item opens the message. *Channels to show*
    (v0.46.0) limits the list to the channels you check, out of those you are in (none checked =
    all); to-dos outside channels — DMs, group DMs, files — are always shown. Slack has no official
    API for To-dos, so this uses the web client's own, with your signed-in browser session: store
    **both** the token (`xoxc-…`) and the value of the cookie named `d` (`xoxd-…`) in one secret
    (e.g. on two lines). Some workspaces answer 403 unless the session's other cookies (`dbd`,
    `d-s`, `x`, `ec`…) come along: for those, store the token and, on its own line, the whole
    `Cookie` request header copied from the browser's developer tools (`d=xoxd-…; dbd=…; …`) — all
    of it is then sent. (v0.48.0) Such a session is tied to your network's public IP address and lasts about
    a day, after which the header has to be copied again. That pair can do anything you can do in Slack — treat it accordingly; it
    stops working when you sign out, and the panel may break whenever Slack changes its client API
    (it then shows an error; nothing else is affected).
- Newest update first (with a note when there are more than can be fetched). Click an item to open it in the browser; → on an item
  types its URL into the focused terminal pane, without Enter (v0.44.0). ⟳ refreshes; panels also refresh
  every 5 minutes. View → *Task Panels* hides/shows them.

## Remote workspaces over ssh (v0.38.0)

Open a directory on another host (e.g. an EC2 instance) as the workspace: the file tree, editor,
git badge **and** terminals all work on that host (like VS Code Remote-SSH), so AI CLIs run there
with your subscription login on that host.

- **Workspace > Open Remote Workspace (SSH)...** or **Open Remote (SSH)…** on the landing screen,
  then enter `host:/path` — `host` is a `Host` from `~/.ssh/config` in WSL (keys, agent, SSM
  `ProxyCommand` all apply), the path may be absolute, `~/dir`, or omitted (home).
- Workspaces are labeled `WSL:<distro>:<path>` / `SSH:<host>:<path>` (badge, tab tooltip, recent
  list; v0.40.0). Terminals are `ssh -t <host>` started in the workspace directory.
- A directory that doesn't exist yet is created (with its parents) after you confirm (v0.40.0).
- **Clone to Remote (SSH)…** on the landing screen clones a Git URL into `host:/parent` on the host
  and opens it (v0.40.0). Auth must work without a prompt on the host (ssh key / credential helper).
- Connection loss (v0.40.0): the workspace badge turns red; click it to reconnect now — otherwise the
  app retries on its own, waiting 2 s doubling up to 30 s between attempts. Opening a remote
  workspace that can't be reached (e.g. at startup) offers to retry. A dropped terminal pane
  restarts on a key press.
- The host needs `python3` (stdlib only). Workbench starts a small agent there over one ssh
  connection per host (`src/remote-agent.py`, sent on each connect — nothing is installed) and does
  file and git operations through it. ssh runs in batch mode, so the host key must already be
  known and auth must not prompt: run `ssh <host>` once in a terminal first.
- ssh runs inside the default distro (`Ubuntu`, or settings `"remoteSshDistro": "<distro>"`).
- Dropping Windows files on the tree uploads them (100MB per file). Pasting an image into a remote
  terminal uploads it to `~/.cache/wsl-workbench/paste/` (0600) and types its path; images older
  than 7 days there are deleted on the next paste (v0.40.0).
- Workspace secrets (v0.39.0): `→` writes the copy into the **host's** tmpfs
  (`/run/user/<uid>/wb-secrets/…`, else `/dev/shm/wslwb-<uid>/…`, same modes as locally) and types
  that path; the copies are removed from the host when the app quits (if it is still reachable,
  within 5 s — otherwise they stay until the host's tmpfs is cleared). `.credentials/` import is
  local-only.
- Clipboard in ssh terminals (v0.39.0): a CLI's copy reaches the Windows clipboard via OSC 52
  (Claude Code's `/copy` and its selection copy). Right-click pastes the Windows clipboard even
  while a full-screen app has mouse reporting on — unless you just selected text in it (drag or
  double-click), in which case the right-click goes to the app as its copy.
- Not available remotely: Reveal in Explorer (hidden from the menu), `.credentials/` import.

## Remote terminal over ssh (prototype, v0.37.0)

Run a workspace's terminal on another host (e.g. an EC2 instance, so AI CLIs run there) while the
UI stays the same. Only the terminal moves: the file tree, editor, and git badge still show the
local workspace. There is no UI yet — add the mapping to `%APPDATA%\wsl-workbench\settings.json`:

```json
"remoteTerminals": [
  { "wslPath": "/home/me/projects/app", "host": "ec2-dev", "dir": "/home/ec2-user/app" }
]
```

- A workspace whose path equals `wslPath` (optional `distro` narrows the match) opens every terminal — new tabs, splits, restarts — as `ssh -t <host>` run **inside that distro**, so its `~/.ssh/config` (keys, agent, SSM `ProxyCommand`) applies. `dir` (optional, absolute) is the remote start directory; if it can't be entered you get a plain remote shell.
- Read at each terminal start, so no restart is needed after editing. Malformed entries are ignored.
- A dropped connection ends the pane within ~2 minutes (`ServerAliveInterval=30`); press a key to reconnect.
- Image paste and workspace secrets still target the local distro. Clipboard copy (OSC 52) and right-click paste work as in remote workspaces (v0.39.0).

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


