use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    io::Write,
    net::IpAddr,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tauri::{Emitter, Manager, State};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch},
    task::JoinSet,
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Local,
    Remote,
    Dynamic,
}
fn default_bind() -> String {
    "127.0.0.1".into()
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Tunnel {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    pub session_id: String,
    #[serde(default = "default_bind")]
    pub bind_address: String,
    pub bind_port: u16,
    #[serde(default)]
    pub target_host: String,
    #[serde(default)]
    pub target_port: Option<u16>,
    #[serde(default)]
    pub autostart: bool,
    #[serde(default)]
    pub reconnect: bool,
    #[serde(default)]
    pub allow_public: bool,
}
#[derive(Serialize, Deserialize)]
struct File {
    version: u32,
    tunnels: Vec<Tunnel>,
}
pub fn is_loopback(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}
fn host_valid(host: &str) -> bool {
    !host.is_empty() && !host.chars().any(|c| c.is_whitespace() || c.is_control())
}
fn validate_fields(t: &Tunnel) -> Result<(), String> {
    if t.name.trim().is_empty()
        || !host_valid(&t.bind_address)
        || (t.kind != Kind::Remote && t.bind_port == 0)
        || (t.kind != Kind::Dynamic
            && (!host_valid(&t.target_host) || t.target_port.is_none_or(|p| p == 0)))
    {
        return Err(
            "Name, Adresse oder Port ist ungültig (Ports: 1–65535; Remote-Port auch 0)".into(),
        );
    }
    // Local binds use only literals or localhost: DNS must not turn a permitted bind into a public bind.
    if t.kind != Kind::Remote
        && !t.bind_address.eq_ignore_ascii_case("localhost")
        && t.bind_address.parse::<IpAddr>().is_err()
    {
        return Err("Lokale Bind-Adresse muss eine IP-Adresse oder localhost sein".into());
    }
    if t.kind == Kind::Dynamic && (!t.target_host.is_empty() || t.target_port.is_some()) {
        return Err("Dynamische Tunnel haben kein festes Ziel".into());
    }
    Ok(())
}
fn validate(t: &Tunnel, sessions: &[crate::sessions::SavedSession]) -> Result<(), String> {
    validate_fields(t)?;
    if !sessions
        .iter()
        .any(|s| s.id == t.session_id && s.kind == "ssh")
    {
        return Err("SSH-Sitzung existiert nicht".into());
    }
    Ok(())
}
pub(crate) fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|_| "Konfigurationsordner fehlt")?
        .join("tunnels.json"))
}
fn load(path: &Path) -> Result<Vec<Tunnel>, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err("Tunneldatei konnte nicht gelesen werden".into()),
    };
    let file: File = serde_json::from_slice(&bytes).map_err(|_| "Tunneldatei ist beschädigt")?;
    if file.version != 1 {
        return Err("Tunneldatei hat eine unbekannte Version".into());
    }
    let mut ids = HashSet::new();
    for t in &file.tunnels {
        validate_fields(t)?;
        if t.id.is_empty() || !ids.insert(&t.id) {
            return Err("Tunneldatei enthält ungültige IDs".into());
        }
    }
    Ok(file.tunnels)
}
fn write_atomic(path: &Path, tunnels: Vec<Tunnel>) -> Result<(), String> {
    load(path)?;
    let bytes = serde_json::to_vec_pretty(&File {
        version: 1,
        tunnels,
    })
    .map_err(|_| "Tunnel konnten nicht serialisiert werden")?;
    let parent = path.parent().ok_or("Ungültiger Tunnelpfad")?;
    std::fs::create_dir_all(parent)
        .map_err(|_| "Konfigurationsordner konnte nicht angelegt werden")?;
    let temp = parent.join(format!(".tunnels-{}.tmp", crate::sessions::new_id()));
    let result = (|| -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut f = options.open(&temp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result.map_err(|_| "Tunneldatei konnte nicht atomar gespeichert werden".into())
}
pub(crate) fn protect_session(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    protect(id, &load(&path(app)?)?)
}
fn protect(id: &str, tunnels: &[Tunnel]) -> Result<(), String> {
    let names: Vec<_> = tunnels
        .iter()
        .filter(|t| t.session_id == id)
        .map(|t| t.name.as_str())
        .collect();
    if names.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Sitzung wird von SSH-Tunneln verwendet: {}",
            names.join(", ")
        ))
    }
}
#[derive(Clone, Default, Serialize)]
pub struct Status {
    pub id: String,
    pub state: String,
    pub error: Option<String>,
    pub connections: u64,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub bound_port: Option<u32>,
}
#[derive(Default)]
struct Counters {
    active: AtomicU64,
    incoming: AtomicU64,
    outgoing: AtomicU64,
}
struct Running {
    joined: bool,
    app: tauri::AppHandle,
    cancel: watch::Sender<bool>,
    done: tokio::task::JoinHandle<()>,
    status: Arc<Mutex<Status>>,
}
#[derive(Default)]
pub struct TunnelManager {
    operations: tokio::sync::Mutex<()>,
    autostarted: AtomicBool,
    running: tokio::sync::Mutex<HashMap<String, Running>>,
}
pub(crate) struct Forward {
    pub channel: russh::Channel<russh::client::Msg>,
    pub address: String,
    pub port: u32,
    pub reply: russh::client::ChannelOpenHandle,
}
#[derive(Clone)]
pub(crate) struct ForwardSender {
    sender: mpsc::Sender<(Forward, Active)>,
    connections: Arc<Connections>,
}
impl ForwardSender {
    pub(crate) fn try_send(&self, forward: Forward) -> Result<(), ()> {
        // Acquire at the SSH callback, before crossing the dispatch channel.
        let Some(active) = self.connections.try_acquire() else {
            drop(forward.channel.into_stream());
            return Err(());
        };
        if let Err(error) = self.sender.try_send((forward, active)) {
            let (forward, _active) = error.into_inner();
            drop(forward.channel.into_stream());
            return Err(());
        }
        Ok(())
    }
}
fn matches_forward(t: &Tunnel, port: u32, address: &str, connected_port: u32) -> bool {
    t.kind == Kind::Remote && t.bind_address == address && port == connected_port
}
fn backoff(attempt: usize) -> Duration {
    Duration::from_secs(match attempt {
        0 => 5,
        1 => 10,
        2 => 30,
        _ => 60,
    })
}
fn set_state(status: &Mutex<Status>, state: &str, error: Option<String>) {
    let mut s = status.lock().unwrap();
    s.state = state.into();
    s.error = error;
}

