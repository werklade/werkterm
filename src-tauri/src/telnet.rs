//! Telnet protocol and terminal transport. Negotiation state survives read boundaries.
use std::{
    collections::HashMap,
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
    time::Duration,
};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{Notify, mpsc, oneshot},
};

use crate::ui_error::{UiError, ui_code, ui_err};
const IAC: u8 = 255;
const WILL: u8 = 251;
const WONT: u8 = 252;
const DO: u8 = 253;
const DONT: u8 = 254;
pub struct Parser {
    state: u8,
    command: u8,
    sub: Vec<u8>,
    remote: [bool; 256],
    local: [bool; 256],
    rejected_remote: [bool; 256],
    rejected_local: [bool; 256],
    pub cols: u16,
    pub rows: u16,
}
impl Default for Parser {
    fn default() -> Self {
        Self {
            state: 0,
            command: 0,
            sub: Vec::new(),
            remote: [false; 256],
            local: [false; 256],
            rejected_remote: [false; 256],
            rejected_local: [false; 256],
            cols: 80,
            rows: 24,
        }
    }
}
pub fn escape(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    for &b in bytes {
        out.push(b);
        if b == IAC {
            out.push(b);
        }
    }
    out
}
pub fn encode(bytes: &[u8], binary: bool) -> Vec<u8> {
    let mut out = Vec::new();
    for &b in bytes {
        out.push(b);
        if b == IAC {
            out.push(b);
        } else if b == b'\r' && !binary {
            out.push(b'\n');
        }
    }
    out
}
pub fn naws(cols: u16, rows: u16) -> Vec<u8> {
    let mut out = vec![IAC, 250, 31];
    out.extend(escape(&[cols.to_be_bytes(), rows.to_be_bytes()].concat()));
    out.extend([IAC, 240]);
    out
}
impl Parser {
    pub fn binary(&self) -> bool {
        self.local[0]
    }
    pub fn resize(&mut self, cols: u16, rows: u16) -> Vec<u8> {
        self.cols = cols;
        self.rows = rows;
        if self.local[31] {
            naws(cols, rows)
        } else {
            vec![]
        }
    }
    pub fn feed(&mut self, bytes: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut data = Vec::new();
        let mut reply = Vec::new();
        for &b in bytes {
            match self.state {
                0 => {
                    if b == IAC {
                        self.state = 1
                    } else {
                        data.push(b)
                    }
                }
                1 => match b {
                    IAC => {
                        data.push(IAC);
                        self.state = 0
                    }
                    WILL | WONT | DO | DONT => {
                        self.command = b;
                        self.state = 2
                    }
                    250 => {
                        self.sub.clear();
                        self.state = 3
                    }
                    _ => self.state = 0,
                },
                2 => {
                    let i = usize::from(b);
                    let supported = match self.command {
                        WILL => matches!(b, 0 | 1 | 3),
                        DO => matches!(b, 0 | 3 | 24 | 31),
                        _ => false,
                    };
                    match self.command {
                        WILL => {
                            if supported {
                                if !self.remote[i] {
                                    reply.extend([IAC, DO, b]);
                                    self.remote[i] = true;
                                }
                                self.rejected_remote[i] = false;
                            } else if !self.rejected_remote[i] {
                                reply.extend([IAC, DONT, b]);
                                self.rejected_remote[i] = true;
                            }
                        }
                        DO => {
                            if supported {
                                if !self.local[i] {
                                    reply.extend([IAC, WILL, b]);
                                    self.local[i] = true;
                                    if b == 31 {
                                        reply.extend(naws(self.cols, self.rows));
                                    }
                                }
                                self.rejected_local[i] = false;
                            } else if !self.rejected_local[i] {
                                reply.extend([IAC, WONT, b]);
                                self.rejected_local[i] = true;
                            }
                        }
                        WONT => {
                            if self.remote[i] {
                                reply.extend([IAC, DONT, b]);
                            }
                            self.remote[i] = false;
                            self.rejected_remote[i] = false;
                        }
                        DONT => {
                            if self.local[i] {
                                reply.extend([IAC, WONT, b]);
                            }
                            self.local[i] = false;
                            self.rejected_local[i] = false;
                        }
                        _ => (),
                    }
                    self.state = 0;
                }
                3 => {
                    if b == IAC {
                        self.state = 4
                    } else if self.sub.len() < 4096 {
                        self.sub.push(b)
                    }
                }
                4 => match b {
                    240 => {
                        if self.local[24] && self.sub == [24, 1] {
                            reply.extend([IAC, 250, 24, 0]);
                            reply.extend(b"XTERM-256COLOR");
                            reply.extend([IAC, 240]);
                        }
                        self.sub.clear();
                        self.state = 0
                    }
                    IAC => {
                        if self.sub.len() < 4096 {
                            self.sub.push(IAC);
                        }
                        self.state = 3
                    }
                    _ => self.state = 3,
                },
                _ => unreachable!(),
            }
        }
        (data, reply)
    }
}
pub(crate) enum Message {
    Data(Vec<u8>),
    Resize(u16, u16),
    Break,
}
pub(crate) struct Control {
    pub stop: std::sync::Arc<AtomicBool>,
    notify: Notify,
}
impl Control {
    fn close(&self) {
        self.stop.store(true, Ordering::Release);
        self.notify.notify_one();
    }
}
struct Connection {
    sender: mpsc::Sender<Message>,
    control: std::sync::Arc<Control>,
}
type Senders = Mutex<HashMap<u32, Connection>>;
static CONNECTIONS: OnceLock<Senders> = OnceLock::new();
static NEXT: AtomicU32 = AtomicU32::new(1);
fn connections() -> &'static Senders {
    CONNECTIONS.get_or_init(Default::default)
}
pub(crate) fn register(sender: mpsc::Sender<Message>) -> (u32, std::sync::Arc<Control>) {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let control = std::sync::Arc::new(Control {
        stop: Default::default(),
        notify: Notify::new(),
    });
    connections().lock().unwrap().insert(
        id,
        Connection {
            sender,
            control: control.clone(),
        },
    );
    (id, control)
}
pub fn stop_all() {
    if let Ok(connections) = connections().lock() {
        for entry in connections.values() {
            entry.control.close();
        }
    }
}
pub(crate) fn remove(id: u32) {
    connections().lock().unwrap().remove(&id);
}
pub(crate) async fn send(id: u32, msg: Message) -> Result<(), String> {
    let sender = connections()
        .lock()
        .map_err(|_| ui_code("PTY_LOCKED"))?
        .get(&id)
        .filter(|entry| !entry.control.stop.load(Ordering::Acquire))
        .map(|entry| entry.sender.clone())
        .ok_or(ui_code("CONNECTION_ENDED"))?;
    sender
        .send(msg)
        .await
        .map_err(|_| ui_code("CONNECTION_ENDED").into())
}
pub(crate) struct Output {
    pub app: tauri::AppHandle,
    pub tab: u32,
    pub data: Channel<InvokeResponseBody>,
    pub exit: Channel<Option<u32>>,
}
impl Output {
    pub fn data(&self, bytes: Vec<u8>) {
        crate::session_log::output(&self.app, self.tab, &bytes);
        let _ = self.data.send(InvokeResponseBody::Raw(bytes));
    }
    pub fn finish(&self) {
        crate::session_log::finish(&self.app, self.tab);
        let _ = self.exit.send(None);
    }
    /// Error notice for the terminal. Travels as JSON `{"notice": "<wire-format error>"}` on the
    /// data channel (ordered with the raw output), so the frontend can translate it; raw
    /// stream bytes could not be translated. The session log gets the language-neutral `log_line` form.
    pub fn error(&self, error: impl Into<String>) {
        let notice = error.into().replace(['\x1b', '\0'], "");
        crate::session_log::output(
            &self.app,
            self.tab,
            format!("\r\n[{}]\r\n", crate::ui_error::log_line(&notice)).as_bytes(),
        );
        let _ = self
            .data
            .send(InvokeResponseBody::Json(notice_json(&notice)));
    }
}
fn notice_json(notice: &str) -> String {
    serde_json::json!({ "notice": notice }).to_string()
}
type Pending = Mutex<HashMap<u32, oneshot::Sender<()>>>;
static PENDING: OnceLock<Pending> = OnceLock::new();
#[tauri::command]
pub fn terminal_cancel_connect(connect_token: u32) {
    if let Some(tx) = PENDING
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .remove(&connect_token)
    {
        let _ = tx.send(());
    }
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn telnet_connect(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    cols: u16,
    rows: u16,
    tab_id: u32,
    connect_token: u32,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<Option<u32>>,
) -> Result<u32, String> {
    if host.is_empty() || host.chars().any(|c| c.is_whitespace() || c.is_control()) || port == 0 {
        return Err(ui_err("TELNET_INVALID_TARGET").into());
    }
    let (cancel, mut cancelled) = oneshot::channel();
    PENDING
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .insert(connect_token, cancel);
    let connection = async {
        let addresses = tokio::time::timeout(
            Duration::from_secs(10),
            tokio::net::lookup_host((host.as_str(), port)),
        )
        .await
        .map_err(|_| String::from(ui_err("SSH_RESOLVE_TIMEOUT")))?
        .map_err(|e| String::from(ui_err("SSH_RESOLVE_FAILED").arg("host", &host).detail(e)))?;
        let mut last: String = ui_err("SSH_RESOLVE_FAILED").arg("host", &host).into();
        for address in addresses {
            match tokio::time::timeout(
                Duration::from_secs(10),
                tokio::net::TcpStream::connect(address),
            )
            .await
            {
                Ok(Ok(stream)) => return Ok(stream),
                Ok(Err(error)) => last = ui_err("TELNET_CONNECT_FAILED").detail(error).into(),
                Err(_) => {
                    last = ui_err("SSH_ADDRESS_TIMEOUT")
                        .arg("address", address.to_string())
                        .into()
                }
            }
        }
        Err(last)
    };
    let result = tokio::select! {
        _ = &mut cancelled => Err(ui_err("SSH_CONNECT_CANCELED").into()),
        result = connection => result,
    };
    PENDING
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .remove(&connect_token);
    let mut stream = result?;
    let (tx, mut rx) = mpsc::channel(128);
    let (id, control) = register(tx);
    let output = Output {
        app,
        tab: tab_id,
        data: on_data,
        exit: on_exit,
    };
    tauri::async_runtime::spawn(async move {
        let mut parser = Parser {
            cols,
            rows,
            ..Default::default()
        };
        let mut buffer = [0; 8192];
        let result: Result<(), UiError> = async {
            while !control.stop.load(Ordering::Acquire) {
                let bytes = tokio::select! {
                    _ = control.notify.notified() => break,
                    incoming = stream.read(&mut buffer) => {
                        let n = incoming.map_err(|e| ui_err("TELNET_CONNECTION_LOST").detail(e))?;
                        if n == 0 { break; }
                        let (data, reply) = parser.feed(&buffer[..n]);
                        if !data.is_empty() { output.data(data); }
                        reply
                    },
                    message = rx.recv() => match message {
                        Some(Message::Data(bytes)) => encode(&bytes, parser.binary()),
                        Some(Message::Resize(cols, rows)) => parser.resize(cols, rows),
                        Some(Message::Break) => vec![IAC, 243],
                        _ => break,
                    },
                };
                tokio::select! {
                    _ = control.notify.notified() => break,
                    result = tokio::time::timeout(Duration::from_secs(10), stream.write_all(&bytes)) => {
                        result
                            .map_err(|_| ui_err("TELNET_WRITE_TIMEOUT"))?
                            .map_err(|e| ui_err("TELNET_CONNECTION_LOST").detail(e))?;
                    }
                }

            }
            Ok(())
        }
        .await;
        if let Err(e) = result {
            output.error(e);
        }
        remove(id);
        output.finish();
    });
    Ok(id)
}
#[tauri::command]
pub async fn terminal_write(id: u32, data: String) -> Result<(), String> {
    send(id, Message::Data(data.into_bytes())).await
}
#[tauri::command]
pub async fn terminal_resize(id: u32, cols: u16, rows: u16) -> Result<(), String> {
    send(id, Message::Resize(cols, rows)).await
}
#[tauri::command]
pub async fn terminal_close(id: u32) -> Result<(), String> {
    if let Some(entry) = connections()
        .lock()
        .map_err(|_| ui_code("PTY_LOCKED"))?
        .remove(&id)
    {
        entry.control.close();
    }
    Ok(())
}
#[tauri::command]
pub async fn serial_break(id: u32) -> Result<(), String> {
    send(id, Message::Break).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn close_removes_connection_even_before_worker_finishes() {
        let (tx, _rx) = mpsc::channel(1);
        let (id, control) = register(tx);
        terminal_close(id).await.unwrap();
        assert!(control.stop.load(Ordering::Acquire));
        assert!(!connections().lock().unwrap().contains_key(&id));
        assert!(send(id, Message::Data(vec![1])).await.is_err());
        terminal_close(id).await.unwrap();
        remove(id);
    }
    #[test]
    fn notices_are_json_on_the_data_channel() {
        let value: serde_json::Value =
            serde_json::from_str(&notice_json(r#"SERIAL_REMOVED: {"args":{"device":"a"}}"#))
                .unwrap();
        assert_eq!(
            value["notice"].as_str(),
            Some(r#"SERIAL_REMOVED: {"args":{"device":"a"}}"#)
        );
    }
    #[test]
    fn split_negotiation_and_subnegotiation() {
        let mut p = Parser::default();
        assert!(p.feed(&[IAC]).0.is_empty());
        assert!(p.feed(&[WILL]).1.is_empty());
        assert_eq!(p.feed(&[1]).1, [IAC, DO, 1]);
        assert!(p.feed(&[IAC, WILL, 1]).1.is_empty());
        assert_eq!(p.feed(&[IAC, IAC]).0, [IAC]);
        assert_eq!(p.feed(&[IAC, DO, 24]).1, [IAC, WILL, 24]);
        for b in [IAC, 250, 24, 1, IAC] {
            assert!(p.feed(&[b]).0.is_empty());
        }
        let reply = p.feed(&[240]).1;
        assert_eq!(&reply[4..18], b"XTERM-256COLOR");
    }
    #[test]
    fn window_and_output() {
        assert_eq!(
            naws(255, 511),
            [255, 250, 31, 0, 255, 255, 1, 255, 255, 255, 240]
        );
        assert_eq!(encode(&[255, 13], false), [255, 255, 13, 10]);
        assert_eq!(encode(&[13], true), [13]);
        let mut p = Parser::default();
        assert_eq!(p.feed(&[255, DO, 0]).1, [255, WILL, 0]);
        assert!(p.binary());
        assert_eq!(
            p.feed(&[255, DO, 31]).1,
            [vec![255, WILL, 31], naws(80, 24)].concat()
        );
        assert_eq!(p.resize(80, 24), naws(80, 24));
    }
    #[test]
    fn refuses_once_and_ignores_sb() {
        let mut p = Parser::default();
        for option in [2, 42] {
            assert_eq!(p.feed(&[255, DO, option]).1, [255, WONT, option]);
            assert!(p.feed(&[255, DO, option]).1.is_empty());
        }
        assert_eq!(
            p.feed(&[255, 250, 1, 255, 255, 2, 255, 240, b'x', 255, 249])
                .0,
            b"x"
        );
    }
    #[test]
    fn every_chunk_boundary_produces_identical_protocol_output() {
        let stream = [
            b"Hello".as_slice(),
            &[
                IAC, WILL, 1, IAC, WILL, 3, IAC, DO, 3, IAC, DO, 24, IAC, 250, 24, 1, IAC, 240,
                IAC, DO, 31, IAC, WILL, 0, IAC, DO, 0, IAC, IAC,
            ],
            b"world",
        ]
        .concat();
        let expected = Parser::default().feed(&stream);
        for cut in 0..=stream.len() {
            let mut p = Parser::default();
            let (mut data, mut replies) = p.feed(&stream[..cut]);
            let (tail, response) = p.feed(&stream[cut..]);
            data.extend(tail);
            replies.extend(response);
            assert_eq!((data, replies), expected, "cut {cut}");
        }
    }
    #[test]
    fn negotiation_tracks_each_direction_and_resets_after_refusal() {
        let mut p = Parser::default();
        for (offer, accepted, disabled, acknowledged, option) in [
            (WILL, DO, WONT, DONT, 1),
            (WILL, DO, WONT, DONT, 3),
            (DO, WILL, DONT, WONT, 3),
            (DO, WILL, DONT, WONT, 24),
            (WILL, DO, WONT, DONT, 0),
            (DO, WILL, DONT, WONT, 0),
        ] {
            assert_eq!(p.feed(&[IAC, offer, option]).1, [IAC, accepted, option]);
            assert!(p.feed(&[IAC, offer, option]).1.is_empty());
            assert_eq!(
                p.feed(&[IAC, disabled, option]).1,
                [IAC, acknowledged, option]
            );
            assert!(p.feed(&[IAC, disabled, option]).1.is_empty());
        }
        for option in [2, 42, 255] {
            assert_eq!(p.feed(&[IAC, WILL, option]).1, [IAC, DONT, option]);
            assert!(p.feed(&[IAC, WILL, option]).1.is_empty());
            p.feed(&[IAC, WONT, option]);
            assert_eq!(p.feed(&[IAC, WILL, option]).1, [IAC, DONT, option]);
        }
    }
}
