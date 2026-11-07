pub mod import_mobaxterm;
pub mod import_windterm;

use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

static SERIAL: AtomicU64 = AtomicU64::new(0);
static STORAGE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SessionAuth {
    #[default]
    Default,
    KeyFile {
        path: String,
    },
    Password,
    Ask,
}

fn default_kind() -> String {
    "ssh".into()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSession {
    #[serde(default = "default_kind")]
    pub kind: String,
    pub id: String,
    pub name: String,
    pub folder: String,
    pub host: String,
    pub port: u16,
    pub user: Option<String>,
    pub auth: SessionAuth,
    pub source: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCandidate {
    pub key: String,
    pub name: String,
    pub folder: String,
    pub host: String,
    pub port: u16,
    pub user: Option<String>,
    pub key_path: Option<String>,
    pub one_key: Option<String>,
    pub duplicate_of: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OneKeyRef {
    pub uuid: String,
    pub name: String,
    pub kind: String,
}

#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub candidates: Vec<ImportCandidate>,
    pub one_keys: Vec<OneKeyRef>,
    pub skipped: u32,
    pub warnings: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSelection {
    pub candidate: ImportCandidate,
    pub user: Option<String>,
    pub auth: SessionAuth,
}

#[derive(Serialize, Deserialize)]
struct SessionFile {
    version: u32,
    sessions: Vec<SavedSession>,
}

fn new_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{nanos:x}-{:x}-{:x}",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    )
}

pub fn validate(session: &SavedSession) -> Result<(), String> {
    if session.kind != "ssh" {
        return Err("Unbekannter Sitzungstyp".into());
    }
    if session.name.trim().is_empty() {
        return Err("Sitzungsname darf nicht leer sein".into());
    }
    if session.host.is_empty()
        || session
            .host
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return Err("Host darf nicht leer sein oder Leerzeichen enthalten".into());
    }
    if session.port == 0 {
        return Err("Port muss zwischen 1 und 65535 liegen".into());
    }
    if session
        .source
        .as_deref()
        .is_some_and(|s| s != "mobaxterm" && s != "windterm")
    {
        return Err("Unbekannte Sitzungsquelle".into());
    }
    if matches!(&session.auth, SessionAuth::KeyFile { path } if path.trim().is_empty()) {
        return Err("Schlüsselpfad darf nicht leer sein".into());
    }
    Ok(())
}

pub fn validate_target(
    session: &SavedSession,
    target: &crate::ssh::SshTarget,
) -> Result<(), String> {
    if !session.host.eq_ignore_ascii_case(&target.host)
        || session.port != target.port
        || session
            .user
            .as_ref()
            .is_some_and(|user| user != &target.user)
    {
        return Err("SSH-Ziel stimmt nicht mit der gespeicherten Sitzung überein".into());
    }
    Ok(())
}

pub fn load(path: &Path) -> Result<Vec<SavedSession>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("Sitzungsdatei konnte nicht gelesen werden".into()),
    };
    let file: SessionFile =
        serde_json::from_slice(&bytes).map_err(|_| "Sitzungsdatei ist beschädigt".to_owned())?;
    if file.version != 1 {
        return Err("Sitzungsdatei hat eine unbekannte Version".into());
    }
    let mut ids = std::collections::HashSet::new();
    for session in &file.sessions {
        validate(session)?;
        if session.id.is_empty() || !ids.insert(&session.id) {
            return Err("Sitzungsdatei enthält ungültige IDs".into());
        }
    }
    Ok(file.sessions)
}

fn write_atomic(path: &Path, sessions: Vec<SavedSession>) -> Result<(), String> {
    // Validate existing contents before creating a temporary file: corruption must never be overwritten.
    load(path)?;
    let bytes = serde_json::to_vec_pretty(&SessionFile {
        version: 1,
        sessions,
    })
    .map_err(|_| "Sitzungen konnten nicht serialisiert werden".to_owned())?;
    let parent = path
        .parent()
        .ok_or_else(|| "Ungültiger Sitzungspfad".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|_| "Konfigurationsordner konnte nicht angelegt werden".to_owned())?;
    let temp = parent.join(format!(".sessions-{}.tmp", new_id()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|_| "Sitzungsdatei konnte nicht atomar gespeichert werden".into())
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("sessions.json"))
        .map_err(|_| "Konfigurationsordner konnte nicht ermittelt werden".into())
}

async fn read_file(path: PathBuf) -> Result<Vec<SavedSession>, String> {
    tauri::async_runtime::spawn_blocking(move || load(&path))
        .await
        .map_err(|_| "Sitzungen konnten nicht geladen werden".to_owned())?
}