// Pure parsers: None means that more bytes are needed, errors are SOCKS reply codes.
fn greeting(bytes: &[u8]) -> Result<Option<usize>, u8> {
    if bytes.len() < 2 {
        return Ok(None);
    }
    if bytes[0] != 5 || bytes[1] == 0 {
        return Err(0xff);
    }
    let end = 2 + bytes[1] as usize;
    if bytes.len() < end {
        return Ok(None);
    }
    if bytes[2..end].contains(&0) {
        Ok(Some(end))
    } else {
        Err(0xff)
    }
}
fn request(bytes: &[u8]) -> Result<Option<(String, u16)>, u8> {
    if bytes.len() < 4 {
        return Ok(None);
    }
    if bytes[0] != 5 || bytes[2] != 0 {
        return Err(1);
    }
    if bytes[1] != 1 {
        return Err(7);
    }
    let (host, end) = match bytes[3] {
        1 => {
            if bytes.len() < 10 {
                return Ok(None);
            }
            (
                std::net::Ipv4Addr::new(bytes[4], bytes[5], bytes[6], bytes[7]).to_string(),
                8,
            )
        }
        4 => {
            if bytes.len() < 22 {
                return Ok(None);
            }
            let mut ip = [0; 16];
            ip.copy_from_slice(&bytes[4..20]);
            (std::net::Ipv6Addr::from(ip).to_string(), 20)
        }
        3 => {
            if bytes.len() < 5 {
                return Ok(None);
            }
            let end = 5 + bytes[4] as usize;
            if bytes[4] == 0 {
                return Err(8);
            }
            if bytes.len() < end + 2 {
                return Ok(None);
            }
            let host = std::str::from_utf8(&bytes[5..end])
                .map_err(|_| 8)?
                .to_string();
            if !host_valid(&host) {
                return Err(8);
            }
            (host, end)
        }
        _ => return Err(8),
    };
    let port = u16::from_be_bytes([bytes[end], bytes[end + 1]]);
    if port == 0 {
        return Err(4);
    }
    Ok(Some((host, port)))
}
async fn socks_target(stream: &mut TcpStream) -> Result<(String, u16), String> {
    let mut bytes = Vec::new();
    loop {
        match greeting(&bytes) {
            Ok(Some(_)) => {
                stream
                    .write_all(&[5, 0])
                    .await
                    .map_err(|_| "SOCKS-Antwort fehlgeschlagen")?;
                break;
            }
            Err(_) => {
                let _ = stream.write_all(&[5, 0xff]).await;
                return Err("SOCKS5: no auth erforderlich".into());
            }
            Ok(None) => {
                let byte = stream
                    .read_u8()
                    .await
                    .map_err(|_| "Unvollständiger SOCKS-Gruß")?;
                bytes.push(byte);
            }
        }
    }
    bytes.clear();
    loop {
        match request(&bytes) {
            Ok(Some(target)) => return Ok(target),
            Err(code) => {
                let _ = socks_reply(stream, code).await;
                return Err("SOCKS-Anforderung abgelehnt".into());
            }
            Ok(None) => bytes.push(
                stream
                    .read_u8()
                    .await
                    .map_err(|_| "Unvollständige SOCKS-Anforderung")?,
            ),
        }
    }
}
async fn socks_reply(stream: &mut TcpStream, code: u8) -> std::io::Result<()> {
    stream.write_all(&[5, code, 0, 1, 0, 0, 0, 0, 0, 0]).await
}
struct Connections {
    permits: Arc<Semaphore>,
    counters: Arc<Counters>,
}
impl Connections {
    fn new(limit: usize, counters: Arc<Counters>) -> Self {
        Self {
            permits: Arc::new(Semaphore::new(limit)),
            counters,
        }
    }
    fn try_acquire(&self) -> Option<Active> {
        let permit = self.permits.clone().try_acquire_owned().ok()?;
        self.counters.active.fetch_add(1, Ordering::Relaxed);
        Some(Active(self.counters.clone(), permit))
    }
}
struct Active(Arc<Counters>, #[allow(dead_code)] OwnedSemaphorePermit);
impl Drop for Active {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::Relaxed);
    }
}
struct Meter<T> {
    inner: T,
    counters: Arc<Counters>,
}
impl<T: AsyncRead + Unpin> AsyncRead for Meter<T> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let result = std::pin::Pin::new(&mut self.inner).poll_read(cx, buf);
        self.counters
            .outgoing
            .fetch_add((buf.filled().len() - before) as u64, Ordering::Relaxed);
        result
    }
}
impl<T: AsyncWrite + Unpin> AsyncWrite for Meter<T> {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        let result = std::pin::Pin::new(&mut self.inner).poll_write(cx, buf);
        if let std::task::Poll::Ready(Ok(n)) = &result {
            self.counters
                .incoming
                .fetch_add(*n as u64, Ordering::Relaxed);
        }
        result
    }
    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}
