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
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State};

use crate::ui_error::ui_err;

static SERIAL: AtomicU64 = AtomicU64::new(0);
const LIMIT: usize = 1024 * 1024;
const POINTER: &str = "data-location.json";
const FILES: [&str; 4] = [
    "sessions.json",
    "tunnels.json",
    "macros.json",
    "settings.json",
];
const DIRECTORIES: [&str; 3] = ["designs", "icon-sets", "fonts"];
/// Exact marker the frontend matches to detect a concurrent change of settings.json.
const SETTINGS_CONFLICT: &str = crate::ui_error::ui_code("SETTINGS_CONFLICT");

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
    /// Only for directories: digest over name, kind, size and modification time of every
    /// entry, so renames and changes below the newest timestamp are noticed as well.
    #[serde(skip_serializing_if = "Option::is_none")]
    digest: Option<u64>,
    /// Only for directories whose root could not be read: the frontend keeps its old baseline.
    #[serde(skip_serializing_if = "is_false")]
    unreadable: bool,
}
fn is_false(value: &bool) -> bool {
    !*value
}
/// Bounds for the directory fingerprint: designs/ and fonts/ are flat, icon-sets/ has one level of sets.
#[derive(Clone, Copy)]
struct TreeLimits {
    depth: usize,
    entries: usize,
}
const TREE_LIMITS: TreeLimits = TreeLimits {
    depth: 3,
    entries: 5000,
};
/// JavaScript numbers are exact up to 2^53; the digest is masked so it survives JSON.
const DIGEST_MASK: u64 = (1 << 53) - 1;

fn config(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| ui_err("CONFIG_DIR_UNAVAILABLE").detail(e).into())
}

fn validate_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(ui_err("DATA_DIR_NOT_ABSOLUTE").into());
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(ui_err("DATA_DIR_PARENT").into());
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
        Err(e) => return Err(ui_err("POINTER_READ_FAILED").detail(e).into()),
    };
    match parse_pointer(&bytes) {
        Parsed::Valid(dir) => Ok(Some(dir)),
        Parsed::UnknownVersion => Err(ui_err("POINTER_UNKNOWN_VERSION").into()),
        Parsed::Malformed => {
            back_up_pointer(config)?;
            Ok(None)
        }
    }
}

/// Moves the pointer to the first free `data-location.json.bak[.N]`; older backups stay.
fn back_up_pointer(config: &Path) -> Result<(), String> {
    let path = config.join(POINTER);
    let error = |e: std::io::Error| String::from(ui_err("POINTER_BACKUP_FAILED").detail(e));
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
    Err(ui_err("POINTER_BACKUP_LIMIT").into())
}

