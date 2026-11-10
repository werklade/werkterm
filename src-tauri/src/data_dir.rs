//! User-selectable data directory for shared configuration (sessions, tunnels, macros,
//! settings, designs, icon sets). The pointer file stays local in app_config_dir;
//! the shared data never includes keyring secrets.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Seek, Write},
    path::{Component, Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, UNIX_EPOCH},
};
use tauri::{Manager, State};

static SERIAL: AtomicU64 = AtomicU64::new(0);
const LIMIT: usize = 1024 * 1024;
const POINTER: &str = "data-location.json";
const FILES: [&str; 4] = [
    "sessions.json",
    "tunnels.json",
    "macros.json",
    "settings.json",
];
const DIRECTORIES: [&str; 2] = ["designs", "icon-sets"];
/// Exact marker the frontend matches to detect a concurrent change of settings.json.
const SETTINGS_CONFLICT: &str = "SETTINGS_CONFLICT";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pointer {
    version: u8,
    // A custom deserializer makes the field mandatory: `null` is an explicit choice.
    #[serde(deserialize_with = "required_option")]
    data_dir: Option<PathBuf>,
}

fn required_option<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<PathBuf>, D::Error> {
    Option::<PathBuf>::deserialize(deserializer)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirStatus {
    configured: bool,
    custom: bool,
    path: String,
    default_path: String,
    reachable: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirInspect {
    exists: bool,
    is_dir: bool,
    writable: bool,
    has_data: bool,
    same_as_current: bool,
}
/// Version stamp of a file as seen by the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stamp {
    modified_ms: u64,
    size: u64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsFile {
    json: String,
    modified_ms: u64,
    size: u64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStamp {
    name: String,
    modified_ms: u64,
    size: u64,
}

fn config(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|_| "Konfigurationsordner konnte nicht ermittelt werden".into())
}

fn validate_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Datenordner muss ein absoluter Pfad sein".into());
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("Datenordner darf kein „..“ enthalten".into());
    }
    Ok(())
}

fn read_limited(path: &Path) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(LIMIT as u64 + 1)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

enum Parsed {
    Valid(Option<PathBuf>),
    UnknownVersion,
    Malformed,
}

fn parse_pointer(bytes: &[u8]) -> Parsed {
    if bytes.len() > LIMIT {
        return Parsed::Malformed;
    }
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return Parsed::Malformed;
    };
    match value.get("version").and_then(serde_json::Value::as_u64) {
        Some(1) => (),
        Some(_) => return Parsed::UnknownVersion,
        None => return Parsed::Malformed,
    }
    match serde_json::from_value::<Pointer>(value) {
        Ok(pointer)
            if pointer
                .data_dir
                .as_deref()
                .is_none_or(|dir| validate_path(dir).is_ok()) =>
        {
            Parsed::Valid(pointer.data_dir)
        }
        _ => Parsed::Malformed,
    }
}

/// `None` = not configured, `Some(None)` = default chosen, `Some(Some(dir))` = custom.
/// Only malformed content is recovered (moved to `.bak`); filesystem errors and unknown
/// versions stay visible so a newer pointer is never destroyed or silently ignored.
fn read_pointer(config: &Path) -> Result<Option<Option<PathBuf>>, String> {
    let path = config.join(POINTER);
    let bytes = match read_limited(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Zeigerdatei konnte nicht gelesen werden: {e}")),
    };
    match parse_pointer(&bytes) {
        Parsed::Valid(dir) => Ok(Some(dir)),
        Parsed::UnknownVersion => Err("Zeigerdatei hat eine unbekannte Version".into()),
        Parsed::Malformed => {
            back_up_pointer(config)?;
            Ok(None)
        }
    }
}

/// Moves the pointer to the first free `data-location.json.bak[.N]`; older backups stay.
fn back_up_pointer(config: &Path) -> Result<(), String> {
    let path = config.join(POINTER);
    let error = |e: std::io::Error| format!("Zeigerdatei konnte nicht gesichert werden: {e}");
    for index in 0..1000 {
        let name = if index == 0 {
            format!("{POINTER}.bak")
        } else {
            format!("{POINTER}.bak.{index}")
        };
        let backup = config.join(name);
        match fs::symlink_metadata(&backup) {
            Ok(_) => continue,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return rename_retrying(&path, &backup).map_err(error);
            }
            Err(e) => return Err(error(e)),
        }
    }
    Err("Zeigerdatei konnte nicht gesichert werden: zu viele Sicherungen".into())
}

fn reset_pointer_at(config: &Path) -> Result<DataDirStatus, String> {
    match fs::symlink_metadata(config.join(POINTER)) {
        Ok(_) => back_up_pointer(config)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(format!("Zeigerdatei konnte nicht gelesen werden: {e}")),
    }
    status_at(config)
}

