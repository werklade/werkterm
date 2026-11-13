# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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

- Renamed LinMoba to Werkterm, including product, package/executable and application identifier (`de.werklade.werkterm`); the integrated editor is named Editor.
- Copy valid legacy `sessions.json` when the new configuration has no session file, preserving the original. Migrate legacy keyring entries on use. Frontend localStorage preferences start fresh.
- Open the SSH shell before SFTP to preserve PAM login messages; drain terminal output immediately to avoid setup deadlocks.
- Use cancellable Linux PTY reading and process-group termination with SIGKILL escalation.
