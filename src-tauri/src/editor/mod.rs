use crate::ssh::SshManager;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex},
    time::UNIX_EPOCH,
};
use tauri::{Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

const MAX_SIZE: u64 = 10 * 1024 * 1024;
const TOO_LARGE: &str = "TOO_LARGE: Datei größer als 10 MB";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EolKind {
    Lf,
    CrLf,
    Cr,
    Mixed,
    None,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EolCounts {
    pub lf: u64,
    pub cr_lf: u64,
    pub cr: u64,
}
#[derive(Debug)]
pub struct DecodedText {
    pub text: String,
    pub bom: bool,
    pub eol: EolKind,
    pub counts: EolCounts,
}

pub fn decode(bytes: &[u8]) -> Result<DecodedText, String> {
    check_size(bytes.len() as u64)?;
    if bytes.iter().take(8192).any(|byte| *byte == 0) {
        return Err("BINARY: Binärdatei".into());
    }
    let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
    let raw = if bom { &bytes[3..] } else { bytes };
    let text =
        std::str::from_utf8(raw).map_err(|_| "ENCODING: Nur UTF-8 wird unterstützt".to_owned())?;
    let mut counts = EolCounts::default();
    let mut index = 0;
    while index < raw.len() {
        match raw[index] {
            b'\r' if raw.get(index + 1) == Some(&b'\n') => {
                counts.cr_lf += 1;
                index += 1;
            }
            b'\r' => counts.cr += 1,
            b'\n' => counts.lf += 1,
            _ => {}
        }
        index += 1;
    }
    let kinds = [counts.lf, counts.cr_lf, counts.cr]
        .iter()
        .filter(|count| **count > 0)
        .count();
    let eol = match kinds {
        0 => EolKind::None,
        1 if counts.lf > 0 => EolKind::Lf,
        1 if counts.cr_lf > 0 => EolKind::CrLf,
        1 => EolKind::Cr,
        _ => EolKind::Mixed,
    };
    Ok(DecodedText {
        text: normalize(text),
        bom,
        eol,
        counts,
    })
}
fn normalize(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}
pub fn encode(text: &str, eol_target: EolKind, bom: bool) -> Result<Vec<u8>, String> {
    let separator = match eol_target {
        EolKind::Lf => "\n",
        EolKind::CrLf => "\r\n",
        EolKind::Cr => "\r",
        _ => return Err("Ungültiges Ziel-Zeilenende".into()),
    };
    let normalized = normalize(text);
    let text = normalized.replace('\n', separator);
    let mut bytes = Vec::with_capacity(text.len() + if bom { 3 } else { 0 });
    if bom {
        bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
    }
    bytes.extend_from_slice(text.as_bytes());
    check_size(bytes.len() as u64)?;
    Ok(bytes)
}
fn check_size(size: u64) -> Result<(), String> {
    if size > MAX_SIZE {
        Err(TOO_LARGE.into())
    } else {
        Ok(())
    }
}
fn io_error(error: impl std::fmt::Display) -> String {
    format!("Dateizugriff fehlgeschlagen: {error}")
}

pub enum DocumentSource {
    Remote {
        session_id: u32,
        path: String,
        sudo: bool,
    },
    Local {
        path: PathBuf,
    },
}
pub struct DocumentEntry {
    pub source: DocumentSource,
    pub cache_path: Option<PathBuf>,
    pub mtime: Option<u64>,
    pub size: u64,
    pub permissions: Option<u32>,
    display_path: String,
    local_modified: Option<std::time::SystemTime>,
    local_identity: Option<LocalIdentity>,
    baseline: Vec<u8>,
}
#[derive(Default)]
struct Documents {
    next_id: u32,
    entries: HashMap<u32, DocumentEntry>,
}
#[derive(Default)]
pub struct EditorDocs {
    documents: Mutex<Documents>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorDocument {
    pub doc_id: u32,
    pub name: String,
    pub path: String,
    pub text: String,
    pub bom: bool,
    pub eol: EolKind,
    pub eol_counts: EolCounts,
    pub size: u64,
    pub mtime: Option<u64>,
    pub readonly: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub size: u64,
    pub mtime: Option<u64>,
}
struct InstanceCache {
    path: PathBuf,
    _lock: fs::File,
}
static INSTANCE_CACHE: StdMutex<Option<InstanceCache>> = StdMutex::new(None);

// Locks protect live instances regardless of age. Unknown entries are left alone.
fn clean_stale_instances(root: &Path) -> std::io::Result<()> {
    fs::create_dir_all(root)?;
    for entry in fs::read_dir(root)? {
        let Ok(entry) = entry else {
            continue;
        };
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if !kind.is_dir() {
            continue;
        }
        let path = entry.path();
        let Ok(lock) = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path.join("instance.lock"))
        else {
            continue;
        };
        if lock.try_lock().is_err() {
            continue;
        }
        let removed = (|| -> std::io::Result<()> {
            for child in fs::read_dir(&path)? {
                let child = child?;
                if child.file_name() == "instance.lock" {
                    continue;
                }
                if child.file_type()?.is_dir() {
                    fs::remove_dir_all(child.path())?;
                } else {
                    fs::remove_file(child.path())?;
                }
            }
            Ok(())
        })();
        // Keep the marker if cleanup failed so a later startup can retry.
        if removed.is_err() {
            continue;
        }
        // Windows requires closing the lock before deleting the lock file.
        drop(lock);
        let _ = fs::remove_file(path.join("instance.lock"));
        let _ = fs::remove_dir(&path);
    }
    Ok(())
}

pub fn init_cache(app: &tauri::AppHandle) -> Result<(), String> {
    let root = app.path().app_cache_dir().map_err(io_error)?.join("editor");
    clean_stale_instances(&root).map_err(io_error)?;
    *INSTANCE_CACHE.lock().map_err(io_error)? = Some(create_instance_cache(&root)?);
    Ok(())
}
fn create_instance_cache(root: &Path) -> Result<InstanceCache, String> {
    let started = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io_error)?
        .as_nanos();
    let path = root.join(format!("{}-{started}", std::process::id()));
    fs::create_dir(&path).map_err(io_error)?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(path.join("initializing.lock"))
        .map_err(io_error)?;
    lock.try_lock().map_err(io_error)?;
    fs::rename(path.join("initializing.lock"), path.join("instance.lock")).map_err(io_error)?;
    Ok(InstanceCache { path, _lock: lock })
}

fn cache_dir(_: &tauri::AppHandle) -> Result<PathBuf, String> {
    INSTANCE_CACHE
        .lock()
        .map_err(io_error)?
        .as_ref()
        .map(|cache| cache.path.clone())
        .ok_or("Editor-Cache ist nicht initialisiert".into())
}
pub fn clear_cache() {
    if let Ok(mut cache) = INSTANCE_CACHE.lock()
        && let Some(instance) = cache.take()
    {
        let path = instance.path.clone();
        drop(instance);
        let _ = fs::remove_dir_all(path);
    }
}
#[derive(Debug, PartialEq, Eq)]
struct LocalIdentity {
    created: Option<std::time::SystemTime>,
    #[cfg(unix)]
    device_inode: (u64, u64),
}
fn local_identity(meta: &fs::Metadata) -> LocalIdentity {
    LocalIdentity {
        created: meta.created().ok(),
        #[cfg(unix)]
        device_inode: {
            use std::os::unix::fs::MetadataExt;
            (meta.dev(), meta.ino())
        },
    }
}
fn write_failed(path: Option<&Path>) -> String {
    format!(
        "WRITE_FAILED: Speichern fehlgeschlagen – die Datei ist möglicherweise unvollständig. Ihr Inhalt ist im Editor erhalten; bitte erneut speichern. Sicherung: {}",
        path.map(|path| path.display().to_string())
            .unwrap_or_else(|| "nicht verfügbar".into())
    )
}
fn file_name(path: &str) -> String {
    // POSIX remote names must not be interpreted as Windows drive prefixes.
    let name = path.rsplit('/').next().unwrap_or_default();
    if name.is_empty() {
        "Datei".into()
    } else {
        name.into()
    }
}
fn safe_name(path: &str) -> String {
    file_name(path)
        .chars()
        .take(80)
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}
fn local_stamp(meta: &fs::Metadata) -> SaveResult {
    SaveResult {
        size: meta.len(),
        mtime: meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|time| time.as_secs()),
    }
}
fn remote_stamp(meta: &FileAttributes) -> Result<SaveResult, String> {
    Ok(SaveResult {
        size: meta
            .size
            .ok_or("Dateigröße konnte nicht ermittelt werden")?,
        mtime: meta.mtime.map(u64::from),
    })
}
fn check_conflict(entry: &DocumentEntry, current: &SaveResult, force: bool) -> Result<(), String> {
    if !force && (entry.mtime != current.mtime || entry.size != current.size) {
        Err("CONFLICT: Datei wurde zwischenzeitlich geändert".into())
    } else {
        Ok(())
    }
}
fn read_local(path: &Path) -> Result<(Vec<u8>, fs::Metadata), String> {
    let mut file = fs::File::open(path).map_err(io_error)?;
    let meta = file.metadata().map_err(io_error)?;
    if !meta.is_file() {
        return Err("Nur reguläre Dateien können bearbeitet werden".into());
    }
    check_size(meta.len())?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_SIZE + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    check_size(bytes.len() as u64)?;
    Ok((bytes, meta))
}
async fn load(
    entry: &mut DocumentEntry,
    doc_id: u32,
    ssh: &SshManager,
) -> Result<EditorDocument, String> {
    let (bytes, stamp, readonly, permissions, local_modified, identity) = match &entry.source {
        DocumentSource::Local { path } => {
            let (bytes, meta) = read_local(path)?;
            let readonly = meta.permissions().readonly()
                || fs::OpenOptions::new().write(true).open(path).is_err();
            (
                bytes,
                local_stamp(&meta),
                readonly,
                local_permissions(&meta),
                meta.modified().ok(),
                Some(local_identity(&meta)),
            )
        }
        DocumentSource::Remote {
            session_id,
            path,
            sudo,
        } => {
            let sftp = ssh.editor_sftp(*session_id, *sudo).await?;
            let meta = sftp.metadata(path.clone()).await.map_err(io_error)?;
            if !meta.is_regular() {
                return Err("Nur reguläre Dateien können bearbeitet werden".into());
            }
            let stamp = remote_stamp(&meta)?;
            check_size(stamp.size)?;
            let mut remote = sftp.open(path.clone()).await.map_err(io_error)?;
            let mut bytes = Vec::new();
            let read = AsyncReadExt::take(&mut remote, MAX_SIZE + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(io_error);
            let closed = remote.shutdown().await.map_err(io_error);
            read?;
            closed?;
            check_size(bytes.len() as u64)?;
            (bytes, stamp, false, meta.permissions, None, None)
        }
    };
    let decoded = decode(&bytes)?;
    if let Some(cache) = &entry.cache_path {
        fs::write(cache, &bytes).map_err(io_error)?;
    }
    entry.baseline = bytes;
    entry.local_identity = identity;
    entry.size = stamp.size;
    entry.mtime = stamp.mtime;
    entry.permissions = permissions;
    entry.local_modified = local_modified;
    Ok(EditorDocument {
        doc_id,
        name: match &entry.source {
            DocumentSource::Local { path } => path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Datei".into()),
            DocumentSource::Remote { path, .. } => file_name(path),
        },
        path: entry.display_path.clone(),
        text: decoded.text,
        bom: decoded.bom,
        eol: decoded.eol,
        eol_counts: decoded.counts,
        size: stamp.size,
        mtime: stamp.mtime,
        readonly,
    })
}
#[cfg(unix)]
fn local_permissions(meta: &fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    Some(meta.permissions().mode())
}
#[cfg(not(unix))]
fn local_permissions(_: &fs::Metadata) -> Option<u32> {
    None
}
fn next_id(docs: &mut Documents) -> Result<u32, String> {
    docs.next_id = docs
        .next_id
        .checked_add(1)
        .ok_or("Keine Dokument-IDs mehr verfügbar")?;
    Ok(docs.next_id)
}

#[tauri::command]
pub async fn editor_open_remote(
    app: tauri::AppHandle,
    docs: State<'_, Arc<EditorDocs>>,
    ssh: State<'_, Arc<SshManager>>,
    id: u32,
    path: String,
) -> Result<EditorDocument, String> {
    if path.is_empty() || path.contains('\0') {
        return Err("Ungültiger Pfad".into());
    }
    let mut docs = docs.documents.lock().await;
    let doc_id = next_id(&mut docs)?;
    let dir = cache_dir(&app)?;
    fs::create_dir_all(&dir).map_err(io_error)?;
    let cache_path = dir.join(format!("{doc_id}-backup-{}", safe_name(&path)));
    let mut entry = DocumentEntry {
        source: DocumentSource::Remote {
            session_id: id,
            sudo: ssh.sudo_active(id).await?,
            path: path.clone(),
        },
        cache_path: Some(cache_path.clone()),
        mtime: None,
        size: 0,
        permissions: None,
        display_path: path,
        local_modified: None,
        local_identity: None,
        baseline: Vec::new(),
    };
    match load(&mut entry, doc_id, &ssh).await {
        Ok(document) => {
            docs.entries.insert(doc_id, entry);
            Ok(document)
        }
        Err(error) => {
            let _ = fs::remove_file(cache_path);
            Err(error)
        }
    }
}
#[tauri::command]
pub async fn editor_open_local(
    app: tauri::AppHandle,
    docs: State<'_, Arc<EditorDocs>>,
    ssh: State<'_, Arc<SshManager>>,
    path: String,
    wsl_distro: Option<String>,
) -> Result<EditorDocument, String> {
    let local_path = match wsl_distro {
        Some(distro) => {
            if !cfg!(windows) {
                return Err("WSL ist nur unter Windows verfügbar".into());
            }
            crate::local_fs::wsl_unc_path(&distro, &path)?
        }
        None => PathBuf::from(&path),
    };
    let local_path = local_path.canonicalize().map_err(io_error)?;
    let mut docs = docs.documents.lock().await;
    let doc_id = next_id(&mut docs)?;
    let mut entry = DocumentEntry {
        source: DocumentSource::Local { path: local_path },
        cache_path: Some(cache_dir(&app)?.join(format!("{doc_id}-backup-{}", safe_name(&path)))),
        mtime: None,
        size: 0,
        permissions: None,
        display_path: path,
        local_modified: None,
        local_identity: None,
        baseline: Vec::new(),
    };
    let document = load(&mut entry, doc_id, &ssh).await?;
    docs.entries.insert(doc_id, entry);
    Ok(document)
}
#[tauri::command]
pub async fn editor_reload(
    docs: State<'_, Arc<EditorDocs>>,
    ssh: State<'_, Arc<SshManager>>,
    doc_id: u32,
) -> Result<EditorDocument, String> {
    let mut docs = docs.documents.lock().await;
    let entry = docs
        .entries
        .get_mut(&doc_id)
        .ok_or("Dokument wurde nicht gefunden")?;
    load(entry, doc_id, &ssh).await
}
#[tauri::command]
pub async fn editor_close(docs: State<'_, Arc<EditorDocs>>, doc_id: u32) -> Result<(), String> {
    let mut docs = docs.documents.lock().await;
    let entry = docs
        .entries
        .get(&doc_id)
        .ok_or("Dokument wurde nicht gefunden")?;
    if let Some(path) = &entry.cache_path {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }
    }
    docs.entries.remove(&doc_id);
    Ok(())
}
#[tauri::command]
pub async fn editor_save(
    docs: State<'_, Arc<EditorDocs>>,
    ssh: State<'_, Arc<SshManager>>,
    doc_id: u32,
    text: String,
    eol: EolKind,
    bom: bool,
    force: bool,
) -> Result<SaveResult, String> {
    let bytes = encode(&text, eol, bom)?;
    let mut docs = docs.documents.lock().await;
    let entry = docs
        .entries
        .get_mut(&doc_id)
        .ok_or("Dokument wurde nicht gefunden")?;
    save_entry(entry, &ssh, &bytes, force).await
}

