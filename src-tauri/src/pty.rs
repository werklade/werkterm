use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ShellKind {
    Local,
    Wsl,
}

pub enum Platform {
    Windows,
    Unix,
}

impl Platform {
    pub fn current() -> Self {
        #[cfg(windows)]
        {
            Self::Windows
        }
        #[cfg(not(windows))]
        {
            Self::Unix
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct ShellSpec {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

#[derive(Debug)]
pub enum PtyError {
    UnknownSession(u32),
    InvalidSize,
    UnsupportedShell(String),
    Poisoned,
    IdExhausted,
    Operation(String),
}

impl fmt::Display for PtyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownSession(id) => write!(f, "Unbekannte PTY-Sitzung: {id}"),
            Self::InvalidSize => f.write_str("PTY-Abmessungen müssen größer als null sein"),
            Self::UnsupportedShell(message) | Self::Operation(message) => f.write_str(message),
            Self::Poisoned => f.write_str("PTY-Sitzungssperre ist beschädigt"),
            Self::IdExhausted => f.write_str("PTY-Sitzungsnummern sind ausgeschöpft"),
        }
    }
}

impl std::error::Error for PtyError {}

fn operation(error: impl fmt::Display) -> PtyError {
    PtyError::Operation(error.to_string())
}

const POWERSHELL_OSC7: &str = r#"$Global:WerktermOriginalPrompt = $function:prompt; function Global:prompt { $p = $executionContext.SessionState.Path.CurrentLocation.ProviderPath; if ($p) { $uri = [System.Uri]::new($p); $u = $uri.AbsolutePath; $h = $env:COMPUTERNAME; if ($uri.IsUnc) { $u = '//' + $uri.Host + $u }; if (-not $u.StartsWith('/')) { $u = '/' + $u }; [Console]::Write(([char]27 + ']7;file://' + $h + $u + [char]7)) }; if ($Global:WerktermOriginalPrompt) { & $Global:WerktermOriginalPrompt } else { "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) " } }"#;
// LC_ALL=C makes substring iteration operate on bytes, including UTF-8 paths.
const BASH_OSC7_FUNCTION: &str = r#"__werkterm_osc7() { local LC_ALL=C p="$PWD" out='' c i; for ((i=0;i<${#p};i++)); do c="${p:i:1}"; case "$c" in [-_.~a-zA-Z0-9/]) out+="$c";; *) printf -v c '%%%02X' "'$c"; out+="$c";; esac; done; printf '\033]7;file://%s%s\007' "${WSL_DISTRO_NAME:-$HOSTNAME}" "$out"; }"#;

fn bash_osc7_startup() -> String {
    format!(
        "{BASH_OSC7_FUNCTION}; export -f __werkterm_osc7; export PROMPT_COMMAND='__werkterm_osc7'\"${{PROMPT_COMMAND:+;$PROMPT_COMMAND}}\"; exec bash -i"
    )
}

pub fn resolve_shell(
    kind: ShellKind,
    platform: Platform,
    env_shell: Option<String>,
    shell_integration: bool,
    has_program: impl Fn(&str) -> bool,
) -> Result<ShellSpec, PtyError> {
    let is_unix = matches!(platform, Platform::Unix);
    let (program, mut args) = match (platform, kind) {
        (Platform::Windows, ShellKind::Local) => (
            if has_program("pwsh.exe") {
                "pwsh.exe"
            } else {
                "powershell.exe"
            }
            .to_owned(),
            vec!["-NoLogo".to_owned()],
        ),
        (Platform::Windows, ShellKind::Wsl) if has_program("wsl.exe") => {
            ("wsl.exe".to_owned(), vec![])
        }
        (Platform::Windows, ShellKind::Wsl) => {
            return Err(PtyError::UnsupportedShell(
                "wsl.exe wurde nicht im PATH gefunden".to_owned(),
            ));
        }
        (Platform::Unix, ShellKind::Local) => (
            env_shell
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "/bin/sh".to_owned()),
            vec![],
        ),
        (Platform::Unix, ShellKind::Wsl) => {
            return Err(PtyError::UnsupportedShell(
                "WSL ist nur unter Windows verfügbar".to_owned(),
            ));
        }
    };
    let env = Vec::new();
    if shell_integration {
        match kind {
            ShellKind::Wsl => {
                args = [
                    "-e".to_owned(),
                    "bash".to_owned(),
                    "-c".to_owned(),
                    bash_osc7_startup(),
                ]
                .to_vec();
            }
            ShellKind::Local if !is_unix => {
                args = ["-NoLogo", "-NoExit", "-Command", POWERSHELL_OSC7]
                    .map(str::to_owned)
                    .to_vec();
            }
            ShellKind::Local
                if std::path::Path::new(&program)
                    .file_name()
                    .is_some_and(|name| name == "bash") =>
            {
                args = vec!["-c".to_owned(), bash_osc7_startup()];
            }
            ShellKind::Local => {}
        }
    }
    Ok(ShellSpec { program, args, env })
}