fn reset_pointer_at(config: &Path) -> Result<DataDirStatus, String> {
    match fs::symlink_metadata(config.join(POINTER)) {
        Ok(_) => back_up_pointer(config)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(ui_err("POINTER_READ_FAILED").detail(e).into()),
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
        Some(path) if !path.is_dir() => Err(ui_err("DATA_DIR_UNREACHABLE")
            .arg("path", path.display().to_string())
            .into()),
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
    retrying(|| fs::rename(from, to))
}

/// `remove` (`fs::remove_file` or `fs::remove_dir`) with the retries of [`rename_retrying`].
fn remove_retrying(path: &Path, remove: fn(&Path) -> std::io::Result<()>) -> std::io::Result<()> {
    retrying(|| remove(path))
}

fn retrying(mut operation: impl FnMut() -> std::io::Result<()>) -> std::io::Result<()> {
    let mut attempt = 0;
    loop {
        match operation() {
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
        .ok_or_else(|| std::io::Error::other("invalid path"))?;
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

/// Identity of a directory (device and inode). Windows offers no stable file index without
/// an extra dependency, so there only the symlink check of the parent chain applies.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Identity(u64, u64);

#[cfg(unix)]
fn identity(metadata: &fs::Metadata) -> Option<Identity> {
    use std::os::unix::fs::MetadataExt;
    Some(Identity(metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
fn identity(_: &fs::Metadata) -> Option<Identity> {
    None
}

/// True if `metadata` still belongs to the recorded entry; without identities (Windows) the
/// caller relies on the other checks.
fn same_identity(recorded: Option<Identity>, metadata: &fs::Metadata) -> bool {
    identity(metadata).is_none_or(|now| recorded == Some(now))
}

/// What the journal knows about a created entry, to recognize it again before removing it.
#[derive(Debug)]
enum Created {
    Directory(Option<Identity>),
    /// Size and modification time after the copy; a sync client may replace the file.
    File {
        len: u64,
        modified: SystemTime,
    },
}

/// Entries newly created at the target by `set_at`, in creation order, so a failed switch
/// can remove exactly what it added. Pre-existing entries are never recorded.
#[derive(Default)]
struct Journal {
    created: Vec<(PathBuf, Created)>,
    /// Deepest pre-existing folder of the target path and its identity; everything recorded
    /// lies below it.
    root: Option<(PathBuf, Option<Identity>)>,
    /// Topmost folder created for the target path itself.
    top: Option<PathBuf>,
    #[cfg(test)]
    faults: Faults,
}

/// Test-only failure injection.
#[cfg(test)]
#[derive(Default)]
struct Faults {
    /// Creating a new entry fails once this many entries are recorded.
    create_after: Option<usize>,
    /// Removing these entries during rollback fails.
    keep: Vec<PathBuf>,
    /// Writing the pointer fails.
    pointer: bool,
}

fn replaced() -> std::io::Error {
    std::io::Error::other("entry was replaced")
}

impl Journal {
    fn before_create(&self) -> std::io::Result<()> {
        #[cfg(test)]
        if self
            .faults
            .create_after
            .is_some_and(|limit| self.created.len() >= limit)
        {
            return Err(std::io::Error::other("injected copy failure"));
        }
        Ok(())
    }

    fn before_pointer(&self) -> std::io::Result<()> {
        #[cfg(test)]
        if self.faults.pointer {
            return Err(std::io::Error::other("injected pointer failure"));
        }
        Ok(())
    }

    /// Without a readable identity a directory is kept on Unix (counted as remaining).
    fn record_directory(&mut self, path: &Path) {
        let id = fs::symlink_metadata(path)
            .ok()
            .and_then(|metadata| identity(&metadata));
        self.created.push((path.to_owned(), Created::Directory(id)));
    }

    fn record_file(&mut self, path: &Path) -> std::io::Result<()> {
        let metadata = fs::symlink_metadata(path)?;
        let modified = metadata.modified()?;
        self.created.push((
            path.to_owned(),
            Created::File {
                len: metadata.len(),
                modified,
            },
        ));
        Ok(())
    }

    /// Checks that the root is unchanged and every folder between it and `path` is a real
    /// folder, so removing never follows a symlink or junction. `false`: the chain is gone,
    /// and with it the entry.
    fn chain_intact(&self, path: &Path) -> std::io::Result<bool> {
        let (root, root_id) = self
            .root
            .as_ref()
            .ok_or_else(|| std::io::Error::other("no root"))?;
        let relative = path.strip_prefix(root).map_err(|_| replaced())?;
        let not_found = |e: &std::io::Error| e.kind() == std::io::ErrorKind::NotFound;
        match fs::metadata(root) {
            Ok(m) if m.is_dir() && same_identity(*root_id, &m) => (),
            Ok(_) => return Err(replaced()),
            Err(e) if not_found(&e) => return Ok(false),
            Err(e) => return Err(e),
        }
        let mut current = root.clone();
        let mut components = relative.components().peekable();
        while let Some(component) = components.next() {
            if components.peek().is_none() {
                break;
            }
            current.push(component);
            match fs::symlink_metadata(&current) {
                Ok(m) if m.is_dir() && !m.is_symlink() => (),
                Ok(_) => return Err(replaced()),
                Err(e) if not_found(&e) => return Ok(false),
                Err(e) => return Err(e),
            }
        }
        Ok(true)
    }

    fn remove(&self, path: &Path, created: &Created) -> std::io::Result<()> {
        #[cfg(test)]
        if self.faults.keep.iter().any(|keep| keep == path) {
            return Err(std::io::Error::other("injected cleanup failure"));
        }
        if !self.chain_intact(path)? {
            return Ok(());
        }
        // Never follow or remove a symlink or other entry that replaced a recorded one.
        let metadata = match fs::symlink_metadata(path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        };
        if metadata.is_symlink() {
            return Err(replaced());
        }
        match created {
            Created::Directory(id) => {
                if !metadata.is_dir() || !same_identity(*id, &metadata) {
                    return Err(replaced());
                }
                // Only empty directories go; foreign content stays.
                remove_retrying(path, |p| fs::remove_dir(p))
            }
            Created::File { len, modified } => {
                if !metadata.is_file()
                    || metadata.len() != *len
                    || metadata.modified().ok() != Some(*modified)
                {
                    return Err(replaced());
                }
                remove_retrying(path, |p| fs::remove_file(p))
            }
        }
    }

    /// Removes the recorded entries in reverse order and returns how many remain.
    fn rollback(&self) -> usize {
        let mut remaining = 0;
        for (path, created) in self.created.iter().rev() {
            if self.remove(path, created).is_err() {
                remaining += 1;
            }
        }
        remaining
    }
}

/// `fs::create_dir_all` that records every directory it creates.
fn create_dirs(target: &Path, journal: &mut Journal) -> std::io::Result<()> {
    let missing: Vec<&Path> = target
        .ancestors()
        .take_while(|path| {
            matches!(fs::symlink_metadata(path), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
        })
        .collect();
    journal.root = target
        .ancestors()
        .nth(missing.len())
        .and_then(|root| Some((root.to_owned(), identity(&fs::metadata(root).ok()?))));
    for path in missing.into_iter().rev() {
        match fs::create_dir(path) {
            Ok(()) => {
                journal.top.get_or_insert_with(|| path.to_owned());
                journal.record_directory(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Rolls back the journal and adds the outcome to the original error. The path named is the
/// topmost folder the switch created, so the remaining entries all lie below it.
fn rolled_back(error: String, journal: &Journal, target: &Path) -> String {
    if journal.created.is_empty() {
        return error;
    }
    match journal.rollback() {
        0 => ui_err("DATA_DIR_COPY_ROLLED_BACK")
            .arg("error", error)
            .into(),
        remaining => ui_err("DATA_DIR_COPY_ROLLBACK_INCOMPLETE")
            .arg("error", error)
            .arg("count", remaining.to_string())
            .arg(
                "path",
                journal
                    .top
                    .as_deref()
                    .unwrap_or(target)
                    .display()
                    .to_string(),
            )
            .into(),
    }
}

/// Copies regular files and directories; symlinks and special files are skipped,
/// existing targets are never overwritten. Every created entry goes into the journal.
fn copy_entry(source: &Path, target: &Path, journal: &mut Journal) -> std::io::Result<()> {
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
        journal.before_create()?;
        let mut output = match options().open(target) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
            Err(e) => return Err(e),
        };
        let copied = std::io::copy(&mut input, &mut output).and_then(|_| output.sync_all());
        drop(output);
        // Size and time are taken from the closed file, as the rollback will see it.
        if let Err(e) = copied.and_then(|()| journal.record_file(target)) {
            let _ = remove_retrying(target, |p| fs::remove_file(p));
            return Err(e);
        }
    } else if metadata.is_dir() {
        match existing {
            Some(m) if m.is_symlink() || !m.is_dir() => return Ok(()),
            Some(_) => (),
            None => {
                journal.before_create()?;
                fs::create_dir(target)?;
                journal.record_directory(target);
            }
        }
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_entry(&entry.path(), &target.join(entry.file_name()), journal)?;
        }
    }
    Ok(())
}

fn copy_data(source: &Path, target: &Path, journal: &mut Journal) -> Result<(), String> {
    if same(source, target) {
        return Ok(());
    }
    if within(target, source) || within(source, target) {
        return Err(ui_err("DATA_DIR_NESTED").into());
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
            Err(e) => return Err(read_failed(name, e)),
        };
        let expected = if directory {
            metadata.is_dir()
        } else {
            metadata.is_file()
        };
        if !metadata.is_symlink() && expected {
            copy_entry(&input, &target.join(name), journal).map_err(|e| {
                String::from(ui_err("DATA_FILE_COPY_FAILED").arg("name", name).detail(e))
            })?;
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
    set_with(config, cache, path, copy_current, &mut Journal::default())
}

/// A failure after the target was touched removes everything this call created there
/// (see [`Journal`]); the pointer is written last, so it never points to a partial copy.
fn set_with(
    config: &Path,
    cache: &Path,
    path: Option<PathBuf>,
    copy_current: bool,
    journal: &mut Journal,
) -> Result<DataDirStatus, String> {
    if let Some(path) = &path {
        validate_path(path)?;
    }
    let target = path.as_deref().unwrap_or(config);
    if within(target, cache) {
        return Err(ui_err("DATA_DIR_IN_CACHE").into());
    }
    let current = current_at(config)?;
    if !same(target, &current) && (within(target, &current) || within(&current, target)) {
        return Err(ui_err("DATA_DIR_NESTED").into());
    }
    // An unreachable source fails before anything is created at the target.
    let source = if copy_current {
        Some(resolve_at(config)?)
    } else {
        None
    };
    // Choosing the default folder by path is stored as the default.
    let stored = path.as_deref().filter(|path| !same(path, config));
    let switched = (|| {
        create_dirs(target, journal)
            .map_err(|e| String::from(ui_err("DATA_DIR_CREATE_FAILED").detail(e)))?;
        if !target.is_dir() {
            return Err(ui_err("DATA_DIR_NOT_DIR").into());
        }
        writable(target).map_err(|e| String::from(ui_err("DATA_DIR_NOT_WRITABLE").detail(e)))?;
        if let Some(source) = &source {
            copy_data(source, target, journal)?;
        }
        let bytes = serde_json::to_vec(&Pointer {
            version: 1,
            data_dir: stored.map(Path::to_path_buf),
        })
        .map_err(|e| String::from(ui_err("POINTER_SAVE_FAILED").detail(e)))?;
        journal
            .before_pointer()
            .and_then(|()| atomic(&config.join(POINTER), &bytes))
            .map_err(|e| String::from(ui_err("POINTER_SAVE_FAILED").detail(e)))?;
        Ok(())
    })();
    switched.map_err(|error| rolled_back(error, journal, target))?;
    status_at(config)
}

fn validate_settings(json: &str) -> Result<(), String> {
    if json.len() > LIMIT {
        return Err(too_large());
    }
    let value = serde_json::from_str::<serde_json::Value>(json)
        .map_err(|e| String::from(ui_err("SETTINGS_INVALID_JSON").json_position(&e)))?;
    if !value.is_object() {
        return Err(ui_err("SETTINGS_NOT_OBJECT").into());
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
    let error = |e: std::io::Error| String::from(ui_err("SETTINGS_READ_FAILED").detail(e));
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(error(e)),
    };
    for _ in 0..3 {
        let before = stamp(&file.metadata().map_err(error)?);
        if before.size > LIMIT as u64 {
            return Err(too_large());
        }
        file.rewind().map_err(error)?;
        let mut bytes = Vec::new();
        (&mut file)
            .take(LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(error)?;
        if bytes.len() > LIMIT {
            return Err(too_large());
        }
        if stamp(&file.metadata().map_err(error)?) != before {
            continue;
        }
        let json =
            String::from_utf8(bytes).map_err(|_| String::from(ui_err("SETTINGS_NOT_UTF8")))?;
        return Ok(Some(SettingsFile {
            json,
            modified_ms: before.modified_ms,
            size: before.size,
        }));
    }
    Err(ui_err("SETTINGS_CHANGING").into())
}

fn too_large() -> String {
    ui_err("SETTINGS_TOO_LARGE").arg("limit", "1 MiB").into()
}

fn read_failed(name: &str, error: std::io::Error) -> String {
    ui_err("DATA_FILE_READ_FAILED")
        .arg("name", name)
        .detail(error)
        .into()
}

/// `base == None` expects no file; otherwise the existing file must carry `base`.
fn save_settings(dir: &Path, json: &str, base: Option<Stamp>) -> Result<Stamp, String> {
    validate_settings(json)?;
    let path = dir.join("settings.json");
    let current = match fs::metadata(&path) {
        Ok(metadata) => Some(stamp(&metadata)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(ui_err("SETTINGS_READ_FAILED").detail(e).into()),
    };
    if current != base {
        return Err(SETTINGS_CONFLICT.into());
    }
    atomic(&path, json.as_bytes())
        .map(|metadata| stamp(&metadata))
        .map_err(|e| ui_err("SETTINGS_SAVE_FAILED").detail(e).into())
}

fn fingerprint_at(dir: &Path) -> Result<Vec<FileStamp>, String> {
    fingerprint_with(dir, directory_stamp)
}

/// File stamps plus one aggregate per data directory. A directory that cannot be read is
/// reported as `unreadable` instead of failing the whole fingerprint.
fn fingerprint_with(
    dir: &Path,
    directory: impl Fn(&Path) -> std::io::Result<Option<FileStamp>>,
) -> Result<Vec<FileStamp>, String> {
    let mut stamps = Vec::new();
    for name in FILES {
        let metadata = match fs::metadata(dir.join(name)) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(read_failed(name, e)),
        };
        let Stamp { modified_ms, size } = stamp(&metadata);
        stamps.push(FileStamp {
            name: name.into(),
            modified_ms,
            size,
            digest: None,
            unreadable: false,
        });
    }
    for name in DIRECTORIES {
        let label = format!("{name}/");
        match directory(&dir.join(name)) {
            Ok(Some(stamp)) => stamps.push(FileStamp {
                name: label,
                ..stamp
            }),
            Ok(None) => (),
            Err(_) => stamps.push(FileStamp {
                name: label,
                modified_ms: 0,
                size: 0,
                digest: None,
                unreadable: true,
            }),
        }
    }
    Ok(stamps)
}

const KIND_FILE: u8 = 0;
const KIND_DIR: u8 = 1;
const KIND_SYMLINK: u8 = 2;
const KIND_UNREADABLE: u8 = 3;

struct TreeEntry {
    path: String,
    kind: u8,
    stamp: Stamp,
}

type ReadDirFn<'a> = &'a dyn Fn(&Path) -> std::io::Result<fs::ReadDir>;

struct Walk<'a> {
    limits: TreeLimits,
    read: ReadDirFn<'a>,
    entries: Vec<TreeEntry>,
    truncated: bool,
}

impl Walk<'_> {
    /// Unreadable parts below the root (permissions, cloud placeholders, I/O errors) become a
    /// marker entry, so the walk goes on and a later recovery still changes the digest.
    fn mark(&mut self, path: &str, error: &std::io::Error) {
        self.entries.push(TreeEntry {
            path: format!("{path}!{:?}", error.kind()),
            kind: KIND_UNREADABLE,
            stamp: Stamp {
                modified_ms: 0,
                size: 0,
            },
        });
    }

    /// Collects the entries below `dir` without following symlinks (they are recorded, not
    /// entered). Entries that vanish during the walk are skipped. Only a failure to read the
    /// root itself is an error.
    fn walk(&mut self, dir: &Path, prefix: &str, depth: usize) -> std::io::Result<()> {
        let reader = match (self.read)(dir) {
            Ok(reader) => reader,
            Err(e) if depth == 0 => return Err(e),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => {
                self.mark(prefix, &e);
                return Ok(());
            }
        };
        for entry in reader {
            if self.entries.len() >= self.limits.entries {
                self.truncated = true;
                return Ok(());
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(e) => {
                    self.mark(prefix, &e);
                    break;
                }
            };
            let path = format!("{prefix}{}", entry.file_name().to_string_lossy());
            // DirEntry::metadata does not follow symlinks on any platform.
            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => {
                    self.mark(&path, &e);
                    continue;
                }
            };
            let kind = if metadata.is_symlink() {
                KIND_SYMLINK
            } else if metadata.is_dir() {
                KIND_DIR
            } else {
                KIND_FILE
            };
            self.entries.push(TreeEntry {
                path: path.clone(),
                kind,
                stamp: stamp(&metadata),
            });
            if kind == KIND_DIR && depth + 1 < self.limits.depth {
                self.walk(&entry.path(), &format!("{path}/"), depth + 1)?;
            }
        }
        Ok(())
    }
}

fn directory_stamp(dir: &Path) -> std::io::Result<Option<FileStamp>> {
    directory_stamp_with(dir, TREE_LIMITS, &|path| fs::read_dir(path))
}

/// Aggregate stamp of a data directory: newest modification time (including the directory
/// itself), total file size and a digest over all entries. A missing directory has no stamp.
fn directory_stamp_with(
    dir: &Path,
    limits: TreeLimits,
    read: ReadDirFn<'_>,
) -> std::io::Result<Option<FileStamp>> {
    let root = match fs::metadata(dir) {
        Ok(m) if m.is_dir() => m,
        Ok(_) => return Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut walk = Walk {
        limits,
        read,
        entries: Vec::new(),
        truncated: false,
    };
    walk.walk(dir, "", 0)?;
    let truncated = walk.truncated;
    let mut entries = walk.entries;
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    // FNV-1a: stable across runs and platforms, unlike the std hasher.
    let mut digest: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |bytes: &[u8]| {
        for byte in bytes {
            digest = (digest ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3);
        }
    };
    let root = stamp(&root);
    let mut newest = root.modified_ms;
    let mut size = 0u64;
    feed(&(entries.len() as u64).to_le_bytes());
    feed(&[u8::from(truncated)]);
    for entry in &entries {
        feed(entry.path.as_bytes());
        feed(&[0, entry.kind]);
        feed(&entry.stamp.size.to_le_bytes());
        feed(&entry.stamp.modified_ms.to_le_bytes());
        newest = newest.max(entry.stamp.modified_ms);
        if entry.kind == KIND_FILE {
            size = size.saturating_add(entry.stamp.size);
        }
    }
    Ok(Some(FileStamp {
        name: String::new(),
        modified_ms: newest,
        size,
        digest: Some(digest & DIGEST_MASK),
        unreadable: false,
    }))
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| String::from(ui_err("BACKGROUND_TASK_FAILED").detail(e)))?
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
        .map_err(|e| String::from(ui_err("CACHE_DIR_UNAVAILABLE").detail(e)))?;
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
    use crate::ui_error::code_of;

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
        assert_eq!(
            code_of(&resolve_at(&config).unwrap_err()),
            Some("DATA_DIR_UNREACHABLE")
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
        fs::create_dir_all(source.join("fonts")).unwrap();
        fs::write(source.join("fonts").join("example.ttf"), b"font").unwrap();
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

        copy_data(&source, &target, &mut Journal::default()).unwrap();

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
        assert_eq!(
            fs::read(target.join("fonts").join("example.ttf")).unwrap(),
            b"font"
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
        copy_data(&source, &target, &mut Journal::default()).unwrap();
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
                "DATA_DIR_IN_CACHE"
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
        assert!(copy_data(&config, &nested, &mut Journal::default()).is_err());
        assert!(!nested.exists());
    }

    #[test]
    fn unreachable_current_dir_still_allows_switch_without_copy() {
        let temp = Temp::new();
        let config = temp.dir("config");
        let cache = temp.0.join("cache");
        write_pointer(&config, Some(temp.0.join("gone")));
        let target = temp.0.join("fresh");
        assert_eq!(
            code_of(&set_at(&config, &cache, Some(target.clone()), true).unwrap_err()),
            Some("DATA_DIR_UNREACHABLE")
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
        // Validation errors carry their own code, not the conflict marker.
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
        assert!(stamps[0].digest.is_none());
    }

    fn dir_stamp(dir: &Path, name: &str) -> Option<(u64, u64, u64)> {
        fingerprint_at(dir)
            .unwrap()
            .into_iter()
            .find(|s| s.name == name)
            .map(|s| (s.modified_ms, s.size, s.digest.unwrap()))
    }

    fn write_at(path: &Path, bytes: &[u8], seconds: u64) {
        fs::write(path, bytes).unwrap();
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_secs(seconds))
            .unwrap();
    }

    #[test]
    fn fingerprint_aggregates_directories() {
        let temp = Temp::new();
        assert!(dir_stamp(&temp.0, "designs/").is_none());
        assert!(dir_stamp(&temp.0, "icon-sets/").is_none());
        let designs = temp.dir("designs");
        let empty = dir_stamp(&temp.0, "designs/").unwrap();
        assert_eq!(empty.1, 0);

        write_at(&designs.join("a.json"), b"12345", 2_000_000);
        let added = dir_stamp(&temp.0, "designs/").unwrap();
        assert_eq!(added.1, 5);
        assert_ne!(added.2, empty.2);
        // Stable while nothing changes.
        assert_eq!(dir_stamp(&temp.0, "designs/"), Some(added));

        // An older file with the same size still changes the digest.
        write_at(&designs.join("b.json"), b"x", 1_000_000);
        let second = dir_stamp(&temp.0, "designs/").unwrap();
        write_at(&designs.join("b.json"), b"y", 1_000_001);
        let changed = dir_stamp(&temp.0, "designs/").unwrap();
        assert_eq!(changed.1, second.1);
        assert_ne!(changed.2, second.2);

        // Rename keeping size and time, then delete.
        fs::rename(designs.join("b.json"), designs.join("c.json")).unwrap();
        let renamed = dir_stamp(&temp.0, "designs/").unwrap();
        assert_ne!(renamed.2, changed.2);
        fs::remove_file(designs.join("c.json")).unwrap();
        let removed = dir_stamp(&temp.0, "designs/").unwrap();
        assert_eq!(removed.1, 5);
        assert_ne!(removed.2, renamed.2);

        fs::remove_dir_all(&designs).unwrap();
        assert!(dir_stamp(&temp.0, "designs/").is_none());
    }

    #[test]
    fn fingerprint_sees_files_inside_icon_sets() {
        let temp = Temp::new();
        let set = temp.dir("icon-sets").join("set-1");
        fs::create_dir_all(&set).unwrap();
        write_at(&set.join("folder.svg"), b"<svg/>", 1_000_000);
        let before = dir_stamp(&temp.0, "icon-sets/").unwrap();
        assert_eq!(before.1, 6);
        write_at(&set.join("folder.svg"), b"<svg />", 1_000_000);
        let after = dir_stamp(&temp.0, "icon-sets/").unwrap();
        assert_eq!(after.1, 7);
        assert_ne!(after.2, before.2);
        assert!(after.2 <= DIGEST_MASK);
        fs::remove_file(set.join("folder.svg")).unwrap();
        assert_ne!(dir_stamp(&temp.0, "icon-sets/").unwrap().2, after.2);
    }

    #[test]
    fn directory_stamp_json_shape() {
        let temp = Temp::new();
        temp.dir("designs");
        let stamps = fingerprint_at(&temp.0).unwrap();
        let value = serde_json::to_value(&stamps).unwrap();
        let entry = value.as_array().unwrap().first().unwrap();
        assert_eq!(entry["name"], "designs/");
        assert!(entry["digest"].is_u64() && entry["modifiedMs"].is_u64());
        assert!(entry.get("unreadable").is_none());
    }

    #[test]
    fn unreadable_directory_keeps_file_stamps() {
        let temp = Temp::new();
        fs::write(temp.0.join("sessions.json"), b"12345").unwrap();
        temp.dir("designs");
        let stamps = fingerprint_with(&temp.0, |path| {
            if path.ends_with("designs") {
                Err(std::io::ErrorKind::PermissionDenied.into())
            } else {
                directory_stamp(path)
            }
        })
        .unwrap();
        assert_eq!(stamps.len(), 2);
        assert_eq!(stamps[0].name, "sessions.json");
        assert_eq!(stamps[1].name, "designs/");
        assert!(stamps[1].unreadable && stamps[1].digest.is_none());
        let value = serde_json::to_value(&stamps).unwrap();
        assert_eq!(value[1]["unreadable"], true);
    }

    #[test]
    fn unreadable_subfolder_becomes_a_marker() {
        let temp = Temp::new();
        let sets = temp.dir("icon-sets");
        let set = sets.join("set-1");
        fs::create_dir_all(&set).unwrap();
        write_at(&set.join("folder.svg"), b"<svg/>", 1_000_000);
        let read = |path: &Path| fs::read_dir(path);
        let fail = |path: &Path| {
            if path.ends_with("set-1") {
                Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
            } else {
                fs::read_dir(path)
            }
        };
        let readable = directory_stamp_with(&sets, TREE_LIMITS, &read)
            .unwrap()
            .unwrap();
        let blocked = directory_stamp_with(&sets, TREE_LIMITS, &fail)
            .unwrap()
            .unwrap();
        assert_ne!(blocked.digest, readable.digest);
        assert_eq!(blocked.size, 0);
        // The root itself failing is an error (reported as unreadable by fingerprint_at).
        let root_fails = |_: &Path| Err(std::io::Error::other("io"));
        assert!(directory_stamp_with(&sets, TREE_LIMITS, &root_fails).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn permission_denied_subfolder_does_not_fail_fingerprint() {
        use std::os::unix::fs::PermissionsExt;
        let temp = Temp::new();
        fs::write(temp.0.join("macros.json"), b"[]").unwrap();
        let set = temp.dir("icon-sets").join("locked");
        fs::create_dir_all(&set).unwrap();
        fs::write(set.join("a.svg"), b"<svg/>").unwrap();
        fs::set_permissions(&set, fs::Permissions::from_mode(0o000)).unwrap();
        let result = fingerprint_at(&temp.0);
        fs::set_permissions(&set, fs::Permissions::from_mode(0o700)).unwrap();
        let stamps = result.unwrap();
        assert!(stamps.iter().any(|s| s.name == "macros.json"));
        let sets = stamps.iter().find(|s| s.name == "icon-sets/").unwrap();
        assert!(!sets.unreadable && sets.digest.is_some());
    }

    #[test]
    fn depth_and_entry_limits_bound_the_walk() {
        let temp = Temp::new();
        let root = temp.dir("designs");
        let deep = root.join("a").join("b").join("c");
        fs::create_dir_all(&deep).unwrap();
        let inside = root.join("a").join("b").join("inside.txt");
        write_at(&inside, b"1", 1_000_000);
        write_at(&deep.join("beyond.txt"), b"1", 1_000_000);
        let visited = std::cell::RefCell::new(Vec::new());
        let tracking = |p: &Path| {
            visited.borrow_mut().push(p.to_path_buf());
            fs::read_dir(p)
        };
        let stamp = directory_stamp_with(&root, TREE_LIMITS, &tracking)
            .unwrap()
            .unwrap();
        // Levels 0..=2 are read; a/b/c (level 3) is recorded as an entry but not entered.
        let visited = visited.into_inner();
        assert!(visited.contains(&root.join("a").join("b")));
        assert!(!visited.contains(&deep));
        assert_eq!(stamp.size, 1);
        let read = |p: &Path| fs::read_dir(p);
        let before = stamp;
        write_at(&inside, b"22", 1_000_000);
        let after = directory_stamp_with(&root, TREE_LIMITS, &read)
            .unwrap()
            .unwrap();
        assert_ne!(after.digest, before.digest);

        let flat = temp.dir("flat");
        for index in 0..5 {
            write_at(&flat.join(format!("{index}.json")), b"x", 1_000_000);
        }
        let small = TreeLimits {
            depth: 3,
            entries: 3,
        };
        let limited = directory_stamp_with(&flat, small, &read).unwrap().unwrap();
        assert_eq!(limited.size, 3);
        let full = directory_stamp_with(&flat, TREE_LIMITS, &read)
            .unwrap()
            .unwrap();
        assert_eq!(full.size, 5);
        assert_ne!(limited.digest, full.digest);
    }

    /// Args of a wire-format error (`CODE: {"args":{…}}`).
    fn args_of(error: &str) -> serde_json::Value {
        let (_, payload) = error.split_once(": ").unwrap();
        serde_json::from_str::<serde_json::Value>(payload).unwrap()["args"].clone()
    }

    /// Relative paths of all entries below `dir`, sorted.
    fn tree(dir: &Path) -> Vec<String> {
        fn walk(dir: &Path, prefix: &str, out: &mut Vec<String>) {
            for entry in fs::read_dir(dir).unwrap() {
                let entry = entry.unwrap();
                let name = format!("{prefix}{}", entry.file_name().to_string_lossy());
                out.push(name.clone());
                if entry.file_type().unwrap().is_dir() {
                    walk(&entry.path(), &format!("{name}/"), out);
                }
            }
        }
        let mut out = Vec::new();
        walk(dir, "", &mut out);
        out.sort();
        out
    }

    /// Current data folder with files, a nested design and an icon set.
    fn source_data(temp: &Temp) -> PathBuf {
        let config = temp.dir("config");
        fs::create_dir_all(config.join("designs").join("nested")).unwrap();
        fs::create_dir_all(config.join("icon-sets").join("set")).unwrap();
        for name in ["sessions.json", "tunnels.json", "macros.json"] {
            fs::write(config.join(name), name).unwrap();
        }
        fs::write(config.join("designs").join("a.json"), b"a").unwrap();
        fs::write(config.join("designs").join("nested").join("b.json"), b"b").unwrap();
        fs::write(config.join("icon-sets").join("set").join("i.svg"), b"svg").unwrap();
        config
    }

    fn failing_copy(after: usize) -> Journal {
        let mut journal = Journal::default();
        journal.faults.create_after = Some(after);
        journal
    }

    #[test]
    fn failed_copy_into_new_folder_removes_everything_created() {
        let temp = Temp::new();
        let config = source_data(&temp);
        let before = tree(&config);
        let parent = temp.0.join("new");
        let target = parent.join("data");
        // Fails while copying designs/, after files and directories were already created.
        let error = set_with(
            &config,
            &temp.0.join("cache"),
            Some(target.clone()),
            true,
            &mut failing_copy(6),
        )
        .unwrap_err();
        assert_eq!(code_of(&error), Some("DATA_DIR_COPY_ROLLED_BACK"));
        let inner = args_of(&error)["error"].as_str().unwrap().to_owned();
        assert_eq!(code_of(&inner), Some("DATA_FILE_COPY_FAILED"));
        assert!(inner.contains("injected copy failure"));
        assert!(!parent.exists(), "created parent folders are removed too");
        assert!(!config.join(POINTER).exists());
        assert_eq!(tree(&config), before);
    }

    #[test]
    fn failed_copy_keeps_existing_target_entries() {
        let temp = Temp::new();
        let config = source_data(&temp);
        let target = temp.dir("target");
        fs::create_dir_all(target.join("designs")).unwrap();
        fs::write(target.join("sessions.json"), b"shared").unwrap();
        fs::write(target.join("designs").join("a.json"), b"shared-a").unwrap();
        fs::write(target.join("notes.txt"), b"foreign").unwrap();
        let before = tree(&target);
        // Seven entries are new at the target; every earlier failure point is tried.
        for after in 0..7 {
            let error = set_with(
                &config,
                &temp.0.join("cache"),
                Some(target.clone()),
                true,
                &mut failing_copy(after),
            )
            .unwrap_err();
            assert!(
                matches!(
                    code_of(&error),
                    Some("DATA_DIR_COPY_ROLLED_BACK" | "DATA_FILE_COPY_FAILED")
                ),
                "{error}"
            );
            assert_eq!(tree(&target), before, "after {after}");
        }
        assert_eq!(fs::read(target.join("sessions.json")).unwrap(), b"shared");
        assert_eq!(
            fs::read(target.join("designs").join("a.json")).unwrap(),
            b"shared-a"
        );
        assert!(!config.join(POINTER).exists());
    }

    #[test]
    fn incomplete_cleanup_reports_remaining_entries() {
        let temp = Temp::new();
        let config = source_data(&temp);
        let parent = temp.0.join("new");
        let target = parent.join("data");
        let mut journal = failing_copy(6);
        journal.faults.keep = vec![target.join("tunnels.json")];
        let error = set_with(
            &config,
            &temp.0.join("cache"),
            Some(target.clone()),
            true,
            &mut journal,
        )
        .unwrap_err();
        assert_eq!(code_of(&error), Some("DATA_DIR_COPY_ROLLBACK_INCOMPLETE"));
        let args = args_of(&error);
        // tunnels.json plus the two folders that are therefore not empty, all below the
        // topmost created folder.
        assert_eq!(args["count"], "3");
        assert_eq!(args["path"], parent.display().to_string().as_str());
        assert_eq!(
            code_of(args["error"].as_str().unwrap()),
            Some("DATA_FILE_COPY_FAILED")
        );
        assert_eq!(tree(&parent), ["data", "data/tunnels.json"]);
        assert!(!config.join(POINTER).exists());

        // An existing target is named itself.
        let existing = temp.dir("existing");
        let mut journal = failing_copy(2);
        journal.faults.keep = vec![existing.join("tunnels.json")];
        let error = set_with(
            &config,
            &temp.0.join("cache"),
            Some(existing.clone()),
            true,
            &mut journal,
        )
        .unwrap_err();
        let args = args_of(&error);
        assert_eq!(args["count"], "1");
        assert_eq!(args["path"], existing.display().to_string().as_str());
        assert_eq!(tree(&existing), ["tunnels.json"]);
    }

    /// Journal of a copy of `designs/` from `source_data` into `target/designs`.
    fn copied_designs(temp: &Temp) -> (PathBuf, Journal) {
        let config = source_data(temp);
        let target = temp.0.join("target");
        let mut journal = Journal::default();
        create_dirs(&target, &mut journal).unwrap();
        copy_entry(
            &config.join("designs"),
            &target.join("designs"),
            &mut journal,
        )
        .unwrap();
        (target, journal)
    }

    #[test]
    fn rollback_keeps_files_changed_after_the_copy() {
        let temp = Temp::new();
        let (target, journal) = copied_designs(&temp);
        let designs = target.join("designs");
        // Same size, other time (a sync client replaced it) and other size.
        let a = designs.join("a.json");
        let time = fs::metadata(&a).unwrap().modified().unwrap();
        write_at(&a, b"x", 1_000_000);
        assert_ne!(fs::metadata(&a).unwrap().modified().unwrap(), time);
        fs::write(designs.join("nested").join("b.json"), b"longer").unwrap();
        // a.json, nested/b.json and the three folders above them stay.
        assert_eq!(journal.rollback(), 5);
        assert_eq!(fs::read(&a).unwrap(), b"x");
        assert_eq!(
            fs::read(designs.join("nested").join("b.json")).unwrap(),
            b"longer"
        );

        // Unchanged files go, together with the folders.
        let temp = Temp::new();
        let (target, journal) = copied_designs(&temp);
        assert_eq!(journal.rollback(), 0);
        assert!(!target.exists());
    }

    #[cfg(unix)]
    #[test]
    fn rollback_does_not_follow_a_replaced_parent_folder() {
        let temp = Temp::new();
        let (target, journal) = copied_designs(&temp);
        // Lookalike outside the target: same names, same size and time as the copies.
        let outside = temp.dir("outside");
        fs::create_dir_all(outside.join("designs").join("nested")).unwrap();
        for name in [PathBuf::from("a.json"), Path::new("nested").join("b.json")] {
            let copy = target.join("designs").join(&name);
            let twin = outside.join("designs").join(&name);
            fs::copy(&copy, &twin).unwrap();
            let time = fs::metadata(&copy).unwrap().modified().unwrap();
            fs::File::options()
                .write(true)
                .open(&twin)
                .unwrap()
                .set_modified(time)
                .unwrap();
        }
        let before = tree(&outside);
        fs::rename(&target, temp.0.join("moved")).unwrap();
        std::os::unix::fs::symlink(&outside, &target).unwrap();
        // target, designs, a.json, nested, nested/b.json all stay.
        assert_eq!(journal.rollback(), 5);
        assert_eq!(tree(&outside), before);
        assert!(fs::symlink_metadata(&target).unwrap().is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn rollback_keeps_a_folder_recreated_under_the_same_name() {
        let temp = Temp::new();
        let target = temp.0.join("target");
        let mut journal = Journal::default();
        create_dirs(&target, &mut journal).unwrap();
        // The old folder stays in use, so the new one surely has another inode.
        fs::rename(&target, temp.0.join("old")).unwrap();
        fs::create_dir(&target).unwrap();
        assert_eq!(journal.rollback(), 1);
        assert!(target.is_dir());
    }

    #[test]
    fn failed_pointer_write_rolls_back_the_copy() {
        let temp = Temp::new();
        let config = source_data(&temp);
        let target = temp.0.join("fresh");
        let mut journal = Journal::default();
        journal.faults.pointer = true;
        let error = set_with(
            &config,
            &temp.0.join("cache"),
            Some(target.clone()),
            true,
            &mut journal,
        )
        .unwrap_err();
        assert_eq!(code_of(&error), Some("DATA_DIR_COPY_ROLLED_BACK"));
        assert_eq!(
            code_of(args_of(&error)["error"].as_str().unwrap()),
            Some("POINTER_SAVE_FAILED")
        );
        assert!(!target.exists());
        assert!(!config.join(POINTER).exists());
        assert!(no_temp_files(&config));
        // Without copying into an existing folder nothing was created: plain error.
        let existing = temp.dir("existing");
        let mut journal = Journal::default();
        journal.faults.pointer = true;
        let error = set_with(
            &config,
            &temp.0.join("cache"),
            Some(existing.clone()),
            false,
            &mut journal,
        )
        .unwrap_err();
        assert_eq!(code_of(&error), Some("POINTER_SAVE_FAILED"));
        assert!(existing.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn rollback_does_not_follow_a_replacing_symlink() {
        let temp = Temp::new();
        let outside = temp.dir("outside");
        fs::write(outside.join("keep"), b"keep").unwrap();
        let created = temp.0.join("created");
        let mut journal = Journal::default();
        create_dirs(&created, &mut journal).unwrap();
        fs::remove_dir(&created).unwrap();
        std::os::unix::fs::symlink(&outside, &created).unwrap();
        assert_eq!(journal.rollback(), 1);
        assert!(fs::symlink_metadata(&created).unwrap().is_symlink());
        assert!(outside.join("keep").exists());
    }

    #[cfg(unix)]
    #[test]
    fn fingerprint_does_not_follow_symlinks_inside_directories() {
        let temp = Temp::new();
        let outside = temp.dir("outside");
        let designs = temp.dir("designs");
        std::os::unix::fs::symlink(&outside, designs.join("link")).unwrap();
        let before = dir_stamp(&temp.0, "designs/").unwrap();
        write_at(&outside.join("secret.json"), b"secret", 1_000_000);
        let after = dir_stamp(&temp.0, "designs/").unwrap();
        assert_eq!(before.1, 0);
        assert_eq!(after.1, 0);
        assert_eq!(after.2, before.2);
    }
}
