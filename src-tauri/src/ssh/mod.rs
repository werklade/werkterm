mod actions;
pub mod lsparse;
pub mod monitor;
pub mod permissions;
mod sudo;
pub use actions::TransferProgress;

use crate::ui_error::{UiError, code_of, ui_code, ui_err};
use russh::{ChannelMsg, ChannelWriteHalf, Disconnect, client, keys};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
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
use tokio::sync::{Mutex, mpsc, oneshot, watch};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub kind: String,
    pub size: u64,
    pub permissions: u32,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub user: Option<String>,
    pub group: Option<String>,
    pub modified: Option<u64>,
    pub target_is_dir: bool,
}

#[derive(Debug, Serialize)]
pub struct DirListing {
    pub sudo: bool,
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
        let invalid = || String::from(ui_err("SSH_INVALID_TARGET"));
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
        .ok_or_else(|| ui_err("HOME_NOT_FOUND").into())
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SecretKind {
    Username,
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
pub(crate) struct SshError(String);
impl std::fmt::Display for SshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for SshError {}
impl From<russh::Error> for SshError {
    fn from(error: russh::Error) -> Self {
        Self(UiError::new("SSH_CONNECT_FAILED").detail(error).into())
    }
}

pub(crate) struct Handler {
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
            return Err(SshError(ui_err("SSH_HOST_CERTIFICATE").into()));
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
                .map_err(|_| SshError(ui_err("SSH_HOST_KEY_CHECK_FAILED").into()))?;
        match check {
            Ok(true) => return Ok(true),
            Err(keys::Error::KeyChanged { line }) => {
                return Err(SshError(
                    UiError::new("SSH_HOST_KEY_CHANGED")
                        .arg("host", self.target.host.clone())
                        .arg("port", self.target.port.to_string())
                        .arg("line", line.to_string())
                        .into(),
                ));
            }
            Err(error) => {
                return Err(SshError(
                    UiError::new("SSH_KNOWN_HOSTS_READ").detail(error).into(),
                ));
            }
            Ok(false) => (),
        }
        self.prompt_active.send_replace(true);
        let accepted = tokio::time::timeout(
            Duration::from_secs(120),
            self.prompter.confirm_host_key(
                format!("{}@{}", self.target.user, self.target.host),
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
                std::fs::create_dir_all(parent).map_err(|error| {
                    SshError(UiError::new("SSH_DIR_CREATE").detail(error).into())
                })?;
            }
            keys::known_hosts::learn_known_hosts_path(&host, port, &key, path)
                .map_err(|error| SshError(UiError::new("SSH_HOST_KEY_SAVE").detail(error).into()))
        })
        .await
        .map_err(|_| SshError(ui_err("SSH_HOST_KEY_SAVE").into()))??;
        Ok(true)
    }
}

pub(crate) struct TunnelHandler {
    inner: Handler,
    forwards: Option<crate::tunnels::ForwardSender>,
}
impl client::Handler for TunnelHandler {
    type Error = SshError;
    async fn check_server_key(
        &mut self,
        offered: &keys::PublicKeyOrCertificate,
    ) -> Result<bool, SshError> {
        self.inner.check_server_key(offered).await
    }
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        address: &str,
        port: u32,
        _origin: &str,
        _origin_port: u32,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), SshError> {
        if let Some(sender) = &self.forwards {
            let _ = sender.try_send(crate::tunnels::Forward {
                channel,
                address: address.into(),
                port,
                reply,
            });
        }
        // Dropping an unknown request rejects it automatically.
        Ok(())
    }
}
pub(crate) type TunnelHandle = client::Handle<TunnelHandler>;
pub(crate) type Handle = client::Handle<Handler>;
struct Session {
    monitor: Mutex<Option<monitor::MonitorTask>>,
    monitor_closed: std::sync::atomic::AtomicBool,
    socket: SetupSocket,
    handle: Arc<Handle>,
    jumps: Vec<Handle>,
    writer: Arc<ChannelWriteHalf<client::Msg>>,
    sftp: std::sync::OnceLock<Arc<SftpSession>>,
    sudo_sftp: Mutex<Option<Arc<SftpSession>>>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
    done: tokio::sync::Notify,
    finished: std::sync::atomic::AtomicBool,
}
#[derive(Default)]
struct Connections {
    running: HashMap<u32, watch::Sender<bool>>,
    completed: HashSet<u32>,
}
#[derive(Serialize)]
pub struct SshConnection {
    pub id: u32,
    pub mode: String,
}
pub struct SshManager {
    sessions: Mutex<HashMap<u32, Arc<Session>>>,
    next_id: AtomicU32,
    connections: Mutex<Connections>,
    transfers: Mutex<actions::Transfers>,
}
impl Default for SshManager {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
            connections: Mutex::new(Connections::default()),
            transfers: Mutex::new(actions::Transfers::default()),
        }
    }
}

