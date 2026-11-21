pub mod folders;
pub mod import_mobaxterm;
pub mod import_windterm;
pub mod recent;

use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

use crate::ui_error::{ui_code, ui_err};

static SERIAL: AtomicU64 = AtomicU64::new(0);
pub(crate) static STORAGE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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

fn default_telnet_port() -> u16 {
    23
}

fn default_kind() -> String {
    "ssh".into()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSession {
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serial: Option<crate::serial::SerialConfig>,
    pub id: String,
    pub name: String,
    pub folder: String,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_telnet_port")]
    pub port: u16,
    pub user: Option<String>,
    #[serde(default)]
    pub auth: SessionAuth,
    pub source: Option<String>,
    #[serde(default = "default_keepalive_interval")]
    pub keepalive_interval: u32,
    #[serde(default = "default_keepalive_max")]
    pub keepalive_max: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jump_session_id: Option<String>,
    #[serde(default, rename = "log_always", alias = "logAlways")]
    pub log_always: bool,
    /// OpenSSH-style options (`Key=Value` per line), see `crate::ssh::options`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub ssh_options: String,
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
    #[serde(skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub gateways: std::collections::HashMap<String, ImportGateway>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImportGateway {
    pub host: String,
    pub port: u16,
    pub user: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSelection {
    pub candidate: ImportCandidate,
    #[serde(default)]
    pub gateway: Option<ImportGateway>,
    pub user: Option<String>,
    pub auth: SessionAuth,
}

#[derive(Serialize, Deserialize)]
struct SessionFile {
    version: u32,
    sessions: Vec<SavedSession>,
    /// Empty folders (paths without a session). Optional, so the file stays version 1: older
    /// versions ignore the field, and a file without it has no empty folders.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    folders: Vec<String>,
}

pub(crate) fn new_id() -> String {
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

pub fn default_keepalive_interval() -> u32 {
    30
}
pub fn default_keepalive_max() -> u32 {
    3
}
pub fn validate(session: &SavedSession) -> Result<(), String> {
    if session.keepalive_interval > 3600 || !(1..=100).contains(&session.keepalive_max) {
        return Err(ui_err("SESSION_KEEPALIVE_RANGE").into());
    }
    if !matches!(session.kind.as_str(), "ssh" | "telnet" | "serial") {
        return Err(ui_err("SESSION_UNKNOWN_KIND").into());
    }
    if session.name.trim().is_empty() {
        return Err(ui_err("SESSION_NAME_EMPTY").into());
    }
    if session.kind != "ssh" {
        if session.auth != SessionAuth::Default
            || session.jump_session_id.is_some()
            || !session.ssh_options.is_empty()
        {
            return Err(ui_err("SESSION_SSH_ONLY_OPTIONS").into());
        }
        if session.kind == "serial" {
            return session
                .serial
                .as_ref()
                .ok_or(ui_code("SESSION_SERIAL_MISSING"))?
                .validate();
        }
    }
    if session.host.is_empty()
        || session
            .host
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return Err(ui_err("SESSION_HOST_INVALID").into());
    }
    if session.port == 0 {
        return Err(ui_err("SESSION_PORT_INVALID").into());
    }
    if session
        .source
        .as_deref()
        .is_some_and(|s| s != "mobaxterm" && s != "windterm")
    {
        return Err(ui_err("SESSION_UNKNOWN_SOURCE").into());
    }
    if matches!(&session.auth, SessionAuth::KeyFile { path } if path.trim().is_empty()) {
        return Err(ui_err("SESSION_KEY_PATH_EMPTY").into());
    }
    crate::ssh::options::parse(&session.ssh_options)?;
    Ok(())
}

/// Resolve gateways in connection order, excluding the destination itself.
/// Five gateways are allowed; the destination is not counted as a hop.
pub fn resolve_jump_chain<'a>(
    session: &SavedSession,
    sessions: &'a [SavedSession],
) -> Result<Vec<&'a SavedSession>, String> {
    let mut seen = std::collections::HashSet::from([session.id.as_str()]);
    let mut next = session.jump_session_id.as_deref();
    let mut chain = Vec::new();
    while let Some(id) = next {
        if !seen.insert(id) {
            return Err(ui_err("JUMP_CYCLE").into());
        }
        let hop = sessions
            .iter()
            .find(|s| s.id == id)
            .ok_or_else(|| String::from(ui_err("JUMP_NOT_FOUND")))?;
        if hop.kind != "ssh" {
            return Err(ui_err("JUMP_NOT_SSH").arg("name", &hop.name).into());
        }
        chain.push(hop);
        if chain.len() > 5 {
            return Err(ui_err("JUMP_TOO_MANY").arg("max", "5").into());
        }
        next = hop.jump_session_id.as_deref();
    }
    chain.reverse();
    Ok(chain)
}

pub fn validate_jump_hosts(sessions: &[SavedSession]) -> Result<(), String> {
    for session in sessions {
        resolve_jump_chain(session, sessions)?;
    }
    Ok(())
}

pub fn validate_delete(id: &str, sessions: &[SavedSession]) -> Result<(), String> {
    let names: Vec<_> = sessions
        .iter()
        .filter(|s| {
            s.jump_session_id.as_deref() == Some(id)
                || resolve_jump_chain(s, sessions)
                    .is_ok_and(|chain| chain.iter().any(|hop| hop.id == id))
        })
        .map(|s| s.name.as_str())
        .collect();
    if names.is_empty() {
        Ok(())
    } else {
        Err(ui_err("SESSION_USED_AS_JUMP")
            .arg("names", names.join(", "))
            .into())
    }
}

pub fn validate_target(
    session: &SavedSession,
    target: &crate::ssh::SshTarget,
) -> Result<(), String> {
    if session.kind != "ssh" {
        return Err(ui_err("SESSION_NOT_SSH").into());
    }
    if !session.host.eq_ignore_ascii_case(&target.host)
        || session.port != target.port
        || session
            .user
            .as_ref()
            .is_some_and(|user| user != &target.user)
    {
        return Err(ui_err("SESSION_TARGET_MISMATCH").into());
    }
    Ok(())
}

pub fn load(path: &Path) -> Result<Vec<SavedSession>, String> {
    load_file(path).map(|file| file.sessions)
}

/// Reads and validates the whole file. The empty-folder list is normalised, invalid entries are
/// dropped instead of failing the load.
fn load_file(path: &Path) -> Result<SessionFile, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SessionFile {
                version: 1,
                sessions: Vec::new(),
                folders: Vec::new(),
            });
        }
        Err(error) => return Err(ui_err("SESSIONS_READ_FAILED").detail(error).into()),
    };
    let file: SessionFile = serde_json::from_slice(&bytes)
        .map_err(|error| String::from(ui_err("SESSIONS_CORRUPT").json_position(&error)))?;
    if file.version != 1 {
        return Err(ui_err("SESSIONS_UNKNOWN_VERSION").into());
    }
    let mut ids = std::collections::HashSet::new();
    for session in &file.sessions {
        validate(session)?;
        if session.id.is_empty() || !ids.insert(&session.id) {
            return Err(ui_err("SESSIONS_INVALID_IDS").into());
        }
    }
    validate_jump_hosts(&file.sessions)?;
    let folders = folders::normalize_list(&file.sessions, &file.folders);
    Ok(SessionFile { folders, ..file })
}

fn write_atomic(path: &Path, sessions: Vec<SavedSession>) -> Result<(), String> {
    write_file(path, sessions, None)
}

/// `folders == None` keeps the empty folders already stored (normalised against the new sessions).
fn write_file(
    path: &Path,
    sessions: Vec<SavedSession>,
    folders: Option<Vec<String>>,
) -> Result<(), String> {
    // Validate existing contents before creating a temporary file: corruption must never be overwritten.
    let existing = load_file(path)?;
    validate_jump_hosts(&sessions)?;
    let folders = folders::normalize_list(&sessions, &folders.unwrap_or(existing.folders));
    let bytes = serde_json::to_vec_pretty(&SessionFile {
        version: 1,
        sessions,
        folders,
    })
    .map_err(|error| String::from(ui_err("SESSIONS_SERIALIZE_FAILED").detail(error)))?;
    let parent = path
        .parent()
        .ok_or_else(|| String::from(ui_err("INVALID_PATH")))?;
    fs::create_dir_all(parent)
        .map_err(|error| String::from(ui_err("CONFIG_DIR_CREATE_FAILED").detail(error)))?;
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
        crate::data_dir::rename_retrying(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|error| ui_err("SESSIONS_SAVE_FAILED").detail(error).into())
}

