# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