async fn persist(path: PathBuf, sessions: Vec<SavedSession>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_atomic(&path, sessions))
        .await
        .map_err(|_| "Sitzungen konnten nicht gespeichert werden".to_owned())?
}

pub async fn find(app: &tauri::AppHandle, id: &str) -> Result<SavedSession, String> {
    let _guard = STORAGE_LOCK.lock().await;
    read_file(config_path(app)?)
        .await?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| "Gespeicherte Sitzung wurde nicht gefunden".into())
}

#[tauri::command]
pub async fn sessions_list(app: tauri::AppHandle) -> Result<Vec<SavedSession>, String> {
    let _guard = STORAGE_LOCK.lock().await;
    read_file(config_path(&app)?).await
}

#[tauri::command]
pub async fn sessions_save(
    app: tauri::AppHandle,
    mut session: SavedSession,
    password: Option<String>,
) -> Result<SavedSession, String> {
    validate(&session)?;
    let _guard = STORAGE_LOCK.lock().await;
    let path = config_path(&app)?;
    let mut sessions = read_file(path.clone()).await?;
    if session.id.is_empty() {
        session.id = new_id();
    }
    let previous = sessions.iter().position(|s| s.id == session.id);
    let account = format!("session:{}", session.id);
    let password = password.filter(|value| !value.is_empty());
    if session.auth == SessionAuth::Password && password.is_none() {
        require_existing_password(crate::secrets::get_password(account.clone()).await?)?;
    }
    let change = if session.auth == SessionAuth::Password {
        password.map(SecretChange::Set)
    } else if previous.is_some_and(|index| sessions[index].auth == SessionAuth::Password) {
        Some(SecretChange::Delete)
    } else {
        None
    };
    if let Some(index) = previous {
        sessions[index] = session.clone();
    } else {
        sessions.push(session.clone());
    }
    persist_with_secret(path, sessions, account, change).await?;
    Ok(session)
}

#[tauri::command]
pub async fn sessions_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let _guard = STORAGE_LOCK.lock().await;
    let path = config_path(&app)?;
    let mut sessions = read_file(path.clone()).await?;
    let delete_secret = sessions
        .iter()
        .any(|session| session.id == id && session.auth == SessionAuth::Password);
    sessions.retain(|session| session.id != id);
    persist(path, sessions).await?;
    if delete_secret {
        crate::secrets::delete_password(format!("session:{id}"))
            .await
            .map_err(|error| format!("Sitzung wurde gelöscht; Schlüsselbund: {error}"))?;
    }
    Ok(())
}

enum SecretChange {
    Set(String),
    Delete,
}

fn require_existing_password(password: Option<String>) -> Result<(), String> {
    match password {
        Some(value) if !value.is_empty() => Ok(()),
        _ => Err("Bitte ein Passwort für die Sitzung eingeben".into()),
    }
}

async fn restore_secret(account: String, previous: Option<String>) -> Result<(), String> {
    match previous {
        Some(password) => crate::secrets::set_password(account, password).await,
        None => crate::secrets::delete_password(account).await,
    }
}

// File replacement and the OS store cannot share a transaction. Keep the old
// secret only in memory and compensate when file persistence fails.
async fn persist_with_secret(
    path: PathBuf,
    sessions: Vec<SavedSession>,
    account: String,
    change: Option<SecretChange>,
) -> Result<(), String> {
    let Some(change) = change else {
        return persist(path, sessions).await;
    };
    let previous = crate::secrets::get_password(account.clone()).await?;
    let changed = match change {
        SecretChange::Set(password) => {
            crate::secrets::set_password(account.clone(), password).await
        }
        SecretChange::Delete => crate::secrets::delete_password(account.clone()).await,
    };
    if let Err(error) = changed {
        // A provider may report failure after having partially changed state.
        if restore_secret(account, previous).await.is_err() {
            return Err(format!(
                "{error}; vorheriger Schlüsselbund-Eintrag konnte nicht wiederhergestellt werden"
            ));
        }
        return Err(error);
    }
    persist_or_restore(persist(path, sessions), || {
        restore_secret(account, previous)
    })
    .await
}