fn current_at(config: &Path) -> Result<PathBuf, String> {
    Ok(read_pointer(config)?
        .flatten()
        .unwrap_or_else(|| config.to_owned()))
}

fn status_at(config: &Path) -> Result<DataDirStatus, String> {
    let pointer = read_pointer(config)?;
    let configured = pointer.is_some();
    let custom = pointer.flatten();
    Ok(DataDirStatus {
        configured,
        custom: custom.is_some(),
        // The default directory is created on demand and therefore always usable.
        reachable: custom.as_deref().is_none_or(Path::is_dir),
        path: custom
            .as_deref()
            .unwrap_or(config)
            .to_string_lossy()
            .into_owned(),
        default_path: config.to_string_lossy().into_owned(),
    })
}

fn resolve_at(config: &Path) -> Result<PathBuf, String> {
    match read_pointer(config)?.flatten() {
        Some(path) if !path.is_dir() => {
            Err(format!("Datenordner nicht erreichbar: {}", path.display()))
        }
        Some(path) => Ok(path),
        None => Ok(config.to_owned()),
    }
}

/// Effective data directory. A configured but unreachable custom directory is an error,
/// never a silent fallback to the default (that would create divergent data).
pub fn resolve(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    resolve_at(&config(app)?)
}

fn unique(parent: &Path, label: &str) -> PathBuf {
    parent.join(format!(
        ".werkterm-{label}-{}-{}.tmp",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ))
}

fn options() -> fs::OpenOptions {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

fn transient(error: &std::io::Error) -> bool {
    // Sync clients and virus scanners briefly hold the target open on Windows.
    cfg!(windows)
        && (error.kind() == std::io::ErrorKind::PermissionDenied
            || matches!(error.raw_os_error(), Some(32 | 33)))
}

/// `fs::rename` with up to three retries (150 ms apart) on transient Windows sharing errors.
pub(crate) fn rename_retrying(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut attempt = 0;
    loop {
        match fs::rename(from, to) {
            Err(e) if attempt < 3 && transient(&e) => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(150));
            }
            result => return result,
        }
    }
}

/// Returns the metadata of the written version, taken from the closed temporary file
/// (rename keeps size and modification time).
fn atomic(path: &Path, bytes: &[u8]) -> std::io::Result<fs::Metadata> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("Ungültiger Pfad"))?;
    fs::create_dir_all(parent)?;
    let temp = unique(parent, "save");
    let result = (|| {
        let mut file = options().open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        let metadata = fs::metadata(&temp)?;
        rename_retrying(&temp, path)?;
        Ok(metadata)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn writable(path: &Path) -> std::io::Result<()> {
    let probe = unique(path, "probe");
    drop(options().open(&probe)?);
    fs::remove_file(probe)
}

/// Canonicalizes the longest existing ancestor and appends the missing rest, so aliases,
/// symlinks, `\\?\` prefixes and trailing separators compare alike.
fn normalized(path: &Path) -> PathBuf {
    let mut tail = Vec::new();
    let mut current = path;
    loop {
        if let Ok(mut result) = fs::canonicalize(current) {
            result.extend(tail.iter().rev());
            return result;
        }
        match (current.parent(), current.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name.to_owned());
                current = parent;
            }
            _ => return path.components().collect(),
        }
    }
}

fn key(path: &Path) -> Vec<String> {
    normalized(path)
        .components()
        .map(|c| {
            let part = c.as_os_str().to_string_lossy();
            // Windows file systems compare names case-insensitively.
            if cfg!(windows) {
                part.to_lowercase()
            } else {
                part.into_owned()
            }
        })
        .collect()
}

fn same(a: &Path, b: &Path) -> bool {
    key(a) == key(b)
}

/// True if `inner` equals `outer` or lies below it.
fn within(inner: &Path, outer: &Path) -> bool {
    key(inner).starts_with(&key(outer))
}

fn inspect_at(config: &Path, path: &Path) -> Result<DataDirInspect, String> {
    validate_path(path)?;
    let current = current_at(config)?;
    let is_dir = path.is_dir();
    Ok(DataDirInspect {
        exists: path.exists(),
        is_dir,
        writable: is_dir && writable(path).is_ok(),
        has_data: path.join("sessions.json").exists() || path.join("settings.json").exists(),
        same_as_current: same(path, &current),
    })
}