async fn agent_auth<H: client::Handler>(handle: &mut client::Handle<H>, user: &str) -> bool {
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

async fn authenticate<H: client::Handler>(
    handle: &mut client::Handle<H>,
    target: &SshTarget,
    prompter: &dyn Prompter,
    session: Option<&crate::sessions::SavedSession>,
    stored_password: Option<String>,
) -> Result<(), String> {
    if agent_auth(handle, &target.user).await {
        return Ok(());
    }
    let auth = session
        .map(|session| &session.auth)
        .cloned()
        .unwrap_or_default();
    let paths = auth_key_paths(&auth)?;
    for path in paths {
        let key_path = path.clone();
        let initial = tokio::task::spawn_blocking(move || {
            if std::fs::read_to_string(&key_path).is_ok_and(|text| {
                text.contains("-----BEGIN ENCRYPTED PRIVATE KEY-----")
                    || text.contains("Proc-Type: 4,ENCRYPTED")
                    || (text.starts_with("PuTTY-User-Key-File-")
                        && !text
                            .lines()
                            .any(|line| line.trim_end() == "Encryption: none"))
            }) {
                return Err(keys::Error::KeyIsEncrypted);
            }
            keys::load_secret_key(key_path, None)
        })
        .await
        .map_err(|_| ui_code("SSH_KEY_LOAD"))?;
        let key = match initial {
            Ok(key) => Some(key),
            Err(keys::Error::KeyIsEncrypted) => {
                let mut key = None;
                for _ in 0..3 {
                    let Some(secret) = prompter
                        .ask_secret(
                            SecretKind::Passphrase,
                            format!(
                                "{}@{}:{} – {}",
                                target.user,
                                target.host,
                                target.port,
                                path.display()
                            ),
                        )
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
                    .map_err(|_| ui_code("SSH_KEY_LOAD"))?;
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
                .map_err(|error| UiError::new("SSH_AUTH_FAILED").detail(error))?
                .flatten();
            if handle
                .authenticate_publickey(
                    &target.user,
                    keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                )
                .await
                .map_err(|error| UiError::new("SSH_AUTH_FAILED").detail(error))?
                .success()
            {
                return Ok(());
            }
        }
    }
    if let Some(secret) = stored_password {
        let result = handle.authenticate_password(&target.user, &secret).await;
        drop(secret);
        if result.is_ok_and(|result| result.success()) {
            return Ok(());
        }
    }
    for _ in 0..3 {
        let Some(secret) = prompter
            .ask_secret(
                SecretKind::Password,
                format!("{}@{}:{}", target.user, target.host, target.port),
            )
            .await
        else {
            return Err(ui_err("SSH_LOGIN_CANCELED").into());
        };
        let result = handle.authenticate_password(&target.user, &secret).await;
        drop(secret);
        if result
            .map_err(|error| UiError::new("SSH_AUTH_FAILED").detail(error))?
            .success()
        {
            return Ok(());
        }
    }
    Err(ui_err("SSH_LOGIN_FAILED").into())
}

fn auth_key_paths(auth: &crate::sessions::SessionAuth) -> Result<Vec<PathBuf>, String> {
    use crate::sessions::SessionAuth;
    match auth {
        SessionAuth::Default => {
            let directory = ssh_dir()?;
            Ok(["id_ed25519", "id_ecdsa", "id_rsa"]
                .into_iter()
                .map(|name| directory.join(name))
                .collect())
        }
        SessionAuth::KeyFile { path } => {
            if path == "~" || path.starts_with("~/") || path.starts_with("~\\") {
                let home = ssh_dir()?
                    .parent()
                    .map(std::path::Path::to_path_buf)
                    .ok_or_else(|| String::from(ui_err("HOME_NOT_FOUND")))?;
                Ok(vec![crate::sessions::expand_home(path, &home)])
            } else {
                Ok(vec![PathBuf::from(path)])
            }
        }
        SessionAuth::Password | SessionAuth::Ask => Ok(Vec::new()),
    }
}

#[cfg(test)]
mod saved_auth_tests {
    use super::*;
    use crate::sessions::SessionAuth;
    #[test]
    fn saved_auth_selects_only_the_requested_key_files() {
        assert!(auth_key_paths(&SessionAuth::Password).unwrap().is_empty());
        assert!(auth_key_paths(&SessionAuth::Ask).unwrap().is_empty());
        assert_eq!(
            auth_key_paths(&SessionAuth::KeyFile {
                path: "test-key.ppk".into()
            })
            .unwrap(),
            vec![PathBuf::from("test-key.ppk")]
        );
        let directory = ssh_dir().unwrap();
        assert_eq!(
            auth_key_paths(&SessionAuth::Default).unwrap(),
            ["id_ed25519", "id_ecdsa", "id_rsa"].map(|name| directory.join(name))
        );
        assert_eq!(
            auth_key_paths(&SessionAuth::KeyFile {
                path: "~/.ssh/test.ppk".into()
            })
            .unwrap(),
            vec![directory.join("test.ppk")]
        );
    }
}

async fn reply(channel: &mut russh::Channel<client::Msg>) -> Result<(), String> {
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Success) => return Ok(()),
            Some(ChannelMsg::Failure | ChannelMsg::Close | ChannelMsg::Eof) | None => {
                return Err(ui_err("SSH_CHANNEL_REJECTED").into());
            }
            _ => (),
        }
    }
}
fn ssh_error(error: impl std::fmt::Display) -> String {
    UiError::new("SSH_FAILED").detail(error).into()
}
/// Prefixes an error of a jump host hop; the frontend translates the nested error.
fn jump_error(name: &str, error: String) -> String {
    UiError::new("SSH_JUMP_HOST")
        .arg("name", name)
        .arg("error", error)
        .into()
}
/// Connection errors that a retry cannot fix (cancellation, rejected or changed host key),
/// also when they occurred on a jump host.
pub(crate) fn is_final_connect_error(error: &str) -> bool {
    let mut error = error.to_owned();
    while code_of(&error) == Some("SSH_JUMP_HOST") {
        let inner = error
            .split_once(':')
            .and_then(|(_, json)| serde_json::from_str::<serde_json::Value>(json.trim()).ok())
            .and_then(|value| value["args"]["error"].as_str().map(str::to_owned));
        match inner {
            Some(inner) => error = inner,
            None => break,
        }
    }
    matches!(
        code_of(&error),
        Some(
            "SSH_CONNECT_CANCELED"
                | "SSH_LOGIN_CANCELED"
                | "SSH_USER_CANCELED"
                | "SSH_HOST_KEY_CHANGED"
                | "SSH_HOST_KEY_CHECK_FAILED"
                | "SSH_HOST_KEY_SAVE"
        )
    )
}
fn quote(path: &str) -> String {
    format!("'{}'", path.replace('\'', "'\\''"))
}

const PHASE_TIMEOUT: Duration = Duration::from_secs(15);
const CANCELED: &str = ui_code("SSH_CONNECT_CANCELED");

trait SshTransport: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> SshTransport for T {}

async fn hop_target(
    session: &crate::sessions::SavedSession,
    prompter: &dyn Prompter,
) -> Result<SshTarget, String> {
    let user = match session.user.as_deref().filter(|u| !u.is_empty()) {
        Some(user) => user.to_owned(),
        None => prompter
            .ask_secret(
                SecretKind::Username,
                format!("{} ({}:{})", session.name, session.host, session.port),
            )
            .await
            .filter(|user| !user.trim().is_empty())
            .ok_or_else(|| String::from(ui_err("SSH_USER_CANCELED")))?,
    };
    let host = if session.host.contains(':') {
        format!("[{}]", session.host)
    } else {
        session.host.clone()
    };
    format!("{user}@{host}:{}", session.port).parse()
}