async fn persist_or_restore<P, R, F>(persistence: P, restore: R) -> Result<(), String>
where
    P: std::future::Future<Output = Result<(), String>>,
    R: FnOnce() -> F,
    F: std::future::Future<Output = Result<(), String>>,
{
    if let Err(error) = persistence.await {
        if restore().await.is_err() {
            return Err("Sitzungsdatei wurde nicht gespeichert; Schlüsselbund konnte nicht wiederhergestellt werden".into());
        }
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub async fn sessions_keyring_available() -> Result<bool, String> {
    crate::secrets::available().await
}

#[tauri::command]
pub fn sessions_import_default_path(source: String) -> Result<Option<String>, String> {
    match source.as_str() {
        "mobaxterm" => {
            #[cfg(windows)]
            {
                Ok(std::env::var_os("APPDATA").map(|dir| {
                    PathBuf::from(dir)
                        .join("MobaXterm")
                        .join("MobaXterm.ini")
                        .to_string_lossy()
                        .into_owned()
                }))
            }
            #[cfg(not(windows))]
            {
                Ok(None)
            }
        }
        "windterm" => Ok(None),
        _ => Err("Unbekannte Importquelle".into()),
    }
}

pub fn mark_duplicates(preview: &mut ImportPreview, sessions: &[SavedSession]) {
    for candidate in &mut preview.candidates {
        candidate.duplicate_of = sessions
            .iter()
            .find(|session| {
                session.host.to_lowercase() == candidate.host.to_lowercase()
                    && session.port == candidate.port
                    && session.user == candidate.user
            })
            .map(|session| session.id.clone());
    }
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .ok_or_else(|| "Home-Verzeichnis nicht gefunden".into())
}

pub fn expand_home(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        home.to_path_buf()
    } else if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        home.join(rest)
    } else {
        PathBuf::from(path)
    }
}

// Windows-1252 fallback without an extra decoding dependency.
fn decode_ini(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.trim_start_matches('\u{feff}').to_owned();
    }
    const HIGH: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž',
        '\u{8f}', '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}',
        'ž', 'Ÿ',
    ];
    bytes
        .iter()
        .map(|&b| {
            if (0x80..=0x9f).contains(&b) {
                HIGH[(b - 0x80) as usize]
            } else {
                char::from(b)
            }
        })
        .collect()
}

#[tauri::command]
pub async fn sessions_import_preview(
    app: tauri::AppHandle,
    source: String,
    path: String,
) -> Result<ImportPreview, String> {
    let home = home_dir()?;
    let documents = app
        .path()
        .document_dir()
        .unwrap_or_else(|_| home.join("Documents"));
    let mut preview = tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        let bytes =
            fs::read(&path).map_err(|_| "Importdatei konnte nicht gelesen werden".to_owned())?;
        match source.as_str() {
            "mobaxterm" => import_mobaxterm::parse(
                &decode_ini(&bytes),
                &import_mobaxterm::ImportBases {
                    home,
                    app_data: std::env::var_os("APPDATA")
                        .map(PathBuf::from)
                        .unwrap_or_default(),
                    documents,
                },
            ),
            "windterm" => {
                let text = std::str::from_utf8(&bytes)
                    .map_err(|_| "Importdatei ist kein UTF-8".to_owned())?;
                let value: serde_json::Value = import_windterm::parse_json(text)
                    .map_err(|_| "WindTerm-Datei ist beschädigt".to_owned())?;
                let sessions_path = if value.is_object() {
                    let directory = value
                        .get("path")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| "profiles.config enthält keinen Profilpfad".to_owned())?;
                    let directory = expand_home(directory, &home);
                    let directory = if directory.is_absolute() {
                        directory
                    } else {
                        path.parent()
                            .unwrap_or_else(|| Path::new("."))
                            .join(directory)
                    };
                    directory
                        .join(".wind")
                        .join("profiles")
                        .join("default.v10")
                        .join("terminal")
                        .join("user.sessions")
                } else {
                    path
                };
                let text = fs::read_to_string(&sessions_path)
                    .map_err(|_| "WindTerm-Sitzungen konnten nicht gelesen werden".to_owned())?;
                let keys_path = sessions_path.with_file_name("onekeys.config");
                let keys = match fs::read_to_string(keys_path) {
                    Ok(text) => Some(text),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                    Err(_) => return Err("OneKey-Datei konnte nicht gelesen werden".into()),
                };
                import_windterm::parse(&text, keys.as_deref(), &home)
            }
            _ => Err("Unbekannte Importquelle".into()),
        }
    })
    .await
    .map_err(|_| "Importvorschau fehlgeschlagen".to_owned())??;
    let _guard = STORAGE_LOCK.lock().await;
    mark_duplicates(&mut preview, &read_file(config_path(&app)?).await?);
    Ok(preview)
}

