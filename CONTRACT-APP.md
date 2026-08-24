# GroundControl.app: a real macOS application

Ground Control should launch from the Dock like any other app: its own icon, its own
window, its own menu bar, Cmd-Q to quit. Not a browser tab pointed at localhost.

Read `CONTRACT.md` for the project's conventions. The zero-dependency rule has
been lifted by the user, but **do not add Electron, Tauri, or an npm toolchain
anyway**. Verified on this machine: Xcode 26 with Swift 6.3.3 is installed and a
`WKWebView` program compiles and runs. A native shell is ~2 MB against Electron's
~150 MB, and **this machine has only ~7 GB of free disk**, which settles it.

---

## 1. What you are building

A macOS `.app` bundle whose window hosts the existing dashboard in a `WKWebView`,
and which owns the lifetime of the Node server that serves it. The web app is
unchanged: this is a shell around it, not a rewrite.

## 2. File ownership

- `app/GroundControl.swift`      (new): the application
- `app/Info.plist`        (new): bundle metadata
- `app/icon.svg`          (new): source artwork for the icon
- `build-app.sh`          (new): compiles and assembles `GroundControl.app`
- `bin/ground-control`            (existing): may gain a `--app` flag; otherwise leave alone

Do **not** modify `server.js`, anything in `lib/`, anything in `public/`,
`README.md`, or any other CONTRACT file. If the shell needs something the server
does not offer, work around it in Swift and report it rather than editing the
server.

## 3. Server lifetime: the part that must not go wrong

The app owns the server process. Get this right and everything else is detail.

1. **Find Node.** A GUI app launched from Finder inherits a minimal `PATH`, so
   `which node` will fail. Probe, in order: `/opt/homebrew/bin/node`,
   `/usr/local/bin/node`, `/usr/bin/node`, then `$SHELL -lc 'command -v node'` as
   a last resort. This machine resolves to `/usr/local/Cellar/node/25.2.1/bin/node`
   via `/usr/local/bin/node`.
2. **Pick a free port** by binding port 0 and reading back what the OS assigned,
   then release it and pass it to the server. Never hardcode 7377: the user may
   already have one running, and two instances must not fight.
3. **Wait for readiness** by polling `/api/projects` until it answers, with a
   10 s ceiling. Show the window only once it is ready; a `WKWebView` that loads
   too early renders a connection error the user has to reload past.
4. **Terminate the server on quit: always.** Handle `applicationWillTerminate`,
   Cmd-Q, window close, *and* an unexpected app exit. Put the child in its own
   process group and kill the group, so no orphan `node` survives. Verify this:
   launch, quit, and confirm with `ps` that nothing is left behind.
5. **If the server dies while running**, do not show a blank window: surface a
   readable message with a Restart action.
6. If Node cannot be found, show a native alert explaining what is missing and
   how to install it. Never fail silently to a white window.

## 4. Window and chrome

- Restore window size and position between launches (`NSWindow.setFrameAutosaveName`).
  Sensible first-run default: 1280×860, centred, minimum 720×520.
- Title bar: `.hiddenTitleBar` or a unified toolbar so the dashboard's own header
  reads as the app's header. Background must match the app's obsidian
  (`#0a0b0d`) so there is no white flash on launch: set the window and the
  `WKWebView` background, and disable the web view's opaque white default.
- A real menu bar: **Ground Control** (About, Hide, Quit), **File** (Rescan ⌘R, Close ⌘W),
  **Edit** (standard cut/copy/paste/select-all so text fields work), **View**
  (Reload ⌘⇧R, Actual Size / Zoom In / Zoom Out, Toggle Full Screen),
  **Window** (Minimize, Zoom). Without an Edit menu, ⌘C/⌘V silently do nothing
  in the filter and dialog fields: wire it.
- ⌘K must reach the page's quick switcher rather than being swallowed by the shell.

## 5. Links and navigation