// A duplicated socket terminates russh handshake tasks even when their future is dropped.
pub(crate) struct SetupSocket(Option<std::net::TcpStream>);
impl Drop for SetupSocket {
    fn drop(&mut self) {
        if let Some(socket) = &self.0 {
            let _ = socket.shutdown(std::net::Shutdown::Both);
        }
    }
}

// Prompt time is excluded, while cancellation remains active throughout.
async fn phase<T>(
    future: impl Future<Output = Result<T, String>>,
    canceled: &mut watch::Receiver<bool>,
    prompts: &mut watch::Receiver<bool>,
) -> Result<T, String> {
    phase_with_budget(future, canceled, prompts, PHASE_TIMEOUT).await
}
async fn phase_with_budget<T>(
    future: impl Future<Output = Result<T, String>>,
    canceled: &mut watch::Receiver<bool>,
    prompts: &mut watch::Receiver<bool>,
    mut remaining: Duration,
) -> Result<T, String> {
    tokio::pin!(future);
    loop {
        if *canceled.borrow() {
            return Err(CANCELED.into());
        }
        let paused = *prompts.borrow_and_update();
        let started = tokio::time::Instant::now();
        tokio::select! {
            biased;
            _ = canceled.changed() => return Err(CANCELED.into()),
            result = &mut future => return result,
            changed = prompts.changed() => {
                if changed.is_err() { return future.await; }
            }
            _ = tokio::time::sleep(remaining), if !paused => return Err(ui_err("SSH_CONNECT_TIMEOUT").into()),
        }
        if !paused {
            remaining = remaining.saturating_sub(started.elapsed());
        }
    }
}

struct TrackedPrompter {
    inner: Arc<dyn Prompter>,
    active: watch::Sender<bool>,
    canceled: watch::Receiver<bool>,
}
impl Prompter for TrackedPrompter {
    fn confirm_host_key(
        &self,
        host: String,
        port: u16,
        key_type: String,
        fingerprint: String,
    ) -> PromptFuture<bool> {
        let future = self
            .inner
            .confirm_host_key(host, port, key_type, fingerprint);
        let active = self.active.clone();
        let mut canceled = self.canceled.clone();
        Box::pin(async move {
            if *canceled.borrow() {
                return false;
            }
            active.send_replace(true);
            let result = tokio::select! { biased; _ = canceled.changed() => false, result = future => result };
            active.send_replace(false);
            result
        })
    }
    fn ask_secret(&self, kind: SecretKind, label: String) -> PromptFuture<Option<String>> {
        let future = self.inner.ask_secret(kind, label);
        let active = self.active.clone();
        let mut canceled = self.canceled.clone();
        Box::pin(async move {
            if *canceled.borrow() {
                return None;
            }
            active.send_replace(true);
            let result = tokio::select! { biased; _ = canceled.changed() => None, result = future => result };
            active.send_replace(false);
            result
        })
    }
}

fn terminal_message(
    message: Option<ChannelMsg>,
    on_data: &mut dyn FnMut(Vec<u8>),
    replies: &mpsc::UnboundedSender<bool>,
    code: &mut Option<u32>,
) -> bool {
    match message {
        Some(ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. }) => {
            on_data(data.to_vec())
        }
        Some(ChannelMsg::Success) => {
            let _ = replies.send(true);
        }
        Some(ChannelMsg::Failure) => {
            let _ = replies.send(false);
        }
        Some(ChannelMsg::ExitStatus { exit_status }) => *code = Some(exit_status),
        Some(ChannelMsg::Eof | ChannelMsg::Close) | None => return false,
        _ => (),
    }
    true
}

trait TerminalReader {
    async fn receive(&mut self) -> Option<ChannelMsg>;
}
impl TerminalReader for russh::ChannelReadHalf {
    async fn receive(&mut self) -> Option<ChannelMsg> {
        self.wait().await
    }
}
async fn pump_terminal(
    reader: &mut impl TerminalReader,
    stopped: &mut oneshot::Receiver<()>,
    on_data: &mut (dyn FnMut(Vec<u8>) + Send),
    replies: &mpsc::UnboundedSender<bool>,
) -> Option<u32> {
    let mut code = None;
    loop {
        tokio::select! {
            _ = &mut *stopped => break,
            message = reader.receive() => {
                if !terminal_message(message, on_data, replies, &mut code) { break; }
            }
        }
    }
    code
}

