use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

#[derive(Clone, Copy, Default)]
enum Escape {
    #[default]
    Text,
    Esc,
    Intermediate,
    Csi,
    String(bool),
    StringEsc(bool),
}

/// Byte-oriented so UTF-8 and even split UTF-8 characters remain unchanged.
#[derive(Default)]
pub struct AnsiFilter {
    state: Escape,
}
impl AnsiFilter {
    pub fn filter(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(bytes.len());
        for &b in bytes {
            self.state = match (self.state, b) {
                (_, 0x18 | 0x1a) => Escape::Text,
                (Escape::Text, 0x1b) => Escape::Esc,
                (Escape::Text, b'\n' | b'\t') => {
                    out.push(b);
                    Escape::Text
                }
                (Escape::Text, 0..=31 | 127) => Escape::Text,
                (Escape::Text, _) => {
                    out.push(b);
                    Escape::Text
                }
                (Escape::Esc, b'[') => Escape::Csi,
                (Escape::Esc, b']') => Escape::String(true),
                (Escape::Esc, b'P' | b'X' | b'^' | b'_') => Escape::String(false),
                (Escape::Esc, 0x20..=0x2f) => Escape::Intermediate,
                (Escape::Esc, 0x1b) => Escape::Esc,
                (Escape::Esc, _) => Escape::Text,
                (Escape::Intermediate, 0x30..=0x7e) => Escape::Text,
                (Escape::Intermediate, 0x1b) => Escape::Esc,
                (Escape::Intermediate, _) => Escape::Intermediate,
                (Escape::Csi, 0x40..=0x7e) => Escape::Text,
                (Escape::Csi, 0x1b) => Escape::Esc,
                (Escape::Csi, _) => Escape::Csi,
                (Escape::String(true) | Escape::StringEsc(true), 7) => Escape::Text,
                (Escape::String(osc), 0x1b) => Escape::StringEsc(osc),
                (Escape::String(osc), _) => Escape::String(osc),
                (Escape::StringEsc(_), b'\\') => Escape::Text,
                (Escape::StringEsc(osc), 0x1b) => Escape::StringEsc(osc),
                (Escape::StringEsc(osc), _) => Escape::String(osc),
            };
        }
        out
    }
}