async fn copy<A: AsyncRead + AsyncWrite + Unpin, B: AsyncRead + AsyncWrite + Unpin>(
    a: A,
    mut b: B,
    counters: Arc<Counters>,
) {
    let mut a = Meter { inner: a, counters };
    let _ = tokio::io::copy_bidirectional(&mut a, &mut b).await;
}
fn socks_channel_error(error: &russh::Error) -> u8 {
    if matches!(
        error,
        russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::ConnectFailed)
    ) {
        5
    } else {
        4
    }
}
// A rejected or unread delivery drops its owned stream, closing the channel.
fn deliver_opened<T, E>(sender: oneshot::Sender<Result<T, E>>, result: Result<T, E>) {
    let _ = sender.send(result);
}
async fn local_connection(
    mut stream: TcpStream,
    handle: Arc<crate::ssh::TunnelHandle>,
    t: Tunnel,
    counters: Arc<Counters>,
) {
    let target = if t.kind == Kind::Dynamic {
        match tokio::time::timeout(Duration::from_secs(30), socks_target(&mut stream)).await {
            Ok(Ok(t)) => t,
            _ => return,
        }
    } else {
        (t.target_host, t.target_port.unwrap_or(0))
    };
    let peer = match stream.peer_addr() {
        Ok(p) => p,
        Err(_) => return,
    };
    // Keep polling the opening even if the connection task times out or is aborted.
    let (sender, receiver) = oneshot::channel();
    tokio::spawn(async move {
        let result = handle
            .channel_open_direct_tcpip(
                target.0,
                u32::from(target.1),
                peer.ip().to_string(),
                u32::from(peer.port()),
            )
            .await;
        // Stream ownership also covers cancellation after send but before receive.
        deliver_opened(sender, result.map(|channel| channel.into_stream()));
    });
    let channel = tokio::time::timeout(Duration::from_secs(15), receiver).await;
    match channel {
        Ok(Ok(Ok(channel))) => {
            if t.kind == Kind::Dynamic && socks_reply(&mut stream, 0).await.is_err() {
                return;
            }
            copy(stream, channel, counters).await;
        }
        failed => {
            if t.kind == Kind::Dynamic {
                let code = match failed {
                    Ok(Ok(Err(error))) => socks_channel_error(&error),
                    _ => 4,
                };
                let _ = socks_reply(&mut stream, code).await;
            }
        }
    }
}
async fn run_once(
    t: &Tunnel,
    sessions: &[crate::sessions::SavedSession],
    prompter: Arc<dyn crate::ssh::Prompter>,
    mut cancel: watch::Receiver<bool>,
    status: Arc<Mutex<Status>>,
    counters: Arc<Counters>,
    rejected: Arc<AtomicBool>,
) -> Result<(), String> {
    validate(t, sessions)?;
    let session = sessions
        .iter()
        .find(|s| s.id == t.session_id)
        .ok_or("SSH-Sitzung fehlt")?
        .clone();
    let jumps = crate::sessions::resolve_jump_chain(&session, sessions)?
        .into_iter()
        .cloned()
        .collect();
    let listener = if t.kind != Kind::Remote {
        let address = if t.bind_address.eq_ignore_ascii_case("localhost") {
            "127.0.0.1"
        } else {
            &t.bind_address
        };
        Some(
            TcpListener::bind((address, t.bind_port))
                .await
                .map_err(|e| {
                    if e.kind() == std::io::ErrorKind::AddrInUse {
                        format!("Port {} ist bereits belegt", t.bind_port)
                    } else {
                        format!("Tunnel konnte nicht gebunden werden: {e}")
                    }
                })?,
        )
    } else {
        None
    };
    let connections = Arc::new(Connections::new(256, counters.clone()));
    let (sender, mut forwarded) = mpsc::channel(64);
    let sender = ForwardSender {
        sender,
        connections: connections.clone(),
    };
    let (handle, _jumps, _socket) =
        crate::ssh::tunnel_transport(session, jumps, prompter, cancel.clone(), sender).await?;
    if rejected.load(Ordering::Relaxed) {
        return Err("Anmeldung abgebrochen".into());
    }
    let handle = Arc::new(handle);
    let port = if t.kind == Kind::Remote {
        let allocated = tokio::select! {
            _ = cancel.changed() => return Ok(()),
            result = tokio::time::timeout(Duration::from_secs(15), handle.tcpip_forward(t.bind_address.clone(), u32::from(t.bind_port))) => {
                result.map_err(|_| "Zeitüberschreitung bei Remote-Weiterleitung")?
                    .map_err(|_| format!("Remote-Weiterleitung abgelehnt: Port {} ist bereits belegt oder die Serverrichtlinie verbietet die Weiterleitung", t.bind_port))?
            }
        };
        if t.bind_port == 0 && !(1..=65535).contains(&allocated) {
            return Err("Server hat einen ungültigen Tunnel-Port geliefert".into());
        }
        if t.bind_port == 0 {
            allocated
        } else {
            u32::from(t.bind_port)
        }
    } else {
        u32::from(t.bind_port)
    };
    status.lock().unwrap().bound_port = Some(port);
    set_state(&status, "running", None);
    let mut tasks = JoinSet::new();
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    let outcome = loop {
        if *cancel.borrow() {
            break Ok(());
        }
        tokio::select! {
            _=cancel.changed()=>break Ok(()),
            _=tick.tick()=> { if handle.is_closed() { break Err("SSH-Verbindung getrennt".into()); } },
            Some(_)=tasks.join_next(), if !tasks.is_empty()=> {},
            incoming=async { listener.as_ref().unwrap().accept().await }, if listener.is_some()=> {
                match incoming { Ok((stream,_))=> { if let Some(active) = connections.try_acquire() {
                    let handle = handle.clone(); let t = t.clone(); let counters = counters.clone();
                    tasks.spawn(async move {
                        let _active = active;
                        local_connection(stream, handle, t, counters).await;
                    });
                } }, Err(e)=>break Err(format!("Tunnel-Listener: {e}")) }
            },
            Some((forward, active))=forwarded.recv()=> {
                if !matches_forward(t,port,&forward.address,forward.port) { drop(forward); continue; }
                let target=(t.target_host.clone(),t.target_port.unwrap_or(0)); let counters=counters.clone();
                tasks.spawn(async move {
                    let _active = active;
                    match tokio::time::timeout(Duration::from_secs(15),TcpStream::connect(target)).await {
                        Ok(Ok(stream))=> { let channel = forward.channel.into_stream(); forward.reply.accept().await; copy(stream,channel,counters).await; },
                        _=> { drop(forward); }
                    }
                });
            }
        }
    };
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    if t.kind == Kind::Remote {
        let _ = tokio::time::timeout(
            Duration::from_secs(3),
            handle.cancel_tcpip_forward(t.bind_address.clone(), port),
        )
        .await;
    }
    let _ = tokio::time::timeout(
        Duration::from_secs(3),
        handle.disconnect(russh::Disconnect::ByApplication, "", ""),
    )
    .await;
    outcome
}
impl TunnelManager {
    async fn start(
        self: &Arc<Self>,
        app: tauri::AppHandle,
        t: Tunnel,
        allow_public: bool,
        prompter: Arc<dyn crate::ssh::Prompter>,
    ) -> Result<(), String> {
        let _operation = self.operations.lock().await;
        let t = tunnels_list(app.clone())
            .await?
            .into_iter()
            .find(|saved| saved.id == t.id)
            .ok_or("Tunnel existiert nicht")?;
        if !is_loopback(&t.bind_address) && !allow_public {
            return Err(
                "Andere Geräte im Netzwerk können diesen Tunnel nutzen. Bestätigung erforderlich."
                    .into(),
            );
        }
        let sessions = crate::sessions::sessions_list(app.clone()).await?;
        validate(&t, &sessions)?;
        let mut running = self.running.lock().await;
        if running.get(&t.id).is_some_and(|r| !r.done.is_finished()) {
            return Ok(());
        }
        let (cancel, mut canceled) = watch::channel(false);
        let status = Arc::new(Mutex::new(Status {
            id: t.id.clone(),
            state: "connecting".into(),
            ..Default::default()
        }));
        let counters = Arc::new(Counters::default());
        let state = status.clone();
        let stats = counters.clone();
        let mut event_cancel = cancel.subscribe();
        let event_app = app.clone();
        let events = tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(500));
            loop {
                tokio::select! { _=event_cancel.changed()=>break, _=tick.tick()=> {
                    let mut s=state.lock().unwrap(); s.connections=stats.active.load(Ordering::Relaxed); s.bytes_in=stats.incoming.load(Ordering::Relaxed); s.bytes_out=stats.outgoing.load(Ordering::Relaxed);
                    let _=event_app.emit("tunnel-status",s.clone());
                } }
            }
        });
        let state = status.clone();
        let id = t.id.clone();
        let running_app = app.clone();
        let rejected = Arc::new(AtomicBool::new(false));
        let prompter: Arc<dyn crate::ssh::Prompter> = Arc::new(CancelAwarePrompter {
            inner: prompter,
            rejected: rejected.clone(),
        });
        let done = tokio::spawn(async move {
            let mut attempt = 0;
            loop {
                let result = run_once(
                    &t,
                    &sessions,
                    prompter.clone(),
                    canceled.clone(),
                    state.clone(),
                    counters.clone(),
                    rejected.clone(),
                )
                .await;
                if *canceled.borrow() {
                    break;
                }
                match result {
                    Ok(()) => break,
                    Err(error) => {
                        // A new outage starts a fresh backoff sequence after a successful connection.
                        if state.lock().unwrap().state == "running" {
                            attempt = 0;
                        }
                        let error = if rejected.load(Ordering::Relaxed) {
                            "SSH-Anmeldung oder Hostkey-Bestätigung abgebrochen".into()
                        } else {
                            error
                        };
                        if rejected.load(Ordering::Relaxed)
                            || !t.reconnect
                            || error.contains("abgebrochen")
                            || error.contains("Hostkey")
                            || error.contains("belegt")
                        {
                            set_state(&state, "error", Some(error));
                            break;
                        }
                        set_state(&state, "reconnecting", Some(error));
                        tokio::select! { _=canceled.changed()=>break, _=tokio::time::sleep(backoff(attempt))=>{} }
                        attempt += 1;
                    }
                }
            }
            if *canceled.borrow() {
                set_state(&state, "stopped", None);
            }
            events.abort();
            let _ = events.await;
            let mut s = state.lock().unwrap();
            s.connections = 0;
            s.bytes_in = counters.incoming.load(Ordering::Relaxed);
            s.bytes_out = counters.outgoing.load(Ordering::Relaxed);
            let _ = app.emit("tunnel-status", s.clone());
        });
        running.insert(
            id,
            Running {
                joined: false,
                app: running_app,
                cancel,
                done,
                status,
            },
        );
        Ok(())
    }
    async fn stop(&self, id: &str) {
        let mut running = self.running.lock().await;
        if let Some(r) = running.get_mut(id) {
            r.cancel.send_replace(true);
            if !r.joined {
                let _ = (&mut r.done).await;
                r.joined = true;
            }
            set_state(&r.status, "stopped", None);
            let _ = r
                .app
                .emit("tunnel-status", r.status.lock().unwrap().clone());
        }
    }
    pub async fn stop_all(&self) {
        let _operation = self.operations.lock().await;
        let ids: Vec<_> = self.running.lock().await.keys().cloned().collect();
        for id in ids {
            self.stop(&id).await;
        }
    }
}
#[tauri::command]
pub async fn tunnels_list(app: tauri::AppHandle) -> Result<Vec<Tunnel>, String> {
    let _guard = crate::sessions::STORAGE_LOCK.lock().await;
    load(&path(&app)?)
}
#[tauri::command]
pub async fn tunnel_save(
    app: tauri::AppHandle,
    manager: State<'_, Arc<TunnelManager>>,
    mut tunnel: Tunnel,
    public_confirmed: bool,
) -> Result<Tunnel, String> {
    let _operation = manager.operations.lock().await;
    if tunnel.allow_public && !public_confirmed {
        return Err("Öffentliche Freigabe muss bestätigt werden".into());
    }
    if manager
        .running
        .lock()
        .await
        .get(&tunnel.id)
        .is_some_and(|r| !r.done.is_finished())
    {
        return Err("Tunnel vor dem Bearbeiten stoppen".into());
    }
    let _guard = crate::sessions::STORAGE_LOCK.lock().await;
    let sessions = crate::sessions::load(
        &app.path()
            .app_config_dir()
            .map_err(|_| "Konfigurationsordner fehlt")?
            .join("sessions.json"),
    )?;
    validate(&tunnel, &sessions)?;
    if !is_loopback(&tunnel.bind_address) && (!public_confirmed || !tunnel.allow_public) {
        return Err("Öffentliche Bind-Adresse muss bestätigt werden".into());
    }
    if tunnel.id.is_empty() {
        tunnel.id = crate::sessions::new_id();
    }
    let path = path(&app)?;
    let mut list = load(&path)?;
    list.retain(|t| t.id != tunnel.id);
    list.push(tunnel.clone());
    write_atomic(&path, list)?;
    Ok(tunnel)
}
#[tauri::command]
pub async fn tunnel_delete(
    app: tauri::AppHandle,
    manager: State<'_, Arc<TunnelManager>>,
    id: String,
) -> Result<(), String> {
    let _operation = manager.operations.lock().await;
    manager.stop(&id).await;
    let _guard = crate::sessions::STORAGE_LOCK.lock().await;
    let path = path(&app)?;
    let mut list = load(&path)?;
    list.retain(|t| t.id != id);
    write_atomic(&path, list)?;
    manager.running.lock().await.remove(&id);
    Ok(())
}
// Remember explicit prompt rejection independently of transport error wording.
struct CancelAwarePrompter<P: crate::ssh::Prompter + ?Sized> {
    inner: Arc<P>,
    rejected: Arc<AtomicBool>,
}
impl<P: crate::ssh::Prompter + ?Sized> crate::ssh::Prompter for CancelAwarePrompter<P> {
    fn confirm_host_key(
        &self,
        host: String,
        port: u16,
        key_type: String,
        fingerprint: String,
    ) -> crate::ssh::PromptFuture<bool> {
        if self.rejected.load(Ordering::Relaxed) {
            return Box::pin(async { false });
        }
        let future = self
            .inner
            .confirm_host_key(host, port, key_type, fingerprint);
        let rejected = self.rejected.clone();
        Box::pin(async move {
            let accepted = future.await;
            if !accepted {
                rejected.store(true, Ordering::Relaxed);
            }
            accepted
        })
    }
    fn ask_secret(
        &self,
        kind: crate::ssh::SecretKind,
        label: String,
    ) -> crate::ssh::PromptFuture<Option<String>> {
        if self.rejected.load(Ordering::Relaxed) {
            return Box::pin(async { None });
        }
        let future = self.inner.ask_secret(kind, label);
        let rejected = self.rejected.clone();
        Box::pin(async move {
            let answer = future.await;
            if answer.is_none() {
                rejected.store(true, Ordering::Relaxed);
            }
            answer
        })
    }
}
fn prompter(
    app: tauri::AppHandle,
    pending: Arc<crate::commands::PendingPrompts>,
    channel: tauri::ipc::Channel<crate::commands::SshPrompt>,
) -> Arc<dyn crate::ssh::Prompter> {
    // A reserved owner token prevents terminal cancellation from canceling tunnel prompts.
    Arc::new(crate::commands::TauriPrompter {
        closed: Some(app),
        connect_token: u32::MAX,
        pending,
        channel,
    })
}
#[tauri::command]
pub async fn tunnel_start(
    app: tauri::AppHandle,
    manager: State<'_, Arc<TunnelManager>>,
    pending: State<'_, Arc<crate::commands::PendingPrompts>>,
    id: String,
    allow_public: bool,
    on_prompt: tauri::ipc::Channel<crate::commands::SshPrompt>,
) -> Result<(), String> {
    let t = tunnels_list(app.clone())
        .await?
        .into_iter()
        .find(|t| t.id == id)
        .ok_or("Tunnel existiert nicht")?;
    manager
        .start(
            app.clone(),
            t,
            allow_public,
            prompter(app.clone(), pending.inner().clone(), on_prompt),
        )
        .await
}
#[tauri::command]
pub async fn tunnel_stop(manager: State<'_, Arc<TunnelManager>>, id: String) -> Result<(), String> {
    let _operation = manager.operations.lock().await;
    manager.stop(&id).await;
    Ok(())
}
#[tauri::command]
pub async fn tunnel_list_status(
    app: tauri::AppHandle,
    manager: State<'_, Arc<TunnelManager>>,
) -> Result<Vec<Status>, String> {
    let saved = tunnels_list(app).await?;
    let running = manager.running.lock().await;
    Ok(saved
        .into_iter()
        .map(|t| {
            running
                .get(&t.id)
                .map(|r| r.status.lock().unwrap().clone())
                .unwrap_or(Status {
                    id: t.id,
                    state: "stopped".into(),
                    ..Default::default()
                })
        })
        .collect())
}
#[tauri::command]
pub async fn tunnel_autostart(
    app: tauri::AppHandle,
    manager: State<'_, Arc<TunnelManager>>,
    pending: State<'_, Arc<crate::commands::PendingPrompts>>,
    on_prompt: tauri::ipc::Channel<crate::commands::SshPrompt>,
) -> Result<(), String> {
    if manager.autostarted.swap(true, Ordering::Relaxed) {
        return Ok(());
    }
    let mut errors = Vec::new();
    for t in tunnels_list(app.clone())
        .await?
        .into_iter()
        .filter(|t| t.autostart)
    {
        let allowed = is_loopback(&t.bind_address) || t.allow_public;
        if let Err(error) = manager
            .start(
                app.clone(),
                t,
                allowed,
                prompter(app.clone(), pending.inner().clone(), on_prompt.clone()),
            )
            .await
        {
            errors.push(error);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}
#[cfg(test)]
mod tests;
