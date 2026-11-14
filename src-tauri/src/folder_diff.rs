use crate::ui_error::{UiError, code_of, ui_err};
use crate::{local_fs::wsl_unc_path, ssh::SshManager};
use russh_sftp::{
    client::{RawSftpSession, SftpSession, error::Error as SftpError},
    protocol::StatusCode,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::PathBuf,
    sync::{
        Arc, LazyLock, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::UNIX_EPOCH,
};
use tauri::{State, ipc::Channel};
use tokio::io::AsyncReadExt;

const MAX_ENTRIES: usize = 50_000;
const MAX_DEPTH: usize = 64;
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const BLOCK: usize = 64 * 1024;
static JOBS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = LazyLock::new(Mutex::default);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    path: String,
    session_id: Option<u32>,
    wsl_distro: Option<String>,
}
#[derive(Clone, Serialize)]
pub struct Entry {
    path: String,
    kind: String,
    size: u64,
    mtime: Option<u64>,
}
#[derive(Default, Serialize)]
pub struct Listing {
    entries: Vec<Entry>,
    truncated: bool,
}
#[derive(Default, Clone, Serialize)]
pub struct Progress {
    bytes: u64,
    files: u64,
    total: u64,
}
#[derive(Serialize)]
pub struct Comparison {
    left: Listing,
    right: Listing,
    content: HashMap<String, bool>,
    limited: bool,
}

