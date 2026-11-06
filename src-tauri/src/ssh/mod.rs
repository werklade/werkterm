pub mod lsparse;

use russh::{ChannelMsg, ChannelWriteHalf, Disconnect, client, keys};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::{
    collections::HashMap,
    future::Future,
    path::PathBuf,
    pin::Pin,
    str::FromStr,
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex, oneshot};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub kind: String,
    pub size: u64,
    pub permissions: u32,
    pub modified: Option<u64>,
    pub target_is_dir: bool,
}

#[derive(Debug, Serialize)]
pub struct DirListing {
    pub path: String,
    pub mode: String,
    pub entries: Vec<DirEntry>,
}

pub fn sort_entries(entries: &mut [DirEntry]) {
    entries.sort_by(|a, b| {
        (a.kind != "dir", a.name.to_lowercase(), &a.name).cmp(&(
            b.kind != "dir",
            b.name.to_lowercase(),
            &b.name,
        ))
    });
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshTarget {
    pub user: String,
    pub host: String,
    pub port: u16,
}

impl FromStr for SshTarget {
    type Err = String;
    fn from_str(value: &str) -> Result<Self, String> {
        let invalid = || "Ungültiges SSH-Ziel (erwartet user@host[:port])".to_owned();
        if value.chars().any(char::is_whitespace) {
            return Err(invalid());
        }
        let (user, address) = value.split_once('@').ok_or_else(invalid)?;
        if user.is_empty() || address.is_empty() || address.contains('@') {
            return Err(invalid());
        }
        let (host, port) = if let Some(address) = address.strip_prefix('[') {
            let (host, suffix) = address.split_once(']').ok_or_else(invalid)?;
            host.parse::<std::net::Ipv6Addr>().map_err(|_| invalid())?;
            (
                host,
                if suffix.is_empty() {
                    22
                } else {
                    suffix
                        .strip_prefix(':')
                        .ok_or_else(invalid)?
                        .parse::<u16>()
                        .map_err(|_| invalid())?
                },
            )
        } else if let Some((host, port)) = address.split_once(':') {
            (host, port.parse::<u16>().map_err(|_| invalid())?)
        } else {
            (address, 22)
        };
        if host.is_empty()
            || port == 0
            || host.contains(['[', ']', '\0', '/', '\\'])
            || user.contains('\0')
        {
            return Err(invalid());
        }
        Ok(Self {
            user: user.into(),
            host: host.into(),
            port,
        })
    }
}

pub fn ssh_dir() -> Result<PathBuf, String> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .filter(|p| !p.is_empty())
        .map(|p| PathBuf::from(p).join(".ssh"))
        .ok_or_else(|| "Home-Verzeichnis nicht gefunden".into())
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SecretKind {
    Password,
    Passphrase,
}
pub type PromptFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
pub trait Prompter: Send + Sync {
    fn confirm_host_key(
        &self,
        host: String,
        port: u16,
        key_type: String,
        fingerprint: String,
    ) -> PromptFuture<bool>;
    fn ask_secret(&self, kind: SecretKind, label: String) -> PromptFuture<Option<String>>;
}

#[derive(Debug)]
struct SshError(String);
impl std::fmt::Display for SshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for SshError {}
impl From<russh::Error> for SshError {
    fn from(error: russh::Error) -> Self {
        Self(format!("SSH-Verbindung fehlgeschlagen: {error}"))
    }
}

struct Handler {
    target: SshTarget,
    path: PathBuf,
    prompter: Arc<dyn Prompter>,
    prompt_active: tokio::sync::watch::Sender<bool>,
}

fn check_known_key(
    host: &str,
    port: u16,
    key: &keys::PublicKey,
    path: &std::path::Path,
) -> Result<bool, keys::Error> {
    if keys::check_known_hosts_path(host, port, key, path)? {
        return Ok(true);
    }
    if let Some((line, _)) = keys::known_hosts::known_host_keys_path(host, port, path)?.first() {
        return Err(keys::Error::KeyChanged { line: *line });
    }
    Ok(false)
}

impl client::Handler for Handler {
    type Error = SshError;
    async fn check_server_key(
        &mut self,
        offered: &keys::PublicKeyOrCertificate,
    ) -> Result<bool, SshError> {
        if offered.certificate().is_some() {
            return Err(SshError(
                "SSH-Hostzertifikate werden nicht unterstützt".into(),
            ));
        }
        let key = offered.public_key();
        let (host, port, path) = (
            self.target.host.clone(),
            self.target.port,
            self.path.clone(),
        );
        let check_key = key.clone();
        let check =
            tokio::task::spawn_blocking(move || check_known_key(&host, port, &check_key, &path))
                .await
                .map_err(|_| SshError("Hostkey-Prüfung fehlgeschlagen".into()))?;
        match check {
            Ok(true) => return Ok(true),
            Err(keys::Error::KeyChanged { line }) => {
                return Err(SshError(format!(
                    "Hostkey von {}:{} hat sich geändert (known_hosts Zeile {line}) – Verbindung abgebrochen",
                    self.target.host, self.target.port
                )));
            }
            Err(_) => return Err(SshError("known_hosts konnte nicht gelesen werden".into())),
            Ok(false) => (),
        }
        self.prompt_active.send_replace(true);
        let accepted = tokio::time::timeout(
            Duration::from_secs(120),
            self.prompter.confirm_host_key(
                self.target.host.clone(),
                self.target.port,
                key.algorithm().to_string(),
                key.fingerprint(keys::HashAlg::Sha256).to_string(),
            ),
        )
        .await
        .unwrap_or(false);
        self.prompt_active.send_replace(false);
        if !accepted {
            return Ok(false);
        }
        let (host, port, path) = (
            self.target.host.clone(),
            self.target.port,
            self.path.clone(),
        );
        tokio::task::spawn_blocking(move || {
            if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
                std::fs::create_dir_all(parent)
                    .map_err(|_| SshError("SSH-Verzeichnis konnte nicht angelegt werden".into()))?;
            }
            keys::known_hosts::learn_known_hosts_path(&host, port, &key, path)
                .map_err(|_| SshError("Hostkey konnte nicht gespeichert werden".into()))
        })
        .await
        .map_err(|_| SshError("Hostkey konnte nicht gespeichert werden".into()))??;
        Ok(true)
    }
}