pub fn program_in_path(name: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path).any(|directory| directory.join(name).is_file())
    })
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    #[cfg(not(unix))]
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    #[cfg(unix)]
    control: Arc<UnixControl>,
}

#[cfg(unix)]
#[derive(Default)]
struct UnixControl {
    stop: std::sync::atomic::AtomicBool,
    kill: std::sync::atomic::AtomicBool,
}

#[cfg(unix)]
fn signal_shell_group(pid: libc::pid_t, signal: libc::c_int) -> std::io::Result<()> {
    // The unreaped child owns this PID. Never target our own or an unrelated group.
    unsafe {
        if pid <= 1 || libc::getpgid(pid) != pid || libc::getpgrp() == pid {
            return Err(std::io::Error::other("Invalid PTY shell process group"));
        }
        if libc::kill(-pid, signal) == -1 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(unix)]
fn read_unix(mut reader: std::fs::File, control: &UnixControl, on_data: &mut dyn FnMut(Vec<u8>)) {
    use std::os::fd::AsRawFd;
    use std::time::{Duration, Instant};
    let mut deadline = None;
    let mut buffer = [0; 8192];
    loop {
        if control.stop.load(Ordering::Acquire) && deadline.is_none() {
            deadline = Some(Instant::now() + Duration::from_millis(200));
        }
        if deadline.is_some_and(|end| Instant::now() >= end) {
            break;
        }
        let mut fd = libc::pollfd {
            fd: reader.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // Only this thread reads the duplicated master, so readiness cannot be
        // consumed by another reader between poll and read.
        let ready = unsafe { libc::poll(&mut fd, 1, 20) };
        if ready < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            break;
        }
        if ready == 0 {
            continue;
        }
        if fd.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) == 0 {
            break;
        }
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => on_data(buffer[..count].to_vec()),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<u32, Session>>>,
    next_id: AtomicU32,
}

impl Default for PtyManager {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU32::new(1),
        }
    }
}

fn size(cols: u16, rows: u16) -> Result<PtySize, PtyError> {
    if cols == 0 || rows == 0 {
        return Err(PtyError::InvalidSize);
    }
    Ok(PtySize {
        cols: cols.min(1000),
        rows: rows.min(1000),
        pixel_width: 0,
        pixel_height: 0,
    })
}