fn err(e: impl std::fmt::Display) -> String {
    UiError::new("FILE_ACCESS_FAILED").detail(e).into()
}
fn check(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        Err(ui_err("FOLDER_DIFF_CANCELLED").into())
    } else {
        Ok(())
    }
}
impl Source {
    fn local(&self) -> Result<PathBuf, String> {
        match &self.wsl_distro {
            Some(d) if cfg!(windows) => wsl_unc_path(d, &self.path),
            Some(_) => Err(ui_err("WSL_WINDOWS_ONLY").into()),
            None => Ok(PathBuf::from(&self.path)),
        }
    }
    async fn sftp(&self, ssh: &SshManager) -> Result<Option<Arc<SftpSession>>, String> {
        match self.session_id {
            Some(id) => ssh.editor_sftp(id, false).await.map(Some).map_err(|e| {
                if code_of(&e) == Some("SFTP_ONLY") {
                    ui_err("FOLDER_DIFF_SFTP").into()
                } else {
                    e
                }
            }),
            None => Ok(None),
        }
    }
    fn remote_path(&self, relative: &str) -> String {
        if relative.is_empty() {
            self.path.clone()
        } else {
            format!("{}/{}", self.path.trim_end_matches('/'), relative)
        }
    }
}
fn local_list(
    source: &Source,
    recursive: bool,
    cancel: &AtomicBool,
    limit: usize,
    depth_limit: usize,
) -> Result<Listing, String> {
    let root = source.local()?;
    if !fs::symlink_metadata(&root).map_err(err)?.is_dir() {
        return Err(ui_err("FOLDER_DIFF_NOT_DIR").into());
    }
    let mut result = Listing::default();
    let mut stack = vec![(PathBuf::new(), 0)];
    while let Some((relative, depth)) = stack.pop() {
        check(cancel)?;
        for item in fs::read_dir(root.join(&relative)).map_err(err)? {
            check(cancel)?;
            if result.entries.len() >= limit {
                result.truncated = true;
                return Ok(result);
            }
            let item = item.map_err(err)?;
            let path = relative.join(item.file_name());
            let meta = fs::symlink_metadata(item.path()).map_err(err)?;
            let kind = if meta.is_symlink() {
                "symlink"
            } else if meta.is_dir() {
                "dir"
            } else if meta.is_file() {
                "file"
            } else {
                "other"
            };
            result.entries.push(Entry {
                path: path
                    .components()
                    .map(|p| p.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/"),
                kind: kind.into(),
                size: meta.len(),
                mtime: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|t| t.as_secs()),
            });
            if recursive && kind == "dir" {
                if depth + 1 < depth_limit {
                    stack.push((path, depth + 1));
                } else {
                    result.truncated = true;
                }
            }
        }
    }
    Ok(result)
}
async fn list(
    source: &Source,
    sftp: Option<&RawSftpSession>,
    recursive: bool,
    cancel: Arc<AtomicBool>,
) -> Result<Listing, String> {
    let Some(sftp) = sftp else {
        let source = source.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            local_list(&source, recursive, &cancel, MAX_ENTRIES, MAX_DEPTH)
        })
        .await
        .map_err(err)?;
    };
    let root = sftp.lstat(source.path.clone()).await.map_err(err)?.attrs;
    if root.is_symlink() || !root.is_dir() {
        return Err(ui_err("FOLDER_DIFF_NOT_DIR").into());
    }
    let mut result = Listing::default();
    let mut stack = vec![(String::new(), 0)];
    while let Some((relative, depth)) = stack.pop() {
        check(&cancel)?;
        let handle = sftp
            .opendir(source.remote_path(&relative))
            .await
            .map_err(err)?
            .handle;
        let outcome: Result<bool, String> = async {
            loop {
                check(&cancel)?;
                let batch = match sftp.readdir(handle.as_str()).await {
                    Ok(batch) => batch,
                    Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => {
                        return Ok(false);
                    }
                    Err(error) => return Err(err(error)),
                };
                for item in batch.files {
                    check(&cancel)?;
                    let name = item.filename;
                    if name == "." || name == ".." {
                        continue;
                    }
                    if name.contains('/') || name.contains('\0') {
                        return Err(ui_err("SFTP_INVALID_NAME").into());
                    }
                    if result.entries.len() >= MAX_ENTRIES {
                        result.truncated = true;
                        return Ok(true);
                    }
                    let path = if relative.is_empty() {
                        name
                    } else {
                        format!("{relative}/{name}")
                    };
                    let meta = item.attrs;
                    let kind = if meta.is_symlink() {
                        "symlink"
                    } else if meta.is_dir() {
                        "dir"
                    } else if meta.is_regular() {
                        "file"
                    } else {
                        "other"
                    };
                    result.entries.push(Entry {
                        path: path.clone(),
                        kind: kind.into(),
                        size: meta.size.unwrap_or(0),
                        mtime: meta.mtime.map(u64::from),
                    });
                    if recursive && kind == "dir" {
                        if depth + 1 < MAX_DEPTH {
                            stack.push((path, depth + 1));
                        } else {
                            result.truncated = true;
                        }
                    }
                }
            }
        }
        .await;
        let closed = sftp.close(handle).await.map_err(err);
        let stop = outcome?;
        closed?;
        if stop {
            return Ok(result);
        }
    }
    Ok(result)
}

async fn list_source(
    source: &Source,
    ssh: &SshManager,
    recursive: bool,
    cancel: Arc<AtomicBool>,
) -> Result<Listing, String> {
    check(&cancel)?;
    let remote = if let Some(id) = source.session_id {
        Some(ssh.folder_diff_sftp(id).await?)
    } else {
        None
    };
    list(source, remote.as_ref(), recursive, cancel).await
}

