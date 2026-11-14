//! Key generation is entirely local. Only public metadata crosses IPC.
use russh::keys::{
    Algorithm, HashAlg, PrivateKey,
    ssh_key::{
        self,
        private::RsaKeypair,
        rand_core::{TryCryptoRng, TryRng, UnwrapErr},
    },
};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::Write,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use crate::ui_error::{ui_code, ui_err};

const FAILED: &str = ui_code("KEYGEN_FAILED");
const CLOSED: &str = ui_code("KEYGEN_CLOSED");

// Volatile writes keep the wipe from being removed as a dead store.
struct SecretBytes(Vec<u8>);
impl SecretBytes {
    fn wipe(&mut self) {
        for byte in &mut self.0 {
            // SAFETY: each pointer belongs to a live, exclusively borrowed byte.
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
        std::sync::atomic::compiler_fence(Ordering::SeqCst);
    }
}
impl Drop for SecretBytes {
    fn drop(&mut self) {
        self.wipe();
    }
}
struct Generated {
    private: SecretBytes,
    public: String,
}
#[derive(Default)]
pub struct KeygenState {
    entries: Mutex<HashMap<u64, Option<Generated>>>,
    next: AtomicU64,
}

impl KeygenState {
    fn begin(&self) -> Result<u64, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let mut entries = self.entries.lock().map_err(|_| FAILED)?;
        entries.clear();
        entries.insert(id, None);
        Ok(id)
    }
    fn store(&self, id: u64, generated: Generated) -> Result<(), String> {
        let mut entries = self.entries.lock().map_err(|_| FAILED)?;
        let entry = entries.get_mut(&id).ok_or(CLOSED)?;
        *entry = Some(generated);
        Ok(())
    }
    fn close(&self, id: u64) -> Result<(), String> {
        self.entries.lock().map_err(|_| FAILED)?.remove(&id);
        Ok(())
    }
}

struct OsRandom;
impl TryRng for OsRandom {
    type Error = std::io::Error;
    fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
        let mut bytes = [0; 4];
        self.try_fill_bytes(&mut bytes)?;
        Ok(u32::from_ne_bytes(bytes))
    }
    fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
        let mut bytes = [0; 8];
        self.try_fill_bytes(&mut bytes)?;
        Ok(u64::from_ne_bytes(bytes))
    }
    fn try_fill_bytes(&mut self, bytes: &mut [u8]) -> Result<(), Self::Error> {
        #[cfg(unix)]
        {
            use std::io::Read;
            std::fs::File::open(Path::new("/dev").join("urandom"))?.read_exact(bytes)
        }
        #[cfg(windows)]
        {
            #[link(name = "bcrypt")]
            unsafe extern "system" {
                fn BCryptGenRandom(
                    algorithm: *mut std::ffi::c_void,
                    buffer: *mut u8,
                    length: u32,
                    flags: u32,
                ) -> i32;
            }
            let length = u32::try_from(bytes.len())
                .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
            // SAFETY: system-preferred RNG takes a writable buffer of exactly length bytes.
            let status =
                unsafe { BCryptGenRandom(std::ptr::null_mut(), bytes.as_mut_ptr(), length, 2) };
            if status < 0 {
                // Internal only: generation errors reach the UI as KEYGEN_FAILED.
                Err(std::io::Error::other(format!(
                    "BCryptGenRandom {status:#010x}"
                )))
            } else {
                Ok(())
            }
        }
    }
}
impl TryCryptoRng for OsRandom {}

fn generate(
    kind: &str,
    bits: usize,
    comment: String,
    passphrase: SecretBytes,
) -> Result<(Generated, String), String> {
    if comment.len() > 1024 || comment.chars().any(char::is_control) || passphrase.0.len() > 4096 {
        return Err(ui_err("KEYGEN_INVALID_INPUT").into());
    }
    let mut rng = UnwrapErr(OsRandom);
    let mut key = match kind {
        "ed25519" => PrivateKey::random(&mut rng, Algorithm::Ed25519),
        "rsa" if matches!(bits, 3072 | 4096) => {
            RsaKeypair::random(&mut rng, bits).and_then(|pair| PrivateKey::new(pair.into(), ""))
        }
        _ => return Err(ui_err("KEYGEN_INVALID_TYPE").into()),
    }
    .map_err(|_| FAILED.to_owned())?;
    key.set_comment(comment);
    let public = key
        .public_key()
        .to_openssh()
        .map_err(|_| FAILED.to_owned())?;
    let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
    if !passphrase.0.is_empty() {
        key = key
            .encrypt(&mut OsRandom, &passphrase.0)
            .map_err(|_| FAILED.to_owned())?;
    }
    let pem = key
        .to_openssh(ssh_key::LineEnding::LF)
        .map_err(|_| FAILED.to_owned())?;
    Ok((
        Generated {
            private: SecretBytes(pem.as_bytes().to_vec()),
            public,
        },
        fingerprint,
    ))
}