async fn save_entry(
    entry: &mut DocumentEntry,
    ssh: &SshManager,
    bytes: &[u8],
    force: bool,
) -> Result<SaveResult, String> {
    // Back up the known baseline, never re-read the file before writing.
    if let Some(cache) = &entry.cache_path {
        fs::write(cache, &entry.baseline).map_err(|_| write_failed(Some(cache)))?;
    }
    let result = async {
        let stamp = match &entry.source {
            DocumentSource::Local { path } => {
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .open(path)
                    .map_err(io_error)?;
                save_local_handle(entry, &mut file, bytes, force)?;
                let metadata = file.metadata().map_err(io_error)?;
                entry.local_modified = metadata.modified().ok();
                entry.local_identity = Some(local_identity(&metadata));
                local_stamp(&metadata)
            }
            DocumentSource::Remote {
                session_id,
                path,
                sudo,
            } => {
                let sftp = ssh.editor_sftp(*session_id, *sudo).await?;
                let mut remote = sftp
                    .open_with_flags(path.clone(), OpenFlags::WRITE)
                    .await
                    .map_err(io_error)?;
                let written = async {
                    let before = remote.metadata().await.map_err(io_error)?;
                    check_conflict(entry, &remote_stamp(&before)?, force)?;
                    let permissions = before
                        .permissions
                        .ok_or("Dateirechte konnten nicht ermittelt werden")?;
                    remote.write_all(bytes).await.map_err(io_error)?;
                    remote.flush().await.map_err(io_error)?;
                    remote
                        .set_metadata(FileAttributes {
                            size: Some(bytes.len() as u64),
                            permissions: Some(permissions),
                            ..FileAttributes::empty()
                        })
                        .await
                        .map_err(io_error)?;
                    remote.sync_all().await.map_err(io_error)?;
                    let after = remote.metadata().await.map_err(io_error)?;
                    entry.permissions = Some(permissions);
                    remote_stamp(&after)
                }
                .await;
                let closed = remote.shutdown().await.map_err(io_error);
                let stamp = written?;
                closed?;
                stamp
            }
        };
        Ok::<_, String>(stamp)
    }
    .await;
    let stamp = result.map_err(|error| {
        if error.starts_with("CONFLICT:") || error.starts_with("SUDO_INACTIVE:") {
            error
        } else {
            write_failed(entry.cache_path.as_deref())
        }
    })?;
    entry.size = stamp.size;
    entry.mtime = stamp.mtime;
    entry.baseline = bytes.to_vec();
    Ok(stamp)
}
fn check_local_conflict(
    entry: &DocumentEntry,
    metadata: &fs::Metadata,
    force: bool,
) -> Result<(), String> {
    check_conflict(entry, &local_stamp(metadata), force)?;
    if !force
        && (entry.local_modified != metadata.modified().ok()
            || entry.local_identity.as_ref() != Some(&local_identity(metadata)))
    {
        return Err("CONFLICT: Datei wurde zwischenzeitlich geändert".into());
    }
    Ok(())
}
fn save_local_handle(
    entry: &DocumentEntry,
    file: &mut fs::File,
    bytes: &[u8],
    force: bool,
) -> Result<(), String> {
    let metadata = file.metadata().map_err(io_error)?;
    check_local_conflict(entry, &metadata, force)?;
    write_local(file, bytes).map_err(io_error)
}
fn write_local(file: &mut fs::File, bytes: &[u8]) -> std::io::Result<()> {
    file.write_all(bytes)?;
    file.set_len(bytes.len() as u64)?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    const LF: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../tests/fixtures/eol/lf.txt"
    ));
    const CRLF: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../tests/fixtures/eol/crlf.txt"
    ));
    const CR: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../tests/fixtures/eol/cr.txt"
    ));
    const MIXED: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../tests/fixtures/eol/mixed.txt"
    ));
    const BOM: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../tests/fixtures/eol/bom-crlf.txt"
    ));
    const NONE: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../tests/fixtures/eol/no-eol.txt"
    ));
    const LATIN1: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../tests/fixtures/eol/latin1.txt"
    ));
    const BINARY: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../tests/fixtures/eol/binary.bin"
    ));
    #[test]
    fn fixture_roundtrips_and_raw_counts() {
        for (bytes, eol, counts) in [
            (
                LF,
                EolKind::Lf,
                EolCounts {
                    lf: 2,
                    ..EolCounts::default()
                },
            ),
            (
                CRLF,
                EolKind::CrLf,
                EolCounts {
                    cr_lf: 2,
                    ..EolCounts::default()
                },
            ),
            (
                CR,
                EolKind::Cr,
                EolCounts {
                    cr: 2,
                    ..EolCounts::default()
                },
            ),
            (
                BOM,
                EolKind::CrLf,
                EolCounts {
                    cr_lf: 2,
                    ..EolCounts::default()
                },
            ),
            (NONE, EolKind::None, EolCounts::default()),
        ] {
            let decoded = decode(bytes).unwrap();
            assert_eq!(decoded.eol, eol);
            assert_eq!(decoded.counts, counts);
            assert_eq!(decoded.bom, bytes == BOM);
            assert!(!decoded.text.contains('\r'));
            let target = if eol == EolKind::None {
                EolKind::Lf
            } else {
                eol
            };
            assert_eq!(encode(&decoded.text, target, decoded.bom).unwrap(), bytes);
        }
        let decoded = decode(MIXED).unwrap();
        assert_eq!(decoded.eol, EolKind::Mixed);
        assert_eq!(
            decoded.counts,
            EolCounts {
                lf: 1,
                cr_lf: 1,
                cr: 1
            }
        );
        assert_eq!(
            encode(&decoded.text, EolKind::Lf, false).unwrap(),
            b"alpha\nbeta\ngamma\n"
        );
    }
    #[test]
    fn encoding_binary_limits_and_defensive_normalization() {
        assert_eq!(
            decode(LATIN1).unwrap_err(),
            "ENCODING: Nur UTF-8 wird unterstützt"
        );
        assert_eq!(decode(BINARY).unwrap_err(), "BINARY: Binärdatei");
        assert_eq!(
            decode(&[0xef, 0xbb, 0xbf, 0xe4]).unwrap_err(),
            "ENCODING: Nur UTF-8 wird unterstützt"
        );
        assert_eq!(
            decode(&vec![b'a'; MAX_SIZE as usize + 1]).unwrap_err(),
            TOO_LARGE
        );
        assert!(decode(&vec![b'a'; MAX_SIZE as usize]).is_ok());
        let mut bytes = vec![b'a'; 8193];
        bytes[8192] = 0;
        assert!(decode(&bytes).is_ok());
        bytes[8191] = 0;
        assert_eq!(decode(&bytes).unwrap_err(), "BINARY: Binärdatei");
        assert_eq!(
            encode("a\r\nb\rc\n", EolKind::CrLf, true).unwrap(),
            b"\xef\xbb\xbfa\r\nb\r\nc\r\n"
        );
        assert!(encode("", EolKind::Mixed, false).is_err());
        assert!(encode("", EolKind::None, false).is_err());
        assert_eq!(decode(b"").unwrap().eol, EolKind::None);
        assert_eq!(decode(b"\xef\xbb\xbf").unwrap().text, "");
    }
    #[test]
    fn json_contract_and_safe_names() {
        assert_eq!(serde_json::to_string(&EolKind::CrLf).unwrap(), "\"crLf\"");
        assert_eq!(
            serde_json::to_value(EolCounts {
                lf: 1,
                cr_lf: 2,
                cr: 3
            })
            .unwrap(),
            serde_json::json!({"lf":1,"crLf":2,"cr":3})
        );
        assert_eq!(safe_name("/folder/a:b?.txt"), "a_b_.txt");
        assert!(
            safe_name("../../evil")
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        );
    }
    struct TestFile {
        dir: PathBuf,
        path: PathBuf,
    }
    impl TestFile {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let base = std::env::temp_dir();
            let dir = base.join("linmoba").join("editor-tests").join(format!(
                "{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&dir).unwrap();
            let path = dir.join("document.txt");
            fs::write(&path, CRLF).unwrap();
            Self { dir, path }
        }
        fn entry(&self) -> DocumentEntry {
            DocumentEntry {
                source: DocumentSource::Local {
                    path: self.path.clone(),
                },
                cache_path: Some(self.dir.join("1-backup-document.txt")),
                mtime: None,
                size: 0,
                permissions: None,
                display_path: self.path.to_string_lossy().into_owned(),
                local_modified: None,
                local_identity: None,
                baseline: Vec::new(),
            }
        }
    }
    impl Drop for TestFile {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }
    #[tokio::test]
    async fn local_load_save_conflict_force_and_reload() {
        let file = TestFile::new();
        let ssh = SshManager::default();
        let mut entry = file.entry();
        let document = load(&mut entry, 17, &ssh).await.unwrap();
        assert_eq!(document.doc_id, 17);
        assert_eq!(document.eol, EolKind::CrLf);
        assert!(!document.readonly);
        let original_permissions = fs::metadata(&file.path).unwrap().permissions();
        let stamp = save_entry(&mut entry, &ssh, b"saved\n", false)
            .await
            .unwrap();
        assert_eq!(stamp.size, 6);
        assert_eq!(fs::read(&file.path).unwrap(), b"saved\n");
        assert_eq!(
            fs::metadata(&file.path).unwrap().permissions(),
            original_permissions
        );
        fs::write(&file.path, b"externally changed").unwrap();
        assert_eq!(
            save_entry(&mut entry, &ssh, b"replacement", false)
                .await
                .unwrap_err(),
            "CONFLICT: Datei wurde zwischenzeitlich geändert"
        );
        assert_eq!(fs::read(&file.path).unwrap(), b"externally changed");
        save_entry(&mut entry, &ssh, b"forced", true).await.unwrap();
        fs::write(&file.path, BOM).unwrap();
        let reloaded = load(&mut entry, 17, &ssh).await.unwrap();
        assert_eq!(reloaded.doc_id, 17);
        assert!(reloaded.bom);
        assert_eq!(entry.size, BOM.len() as u64);
    }
    #[tokio::test]
    async fn closed_remote_session_returns_stable_error() {
        let ssh = SshManager::default();
        let mut entry = DocumentEntry {
            source: DocumentSource::Remote {
                session_id: 99,
                sudo: false,
                path: "file".into(),
            },
            cache_path: None,
            mtime: None,
            size: 0,
            permissions: None,
            display_path: "file".into(),
            local_modified: None,
            local_identity: None,
            baseline: Vec::new(),
        };
        assert_eq!(
            load(&mut entry, 1, &ssh).await.unwrap_err(),
            "SESSION_CLOSED: SSH-Sitzung beendet"
        );
        assert_eq!(
            save_entry(&mut entry, &ssh, b"text", false)
                .await
                .unwrap_err(),
            write_failed(None)
        );
    }
    #[tokio::test]
    async fn unavailable_sudo_preserves_editor_baseline_and_error_category() {
        let ssh = SshManager::default();
        let baseline = b"original".to_vec();
        let mut entry = DocumentEntry {
            source: DocumentSource::Remote {
                session_id: 99,
                path: "file".into(),
                sudo: true,
            },
            cache_path: None,
            mtime: Some(17),
            size: baseline.len() as u64,
            permissions: Some(0o640),
            display_path: "file".into(),
            local_modified: None,
            local_identity: None,
            baseline: baseline.clone(),
        };
        assert_eq!(
            save_entry(&mut entry, &ssh, b"unsaved edits", false)
                .await
                .unwrap_err(),
            "SUDO_INACTIVE: sudo-Modus ist nicht mehr aktiv"
        );
        assert_eq!(entry.baseline, baseline);
        assert_eq!(entry.permissions, Some(0o640));
        assert_eq!(entry.mtime, Some(17));
        assert_eq!(
            load(&mut entry, 1, &ssh).await.unwrap_err(),
            "SUDO_INACTIVE: sudo-Modus ist nicht mehr aktiv"
        );
    }
    #[tokio::test]
    async fn same_size_subsecond_changes_conflict() {
        let file = TestFile::new();
        let handle = fs::OpenOptions::new().write(true).open(&file.path).unwrap();
        let time = UNIX_EPOCH + std::time::Duration::new(1_700_000_000, 100_000_000);
        handle
            .set_times(fs::FileTimes::new().set_modified(time))
            .unwrap();
        let ssh = SshManager::default();
        let mut entry = file.entry();
        load(&mut entry, 1, &ssh).await.unwrap();
        handle
            .set_times(
                fs::FileTimes::new().set_modified(time + std::time::Duration::from_millis(100)),
            )
            .unwrap();
        assert_eq!(
            save_entry(&mut entry, &ssh, b"new", false)
                .await
                .unwrap_err(),
            "CONFLICT: Datei wurde zwischenzeitlich geändert"
        );
        assert_eq!(fs::read(&file.path).unwrap(), CRLF);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn symlinks_and_hardlinks_keep_target_inode() {
        use std::os::unix::fs::{MetadataExt, symlink};
        let file = TestFile::new();
        let alias = file.dir.join("alias");
        let hardlink = file.dir.join("hardlink");
        symlink(&file.path, &alias).unwrap();
        fs::hard_link(&file.path, &hardlink).unwrap();
        let inode = fs::metadata(&file.path).unwrap().ino();
        let mut entry = file.entry();
        entry.source = DocumentSource::Local { path: alias };
        let ssh = SshManager::default();
        load(&mut entry, 1, &ssh).await.unwrap();
        save_entry(&mut entry, &ssh, b"new", false).await.unwrap();
        assert_eq!(fs::metadata(&file.path).unwrap().ino(), inode);
        assert_eq!(fs::read(hardlink).unwrap(), b"new");
    }
    #[test]
    fn write_failure_message_contains_recovery_path() {
        let path = Path::new("known-backup");
        assert_eq!(
            write_failed(Some(path)),
            "WRITE_FAILED: Speichern fehlgeschlagen – die Datei ist möglicherweise unvollständig. Ihr Inhalt ist im Editor erhalten; bitte erneut speichern. Sicherung: known-backup"
        );
    }
    #[tokio::test]
    async fn opened_handle_conflict_never_writes_and_short_save_truncates() {
        let file = TestFile::new();
        let mut entry = file.entry();
        let ssh = SshManager::default();
        load(&mut entry, 1, &ssh).await.unwrap();
        let mut opened = fs::OpenOptions::new().write(true).open(&file.path).unwrap();
        fs::write(&file.path, b"external content").unwrap();
        let error = save_local_handle(&entry, &mut opened, b"must not write", false).unwrap_err();
        assert!(error.starts_with("CONFLICT:"));
        assert_eq!(fs::read(&file.path).unwrap(), b"external content");
        assert_eq!(fs::read(entry.cache_path.as_ref().unwrap()).unwrap(), CRLF);
        // A fresh handle starts at byte zero and truncates only after writing.
        let mut opened = fs::OpenOptions::new().write(true).open(&file.path).unwrap();
        save_local_handle(&entry, &mut opened, b"x", true).unwrap();
        assert_eq!(fs::read(&file.path).unwrap(), b"x");
    }
    #[tokio::test]
    async fn backup_uses_known_baseline_even_when_force_overwrites_external_changes() {
        let file = TestFile::new();
        let mut entry = file.entry();
        let ssh = SshManager::default();
        load(&mut entry, 1, &ssh).await.unwrap();
        fs::write(&file.path, b"external").unwrap();
        save_entry(&mut entry, &ssh, b"saved", true).await.unwrap();
        assert_eq!(fs::read(entry.cache_path.as_ref().unwrap()).unwrap(), CRLF);
        save_entry(&mut entry, &ssh, b"next", false).await.unwrap();
        assert_eq!(
            fs::read(entry.cache_path.as_ref().unwrap()).unwrap(),
            b"saved"
        );
        fs::remove_file(&file.path).unwrap();
        let error = save_entry(&mut entry, &ssh, b"retained", false)
            .await
            .unwrap_err();
        assert_eq!(error, write_failed(entry.cache_path.as_deref()));
        assert_eq!(
            fs::read(entry.cache_path.as_ref().unwrap()).unwrap(),
            b"next"
        );
        assert_eq!(entry.baseline, b"next");
    }
    #[test]
    fn cleanup_removes_only_unlocked_instance_directories() {
        let file = TestFile::new();
        let root = file.dir.join("instances");
        fs::create_dir_all(&root).unwrap();
        let live = root.join("live");
        let stale = root.join("stale");
        let unknown = root.join("legacy");
        for path in [&live, &stale, &unknown] {
            fs::create_dir(path).unwrap();
            fs::write(path.join("backup"), b"keep").unwrap();
        }
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(live.join("instance.lock"))
            .unwrap();
        lock.try_lock().unwrap();
        fs::write(stale.join("instance.lock"), b"").unwrap();
        clean_stale_instances(&root).unwrap();
        assert!(live.join("backup").exists());
        assert!(!stale.exists());
        assert!(unknown.join("backup").exists());
        drop(lock);
        // Parallel tests spawn processes; a child between fork and exec briefly
        // shares the lock descriptor, so allow the lock a moment to be released.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            clean_stale_instances(&root).unwrap();
            if !live.exists() || std::time::Instant::now() > deadline {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(!live.exists());
    }
    #[test]
    fn instance_marker_is_published_with_its_lock_already_held() {
        let file = TestFile::new();
        let root = file.dir.join("instances");
        fs::create_dir(&root).unwrap();
        let instance = create_instance_cache(&root).unwrap();
        let path = instance.path.clone();
        assert!(path.join("instance.lock").exists());
        assert!(!path.join("initializing.lock").exists());
        clean_stale_instances(&root).unwrap();
        assert!(path.exists());
        drop(instance);
        clean_stale_instances(&root).unwrap();
        assert!(!path.exists());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn replacement_identity_conflicts_even_with_equal_size_and_timestamp() {
        let file = TestFile::new();
        let mut entry = file.entry();
        let ssh = SshManager::default();
        load(&mut entry, 1, &ssh).await.unwrap();
        let previous = fs::metadata(&file.path).unwrap();
        let replacement = file.dir.join("replacement");
        fs::write(&replacement, CRLF).unwrap();
        let handle = fs::OpenOptions::new()
            .write(true)
            .open(&replacement)
            .unwrap();
        handle
            .set_times(fs::FileTimes::new().set_modified(previous.modified().unwrap()))
            .unwrap();
        fs::rename(&replacement, &file.path).unwrap();
        assert!(
            save_entry(&mut entry, &ssh, b"bad", false)
                .await
                .unwrap_err()
                .starts_with("CONFLICT:")
        );
        assert_eq!(fs::read(&file.path).unwrap(), CRLF);
    }
}