pub(crate) fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::data_dir::resolve(app).map(|dir| dir.join("sessions.json"))
}

async fn read_file(path: PathBuf) -> Result<Vec<SavedSession>, String> {
    tauri::async_runtime::spawn_blocking(move || load(&path))
        .await
        .map_err(|error| String::from(ui_err("BACKGROUND_TASK_FAILED").detail(error)))?
}

async fn persist(path: PathBuf, sessions: Vec<SavedSession>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_atomic(&path, sessions))
        .await
        .map_err(|error| String::from(ui_err("BACKGROUND_TASK_FAILED").detail(error)))?
}

pub async fn find(app: &tauri::AppHandle, id: &str) -> Result<SavedSession, String> {
    let _guard = STORAGE_LOCK.lock().await;
    read_file(config_path(app)?)
        .await?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| ui_err("SESSION_NOT_FOUND").into())
}

pub async fn jump_chain(
    app: &tauri::AppHandle,
    session: &SavedSession,
) -> Result<Vec<SavedSession>, String> {
    let _guard = STORAGE_LOCK.lock().await;
    let sessions = read_file(config_path(app)?).await?;
    Ok(resolve_jump_chain(session, &sessions)?
        .into_iter()
        .cloned()
        .collect())
}

#[tauri::command]
pub async fn sessions_list(app: tauri::AppHandle) -> Result<Vec<SavedSession>, String> {
    let _guard = STORAGE_LOCK.lock().await;
    read_file(config_path(&app)?).await
}

/// Empty folders (folders that hold sessions follow from the sessions themselves).
#[tauri::command]
pub async fn sessions_folders(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let _guard = STORAGE_LOCK.lock().await;
    let path = config_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || load_file(&path).map(|file| file.folders))
        .await
        .map_err(|error| String::from(ui_err("BACKGROUND_TASK_FAILED").detail(error)))?
}

/// Reads the file, applies `change` and writes the result once, atomically. Nothing is written
/// when the change reports no difference or fails.
fn change_layout_at<F>(path: &Path, change: F) -> Result<folders::LayoutChange, String>
where
    F: FnOnce(&mut Vec<SavedSession>, &mut Vec<String>) -> Result<folders::LayoutChange, String>,
{
    let mut file = load_file(path)?;
    let result = change(&mut file.sessions, &mut file.folders)?;
    if result.changed {
        write_file(path, file.sessions, Some(file.folders))?;
    }
    Ok(result)
}

async fn change_layout<F>(
    app: &tauri::AppHandle,
    change: F,
) -> Result<folders::LayoutChange, String>
where
    F: FnOnce(&mut Vec<SavedSession>, &mut Vec<String>) -> Result<folders::LayoutChange, String>
        + Send
        + 'static,
{
    let _guard = STORAGE_LOCK.lock().await;
    let path = config_path(app)?;
    tauri::async_runtime::spawn_blocking(move || change_layout_at(&path, change))
        .await
        .map_err(|error| String::from(ui_err("BACKGROUND_TASK_FAILED").detail(error)))?
}

/// Moves sessions into a folder (`""` = top level). Returns the snapshot for undo.
#[tauri::command]
pub async fn sessions_move(
    app: tauri::AppHandle,
    ids: Vec<String>,
    folder: String,
) -> Result<folders::LayoutChange, String> {
    change_layout(&app, move |sessions, list| {
        folders::move_sessions(sessions, list, &ids, &folder)
    })
    .await
}

/// Renames or moves a folder with everything below it.
#[tauri::command]
pub async fn sessions_rename_folder(
    app: tauri::AppHandle,
    from: String,
    to: String,
) -> Result<folders::LayoutChange, String> {
    change_layout(&app, move |sessions, list| {
        folders::rename_folder(sessions, list, &from, &to)
    })
    .await
}

/// Undo of a move or rename: restores the folders of a snapshot in one write.
#[tauri::command]
pub async fn sessions_restore_layout(
    app: tauri::AppHandle,
    layout: folders::LayoutSnapshot,
) -> Result<folders::LayoutChange, String> {
    change_layout(&app, move |sessions, list| {
        folders::restore(sessions, list, &layout)
    })
    .await
}

#[tauri::command]
pub async fn sessions_create_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    change_layout(&app, move |sessions, list| {
        folders::create_folder(sessions, list, &path).map(|()| folders::LayoutChange {
            changed: true,
            ..Default::default()
        })
    })
    .await
    .map(drop)
}

#[tauri::command]
pub async fn sessions_remove_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    change_layout(&app, move |sessions, list| {
        folders::remove_folder(sessions, list, &path).map(|()| folders::LayoutChange {
            changed: true,
            ..Default::default()
        })
    })
    .await
    .map(drop)
}

