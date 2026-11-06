use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
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

const POWERSHELL_OSC7: &str = r#"$Global:LinMobaOriginalPrompt = $function:prompt; function Global:prompt { $p = $executionContext.SessionState.Path.CurrentLocation.ProviderPath; if ($p) { $uri = [System.Uri]::new($p); $u = $uri.AbsolutePath; $h = $env:COMPUTERNAME; if ($uri.IsUnc) { $u = '//' + $uri.Host + $u }; if (-not $u.StartsWith('/')) { $u = '/' + $u }; [Console]::Write(([char]27 + ']7;file://' + $h + $u + [char]7)) }; if ($Global:LinMobaOriginalPrompt) { & $Global:LinMobaOriginalPrompt } else { "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) " } }"#;
// LC_ALL=C makes substring iteration operate on bytes, including UTF-8 paths.
const BASH_OSC7_FUNCTION: &str = r#"__linmoba_osc7() { local LC_ALL=C p="$PWD" out='' c i; for ((i=0;i<${#p};i++)); do c="${p:i:1}"; case "$c" in [-_.~a-zA-Z0-9/]) out+="$c";; *) printf -v c '%%%02X' "'$c"; out+="$c";; esac; done; printf '\033]7;file://%s%s\007' "${WSL_DISTRO_NAME:-$HOSTNAME}" "$out"; }"#;

fn bash_osc7_startup() -> String {
    format!(
        "{BASH_OSC7_FUNCTION}; export -f __linmoba_osc7; export PROMPT_COMMAND='__linmoba_osc7'\"${{PROMPT_COMMAND:+;$PROMPT_COMMAND}}\"; exec bash -i"
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
    killer: Box<dyn ChildKiller + Send + Sync>,
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
        let mut reader = pair.master.try_clone_reader().map_err(operation)?;
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
                let mut buffer = [0; 8192];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(count) => on_data(buffer[..count].to_vec()),
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
                    return;
                };
                let status = child.wait().ok().map(|status| status.exit_code());
                // Close ConPTY outside the lock while the reader drains its pipe.
                let removed = match session_map.lock() {
                    Ok(mut sessions) => sessions.remove(&id),
                    Err(poisoned) => poisoned.into_inner().remove(&id),
                };
                drop(removed);
                // Descendants may retain the Unix slave after the shell has exited.
                if reader_finished
                    .recv_timeout(std::time::Duration::from_secs(1))
                    .is_ok()
                {
                    let _ = reader_thread.join();
                }
                on_exit(status);
            })
            .map_err(operation)?;
        let result = pair.slave.spawn_command(command);
        drop(pair.slave);
        let child = result.map_err(operation)?;
        sessions.insert(
            id,
            Session {
                master: pair.master,
                writer: Arc::new(Mutex::new(writer)),
                killer: child.clone_killer(),
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
        let mut session = self
            .sessions()?
            .remove(&id)
            .ok_or(PtyError::UnknownSession(id))?;
        session.killer.kill().map_err(operation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

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
            assert!(spec.args[3].contains("$Global:LinMobaOriginalPrompt = $function:prompt"));
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
        assert!(spec.args[3].contains("export -f __linmoba_osc7"));
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
            args: ["/C", "echo linmoba-ok"].map(str::to_owned).to_vec(),
            env: vec![],
        };
        #[cfg(not(windows))]
        let spec = ShellSpec {
            program: "/bin/sh".to_owned(),
            args: ["-c", "echo linmoba-ok"].map(str::to_owned).to_vec(),
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
        assert!(String::from_utf8_lossy(&output.lock().unwrap()).contains("linmoba-ok"));
        assert!(!manager.sessions().unwrap().contains_key(&id));
    }
}
