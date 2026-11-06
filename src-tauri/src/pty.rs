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
            Self::UnknownSession(id) => write!(f, "Unknown PTY session: {id}"),
            Self::InvalidSize => f.write_str("PTY dimensions must be greater than zero"),
            Self::UnsupportedShell(message) | Self::Operation(message) => f.write_str(message),
            Self::Poisoned => f.write_str("PTY session mutex is poisoned"),
            Self::IdExhausted => f.write_str("PTY session IDs exhausted"),
        }
    }
}

impl std::error::Error for PtyError {}

fn operation(error: impl fmt::Display) -> PtyError {
    PtyError::Operation(error.to_string())
}

pub fn resolve_shell(
    kind: ShellKind,
    platform: Platform,
    env_shell: Option<String>,
    has_program: impl Fn(&str) -> bool,
) -> Result<ShellSpec, PtyError> {
    let (program, args) = match (platform, kind) {
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
                "wsl.exe was not found in PATH".to_owned(),
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
    Ok(ShellSpec { program, args })
}

pub fn program_in_path(name: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path).any(|directory| directory.join(name).is_file())
    })
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
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
                writer,
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
            return Err(PtyError::Operation("PTY waiter disconnected".to_owned()));
        }
        Ok(id)
    }

    pub fn write(&self, id: u32, data: &[u8]) -> Result<(), PtyError> {
        let mut sessions = self.sessions()?;
        let session = sessions.get_mut(&id).ok_or(PtyError::UnknownSession(id))?;
        session.writer.write_all(data).map_err(operation)?;
        session.writer.flush().map_err(operation)
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
            let shell =
                resolve_shell(ShellKind::Local, Platform::Windows, None, |_| has_pwsh).unwrap();
            assert_eq!(shell.program, expected);
            assert_eq!(shell.args, ["-NoLogo"]);
        }
        let wsl = resolve_shell(ShellKind::Wsl, Platform::Windows, None, |name| {
            name == "wsl.exe"
        })
        .unwrap();
        assert_eq!(wsl.program, "wsl.exe");
        assert!(wsl.args.is_empty());
        assert!(resolve_shell(ShellKind::Wsl, Platform::Windows, None, |_| false).is_err());
        for (env, expected) in [
            (None, "/bin/sh"),
            (Some(""), "/bin/sh"),
            (Some("/bin/bash"), "/bin/bash"),
        ] {
            let shell = resolve_shell(
                ShellKind::Local,
                Platform::Unix,
                env.map(str::to_owned),
                |_| false,
            )
            .unwrap();
            assert_eq!(shell.program, expected);
            assert!(shell.args.is_empty());
        }
        assert_eq!(
            resolve_shell(ShellKind::Wsl, Platform::Unix, None, |_| true)
                .unwrap_err()
                .to_string(),
            "WSL ist nur unter Windows verfügbar"
        );
    }

    #[test]
    fn rejects_zero_dimensions_and_caps_size() {
        let manager = PtyManager::default();
        let spec = ShellSpec {
            program: String::new(),
            args: vec![],
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
    fn real_pty_delivers_output_and_removes_session() {
        #[cfg(windows)]
        let spec = ShellSpec {
            program: "cmd.exe".to_owned(),
            args: ["/C", "echo linmoba-ok"].map(str::to_owned).to_vec(),
        };
        #[cfg(not(windows))]
        let spec = ShellSpec {
            program: "/bin/sh".to_owned(),
            args: ["-c", "echo linmoba-ok"].map(str::to_owned).to_vec(),
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