#[allow(clippy::too_many_arguments)]
async fn connect_transport<H: client::Handler<Error = SshError> + 'static>(
    target: SshTarget,
    session: Option<crate::sessions::SavedSession>,
    jump_sessions: Vec<crate::sessions::SavedSession>,
    known_hosts_path: PathBuf,
    prompter: Arc<dyn Prompter>,
    canceled: &mut watch::Receiver<bool>,
    prompts: &mut watch::Receiver<bool>,
    handler_factory: impl Fn(SshTarget, PathBuf, Arc<dyn Prompter>, watch::Sender<bool>, bool) -> H,
) -> Result<(client::Handle<H>, Vec<client::Handle<H>>, SetupSocket), String> {
    let mut hop_targets = Vec::new();
    for hop in &jump_sessions {
        hop_targets.push(
            phase(hop_target(hop, prompter.as_ref()), canceled, prompts)
                .await
                .map_err(|error| jump_error(&hop.name, error))?,
        );
    }
    let first_target = hop_targets.first().unwrap_or(&target);
    let first_error = |error: String| match jump_sessions.first() {
        Some(hop) => jump_error(&hop.name, error),
        None => error,
    };
    let started = tokio::time::Instant::now();
    // Try every resolved address like OpenSSH does: "localhost" may resolve to an
    // unreachable ::1 first (e.g. WSL mirrored networking), which only times out.
    let addresses: Vec<_> = phase(
        async {
            tokio::time::timeout(
                Duration::from_secs(5),
                tokio::net::lookup_host((first_target.host.as_str(), first_target.port)),
            )
            .await
            .map_err(|_| String::from(ui_err("SSH_RESOLVE_TIMEOUT")))?
            .map(|addresses| addresses.collect())
            .map_err(ssh_error)
        },
        canceled,
        prompts,
    )
    .await
    .map_err(first_error)?;
    let mut last_error =
        String::from(ui_err("SSH_RESOLVE_FAILED").arg("host", first_target.host.clone()));
    let mut connected = None;
    for address in addresses {
        if started.elapsed() >= Duration::from_secs(15) {
            break;
        }
        match phase(
            async {
                tokio::time::timeout(
                    Duration::from_secs(5),
                    tokio::net::TcpStream::connect(address),
                )
                .await
                .map_err(|_| {
                    String::from(ui_err("SSH_ADDRESS_TIMEOUT").arg("address", address.to_string()))
                })?
                .map_err(ssh_error)
            },
            canceled,
            prompts,
        )
        .await
        {
            Ok(stream) => {
                connected = Some(stream);
                break;
            }
            Err(error) if error == CANCELED => return Err(error),
            Err(error) => last_error = error,
        }
    }
    let stream = connected
        .ok_or(last_error)
        .map_err(first_error)?
        .into_std()
        .map_err(ssh_error)?;
    let setup_socket = SetupSocket(Some(stream.try_clone().map_err(ssh_error)?));
    let stream = tokio::net::TcpStream::from_std(stream).map_err(ssh_error)?;
    // All russh tasks are rooted in setup_socket. Dropping it tears down every
    // transport, including a handshake future canceled before it returned a handle.
    let mut transport: Box<dyn SshTransport> = Box::new(stream);
    let mut jumps: Vec<client::Handle<H>> = Vec::new();
    let mut handle;
    let mut index = 0;
    loop {
        let hop = jump_sessions.get(index);
        let hop_session = hop.or(session.as_ref());
        let hop_target = hop_targets.get(index).unwrap_or(&target);
        let label_error = |error: String| match hop {
            Some(hop) => jump_error(&hop.name, error),
            None => error,
        };
        let config = Arc::new(client::Config {
            keepalive_interval: {
                let seconds = hop_session.map_or(30, |s| s.keepalive_interval);
                (seconds != 0).then(|| Duration::from_secs(u64::from(seconds)))
            },
            keepalive_max: hop_session.map_or(3, |s| s.keepalive_max as usize),
            inactivity_timeout: None,
            ..Default::default()
        });
        let (prompt_active, _prompt_state) = watch::channel(false);
        handle = phase(
            async {
                client::connect_stream(
                    config,
                    transport,
                    handler_factory(
                        hop_target.clone(),
                        known_hosts_path.clone(),
                        prompter.clone(),
                        prompt_active,
                        hop.is_none(),
                    ),
                )
                .await
                .map_err(|e| e.to_string())
            },
            canceled,
            prompts,
        )
        .await
        .map_err(label_error)?;
        let password = if let Some(saved) = hop_session {
            if saved.auth == crate::sessions::SessionAuth::Password {
                phase(
                    async {
                        Ok(
                            crate::secrets::get_password(format!("session:{}", saved.id))
                                .await
                                .ok()
                                .flatten(),
                        )
                    },
                    canceled,
                    prompts,
                )
                .await
                .map_err(label_error)?
            } else {
                None
            }
        } else {
            None
        };
        phase(
            authenticate(
                &mut handle,
                hop_target,
                prompter.as_ref(),
                hop_session,
                password,
            ),
            canceled,
            prompts,
        )
        .await
        .map_err(label_error)?;
        if hop.is_none() {
            break;
        }
        let next = match jump_sessions.get(index + 1) {
            Some(hop) => (hop.host.clone(), hop.port),
            None => (target.host.clone(), target.port),
        };
        let channel = phase(
            async {
                handle
                    .channel_open_direct_tcpip(next.0, u32::from(next.1), "127.0.0.1", 0)
                    .await
                    .map_err(ssh_error)
            },
            canceled,
            prompts,
        )
        .await
        .map_err(label_error)?;
        transport = Box::new(channel.into_stream());
        jumps.push(handle);
        index += 1;
    }
    Ok((handle, jumps, setup_socket))
}