/// Copies regular files and directories; symlinks and special files are skipped,
/// existing targets are never overwritten.
fn copy_entry(source: &Path, target: &Path) -> std::io::Result<()> {
    let metadata = match fs::symlink_metadata(source) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if metadata.is_symlink() {
        return Ok(());
    }
    let existing = match fs::symlink_metadata(target) {
        Ok(m) => Some(m),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };
    if metadata.is_file() {
        if existing.is_some() {
            return Ok(());
        }
        let mut input = fs::File::open(source)?;
        let mut output = match options().open(target) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
            Err(e) => return Err(e),
        };
        let copied = std::io::copy(&mut input, &mut output).and_then(|_| output.sync_all());
        drop(output);
        if let Err(e) = copied {
            let _ = fs::remove_file(target);
            return Err(e);
        }
    } else if metadata.is_dir() {
        match existing {
            Some(m) if m.is_symlink() || !m.is_dir() => return Ok(()),
            Some(_) => (),
            None => fs::create_dir(target)?,
        }
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_entry(&entry.path(), &target.join(entry.file_name()))?;
        }
    }
    Ok(())
}

fn copy_data(source: &Path, target: &Path) -> Result<(), String> {
    if same(source, target) {
        return Ok(());
    }
    if within(target, source) || within(source, target) {
        return Err("Neuer Datenordner darf nicht im bisherigen liegen oder ihn enthalten".into());
    }
    let entries = FILES
        .iter()
        .map(|name| (*name, false))
        .chain(DIRECTORIES.iter().map(|name| (*name, true)));
    for (name, directory) in entries {
        let input = source.join(name);
        let metadata = match fs::symlink_metadata(&input) {
            Ok(metadata) => metadata,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("{name} konnte nicht gelesen werden: {e}")),
        };
        let expected = if directory {
            metadata.is_dir()
        } else {
            metadata.is_file()
        };
        if !metadata.is_symlink() && expected {
            copy_entry(&input, &target.join(name))
                .map_err(|e| format!("{name} konnte nicht kopiert werden: {e}"))?;
        }
    }
    Ok(())
}

fn set_at(
    config: &Path,
    cache: &Path,
    path: Option<PathBuf>,
    copy_current: bool,
) -> Result<DataDirStatus, String> {
    if let Some(path) = &path {
        validate_path(path)?;
    }
    let target = path.as_deref().unwrap_or(config);
    if within(target, cache) {
        return Err("Datenordner darf nicht im App-Cache liegen".into());
    }
    let current = current_at(config)?;
    if !same(target, &current) && (within(target, &current) || within(&current, target)) {
        return Err("Neuer Datenordner darf nicht im bisherigen liegen oder ihn enthalten".into());
    }
    // An unreachable source fails before anything is created at the target.
    let source = if copy_current {
        Some(resolve_at(config)?)
    } else {
        None
    };
    fs::create_dir_all(target)
        .map_err(|e| format!("Datenordner konnte nicht angelegt werden: {e}"))?;
    if !target.is_dir() {
        return Err("Datenordner ist kein Verzeichnis".into());
    }
    writable(target).map_err(|e| format!("Datenordner ist nicht beschreibbar: {e}"))?;
    if let Some(source) = source {
        copy_data(&source, target)?;
    }
    // Choosing the default folder by path is stored as the default.
    let stored = path.filter(|path| !same(path, config));
    let bytes = serde_json::to_vec(&Pointer {
        version: 1,
        data_dir: stored,
    })
    .map_err(|_| "Zeigerdatei konnte nicht serialisiert werden".to_owned())?;
    atomic(&config.join(POINTER), &bytes)
        .map_err(|e| format!("Zeigerdatei konnte nicht gespeichert werden: {e}"))?;
    status_at(config)
}

fn validate_settings(json: &str) -> Result<(), String> {
    if json.len() > LIMIT {
        return Err("Einstellungen sind größer als 1 MiB".into());
    }
    let value = serde_json::from_str::<serde_json::Value>(json)
        .map_err(|_| "Einstellungen sind kein gültiges JSON".to_owned())?;
    if !value.is_object() {
        return Err("Einstellungen müssen ein JSON-Objekt sein".into());
    }
    Ok(())
}

fn stamp(metadata: &fs::Metadata) -> Stamp {
    Stamp {
        modified_ms: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX)),
        size: metadata.len(),
    }
}

/// Content and stamp come from the same handle; a change during reading is retried.
fn load_settings(path: &Path) -> Result<Option<SettingsFile>, String> {
    let error = |e: std::io::Error| format!("Einstellungen konnten nicht gelesen werden: {e}");
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(error(e)),
    };
    for _ in 0..3 {
        let before = stamp(&file.metadata().map_err(error)?);
        if before.size > LIMIT as u64 {
            return Err("Einstellungen sind größer als 1 MiB".into());
        }
        file.rewind().map_err(error)?;
        let mut bytes = Vec::new();
        (&mut file)
            .take(LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(error)?;
        if bytes.len() > LIMIT {
            return Err("Einstellungen sind größer als 1 MiB".into());
        }
        if stamp(&file.metadata().map_err(error)?) != before {
            continue;
        }
        let json =
            String::from_utf8(bytes).map_err(|_| "Einstellungen sind kein gültiges UTF-8")?;
        return Ok(Some(SettingsFile {
            json,
            modified_ms: before.modified_ms,
            size: before.size,
        }));
    }
    Err("Einstellungen ändern sich gerade, erneut laden".into())
}