enum Reader {
    Local(fs::File),
    Remote(Box<russh_sftp::client::fs::File>),
}
async fn reader(source: &Source, sftp: Option<&SftpSession>, path: &str) -> Result<Reader, String> {
    if let Some(sftp) = sftp {
        let path = source.remote_path(path);
        if !sftp
            .symlink_metadata(path.clone())
            .await
            .map_err(err)?
            .is_regular()
        {
            return Err(ui_err("FOLDER_DIFF_TYPE_CHANGED").into());
        }
        Ok(Reader::Remote(Box::new(
            sftp.open(path).await.map_err(err)?,
        )))
    } else {
        let path = source.local()?.join(path);
        if !fs::symlink_metadata(&path).map_err(err)?.is_file() {
            return Err(ui_err("FOLDER_DIFF_TYPE_CHANGED").into());
        }
        Ok(Reader::Local(fs::File::open(path).map_err(err)?))
    }
}
impl Reader {
    async fn block(&mut self, buffer: &mut [u8]) -> Result<usize, String> {
        let mut count = 0;
        while count < buffer.len() {
            let n = match self {
                Self::Local(file) => Read::read(file, &mut buffer[count..]).map_err(err)?,
                Self::Remote(file) => file.read(&mut buffer[count..]).await.map_err(err)?,
            };
            if n == 0 {
                break;
            }
            count += n;
        }
        Ok(count)
    }
}
async fn equal(
    a: &mut Reader,
    b: &mut Reader,
    size: u64,
    cancel: &AtomicBool,
    progress: &mut Progress,
    channel: &Channel<Progress>,
) -> Result<bool, String> {
    let mut left = vec![0; BLOCK];
    let mut right = vec![0; BLOCK];
    let mut remaining = size;
    while remaining > 0 {
        check(cancel)?;
        tokio::task::yield_now().await;
        let length = remaining.min(BLOCK as u64) as usize;
        let n = a.block(&mut left[..length]).await?;
        let m = b.block(&mut right[..length]).await?;
        progress.bytes += (n + m) as u64;
        let _ = channel.send(progress.clone());
        if n != length || m != length {
            return Err(ui_err("FOLDER_DIFF_FILE_CHANGED").into());
        }
        if left[..n] != right[..m] {
            return Ok(false);
        }
        remaining -= n as u64;
    }
    check(cancel)?;
    // Detect growth beyond the listed size without reading unbounded input.
    if a.block(&mut left[..1]).await? != 0 || b.block(&mut right[..1]).await? != 0 {
        return Err(ui_err("FOLDER_DIFF_FILE_CHANGED").into());
    }
    Ok(true)
}

fn comparison_bytes(sizes: impl Iterator<Item = u64>) -> u64 {
    sizes
        .map(|size| size.saturating_mul(2))
        .fold(0u64, u64::saturating_add)
}