type Handle = client::Handle<Handler>;
struct Session {
    handle: Arc<Handle>,
    writer: Arc<ChannelWriteHalf<client::Msg>>,
    sftp: Option<Arc<SftpSession>>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
    done: tokio::sync::Notify,
    finished: std::sync::atomic::AtomicBool,
}
pub struct SshManager {
    sessions: Mutex<HashMap<u32, Arc<Session>>>,
    next_id: AtomicU32,
}
impl Default for SshManager {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

async fn agent_auth(handle: &mut Handle, user: &str) -> bool {
    use keys::agent::client::AgentClient;
    #[cfg(unix)]
    let agent = tokio::time::timeout(Duration::from_secs(2), AgentClient::connect_env())
        .await
        .ok()
        .and_then(Result::ok);
    #[cfg(windows)]
    let agent = tokio::net::windows::named_pipe::ClientOptions::new()
        .open(r"\\.\pipe\openssh-ssh-agent")
        .ok()
        .map(AgentClient::connect);
    #[cfg(not(any(unix, windows)))]
    return false;
    #[cfg(any(unix, windows))]
    {
        let Some(mut agent) = agent else { return false };
        let Ok(Ok(identities)) =
            tokio::time::timeout(Duration::from_secs(2), agent.request_identities()).await
        else {
            return false;
        };
        let hash = handle
            .best_supported_rsa_hash()
            .await
            .ok()
            .flatten()
            .flatten();
        for key in identities {
            if handle
                .authenticate_publickey_with(user, key.public_key().into_owned(), hash, &mut agent)
                .await
                .is_ok_and(|r| r.success())
            {
                return true;
            }
        }
        false
    }
}

async fn authenticate(
    handle: &mut Handle,
    target: &SshTarget,
    prompter: &dyn Prompter,
) -> Result<(), String> {
    if agent_auth(handle, &target.user).await {
        return Ok(());
    }
    let directory = ssh_dir()?;
    for name in ["id_ed25519", "id_ecdsa", "id_rsa"] {
        let path = directory.join(name);
        let key_path = path.clone();
        let initial = tokio::task::spawn_blocking(move || {
            if std::fs::read_to_string(&key_path).is_ok_and(|text| {
                text.contains("-----BEGIN ENCRYPTED PRIVATE KEY-----")
                    || text.contains("Proc-Type: 4,ENCRYPTED")
            }) {
                return Err(keys::Error::KeyIsEncrypted);
            }
            keys::load_secret_key(key_path, None)
        })
        .await
        .map_err(|_| "Schlüsseldatei konnte nicht geladen werden")?;
        let key = match initial {
            Ok(key) => Some(key),
            Err(keys::Error::KeyIsEncrypted) => {
                let mut key = None;
                for _ in 0..3 {
                    let Some(secret) = prompter
                        .ask_secret(SecretKind::Passphrase, path.to_string_lossy().into_owned())
                        .await
                    else {
                        break;
                    };
                    let key_path = path.clone();
                    let loaded = tokio::task::spawn_blocking(move || {
                        let result = keys::load_secret_key(key_path, Some(&secret));
                        drop(secret);
                        result
                    })
                    .await
                    .map_err(|_| "Schlüsseldatei konnte nicht geladen werden")?;
                    if let Ok(loaded) = loaded {
                        key = Some(loaded);
                        break;
                    }
                }
                key
            }
            Err(_) => None,
        };
        if let Some(key) = key {
            let hash = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|_| "SSH-Authentifizierung fehlgeschlagen")?
                .flatten();
            if handle
                .authenticate_publickey(
                    &target.user,
                    keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                )
                .await
                .map_err(|_| "SSH-Authentifizierung fehlgeschlagen")?
                .success()
            {
                return Ok(());
            }
        }
    }
    for _ in 0..3 {
        let Some(secret) = prompter
            .ask_secret(
                SecretKind::Password,
                format!("{}@{}", target.user, target.host),
            )
            .await
        else {
            return Err("Anmeldung abgebrochen".into());
        };
        let result = handle.authenticate_password(&target.user, &secret).await;
        drop(secret);
        if result
            .map_err(|_| "SSH-Authentifizierung fehlgeschlagen")?
            .success()
        {
            return Ok(());
        }
    }
    Err("SSH-Anmeldung fehlgeschlagen".into())
}