- Navigation **inside** the app is limited to the local server origin.
- Any `http(s)` link to another origin opens in the user's default browser via
  `NSWorkspace.shared.open`, never in the app window.
- `target="_blank"` must not open a dead empty web view: route it through the
  same external-open path.
- Downloads are out of scope; if one is triggered, hand it to the browser.

## 6. Icon

`app/icon.svg` is the source: Ground Control's eye: an ember iris on obsidian, in the
palette from `CONTRACT.md` §3. Build the `.icns` in `build-app.sh` from that SVG
using only tools already present (`qlmanage` or `sips` to rasterise, then
`iconutil`), generating the full `iconset` ladder (16/32/128/256/512 @1x and @2x).
The icon must be legible at 32 px: no fine detail that mushes at Dock size.

## 7. `build-app.sh`

One script, runnable from a clean checkout:

```
./build-app.sh            # builds ./GroundControl.app
./build-app.sh --install  # also copies it to ~/Applications
```

It must: compile `GroundControl.swift` with `swiftc -O`, assemble the bundle
(`Contents/MacOS`, `Contents/Resources`, `Info.plist`), generate and install the
icon, and **copy the application's own runtime files into `Contents/Resources`**
 (`server.js`, `lib/`, `public/`, `package.json`) so the built app is
self-contained and keeps working if the source folder moves.

It must be idempotent, print what it did, and fail loudly with a useful message
if `swiftc` is missing. It must not require `sudo` and must not touch anything
outside the repo and `~/Applications`.

The app is unsigned. Say so in the build output, and state the one-time
right-click → Open that Gatekeeper needs on first launch. Do not attempt to
disable Gatekeeper or sign with a fake identity.

## 7a. Folders dragged onto the window (added with CONTRACT-SOURCES.md)

The dashboard watches a list of folders, and dragging one in from Finder is the
obvious way to add one. In a browser this is the hard case: a dropped directory
arrives as a *name* with its path deliberately withheld. The app shell does not
have that problem, so it fills the gap:

- The window's content view is a `DropHostView` registered for `.fileURL`
  drags. It accepts **directories only**: refusing a dragged file during the
  drag is kinder than accepting it and erroring afterwards, and hands the real
  paths to the page as `window.groundControlAddFolders([...])`.
- `config.userContentController` exposes **`gcPickFolder`**. The page posts to
  it and the shell opens a real `NSOpenPanel` as a sheet on the window,
  replying with `window.groundControlPickedFolder(path | null)`. Outside the app
  the page falls back to the server's `osascript` chooser, which works but is a
  dialog owned by another process.
- File ▸ **Add Folder…** (⌘⇧O) is the same panel from the menu bar.

The shell **never writes to the source list**. It only ever hands a path to the
page, which shows its own confirmation dialog. That keeps one code path for
adding a folder, and one place where the decision is made.

## 8. Verification: actually do these

1. `./build-app.sh` from a clean state produces `GroundControl.app`.
2. Launch it by **double-clicking in Finder** (not from a terminal), which is the
   case where a bad `PATH` breaks Node discovery. Confirm the dashboard renders
   and shows all 19 projects.
3. Confirm the Dock icon is the Ground Control eye and is legible at Dock size.
4. Quit with ⌘Q, then confirm with `ps` that **no `node` process survives**.
   Repeat for closing the window and for force-quitting the app.
5. Launch twice and confirm two instances do not fight over a port (or that the
   second focuses the first: either is acceptable, but say which you did).
6. Verify ⌘C/⌘V work in the filter field, ⌘K opens the quick switcher, and an
   external link opens in the default browser rather than inside the app.
7. Confirm there is no white flash on launch.
8. Drag a folder from Finder onto the window and confirm the add dialog opens
   with the real path already filled in; then File ▸ Add Folder… and confirm the
   panel is a sheet on the window, not a floating dialog behind it.
9. Leave the repo clean: no stray processes, no build artifacts beyond
   `GroundControl.app` and an ignored build directory. Add both to `.gitignore`.
