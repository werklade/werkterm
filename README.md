# Werkterm – SSH terminal with SFTP browser and editor for Linux and Windows

Deutsche Fassung: [README.de.md](README.de.md)

Werkterm is a desktop application built with Tauri 2, Rust and React. It provides local terminals, SSH with an SFTP browser that follows the terminal directory, and an integrated editor. It targets Linux first and also runs on Windows 10/11 x64.

> [!NOTE]
> Werkterm is a prerelease (currently 0.1.6) for invited testers. Please submit feedback through Issues.

## Independence and trademarks

Werkterm is a private, independent project with no affiliation to Mobatek. It has not been commissioned, reviewed or supported by Mobatek. MobaXterm is a trademark of Mobatek and is mentioned only to describe importing sessions and colors. WindTerm, Debian and other product names are trademarks of their respective owners. The software is supplied without warranty under the GPL; see [LICENSE](LICENSE).

## Screens

| Terminal and SFTP | Editor |
| --- | --- |
| ![SSH terminal beside the directory-following SFTP browser](docs/screenshots/terminal-sftp.png) | ![Editor with syntax highlighting and color-code backgrounds](docs/screenshots/editor-colors.png) |
| Sessions and import | Permissions and sudo |
| ![Session import dialog](docs/screenshots/sessions-import.png) | ![File permissions dialog of the SFTP browser](docs/screenshots/permissions-sudo.png) |


## Features

- **Terminals:** local Bash/configured shell on Linux; PowerShell, cmd and WSL on Windows. Hardware overview on Linux and Windows, root terminal and processes on Linux; SSH, Telnet and serial sessions. Tabs, split views, MultiExec, font/cursor/scrollback/color settings. Context menu: copy, copy all, clear, save as TXT/HTML/RTF. Editable paste confirmation, session logging and close confirmation. Session-end menu: Return closes, R reconnects in the same tab, S saves output.
- **SSH:** one connection with shell and SFTP channels, exec listing fallback, host-key verification against `known_hosts`, agent/key (including `.ppk`)/password authentication, keepalive and jump-host chains. Tunnel manager for `-L`, `-R` and SOCKS5, with separate background connections, autostart, reconnect and status. Monitoring bar with tooltips for host, CPU, RAM, network, uptime, users and filesystems.
- **SFTP browser:** Follow Terminal Folder via OSC 7, navigation, sorting, queued file transfers with progress/cancellation and drag and drop. Create files/directories, confirmed recursive deletion, recursive chmod with separate file/directory settings, sudo mode and “remember for comparison”. Local and WSL directory browsing is also available.
- **Sessions:** folders, search, quick connect, recent sessions and last-tab restoration. Session import from MobaXterm and WindTerm; color import from MobaXterm. Saved passwords use the system keyring. Encrypted imported passwords are not recovered.
- **Editor:** syntax highlighting, folding, search/replace and live color-code backgrounds with BT.601 contrast selection. CRLF/LF/CR detection and conversion, mixed-line-ending warning, UTF-8 with/without BOM, conflict checks and in-place saving with permissions preserved.
- **Tools:** read-only file comparison (local/remote/mixed), recursive folder comparison with optional content comparison, macros with recording, text/wait/prompt steps and shortcuts, SSH key generation, open local ports, ASCII table and Tux wanderer idle animation. Linux serial-permission assistance identifies device groups such as dialout/uucp and offers a confirmed command in a local terminal.

## Requirements

Windows 10/11 x64 with Microsoft Edge WebView2 (preinstalled on current Windows; the installer downloads it if missing).

Linux x86_64 with WebKitGTK 4.1 and GTK 3: Debian-family runtime packages include `libwebkit2gtk-4.1-0` and `libgtk-3-0`. Recommended: `gnome-keyring` or another Secret Service provider, and `fonts-noto-color-emoji`. OpenSSH is the intended SSH server; SFTP is recommended. Browser writes/transfers require SFTP; sudo mode also needs sudo permission and an external `sftp-server` executable.

## Installing

Prebuilt packages (`.deb`, AppImage, `SHA256SUMS`) are attached to the GitHub release, visible to invited testers; alternatively build them as described below. Tested on Debian 13 (WebKitGTK 2.54). The product name is `Werkterm`, the package/executable name is `werkterm`. The recorded Linux build uses these case-sensitive artifact names.

Debian-family systems, Bash (installs a system package):

```bash
sudo apt install ./Werkterm_0.1.6_amd64.deb
```

Verify by starting `werkterm`. To uninstall: `sudo apt remove werkterm`.

AppImage, Bash (`libfuse2` required; its package name can vary by distribution):

```bash
chmod +x ./Werkterm_0.1.6_amd64.AppImage
./Werkterm_0.1.6_amd64.AppImage
```

