# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Sessions panel: organise saved sessions with the mouse or the keyboard. Drag a session, or the whole multi-selection, onto a folder or onto free space in the list (top level); drag folders into other folders. The target folder is outlined while dragging; Escape cancels, and a folder can never be dropped into itself or one of its subfolders. Dragging uses pointer events, not HTML drag and drop, so it works the same on Windows, X11 and Wayland and does not interfere with dropping files on the file browser. Context menu (also via the context-menu key or Shift+F10): "Move to…" opens a dialog with the folder list and a path field (a new path creates the missing folders), "Rename folder" (also F2, edited in place; renaming onto an existing sibling asks before merging, dragging merges without asking), "New folder…" (also in the toolbar) and "Remove empty folder". Renaming or moving a folder takes all sessions and subfolders below it along; moving into an existing folder merges them. After each move or rename the status line offers "Undo" for 10 seconds. Undo turns back exactly that change in one step: a session returns only if it is still where the change put it (sessions changed or deleted on another device in the meantime are left alone and counted in the status line), only the empty folders the change added or removed are taken back, and expanded folders return to their previous state. A rename is checked for every resulting path first and is rejected as a whole if one would be invalid or longer than 1024 characters. Session IDs and jump-host references never change. Every change is a single atomic write of `sessions.json` and is not reported as an external change in a shared data folder. Empty folders are stored in an optional `folders` list in `sessions.json` (format version stays 1; older Werkterm versions ignore the list and drop it when they save). A folder emptied by a move stays until it is removed; "Delete folder with all sessions" removes the sessions and the empty subfolders in the same single write (if a session is protected as jump host or by a tunnel, the folder stays). Folder names are trimmed of spaces, tabs, line breaks, Unicode spaces and U+FEFF at both ends of each level, the same way in the panel and in the file (issue #1).
- Three dark retro designs whose Tuxes follow their own rules instead of the normal walker, drawn in the design's look in every state. "Retro Lemminge": every 2nd row counted from the bottom turns into soil while the Tuxes are active, the rows in between stay readable; numbers and paths on soil rows become steel; Tuxes dig by hand straight down, as a tunnel through a word or diagonally, and shrug and turn round on steel; umbrella and climber abilities (the climber shows a blue badge and climbs a wall one level up); a fall of one level is survived, two only with umbrella, the drop out of the hatch does not count; stopper, builder (one level of stairs), hatch and exit door. "Retro Gerüst": girders on every 2nd row counted from the lowest text row, the rows in between stay readable; ladders span the rows between two girders and prefer free columns; a crane robot on the top girder (always visible) throws barrels and crumbles the top 3 text rows; a barrel only hits a Tux on the same girder or ladder, the hit Tux restarts bottom left, the goal is at the top. "Retro Hüpfer": every 2nd row counted from the bottom turns into bricks while the Tuxes are active, the rows in between stay readable; the Tuxes zigzag over the bricks, stomp through a brick row one level down with a crouch jump and never land higher after a random hop; ?-blocks sit in a word gap of the brick row above a Tux (never in the top 3 text rows), items come out below and fall to the Tux's level; goal flag and exit pipe bottom left. On terminal activity the Tuxes leave in the design's own way within a second (Lemminge pop from left to right, Hüpfer jump away with a coin sparkle, Gerüst beam out) without holding up input, then the normal text returns. Soil, bricks and destroyed text are overlay only; Tuxes leave on their own after 10 minutes; nothing runs with Tux off or reduced motion. Designs are defined in the app, not in the design tokens (issue #25).
- SSH sessions: "Advanced SSH options" field (one option per line as `-o Key=Value`, `Key=Value` or `Key Value`), stored with the session and included in session export/import. Quick connect accepts the same `-o Key=Value` arguments before `user@host[:port]`. Supported: `KexAlgorithms`, `HostKeyAlgorithms`, `PubkeyAcceptedAlgorithms` (alias `PubkeyAcceptedKeyTypes`), `Ciphers`, `MACs` with OpenSSH list syntax (`+` appends, `-` removes, `^` puts first, a plain list replaces), plus `ConnectTimeout`, `ServerAliveInterval` and `ServerAliveCountMax`. This reaches older servers that only offer legacy algorithms such as `diffie-hellman-group14-sha1`, `diffie-hellman-group1-sha1`, CBC ciphers (including `3des-cbc`) or `hmac-sha1`; the defaults are unchanged. Weak algorithms enabled this way are flagged in the session dialog, in the Werkterm import preview and as a line in the terminal after connecting. Naming a group exchange algorithm explicitly accepts groups from 2048 bits (default minimum 3072; 1024-bit groups are not supported). `ConnectTimeout` limits each TCP connect attempt, like OpenSSH, and never shortens the default handshake time. Encrypted key files whose type `PubkeyAcceptedAlgorithms` excludes are skipped without asking for the passphrase. Unknown options, unknown algorithm names and malformed lines are rejected with the line number before connecting. A jump host uses the options of its own session.
- APT test distribution for `.deb` installs: test builds are published to the APT distribution `test` as well (`npm run publish-pkg -- <version> --channel test` now uploads the .deb with `deb-test`). With the update channel on Test, the update dialog of a `.deb` install explains how to add `test` to `Suites:` in `/etc/apt/sources.list.d/werklade.sources` and offers the steps plus a one-line command to copy. Back on Stable, a `.deb` install with a newer test build now sees the stable release as a downgrade offer and gets the commands to remove `test` and install the stable version with `sudo apt install werkterm=<version>`. Werkterm only shows and copies these commands; it never runs them.
- Session dialog: under "Advanced", a saved session with a remembered paste choice ("Remember for the profile" in the paste dialog) shows that choice and offers "Reset remembered paste choice". The reset takes effect immediately, without saving the session, and only affects this session; other sessions and the choice remembered for all terminals stay. A choice remembered for an open tab stays until the tab is closed; the button's tooltip says so (issue #5).
- Settings > General > Interface size: scales the whole interface to 90 %, 100 %, 110 %, 125 % or 150 % (100 % by default). The size is stored per device and not synced through the data folder, because screens differ between devices. It is applied at startup from the local cache before the first render (waiting at most 300 ms) and immediately on change; if a change fails, the status line says so and the selection returns to the size actually shown; terminals and the Tux overlay adapt to the new size. Unknown values fall back to 100 %. The per-terminal font zoom with Ctrl+mouse wheel is unchanged (issue #6).
- File browser: folder download and upload over SFTP, also in sudo mode. "Download" on a folder asks for a local target folder and creates the folder of the same name inside it; the upload button now offers "Upload files" and "Upload folder", and dropped folders are uploaded as well. Folders are created first (remote with 0755), then every file runs as its own job in the transfer queue with progress, cancellation and the existing overwrite question; the status line shows the position ("Folder logs: 12 of 40 files"). "Overwrite all" and "Cancel" apply to the whole folder; existing folders are reused, and files that already exist locally are no longer replaced without asking. Symbolic links inside the folder are not followed but skipped and counted in the final status line, like special files and names that cannot be used on the target (on Windows for example `a:b`, `nul.txt` or a trailing dot). Downloads to Windows are rejected before anything is transferred if two names differ only in case. Folders with more than 10,000 entries or nested deeper than 32 levels are rejected before anything is transferred; Cancel also stops reading the folder. The final status line names up to five failed files, and after a cancel it says how many files were transferred; if the connection is lost, the rest of the folder is dropped with one message instead of one error per file. New uploaded files get 0644, or 0755 if the local file is executable (Linux). Without SFTP (exec listing) folder transfers stay unavailable (issue #11).

### Fixed

- Linux: a touchpad pinch no longer scales the whole interface. It now changes the font size of the focused terminal or editor, in the same steps as Ctrl+mouse wheel (one size per 10 % pinch); a pinch while neither has the focus does nothing. WebKitGTK handled the pinch itself as page zoom, out of reach of the app's zoom guard; Werkterm now turns that off and handles the gesture itself. The interface size setting is unchanged. Windows already ignored the pinch for the interface (issue #27).
- Terminal: a connection that fails to start (for example a connect, name resolution or address timeout, a rejected login or a cancelled password prompt) now ends like a regular disconnect. The error stays visible and is followed by the usual hints: Return closes the tab, R restarts the session, S saves the output. If the shell already ended while the connection was still being set up, the error is shown once, above the hints, instead of below them.
- Paste dialog: Enter now confirms the paste as soon as the dialog opens, and Escape cancels. Focus used to land in the text field, so Enter only inserted a line break. In the text field Enter still inserts a line break; checkbox, selection and the other buttons keep their own Enter behaviour. The confirming Enter is no longer passed on to the terminal.
- Shared data folder: designs and icon sets changed outside Werkterm (for example on another device through a cloud folder) are now picked up when the window gets focus, like sessions, tunnels, macros and settings. New designs appear, changed ones are replaced and deleted ones disappear; a changed active design is applied right away. If the active design is still missing at the next check (so a half-synced file or a rename that arrives before the settings does not count), the default design is used and the status line says so. Designs being edited in Werkterm are not reloaded until the edit is saved. The active imported icon set is reloaded; if it no longer exists, the default icons are used. A folder that cannot be read, or a reload that fails, is tried again at the next check (issue #3).
- Data folder switch: if copying the current data to the new folder fails, or the new location cannot be saved afterwards, everything the switch created there is removed again, including folders created for the new path. Files and folders that already existed in the target are never touched. Folders only go when they are empty, files only when their size and modification time are still those of the copy (a sync client may have replaced them in the meantime), and nothing is removed through a symlink or junction that replaced a folder on the way. The error message keeps the original cause and adds the result: partial copy removed, or how many entries remain in which folder (issue #4).
- Transfers: the cancel button and a progress bar (share of the file, or of the folder by files) now stay at a fixed place on the left of the status bar instead of moving with the length of the transfer text (issue #29).
- Toolbar: at a large interface size the labels wrap below the icons instead of overlapping them (issue #30).
- Paste dialog: the remembered choice is offered "for this session", matching the session dialog, instead of "for the profile" (issue #31).
- Linux: dropping files or folders onto the file browser works on HiDPI screens (for example Ubuntu 26.04 at 200 %). The drop position, already in logical pixels on Linux, was scaled down a second time and missed the file list. Under the experimental Cinnamon Wayland session (Linux Mint) the desktop delivers no drop events at all; there the upload button or the X11 session works (issue #28).

## [1.2.0] – 2026-11-20

### Added

- Settings > Updates > Update channel: Stable or Test, stored per device and not synced (Stable by default). The test channel offers whichever is newer, the latest test build or the latest stable release; if one of the two cannot be read, the other one is used and the update dialog says which one was not checked. Back on Stable, the latest stable release is offered even when an installed test build is newer; installing that downgrade needs an explicit confirmation in the update dialog, which warns that settings only known to the newer version may be lost. The install only proceeds with the exact version the dialog showed. `WERKTERM_UPDATE_CHANNEL=test` or `=stable` still overrides the setting. .deb installs keep getting updates through APT; the settings say so.

## [1.1.0] – 2026-11-16

### Fixed

- Linux: the window no longer stays black on NVIDIA graphics with the open-source nouveau driver; Werkterm now applies the WebKit workaround (`WEBKIT_DISABLE_DMABUF_RENDERER=1`, also under Wayland) there too.
- Linux: started from a shell without a graphical session (for example over SSH, after `su -` or on a text console), Werkterm now prints a short explanation and exits with code 1 instead of aborting with a GTK panic.
- SSH: the helper command for "Follow terminal folder" no longer stays visible on hosts with slow logins (it is only sent once a shell prompt is recognised, never into password prompts, questions or full-screen programs, and not after the user started typing), and it no longer appears in the shell history on systems without `HISTCONTROL=ignorespace` (for example AlmaLinux).

### Changed

- Settings: the tabs are listed on the left and the dialog is wider, so all tabs fit without scrolling sideways; only the content scrolls. Arrow keys, Home and End move between tabs. "Clear recent" is a button in the General tab.
- The update dialog shows the release notes formatted (headings, lists, code) instead of raw Markdown. Links stay plain text.

## [1.0.0] – 2026-11-15

### Added

- AppStream metadata in the .deb, so software centers show Werkterm with description, license and links to the project page and issue tracker on GitHub.
- Linux menu entry: the description (`Comment`) is English by default with a German translation (`Comment[de]`), so desktop environments show it in the system language. It is listed only under System (terminal emulators), no longer also under Network, so it no longer appears twice in some menus.
- Interface language German or English: Settings > General > Language ("System language" by default; any system language other than English falls back to German). Stored per device. Menus, toolbar, sidebar, tabs, start page, keyboard-shortcut help and the settings tabs are translated, and so are all dialogs, the editor (including the search panel and folding), the file browser, sessions, tunnels, macros, tools, data folder and update dialogs. Messages from the backend (connection, file, session, tunnel, update and device errors) are sent as codes and shown in the interface language; technical details from libraries and the operating system (for example "os error 2") stay in their original English wording.

### Changed

- German menu and toolbar names are now consistently German: Sitzungen, Werkzeuge, Ansicht, Teilen, Einstellungen, Hilfe, Makros, Schnellverbindung. Alt shortcuts for the German menus follow the new names (for example Alt+A for Ansicht instead of Alt+V, Alt+W for Werkzeuge instead of Alt+O); the shortcut help lists them for the current language.
- Dates, numbers and sorting follow the interface language instead of a fixed German locale.
- The settings dialog opens on the new General tab.
- German texts follow one style: no "bitte", no direct address, consistent terms (for example Sprungserver instead of "Jump host", Übertragung instead of "Transfer", Im Editor öffnen, Aktualisieren, Fingerabdruck); English leftovers such as "Refresh" or "Follow Terminal Folder" are German now.
- Sizes and counts use the decimal and thousands separators of the interface language (German "1,5 KB", "100.000").
- Session logs of Telnet and serial connections record connection notices as language-neutral codes (for example `[SERIAL_REMOVED device=/dev/ttyUSB0]`) instead of German text.
- When several tunnels fail to start automatically, every failure is reported with its tunnel name instead of one combined text.
- Errors in damaged data files (macros, sessions, tunnels, recent list) only name line and column, so no values from the file (such as typed text) appear in the status line.

### Removed

- Takeover of sessions, keyring entries and interface preferences from installations made before the rename to Werkterm (before 0.1.0).

### Fixed

- AppImage: the GStreamer plugins WebKitGTK needs are now included. Before, the window could stay black or rendering could crash unless `GST_PLUGIN_PATH_1_0` pointed to the system plugins; remove this variable from 1.0.0 on.

## [0.1.8] – 2026-11-13

### Added

- Update check: "Hilfe > Nach Updates suchen…" asks https://pkg.werklade.de for a newer version. AppImage, NSIS and MSI installations download and install the signed update themselves; .deb installations are pointed to the package manager. A check at startup is opt-in (Settings > Updates, off by default). Werkterm contacts no other host, and never without this click or setting.

- Paste confirmation dialog: the new list "Remember choice?" offers "Don't remember", "Remember for this tab", "Remember for the profile" (saved session) and "Remember permanently". The remembered choice is the action (paste / paste as one line) including "Remove last line break". Content with control characters always asks. With MultiExec only "Remember permanently" applies. Settings show the current state and offer "Reset remembered choice".
- `npm run check-paths` checks release binaries for user paths of the build machine.
- Selectable data folder: on first start Werkterm asks "Choose data folder" (default folder or a folder of your own, for example one synchronized by a cloud client and shared by several devices). Changeable later under Settings > Data folder; Werkterm restarts on change, running tunnels are stopped and open connections are closed after confirmation.
  - The data folder holds `sessions.json`, `tunnels.json`, `macros.json`, `settings.json`, `designs/` and `icon-sets/`. Per device stay: passwords (OS keyring), recent list, last open tabs, editor cache, logs and the log folder path, window and column widths.
  - If the chosen folder already contains Werkterm data, it is used; otherwise the existing data can be copied there (nothing is overwritten, the source stays unchanged).
  - If the folder is unreachable (for example a cloud drive that is not mounted), a dialog offers "Try again", "Choose another folder" and "Use default folder". Nothing is written until then; there is no silent fallback.
  - Changes from outside (sync client) are detected when the window regains focus and reloaded. Before saving, settings are compared with the last version read; if they differ, only your own changes are applied on top of the new version.
  - Settings now live in `settings.json` instead of the webview storage; existing settings are taken over once.
  - Known limit: if two devices edit the same session at the same time, the last saved version wins or the sync client creates a conflict copy. The files are not encrypted and contain host names and user names, but no passwords.

### Changed

- Ctrl+mouse wheel and the two-finger zoom gesture now change the font size of the terminal or editor tab under the pointer instead of scaling the whole window. The zoom applies to that tab only and is not saved; the terminal context menu and "Schrift Standard" reset it.
- .deb: `libdbus-1-3` is now a dependency, `xdg-utils` a recommendation.
- Linux packages require glibc 2.39 or newer (Debian 13, Ubuntu 24.04 and derivatives). The .deb now declares `libc6 (>= 2.39)`, so older systems such as Debian 12 refuse the installation instead of failing at startup.

### Fixed

- Linux/GNOME: the running window showed a gear instead of the Werkterm icon in the panel, and a pinned launcher was not recognized as running. The desktop entry now names the window class (`StartupWMClass`).
- Windows: saving sessions, tunnels, macros and settings repeats the last step briefly if a sync client currently holds the file locked.
- Linux: black window on systems with NVIDIA graphics and the proprietary driver. At startup Werkterm sets `WEBKIT_DISABLE_DMABUF_RENDERER=1`, under Wayland also `__NV_DISABLE_EXPLICIT_SYNC=1`, only if such a graphics card is detected and none of these variables (including `WEBKIT_DISABLE_COMPOSITING_MODE`) is set by the user. The variables are not passed on to local terminals. Disable with `WERKTERM_NO_WEBKIT_WORKAROUND=1`; force on affected systems without a detected NVIDIA card with `WERKTERM_WEBKIT_WORKAROUND=1`.
- Release packages no longer contain directory paths of the build machine (source paths in the executable are rewritten).
- Paste: control characters in the range U+0080–U+009F are recognized as control characters.
- Monitor bar: RAM is now shown in binary units (GiB, tooltip MiB) and matches what Proxmox and `free -h` report. Before, 93.46 GiB appeared as 100.35 GB.

## [0.1.7] – 2026-11-08

### Fixed

- SSH: shells started inside an SSH session, for example `pct enter` on Proxmox, `su` or new tmux windows, no longer print `__werkterm_osc7: command not found` before every prompt. The Follow Terminal Folder hook no longer exports `PROMPT_COMMAND` and only runs where its function is defined.

## [0.1.6] – 2026-11-08

### Changed

- Werklade Hell: text on orange buttons is now slate instead of white, so it meets WCAG AA contrast (4.5:1 instead of 3.3:1).
- The primary dialog button uses the new design token `accent-hover-fill` under the pointer (Werklade Hell: a lighter orange, so slate text stays readable). Custom designs saved without this token keep their own hover colour.

## [0.1.5] – 2026-11-08

### Changed

- New Werkterm logo and app icon in the Werklade style (slate tile, orange drawer with a prompt, grey drawer), taken from the shared Werklade design set; replaces the blue terminal icon with Tux.

## [0.1.4] – 2026-11-08

### Changed

- Werklade Dunkel and Werklade Hell are built directly from the shared Werklade design tokens; `npm run sync-design` also copies the shared icons, `npm run check-design` reports differences without changing files.
- The home, MultiExec, help, split, view and quit icons now come from the shared Werklade icon set.

### Fixed

- Werklade icons: the quit icon sits in a tinted ring like the refresh and undo icons instead of an open, filled power symbol.

## [0.1.3] – 2026-11-08

### Added

- Windows 10/11 x64 packages: NSIS installer (per user, no admin rights, German/English) and MSI.
- Hardware overview on Windows with the same sections as on Linux (System, CPU, Memory, Hardware, Disks, Network, DNS).

### Changed

- Werklade icons: new-session, new-folder, new-file and parent-folder icons carry a round badge (plus or arrow) that closes the outline; refresh, undo, redo, wrap and jump arrows sit in a tinted ring instead of a filled disc.

## [0.1.2] – 2026-11-08

### Added

- Designs: the whole app (interface, terminal, editor, monitoring) follows a design. New built-in designs Werklade Dunkel (default for new installs) and Werklade Hell; a Design tab edits colours with live preview and contrast warnings, duplicates, exports and imports designs.
- Icon sets: Standard and Werklade (duotone with a soft accent fill) built in; import a folder of SVG files (sanitized) and export a template to create your own.
- Export all, selected or folder sessions to a Werkterm session file (no passwords) and import it on another device with preview, duplicate detection and jump-host remapping.

### Changed

- The Sessions menu lists new session, panel and import/export actions above the saved sessions.

## [0.1.1] – 2026-11-08

### Fixed

- The hardware overview keeps the shell open instead of ending the session.
- WindTerm import explains `profiles.config` problems (Windows paths, missing `user.sessions`) and falls back to other `default.v*` profiles.
- Shell dotfiles (`.bashrc`, `.profile`, …) and env/config files without extensions are syntax-highlighted.
- In MultiExec, clicking a terminal makes it active, so the monitoring bar and SSH browser follow it.

## [0.1.0] – 2026-11-08

### Added

- Tauri 2 application for Linux with Rust and React/TypeScript, Debian and AppImage packaging; Windows/WSL development support.
- Local, SSH, Telnet and serial terminals, split views, MultiExec, terminal settings and Linux root/process/hardware tools.
- SSH/SFTP on one connection, exec listing fallback, known_hosts checks, agent/key/password authentication, PuTTY keys, keepalive, jump-host chains and local/remote/SOCKS5 tunnels.
- Remote monitoring with detailed tooltips.
- OSC 7 directory following, queued file transfers, drag and drop, file/directory creation, recursive deletion/chmod and sudo mode.
- Saved session folders, search, recent sessions, last-tab restoration, MobaXterm/WindTerm session imports, MobaXterm color import and keyring-backed passwords.
- Local/remote editor with syntax highlighting, folding, search/replace, color-code backgrounds, UTF-8/EOL/BOM handling, conflict checks, in-place writes and per-instance cache backups.
- File comparison and recursive folder/content comparison.
- Macro recording/playback, text/wait/prompt steps, shortcuts and MultiExec integration.
- Terminal copy/export (TXT/HTML/RTF), editable paste confirmation, session logging, close confirmation and Return/R/S session-end menu.
- SSH key generation, open local ports, ASCII table, Linux serial-permission assistance and Tux idle animation.
- English/German READMEs with Linux screenshots and architecture documentation.

### Changed

- Renamed the project to Werkterm, including product, package/executable and application identifier (`de.werklade.werkterm`); the integrated editor is named Editor.
- Copy valid legacy `sessions.json` when the new configuration has no session file, preserving the original. Migrate legacy keyring entries on use. Frontend localStorage preferences start fresh.
- Open the SSH shell before SFTP to preserve PAM login messages; drain terminal output immediately to avoid setup deadlocks.
- Use cancellable Linux PTY reading and process-group termination with SIGKILL escalation.