#[tauri::command]
pub fn folder_diff_cancel(token: String) {
    if let Some(cancel) = JOBS.lock().unwrap().get(&token) {
        cancel.store(true, Ordering::Relaxed);
    }
}
struct Job(String);
impl Drop for Job {
    fn drop(&mut self) {
        JOBS.lock().unwrap().remove(&self.0);
    }
}
#[tauri::command]
pub async fn folder_diff_kind(
    source: Source,
    ssh: State<'_, Arc<SshManager>>,
) -> Result<String, String> {
    if let Some(sftp) = source.sftp(&ssh).await? {
        let meta = sftp.symlink_metadata(source.path).await.map_err(err)?;
        Ok(if meta.is_symlink() {
            "symlink"
        } else if meta.is_dir() {
            "dir"
        } else if meta.is_regular() {
            "file"
        } else {
            "other"
        }
        .into())
    } else {
        let meta = fs::symlink_metadata(source.local()?).map_err(err)?;
        Ok(if meta.is_symlink() {
            "symlink"
        } else if meta.is_dir() {
            "dir"
        } else if meta.is_file() {
            "file"
        } else {
            "other"
        }
        .into())
    }
}
#[tauri::command]
pub async fn folder_diff_compare(
    left: Source,
    right: Source,
    recursive: bool,
    contents: bool,
    token: String,
    on_progress: Channel<Progress>,
    ssh: State<'_, Arc<SshManager>>,
) -> Result<Comparison, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut jobs = JOBS.lock().unwrap();
        if jobs.contains_key(&token) {
            return Err(ui_err("FOLDER_DIFF_RUNNING").into());
        }
        jobs.insert(token.clone(), cancel.clone());
    }
    let _job = Job(token);
    let _ = on_progress.send(Progress::default());
    check(&cancel)?;
    let operation = async {
        let a = left.sftp(&ssh).await?;
        let b = right.sftp(&ssh).await?;
        let l = list_source(&left, &ssh, recursive, cancel.clone()).await?;
        let r = list_source(&right, &ssh, recursive, cancel.clone()).await?;
        let mut content = HashMap::new();
        let mut progress = Progress::default();
        let right_entries: HashMap<_, _> = r.entries.iter().map(|e| (e.path.as_str(), e)).collect();
        let pairs: Vec<_> = l
            .entries
            .iter()
            .filter(|e| e.kind == "file")
            .filter_map(|e| {
                right_entries
                    .get(e.path.as_str())
                    .filter(|r| r.kind == "file" && e.size == r.size)
                    .map(|r| (e, *r))
            })
            .collect();
        let total = comparison_bytes(pairs.iter().map(|(entry, _)| entry.size));
        let limited = contents && total > MAX_BYTES;
        progress.total = total;
        let _ = on_progress.send(progress.clone());
        if contents && !limited {
            for (entry, _) in pairs {
                check(&cancel)?;
                let mut ra = reader(&left, a.as_deref(), &entry.path).await?;
                let mut rb = reader(&right, b.as_deref(), &entry.path).await?;
                let same = equal(
                    &mut ra,
                    &mut rb,
                    entry.size,
                    &cancel,
                    &mut progress,
                    &on_progress,
                )
                .await?;
                content.insert(entry.path.clone(), same);
                progress.files += 1;
                let _ = on_progress.send(progress.clone());
            }
        }
        check(&cancel)?;
        Ok(Comparison {
            left: l,
            right: r,
            content,
            limited,
        })
    };
    tokio::select! {
        result = operation => result,
        _ = async { while !cancel.load(Ordering::Relaxed) { tokio::time::sleep(std::time::Duration::from_millis(20)).await; } } => Err(ui_err("FOLDER_DIFF_CANCELLED").into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "werkterm-folder-diff-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn source(&self) -> Source {
            Source {
                path: self.0.to_str().unwrap().into(),
                session_id: None,
                wsl_distro: None,
            }
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn listing_recursion_limits_and_cancellation() {
        let temp = Temp::new();
        fs::create_dir(temp.0.join("dir")).unwrap();
        fs::write(temp.0.join("dir").join("nested"), b"abc").unwrap();
        fs::write(temp.0.join("root"), b"hello").unwrap();
        let cancel = AtomicBool::new(false);
        let flat = local_list(&temp.source(), false, &cancel, MAX_ENTRIES, MAX_DEPTH).unwrap();
        assert_eq!(flat.entries.len(), 2);
        let all = local_list(&temp.source(), true, &cancel, MAX_ENTRIES, MAX_DEPTH).unwrap();
        assert_eq!(all.entries.len(), 3);
        assert!(!all.truncated);
        let nested = all.entries.iter().find(|e| e.path == "dir/nested").unwrap();
        assert_eq!(nested.size, 3);
        assert_eq!(nested.kind, "file");
        assert!(nested.mtime.is_some());
        assert!(
            local_list(&temp.source(), true, &cancel, 1, MAX_DEPTH)
                .unwrap()
                .truncated
        );
        assert!(
            local_list(&temp.source(), true, &cancel, MAX_ENTRIES, 1)
                .unwrap()
                .truncated
        );
        cancel.store(true, Ordering::Relaxed);
        assert!(local_list(&temp.source(), true, &cancel, MAX_ENTRIES, MAX_DEPTH).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_are_listed_without_following() {
        let temp = Temp::new();
        fs::create_dir(temp.0.join("dir")).unwrap();
        std::os::unix::fs::symlink(&temp.0, temp.0.join("dir").join("loop")).unwrap();
        let list = local_list(
            &temp.source(),
            true,
            &AtomicBool::new(false),
            MAX_ENTRIES,
            MAX_DEPTH,
        )
        .unwrap();
        assert_eq!(list.entries.len(), 2);
        assert_eq!(
            list.entries
                .iter()
                .find(|e| e.path == "dir/loop")
                .unwrap()
                .kind,
            "symlink"
        );
        assert!(!list.truncated);
    }
    #[tokio::test]
    async fn streaming_content_and_cancellation() {
        let temp = Temp::new();
        let source = temp.source();
        let bytes = vec![42; BLOCK * 2 + 3];
        fs::write(temp.0.join("a"), &bytes).unwrap();
        fs::write(temp.0.join("b"), &bytes).unwrap();
        let channel = Channel::new(|_| Ok(()));
        let cancel = AtomicBool::new(false);
        let mut progress = Progress::default();
        assert!(
            equal(
                &mut reader(&source, None, "a").await.unwrap(),
                &mut reader(&source, None, "b").await.unwrap(),
                bytes.len() as u64,
                &cancel,
                &mut progress,
                &channel
            )
            .await
            .unwrap()
        );
        assert_eq!(progress.bytes, (bytes.len() * 2) as u64);
        let mut changed = bytes.clone();
        changed[0] = 5;
        fs::write(temp.0.join("b"), changed).unwrap();
        progress.bytes = 0;
        assert!(
            !equal(
                &mut reader(&source, None, "a").await.unwrap(),
                &mut reader(&source, None, "b").await.unwrap(),
                bytes.len() as u64,
                &cancel,
                &mut progress,
                &channel
            )
            .await
            .unwrap()
        );
        assert_eq!(progress.bytes, (BLOCK * 2) as u64);
        cancel.store(true, Ordering::Relaxed);
        assert!(
            equal(
                &mut reader(&source, None, "a").await.unwrap(),
                &mut reader(&source, None, "b").await.unwrap(),
                bytes.len() as u64,
                &cancel,
                &mut progress,
                &channel
            )
            .await
            .is_err()
        );
    }
    #[test]
    fn content_budget_boundary_and_overflow() {
        assert_eq!(comparison_bytes([MAX_BYTES / 2].into_iter()), MAX_BYTES);
        assert!(comparison_bytes([MAX_BYTES / 2, 1].into_iter()) > MAX_BYTES);
        assert_eq!(comparison_bytes([u64::MAX, u64::MAX].into_iter()), u64::MAX);
    }
    #[tokio::test]
    async fn empty_changed_files_and_midstream_cancel() {
        let temp = Temp::new();
        let source = temp.source();
        fs::write(temp.0.join("a"), []).unwrap();
        fs::write(temp.0.join("b"), []).unwrap();
        let channel = Channel::new(|_| Ok(()));
        let cancel = AtomicBool::new(false);
        let mut progress = Progress::default();
        assert!(
            equal(
                &mut reader(&source, None, "a").await.unwrap(),
                &mut reader(&source, None, "b").await.unwrap(),
                0,
                &cancel,
                &mut progress,
                &channel
            )
            .await
            .unwrap()
        );
        fs::write(temp.0.join("a"), b"grown").unwrap();
        assert!(
            equal(
                &mut reader(&source, None, "a").await.unwrap(),
                &mut reader(&source, None, "b").await.unwrap(),
                0,
                &cancel,
                &mut progress,
                &channel
            )
            .await
            .is_err()
        );
        let bytes = vec![7; BLOCK * 3];
        fs::write(temp.0.join("a"), &bytes).unwrap();
        fs::write(temp.0.join("b"), &bytes).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let copy = cancel.clone();
        let channel = Channel::new(move |_| {
            copy.store(true, Ordering::Relaxed);
            Ok(())
        });
        progress.bytes = 0;
        assert!(
            equal(
                &mut reader(&source, None, "a").await.unwrap(),
                &mut reader(&source, None, "b").await.unwrap(),
                bytes.len() as u64,
                &cancel,
                &mut progress,
                &channel
            )
            .await
            .is_err()
        );
        assert_eq!(progress.bytes, (BLOCK * 2) as u64);
    }
    #[test]
    fn cancel_token_and_cleanup() {
        let token = "folder-diff-unit-test".to_owned();
        let cancelled = Arc::new(AtomicBool::new(false));
        JOBS.lock()
            .unwrap()
            .insert(token.clone(), cancelled.clone());
        let job = Job(token.clone());
        folder_diff_cancel(token.clone());
        assert!(cancelled.load(Ordering::Relaxed));
        drop(job);
        assert!(!JOBS.lock().unwrap().contains_key(&token));
    }
}
