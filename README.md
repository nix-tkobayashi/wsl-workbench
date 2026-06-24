# WSL Workbench

Lightweight Windows Electron app for working in WSL:

- Left: WSL file explorer tree (shows the workspace contents directly)
- Upper right: minimal text editor (`Ctrl+S` to save) with inline image preview
- Lower right: WSL terminal for Claude Code
- Landing screen on startup / New Window to pick a workspace
- **Start Claude** launches the WSL-native `claude --dangerously-skip-permissions`
- Terminal: right-click to copy (selection) / paste, drag a tree item in to insert its path,
  paste an image with `Alt+V` (Claude Code reads it), and press any key to restart after `exit`
- Tree auto-refreshes (files created in the terminal appear without a manual refresh)
- English / Japanese UI (Language menu)
- Drag & drop to move within the tree, or copy in from Windows Explorer
- Multi-window; Exit closes only the active window
- Resizable left/right and editor/terminal panes

## Download (Windows)

No Node.js needed to run. Grab one of these from the [**latest release**](https://github.com/nix-tkobayashi/wsl-workbench/releases/latest):

- **Installer** — `WSL Workbench Setup <version>.exe` (NSIS). Installs per-user, adds Start Menu / desktop shortcuts, and registers `.wslwb-workspace` files. Recommended.
- **Portable** — `WSL Workbench <version>.exe`. A single self-contained exe; just run it.
- **Zip** — `WSL Workbench-<version>-win.zip`. Extract anywhere and run `WSL Workbench.exe`.

Requires WSL. On first launch, choose a workspace (Open Workspace / Open Workspace File).
The builds are **self-signed**, so Windows SmartScreen may still warn on first run — choose **More info → Run anyway**, or trust the publisher once (see [Code signing](#code-signing)).
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

Trust the publisher once per machine (downloads the `wsl-workbench.cer` from the release):

```powershell
Import-Certificate -FilePath .\wsl-workbench.cer -CertStoreLocation Cert:\CurrentUser\Root
Import-Certificate -FilePath .\wsl-workbench.cer -CertStoreLocation Cert:\CurrentUser\TrustedPublisher
```

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

## Notes

Internal tree drag and drop performs move/rename via Windows UNC path:

```text
\\wsl.localhost\Ubuntu\...
```

The editor is intentionally minimal. Test file editing and drag/drop operations in a throwaway directory before using it on important repositories.

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