#[tauri::command]
pub async fn sessions_save(
    app: tauri::AppHandle,
    mut session: SavedSession,
    password: Option<String>,
) -> Result<SavedSession, String> {
    if session.kind != "ssh" {
        session.auth = SessionAuth::Default;
        if password.as_ref().is_some_and(|value| !value.is_empty()) {
            return Err(ui_err("SESSION_PASSWORD_SSH_ONLY").into());
        }
    }
    validate(&session)?;
    let _guard = STORAGE_LOCK.lock().await;
    let path = config_path(&app)?;
    let mut sessions = read_file(path.clone()).await?;
    if session.id.is_empty() {
        session.id = new_id();
    }
    let previous = sessions.iter().position(|s| s.id == session.id);
    protect_kind_change(&session, &sessions, || {
        crate::tunnels::protect_session(&app, &session.id)
    })?;
    let mut proposed = sessions.clone();
    proposed.retain(|s| s.id != session.id);
    proposed.push(session.clone());
    validate_jump_hosts(&proposed)?;
    let account = format!("session:{}", session.id);
    let password = password.filter(|value| !value.is_empty());
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
    validate_delete(&id, &sessions)?;
    crate::tunnels::protect_session(&app, &id)?;
    let delete_secret = sessions.iter().any(|session| session.id == id);
    sessions.retain(|session| session.id != id);
    persist(path, sessions).await?;
    if delete_secret {
        crate::secrets::delete_password(format!("session:{id}"))
            .await
            .map_err(|error| String::from(ui_err("SESSION_DELETED_KEYRING").arg("error", error)))?;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct DeleteBlocked {
    id: String,
    name: String,
    reason: String,
}

#[derive(Debug, Default, Serialize)]
pub struct DeleteManyResult {
    deleted: Vec<String>,
    blocked: Vec<DeleteBlocked>,
    warnings: Vec<String>,
}

fn plan_delete_many(
    sessions: &[SavedSession],
    ids: &[String],
    mut protect: impl FnMut(&str) -> Result<(), String>,
) -> DeleteManyResult {
    let mut result = DeleteManyResult::default();
    let mut candidates: std::collections::HashSet<String> = ids.iter().cloned().collect();
    let requested: Vec<_> = sessions
        .iter()
        .filter(|s| candidates.contains(&s.id))
        .collect();
    for session in requested {
        if let Err(reason) = protect(&session.id) {
            candidates.remove(&session.id);
            result.blocked.push(DeleteBlocked {
                id: session.id.clone(),
                name: session.name.clone(),
                reason,
            });
        }
    }
    loop {
        let blocked: Vec<_> = sessions
            .iter()
            .filter(|s| {
                candidates.contains(&s.id)
                    && sessions.iter().any(|dependent| {
                        !candidates.contains(&dependent.id)
                            && dependent.jump_session_id.as_deref() == Some(s.id.as_str())
                    })
            })
            .collect();
        if blocked.is_empty() {
            break;
        }
        for session in blocked {
            candidates.remove(&session.id);
            result.blocked.push(DeleteBlocked {
                id: session.id.clone(),
                name: session.name.clone(),
                reason: ui_err("SESSION_IS_JUMP_HOST").into(),
            });
        }
    }
    result.deleted = sessions
        .iter()
        .filter(|s| candidates.contains(&s.id))
        .map(|s| s.id.clone())
        .collect();
    result
}

/// Deletes `ids`, or with `folder` every session in that folder and below plus its empty
/// subfolders (only if nothing was blocked). One atomic write, then the keyring entries.
async fn delete_many_at<P, F>(
    path: PathBuf,
    ids: Vec<String>,
    folder: Option<String>,
    protect: P,
    mut delete_secret: F,
) -> Result<DeleteManyResult, String>
where
    P: FnMut(&str) -> Result<(), String>,
    F: AsyncFnMut(String) -> Result<(), String>,
{
    let folder = match folder {
        Some(folder) => match folders::normalize(&folder)? {
            folder if folder.is_empty() => return Err(ui_err("SESSION_FOLDER_INVALID").into()),
            folder => Some(folder),
        },
        None => None,
    };
    let read = path.clone();
    let mut file = tauri::async_runtime::spawn_blocking(move || load_file(&read))
        .await
        .map_err(|error| String::from(ui_err("BACKGROUND_TASK_FAILED").detail(error)))??;
    let ids = match &folder {
        Some(folder) => file
            .sessions
            .iter()
            .filter(|s| folders::is_within(&folders::lenient(&s.folder), folder))
            .map(|s| s.id.clone())
            .collect(),
        None => ids,
    };
    let mut result = plan_delete_many(&file.sessions, &ids, protect);
    let drop_folder = folder.filter(|_| result.blocked.is_empty());
    if !result.deleted.is_empty() || drop_folder.is_some() {
        file.sessions.retain(|s| !result.deleted.contains(&s.id));
        let mut list = file.folders;
        if let Some(folder) = &drop_folder {
            folders::drop_folder(&file.sessions, &mut list, folder);
        }
        let sessions = file.sessions;
        tauri::async_runtime::spawn_blocking(move || write_file(&path, sessions, Some(list)))
            .await
            .map_err(|error| String::from(ui_err("BACKGROUND_TASK_FAILED").detail(error)))??;
        for id in &result.deleted {
            if let Err(error) = delete_secret(format!("session:{id}")).await {
                result
                    .warnings
                    .push(ui_err("SESSION_DELETED_KEYRING").arg("error", error).into());
            }
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn sessions_delete_many(
    app: tauri::AppHandle,
    ids: Vec<String>,
) -> Result<DeleteManyResult, String> {
    let _guard = STORAGE_LOCK.lock().await;
    delete_many_at(
        config_path(&app)?,
        ids,
        None,
        |id| crate::tunnels::protect_session(&app, id),
        crate::secrets::delete_password,
    )
    .await
}

/// Deletes a folder with all sessions below it and its empty subfolders in one write.
#[tauri::command]
pub async fn sessions_delete_folder(
    app: tauri::AppHandle,
    folder: String,
) -> Result<DeleteManyResult, String> {
    let _guard = STORAGE_LOCK.lock().await;
    delete_many_at(
        config_path(&app)?,
        Vec::new(),
        Some(folder),
        |id| crate::tunnels::protect_session(&app, id),
        crate::secrets::delete_password,
    )
    .await
}

fn protect_kind_change(
    session: &SavedSession,
    sessions: &[SavedSession],
    protect_tunnels: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if session.kind != "ssh"
        && sessions
            .iter()
            .any(|saved| saved.id == session.id && saved.kind == "ssh")
    {
        validate_delete(&session.id, sessions)?;
        protect_tunnels()?;
    }
    Ok(())
}

enum SecretChange {
    Set(String),
    Delete,
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
    if matches!(change, SecretChange::Delete) {
        // Persist first: a disk failure must not discard a saved credential.
        persist(path, sessions).await?;
        return crate::secrets::delete_password(account).await;
    }
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
            return Err(ui_err("KEYRING_RESTORE_FAILED").arg("error", error).into());
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
            return Err(ui_err("SESSIONS_SAVE_RESTORE_FAILED").into());
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
        _ => Err(ui_err("IMPORT_UNKNOWN_SOURCE").into()),
    }
}

pub fn mark_duplicates(preview: &mut ImportPreview, sessions: &[SavedSession]) {
    for candidate in &mut preview.candidates {
        candidate.duplicate_of = sessions
            .iter()
            .find(|session| {
                session.kind == "ssh"
                    && session.host.to_lowercase() == candidate.host.to_lowercase()
                    && session.port == candidate.port
                    && session.user == candidate.user
            })
            .map(|session| session.id.clone());
    }
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .ok_or_else(|| ui_err("HOME_NOT_FOUND").into())
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
        let bytes = fs::read(&path)
            .map_err(|error| String::from(ui_err("IMPORT_READ_FAILED").detail(error)))?;
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
                    .map_err(|_| String::from(ui_err("IMPORT_NOT_UTF8")))?;
                let value: serde_json::Value =
                    import_windterm::parse_json(text).map_err(|error| {
                        String::from(ui_err("WINDTERM_CORRUPT").json_position(&error))
                    })?;
                let sessions_path = if value.is_object() {
                    let directory = value
                        .get("path")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| String::from(ui_err("WINDTERM_NO_PROFILE_PATH")))?;
                    windterm_sessions_path(directory, &path, &home)?
                } else {
                    path
                };
                let text = fs::read_to_string(&sessions_path).map_err(|error| {
                    String::from(ui_err("WINDTERM_SESSIONS_READ_FAILED").detail(error))
                })?;
                let keys_path = sessions_path.with_file_name("onekeys.config");
                let keys = match fs::read_to_string(keys_path) {
                    Ok(text) => Some(text),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                    Err(error) => {
                        return Err(ui_err("WINDTERM_ONEKEY_READ_FAILED").detail(error).into());
                    }
                };
                import_windterm::parse(&text, keys.as_deref(), &home)
            }
            _ => Err(ui_err("IMPORT_UNKNOWN_SOURCE").into()),
        }
    })
    .await
    .map_err(|error| String::from(ui_err("BACKGROUND_TASK_FAILED").detail(error)))??;
    let _guard = STORAGE_LOCK.lock().await;
    let sessions = read_file(config_path(&app)?).await?;
    mark_duplicates(&mut preview, &sessions);
    import_mobaxterm::warn_unmapped_gateways(&mut preview, &sessions);
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
                .ok_or_else(|| String::from(ui_err("IMPORT_UNKNOWN_SOURCE")))?
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
                keepalive_interval: 30,
                keepalive_max: 3,
                jump_session_id: None,
                serial: None,
                log_always: false,
                ssh_options: String::new(),
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
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WerktermImportPreview {
    pub sessions: Vec<SavedSession>,
    pub duplicate_of: Vec<Option<String>>,
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
struct WerktermExport {
    format: &'static str,
    version: u32,
    exported: String,
    sessions: Vec<SavedSession>,
}

fn export_bytes(sessions: &[SavedSession], ids: &[String]) -> Result<(Vec<u8>, usize), String> {
    let sessions: Vec<_> = sessions
        .iter()
        .filter(|session| ids.is_empty() || ids.contains(&session.id))
        .cloned()
        .collect();
    let count = sessions.len();
    if count == 0 {
        return Err(ui_err("EXPORT_EMPTY").into());
    }
    let bytes = serde_json::to_vec_pretty(&WerktermExport {
        format: "werkterm-sessions",
        version: 1,
        exported: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            .to_string(),
        sessions,
    })
    .map_err(|error| String::from(ui_err("SESSIONS_SERIALIZE_FAILED").detail(error)))?;
    Ok((bytes, count))
}

fn export_to_path(path: &Path, sessions: &[SavedSession], ids: &[String]) -> Result<usize, String> {
    let (bytes, count) = export_bytes(sessions, ids)?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let temp = parent.join(format!(".werkterm-export-{}.tmp", new_id()));
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
    result.map_err(|error| String::from(ui_err("EXPORT_WRITE_FAILED").detail(error)))?;
    Ok(count)
}

fn same_werkterm_target(left: &SavedSession, right: &SavedSession) -> bool {
    left.kind == right.kind
        && if left.kind == "serial" {
            left.serial
                .as_ref()
                .zip(right.serial.as_ref())
                .is_some_and(|(left, right)| left.device == right.device)
        } else {
            left.host.to_lowercase() == right.host.to_lowercase()
                && left.port == right.port
                && left.user == right.user
        }
}

fn werkterm_preview(bytes: &[u8], local: &[SavedSession]) -> Result<WerktermImportPreview, String> {
    let file: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|error| String::from(ui_err("SESSIONS_CORRUPT").json_position(&error)))?;
    if file.get("format").and_then(serde_json::Value::as_str) != Some("werkterm-sessions") {
        return Err(ui_err("EXPORT_NOT_WERKTERM").into());
    }
    let version = file
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .ok_or(ui_code("EXPORT_INVALID_VERSION"))?;
    if version > 1 {
        return Err(ui_err("EXPORT_NEWER_VERSION")
            .arg("version", version.to_string())
            .into());
    }
    if version != 1 {
        return Err(ui_err("EXPORT_INVALID_VERSION").into());
    }
    let entries = file
        .get("sessions")
        .and_then(serde_json::Value::as_array)
        .ok_or(ui_code("EXPORT_NO_SESSIONS"))?;
    let mut preview = WerktermImportPreview::default();
    let mut seen = std::collections::HashSet::new();
    for entry in entries {
        let name = entry
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("?");
        let session = serde_json::from_value::<SavedSession>(entry.clone())
            .map_err(|_| String::from(ui_err("SESSION_DATA_INVALID")))
            .and_then(|session| {
                validate(&session)?;
                if session.id.is_empty() || !seen.insert(session.id.clone()) {
                    return Err(ui_err("SESSION_ID_INVALID").into());
                }
                Ok(session)
            });
        match session {
            Ok(session) => {
                // Validated above, so the options parse; weak opt-ins must not arrive unnoticed.
                if let Ok(options) = crate::ssh::options::parse(&session.ssh_options)
                    && !options.legacy.is_empty()
                {
                    preview.warnings.push(
                        ui_err("IMPORT_WEAK_SSH_OPTIONS")
                            .arg("name", &session.name)
                            .arg("algorithms", options.legacy.join(", "))
                            .into(),
                    );
                }
                preview.duplicate_of.push(
                    local
                        .iter()
                        .find(|saved| same_werkterm_target(saved, &session))
                        .map(|saved| saved.id.clone()),
                );
                preview.sessions.push(session);
            }
            Err(error) => preview.warnings.push(
                ui_err("IMPORT_SESSION_SKIPPED")
                    .arg("name", name)
                    .arg("error", error)
                    .into(),
            ),
        }
    }
    Ok(preview)
}