#[derive(Serialize)]
pub struct KeygenStart {
    id: u64,
    comment: String,
    directory: String,
}
#[tauri::command]
pub fn keygen_begin(state: tauri::State<'_, Arc<KeygenState>>) -> Result<KeygenStart, String> {
    let user = std::env::var(if cfg!(windows) { "USERNAME" } else { "USER" })
        .unwrap_or_else(|_| "user".into());
    let host = std::env::var(if cfg!(windows) {
        "COMPUTERNAME"
    } else {
        "HOSTNAME"
    })
    .ok()
    .or({
        #[cfg(unix)]
        {
            std::fs::read_to_string(Path::new("/etc").join("hostname")).ok()
        }
        #[cfg(not(unix))]
        {
            None
        }
    })
    .unwrap_or_else(|| "localhost".into());
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .ok_or(ui_code("HOME_NOT_FOUND"))?;
    let id = state.begin()?;
    Ok(KeygenStart {
        id,
        comment: format!("{}@{}", user.trim(), host.trim())
            .chars()
            .filter(|c| !c.is_control())
            .collect(),
        directory: Path::new(&home).join(".ssh").to_string_lossy().into_owned(),
    })
}

#[derive(Serialize)]
pub struct KeygenPublic {
    public_key: String,
    fingerprint: String,
}
#[tauri::command]
pub async fn keygen_generate(
    state: tauri::State<'_, Arc<KeygenState>>,
    id: u64,
    kind: String,
    bits: usize,
    comment: String,
    passphrase: String,
) -> Result<KeygenPublic, String> {
    let passphrase = SecretBytes(passphrase.into_bytes());
    if !state.entries.lock().map_err(|_| FAILED)?.contains_key(&id) {
        return Err(CLOSED.into());
    }
    let (generated, fingerprint) =
        tauri::async_runtime::spawn_blocking(move || generate(&kind, bits, comment, passphrase))
            .await
            .map_err(|_| FAILED.to_owned())??;
    let result = KeygenPublic {
        public_key: generated.public.clone(),
        fingerprint,
    };
    state.store(id, generated)?;
    Ok(result)
}
#[tauri::command]
pub fn keygen_close(state: tauri::State<'_, Arc<KeygenState>>, id: u64) -> Result<(), String> {
    state.close(id)
}