impl PtyManager {
    fn sessions(&self) -> Result<MutexGuard<'_, HashMap<u32, Session>>, PtyError> {
        self.sessions.lock().map_err(|_| PtyError::Poisoned)
    }

    pub fn spawn(
        &self,
        spec: &ShellSpec,
        cols: u16,
        rows: u16,
        mut on_data: Box<dyn FnMut(Vec<u8>) + Send>,
        on_exit: Box<dyn FnOnce(Option<u32>) + Send>,
    ) -> Result<u32, PtyError> {
        let size = size(cols, rows)?;
        let id = self
            .next_id
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .map_err(|_| PtyError::IdExhausted)?;
        let mut sessions = self.sessions()?;
        let pair = native_pty_system().openpty(size).map_err(operation)?;
        #[cfg(not(unix))]
        let mut reader = pair.master.try_clone_reader().map_err(operation)?;
        #[cfg(unix)]
        let reader = {
            use std::os::fd::BorrowedFd;
            let fd = pair
                .master
                .as_raw_fd()
                .ok_or_else(|| operation("Missing PTY FD"))?;
            // Duplicate ownership: dropping the session cannot invalidate the reader FD.
            let owned = unsafe { BorrowedFd::borrow_raw(fd) }
                .try_clone_to_owned()
                .map_err(operation)?;
            std::fs::File::from(owned)
        };
        #[cfg(unix)]
        let control = Arc::new(UnixControl::default());
        #[cfg(unix)]
        let reader_control = Arc::clone(&control);
        #[cfg(unix)]
        let waiter_control = Arc::clone(&control);
        let writer = pair.master.take_writer().map_err(operation)?;
        let mut command = CommandBuilder::new(&spec.program);
        command.args(&spec.args);
        for (name, value) in &spec.env {
            command.env(name, value);
        }
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        let home_key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        if let Some(home) = std::env::var_os(home_key) {
            command.cwd(home);
        }
        let (reader_done, reader_finished) = std::sync::mpsc::channel();
        let reader_thread = std::thread::Builder::new()
            .name(format!("pty-reader-{id}"))
            .spawn(move || {
                #[cfg(unix)]
                read_unix(reader, &reader_control, &mut on_data);
                #[cfg(not(unix))]
                {
                    let mut buffer = [0; 8192];
                    loop {
                        match reader.read(&mut buffer) {
                            Ok(0) | Err(_) => break,
                            Ok(count) => on_data(buffer[..count].to_vec()),
                        }
                    }
                }
                let _ = reader_done.send(());
            })
            .map_err(operation)?;
        let (child_sender, child_receiver) =
            std::sync::mpsc::channel::<Box<dyn portable_pty::Child + Send + Sync>>();
        let session_map = Arc::clone(&self.sessions);
        std::thread::Builder::new()
            .name(format!("pty-waiter-{id}"))
            .spawn(move || {
                let Ok(mut child) = child_receiver.recv() else {
                    #[cfg(unix)]
                    {
                        waiter_control.stop.store(true, Ordering::Release);
                        let _ = reader_thread.join();
                    }
                    return;
                };
                #[cfg(unix)]
                let status = {
                    let mut kill_deadline = None;
                    loop {
                        // Signals are sent before try_wait can reap and release the PID.
                        if waiter_control.kill.load(Ordering::Acquire)
                            && let Some(pid) = child
                                .process_id()
                                .and_then(|pid| libc::pid_t::try_from(pid).ok())
                        {
                            if kill_deadline.is_none() {
                                let _ = signal_shell_group(pid, libc::SIGHUP);
                                kill_deadline = Some(
                                    std::time::Instant::now() + std::time::Duration::from_secs(2),
                                );
                            } else if kill_deadline
                                .is_some_and(|end| std::time::Instant::now() >= end)
                            {
                                let _ = signal_shell_group(pid, libc::SIGKILL);
                            }
                        }
                        match child.try_wait() {
                            Ok(Some(status)) => break Some(status.exit_code()),
                            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
                            Err(_) => {
                                if let Some(pid) = child
                                    .process_id()
                                    .and_then(|pid| libc::pid_t::try_from(pid).ok())
                                {
                                    let _ = signal_shell_group(pid, libc::SIGKILL);
                                }
                                break child.wait().ok().map(|status| status.exit_code());
                            }
                        }
                    }
                };
                #[cfg(unix)]
                waiter_control.stop.store(true, Ordering::Release);
                #[cfg(not(unix))]
                let status = child.wait().ok().map(|status| status.exit_code());
                // Close ConPTY outside the lock while the reader drains its pipe.
                let removed = match session_map.lock() {
                    Ok(mut sessions) => sessions.remove(&id),
                    Err(poisoned) => poisoned.into_inner().remove(&id),
                };
                drop(removed);
                // Descendants may retain the Unix slave after the shell has exited.
                #[cfg(not(unix))]
                if reader_finished
                    .recv_timeout(std::time::Duration::from_secs(1))
                    .is_ok()
                {
                    let _ = reader_thread.join();
                }
                #[cfg(unix)]
                {
                    let _ = reader_finished.recv();
                    let _ = reader_thread.join();
                }
                on_exit(status);
            })
            .map_err(|error| {
                #[cfg(unix)]
                control.stop.store(true, Ordering::Release);
                operation(error)
            })?;
        let result = pair.slave.spawn_command(command);
        drop(pair.slave);
        let child = result.map_err(operation)?;
        sessions.insert(
            id,
            Session {
                master: pair.master,
                writer: Arc::new(Mutex::new(writer)),
                #[cfg(not(unix))]
                killer: child.clone_killer(),
                #[cfg(unix)]
                control,
            },
        );
        drop(sessions);
        if let Err(error) = child_sender.send(child) {
            let mut child = error.0;
            let _ = child.kill();
            let _ = child.wait();
            let removed = self.sessions()?.remove(&id);
            drop(removed);
            return Err(PtyError::Operation(
                "PTY-Warteprozess wurde getrennt".to_owned(),
            ));
        }
        Ok(id)
    }

    pub fn write(&self, id: u32, data: &[u8]) -> Result<(), PtyError> {
        let writer = {
            let sessions = self.sessions()?;
            let session = sessions.get(&id).ok_or(PtyError::UnknownSession(id))?;
            Arc::clone(&session.writer)
        };
        let mut writer = writer.lock().map_err(|_| PtyError::Poisoned)?;
        writer.write_all(data).map_err(operation)?;
        writer.flush().map_err(operation)
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), PtyError> {
        let sessions = self.sessions()?;
        let session = sessions.get(&id).ok_or(PtyError::UnknownSession(id))?;
        session.master.resize(size(cols, rows)?).map_err(operation)
    }

    pub fn kill(&self, id: u32) -> Result<(), PtyError> {
        #[cfg(unix)]
        {
            let sessions = self.sessions()?;
            let session = sessions.get(&id).ok_or(PtyError::UnknownSession(id))?;
            session.control.stop.store(true, Ordering::Release);
            session.control.kill.store(true, Ordering::Release);
            Ok(())
        }
        #[cfg(not(unix))]
        {
            let mut session = self
                .sessions()?
                .remove(&id)
                .ok_or(PtyError::UnknownSession(id))?;
            session.killer.kill().map_err(operation)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[cfg(windows)]
    #[test]
    fn windows_hardware_script_is_valid_encoded_and_keeps_shell_open() {
        let mut spec = ShellSpec {
            program: String::new(),
            args: vec![],
            env: vec![],
        };
        apply_start_command(&mut spec, Some(StartCommand::Hardware)).unwrap();
        assert_eq!(spec.program, "powershell.exe");
        assert_eq!(
            spec.args[..4],
            ["-NoLogo", "-NoProfile", "-NoExit", "-EncodedCommand"]
        );
        let script = include_str!("hardware.ps1");
        // Decode independently with PowerShell/.NET and parse with the Windows 5.1 parser.
        let validation = format!(
            "$script = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('{}')); \
             $expected = [Console]::In.ReadToEnd(); if ($script -cne $expected) {{ exit 2 }}; \
             $tokens = $null; $errors = $null; \
             [void][System.Management.Automation.Language.Parser]::ParseInput($script, [ref]$tokens, [ref]$errors); \
             if ($errors.Count) {{ $errors | ForEach-Object {{ [Console]::Error.WriteLine($_) }}; exit 1 }}",
            spec.args[4]
        );
        let mut child = std::process::Command::new(&spec.program)
            .args(["-NoProfile", "-Command", &validation])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(script.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        for command in [StartCommand::Root, StartCommand::Processes] {
            assert!(apply_start_command(&mut spec, Some(command)).is_err());
        }
        // Include non-ASCII and supplementary characters, and every base64 padding length.
        for (value, expected) in [
            ("", ""),
            ("a", "YQA="),
            ("ab", "YQBiAA=="),
            ("abc", "YQBiAGMA"),
            ("ä😀", "5AA92ADe"),
        ] {
            assert_eq!(encoded_powershell(value), expected);
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn tool_scripts_are_valid_and_keep_the_shell_open() {
        for command in [StartCommand::Hardware, StartCommand::Processes] {
            let mut spec = ShellSpec {
                program: String::new(),
                args: vec![],
                env: vec![],
            };
            apply_start_command(&mut spec, Some(command)).unwrap();
            let script = &spec.args[1];
            assert!(
                script.ends_with("\nexec \"${SHELL:-/bin/sh}\" -i"),
                "{script}"
            );
            // `sh -n` only parses; a stray ";" after a multi-line script used to end the tab.
            let status = std::process::Command::new("/bin/sh")
                .args(["-n", "-c", script])
                .status()
                .unwrap();
            assert!(status.success(), "syntax error in {command:?} script");
        }
    }

    #[cfg(unix)]
    struct UnixTestCleanup {
        manager: Arc<PtyManager>,
        id: u32,
        output: Arc<Mutex<Vec<u8>>>,
    }

    #[cfg(unix)]
    impl Drop for UnixTestCleanup {
        fn drop(&mut self) {
            let _ = self.manager.kill(self.id);
            // The background test prints its child PID before exiting. Clean it
            // even if a timeout assertion fails; it is not our waitable child.
            let output = self.output.lock().unwrap();
            for line in String::from_utf8_lossy(&output).lines() {
                if let Some(pid) = line
                    .trim()
                    .strip_prefix("background=")
                    .and_then(|pid| pid.parse::<libc::pid_t>().ok())
                    .filter(|pid| *pid > 1)
                {
                    unsafe {
                        libc::kill(pid, libc::SIGKILL);
                    }
                }
            }
            drop(output);
            let deadline = std::time::Instant::now() + Duration::from_secs(4);
            while self.manager.sessions().unwrap().contains_key(&self.id)
                && std::time::Instant::now() < deadline
            {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }

    #[cfg(unix)]
    fn unix_test_session(script: &str) -> (UnixTestCleanup, mpsc::Receiver<Option<u32>>) {
        let manager = Arc::new(PtyManager::default());
        let output = Arc::new(Mutex::new(Vec::new()));
        let received = Arc::clone(&output);
        let (tx, rx) = mpsc::channel();
        let id = manager
            .spawn(
                &ShellSpec {
                    program: "/bin/sh".to_owned(),
                    args: vec!["-c".to_owned(), script.to_owned()],
                    env: vec![],
                },
                80,
                24,
                Box::new(move |bytes| received.lock().unwrap().extend(bytes)),
                Box::new(move |status| {
                    let _ = tx.send(status);
                }),
            )
            .unwrap();
        (
            UnixTestCleanup {
                manager,
                id,
                output,
            },
            rx,
        )
    }

    #[cfg(unix)]
    #[test]
    fn kill_escalates_when_shell_ignores_hup() {
        let (cleanup, exit) = unix_test_session("trap '' HUP; echo ready; while :; do :; done");
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !String::from_utf8_lossy(&cleanup.output.lock().unwrap()).contains("ready") {
            assert!(
                std::time::Instant::now() < deadline,
                "Shell did not become ready"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let started = std::time::Instant::now();
        cleanup.manager.kill(cleanup.id).unwrap();
        exit.recv_timeout(Duration::from_secs(4))
            .expect("SIGHUP-ignoring shell survived escalation");
        assert!(started.elapsed() >= Duration::from_secs(2));
        assert!(
            !cleanup
                .manager
                .sessions()
                .unwrap()
                .contains_key(&cleanup.id)
        );
        assert!(matches!(
            exit.try_recv(),
            Err(mpsc::TryRecvError::Disconnected)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn shell_exit_joins_reader_with_background_slave_open() {
        let (cleanup, exit) =
            unix_test_session("trap '' HUP; sleep 30 & echo background=$!; exit 0");
        // The production watcher joins the reader before invoking on_exit. This
        // timeout therefore also checks that the reader join completes.
        assert_eq!(
            exit.recv_timeout(Duration::from_secs(3))
                .expect("Reader failed to join"),
            Some(0)
        );
        assert!(String::from_utf8_lossy(&cleanup.output.lock().unwrap()).contains("background="));
        assert!(
            !cleanup
                .manager
                .sessions()
                .unwrap()
                .contains_key(&cleanup.id)
        );
        assert!(matches!(
            exit.try_recv(),
            Err(mpsc::TryRecvError::Disconnected)
        ));
    }

    #[test]
    fn resolves_all_shell_combinations() {
        for (has_pwsh, expected) in [(true, "pwsh.exe"), (false, "powershell.exe")] {
            let shell = resolve_shell(ShellKind::Local, Platform::Windows, None, false, |_| {
                has_pwsh
            })
            .unwrap();
            assert_eq!(shell.program, expected);
            assert_eq!(shell.args, ["-NoLogo"]);
        }
        let wsl = resolve_shell(ShellKind::Wsl, Platform::Windows, None, false, |name| {
            name == "wsl.exe"
        })
        .unwrap();
        assert_eq!(wsl.program, "wsl.exe");
        assert!(wsl.args.is_empty());
        assert!(resolve_shell(ShellKind::Wsl, Platform::Windows, None, false, |_| false).is_err());
        for (env, expected) in [
            (None, "/bin/sh"),
            (Some(""), "/bin/sh"),
            (Some("/bin/bash"), "/bin/bash"),
        ] {
            let shell = resolve_shell(
                ShellKind::Local,
                Platform::Unix,
                env.map(str::to_owned),
                false,
                |_| false,
            )
            .unwrap();
            assert_eq!(shell.program, expected);
            assert!(shell.args.is_empty());
        }
        assert_eq!(
            resolve_shell(ShellKind::Wsl, Platform::Unix, None, false, |_| true)
                .unwrap_err()
                .to_string(),
            "WSL ist nur unter Windows verfügbar"
        );
    }

    #[test]
    fn shell_integration_preserves_disabled_behavior_and_selects_hooks() {
        for has_pwsh in [false, true] {
            let spec = resolve_shell(ShellKind::Local, Platform::Windows, None, true, |_| {
                has_pwsh
            })
            .unwrap();
            assert_eq!(spec.args[..3], ["-NoLogo", "-NoExit", "-Command"]);
            assert!(spec.args[3].contains("$Global:WerktermOriginalPrompt = $function:prompt"));
            assert!(spec.args[3].contains("function Global:prompt"));
            assert!(spec.args[3].contains("[char]27"));
            assert!(spec.args[3].contains("[char]7"));
            assert!(spec.args[3].contains("[Console]::Write"));
            assert!(spec.args[3].contains("$env:COMPUTERNAME"));
            assert!(!spec.args[3].contains("`e"));
            assert!(spec.args[3].contains("$uri.AbsolutePath"));
            assert!(spec.args[3].contains("if ($uri.IsUnc) { $u = '//' + $uri.Host + $u }"));
            assert!(!spec.args[3].contains("Substring(7)"));
            assert!(spec.env.is_empty());
        }
        let spec = resolve_shell(ShellKind::Wsl, Platform::Windows, None, true, |_| true).unwrap();
        assert_eq!(spec.args[..3], ["-e", "bash", "-c"]);
        assert_eq!(spec.args[3], bash_osc7_startup());
        assert!(spec.args[3].contains("export -f __werkterm_osc7"));
        assert!(spec.args[3].contains("exec bash -i"));
        assert!(spec.args[3].contains("local LC_ALL=C"));
        assert!(spec.args[3].contains("[-_.~a-zA-Z0-9/]"));
        assert!(spec.args[3].contains("printf -v c '%%%02X'"));
        for shell in ["/bin/bash", "bash"] {
            let spec = resolve_shell(
                ShellKind::Local,
                Platform::Unix,
                Some(shell.to_owned()),
                true,
                |_| false,
            )
            .unwrap();
            assert!(spec.env.is_empty());
            assert_eq!(spec.args, ["-c", &bash_osc7_startup()]);
        }
        for shell in ["/bin/zsh", "/bin/sh"] {
            let spec = resolve_shell(
                ShellKind::Local,
                Platform::Unix,
                Some(shell.to_owned()),
                true,
                |_| false,
            )
            .unwrap();
            assert!(spec.env.is_empty());
        }
        let spec = resolve_shell(
            ShellKind::Local,
            Platform::Unix,
            Some("/bin/bash".to_owned()),
            false,
            |_| false,
        )
        .unwrap();
        assert!(spec.env.is_empty());
    }

    #[test]
    fn rejects_zero_dimensions_and_caps_size() {
        let manager = PtyManager::default();
        let spec = ShellSpec {
            program: String::new(),
            args: vec![],
            env: vec![],
        };
        for (cols, rows) in [(0, 24), (80, 0)] {
            assert!(matches!(
                manager.spawn(&spec, cols, rows, Box::new(|_| {}), Box::new(|_| {})),
                Err(PtyError::InvalidSize)
            ));
        }
        let capped = size(u16::MAX, u16::MAX).unwrap();
        assert_eq!((capped.cols, capped.rows), (1000, 1000));
    }

    #[test]
    fn unknown_sessions_return_errors() {
        let manager = PtyManager::default();
        assert!(matches!(
            manager.write(42, b"test"),
            Err(PtyError::UnknownSession(42))
        ));
        assert!(matches!(
            manager.resize(42, 80, 24),
            Err(PtyError::UnknownSession(42))
        ));
        assert!(matches!(
            manager.kill(42),
            Err(PtyError::UnknownSession(42))
        ));
    }

    #[test]
    fn manager_is_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<PtyManager>();
    }

    #[test]
    fn blocked_writer_does_not_block_other_sessions() {
        let spec = ShellSpec {
            program: if cfg!(windows) { "cmd.exe" } else { "/bin/sh" }.to_owned(),
            args: vec![],
            env: vec![],
        };
        let manager = Arc::new(PtyManager::default());
        let (exit_tx, exit_rx) = mpsc::channel();
        let on_exit = || {
            let exit_tx = exit_tx.clone();
            Box::new(move |_| {
                let _ = exit_tx.send(());
            }) as Box<dyn FnOnce(Option<u32>) + Send>
        };
        let first = manager
            .spawn(&spec, 80, 24, Box::new(|_| {}), on_exit())
            .unwrap();
        let second = match manager.spawn(&spec, 80, 24, Box::new(|_| {}), on_exit()) {
            Ok(id) => id,
            Err(error) => {
                let _ = manager.kill(first);
                panic!("Could not spawn second PTY: {error}");
            }
        };
        // ConPTY requests the initial cursor position from its terminal peer.
        #[cfg(windows)]
        for id in [first, second] {
            let _ = manager.write(id, b"\x1b[1;1R");
        }
        let writer = {
            let sessions = manager.sessions().unwrap();
            Arc::clone(&sessions.get(&first).unwrap().writer)
        };
        let (locked_tx, locked_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let holder = std::thread::spawn(move || {
            let _guard = writer.lock().unwrap();
            locked_tx.send(()).unwrap();
            let _ = release_rx.recv();
        });
        locked_rx.recv().unwrap();

        let writing_manager = Arc::clone(&manager);
        let (write_tx, write_rx) = mpsc::channel();
        let writing = std::thread::spawn(move || {
            let result = writing_manager.write(first, b"");
            let _ = write_tx.send(result);
        });
        // Give write() time to reach the held writer mutex.
        let write_waiting = matches!(
            write_rx.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        );
        let other_manager = Arc::clone(&manager);
        let (other_tx, other_rx) = mpsc::channel();
        let other = std::thread::spawn(move || {
            let _ = other_tx.send(other_manager.resize(second, 100, 30));
        });
        let independent = other_rx.recv_timeout(Duration::from_secs(2));

        // Release the blocked writer before joining and cleaning up, even on failure.
        let _ = release_tx.send(());
        let holder_result = holder.join();
        let writing_result = writing.join();
        let other_result = other.join();
        // portable-pty 0.9.0 can report an error after a successful Windows kill;
        // verify cleanup through the exit callbacks instead of the return value.
        let _ = manager.kill(first);
        let _ = manager.kill(second);
        let first_exited = exit_rx.recv_timeout(Duration::from_secs(20));
        let second_exited = exit_rx.recv_timeout(Duration::from_secs(20));

        holder_result.unwrap();
        writing_result.unwrap();
        other_result.unwrap();
        first_exited.unwrap();
        second_exited.unwrap();
        assert!(write_waiting, "write() did not wait for the writer mutex");
        independent
            .expect("Other session blocked for two seconds")
            .unwrap();
        write_rx.recv().unwrap().unwrap();
    }

    #[test]
    fn real_pty_delivers_output_and_removes_session() {
        #[cfg(windows)]
        let spec = ShellSpec {
            program: "cmd.exe".to_owned(),
            args: ["/C", "echo werkterm-ok"].map(str::to_owned).to_vec(),
            env: vec![],
        };
        #[cfg(not(windows))]
        let spec = ShellSpec {
            program: "/bin/sh".to_owned(),
            args: ["-c", "echo werkterm-ok"].map(str::to_owned).to_vec(),
            env: vec![],
        };
        let manager = PtyManager::default();
        let output = Arc::new(Mutex::new(Vec::new()));
        let received = Arc::clone(&output);
        let (tx, rx) = mpsc::channel();
        let id = manager
            .spawn(
                &spec,
                80,
                24,
                Box::new(move |bytes| received.lock().unwrap().extend(bytes)),
                Box::new(move |code| tx.send(code).unwrap()),
            )
            .unwrap();
        // ConPTY requests the initial cursor position from its terminal peer.
        #[cfg(windows)]
        let _ = manager.write(id, b"\x1b[1;1R");
        let exit = rx.recv_timeout(Duration::from_secs(20));
        if exit.is_err() {
            let _ = manager.kill(id);
        }
        assert_eq!(exit.unwrap(), Some(0));
        assert!(String::from_utf8_lossy(&output.lock().unwrap()).contains("werkterm-ok"));
        assert!(!manager.sessions().unwrap().contains_key(&id));
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StartCommand {
    Root,
    Processes,
    Hardware,
}

#[cfg(windows)]
fn encoded_powershell(script: &str) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut encoded = String::new();
    for chunk in bytes.chunks(3) {
        let a = chunk[0];
        let b = chunk.get(1).copied().unwrap_or(0);
        let c = chunk.get(2).copied().unwrap_or(0);
        encoded.push(ALPHABET[(a >> 2) as usize] as char);
        encoded.push(ALPHABET[((a & 3) << 4 | b >> 4) as usize] as char);
        encoded.push(if chunk.len() > 1 {
            ALPHABET[((b & 15) << 2 | c >> 6) as usize] as char
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            ALPHABET[(c & 63) as usize] as char
        } else {
            '='
        });
    }
    encoded
}

pub fn apply_start_command(
    spec: &mut ShellSpec,
    command: Option<StartCommand>,
) -> Result<(), String> {
    let Some(command) = command else {
        return Ok(());
    };
    #[cfg(windows)]
    if matches!(command, StartCommand::Hardware) {
        spec.program = "powershell.exe".into();
        spec.args = ["-NoLogo", "-NoProfile", "-NoExit", "-EncodedCommand"]
            .map(str::to_owned)
            .to_vec();
        spec.args
            .push(encoded_powershell(include_str!("hardware.ps1")));
        return Ok(());
    }
    if !cfg!(target_os = "linux") {
        return Err("Systemwerkzeuge sind nur unter Linux verfügbar".into());
    }
    match command {
        StartCommand::Root => {
            spec.program = "sudo".into();
            spec.args = vec!["-i".into()];
        }
        StartCommand::Processes | StartCommand::Hardware => {
            let command = match command {
                StartCommand::Processes => {
                    "if command -v htop >/dev/null 2>&1; then htop; else top; fi"
                }
                // Read-only "Key=Value" overview like MobaXterm's hardware list.
                _ => include_str!("hardware.sh"),
            };
            spec.program = "/bin/sh".into();
            spec.args = vec![
                "-c".into(),
                // A newline (not ";") keeps multi-line scripts valid; the shell stays open afterwards.
                format!("{}\nexec \"${{SHELL:-/bin/sh}}\" -i", command.trim_end()),
            ];
        }
    }
    Ok(())
}