/// `base == None` expects no file; otherwise the existing file must carry `base`.
fn save_settings(dir: &Path, json: &str, base: Option<Stamp>) -> Result<Stamp, String> {
    validate_settings(json)?;
    let path = dir.join("settings.json");
    let current = match fs::metadata(&path) {
        Ok(metadata) => Some(stamp(&metadata)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("Einstellungen konnten nicht gelesen werden: {e}")),
    };
    if current != base {
        return Err(SETTINGS_CONFLICT.into());
    }
    atomic(&path, json.as_bytes())
        .map(|metadata| stamp(&metadata))
        .map_err(|e| format!("Einstellungen konnten nicht gespeichert werden: {e}"))
}

fn fingerprint_at(dir: &Path) -> Result<Vec<FileStamp>, String> {
    let mut stamps = Vec::new();
    for name in FILES {
        let metadata = match fs::metadata(dir.join(name)) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("{name} konnte nicht gelesen werden: {e}")),
        };
        let Stamp { modified_ms, size } = stamp(&metadata);
        stamps.push(FileStamp {
            name: name.into(),
            modified_ms,
            size,
        });
    }
    Ok(stamps)
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "Datenordner-Vorgang wurde abgebrochen".to_owned())?
}

#[tauri::command]
pub async fn data_dir_status(app: tauri::AppHandle) -> Result<DataDirStatus, String> {
    blocking(move || status_at(&config(&app)?)).await
}

#[tauri::command]
pub async fn data_dir_inspect(
    app: tauri::AppHandle,
    path: String,
) -> Result<DataDirInspect, String> {
    blocking(move || inspect_at(&config(&app)?, Path::new(&path))).await
}

#[tauri::command]
pub async fn data_dir_set(
    app: tauri::AppHandle,
    tunnels: State<'_, Arc<crate::tunnels::TunnelManager>>,
    path: Option<String>,
    copy_current: bool,
) -> Result<DataDirStatus, String> {
    // Lock order as in tunnel_save: tunnel operations first, then storage.
    let _idle = tunnels.idle_guard().await?;
    let _storage = crate::sessions::STORAGE_LOCK.lock().await;
    let _macros = crate::macros::LOCK.lock().await;
    let config = config(&app)?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|_| "App-Cache-Ordner konnte nicht ermittelt werden".to_owned())?;
    blocking(move || set_at(&config, &cache, path.map(PathBuf::from), copy_current)).await
}

/// Backs up an unusable pointer (e.g. unknown version) so the app is "not configured" again.
#[tauri::command]
pub async fn data_dir_reset_pointer(
    app: tauri::AppHandle,
    tunnels: State<'_, Arc<crate::tunnels::TunnelManager>>,
) -> Result<DataDirStatus, String> {
    let _idle = tunnels.idle_guard().await?;
    let _storage = crate::sessions::STORAGE_LOCK.lock().await;
    let _macros = crate::macros::LOCK.lock().await;
    let config = config(&app)?;
    blocking(move || reset_pointer_at(&config)).await
}

#[tauri::command]
pub async fn settings_load(app: tauri::AppHandle) -> Result<Option<SettingsFile>, String> {
    let _storage = crate::sessions::STORAGE_LOCK.lock().await;
    blocking(move || load_settings(&resolve(&app)?.join("settings.json"))).await
}

#[tauri::command]
pub async fn settings_save(
    app: tauri::AppHandle,
    json: String,
    base: Option<Stamp>,
) -> Result<Stamp, String> {
    let _storage = crate::sessions::STORAGE_LOCK.lock().await;
    blocking(move || save_settings(&resolve(&app)?, &json, base)).await
}

#[tauri::command]
pub async fn data_dir_fingerprint(app: tauri::AppHandle) -> Result<Vec<FileStamp>, String> {
    blocking(move || fingerprint_at(&resolve(&app)?)).await
}