async fn reply(channel: &mut russh::Channel<client::Msg>) -> Result<(), String> {
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Success) => return Ok(()),
            Some(ChannelMsg::Failure | ChannelMsg::Close | ChannelMsg::Eof) | None => {
                return Err("SSH-Kanalanforderung abgelehnt".into());
            }
            _ => (),
        }
    }
}
fn ssh_error(error: impl std::fmt::Display) -> String {
    format!("SSH-Operation fehlgeschlagen: {error}")
}
fn quote(path: &str) -> String {
    format!("'{}'", path.replace('\'', "'\\''"))
}

impl SshManager {
    #[allow(clippy::too_many_arguments)]
    pub async fn connect(
        self: &Arc<Self>,
        target: SshTarget,
        cols: u16,
        rows: u16,
        known_hosts_path: PathBuf,
        prompter: Arc<dyn Prompter>,
        mut on_data: Box<dyn FnMut(Vec<u8>) + Send>,
        on_exit: Box<dyn FnOnce(Option<u32>) + Send>,
    ) -> Result<u32, String> {
        if cols == 0 || rows == 0 {
            return Err("Terminalgröße muss größer als null sein".into());
        }
        let started = tokio::time::Instant::now();
        // Try every resolved address like OpenSSH does: "localhost" may resolve to an
        // unreachable ::1 first (e.g. WSL mirrored networking), which only times out.
        let addresses: Vec<_> = tokio::time::timeout(
            Duration::from_secs(5),
            tokio::net::lookup_host((target.host.as_str(), target.port)),
        )
        .await
        .map_err(|_| "Zeitüberschreitung bei der Namensauflösung")?
        .map_err(ssh_error)?
        .collect();
        let mut last_error = String::from("Host konnte nicht aufgelöst werden");
        let mut connected = None;
        for address in addresses {
            if started.elapsed() >= Duration::from_secs(15) {
                break;
            }
            match tokio::time::timeout(
                Duration::from_secs(5),
                tokio::net::TcpStream::connect(address),
            )
            .await
            {
                Ok(Ok(stream)) => {
                    connected = Some(stream);
                    break;
                }
                Ok(Err(error)) => last_error = ssh_error(error),
                Err(_) => last_error = format!("Zeitüberschreitung bei {address}"),
            }
        }
        let stream = connected.ok_or(last_error)?;
        let config = Arc::new(client::Config {
            keepalive_interval: Some(Duration::from_secs(30)),
            inactivity_timeout: None,
            ..Default::default()
        });
        let (prompt_active, mut prompt_state) = tokio::sync::watch::channel(false);
        let connecting = client::connect_stream(
            config,
            stream,
            Handler {
                target: target.clone(),
                path: known_hosts_path,
                prompter: prompter.clone(),
                prompt_active,
            },
        );
        tokio::pin!(connecting);
        let mut remaining = Duration::from_secs(15).saturating_sub(started.elapsed());
        let mut last = tokio::time::Instant::now();
        let mut paused = false;
        let mut handle = loop {
            tokio::select! {
                result = &mut connecting => break result.map_err(|e| e.to_string())?,
                changed = prompt_state.changed() => {
                    if changed.is_err() {break connecting.as_mut().await.map_err(|e| e.to_string())?;}
                    if !paused {remaining = remaining.saturating_sub(last.elapsed());}
                    paused = *prompt_state.borrow_and_update();
                    last = tokio::time::Instant::now();
                },
                _ = tokio::time::sleep(remaining), if !paused => return Err("Zeitüberschreitung beim SSH-Verbindungsaufbau".into()),
            }
        };
        if let Err(error) = authenticate(&mut handle, &target, prompter.as_ref()).await {
            let _ = handle.disconnect(Disconnect::ByApplication, "", "").await;
            return Err(error);
        }
        let setup = async {
            let mut terminal = handle.channel_open_session().await.map_err(ssh_error)?;
            terminal
                .request_pty(
                    true,
                    "xterm-256color",
                    u32::from(cols),
                    u32::from(rows),
                    0,
                    0,
                    &[],
                )
                .await
                .map_err(ssh_error)?;
            reply(&mut terminal).await?;
            terminal.request_shell(true).await.map_err(ssh_error)?;
            reply(&mut terminal).await?;
            let sftp = match handle.channel_open_session().await {
                Ok(mut channel) => {
                    if channel.request_subsystem(true, "sftp").await.is_ok()
                        && reply(&mut channel).await.is_ok()
                    {
                        SftpSession::new(channel.into_stream())
                            .await
                            .ok()
                            .map(Arc::new)
                    } else {
                        let _ = channel.close().await;
                        None
                    }
                }
                Err(_) => None,
            };
            Ok::<_, String>((terminal, sftp))
        }
        .await;
        let (terminal, sftp) = match setup {
            Ok(value) => value,
            Err(error) => {
                let _ = handle.disconnect(Disconnect::ByApplication, "", "").await;
                return Err(error);
            }
        };
        let id = self
            .next_id
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .map_err(|_| "SSH-Sitzungsnummern ausgeschöpft")?;
        let (mut reader, writer) = terminal.split();
        let (stop, mut stopped) = oneshot::channel();
        let session = Arc::new(Session {
            handle: Arc::new(handle),
            writer: Arc::new(writer),
            sftp,
            stop: Mutex::new(Some(stop)),
            done: tokio::sync::Notify::new(),
            finished: std::sync::atomic::AtomicBool::new(false),
        });
        self.sessions.lock().await.insert(id, session.clone());
        let manager = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut code = None;
            loop {
                tokio::select! {
                    _ = &mut stopped => {let _=session.writer.close().await;break;},
                    message = reader.wait() => match message {
                        Some(ChannelMsg::Data {data} | ChannelMsg::ExtendedData {data,..}) => on_data(data.to_vec()),
                        Some(ChannelMsg::ExitStatus {exit_status}) => code=Some(exit_status),
                        Some(ChannelMsg::Eof | ChannelMsg::Close) | None => break,
                        _ => (),
                    }
                }
            }
            let _ = session
                .handle
                .disconnect(Disconnect::ByApplication, "", "")
                .await;
            if let Some(manager) = manager.upgrade() {
                manager.sessions.lock().await.remove(&id);
            }
            on_exit(code);
            session.finished.store(true, Ordering::Release);
            session.done.notify_waiters();
        });
        Ok(id)
    }
    async fn session(&self, id: u32) -> Result<Arc<Session>, String> {
        self.sessions
            .lock()
            .await
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("Unbekannte SSH-Sitzung: {id}"))
    }
    pub async fn write(&self, id: u32, bytes: &[u8]) -> Result<(), String> {
        self.session(id)
            .await?
            .writer
            .data(bytes)
            .await
            .map_err(ssh_error)
    }
    pub async fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        if cols == 0 || rows == 0 {
            return Err("Terminalgröße muss größer als null sein".into());
        }
        self.session(id)
            .await?
            .writer
            .window_change(u32::from(cols), u32::from(rows), 0, 0)
            .await
            .map_err(ssh_error)
    }
    pub async fn close(&self, id: u32) -> Result<(), String> {
        let session = self.session(id).await?;
        let done = session.done.notified();
        tokio::pin!(done);
        done.as_mut().enable();
        if let Some(stop) = session.stop.lock().await.take() {
            let _ = stop.send(());
        }
        if !session.finished.load(Ordering::Acquire) {
            done.await;
        }
        Ok(())
    }
    pub async fn list_dir(&self, id: u32, path: String) -> Result<DirListing, String> {
        let session = self.session(id).await?;
        if path.contains('\0') {
            return Err("Ungültiger Verzeichnispfad".into());
        }
        let home = path.is_empty() || path == "~";
        let (path, mode, mut entries) = if let Some(sftp) = &session.sftp {
            let path = sftp
                .canonicalize(if home { "." } else { &path })
                .await
                .map_err(ssh_error)?;
            let mut entries = Vec::new();
            for entry in sftp.read_dir(path.clone()).await.map_err(ssh_error)? {
                let name = entry.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                let meta = entry.metadata();
                let kind = if meta.is_dir() {
                    "dir"
                } else if meta.is_symlink() {
                    "symlink"
                } else if meta.is_regular() {
                    "file"
                } else {
                    "other"
                };
                let target_is_dir = kind == "symlink"
                    && sftp
                        .metadata(format!("{}/{name}", path.trim_end_matches('/')))
                        .await
                        .is_ok_and(|m| m.is_dir());
                entries.push(DirEntry {
                    name,
                    kind: kind.into(),
                    size: meta.size.unwrap_or(0),
                    permissions: meta.permissions.unwrap_or(0) & 0o7777,
                    modified: meta.mtime.map(u64::from),
                    target_is_dir,
                });
            }
            (path, "sftp", entries)
        } else {
            let canonical = exec(
                &session.handle,
                if home {
                    "pwd".into()
                } else {
                    format!("cd -- {} && pwd -P", quote(&path))
                },
            )
            .await?;
            let path = canonical.trim_end_matches(['\r', '\n']).to_owned();
            if !path.starts_with('/') || path.contains('\n') {
                return Err(lsparse::UNSUPPORTED.into());
            }
            let output = exec(
                &session.handle,
                format!(
                    "LC_ALL=C QUOTING_STYLE=literal ls -la --time-style=+%s -- {}",
                    quote(&path)
                ),
            )
            .await?;
            (path, "exec", lsparse::parse(&output)?)
        };
        sort_entries(&mut entries);
        Ok(DirListing {
            path,
            mode: mode.into(),
            entries,
        })
    }
}

