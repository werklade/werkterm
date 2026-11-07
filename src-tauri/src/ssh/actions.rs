use super::{SshManager, ssh_error};
use russh_sftp::{
    client::{SftpSession, error::Error},
    protocol::{FileAttributes, OpenFlags, StatusCode},
};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::watch,
};

#[derive(Default)]
pub(super) struct Transfers {
    active: HashMap<u32, watch::Sender<bool>>,
    pending_cancel: HashSet<u32>,
}

const BLOCK_SIZE: usize = 64 * 1024;
const CANCELLED: &str = "CANCELLED: Übertragung abgebrochen";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub transfer_id: u32,
    pub done: u64,
    pub total: Option<u64>,
}

pub fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\0']) {
        Err("Ungültiger Name".into())
    } else {
        Ok(())
    }
}

pub fn remote_join(parent: &str, name: &str) -> Result<String, String> {
    validate_name(name)?;
    validate_path(parent)?;
    Ok(if parent.is_empty() {
        name.into()
    } else {
        format!("{}/{name}", parent.trim_end_matches('/'))
    })
}
fn validate_path(path: &str) -> Result<(), String> {
    if path.contains('\0') {
        Err("Ungültiger Pfad".into())
    } else {
        Ok(())
    }
}
pub(super) fn action_path(path: &str) -> Result<String, String> {
    validate_path(path)?;
    if path.is_empty() || path.split('/').any(|part| part == "." || part == "..") {
        return Err("Ungültiger Pfad".into());
    }
    Ok(if path.trim_matches('/').is_empty() {
        "/".into()
    } else {
        path.trim_end_matches('/').into()
    })
}
fn progress_due(last: Option<Duration>, elapsed: Duration) -> bool {
    last.is_none_or(|previous| elapsed.saturating_sub(previous) >= Duration::from_millis(100))
}
struct Progress<'a> {
    id: u32,
    total: Option<u64>,
    started: Instant,
    last: Option<Duration>,
    send: &'a (dyn Fn(TransferProgress) + Send + Sync),
}
impl Progress<'_> {
    async fn finish(&mut self, done: u64) {
        if let Some(last) = self.last {
            let remaining = Duration::from_millis(100)
                .saturating_sub(self.started.elapsed().saturating_sub(last));
            tokio::time::sleep(remaining).await;
        }
        self.report(done);
    }
    fn report(&mut self, done: u64) {
        let elapsed = self.started.elapsed();
        if progress_due(self.last, elapsed) {
            (self.send)(TransferProgress {
                transfer_id: self.id,
                done,
                total: self.total,
            });
            self.last = Some(elapsed);
        }
    }
}
fn check_cancel(cancel: &watch::Receiver<bool>) -> Result<(), String> {
    if *cancel.borrow() {
        Err(CANCELLED.into())
    } else {
        Ok(())
    }
}
async fn cancellable<T>(
    cancel: &mut watch::Receiver<bool>,
    future: impl std::future::Future<Output = Result<T, std::io::Error>>,
) -> Result<T, String> {
    check_cancel(cancel)?;
    tokio::select! {
        biased;
        _ = cancel.changed() => Err(CANCELLED.into()),
        result = future => result.map_err(ssh_error),
    }
}
fn part_path(target: &Path) -> PathBuf {
    let mut name = target.as_os_str().to_os_string();
    name.push(".werkterm-part");
    PathBuf::from(name)
}
async fn finish_part(part: &Path, target: &Path, success: bool) -> Result<(), String> {
    if success {
        tokio::fs::rename(part, target).await.map_err(ssh_error)
    } else {
        match tokio::fs::remove_file(part).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(ssh_error(error)),
        }
    }
}
async fn existing(sftp: &SftpSession, path: &str) -> Result<Option<FileAttributes>, String> {
    match sftp.symlink_metadata(path).await {
        Ok(metadata) => Ok(Some(metadata)),
        Err(Error::Status(status)) if status.status_code == StatusCode::NoSuchFile => Ok(None),
        Err(error) => Err(ssh_error(error)),
    }
}