fn prepare_werkterm_import(
    bytes: &[u8],
    local: &[SavedSession],
    ids: &[String],
    home: &Path,
) -> Result<(Vec<SavedSession>, ImportResult), String> {
    let preview = werkterm_preview(bytes, local)?;
    let selected: std::collections::HashSet<_> = ids.iter().collect();
    let mut imported: Vec<_> = preview
        .sessions
        .into_iter()
        .filter(|session| selected.contains(&session.id))
        .collect();
    let mut result = ImportResult {
        imported: imported.len() as u32,
        skipped_duplicates: selected.len().saturating_sub(imported.len()) as u32,
        warnings: preview.warnings,
    };
    let mapping: std::collections::HashMap<_, _> = imported
        .iter()
        .map(|session| (session.id.clone(), new_id()))
        .collect();
    let mut passwords = 0;
    for session in &mut imported {
        session.id = mapping[&session.id].clone();
        if let Some(jump) = &session.jump_session_id {
            if let Some(mapped) = mapping.get(jump) {
                session.jump_session_id = Some(mapped.clone());
            } else if !local.iter().any(|saved| saved.id == *jump) {
                session.jump_session_id = None;
                result.warnings.push(
                    ui_err("IMPORT_JUMP_REMOVED")
                        .arg("name", &session.name)
                        .into(),
                );
            }
        }
        match &session.auth {
            SessionAuth::Password => {
                session.auth = SessionAuth::Ask;
                passwords += 1;
            }
            SessionAuth::KeyFile { path } if !expand_home(path, home).exists() => {
                result.warnings.push(
                    ui_err("IMPORT_KEY_MISSING")
                        .arg("name", &session.name)
                        .arg("path", path)
                        .into(),
                )
            }
            _ => {}
        }
    }
    if passwords > 0 {
        result.warnings.push(
            ui_err("IMPORT_PASSWORDS_ASK")
                .arg("count", passwords.to_string())
                .into(),
        );
    }
    let mut combined = local.to_vec();
    combined.extend(imported);
    validate_jump_hosts(&combined)?;
    Ok((combined, result))
}

#[tauri::command]
pub async fn sessions_export(
    app: tauri::AppHandle,
    ids: Vec<String>,
    path: String,
) -> Result<usize, String> {
    let _guard = STORAGE_LOCK.lock().await;
    let sessions = read_file(config_path(&app)?).await?;
    tauri::async_runtime::spawn_blocking(move || export_to_path(Path::new(&path), &sessions, &ids))
        .await
        .map_err(|error| String::from(ui_err("BACKGROUND_TASK_FAILED").detail(error)))?
}

#[tauri::command]
pub async fn sessions_export_preview(
    app: tauri::AppHandle,
    path: String,
) -> Result<WerktermImportPreview, String> {
    let _guard = STORAGE_LOCK.lock().await;
    let local = read_file(config_path(&app)?).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = fs::read(path)
            .map_err(|error| String::from(ui_err("IMPORT_READ_FAILED").detail(error)))?;
        werkterm_preview(&bytes, &local)
    })
    .await
    .map_err(|error| String::from(ui_err("BACKGROUND_TASK_FAILED").detail(error)))?
}

#[tauri::command]
pub async fn sessions_import_werkterm(
    app: tauri::AppHandle,
    path: String,
    ids: Vec<String>,
) -> Result<ImportResult, String> {
    let _guard = STORAGE_LOCK.lock().await;
    let storage = config_path(&app)?;
    let local = read_file(storage.clone()).await?;
    let home = home_dir()?;
    let (sessions, result) = tauri::async_runtime::spawn_blocking(move || {
        let bytes = fs::read(path)
            .map_err(|error| String::from(ui_err("IMPORT_READ_FAILED").detail(error)))?;
        prepare_werkterm_import(&bytes, &local, &ids, &home)
    })
    .await
    .map_err(|error| String::from(ui_err("BACKGROUND_TASK_FAILED").detail(error)))??;
    persist(storage, sessions).await?;
    Ok(result)
}