async fn exec(handle: &Handle, command: String) -> Result<String, String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|_| lsparse::UNSUPPORTED)?;
    channel
        .exec(true, command)
        .await
        .map_err(|_| lsparse::UNSUPPORTED)?;
    let mut output = Vec::new();
    let mut code = None;
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } => output.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
            ChannelMsg::Failure => return Err(lsparse::UNSUPPORTED.into()),
            ChannelMsg::Close => break,
            _ => (),
        }
    }
    if code != Some(0) {
        return Err(lsparse::UNSUPPORTED.into());
    }
    String::from_utf8(output).map_err(|_| lsparse::UNSUPPORTED.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temporary_path() -> PathBuf {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        std::env::temp_dir().join(format!(
            "linmoba-known-hosts-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }
    #[test]
    fn parses_targets() {
        for (input, host, port) in [
            ("me@example.org", "example.org", 22),
            ("me@host:2222", "host", 2222),
            ("me@[::1]:2022", "::1", 2022),
            ("me@[2001:db8::1]", "2001:db8::1", 22),
        ] {
            let target: SshTarget = input.parse().unwrap();
            assert_eq!(
                target,
                SshTarget {
                    user: "me".into(),
                    host: host.into(),
                    port
                }
            );
        }
        for input in [
            "host",
            "@host",
            "me@",
            "me@host:0",
            "me@host:65536",
            "me@::1",
            "me@[host]",
            "me@[::1]:",
            "me@host@other",
            "me@ho st",
        ] {
            assert!(input.parse::<SshTarget>().is_err(), "{input}");
        }
        assert_eq!(quote("a'b"), "'a'\\''b'");
    }
    #[test]
    fn known_hosts_unknown_known_changed_and_ports() {
        let path = temporary_path();
        let first = keys::PublicKey::from_openssh(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ",
        )
        .unwrap();
        let second = keys::PublicKey::from_openssh(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA6rWI3G2sz07DnfFlrouTcysQlj2P+jpNSOEWD9OJ3X",
        )
        .unwrap();
        assert!(!keys::check_known_hosts_path("example.invalid", 22, &first, &path).unwrap());
        keys::known_hosts::learn_known_hosts_path("example.invalid", 22, &first, &path).unwrap();
        assert!(keys::check_known_hosts_path("example.invalid", 22, &first, &path).unwrap());
        let different_algorithm = keys::PublicKey::from_openssh("ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBHwf2HMM5TRXvo2SQJjsNkiDD5KqiiNjrGVv3UUh+mMT5RHxiRtOnlqvjhQtBq0VpmpCV/PwUdhOig4vkbqAcEc=").unwrap();
        assert!(matches!(
            check_known_key("example.invalid", 22, &different_algorithm, &path),
            Err(keys::Error::KeyChanged { line: 2 })
        ));
        assert!(matches!(
            keys::check_known_hosts_path("example.invalid", 22, &second, &path),
            Err(keys::Error::KeyChanged { line: 2 })
        ));
        assert!(!keys::check_known_hosts_path("example.invalid", 2222, &first, &path).unwrap());
        keys::known_hosts::learn_known_hosts_path("example.invalid", 2222, &second, &path).unwrap();
        assert!(
            std::fs::read_to_string(&path)
                .unwrap()
                .contains("[example.invalid]:2222")
        );
        assert!(keys::check_known_hosts_path("example.invalid", 2222, &second, &path).unwrap());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn manager_is_send_and_sync() {
        fn check<T: Send + Sync>() {}
        check::<SshManager>();
    }

    struct TestPrompter;
    impl Prompter for TestPrompter {
        fn confirm_host_key(
            &self,
            _host: String,
            _port: u16,
            _key_type: String,
            _fingerprint: String,
        ) -> PromptFuture<bool> {
            Box::pin(async { true })
        }
        fn ask_secret(&self, kind: SecretKind, _label: String) -> PromptFuture<Option<String>> {
            Box::pin(async move {
                match kind {
                    SecretKind::Password => std::env::var("LINMOBA_TEST_SSH_PASSWORD").ok(),
                    SecretKind::Passphrase => None,
                }
            })
        }
    }
    #[tokio::test]
    #[ignore = "Requires LINMOBA_TEST_SSH and LINMOBA_TEST_SSH_PASSWORD"]
    async fn ssh_shell_listing_and_close() {
        let target = std::env::var("LINMOBA_TEST_SSH")
            .expect("LINMOBA_TEST_SSH")
            .parse()
            .unwrap();
        let manager = Arc::new(SshManager::default());
        let path = temporary_path();
        let (data_tx, mut data_rx) = tokio::sync::mpsc::unbounded_channel();
        let (exit_tx, exit_rx) = oneshot::channel();
        let id = manager
            .connect(
                target,
                80,
                24,
                path.clone(),
                Arc::new(TestPrompter),
                Box::new(move |data| {
                    let _ = data_tx.send(data);
                }),
                Box::new(move |code| {
                    let _ = exit_tx.send(code);
                }),
            )
            .await
            .unwrap();
        manager.write(id, b"echo linmoba-ssh-ok\n").await.unwrap();
        let output = tokio::time::timeout(Duration::from_secs(15), async {
            let mut output = Vec::new();
            while let Some(bytes) = data_rx.recv().await {
                output.extend(bytes);
                if String::from_utf8_lossy(&output)
                    .replace('\r', "")
                    .contains("\nlinmoba-ssh-ok\n")
                {
                    return;
                }
            }
            panic!("SSH shell closed before output");
        })
        .await;
        let listing = manager.list_dir(id, String::new()).await;
        manager.close(id).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), exit_rx)
            .await
            .unwrap()
            .unwrap();
        output.unwrap();
        let listing = listing.unwrap();
        assert!(listing.path.starts_with('/'));
        assert!(!manager.sessions.lock().await.contains_key(&id));
        let _ = std::fs::remove_file(path);
    }
}