Verify that the application window opens.

Windows: run `Werkterm_0.1.6_x64-setup.exe` (installs for the current user, no admin rights) or deploy `Werkterm_0.1.6_x64_en-US.msi`. The packages are not code-signed, so SmartScreen shows "Unknown publisher" on first start; choose "More info" → "Run anyway". Uninstall via Settings → Apps. Settings and sessions are stored in `%APPDATA%\de.werklade.werkterm`. If the taskbar still shows the old icon after an update, that is the Windows icon cache: run `ie4uinit.exe -show` or sign out and back in.

Check downloads against `SHA256SUMS` (Linux: `sha256sum -c SHA256SUMS`, Windows PowerShell: `Get-FileHash <file>`).

## Building

Use Linux x86_64, Rust stable with Edition 2024 support, Node.js with npm and the [official Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/). Windows packages are built on Windows. The frontend uses TypeScript `~6.0.3`; manifests and lockfiles define dependencies. The project declares no minimum Node.js version.

From the project root, Bash:

```bash
npm ci
npm run tauri dev
```

For Linux packages, Bash:

```bash
npm run tauri build
```

Output: `src-tauri/target/release/bundle/{deb,appimage}` on Linux, `src-tauri/target/release/bundle/{nsis,msi}` on Windows (stop a running dev instance first). Verify the generated artifacts and launch the installed package or AppImage.

Tests, Bash:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
npm test
```

Both commands should exit successfully. The optional live SSH test is ignored by default and requires an explicitly configured test server.

## Security

Saved authentication passwords are stored only in the system keyring, never in configuration files or application diagnostic logs. Authentication prompts hold secrets in memory while needed; `sessions.json` contains settings without stored passwords. A sudo password is sent only to sudo and never saved.

There is no telemetry or automatic service discovery. Connections serve user-configured SSH targets/jump hosts, Telnet targets and tunnel listeners/forwarded destinations; autostart tunnels can connect at startup. Telnet is unencrypted.

Host keys are checked against `known_hosts`: unknown keys require confirmation with a SHA256 fingerprint; changed keys abort the connection. Session logs/exports contain displayed terminal text; macros store recorded text in plaintext. Do not record or echo secrets into these features. Macro playback intentionally bypasses paste confirmation.

## Technical overview

The Rust backend uses Tauri 2, `russh`, `russh-sftp`, `portable-pty`, `keyring` and `serialport`. Commands handle requests; Tauri channels stream terminal bytes and transfer progress. React uses xterm.js and CodeMirror 6, including `@codemirror/merge` for comparison. See [architecture (German)](docs/architektur.md).

## Known limitations

- No folder upload/download; recursive folder comparison is a separate feature.
- Automatic remote OSC 7 setup supports Bash only; other shells need their own integration. The injected command's echo is cleared after execution.
- Remote editor conflict checks use file size and second-resolution modification time: same-size changes within one second can go undetected. Local files also have identity and finer timestamp checks.
- The editor supports UTF-8 text only, up to 10 MiB. Mixed line endings require explicit normalization before saving.
- A host with only another key type in `known_hosts` is rejected as changed. Review the entry before replacing it.
- Exec listing requires GNU-compatible tools and does not provide SFTP writes/transfers.
- Secret Service or session D-Bus may be unavailable, especially under WSL; saved-password operations then report an error.
- Windows/WSL development: WSL tabs use the default distribution; PowerShell UNC directory listing is not confirmed.
- Linux serial-permission assistance still needs a real-device test in the packaged application. STATUS.md also lists window-level SSH close confirmation as awaiting manual verification.

## Roadmap

Deferred: detached tabs, popup console, Mosh/RDP/VNC. Macros and the other features above are implemented despite older deferred/open entries in STATUS.md.

Not planned: master password (system keyring is used), bundled X11/Cygwin, network/port scanner, packet capture and, for now, Wake on LAN.

## License

GPL-3.0-or-later; see [LICENSE](LICENSE).

Third-party graphics: Tabler Icons (MIT; [license](src/assets/icons/LICENSE-tabler-icons.txt)); Debian Open Use Logo, copyright Software in the Public Interest, Inc., under LGPL-3.0-or-later or CC BY-SA 3.0. Debian is a registered trademark of SPI. Werkterm is not affiliated with the Debian project; the logo only identifies Debian hosts. See [icon attribution](src/assets/icons/README.md).

Important libraries include Tauri, russh, russh-sftp, xterm.js, CodeMirror (including `@codemirror/merge`), portable-pty, keyring and serialport. Their respective licenses apply to those components.

## Origin

The project was developed with the assistance of Claude Code. OpenAI Codex CLI, Google Antigravity and local Ollama were also used for individual tasks.