pub(crate) async fn tunnel_transport(
    session: crate::sessions::SavedSession,
    jumps: Vec<crate::sessions::SavedSession>,
    prompter: Arc<dyn Prompter>,
    mut canceled: watch::Receiver<bool>,
    forwards: crate::tunnels::ForwardSender,
) -> Result<(TunnelHandle, Vec<TunnelHandle>, SetupSocket), String> {
    let (active, mut prompts) = watch::channel(false);
    let prompter: Arc<dyn Prompter> = Arc::new(TrackedPrompter {
        inner: prompter,
        active,
        canceled: canceled.clone(),
    });
    let target = phase(
        hop_target(&session, prompter.as_ref()),
        &mut canceled,
        &mut prompts,
    )
    .await?;
    connect_transport(
        target,
        Some(session),
        jumps,
        ssh_dir()?.join("known_hosts"),
        prompter,
        &mut canceled,
        &mut prompts,
        move |target, path, prompter, prompt_active, final_hop| TunnelHandler {
            inner: Handler {
                target,
                path,
                prompter,
                prompt_active,
            },
            forwards: final_hop.then(|| forwards.clone()),
        },
    )
    .await
}
impl SshManager {
    #[allow(clippy::too_many_arguments)]
    pub async fn connect(
        self: &Arc<Self>,
        connect_token: u32,
        target: SshTarget,
        cols: u16,
        rows: u16,
        known_hosts_path: PathBuf,
        prompter: Arc<dyn Prompter>,
        on_data: Box<dyn FnMut(Vec<u8>) + Send>,
        on_exit: Box<dyn FnOnce(Option<u32>) + Send>,
    ) -> Result<SshConnection, String> {
        self.connect_with_session(
            connect_token,
            target,
            None,
            Vec::new(),
            cols,
            rows,
            known_hosts_path,
            prompter,
            on_data,
            on_exit,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn connect_with_session(
        self: &Arc<Self>,
        connect_token: u32,
        target: SshTarget,
        session: Option<crate::sessions::SavedSession>,
        jump_sessions: Vec<crate::sessions::SavedSession>,
        cols: u16,
        rows: u16,
        known_hosts_path: PathBuf,
        prompter: Arc<dyn Prompter>,
        on_data: Box<dyn FnMut(Vec<u8>) + Send>,
        on_exit: Box<dyn FnOnce(Option<u32>) + Send>,
    ) -> Result<SshConnection, String> {
        let (cancel, mut canceled) = watch::channel(false);
        {
            let mut connections = self.connections.lock().await;
            connections.completed.remove(&connect_token);
            if let Some(early_cancel) = connections.running.get(&connect_token) {
                if *early_cancel.borrow() && early_cancel.receiver_count() == 0 {
                    canceled = early_cancel.subscribe();
                } else {
                    return Err(ui_err("SSH_CONNECT_TOKEN_IN_USE").into());
                }
            } else {
                connections.running.insert(connect_token, cancel);
            }
        }
        let (active, mut prompts) = watch::channel(false);
        let prompter: Arc<dyn Prompter> = Arc::new(TrackedPrompter {
            inner: prompter,
            active,
            canceled: canceled.clone(),
        });
        let result = self
            .connect_inner(
                target,
                session,
                jump_sessions,
                cols,
                rows,
                known_hosts_path,
                prompter,
                on_data,
                on_exit,
                &mut canceled,
                &mut prompts,
            )
            .await;
        let was_canceled = {
            let mut connections = self.connections.lock().await;
            let canceled = connections
                .running
                .remove(&connect_token)
                .is_some_and(|cancel| *cancel.borrow());
            connections.completed.insert(connect_token);
            canceled
        };
        if was_canceled {
            if let Ok(connection) = result {
                let _ = self.close(connection.id).await;
            }
            Err(CANCELED.into())
        } else {
            result
        }
    }
    pub async fn cancel_connect(&self, connect_token: u32) {
        let mut connections = self.connections.lock().await;
        if let Some(cancel) = connections.running.get(&connect_token) {
            cancel.send_replace(true);
        } else if !connections.completed.contains(&connect_token) {
            // A cancel IPC may be scheduled before its connect IPC.
            let (cancel, _) = watch::channel(true);
            connections.running.insert(connect_token, cancel);
        }
    }
    #[allow(clippy::too_many_arguments)]
    async fn connect_inner(
        self: &Arc<Self>,
        target: SshTarget,
        session: Option<crate::sessions::SavedSession>,
        jump_sessions: Vec<crate::sessions::SavedSession>,
        cols: u16,
        rows: u16,
        known_hosts_path: PathBuf,
        prompter: Arc<dyn Prompter>,
        mut on_data: Box<dyn FnMut(Vec<u8>) + Send>,
        on_exit: Box<dyn FnOnce(Option<u32>) + Send>,
        canceled: &mut watch::Receiver<bool>,
        prompts: &mut watch::Receiver<bool>,
    ) -> Result<SshConnection, String> {
        if cols == 0 || rows == 0 {
            return Err(ui_err("TERMINAL_SIZE_ZERO").into());
        }
        let (handle, jumps, mut setup_socket) = connect_transport(
            target,
            session,
            jump_sessions,
            known_hosts_path,
            prompter,
            canceled,
            prompts,
            |target, path, prompter, prompt_active, _| Handler {
                target,
                path,
                prompter,
                prompt_active,
            },
        )
        .await?;
        let setup = phase(
            async { handle.channel_open_session().await.map_err(ssh_error) },
            canceled,
            prompts,
        )
        .await;
        let terminal = match setup {
            Ok(value) => value,
            Err(error) => {
                if let Some(socket) = &setup_socket.0 {
                    let _ = socket.shutdown(std::net::Shutdown::Both);
                }
                let _ = tokio::time::timeout(
                    PHASE_TIMEOUT,
                    handle.disconnect(Disconnect::ByApplication, "", ""),
                )
                .await;
                return Err(error);
            }
        };
        let id = self
            .next_id
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .map_err(|_| ui_code("SSH_IDS_EXHAUSTED"))?;
        let (mut reader, writer) = terminal.split();
        let (stop, mut stopped) = oneshot::channel();
        let (replies, mut responses) = mpsc::unbounded_channel();
        let session = Arc::new(Session {
            monitor: Mutex::new(None),
            monitor_closed: std::sync::atomic::AtomicBool::new(false),
            socket: SetupSocket(setup_socket.0.take()),
            handle: Arc::new(handle),
            jumps,
            writer: Arc::new(writer),
            sftp: std::sync::OnceLock::new(),
            sudo_sftp: Mutex::new(None),
            stop: Mutex::new(Some(stop)),
            done: tokio::sync::Notify::new(),
            finished: std::sync::atomic::AtomicBool::new(false),
        });
        let (registered, registration) = oneshot::channel();
        let reader_session = session.clone();
        let manager = Arc::downgrade(self);
        tokio::spawn(async move {
            let session = reader_session;
            let code = tokio::select! {
                code = pump_terminal(&mut reader, &mut stopped, on_data.as_mut(), &replies) => code,
                _ = async {
                    loop {
                        if session.jumps.iter().any(Handle::is_closed) { break; }
                        tokio::time::sleep(Duration::from_millis(250)).await;
                    }
                }, if !session.jumps.is_empty() => None,
            };
            session.monitor_closed.store(true, Ordering::Release);
            monitor::stop_session(&session).await;
            // Wake setup immediately if the shell ends while SFTP is negotiated.
            drop(replies);
            let _ = tokio::time::timeout(PHASE_TIMEOUT, session.writer.close()).await;
            let _ = tokio::time::timeout(
                PHASE_TIMEOUT,
                session.handle.disconnect(Disconnect::ByApplication, "", ""),
            )
            .await;
            for hop in session.jumps.iter().rev() {
                let _ = tokio::time::timeout(
                    PHASE_TIMEOUT,
                    hop.disconnect(Disconnect::ByApplication, "", ""),
                )
                .await;
            }
            if let Some(socket) = &session.socket.0 {
                let _ = socket.shutdown(std::net::Shutdown::Both);
            }
            if let Some(sftp) = session.sudo_sftp.lock().await.take() {
                let _ = sftp.close().await;
            }
            if let Some(sftp) = session.sftp.get() {
                let _ = sftp.close().await;
            }
            // Read immediately, but do not remove a session before publication.
            if registration.await == Ok(true)
                && let Some(manager) = manager.upgrade()
            {
                manager.sessions.lock().await.remove(&id);
            }
            on_exit(code);
            session.finished.store(true, Ordering::Release);
            session.done.notify_waiters();
        });
        // The reader is already consuming data before any PTY/shell request.
        let requests = async {
            phase(
                async {
                    session
                        .writer
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
                    if responses.recv().await == Some(true) {
                        Ok(())
                    } else {
                        Err(ui_err("SSH_CHANNEL_REJECTED").into())
                    }
                },
                canceled,
                prompts,
            )
            .await?;
            phase(
                async {
                    session
                        .writer
                        .request_shell(true)
                        .await
                        .map_err(ssh_error)?;
                    if responses.recv().await == Some(true) {
                        Ok(())
                    } else {
                        Err(ui_err("SSH_CHANNEL_REJECTED").into())
                    }
                },
                canceled,
                prompts,
            )
            .await?;
            // The shell is active and its independent pump is already draining login
            // output. SFTP must be the second session channel for PAM login messages.
            let sftp = match phase(
                async {
                    session
                        .handle
                        .channel_open_session()
                        .await
                        .map_err(ssh_error)
                },
                canceled,
                prompts,
            )
            .await
            {
                Ok(mut channel) => {
                    let requested = phase(
                        async {
                            channel
                                .request_subsystem(true, "sftp")
                                .await
                                .map_err(ssh_error)?;
                            reply(&mut channel).await
                        },
                        canceled,
                        prompts,
                    )
                    .await;
                    if requested.is_ok() {
                        match phase(
                            async {
                                SftpSession::new(channel.into_stream())
                                    .await
                                    .map_err(ssh_error)
                            },
                            canceled,
                            prompts,
                        )
                        .await
                        {
                            Ok(sftp) => Some(Arc::new(sftp)),
                            Err(error) => {
                                if error == CANCELED {
                                    return Err(error);
                                }
                                None
                            }
                        }
                    } else {
                        let _ = tokio::time::timeout(PHASE_TIMEOUT, channel.close()).await;
                        if *canceled.borrow() {
                            return Err(CANCELED.into());
                        }
                        None
                    }
                }
                Err(error) => {
                    if error == CANCELED {
                        return Err(error);
                    }
                    None
                }
            };
            if let Some(sftp) = sftp {
                let _ = session.sftp.set(sftp);
            }
            if responses.is_closed() {
                return Err(ui_err("SSH_TERMINAL_CLOSED").into());
            }
            Ok::<_, String>(())
        }
        .await;
        if let Err(error) = requests {
            if let Some(socket) = &session.socket.0 {
                let _ = socket.shutdown(std::net::Shutdown::Both);
            }
            let _ = registered.send(false);
            let done = session.done.notified();
            tokio::pin!(done);
            done.as_mut().enable();
            if let Some(stop) = session.stop.lock().await.take() {
                let _ = stop.send(());
            }
            if !session.finished.load(Ordering::Acquire) {
                done.await;
            }
            return Err(error);
        }
        let mode = if session.sftp.get().is_some() {
            "SFTP"
        } else {
            "exec"
        }
        .to_owned();
        self.sessions.lock().await.insert(id, session);
        let _ = registered.send(true);
        Ok(SshConnection { id, mode })
    }
    /// A bounded readdir cursor on the existing authenticated SSH connection.
    /// The high-level read_dir helper collects entire directories before returning.
    pub(crate) async fn folder_diff_sftp(
        &self,
        id: u32,
    ) -> Result<russh_sftp::client::RawSftpSession, String> {
        self.editor_sftp(id, false).await.map_err(|e| {
            if code_of(&e) == Some("SFTP_ONLY") {
                ui_err("FOLDER_DIFF_SFTP").into()
            } else {
                e
            }
        })?;
        let session = self.session(id).await?;
        tokio::time::timeout(PHASE_TIMEOUT, async {
            let mut channel = session
                .handle
                .channel_open_session()
                .await
                .map_err(ssh_error)?;
            channel
                .request_subsystem(true, "sftp")
                .await
                .map_err(ssh_error)?;
            reply(&mut channel).await?;
            let raw = russh_sftp::client::RawSftpSession::new(channel.into_stream());
            raw.init().await.map_err(ssh_error)?;
            Ok(raw)
        })
        .await
        .map_err(|_| String::from(ui_err("SFTP_OPEN_TIMEOUT")))?
    }
    pub(crate) async fn editor_sftp(
        &self,
        id: u32,
        sudo: bool,
    ) -> Result<Arc<SftpSession>, String> {
        let unavailable = ui_err(if sudo {
            "SUDO_INACTIVE"
        } else {
            "SESSION_CLOSED"
        });
        let session = self
            .session(id)
            .await
            .map_err(|_| String::from(unavailable.clone()))?;
        if session.finished.load(Ordering::Acquire) {
            return Err(unavailable.into());
        }
        if sudo {
            return session
                .sudo_sftp
                .lock()
                .await
                .clone()
                .ok_or_else(|| ui_err("SUDO_INACTIVE").into());
        }
        session
            .sftp
            .get()
            .cloned()
            .ok_or_else(|| ui_err("SFTP_ONLY").into())
    }
    async fn session(&self, id: u32) -> Result<Arc<Session>, String> {
        self.sessions.lock().await.get(&id).cloned().ok_or_else(|| {
            ui_err("SSH_UNKNOWN_SESSION")
                .arg("id", id.to_string())
                .into()
        })
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
            return Err(ui_err("TERMINAL_SIZE_ZERO").into());
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
            return Err(ui_err("INVALID_PATH").into());
        }
        let home = path.is_empty() || path == "~";
        let elevated = session.sudo_sftp.lock().await.clone();
        let sudo = elevated.is_some();
        let active_sftp = elevated.or_else(|| session.sftp.get().cloned());
        let (path, mode, mut entries) = if let Some(sftp) = active_sftp {
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
                    uid: meta.uid,
                    gid: meta.gid,
                    user: meta.user,
                    group: meta.group,
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
                    "LC_ALL=C ls -la --time-style=+%s --quoting-style=c -- {}",
                    quote(&path)
                ),
            )
            .await?;
            (path, "exec", lsparse::parse(&output)?)
        };
        sort_entries(&mut entries);
        Ok(DirListing {
            sudo,
            path,
            mode: mode.into(),
            entries,
        })
    }
}

