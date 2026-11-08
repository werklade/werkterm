# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