fn write_key(path: &Path, bytes: &[u8], private: bool, overwrite: bool) -> Result<(), String> {
    use std::fs::OpenOptions;
    let mut options = OpenOptions::new();
    options.write(true);
    if overwrite {
        options.create(false);
    } else {
        options.create_new(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(if private { 0o600 } else { 0o644 })
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    if overwrite
        && std::fs::symlink_metadata(path)
            .map_err(|_| FAILED)?
            .file_type()
            .is_symlink()
    {
        return Err(ui_err("KEYGEN_SYMLINK").into());
    }
    let mut file = options.open(path).map_err(|error| {
        String::from(if error.kind() == std::io::ErrorKind::AlreadyExists {
            let name = path.file_name().unwrap_or(path.as_os_str());
            ui_err("EXISTS").arg("name", name.to_string_lossy())
        } else {
            ui_err("KEYGEN_OPEN_FAILED").detail(error)
        })
    })?;
    if !file.metadata().map_err(|_| FAILED)?.is_file() {
        return Err(ui_err("SFTP_TARGET_NOT_FILE").into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(if private {
            0o600
        } else {
            0o644
        }))
        .map_err(|_| FAILED)?;
    }
    #[cfg(not(unix))]
    let _ = private;
    if overwrite {
        file.set_len(0).map_err(|_| FAILED)?;
    }
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| ui_err("KEYGEN_WRITE_FAILED").detail(error).into())
}

#[tauri::command]
pub fn keygen_save(
    state: tauri::State<'_, Arc<KeygenState>>,
    id: u64,
    path: String,
    private: bool,
    overwrite: bool,
) -> Result<(), String> {
    let entries = state.entries.lock().map_err(|_| FAILED)?;
    let generated = entries.get(&id).and_then(Option::as_ref).ok_or(CLOSED)?;
    let path = Path::new(&path);
    if let Some(parent) = path.parent()
        && !parent.exists()
    {
        // Only the conventional ~/.ssh directory may be created automatically.
        let home =
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).ok_or(FAILED)?;
        if parent != Path::new(&home).join(".ssh") {
            return Err(ui_err("KEYGEN_DIR_MISSING").into());
        }
        let builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        let builder = {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = builder;
            builder.mode(0o700);
            builder
        };
        builder.create(parent).map_err(|_| FAILED)?;
    }
    if private {
        write_key(path, &generated.private.0, true, overwrite)
    } else {
        write_key(
            path,
            format!("{}\n", generated.public).as_bytes(),
            false,
            overwrite,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ed25519_format_and_passphrase() {
        let (plain, _) =
            generate("ed25519", 0, "user@host".into(), SecretBytes(Vec::new())).unwrap();
        assert!(plain.public.starts_with("ssh-ed25519 "));
        assert!(
            !PrivateKey::from_openssh(&plain.private.0)
                .unwrap()
                .is_encrypted()
        );
        let (encrypted, fingerprint) = generate(
            "ed25519",
            0,
            "test".into(),
            SecretBytes(b"test-passphrase".to_vec()),
        )
        .unwrap();
        assert!(fingerprint.starts_with("SHA256:"));
        let key = PrivateKey::from_openssh(&encrypted.private.0).unwrap();
        assert!(key.is_encrypted());
        assert!(key.decrypt("wrong").is_err());
        assert!(key.decrypt("test-passphrase").is_ok());
    }
    #[test]
    fn rsa_format_and_size() {
        for bits in [3072, 4096] {
            let (key, _) = generate(
                "rsa",
                bits,
                "test".into(),
                SecretBytes(b"rsa-passphrase".to_vec()),
            )
            .unwrap();
            assert!(key.public.starts_with("ssh-rsa "));
            let encrypted = PrivateKey::from_openssh(&key.private.0).unwrap();
            assert!(encrypted.is_encrypted());
            assert!(encrypted.decrypt("wrong").is_err());
            let parsed = encrypted.decrypt("rsa-passphrase").unwrap();
            assert_eq!(
                parsed
                    .key_data()
                    .rsa()
                    .unwrap()
                    .public()
                    .n()
                    .as_positive_bytes()
                    .unwrap()
                    .len()
                    * 8,
                bits
            );
        }
    }
    #[test]
    fn closing_dialog_rejects_late_results_and_new_dialog_evicts_old_key() {
        let state = KeygenState::default();
        let id = state.begin().unwrap();
        let dummy = || Generated {
            private: SecretBytes(vec![1, 2, 3]),
            public: "test".into(),
        };
        state.store(id, dummy()).unwrap();
        state.close(id).unwrap();
        assert!(state.entries.lock().unwrap().is_empty());
        assert!(state.store(id, dummy()).is_err());
        let next = state.begin().unwrap();
        state.store(next, dummy()).unwrap();
        let latest = state.begin().unwrap();
        assert_ne!(latest, next);
        assert!(state.store(next, dummy()).is_err());
        let mut secret = SecretBytes(vec![9; 32]);
        secret.wipe();
        assert_eq!(secret.0, vec![0; 32]);
    }
    #[test]
    fn invalid_requests_are_rejected() {
        let code = |result: Result<(Generated, String), String>| result.err();
        assert_eq!(
            code(generate("rsa", 1024, "".into(), SecretBytes(Vec::new()))).as_deref(),
            Some("KEYGEN_INVALID_TYPE")
        );
        assert_eq!(
            code(generate(
                "ed25519",
                0,
                "bad\ncomment".into(),
                SecretBytes(Vec::new())
            ))
            .as_deref(),
            Some("KEYGEN_INVALID_INPUT")
        );
    }
    #[test]
    fn existing_file_reports_exists_with_name() {
        let dir = std::env::temp_dir().join(format!("werkterm-keygen-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("id_test");
        std::fs::write(&path, b"old").unwrap();
        let error = write_key(&path, b"new", true, false).unwrap_err();
        assert_eq!(error, r#"EXISTS: {"args":{"name":"id_test"}}"#);
        assert_eq!(std::fs::read(&path).unwrap(), b"old");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