async fn exec(handle: &Handle, command: String) -> Result<String, String> {
    let mut channel = tokio::time::timeout(PHASE_TIMEOUT, handle.channel_open_session())
        .await
        .map_err(|_| ui_code("SSH_EXEC_OPEN_TIMEOUT"))?
        .map_err(|_| lsparse::UNSUPPORTED)?;
    run_exec(&mut channel, command, PHASE_TIMEOUT).await
}

trait ExecChannel {
    async fn execute(&mut self, command: String) -> Result<(), String>;
    async fn receive(&mut self) -> Option<ChannelMsg>;
    async fn close_channel(&mut self);
}
impl ExecChannel for russh::Channel<client::Msg> {
    async fn execute(&mut self, command: String) -> Result<(), String> {
        self.exec(true, command)
            .await
            .map_err(|_| lsparse::UNSUPPORTED.into())
    }
    async fn receive(&mut self) -> Option<ChannelMsg> {
        self.wait().await
    }
    async fn close_channel(&mut self) {
        let _ = self.close().await;
    }
}
async fn run_exec(
    channel: &mut impl ExecChannel,
    command: String,
    budget: Duration,
) -> Result<String, String> {
    let result = tokio::time::timeout(budget, async {
        channel.execute(command).await?;
        let mut output = Vec::new();
        let mut code = None;
        while let Some(message) = channel.receive().await {
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
    })
    .await
    .map_err(|_| String::from(ui_err("SSH_EXEC_TIMEOUT")))
    .and_then(|result| result);
    // Every operation result, including rejection and timeout, reaches close.
    let _ = tokio::time::timeout(budget, channel.close_channel()).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    impl TerminalReader for mpsc::Receiver<ChannelMsg> {
        async fn receive(&mut self) -> Option<ChannelMsg> {
            self.recv().await
        }
    }
    #[tokio::test]
    async fn terminal_pump_drains_large_login_output_while_sftp_setup_waits() {
        let (messages, mut reader) = mpsc::channel(2);
        let (sftp_ready, setup) = oneshot::channel();
        let (stop, mut stopped) = oneshot::channel();
        let (replies, _) = mpsc::unbounded_channel();
        let output = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = output.clone();
        let pump = tokio::spawn(async move {
            pump_terminal(
                &mut reader,
                &mut stopped,
                &mut |data| {
                    captured.lock().unwrap().extend(data);
                },
                &replies,
            )
            .await
        });
        // Model one SSH event loop: it cannot finish opening SFTP until all login
        // messages fit through the bounded terminal channel.
        let server = tokio::spawn(async move {
            for _ in 0..512 {
                messages
                    .send(ChannelMsg::Data {
                        data: vec![b'x'; 8192].into(),
                    })
                    .await
                    .unwrap();
            }
            messages.send(ChannelMsg::Eof).await.unwrap();
            sftp_ready.send(()).unwrap();
        });
        tokio::time::timeout(Duration::from_secs(5), setup)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(pump.await.unwrap(), None);
        server.await.unwrap();
        drop(stop);
        assert_eq!(output.lock().unwrap().as_slice(), vec![b'x'; 512 * 8192]);
    }
    #[tokio::test]
    async fn phase_times_out_and_can_be_canceled_during_prompt() {
        let (cancel, mut canceled) = watch::channel(false);
        let (active, mut prompts) = watch::channel(false);
        let never = std::future::pending::<Result<(), String>>();
        assert!(
            phase_with_budget(
                never,
                &mut canceled,
                &mut prompts,
                Duration::from_millis(10)
            )
            .await
            .unwrap_err()
                == "SSH_CONNECT_TIMEOUT"
        );
        active.send_replace(true);
        cancel.send_replace(true);
        assert_eq!(
            phase(
                std::future::pending::<Result<(), String>>(),
                &mut canceled,
                &mut prompts
            )
            .await
            .unwrap_err(),
            CANCELED
        );
    }
    #[tokio::test]
    async fn phase_excludes_prompt_wait_from_budget() {
        let (_cancel, mut canceled) = watch::channel(false);
        let (active, mut prompts) = watch::channel(true);
        let future = async {
            tokio::time::sleep(Duration::from_millis(80)).await;
            active.send_replace(false);
            tokio::time::sleep(Duration::from_millis(5)).await;
            Ok::<_, String>(42)
        };
        assert_eq!(
            phase_with_budget(
                future,
                &mut canceled,
                &mut prompts,
                Duration::from_millis(40)
            )
            .await
            .unwrap(),
            42
        );
    }
    #[tokio::test]
    async fn cancel_watch_interrupts_pending_phase_and_releases_token() {
        let manager = SshManager::default();
        let (cancel, mut canceled) = watch::channel(false);
        manager.connections.lock().await.running.insert(7, cancel);
        let (_active, mut prompts) = watch::channel(false);
        let operation = phase(
            std::future::pending::<Result<(), String>>(),
            &mut canceled,
            &mut prompts,
        );
        let cancel = async {
            tokio::task::yield_now().await;
            manager.cancel_connect(7).await;
        };
        let (result, ()) = tokio::join!(operation, cancel);
        assert_eq!(result.unwrap_err(), CANCELED);
    }
    #[test]
    fn terminal_reader_preserves_data_before_shell_success() {
        let (replies, mut answers) = mpsc::unbounded_channel();
        let mut output = Vec::new();
        let mut code = None;
        let mut on_data = |bytes| output.extend(bytes);
        assert!(terminal_message(
            Some(ChannelMsg::Data {
                data: b"banner".to_vec().into()
            }),
            &mut on_data,
            &replies,
            &mut code
        ));
        assert!(terminal_message(
            Some(ChannelMsg::Success),
            &mut on_data,
            &replies,
            &mut code
        ));
        assert!(terminal_message(
            Some(ChannelMsg::Failure),
            &mut on_data,
            &replies,
            &mut code
        ));
        assert!(!terminal_message(
            Some(ChannelMsg::Close),
            &mut on_data,
            &replies,
            &mut code
        ));
        assert_eq!(output, b"banner");
        assert!(answers.try_recv().unwrap());
        assert!(!answers.try_recv().unwrap());
    }
    #[tokio::test]
    async fn jump_username_uses_saved_user_or_a_host_specific_prompt() {
        struct UserPrompt {
            answer: Option<&'static str>,
            labels: std::sync::Mutex<Vec<String>>,
        }
        impl Prompter for UserPrompt {
            fn confirm_host_key(
                &self,
                _: String,
                _: u16,
                _: String,
                _: String,
            ) -> PromptFuture<bool> {
                panic!("target resolution must not contact a server")
            }
            fn ask_secret(&self, kind: SecretKind, label: String) -> PromptFuture<Option<String>> {
                assert!(matches!(kind, SecretKind::Username));
                self.labels.lock().unwrap().push(label);
                let answer = self.answer.map(str::to_owned);
                Box::pin(async move { answer })
            }
        }
        let mut saved: crate::sessions::SavedSession = serde_json::from_value(serde_json::json!({
            "id": "gw", "name": "Gateway", "folder": "", "host": "::1", "port": 2222,
            "user": "saved-user", "auth": { "type": "ask" }, "source": null
        }))
        .unwrap();
        let prompt = UserPrompt {
            answer: Some("prompt-user"),
            labels: Default::default(),
        };
        assert_eq!(
            hop_target(&saved, &prompt).await.unwrap().user,
            "saved-user"
        );
        assert!(prompt.labels.lock().unwrap().is_empty());
        saved.user = None;
        let target = hop_target(&saved, &prompt).await.unwrap();
        assert_eq!(
            (target.user.as_str(), target.host.as_str(), target.port),
            ("prompt-user", "::1", 2222)
        );
        assert_eq!(*prompt.labels.lock().unwrap(), ["Gateway (::1:2222)"]);
        for answer in [None, Some(""), Some("bad user")] {
            let prompt = UserPrompt {
                answer,
                labels: Default::default(),
            };
            assert!(hop_target(&saved, &prompt).await.is_err());
        }
    }

    struct NoPrompts;
    impl Prompter for NoPrompts {
        fn confirm_host_key(&self, _: String, _: u16, _: String, _: String) -> PromptFuture<bool> {
            Box::pin(async { false })
        }
        fn ask_secret(&self, _: SecretKind, _: String) -> PromptFuture<Option<String>> {
            Box::pin(async { None })
        }
    }
    #[tokio::test]
    async fn early_cancel_is_consumed_and_completed_token_can_be_reused() {
        let manager = Arc::new(SshManager::default());
        manager.cancel_connect(19).await;
        // Invalid dimensions avoid network access while exercising real token registration/cleanup.
        let connect = || {
            manager.connect(
                19,
                "u@example.invalid".parse().unwrap(),
                0,
                24,
                PathBuf::new(),
                Arc::new(NoPrompts),
                Box::new(|_| {}),
                Box::new(|_| {}),
            )
        };
        assert_eq!(connect().await.err().unwrap(), CANCELED);
        assert!(manager.connections.lock().await.running.is_empty());
        manager.cancel_connect(19).await;
        assert!(manager.connections.lock().await.running.is_empty());
        assert_eq!(connect().await.err().unwrap(), "TERMINAL_SIZE_ZERO");
        assert!(manager.connections.lock().await.running.is_empty());
    }
    struct FakeExec {
        messages: std::collections::VecDeque<ChannelMsg>,
        execute_error: bool,
        hang: bool,
        closed: bool,
    }
    impl ExecChannel for FakeExec {
        async fn execute(&mut self, _: String) -> Result<(), String> {
            if self.execute_error {
                Err("exec rejected".into())
            } else {
                Ok(())
            }
        }
        async fn receive(&mut self) -> Option<ChannelMsg> {
            if self.hang {
                std::future::pending::<()>().await;
            }
            self.messages.pop_front()
        }
        async fn close_channel(&mut self) {
            self.closed = true;
        }
    }
    #[tokio::test]
    async fn exec_closes_on_success_failure_error_and_timeout() {
        for (messages, execute_error, hang, success) in [
            (
                vec![ChannelMsg::ExitStatus { exit_status: 0 }, ChannelMsg::Close],
                false,
                false,
                true,
            ),
            (vec![ChannelMsg::Failure], false, false, false),
            (
                vec![ChannelMsg::ExitStatus { exit_status: 1 }],
                false,
                false,
                false,
            ),
            (vec![], true, false, false),
            (vec![], false, true, false),
        ] {
            let mut channel = FakeExec {
                messages: messages.into(),
                execute_error,
                hang,
                closed: false,
            };
            let result = run_exec(&mut channel, "ls".into(), Duration::from_millis(10)).await;
            assert_eq!(result.is_ok(), success);
            assert!(channel.closed);
        }
    }
    fn temporary_path() -> PathBuf {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        std::env::temp_dir().join(format!(
            "werkterm-known-hosts-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }
    #[test]
    fn final_connect_errors_are_found_through_jump_hosts() {
        let canceled = jump_error("outer", jump_error("inner", CANCELED.into()));
        assert_eq!(code_of(&canceled), Some("SSH_JUMP_HOST"));
        assert!(canceled.contains(r#""name":"outer""#));
        assert!(is_final_connect_error(&canceled));
        assert!(is_final_connect_error(
            &ui_err("SSH_HOST_KEY_CHANGED")
                .arg("host", "h")
                .arg("port", "22")
                .arg("line", "3")
                .to_string()
        ));
        assert!(!is_final_connect_error(&jump_error(
            "hop",
            ssh_error("connection reset")
        )));
        assert!(!is_final_connect_error("SSH_JUMP_HOST: {broken"));
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
            assert_eq!(
                input.parse::<SshTarget>().unwrap_err(),
                "SSH_INVALID_TARGET",
                "{input}"
            );
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
                    SecretKind::Password => std::env::var("WERKTERM_TEST_SSH_PASSWORD").ok(),
                    SecretKind::Username | SecretKind::Passphrase => None,
                }
            })
        }
    }
    #[tokio::test]
    #[ignore = "Requires WERKTERM_TEST_SSH and WERKTERM_TEST_SSH_PASSWORD"]
    async fn ssh_shell_listing_and_close() {
        let target = std::env::var("WERKTERM_TEST_SSH")
            .expect("WERKTERM_TEST_SSH")
            .parse()
            .unwrap();
        let manager = Arc::new(SshManager::default());
        let path = temporary_path();
        let (data_tx, mut data_rx) = tokio::sync::mpsc::unbounded_channel();
        let (exit_tx, exit_rx) = oneshot::channel();
        let id = manager
            .connect(
                1,
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
            .unwrap()
            .id;
        manager.write(id, b"echo werkterm-ssh-ok\n").await.unwrap();
        let output = tokio::time::timeout(Duration::from_secs(15), async {
            let mut output = Vec::new();
            while let Some(bytes) = data_rx.recv().await {
                output.extend(bytes);
                if String::from_utf8_lossy(&output)
                    .replace('\r', "")
                    .contains("\nwerkterm-ssh-ok\n")
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