fn append_unique_imports(
    sessions: &mut Vec<SavedSession>,
    imported: Vec<SavedSession>,
) -> Result<ImportResult, String> {
    let mut result = ImportResult::default();
    for session in imported {
        let duplicate = sessions.iter().any(|saved| {
            saved.kind == session.kind
                && saved.host.to_lowercase() == session.host.to_lowercase()
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
            .ok_or_else(|| String::from(ui_err("IMPORT_TOO_MANY")))?;
    }
    Ok(result)
}

fn apply_import_gateways(
    sessions: &mut [SavedSession],
    pending: &[(String, ImportGateway)],
) -> Vec<String> {
    let mut warnings = Vec::new();
    for (id, gateway) in pending {
        let matches = import_mobaxterm::gateway_matches(gateway, sessions);
        if let Some(index) = sessions.iter().position(|s| s.id == *id) {
            if matches.len() == 1 && matches[0] != *id {
                sessions[index].jump_session_id = Some(matches[0].clone());
            } else {
                warnings.push(
                    ui_err("IMPORT_GATEWAY_UNMAPPED")
                        .arg("host", &gateway.host)
                        .arg("name", &sessions[index].name)
                        .into(),
                );
            }
        }
    }
    warnings
}

#[tauri::command]
pub async fn sessions_import_commit(
    app: tauri::AppHandle,
    candidates: Vec<ImportSelection>,
) -> Result<ImportResult, String> {
    let gateways: Vec<_> = candidates
        .iter()
        .map(|selection| {
            selection
                .candidate
                .key
                .starts_with("mobaxterm:")
                .then(|| selection.gateway.clone())
                .flatten()
        })
        .collect();
    let imported = prepare_import(candidates)?;
    let pending: Vec<_> = imported
        .iter()
        .zip(gateways)
        .filter_map(|(session, gateway)| gateway.map(|gateway| (session.id.clone(), gateway)))
        .collect();
    let _guard = STORAGE_LOCK.lock().await;
    let path = config_path(&app)?;
    let mut sessions = read_file(path.clone()).await?;
    let mut result = append_unique_imports(&mut sessions, imported)?;
    result.warnings = apply_import_gateways(&mut sessions, &pending);
    validate_jump_hosts(&sessions)?;
    persist(path, sessions).await?;
    Ok(result)
}

/// True for `C:\...`, `C:/...` or UNC paths, which cannot be resolved on Linux.
fn is_windows_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/'))
        || path.starts_with("\\\\")
}

/// Resolves the `user.sessions` file a WindTerm `profiles.config` points to. WindTerm keeps
/// sessions in `<path>/.wind/profiles/default.v<N>/terminal/user.sessions`; `default.v10` is
/// preferred, otherwise the newest other `default.v*` profile that contains the file is used.
fn windterm_sessions_path(directory: &str, config: &Path, home: &Path) -> Result<PathBuf, String> {
    if !cfg!(windows) && is_windows_path(directory) {
        return Err(ui_err("WINDTERM_WINDOWS_PATH")
            .arg("path", directory)
            .into());
    }
    let directory = expand_home(directory, home);
    let directory = if directory.is_absolute() {
        directory
    } else {
        config
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(directory)
    };
    let profiles = directory.join(".wind").join("profiles");
    let sessions = |profile: &Path| profile.join("terminal").join("user.sessions");
    let preferred = sessions(&profiles.join("default.v10"));
    if preferred.is_file() {
        return Ok(preferred);
    }
    let mut others: Vec<PathBuf> = fs::read_dir(&profiles)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with("default.v"))
                })
                .collect()
        })
        .unwrap_or_default();
    // Newest profile version first ("default.v12" before "default.v9").
    others.sort_by_key(|path| {
        std::cmp::Reverse(
            path.file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.strip_prefix("default.v"))
                .and_then(|version| version.parse::<u32>().ok())
                .unwrap_or(0),
        )
    });
    others
        .iter()
        .map(|profile| sessions(profile))
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| {
            ui_err("WINDTERM_NO_SESSIONS")
                .arg("path", profiles.display().to_string())
                .into()
        })
}

#[cfg(test)]
mod tests {

    #[test]
    fn windterm_profiles_config_paths() {
        let root = std::env::temp_dir().join(format!("werkterm-windterm-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let config = root.join("profiles.config");
        let home = root.join("home");
        // Missing profile: clear message with the searched folder.
        let error = windterm_sessions_path("profile", &config, &home).unwrap_err();
        assert_eq!(code_of(&error), Some("WINDTERM_NO_SESSIONS"), "{error}");
        // Only another version present: the newest one is used.
        for version in ["default.v9", "default.v12"] {
            let dir = root
                .join("profile/.wind/profiles")
                .join(version)
                .join("terminal");
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("user.sessions"), "[]").unwrap();
        }
        let found = windterm_sessions_path("profile", &config, &home).unwrap();
        assert!(found.to_string_lossy().contains("default.v12"));
        // default.v10 wins when present.
        let v10 = root.join("profile/.wind/profiles/default.v10/terminal");
        fs::create_dir_all(&v10).unwrap();
        fs::write(v10.join("user.sessions"), "[]").unwrap();
        assert_eq!(
            windterm_sessions_path("profile", &config, &home).unwrap(),
            v10.join("user.sessions")
        );
        fs::remove_dir_all(&root).unwrap();
        assert!(is_windows_path("C:/Users/x/WindTerm"));
        assert!(is_windows_path("D:\\Tools"));
        assert!(is_windows_path("\\\\server\\share"));
        assert!(!is_windows_path("/home/x"));
        assert!(!is_windows_path("~/WindTerm"));
        if !cfg!(windows) {
            let error = windterm_sessions_path("C:/Users/x/WindTerm", &config, &home).unwrap_err();
            assert_eq!(code_of(&error), Some("WINDTERM_WINDOWS_PATH"), "{error}");
        }
    }
    #[test]
    fn kind_changes_preserve_named_jump_and_tunnel_references() {
        let original = jump_sample("gateway", None);
        for kind in ["telnet", "serial"] {
            let changed = SavedSession {
                kind: kind.into(),
                ..original.clone()
            };
            let sessions = vec![original.clone(), jump_sample("production", Some("gateway"))];
            let error =
                protect_kind_change(&changed, &sessions, || panic!("jump protection first"))
                    .unwrap_err();
            assert!(error.contains("production"));
            let error = protect_kind_change(&changed, std::slice::from_ref(&original), || {
                Err(ui_err("SESSION_USED_BY_TUNNELS")
                    .arg("names", "Database")
                    .into())
            })
            .unwrap_err();
            assert!(error.contains("Database"));
            assert!(
                protect_kind_change(&changed, std::slice::from_ref(&original), || Ok(())).is_ok()
            );
            assert!(protect_kind_change(&changed, &[], || panic!("new session")).is_ok());
        }
        assert!(
            protect_kind_change(&original, std::slice::from_ref(&original), || panic!(
                "SSH unchanged"
            ))
            .is_ok()
        );
    }

    #[test]
    fn import_duplicates_require_matching_kind() {
        let imported = sample();
        let mut preview = ImportPreview {
            candidates: vec![ImportCandidate {
                key: "windterm:test".into(),
                name: imported.name.clone(),
                folder: imported.folder.clone(),
                host: imported.host.to_uppercase(),
                port: imported.port,
                user: imported.user.clone(),
                key_path: None,
                one_key: None,
                duplicate_of: None,
            }],
            ..Default::default()
        };
        for kind in ["telnet", "serial", "ssh"] {
            let other = SavedSession {
                kind: kind.into(),
                ..sample()
            };
            mark_duplicates(&mut preview, std::slice::from_ref(&other));
            assert_eq!(preview.candidates[0].duplicate_of.is_some(), kind == "ssh");
            let mut saved = vec![other];
            let result =
                append_unique_imports(&mut saved, vec![imported.clone(), imported.clone()])
                    .unwrap();
            assert_eq!(result.imported, u32::from(kind != "ssh"));
            assert_eq!(result.skipped_duplicates, if kind == "ssh" { 2 } else { 1 });
        }
    }
    #[tokio::test]
    async fn saves_without_new_password_without_accessing_keyring() {
        let directory = std::env::temp_dir().join(format!("werkterm-no-keyring-{}", new_id()));
        let path = directory.join("sessions.json");
        for auth in [
            SessionAuth::Default,
            SessionAuth::Ask,
            SessionAuth::Password,
        ] {
            let session = SavedSession { auth, ..sample() };
            persist_with_secret(path.clone(), vec![session.clone()], "unused".into(), None)
                .await
                .unwrap();
            assert_eq!(load(&path).unwrap(), vec![session]);
        }
        fs::remove_dir_all(directory).unwrap();
    }
    use super::*;
    use crate::ui_error::code_of;
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
    #[test]
    fn jump_serialization_keeps_version_one_and_legacy_defaults() {
        let old = serde_json::to_value(sample()).unwrap();
        assert!(old.get("jumpSessionId").is_none());
        let legacy: SavedSession = serde_json::from_value(old).unwrap();
        assert_eq!(legacy.jump_session_id, None);
        let mut new = legacy;
        new.jump_session_id = Some("gateway".into());
        let file = SessionFile {
            version: 1,
            sessions: vec![new.clone()],
            folders: Vec::new(),
        };
        let encoded = serde_json::to_string(&file).unwrap();
        let decoded: SessionFile = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.version, 1);
        assert_eq!(decoded.sessions, vec![new]);
    }

    fn jump_sample(id: &str, jump: Option<&str>) -> SavedSession {
        SavedSession {
            id: id.into(),
            name: id.into(),
            jump_session_id: jump.map(str::to_owned),
            ..sample()
        }
    }