fn prepare_import(selections: Vec<ImportSelection>) -> Result<Vec<SavedSession>, String> {
    selections
        .into_iter()
        .map(|selection| {
            let candidate = selection.candidate;
            let source = candidate
                .key
                .split(':')
                .next()
                .filter(|source| *source == "mobaxterm" || *source == "windterm")
                .ok_or_else(|| "Unbekannte Importquelle".to_owned())?
                .to_owned();
            let session = SavedSession {
                kind: default_kind(),
                id: new_id(),
                name: candidate.name,
                folder: candidate.folder,
                host: candidate.host,
                port: candidate.port,
                user: selection.user,
                auth: if selection.auth == SessionAuth::Password {
                    SessionAuth::Ask
                } else {
                    selection.auth
                },
                source: Some(source),
            };
            validate(&session)?;
            Ok(session)
        })
        .collect()
}

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: u32,
    pub skipped_duplicates: u32,
}

fn append_unique_imports(
    sessions: &mut Vec<SavedSession>,
    imported: Vec<SavedSession>,
) -> Result<ImportResult, String> {
    let mut result = ImportResult::default();
    for session in imported {
        let duplicate = sessions.iter().any(|saved| {
            saved.host.to_lowercase() == session.host.to_lowercase()
                && saved.port == session.port
                && saved.user == session.user
        });
        let count = if duplicate {
            &mut result.skipped_duplicates
        } else {
            sessions.push(session);
            &mut result.imported
        };
        *count = count
            .checked_add(1)
            .ok_or_else(|| "Zu viele Importsitzungen".to_owned())?;
    }
    Ok(result)
}