pub fn clean_name(name: &str) -> String {
    let mut value = String::new();
    for c in name.chars() {
        let c = if c.is_alphanumeric() || matches!(c, '-' | '_') {
            c
        } else {
            '_'
        };
        if value.len() + c.len_utf8() > 80 {
            break;
        }
        value.push(c);
    }
    if value.is_empty() {
        "Sitzung".into()
    } else {
        value
    }
}
fn create_log(folder: &Path, name: &str, timestamp: &str) -> std::io::Result<(File, PathBuf)> {
    if timestamp.len() != 19
        || !timestamp.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 | 13 | 16 => b == b'-',
            10 => b == b'_',
            _ => b.is_ascii_digit(),
        })
    {
        return Err(std::io::Error::other("Ungültiger Protokollzeitstempel"));
    }
    std::fs::create_dir_all(folder)?;
    let base = format!("{}_{timestamp}", clean_name(name));
    for suffix in 1..=10000 {
        let path = folder.join(if suffix == 1 {
            format!("{base}.log")
        } else {
            format!("{base}_{suffix}.log")
        });
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(file) => return Ok((file, path)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::other("Zu viele gleichnamige Protokolle"))
}
const QUEUE_CAPACITY: usize = 1024;
const FLUSH_INTERVAL: Duration = Duration::from_secs(1);
type Worker = JoinHandle<Result<(), String>>;
struct Log {
    sender: SyncSender<Vec<u8>>,
    aborted: Arc<AtomicBool>,
    worker: Worker,
}
#[derive(Default)]
struct Logs {
    active: HashMap<u32, Log>,
    retired: Vec<Worker>,
}
#[derive(Clone, serde::Serialize)]
struct LogError {
    id: u32,
    message: String,
}
fn report_error(app: &tauri::AppHandle, id: u32, error: impl std::fmt::Display) {
    let _ = app.emit(
        "session-log-error",
        LogError {
            id,
            message: error.to_string(),
        },
    );
}
static LOGS: OnceLock<Mutex<Logs>> = OnceLock::new();
fn logs() -> &'static Mutex<Logs> {
    LOGS.get_or_init(|| Mutex::new(Logs::default()))
}
fn write_stream(
    writer: &mut dyn Write,
    receiver: &Receiver<Vec<u8>>,
    strip: bool,
    aborted: &AtomicBool,
) -> std::io::Result<()> {
    let mut filter = strip.then(AnsiFilter::default);
    let mut deadline = Instant::now() + FLUSH_INTERVAL;
    loop {
        if aborted.load(Ordering::Acquire) {
            return writer.flush();
        }
        match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(data) => {
                let filtered = filter.as_mut().map(|filter| filter.filter(&data));
                writer.write_all(filtered.as_deref().unwrap_or(&data))?;
            }
            Err(RecvTimeoutError::Disconnected) => return writer.flush(),
            Err(RecvTimeoutError::Timeout) => {}
        }
        if Instant::now() >= deadline {
            writer.flush()?;
            deadline = Instant::now() + FLUSH_INTERVAL;
        }
    }
}
fn spawn_writer(
    mut writer: Box<dyn Write + Send>,
    strip: bool,
    capacity: usize,
    on_error: impl FnOnce(String, &Arc<AtomicBool>) + Send + 'static,
) -> Result<Log, String> {
    let (sender, receiver) = mpsc::sync_channel(capacity);
    let aborted = Arc::new(AtomicBool::new(false));
    let token = aborted.clone();
    let worker = std::thread::Builder::new()
        .name("session-log".into())
        .spawn(move || {
            let result = write_stream(&mut *writer, &receiver, strip, &token)
                .map_err(|error| format!("Protokoll gestoppt: {error}"));
            if let Err(error) = &result
                && !token.swap(true, Ordering::AcqRel)
            {
                on_error(error.clone(), &token);
            }
            result
        })
        .map_err(|error| error.to_string())?;
    Ok(Log {
        sender,
        aborted,
        worker,
    })
}
impl Logs {
    fn retire(&mut self, id: u32) -> Option<Worker> {
        self.active.remove(&id).map(|log| {
            drop(log.sender);
            log.worker
        })
    }
    fn enqueue(&mut self, id: u32, data: &[u8]) -> Option<&'static str> {
        let log = self.active.get(&id)?;
        let message = match log.sender.try_send(data.to_vec()) {
            Ok(()) => return None,
            Err(TrySendError::Full(_)) => "Protokoll gestoppt: Ziel zu langsam",
            Err(TrySendError::Disconnected(_)) => "Protokoll gestoppt: Writer beendet",
        };
        log.aborted.store(true, Ordering::Release);
        if let Some(worker) = self.retire(id) {
            self.retired.push(worker);
        }
        Some(message)
    }
    fn reap(&mut self) {
        self.retired.retain(|worker| !worker.is_finished());
    }
}
pub fn output(app: &tauri::AppHandle, id: u32, data: &[u8]) {
    let error = match logs().lock() {
        Ok(mut logs) => logs.enqueue(id, data),
        Err(_) => Some("Protokollsperre beschädigt"),
    };
    if let Some(error) = error {
        report_error(app, id, error);
    }
}
pub fn finish(app: &tauri::AppHandle, id: u32) {
    if let Err(error) = stop(id) {
        report_error(app, id, error);
    }
}
pub fn stop(id: u32) -> Result<(), String> {
    let mut logs = logs().lock().map_err(|_| "Protokollsperre beschädigt")?;
    if let Some(worker) = logs.retire(id) {
        logs.retired.push(worker);
    }
    Ok(())
}
pub fn stop_all() {
    let workers = if let Ok(mut logs) = logs().lock() {
        let active = std::mem::take(&mut logs.active);
        let mut workers = std::mem::take(&mut logs.retired);
        for (_, log) in active {
            drop(log.sender);
            workers.push(log.worker);
        }
        workers
    } else {
        return;
    };
    let deadline = Instant::now() + Duration::from_secs(2);
    while workers.iter().any(|worker| !worker.is_finished()) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    for worker in workers {
        if worker.is_finished() {
            let _ = worker.join();
        }
    }
}
#[tauri::command]
pub async fn session_log_start(
    app: tauri::AppHandle,
    id: u32,
    folder: Option<String>,
    name: String,
    timestamp: String,
    strip: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = match folder.filter(|v| !v.is_empty()) {
            Some(path) => PathBuf::from(path),
            None => app
                .path()
                .document_dir()
                .map_err(|e| e.to_string())?
                .join("Werkterm-Logs"),
        };
        if !folder.is_absolute() {
            return Err("Protokollordner muss ein absoluter Pfad sein".into());
        }
        if logs()
            .lock()
            .map_err(|_| "Protokollsperre beschädigt")?
            .active
            .contains_key(&id)
        {
            return Err("Protokoll läuft bereits".into());
        }
        let (file, path) = create_log(&folder, &name, &timestamp).map_err(|e| e.to_string())?;
        let log = spawn_writer(
            Box::new(BufWriter::new(file)),
            strip,
            QUEUE_CAPACITY,
            move |error, token| {
                if let Ok(mut logs) = logs().lock()
                    && logs
                        .active
                        .get(&id)
                        .is_some_and(|log| Arc::ptr_eq(&log.aborted, token))
                    && let Some(worker) = logs.retire(id)
                {
                    logs.retired.push(worker);
                }
                report_error(&app, id, error);
            },
        )?;
        let mut logs = logs().lock().map_err(|_| "Protokollsperre beschädigt")?;
        logs.reap();
        if logs.active.contains_key(&id) {
            drop(logs);
            drop(log.sender);
            return Err("Protokoll läuft bereits".into());
        }
        logs.active.insert(id, log);
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn session_log_stop(id: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let worker = logs()
            .lock()
            .map_err(|_| "Protokollsperre beschädigt")?
            .retire(id);
        if let Some(worker) = worker {
            worker
                .join()
                .map_err(|_| "Protokoll-Thread abgebrochen".to_string())??;
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn session_log_open_folder(
    app: tauri::AppHandle,
    folder: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_opener::OpenerExt;
        let path = match folder.filter(|v| !v.is_empty()) {
            Some(path) => PathBuf::from(path),
            None => app
                .path()
                .document_dir()
                .map_err(|e| e.to_string())?
                .join("Werkterm-Logs"),
        };
        if !path.is_absolute() {
            return Err("Protokollordner muss ein absoluter Pfad sein".into());
        }
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        let path = path.canonicalize().map_err(|e| e.to_string())?;
        app.opener()
            .open_path(path.to_string_lossy().into_owned(), None::<&str>)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    struct BlockingWriter {
        entered: mpsc::Sender<()>,
        release: Receiver<()>,
    }
    impl Write for BlockingWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.entered.send(()).unwrap();
            self.release.recv().unwrap();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    #[test]
    fn overflow_stops_without_waiting_for_blocked_writer() {
        let (entered, observed) = mpsc::channel();
        let (release, blocked) = mpsc::channel();
        let log = spawn_writer(
            Box::new(BlockingWriter {
                entered,
                release: blocked,
            }),
            false,
            1,
            |error, _| panic!("{error}"),
        )
        .unwrap();
        let mut registry = Logs::default();
        registry.active.insert(1, log);
        assert_eq!(registry.enqueue(1, b"first"), None);
        observed.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(registry.enqueue(1, b"queued"), None);
        // Keep the target blocked until enqueue has returned on another thread.
        let (done, completed) = mpsc::channel();
        let task = std::thread::spawn(move || {
            let start = Instant::now();
            let error = registry.enqueue(1, b"overflow");
            done.send((error, start.elapsed(), registry)).unwrap();
        });
        let result = completed.recv_timeout(Duration::from_secs(1));
        release.send(()).unwrap();
        let (error, elapsed, mut registry) = result.expect("enqueue blocked on file I/O");
        task.join().unwrap();
        assert_eq!(error, Some("Protokoll gestoppt: Ziel zu langsam"));
        assert!(elapsed < Duration::from_secs(1));
        assert!(!registry.active.contains_key(&1));
        assert_eq!(registry.enqueue(1, b"ignored"), None);
        registry.retired.pop().unwrap().join().unwrap().unwrap();
    }
    struct RecordingWriter(Arc<Mutex<Vec<u8>>>);
    impl Write for RecordingWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    #[test]
    fn writer_preserves_order_and_filter_state() {
        for strip in [false, true] {
            let bytes = Arc::new(Mutex::new(Vec::new()));
            let log = spawn_writer(
                Box::new(RecordingWriter(bytes.clone())),
                strip,
                1024,
                |error, _| panic!("{error}"),
            )
            .unwrap();
            let input = "a\x1b[31mGrüße\x1b[0m\r\n\x1b]title\x1b\\z".as_bytes();
            for byte in input {
                log.sender.send(vec![*byte]).unwrap();
            }
            drop(log.sender);
            log.worker.join().unwrap().unwrap();
            assert_eq!(
                *bytes.lock().unwrap(),
                if strip {
                    "aGrüße\nz".as_bytes()
                } else {
                    input
                }
            );
        }
    }
    struct FlushObserver(mpsc::Sender<Instant>);
    impl Write for FlushObserver {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            let _ = self.0.send(Instant::now());
            Ok(())
        }
    }
    #[test]
    fn idle_writer_flushes_before_stop() {
        let (flushed, observed) = mpsc::channel();
        let log = spawn_writer(Box::new(FlushObserver(flushed)), false, 1, |error, _| {
            panic!("{error}")
        })
        .unwrap();
        log.sender.send(b"buffered".to_vec()).unwrap();
        // Sender stays alive: a periodic flush must happen without disconnecting.
        observed.recv_timeout(Duration::from_secs(2)).unwrap();
        drop(log.sender);
        log.worker.join().unwrap().unwrap();
        observed.recv_timeout(Duration::from_secs(1)).unwrap();
    }
    struct FailingWriter;
    impl Write for FailingWriter {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("disk failed"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    #[test]
    fn write_error_reports_and_disconnects() {
        let (errors, received) = mpsc::channel();
        let log = spawn_writer(Box::new(FailingWriter), false, 1, move |error, _| {
            errors.send(error).unwrap();
        })
        .unwrap();
        log.sender.send(vec![1]).unwrap();
        assert_eq!(
            received.recv_timeout(Duration::from_secs(2)).unwrap(),
            "Protokoll gestoppt: disk failed"
        );
        assert!(log.worker.join().unwrap().is_err());
        assert!(matches!(
            log.sender.try_send(vec![2]),
            Err(TrySendError::Disconnected(_))
        ));
    }
    #[test]
    fn filter_chunks() {
        let input = b"a\x1b[31mred\x1b[0m\r\n\t\x1b]7;file://host/path\x07b\x1b]title\x1b\\c\x1bPignored\x1b\\d\x1b(B\x01";
        for split in 0..=input.len() {
            let mut filter = AnsiFilter::default();
            let mut out = filter.filter(&input[..split]);
            out.extend(filter.filter(&input[split..]));
            assert_eq!(out, b"ared\n\tbcd", "split {split}");
        }
        let mut filter = AnsiFilter::default();
        let out: Vec<_> = input.iter().flat_map(|b| filter.filter(&[*b])).collect();
        assert_eq!(out, b"ared\n\tbcd");
        assert_eq!(
            AnsiFilter::default().filter(b"a\x1bPdata\x07still hidden\x1b\\b"),
            b"ab"
        );
        let mut filter = AnsiFilter::default();
        let bytes = "Grüße 🐧".as_bytes();
        let out: Vec<_> = bytes.iter().flat_map(|b| filter.filter(&[*b])).collect();
        assert_eq!(out, bytes);
    }
    #[test]
    fn safe_names() {
        assert_eq!(clean_name("../a\\b:c"), "___a_b_c");
        assert_eq!(clean_name(""), "Sitzung");
        assert_eq!(clean_name(&"a".repeat(100)).len(), 80);
        assert!(clean_name(&"界".repeat(80)).len() <= 80);
    }
    #[test]
    fn collision_and_permissions() {
        let folder = std::env::temp_dir().join(format!(
            "werkterm-log-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let (mut first, a) = create_log(&folder, "CON", "2026-11-07_12-00-00").unwrap();
        first.write_all(b"original").unwrap();
        drop(first);
        let (second, b) = create_log(&folder, "CON", "2026-11-07_12-00-00").unwrap();
        drop(second);
        assert_ne!(a, b);
        assert!(b.to_string_lossy().ends_with("_2.log"));
        assert_eq!(std::fs::read(&a).unwrap(), b"original");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(a).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        for strip in [false, true] {
            let (file, path) = create_log(&folder, "output", "2026-11-07_12-00-00").unwrap();
            let log = spawn_writer(Box::new(BufWriter::new(file)), strip, 16, |error, _| {
                panic!("{error}")
            })
            .unwrap();
            log.sender.send(b"\x1b[3".to_vec()).unwrap();
            log.sender.send("1mGrüße\r\n".as_bytes().to_vec()).unwrap();
            drop(log.sender);
            log.worker.join().unwrap().unwrap();
            assert_eq!(
                std::fs::read(path).unwrap(),
                if strip {
                    "Grüße\n".as_bytes()
                } else {
                    "\x1b[31mGrüße\r\n".as_bytes()
                }
            );
        }
        assert!(create_log(&folder, "x", "../../bad").is_err());
        std::fs::remove_dir_all(folder).unwrap();
    }
}