    #[test]
    fn jump_validation_rejects_self_unknown_non_ssh_and_cycles() {
        for sessions in [
            vec![jump_sample("a", Some("a"))],
            vec![jump_sample("a", Some("missing"))],
            vec![jump_sample("a", Some("b")), jump_sample("b", Some("a"))],
            vec![
                jump_sample("a", Some("b")),
                jump_sample("b", Some("c")),
                jump_sample("c", Some("a")),
            ],
            vec![
                jump_sample("a", Some("b")),
                SavedSession {
                    kind: "local".into(),
                    ..jump_sample("b", None)
                },
            ],
        ] {
            assert!(validate_jump_hosts(&sessions).is_err());
        }
        let sessions = vec![jump_sample("a", Some("b")), jump_sample("b", None)];
        validate_jump_hosts(&sessions).unwrap();
        assert!(validate_delete("a", &sessions).is_ok());
        let error = validate_delete("b", &sessions).unwrap_err();
        assert!(error.contains('a'));
    }

    #[test]
    fn jump_chain_is_outermost_first_and_allows_exactly_five_gateways() {
        let mut sessions = vec![jump_sample("target", Some("1"))];
        for index in 1..=5 {
            sessions.push(jump_sample(&index.to_string(), None));
            if index < 5 {
                sessions[index].jump_session_id = Some((index + 1).to_string());
            }
        }
        let chain = resolve_jump_chain(&sessions[0], &sessions).unwrap();
        assert_eq!(
            chain.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            ["5", "4", "3", "2", "1"]
        );
        assert!(
            resolve_jump_chain(&jump_sample("direct", None), &sessions)
                .unwrap()
                .is_empty()
        );
        sessions[5].jump_session_id = Some("6".into());
        sessions.push(jump_sample("6", None));
        assert_eq!(
            resolve_jump_chain(&sessions[0], &sessions).unwrap_err(),
            r#"JUMP_TOO_MANY: {"args":{"max":"5"}}"#
        );
        sessions[5].jump_session_id = Some("target".into());
        assert_eq!(
            resolve_jump_chain(&sessions[0], &sessions).unwrap_err(),
            "JUMP_CYCLE"
        );
    }

    #[test]
    fn bulk_delete_respects_dependencies_and_tunnel_protection() {
        let sessions = vec![
            jump_sample("gateway", None),
            jump_sample("middle", Some("gateway")),
            jump_sample("target", Some("middle")),
        ];
        let all = vec![
            "gateway".into(),
            "middle".into(),
            "target".into(),
            "unknown".into(),
            "target".into(),
        ];
        assert_eq!(
            plan_delete_many(&sessions, &all, |_| Ok(())).deleted.len(),
            3
        );
        let blocked = plan_delete_many(&sessions, &all, |id| {
            if id == "target" {
                Err(ui_err("SESSION_USED_BY_TUNNELS")
                    .arg("names", "Tunnel")
                    .into())
            } else {
                Ok(())
            }
        });
        assert!(blocked.deleted.is_empty());
        assert_eq!(blocked.blocked.len(), 3);
        assert!(
            blocked
                .blocked
                .iter()
                .any(|s| s.id == "target" && s.reason.contains("Tunnel"))
        );
        let gateway = plan_delete_many(&sessions, &["gateway".into()], |_| Ok(()));
        assert_eq!(gateway.blocked.len(), 1);
        assert!(gateway.deleted.is_empty());
        assert!(
            plan_delete_many(&sessions, &["unknown".into()], |_| panic!(
                "unknown ID must not be protected"
            ))
            .deleted
            .is_empty()
        );
    }

