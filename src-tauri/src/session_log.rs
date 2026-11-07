use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
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
struct Log {
    writer: BufWriter<File>,
    filter: Option<AnsiFilter>,
}
impl Log {
    fn write(&mut self, data: &[u8]) -> std::io::Result<()> {
        let filtered = self.filter.as_mut().map(|filter| filter.filter(data));
        self.writer.write_all(filtered.as_deref().unwrap_or(data))
    }
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
            message: format!("Protokoll: {error}"),
        },
    );
}
static LOGS: OnceLock<Mutex<HashMap<u32, Log>>> = OnceLock::new();
fn logs() -> &'static Mutex<HashMap<u32, Log>> {
    LOGS.get_or_init(|| Mutex::new(HashMap::new()))
}
static FLUSHER: OnceLock<()> = OnceLock::new();

pub fn output(app: &tauri::AppHandle, id: u32, data: &[u8]) {
    let result = (|| {
        let mut logs = logs()
            .lock()
            .map_err(|_| std::io::Error::other("Protokollsperre beschädigt"))?;
        if let Some(log) = logs.get_mut(&id) {
            log.write(data)?;
        }
        Ok::<_, std::io::Error>(())
    })();
    if let Err(error) = result {
        let _ = stop(id);
        report_error(app, id, error);
    }
}
pub fn finish(app: &tauri::AppHandle, id: u32) {
    if let Err(error) = stop(id) {
        report_error(app, id, error);
    }
}
pub fn stop(id: u32) -> Result<(), String> {
    if let Some(mut log) = logs()
        .lock()
        .map_err(|_| "Protokollsperre beschädigt")?
        .remove(&id)
    {
        log.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn stop_all() {
    if let Ok(mut logs) = logs().lock() {
        for (_, mut log) in logs.drain() {
            let _ = log.writer.flush();
        }
    }
}
#[tauri::command]
pub fn session_log_start(
    app: tauri::AppHandle,
    id: u32,
    folder: Option<String>,
    name: String,
    timestamp: String,
    strip: bool,
) -> Result<String, String> {
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
    let mut logs = logs().lock().map_err(|_| "Protokollsperre beschädigt")?;
    if logs.contains_key(&id) {
        return Err("Protokoll läuft bereits".into());
    }
    let (file, path) = create_log(&folder, &name, &timestamp).map_err(|e| e.to_string())?;
    logs.insert(
        id,
        Log {
            writer: BufWriter::new(file),
            filter: strip.then(AnsiFilter::default),
        },
    );
    FLUSHER.get_or_init(|| {
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(std::time::Duration::from_millis(500));
                if let Ok(mut logs) = self::logs().lock() {
                    logs.retain(|id, log| match log.writer.flush() {
                        Ok(()) => true,
                        Err(error) => {
                            report_error(&app, *id, error);
                            false
                        }
                    });
                }
            }
        });
    });
    Ok(path.to_string_lossy().into_owned())
}
#[tauri::command]
pub fn session_log_stop(id: u32) -> Result<(), String> {
    stop(id)
}

#[tauri::command]
pub fn session_log_open_folder(
    app: tauri::AppHandle,
    folder: Option<String>,
) -> Result<(), String> {
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
}

#[cfg(test)]
mod tests {
    use super::*;
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
            let mut log = Log {
                writer: BufWriter::new(file),
                filter: strip.then(AnsiFilter::default),
            };
            log.write(b"\x1b[3").unwrap();
            log.write("1mGrüße\r\n".as_bytes()).unwrap();
            log.writer.flush().unwrap();
            drop(log);
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