/// Non-blocking variant: the exit handlers in lib.rs (tunnels, editor cache) still run.
#[tauri::command]
pub async fn app_restart(app: tauri::AppHandle) {
    app.request_restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "werkterm-data-dir-test-{}-{}",
                std::process::id(),
                SERIAL.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn dir(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::create_dir_all(&path).unwrap();
            path
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write_pointer(config: &Path, path: Option<PathBuf>) {
        atomic(
            &config.join(POINTER),
            &serde_json::to_vec(&Pointer {
                version: 1,
                data_dir: path,
            })
            .unwrap(),
        )
        .unwrap();
    }

    fn no_temp_files(dir: &Path) -> bool {
        fs::read_dir(dir).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")
        })
    }

    #[test]
    fn pointer_states_and_unreachable() {
        let temp = Temp::new();
        let config = temp.dir("config");
        let status = status_at(&config).unwrap();
        assert!(!status.configured && !status.custom && status.reachable);
        assert_eq!(resolve_at(&config).unwrap(), config);

        write_pointer(&config, None);
        let status = status_at(&config).unwrap();
        assert!(status.configured && !status.custom);
        assert_eq!(resolve_at(&config).unwrap(), config);

        let custom = temp.dir("custom");
        write_pointer(&config, Some(custom.clone()));
        let status = status_at(&config).unwrap();
        assert!(status.configured && status.custom && status.reachable);
        assert_eq!(status.path, custom.to_string_lossy());
        assert_eq!(resolve_at(&config).unwrap(), custom);

        fs::remove_dir(&custom).unwrap();
        assert!(
            resolve_at(&config)
                .unwrap_err()
                .starts_with("Datenordner nicht erreichbar:")
        );
        assert!(!status_at(&config).unwrap().reachable);
        // No silent fallback: the pointer stays untouched.
        assert!(config.join(POINTER).exists());

        fs::write(custom, b"file").unwrap();
        assert!(resolve_at(&config).is_err());
    }

    #[test]
    fn pointer_file_has_expected_format() {
        let temp = Temp::new();
        let config = temp.dir("config");
        let custom = temp.dir("custom");
        set_at(&config, &temp.0.join("cache"), Some(custom.clone()), false).unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(config.join(POINTER)).unwrap()).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(value["dataDir"], custom.to_string_lossy().as_ref());
        set_at(&config, &temp.0.join("cache"), None, false).unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(config.join(POINTER)).unwrap()).unwrap();
        assert!(value["dataDir"].is_null());
        assert!(no_temp_files(&config));
    }

    #[test]
    fn broken_pointer_is_backed_up() {
        let temp = Temp::new();
        fs::write(temp.0.join(POINTER), b"broken").unwrap();
        assert!(!status_at(&temp.0).unwrap().configured);
        assert!(!temp.0.join(POINTER).exists());
        assert_eq!(
            fs::read(temp.0.join("data-location.json.bak")).unwrap(),
            b"broken"
        );
        assert_eq!(resolve_at(&temp.0).unwrap(), temp.0);
    }

    #[test]
    fn malformed_pointer_schema_is_not_configured() {
        let temp = Temp::new();
        for (index, invalid) in [
            r#"{"version":1}"#,
            r#"{"dataDir":null}"#,
            r#"{"version":1,"dataDir":"relative"}"#,
            r#"{"version":1,"dataDir":42}"#,
            r#"[]"#,
        ]
        .into_iter()
        .enumerate()
        {
            fs::write(temp.0.join(POINTER), invalid).unwrap();
            assert!(!status_at(&temp.0).unwrap().configured, "{invalid}");
            // Earlier backups are kept, each one goes to the next free name.
            let name = if index == 0 {
                "data-location.json.bak".to_owned()
            } else {
                format!("data-location.json.bak.{index}")
            };
            assert_eq!(fs::read_to_string(temp.0.join(name)).unwrap(), invalid);
        }
        assert_eq!(
            fs::read_to_string(temp.0.join("data-location.json.bak")).unwrap(),
            r#"{"version":1}"#
        );
    }

    #[test]
    fn reset_pointer_backs_up_without_overwriting() {
        let temp = Temp::new();
        let status = reset_pointer_at(&temp.0).unwrap();
        assert!(!status.configured);
        fs::write(temp.0.join("data-location.json.bak"), b"older").unwrap();
        let newer = r#"{"version":2,"dataDir":null}"#;
        fs::write(temp.0.join(POINTER), newer).unwrap();
        assert!(status_at(&temp.0).is_err());
        let status = reset_pointer_at(&temp.0).unwrap();
        assert!(!status.configured && !status.custom && status.reachable);
        assert!(!temp.0.join(POINTER).exists());
        assert_eq!(
            fs::read(temp.0.join("data-location.json.bak")).unwrap(),
            b"older"
        );
        assert_eq!(
            fs::read_to_string(temp.0.join("data-location.json.bak.1")).unwrap(),
            newer
        );
        assert_eq!(resolve_at(&temp.0).unwrap(), temp.0);
    }

    #[test]
    fn unknown_pointer_version_is_kept_and_reported() {
        let temp = Temp::new();
        let newer = r#"{"version":2,"dataDir":null}"#;
        fs::write(temp.0.join(POINTER), newer).unwrap();
        assert!(resolve_at(&temp.0).is_err());
        assert!(status_at(&temp.0).is_err());
        assert_eq!(fs::read_to_string(temp.0.join(POINTER)).unwrap(), newer);
        assert!(!temp.0.join("data-location.json.bak").exists());
    }

    #[test]
    fn copy_preserves_existing_and_nested_data() {
        let temp = Temp::new();
        let source = temp.dir("source");
        let target = temp.dir("target");
        fs::create_dir_all(source.join("designs").join("nested")).unwrap();
        fs::create_dir_all(source.join("icon-sets").join("set")).unwrap();
        fs::create_dir_all(target.join("designs")).unwrap();
        fs::write(source.join("sessions.json"), b"source").unwrap();
        fs::write(source.join("tunnels.json"), b"tunnels").unwrap();
        fs::write(source.join("recent.json"), b"local").unwrap();
        fs::write(target.join("sessions.json"), b"target").unwrap();
        fs::write(source.join("designs").join("a.json"), b"source-a").unwrap();
        fs::write(target.join("designs").join("a.json"), b"target-a").unwrap();
        fs::write(
            source.join("designs").join("nested").join("theme.json"),
            b"theme",
        )
        .unwrap();
        fs::write(
            source.join("icon-sets").join("set").join("icon.svg"),
            b"svg",
        )
        .unwrap();

        copy_data(&source, &target).unwrap();

        assert_eq!(fs::read(target.join("sessions.json")).unwrap(), b"target");
        assert_eq!(fs::read(target.join("tunnels.json")).unwrap(), b"tunnels");
        assert_eq!(
            fs::read(target.join("designs").join("a.json")).unwrap(),
            b"target-a"
        );
        assert_eq!(
            fs::read(target.join("designs").join("nested").join("theme.json")).unwrap(),
            b"theme"
        );
        assert_eq!(
            fs::read(target.join("icon-sets").join("set").join("icon.svg")).unwrap(),
            b"svg"
        );
        assert!(!target.join("recent.json").exists());
        assert_eq!(fs::read(source.join("sessions.json")).unwrap(), b"source");
        assert_eq!(
            fs::read(source.join("designs").join("a.json")).unwrap(),
            b"source-a"
        );
    }

    #[test]
    fn set_with_copy_keeps_existing_target_files() {
        let temp = Temp::new();
        let config = temp.dir("config");
        let target = temp.dir("target");
        fs::write(config.join("sessions.json"), b"local").unwrap();
        fs::write(config.join("macros.json"), b"macros").unwrap();
        fs::write(target.join("sessions.json"), b"shared").unwrap();
        let status = set_at(&config, &temp.0.join("cache"), Some(target.clone()), true).unwrap();
        assert!(status.custom && status.reachable);
        assert_eq!(fs::read(target.join("sessions.json")).unwrap(), b"shared");
        assert_eq!(fs::read(target.join("macros.json")).unwrap(), b"macros");
        assert_eq!(fs::read(config.join("sessions.json")).unwrap(), b"local");
        assert_eq!(resolve_at(&config).unwrap(), target);
        assert!(no_temp_files(&target));
    }

    #[cfg(unix)]
    #[test]
    fn copy_skips_symlinks() {
        let temp = Temp::new();
        let source = temp.dir("source");
        let target = temp.dir("target");
        let outside = temp.dir("outside");
        fs::write(outside.join("secret"), b"secret").unwrap();
        fs::create_dir(source.join("designs")).unwrap();
        std::os::unix::fs::symlink(&outside, source.join("designs").join("link")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret"), source.join("macros.json")).unwrap();
        std::os::unix::fs::symlink(&outside, source.join("icon-sets")).unwrap();
        copy_data(&source, &target).unwrap();
        assert!(target.join("designs").is_dir());
        assert!(fs::symlink_metadata(target.join("designs").join("link")).is_err());
        assert!(fs::symlink_metadata(target.join("macros.json")).is_err());
        assert!(fs::symlink_metadata(target.join("icon-sets")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn written_files_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let temp = Temp::new();
        save_settings(&temp.0, "{}", None).unwrap();
        let mode = fs::metadata(temp.0.join("settings.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn relative_and_parent_paths_rejected() {
        let temp = Temp::new();
        let cache = temp.0.join("cache");
        assert!(inspect_at(&temp.0, Path::new("relative")).is_err());
        assert!(inspect_at(&temp.0, Path::new("")).is_err());
        assert!(set_at(&temp.0, &cache, Some(PathBuf::from("relative")), false).is_err());
        assert!(set_at(&temp.0, &cache, Some(PathBuf::from("")), false).is_err());
        let parent = temp.0.join("a").join("..").join("b");
        assert!(set_at(&temp.0, &cache, Some(parent), false).is_err());
        assert!(!temp.0.join(POINTER).exists());
        assert!(!temp.0.join("relative").exists());
    }

    #[test]
    fn cache_targets_rejected() {
        let temp = Temp::new();
        let config = temp.dir("config");
        let cache = temp.dir("cache");
        for target in [cache.clone(), cache.join("editor"), cache.join("new")] {
            assert_eq!(
                set_at(&config, &cache, Some(target.clone()), false).unwrap_err(),
                "Datenordner darf nicht im App-Cache liegen"
            );
        }
        assert!(!cache.join("new").exists());
        assert!(!config.join(POINTER).exists());
    }

    #[test]
    fn nested_targets_rejected() {
        let temp = Temp::new();
        let config = temp.dir("config");
        let cache = temp.0.join("cache");
        fs::create_dir_all(config.join("designs")).unwrap();
        fs::write(config.join("designs").join("theme.json"), b"theme").unwrap();
        // Target inside the current data folder and the other way round.
        for target in [config.join("designs").join("destination"), temp.0.clone()] {
            assert!(set_at(&config, &cache, Some(target), true).is_err());
        }
        assert!(!config.join("designs").join("destination").exists());
        assert!(!config.join(POINTER).exists());
        // copy_data guards on its own as well.
        let nested = config.join("designs").join("inner");
        assert!(copy_data(&config, &nested).is_err());
        assert!(!nested.exists());
    }

    #[test]
    fn unreachable_current_dir_still_allows_switch_without_copy() {
        let temp = Temp::new();
        let config = temp.dir("config");
        let cache = temp.0.join("cache");
        write_pointer(&config, Some(temp.0.join("gone")));
        let target = temp.0.join("fresh");
        assert!(
            set_at(&config, &cache, Some(target.clone()), true)
                .unwrap_err()
                .starts_with("Datenordner nicht erreichbar:")
        );
        assert!(!target.exists());
        let status = set_at(&config, &cache, Some(target.clone()), false).unwrap();
        assert!(status.custom && status.reachable && target.is_dir());
        let status = set_at(&config, &cache, None, false).unwrap();
        assert!(status.configured && !status.custom);
    }

    #[test]
    fn default_path_by_name_is_stored_as_default() {
        let temp = Temp::new();
        let config = temp.dir("config");
        let mut spelled = config.as_os_str().to_owned();
        spelled.push(std::path::MAIN_SEPARATOR_STR);
        let status = set_at(&config, &temp.0.join("cache"), Some(spelled.into()), false).unwrap();
        assert!(status.configured && !status.custom);
    }

    #[test]
    fn same_as_current_ignores_trailing_separator_and_case() {
        let temp = Temp::new();
        let config = temp.dir("config");
        let custom = temp.dir("Custom");
        write_pointer(&config, Some(custom.clone()));
        let mut spelled = custom.as_os_str().to_owned();
        spelled.push(std::path::MAIN_SEPARATOR_STR);
        assert!(
            inspect_at(&config, Path::new(&spelled))
                .unwrap()
                .same_as_current
        );
        #[cfg(windows)]
        {
            let lower = PathBuf::from(custom.to_string_lossy().to_lowercase());
            assert!(inspect_at(&config, &lower).unwrap().same_as_current);
            let missing = temp.0.join("Missing").join("Dir");
            let lower = PathBuf::from(missing.to_string_lossy().to_lowercase());
            assert!(same(&missing, &lower));
        }
        assert!(!inspect_at(&config, &config).unwrap().same_as_current);
    }

    #[test]
    fn inspect_reports_directory_state() {
        let temp = Temp::new();
        let config = temp.dir("config");
        let missing = inspect_at(&config, &temp.0.join("missing")).unwrap();
        assert!(!missing.exists && !missing.is_dir && !missing.writable && !missing.has_data);
        let data = temp.dir("data");
        fs::write(data.join("settings.json"), b"{}").unwrap();
        let found = inspect_at(&config, &data).unwrap();
        assert!(found.exists && found.is_dir && found.writable && found.has_data);
        assert!(no_temp_files(&data));
        let file = temp.0.join("file");
        fs::write(&file, b"x").unwrap();
        let file = inspect_at(&config, &file).unwrap();
        assert!(file.exists && !file.is_dir && !file.writable);
    }

    #[test]
    fn settings_limits_and_object_validation() {
        assert!(validate_settings("{}").is_ok());
        for invalid in ["[]", "null", "42", "\"text\"", "broken", ""] {
            assert!(validate_settings(invalid).is_err(), "{invalid}");
        }
        assert!(validate_settings(&" ".repeat(LIMIT + 1)).is_err());
        let temp = Temp::new();
        let path = temp.0.join("settings.json");
        assert!(load_settings(&path).unwrap().is_none());
        assert!(save_settings(&temp.0, "[]", None).is_err());
        assert!(!path.exists());
        let first = save_settings(&temp.0, r#"{"theme":"dark"}"#, None).unwrap();
        assert_eq!(
            load_settings(&path).unwrap().unwrap().json,
            r#"{"theme":"dark"}"#
        );
        save_settings(&temp.0, r#"{"theme":"light"}"#, Some(first)).unwrap();
        assert_eq!(
            load_settings(&path).unwrap().unwrap().json,
            r#"{"theme":"light"}"#
        );
        assert!(no_temp_files(&temp.0));
        fs::write(&path, vec![b' '; LIMIT + 1]).unwrap();
        assert!(load_settings(&path).is_err());
        fs::write(&path, [0xff, 0xfe]).unwrap();
        assert!(load_settings(&path).is_err());
    }

    fn loaded_stamp(path: &Path) -> Stamp {
        let file = load_settings(path).unwrap().unwrap();
        Stamp {
            modified_ms: file.modified_ms,
            size: file.size,
        }
    }

    #[test]
    fn settings_save_detects_conflicts() {
        let temp = Temp::new();
        let path = temp.0.join("settings.json");
        // No file and base null: allowed; the returned stamp matches settings_load.
        let first = save_settings(&temp.0, r#"{"a":1}"#, None).unwrap();
        assert_eq!(loaded_stamp(&path), first);
        assert_eq!(first.size, 7);
        // File exists but base null: conflict, file unchanged.
        assert_eq!(
            save_settings(&temp.0, r#"{"b":2}"#, None).unwrap_err(),
            SETTINGS_CONFLICT
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), r#"{"a":1}"#);
        // Matching base: saved, new stamp again matches settings_load.
        let second = save_settings(&temp.0, r#"{"a":1,"b":2}"#, Some(first)).unwrap();
        assert_eq!(loaded_stamp(&path), second);
        assert_ne!(second, first);
        // Outdated base: conflict, file unchanged.
        assert_eq!(
            save_settings(&temp.0, r#"{"c":3}"#, Some(first)).unwrap_err(),
            SETTINGS_CONFLICT
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), r#"{"a":1,"b":2}"#);
        // Base set but file gone: conflict, nothing created.
        fs::remove_file(&path).unwrap();
        assert_eq!(
            save_settings(&temp.0, r#"{"c":3}"#, Some(second)).unwrap_err(),
            SETTINGS_CONFLICT
        );
        assert!(!path.exists());
        // Validation errors stay German messages, not the conflict marker.
        let invalid = save_settings(&temp.0, "[]", Some(second)).unwrap_err();
        assert_ne!(invalid, SETTINGS_CONFLICT);
        assert!(no_temp_files(&temp.0));
    }

    #[test]
    fn stamp_json_shape_is_camel_case() {
        let value = serde_json::to_value(Stamp {
            modified_ms: 5,
            size: 2,
        })
        .unwrap();
        assert_eq!(value, serde_json::json!({"modifiedMs": 5, "size": 2}));
        let base: Option<Stamp> =
            serde_json::from_value(serde_json::json!({"modifiedMs": 5, "size": 2})).unwrap();
        assert_eq!(base.map(|b| b.modified_ms), Some(5));
        let file = serde_json::to_value(SettingsFile {
            json: "{}".into(),
            modified_ms: 1,
            size: 2,
        })
        .unwrap();
        assert_eq!(
            file,
            serde_json::json!({"json": "{}", "modifiedMs": 1, "size": 2})
        );
    }

    #[test]
    fn rename_retrying_moves_and_reports_errors() {
        let temp = Temp::new();
        let from = temp.0.join("from");
        let to = temp.0.join("to");
        fs::write(&from, b"x").unwrap();
        fs::write(&to, b"old").unwrap();
        rename_retrying(&from, &to).unwrap();
        assert_eq!(fs::read(&to).unwrap(), b"x");
        assert!(!from.exists());
        assert_eq!(
            rename_retrying(&from, &to).unwrap_err().kind(),
            std::io::ErrorKind::NotFound
        );
    }

    #[test]
    fn fingerprint_lists_existing_files_only() {
        let temp = Temp::new();
        fs::write(temp.0.join("sessions.json"), b"12345").unwrap();
        fs::write(temp.0.join("recent.json"), b"x").unwrap();
        let stamps = fingerprint_at(&temp.0).unwrap();
        assert_eq!(stamps.len(), 1);
        assert_eq!(stamps[0].name, "sessions.json");
        assert_eq!(stamps[0].size, 5);
        assert!(stamps[0].modified_ms > 0);
    }
}