    #[tokio::test]
    async fn bulk_delete_persists_once_before_cleaning_each_secret() {
        let directory = std::env::temp_dir().join(format!("werkterm-bulk-{}", new_id()));
        let path = directory.join("sessions.json");
        write_atomic(
            &path,
            vec![
                jump_sample("gateway", None),
                jump_sample("target", Some("gateway")),
                jump_sample("keep", None),
            ],
        )
        .unwrap();
        let calls = std::cell::RefCell::new(Vec::new());
        let result = delete_many_at(
            path.clone(),
            vec![
                "gateway".into(),
                "target".into(),
                "target".into(),
                "unknown".into(),
            ],
            None,
            |_| Ok(()),
            async |account| {
                assert_eq!(
                    load(&path)
                        .unwrap()
                        .iter()
                        .map(|s| s.id.as_str())
                        .collect::<Vec<_>>(),
                    ["keep"]
                );
                calls.borrow_mut().push(account);
                Err("mock keyring failure".into())
            },
        )
        .await
        .unwrap();
        assert_eq!(result.deleted, ["gateway", "target"]);
        assert_eq!(*calls.borrow(), ["session:gateway", "session:target"]);
        assert_eq!(result.warnings.len(), 2);
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        // Force failure after the initial read, in write_atomic's validation.
        assert!(
            delete_many_at(
                path.clone(),
                vec!["keep".into()],
                None,
                |_| {
                    fs::write(&path, b"broken").unwrap();
                    Ok(())
                },
                async |_| panic!("failed persistence must not remove credentials")
            )
            .await
            .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), b"broken");
        assert!(
            delete_many_at(
                path.clone(),
                vec!["keep".into()],
                None,
                |_| Ok(()),
                async |_| panic!("must not remove credentials on persistence failure")
            )
            .await
            .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), b"broken");
        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn folder_delete_removes_sessions_and_empty_subfolders_in_one_write() {
        let directory = std::env::temp_dir().join(format!("werkterm-delfolder-{}", new_id()));
        let path = directory.join("sessions.json");
        let in_folder = |id: &str, folder: &str, jump: Option<&str>| SavedSession {
            folder: folder.into(),
            ..jump_sample(id, jump)
        };
        write_file(
            &path,
            vec![
                in_folder("a", "Lab", None),
                in_folder("b", "Lab/Sub", None),
                in_folder("keep", "Prod", None),
            ],
            Some(vec!["Lab/Empty".into(), "Other".into()]),
        )
        .unwrap();
        let result = delete_many_at(
            path.clone(),
            Vec::new(),
            Some(" Lab ".into()),
            |_| Ok(()),
            async |_| Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(result.deleted, ["a", "b"]);
        let file = load_file(&path).unwrap();
        assert_eq!(file.sessions.len(), 1);
        assert_eq!(file.folders, ["Other"]);
        // A blocked session keeps the folder and its empty subfolders.
        write_file(
            &path,
            vec![
                in_folder("gw", "Hops", None),
                in_folder("web", "Prod", Some("gw")),
            ],
            Some(vec!["Hops/Empty".into()]),
        )
        .unwrap();
        let result = delete_many_at(
            path.clone(),
            Vec::new(),
            Some("Hops".into()),
            |_| Ok(()),
            async |_| Ok(()),
        )
        .await
        .unwrap();
        assert!(result.deleted.is_empty());
        assert_eq!(result.blocked.len(), 1);
        assert_eq!(load_file(&path).unwrap().folders, ["Hops/Empty"]);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn jump_delete_lists_every_dependent_session() {
        let sessions = vec![
            jump_sample("first", Some("gateway")),
            jump_sample("second", Some("gateway")),
            jump_sample("gateway", None),
            jump_sample("indirect", Some("first")),
        ];
        let error = validate_delete("gateway", &sessions).unwrap_err();
        assert!(error.contains("first"));
        assert!(error.contains("second"));
        assert!(error.contains("indirect"));
    }

    #[test]
    fn import_maps_existing_and_new_gateways_but_never_ambiguous_targets() {
        let target = SavedSession {
            host: "target.test".into(),
            ..jump_sample("target", None)
        };
        let gateway = ImportGateway {
            host: "SRV1.example.test".into(),
            port: 22,
            user: "alice".into(),
        };
        let pending = vec![("target".into(), gateway.clone())];
        let mut sessions = vec![target.clone(), jump_sample("gateway", None)];
        assert!(apply_import_gateways(&mut sessions, &pending).is_empty());
        assert_eq!(sessions[0].jump_session_id.as_deref(), Some("gateway"));
        for alternatives in [
            vec![],
            vec![jump_sample("one", None), jump_sample("two", None)],
            vec![SavedSession {
                port: 2222,
                ..jump_sample("wrong-port", None)
            }],
            vec![SavedSession {
                user: Some("bob".into()),
                ..jump_sample("wrong-user", None)
            }],
        ] {
            let mut sessions = vec![target.clone()];
            sessions.extend(alternatives);
            assert_eq!(apply_import_gateways(&mut sessions, &pending).len(), 1);
            assert!(sessions[0].jump_session_id.is_none());
        }
        let mut sessions = vec![jump_sample("gateway", None)];
        assert_eq!(
            apply_import_gateways(&mut sessions, &[("gateway".into(), gateway)]).len(),
            1
        );
        assert!(sessions[0].jump_session_id.is_none());
    }

    #[test]
    fn logging_defaults_and_roundtrips() {
        let mut value = serde_json::to_value(sample()).unwrap();
        value.as_object_mut().unwrap().remove("log_always");
        assert!(
            !serde_json::from_value::<SavedSession>(value.clone())
                .unwrap()
                .log_always
        );
        value["log_always"] = serde_json::Value::Bool(true);
        let session: SavedSession = serde_json::from_value(value).unwrap();
        assert!(session.log_always);
        assert_eq!(serde_json::to_value(session).unwrap()["log_always"], true);
    }
    #[test]
    fn werkterm_export_roundtrip_and_format_validation() {
        let sessions = vec![sample(), jump_sample("other", None)];
        let directory = std::env::temp_dir().join(format!("werkterm-export-{}", new_id()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("export.json");
        assert_eq!(export_to_path(&path, &sessions, &[]).unwrap(), 2);
        let bytes = fs::read(&path).unwrap();
        assert!(!bytes.contains(&b'\r'));
        let preview = werkterm_preview(&bytes, &[]).unwrap();
        assert_eq!(preview.sessions, sessions);
        assert_eq!(preview.duplicate_of, [None, None]);
        assert!(preview.warnings.is_empty());
        assert_eq!(
            export_to_path(&path, &sessions, &["other".into()]).unwrap(),
            1
        );
        assert_eq!(
            werkterm_preview(&fs::read(&path).unwrap(), &[])
                .unwrap()
                .sessions,
            [sessions[1].clone()]
        );
        assert!(export_bytes(&sessions, &["missing".into()]).is_err());
        let mut file: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        file["format"] = serde_json::json!("other");
        assert_eq!(
            werkterm_preview(&serde_json::to_vec(&file).unwrap(), &[]).unwrap_err(),
            "EXPORT_NOT_WERKTERM"
        );
        file["format"] = serde_json::json!("werkterm-sessions");
        file["version"] = serde_json::json!(2);
        assert_eq!(
            werkterm_preview(&serde_json::to_vec(&file).unwrap(), &[]).unwrap_err(),
            r#"EXPORT_NEWER_VERSION: {"args":{"version":"2"}}"#
        );
        file["version"] = serde_json::json!(1);
        file["sessions"][0]["port"] = serde_json::json!(0);
        let preview = werkterm_preview(&serde_json::to_vec(&file).unwrap(), &[]).unwrap();
        assert_eq!(preview.sessions.len(), 1);
        assert_eq!(
            code_of(&preview.warnings[0]),
            Some("IMPORT_SESSION_SKIPPED")
        );
        assert!(preview.warnings[0].contains(r#""name":"Test""#));
        assert!(preview.warnings[0].contains("SESSION_PORT_INVALID"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn werkterm_import_remaps_jumps_and_reports_missing_credentials() {
        let local = jump_sample("local", None);
        let imported = vec![
            jump_sample("gateway", None),
            jump_sample("internal", Some("gateway")),
            jump_sample("external", Some("local")),
            jump_sample("missing", Some("unknown")),
            sample(),
            SavedSession {
                id: "key".into(),
                auth: SessionAuth::KeyFile {
                    path: "~/missing-key".into(),
                },
                ..sample()
            },
        ];
        let (bytes, _) = export_bytes(&imported, &[]).unwrap();
        let mut ids: Vec<_> = imported.iter().map(|session| session.id.clone()).collect();
        ids.push("not-in-file".into());
        let home = std::env::temp_dir().join(format!("werkterm-missing-{}", new_id()));
        let (combined, result) = prepare_werkterm_import(&bytes, &[local], &ids, &home).unwrap();
        assert_eq!(result.imported, 6);
        assert_eq!(result.skipped_duplicates, 1);
        assert_eq!(combined[2].jump_session_id.as_ref(), Some(&combined[1].id));
        assert_eq!(combined[3].jump_session_id.as_deref(), Some("local"));
        assert_eq!(combined[4].jump_session_id, None);
        assert_eq!(combined[5].auth, SessionAuth::Ask);
        assert!(
            combined[1..]
                .iter()
                .all(|session| !ids.contains(&session.id))
        );
        assert_eq!(result.warnings.len(), 3);
        assert!(
            result
                .warnings
                .iter()
                .any(|warning| code_of(warning) == Some("IMPORT_JUMP_REMOVED"))
        );
        assert!(
            result
                .warnings
                .iter()
                .any(|warning| warning == r#"IMPORT_PASSWORDS_ASK: {"args":{"count":"5"}}"#)
        );
        assert!(result.warnings.iter().any(|warning| warning
            == r#"IMPORT_KEY_MISSING: {"args":{"name":"Test","path":"~/missing-key"}}"#));
        let (combined, result) =
            prepare_werkterm_import(&bytes, &[], &["internal".into()], &home).unwrap();
        assert_eq!(combined[0].jump_session_id, None);
        assert_eq!(result.warnings.len(), 2);
    }

    #[test]
    fn werkterm_duplicates_cover_all_connection_kinds() {
        let ssh = sample();
        let telnet = SavedSession {
            kind: "telnet".into(),
            id: "telnet".into(),
            auth: SessionAuth::Default,
            ..sample()
        };
        let serial: SavedSession = serde_json::from_value(serde_json::json!({ "kind": "serial", "id": "serial", "name": "Console", "folder": "", "serial": { "device": "/dev/ttyUSB0" } })).unwrap();
        let local = vec![ssh, telnet, serial];
        let mut imported = local.clone();
        for session in &mut imported {
            session.id = format!("import-{}", session.id);
            session.host = session.host.to_uppercase();
        }
        let (bytes, _) = export_bytes(&imported, &[]).unwrap();
        let preview = werkterm_preview(&bytes, &local).unwrap();
        assert_eq!(
            preview.duplicate_of,
            [
                Some("sample".into()),
                Some("telnet".into()),
                Some("serial".into())
            ]
        );
        imported[0].user = Some("other".into());
        imported[1].port += 1;
        imported[2].serial.as_mut().unwrap().device = "/dev/ttyUSB1".into();
        let (bytes, _) = export_bytes(&imported, &[]).unwrap();
        assert_eq!(
            werkterm_preview(&bytes, &local).unwrap().duplicate_of,
            [None, None, None]
        );
        let (combined, result) = prepare_werkterm_import(
            &export_bytes(&local, &[]).unwrap().0,
            &local,
            &["sample".into()],
            Path::new("."),
        )
        .unwrap();
        assert_eq!(combined.len(), 4);
        assert_eq!(result.imported, 1);
        assert_eq!(result.skipped_duplicates, 0);
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
            keepalive_interval: 30,
            keepalive_max: 3,
            jump_session_id: None,
            serial: None,
            log_always: false,
            ssh_options: String::new(),
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
    fn telnet_and_serial_roundtrip_with_v1_defaults_and_no_authentication() {
        let value = serde_json::json!({ "kind":"telnet", "id":"telnet", "name":"Router", "folder":"", "host":"router.test" });
        let mut telnet: SavedSession = serde_json::from_value(value).unwrap();
        assert_eq!(telnet.port, 23);
        assert_eq!(telnet.auth, SessionAuth::Default);
        assert!(validate(&telnet).is_ok());
        telnet.auth = SessionAuth::Password;
        assert!(validate(&telnet).is_err());
        telnet.auth = SessionAuth::Default;
        telnet.jump_session_id = Some("ssh".into());
        assert!(validate(&telnet).is_err());
        let value = serde_json::json!({ "kind":"serial", "id":"serial", "name":"Console", "folder":"", "serial":{"device":"/dev/ttyUSB0"} });
        let serial: SavedSession = serde_json::from_value(value).unwrap();
        assert!(validate(&serial).is_ok());
        assert_eq!(serial.serial.as_ref().unwrap().baud, 115200);
        assert_eq!(serial.serial.as_ref().unwrap().enter, "cr");
        let file = SessionFile {
            version: 1,
            sessions: vec![serial.clone()],
            folders: Vec::new(),
        };
        let restored: SessionFile =
            serde_json::from_slice(&serde_json::to_vec(&file).unwrap()).unwrap();
        assert_eq!(restored.version, 1);
        assert_eq!(restored.sessions, [serial]);
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
        let directory = std::env::temp_dir().join(format!("werkterm-test-{}", new_id()));
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
    fn empty_folders_persist_across_other_writes_and_stay_version_one() {
        let directory = std::env::temp_dir().join(format!("werkterm-folders-{}", new_id()));
        let path = directory.join("sessions.json");
        write_atomic(&path, vec![sample()]).unwrap();
        // Without empty folders the field is not written (identical to older files).
        let plain: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(plain.get("folders").is_none());
        assert_eq!(plain["version"], 1);
        change_layout_at(&path, |sessions, list| {
            folders::create_folder(sessions, list, "Empty").map(|()| folders::LayoutChange {
                changed: true,
                ..Default::default()
            })
        })
        .unwrap();
        assert_eq!(load_file(&path).unwrap().folders, ["Empty"]);
        // A regular session save keeps the empty folders.
        write_atomic(&path, vec![sample()]).unwrap();
        assert_eq!(load_file(&path).unwrap().folders, ["Empty"]);
        // Moving a session in makes the folder a regular one; ids stay.
        let change = change_layout_at(&path, |sessions, list| {
            folders::move_sessions(sessions, list, &["sample".into()], "Empty")
        })
        .unwrap();
        let file = load_file(&path).unwrap();
        // "Empty" now holds a session; the emptied source stays as an empty folder.
        assert_eq!(file.folders, ["Lab/SSH"]);
        assert_eq!(file.sessions[0].id, "sample");
        assert_eq!(file.sessions[0].folder, "Empty");
        change_layout_at(&path, |sessions, list| {
            folders::restore(sessions, list, &change.undo)
        })
        .unwrap();
        let file = load_file(&path).unwrap();
        assert_eq!(file.sessions, vec![sample()]);
        assert_eq!(file.folders, ["Empty"]);
        // Unknown and invalid entries in a foreign file are dropped on load, not fatal.
        fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "version": 1, "sessions": [sample()], "folders": ["Lab", "x\u{1}", "New "]
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(load_file(&path).unwrap().folders, ["New"]);
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn layout_changes_never_overwrite_a_corrupt_file_or_write_without_a_change() {
        let directory = std::env::temp_dir().join(format!("werkterm-layout-{}", new_id()));
        let path = directory.join("sessions.json");
        write_atomic(
            &path,
            vec![
                jump_sample("gateway", None),
                jump_sample("target", Some("gateway")),
            ],
        )
        .unwrap();
        let before = fs::read(&path).unwrap();
        let unchanged = change_layout_at(&path, |sessions, list| {
            folders::move_sessions(sessions, list, &["gateway".into()], "Lab/SSH")
        })
        .unwrap();
        assert!(!unchanged.changed);
        assert_eq!(fs::read(&path).unwrap(), before);
        change_layout_at(&path, |sessions, list| {
            folders::move_sessions(sessions, list, &["gateway".into(), "target".into()], "Hops")
        })
        .unwrap();
        let moved = load(&path).unwrap();
        assert_eq!(moved[1].jump_session_id.as_deref(), Some("gateway"));
        assert!(moved.iter().all(|s| s.folder == "Hops"));
        fs::write(&path, b"broken").unwrap();
        assert!(
            change_layout_at(&path, |sessions, list| {
                folders::move_sessions(sessions, list, &["gateway".into()], "Other")
            })
            .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), b"broken");
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
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
            gateway: None,
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
                    gateway: None,
                    user: None,
                    auth: SessionAuth::Ask
                },
                ImportSelection {
                    candidate: invalid,
                    gateway: None,
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
                skipped_duplicates: 2,
                warnings: Vec::new(),
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

#[cfg(test)]
mod keepalive_tests {
    use super::*;
    #[test]
    fn old_sessions_default_and_ranges_are_validated() {
        let mut value = serde_json::json!({"id":"old","name":"Old","folder":"","host":"host","port":22,"user":null,"auth":{"type":"default"},"source":null});
        let mut session: SavedSession = serde_json::from_value(value.clone()).unwrap();
        assert_eq!((session.keepalive_interval, session.keepalive_max), (30, 3));
        for interval in [0, 30, 3600] {
            for max in [1, 3, 100] {
                session.keepalive_interval = interval;
                session.keepalive_max = max;
                assert!(validate(&session).is_ok());
            }
        }
        session.keepalive_interval = 3601;
        assert!(validate(&session).is_err());
        session.keepalive_interval = 30;
        for max in [0, 101] {
            session.keepalive_max = max;
            assert!(validate(&session).is_err());
        }
        value["keepaliveInterval"] = serde_json::json!(-1);
        assert!(serde_json::from_value::<SavedSession>(value).is_err());
    }
}

#[cfg(test)]
mod ssh_options_tests {
    use super::*;

    fn session(options: &str) -> SavedSession {
        let mut session: SavedSession = serde_json::from_value(serde_json::json!({"id":"a","name":"Old","folder":"","host":"host","port":22,"user":null,"auth":{"type":"default"},"source":null})).unwrap();
        session.ssh_options = options.into();
        session
    }

    #[test]
    fn options_are_optional_validated_and_ssh_only() {
        assert!(session("").ssh_options.is_empty());
        assert!(validate(&session("KexAlgorithms=+diffie-hellman-group14-sha1")).is_ok());
        let error = validate(&session("Ciphers aes128-ctr\nProxyJump x")).unwrap_err();
        assert!(error.starts_with("SSH_OPTION_UNKNOWN:") && error.contains("\"line\":\"2\""));
        let mut telnet = session("ConnectTimeout 5");
        telnet.kind = "telnet".into();
        assert!(validate(&telnet).is_err());
        let value = serde_json::to_value(session("")).unwrap();
        assert!(value.get("sshOptions").is_none());
    }

    #[test]
    fn export_and_import_keep_options_and_skip_invalid_ones() {
        let good = session("Ciphers -aes128-ctr");
        let mut bad = session("Ciphers +rot13");
        bad.id = "b".into();
        bad.name = "Bad".into();
        bad.ssh_options = "Ciphers +rot13".into();
        let (bytes, count) = export_bytes(std::slice::from_ref(&good), &[]).unwrap();
        assert_eq!(count, 1);
        let preview = werkterm_preview(&bytes, &[]).unwrap();
        assert_eq!(preview.sessions[0].ssh_options, "Ciphers -aes128-ctr");
        let file =
            serde_json::json!({"format":"werkterm-sessions","version":1,"sessions":[good, bad]});
        let preview = werkterm_preview(&serde_json::to_vec(&file).unwrap(), &[]).unwrap();
        assert_eq!(preview.sessions.len(), 1);
        assert_eq!(preview.warnings.len(), 1);
        assert!(preview.warnings[0].contains("SSH_OPTION_UNKNOWN_ALGORITHM"));
    }

    #[test]
    fn import_preview_warns_about_weak_options() {
        let mut weak = session("KexAlgorithms +diffie-hellman-group1-sha1\nCiphers -aes128-ctr");
        weak.name = "Legacy".into();
        let mut strong = session("Ciphers -aes128-ctr");
        strong.id = "b".into();
        let file =
            serde_json::json!({"format":"werkterm-sessions","version":1,"sessions":[weak, strong]});
        let preview = werkterm_preview(&serde_json::to_vec(&file).unwrap(), &[]).unwrap();
        assert_eq!(preview.sessions.len(), 2);
        assert_eq!(preview.warnings.len(), 1);
        let warning = &preview.warnings[0];
        assert!(warning.starts_with("IMPORT_WEAK_SSH_OPTIONS:"), "{warning}");
        assert!(warning.contains("Legacy") && warning.contains("diffie-hellman-group1-sha1"));
    }
}