#[tauri::command]
pub async fn sessions_import_commit(
    app: tauri::AppHandle,
    candidates: Vec<ImportSelection>,
) -> Result<ImportResult, String> {
    let imported = prepare_import(candidates)?;
    let _guard = STORAGE_LOCK.lock().await;
    let path = config_path(&app)?;
    let mut sessions = read_file(path.clone()).await?;
    let result = append_unique_imports(&mut sessions, imported)?;
    persist(path, sessions).await?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    #[test]
    fn password_auth_requires_a_real_existing_secret_when_no_replacement_is_given() {
        assert!(super::require_existing_password(None).is_err());
        assert!(super::require_existing_password(Some(String::new())).is_err());
        assert!(super::require_existing_password(Some("existing".into())).is_ok());
    }
    use super::*;
    #[test]
    fn legacy_session_files_default_to_ssh() {
        let mut value = serde_json::to_value(sample()).unwrap();
        value.as_object_mut().unwrap().remove("kind");
        let file: SessionFile =
            serde_json::from_value(serde_json::json!({"version": 1, "sessions": [value]})).unwrap();
        assert_eq!(file.sessions[0].kind, "ssh");
        validate(&file.sessions[0]).unwrap();
        let mut invalid = sample();
        invalid.kind = "local".into();
        assert!(validate(&invalid).is_err());
    }
    fn sample() -> SavedSession {
        SavedSession {
            kind: default_kind(),
            id: "sample".into(),
            name: "Test".into(),
            folder: "Lab/SSH".into(),
            host: "srv1.example.test".into(),
            port: 22,
            user: Some("alice".into()),
            auth: SessionAuth::Password,
            source: None,
        }
    }

    #[tokio::test]
    async fn persistence_failure_restores_secret_without_os_store() {
        let secret = std::cell::RefCell::new(Some("replacement".to_owned()));
        let result = persist_or_restore(std::future::ready(Err("disk failure".into())), || {
            secret.replace(Some("original".to_owned()));
            std::future::ready(Ok(()))
        })
        .await;
        assert_eq!(result.unwrap_err(), "disk failure");
        assert_eq!(secret.borrow().as_deref(), Some("original"));
        persist_or_restore(std::future::ready(Ok(())), || {
            panic!("successful persistence must not restore");
            #[allow(unreachable_code)]
            std::future::ready(Ok(()))
        })
        .await
        .unwrap();
        let error = persist_or_restore(std::future::ready(Err("disk failure".into())), || {
            std::future::ready(Err("private provider text".into()))
        })
        .await
        .unwrap_err();
        assert!(!error.contains("private"));
    }

    #[test]
    fn saved_credentials_are_bound_to_the_saved_target() {
        let mut session = sample();
        assert!(validate_target(&session, &"alice@SRV1.example.test".parse().unwrap()).is_ok());
        for target in [
            "bob@srv1.example.test",
            "alice@srv2.example.test",
            "alice@srv1.example.test:2200",
        ] {
            assert!(validate_target(&session, &target.parse().unwrap()).is_err());
        }
        session.user = None;
        assert!(validate_target(&session, &"bob@srv1.example.test".parse().unwrap()).is_ok());
    }
    #[test]
    fn roundtrip_atomic_and_corruption() {
        let directory = std::env::temp_dir().join(format!("linmoba-test-{}", new_id()));
        let path = directory.join("sessions.json");
        assert!(load(&path).unwrap().is_empty());
        write_atomic(&path, vec![sample()]).unwrap();
        assert_eq!(load(&path).unwrap(), vec![sample()]);
        write_atomic(&path, Vec::new()).unwrap();
        assert!(load(&path).unwrap().is_empty());
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::write(&path, b"broken").unwrap();
        assert!(write_atomic(&path, vec![sample()]).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"broken");
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn validation_and_auth_json() {
        let mut session = sample();
        assert!(validate(&session).is_ok());
        for host in ["", "bad host", "bad\thost"] {
            session.host = host.into();
            assert!(validate(&session).is_err());
        }
        session = sample();
        session.name = "  ".into();
        assert!(validate(&session).is_err());
        session = sample();
        session.port = 0;
        assert!(validate(&session).is_err());
        for auth in [
            SessionAuth::Default,
            SessionAuth::KeyFile {
                path: "key.ppk".into(),
            },
            SessionAuth::Password,
            SessionAuth::Ask,
        ] {
            session.auth = auth;
            let json = serde_json::to_string(&session).unwrap();
            assert_eq!(
                serde_json::from_str::<SavedSession>(&json).unwrap(),
                session
            );
            assert!(!json.contains("passwordValue"));
        }
    }
    #[test]
    fn duplicates_and_import_validation() {
        let candidate = ImportCandidate {
            key: "windterm:test".into(),
            name: "Test".into(),
            folder: String::new(),
            host: "SRV1.example.test".into(),
            port: 22,
            user: Some("alice".into()),
            key_path: None,
            one_key: None,
            duplicate_of: None,
        };
        let mut preview = ImportPreview {
            candidates: vec![candidate.clone()],
            ..Default::default()
        };
        mark_duplicates(&mut preview, &[sample()]);
        assert_eq!(
            preview.candidates[0].duplicate_of.as_deref(),
            Some("sample")
        );
        preview.candidates[0].user = None;
        mark_duplicates(&mut preview, &[sample()]);
        assert!(preview.candidates[0].duplicate_of.is_none());
        let imported = prepare_import(vec![ImportSelection {
            candidate: candidate.clone(),
            user: None,
            auth: SessionAuth::Password,
        }])
        .unwrap();
        assert_eq!(imported[0].auth, SessionAuth::Ask);
        let mut invalid = candidate.clone();
        invalid.port = 0;
        assert!(
            prepare_import(vec![
                ImportSelection {
                    candidate,
                    user: None,
                    auth: SessionAuth::Ask
                },
                ImportSelection {
                    candidate: invalid,
                    user: None,
                    auth: SessionAuth::Ask
                }
            ])
            .is_err()
        );
    }
    #[test]
    fn import_commit_skips_existing_and_batch_duplicates_after_mapping() {
        let mut existing = sample();
        existing.host = "münchen.example.test".into();
        let mut same_target = existing.clone();
        same_target.id = "other".into();
        same_target.host = same_target.host.to_uppercase();
        let mut preview = ImportPreview {
            candidates: vec![ImportCandidate {
                key: "windterm:unicode".into(),
                name: same_target.name.clone(),
                folder: same_target.folder.clone(),
                host: same_target.host.clone(),
                port: same_target.port,
                user: same_target.user.clone(),
                key_path: None,
                one_key: None,
                duplicate_of: None,
            }],
            ..Default::default()
        };
        mark_duplicates(&mut preview, std::slice::from_ref(&existing));
        assert_eq!(
            preview.candidates[0].duplicate_of.as_deref(),
            Some("sample")
        );
        let mut other_user = same_target.clone();
        other_user.user = Some("bob".into());
        let mut other_port = other_user.clone();
        other_port.port = 2200;
        let mut sessions = vec![existing];
        let result = append_unique_imports(
            &mut sessions,
            vec![same_target, other_user.clone(), other_user, other_port],
        )
        .unwrap();
        assert_eq!(
            result,
            ImportResult {
                imported: 2,
                skipped_duplicates: 2
            }
        );
        assert_eq!(sessions.len(), 3);
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!({
                "imported": 2, "skippedDuplicates": 2
            })
        );
    }

    #[test]
    fn windows_1252_and_home() {
        assert_eq!(decode_ini(b"caf\xe9 \x80"), "café €");
        assert_eq!(
            expand_home("~/key", Path::new("home")),
            Path::new("home").join("key")
        );
    }
}