impl SshManager {
    pub(super) async fn action_sftp(&self, id: u32) -> Result<Arc<SftpSession>, String> {
        let session = self.session(id).await?;
        let sudo = session.sudo_sftp.lock().await;
        sudo.clone()
            .or_else(|| session.sftp.get().cloned())
            .ok_or_else(|| "Nur mit SFTP verfügbar".into())
    }
    async fn begin_transfer(&self, transfer_id: u32) -> Result<watch::Receiver<bool>, String> {
        let mut transfers = self.transfers.lock().await;
        if transfers.active.contains_key(&transfer_id) {
            return Err("Transfer-ID bereits aktiv".into());
        }
        let (sender, receiver) = watch::channel(transfers.pending_cancel.remove(&transfer_id));
        transfers.active.insert(transfer_id, sender);
        Ok(receiver)
    }
    pub async fn cancel_transfer(&self, transfer_id: u32) {
        let mut transfers = self.transfers.lock().await;
        if let Some(sender) = transfers.active.get(&transfer_id) {
            sender.send_replace(true);
        } else {
            transfers.pending_cancel.insert(transfer_id);
        }
    }
    pub async fn download(
        &self,
        id: u32,
        remote_path: String,
        local_path: String,
        transfer_id: u32,
        send: &(dyn Fn(TransferProgress) + Send + Sync),
    ) -> Result<(), String> {
        validate_path(&remote_path)?;
        let sftp = self.action_sftp(id).await?;
        let mut cancel = self.begin_transfer(transfer_id).await?;
        let target = PathBuf::from(local_path);
        let part = part_path(&target);
        let mut created = false;
        let result = async {
            let mut remote = sftp.open(remote_path).await.map_err(ssh_error)?;
            let metadata = remote.metadata().await.map_err(ssh_error)?;
            if !metadata.is_regular() {
                return Err("Nur Dateien können heruntergeladen werden".into());
            }
            check_cancel(&cancel)?;
            let mut local = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&part)
                .await
                .map_err(ssh_error)?;
            created = true;
            let mut progress = Progress {
                id: transfer_id,
                total: metadata.size,
                started: Instant::now(),
                last: None,
                send,
            };
            let mut buffer = vec![0; BLOCK_SIZE];
            let mut done = 0;
            progress.report(done);
            let copy = async {
                loop {
                    let count = cancellable(&mut cancel, remote.read(&mut buffer)).await?;
                    if count == 0 {
                        break;
                    }
                    local.write_all(&buffer[..count]).await.map_err(ssh_error)?;
                    done += count as u64;
                    progress.report(done);
                }
                local.flush().await.map_err(ssh_error)?;
                local.sync_all().await.map_err(ssh_error)?;
                check_cancel(&cancel)
            }
            .await;
            drop(local);
            let closed = remote.shutdown().await.map_err(ssh_error);
            copy?;
            closed?;
            progress.finish(done).await;
            check_cancel(&cancel)?;
            finish_part(&part, &target, true).await
        }
        .await;
        let cleanup = if created && result.is_err() {
            finish_part(&part, &target, false).await
        } else {
            Ok(())
        };
        self.transfers.lock().await.active.remove(&transfer_id);
        cleanup?;
        result
    }
    #[allow(clippy::too_many_arguments)]
    pub async fn upload(
        &self,
        id: u32,
        local_path: String,
        remote_dir: String,
        overwrite: bool,
        transfer_id: u32,
        send: &(dyn Fn(TransferProgress) + Send + Sync),
    ) -> Result<(), String> {
        let local_path = PathBuf::from(local_path);
        let name = local_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Ungültiger Name")?;
        let target = remote_join(&remote_dir, name)?;
        let sftp = self.action_sftp(id).await?;
        let mut cancel = self.begin_transfer(transfer_id).await?;
        let mut created = false;
        let result = async {
            if tokio::fs::metadata(&local_path)
                .await
                .map_err(ssh_error)?
                .is_dir()
            {
                return Err("DIRECTORY: Ordner-Upload folgt später".into());
            }
            let mut local = tokio::fs::File::open(&local_path)
                .await
                .map_err(ssh_error)?;
            let local_meta = local.metadata().await.map_err(ssh_error)?;
            if local_meta.is_dir() {
                return Err("DIRECTORY: Ordner-Upload folgt später".into());
            }
            if !local_meta.is_file() {
                return Err("Nur reguläre Dateien können hochgeladen werden".into());
            }
            let previous = existing(&sftp, &target).await?;
            if previous.is_some() && !overwrite {
                return Err(format!("EXISTS: {name}"));
            }
            if previous
                .as_ref()
                .is_some_and(|meta| !meta.is_regular() || meta.is_symlink())
            {
                return Err("Ziel ist keine reguläre Datei".into());
            }
            let permissions = match &previous {
                Some(meta) => {
                    meta.permissions
                        .ok_or("Dateirechte konnten nicht ermittelt werden")?
                        & 0o7777
                }
                None => 0o644,
            };
            check_cancel(&cancel)?;
            let flags = OpenFlags::WRITE
                | OpenFlags::CREATE
                | if previous.is_some() {
                    OpenFlags::TRUNCATE
                } else {
                    OpenFlags::EXCLUDE
                };
            let opened = sftp
                .open_with_flags_and_attributes(
                    target.clone(),
                    flags,
                    FileAttributes {
                        permissions: Some(permissions),
                        ..FileAttributes::empty()
                    },
                )
                .await;
            let mut remote = match opened {
                Ok(file) => file,
                Err(error) => {
                    if !overwrite && existing(&sftp, &target).await?.is_some() {
                        return Err(format!("EXISTS: {name}"));
                    }
                    return Err(ssh_error(error));
                }
            };
            created = true;
            let mut progress = Progress {
                id: transfer_id,
                total: Some(local_meta.len()),
                started: Instant::now(),
                last: None,
                send,
            };
            let mut buffer = vec![0; BLOCK_SIZE];
            let mut done = 0;
            progress.report(done);
            let copy = async {
                loop {
                    check_cancel(&cancel)?;
                    let count = local.read(&mut buffer).await.map_err(ssh_error)?;
                    if count == 0 {
                        break;
                    }
                    cancellable(&mut cancel, remote.write_all(&buffer[..count])).await?;
                    done += count as u64;
                    progress.report(done);
                }
                cancellable(&mut cancel, remote.flush()).await?;
                check_cancel(&cancel)
            }
            .await;
            let closed = remote.shutdown().await.map_err(ssh_error);
            copy?;
            closed?;
            progress.finish(done).await;
            check_cancel(&cancel)?;
            sftp.set_metadata(
                target.clone(),
                FileAttributes {
                    permissions: Some(permissions),
                    ..FileAttributes::empty()
                },
            )
            .await
            .map_err(ssh_error)?;
            check_cancel(&cancel)
        }
        .await;
        let cleanup = if created && result.is_err() {
            sftp.remove_file(target).await.map_err(ssh_error)
        } else {
            Ok(())
        };
        self.transfers.lock().await.active.remove(&transfer_id);
        cleanup?;
        result
    }
    pub async fn mkdir(&self, id: u32, parent: String, name: String) -> Result<(), String> {
        let target = remote_join(&parent, &name)?;
        self.action_sftp(id)
            .await?
            .create_dir(target)
            .await
            .map_err(ssh_error)
    }
    pub async fn create_file(&self, id: u32, parent: String, name: String) -> Result<(), String> {
        let target = remote_join(&parent, &name)?;
        let sftp = self.action_sftp(id).await?;
        let mut file = sftp
            .open_with_flags_and_attributes(
                target,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                FileAttributes {
                    permissions: Some(0o644),
                    ..FileAttributes::empty()
                },
            )
            .await
            .map_err(ssh_error)?;
        file.shutdown().await.map_err(ssh_error)
    }
    pub async fn count_entries(&self, id: u32, path: String) -> Result<u64, String> {
        let path = action_path(&path)?;
        let sftp = self.action_sftp(id).await?;
        let meta = sftp
            .symlink_metadata(path.clone())
            .await
            .map_err(ssh_error)?;
        if meta.is_symlink() || !meta.is_dir() {
            return Ok(0);
        }
        let mut pending = vec![path];
        let mut count = 0;
        while let Some(path) = pending.pop() {
            // Recheck before descending: never intentionally follow a replaced symlink.
            let meta = sftp
                .symlink_metadata(path.clone())
                .await
                .map_err(ssh_error)?;
            if meta.is_symlink() || !meta.is_dir() {
                continue;
            }
            for entry in sftp.read_dir(path.clone()).await.map_err(ssh_error)? {
                let name = entry.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                let child = remote_join(&path, &name)?;
                count += 1;
                let meta = sftp
                    .symlink_metadata(child.clone())
                    .await
                    .map_err(ssh_error)?;
                if !meta.is_symlink() && meta.is_dir() {
                    pending.push(child);
                }
            }
        }
        Ok(count)
    }
    pub async fn delete(&self, id: u32, path: String, recursive: bool) -> Result<(), String> {
        let path = action_path(&path)?;
        if path.is_empty()
            || path.trim_matches('/').is_empty()
            || path.split('/').any(|part| part == "." || part == "..")
        {
            return Err("Ungültiger Löschpfad".into());
        }
        let sftp = self.action_sftp(id).await?;
        let mut pending = vec![(path, false)];
        while let Some((path, visited)) = pending.pop() {
            let meta = sftp
                .symlink_metadata(path.clone())
                .await
                .map_err(ssh_error)?;
            if meta.is_symlink() || !meta.is_dir() {
                sftp.remove_file(path).await.map_err(ssh_error)?;
            } else if visited || !recursive {
                sftp.remove_dir(path).await.map_err(ssh_error)?;
            } else {
                pending.push((path.clone(), true));
                for entry in sftp.read_dir(path.clone()).await.map_err(ssh_error)? {
                    let name = entry.file_name();
                    if name != "." && name != ".." {
                        pending.push((remote_join(&path, &name)?, false));
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_reject_traversal_and_separators() {
        for name in ["", ".", "..", "a/b", "a\0b"] {
            assert_eq!(validate_name(name), Err("Ungültiger Name".into()));
        }
        for name in ["file.txt", "a b", "ä", "a\\b"] {
            assert!(validate_name(name).is_ok());
        }
    }
    #[test]
    fn remote_paths_use_posix_separator() {
        assert_eq!(remote_join("/", "file").unwrap(), "/file");
        assert_eq!(remote_join("/tmp/", "file").unwrap(), "/tmp/file");
        assert_eq!(remote_join("", "file").unwrap(), "file");
        assert!(remote_join("/tmp", "../file").is_err());
    }
    #[test]
    fn action_paths_do_not_dereference_trailing_slashes() {
        assert_eq!(action_path("/tmp/link///").unwrap(), "/tmp/link");
        assert_eq!(action_path("/").unwrap(), "/");
        assert!(action_path("/tmp/link/.").is_err());
        assert!(action_path("").is_err());
    }
    #[tokio::test]
    async fn early_cancellation_is_preserved_and_ids_cannot_overlap() {
        let manager = SshManager::default();
        manager.cancel_transfer(42).await;
        let receiver = manager.begin_transfer(42).await.unwrap();
        assert!(check_cancel(&receiver).is_err());
        assert!(manager.begin_transfer(42).await.is_err());
        let later = manager.begin_transfer(43).await.unwrap();
        assert!(check_cancel(&later).is_ok());
        manager.cancel_transfer(43).await;
        assert!(check_cancel(&later).is_err());
    }
    #[test]
    fn progress_is_limited_to_ten_messages_per_second() {
        assert!(progress_due(None, Duration::ZERO));
        assert!(!progress_due(
            Some(Duration::ZERO),
            Duration::from_millis(99)
        ));
        assert!(progress_due(
            Some(Duration::ZERO),
            Duration::from_millis(100)
        ));
        assert!(!progress_due(Some(Duration::from_secs(1)), Duration::ZERO));
        let mut last = None;
        let mut count = 0;
        for millis in 0..1000 {
            let elapsed = Duration::from_millis(millis);
            if progress_due(last, elapsed) {
                count += 1;
                last = Some(elapsed);
            }
        }
        assert_eq!(count, 10);
    }
    #[tokio::test]
    async fn part_file_is_renamed_or_cleaned_without_touching_target() {
        let directory = std::env::temp_dir().join(format!(
            "werkterm-transfer-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        tokio::fs::create_dir(&directory).await.unwrap();
        let target = directory.join("target.txt");
        let part = part_path(&target);
        tokio::fs::write(&part, b"complete").await.unwrap();
        finish_part(&part, &target, true).await.unwrap();
        assert_eq!(tokio::fs::read(&target).await.unwrap(), b"complete");
        assert!(!part.exists());
        tokio::fs::write(&part, b"partial").await.unwrap();
        finish_part(&part, &target, false).await.unwrap();
        assert!(!part.exists());
        assert_eq!(tokio::fs::read(&target).await.unwrap(), b"complete");
        finish_part(&part, &target, false).await.unwrap();
        let absent = directory.join("missing/target");
        assert!(finish_part(&target, &absent, true).await.is_err());
        assert!(target.exists());
        tokio::fs::remove_dir_all(directory).await.unwrap();
    }
}
