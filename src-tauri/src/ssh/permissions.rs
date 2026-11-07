use super::{SshManager, ssh_error};
use russh_sftp::{client::SftpSession, protocol::FileAttributes};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    All,
    Dirs,
    Files,
}
#[derive(Clone, Copy)]
pub struct Options {
    pub mode: u32,
    pub recursive: bool,
    pub scope: Scope,
    pub dir_mode: Option<u32>,
    pub file_mode: Option<u32>,
}
pub fn validate_mode(mode: u32) -> Result<(), String> {
    if mode & !0o7777 != 0 {
        Err("Ungültige Rechte".into())
    } else {
        Ok(())
    }
}
impl Options {
    pub fn validate(self) -> Result<(), String> {
        validate_mode(self.mode)?;
        for mode in [self.dir_mode, self.file_mode].into_iter().flatten() {
            validate_mode(mode)?;
        }
        if self.dir_mode.is_some() != self.file_mode.is_some() {
            return Err("Ungültige Rechte".into());
        }
        Ok(())
    }
    pub fn select(self, directory: bool, symlink: bool) -> Option<u32> {
        if symlink {
            return None;
        }
        if !self.recursive {
            return Some(self.mode);
        }
        if let (Some(dir), Some(file)) = (self.dir_mode, self.file_mode) {
            return Some(if directory { dir } else { file });
        }
        match self.scope {
            Scope::All => Some(self.mode),
            Scope::Dirs if directory => Some(self.mode),
            Scope::Files if !directory => Some(self.mode),
            _ => None,
        }
    }
}
pub fn mode_to_rwx(mode: u32) -> Result<String, String> {
    validate_mode(mode)?;
    let mut result = String::new();
    for (shift, special, lower, upper) in [
        (6, 0o4000, 's', 'S'),
        (3, 0o2000, 's', 'S'),
        (0, 0o1000, 't', 'T'),
    ] {
        result.push(if mode & (4 << shift) != 0 { 'r' } else { '-' });
        result.push(if mode & (2 << shift) != 0 { 'w' } else { '-' });
        result.push(match (mode & (1 << shift) != 0, mode & special != 0) {
            (true, true) => lower,
            (false, true) => upper,
            (true, false) => 'x',
            _ => '-',
        });
    }
    Ok(result)
}
pub fn rwx_to_mode(value: &str) -> Result<u32, String> {
    if value.len() != 9 {
        return Err("Ungültige Rechte".into());
    }
    super::lsparse::mode_bits(&format!("-{value}")).map_err(|_| "Ungültige Rechte".into())
}
#[derive(Default, Serialize)]
pub struct ChmodResult {
    pub changed: u64,
    pub failed: u64,
    pub errors: Vec<String>,
}
impl ChmodResult {
    fn fail(&mut self, path: String) {
        self.failed += 1;
        if self.errors.len() < 20 {
            self.errors.push(path);
        }
    }
}
trait Tree {
    async fn kind(&self, path: &str) -> Result<(bool, bool), String>;
    async fn children(&self, path: &str) -> Result<Vec<String>, String>;
    async fn chmod(&self, path: &str, mode: u32) -> Result<(), String>;
}
impl Tree for SftpSession {
    async fn kind(&self, path: &str) -> Result<(bool, bool), String> {
        let meta = self.symlink_metadata(path).await.map_err(ssh_error)?;
        Ok((meta.is_dir(), meta.is_symlink()))
    }
    async fn children(&self, path: &str) -> Result<Vec<String>, String> {
        let mut result = Vec::new();
        for entry in self.read_dir(path).await.map_err(ssh_error)? {
            let name = entry.file_name();
            if name != "." && name != ".." {
                result.push(super::actions::remote_join(path, &name)?);
            }
        }
        Ok(result)
    }
    async fn chmod(&self, path: &str, mode: u32) -> Result<(), String> {
        self.set_metadata(
            path,
            FileAttributes {
                permissions: Some(mode),
                ..Default::default()
            },
        )
        .await
        .map_err(ssh_error)
    }
}
async fn apply(tree: &impl Tree, path: String, options: Options) -> ChmodResult {
    let mut result = ChmodResult::default();
    let mut pending = vec![(path, false)];
    while let Some((path, visited)) = pending.pop() {
        // lstat again before setstat: skip replaced symlinks as well.
        let (directory, symlink) = match tree.kind(&path).await {
            Ok(kind) => kind,
            Err(_) => {
                result.fail(path);
                continue;
            }
        };
        if symlink {
            continue;
        }
        if options.recursive && directory && !visited {
            match tree.children(&path).await {
                Ok(children) => {
                    pending.push((path, true));
                    pending.extend(children.into_iter().map(|child| (child, false)));
                }
                Err(_) => {
                    result.fail(path);
                }
            }
            continue;
        }
        if let Some(mode) = options.select(directory, symlink) {
            if tree.chmod(&path, mode).await.is_ok() {
                result.changed += 1;
            } else {
                result.fail(path);
            }
        }
    }
    result
}
impl SshManager {
    pub async fn chmod(
        &self,
        id: u32,
        path: String,
        options: Options,
    ) -> Result<ChmodResult, String> {
        options.validate()?;
        let path = super::actions::action_path(&path)?;
        let sftp = self.action_sftp(id).await?;
        Ok(apply(sftp.as_ref(), path, options).await)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    #[test]
    fn validates_and_roundtrips_every_mode() {
        for mode in 0..=0o7777 {
            assert_eq!(rwx_to_mode(&mode_to_rwx(mode).unwrap()).unwrap(), mode);
        }
        assert!(validate_mode(0o10000).is_err());
        assert!(rwx_to_mode("rwxrwxrwz").is_err());
        assert_eq!(mode_to_rwx(0o7700).unwrap(), "rws--S--T");
    }
    fn options() -> Options {
        Options {
            mode: 0o600,
            recursive: true,
            scope: Scope::All,
            dir_mode: None,
            file_mode: None,
        }
    }
    #[test]
    fn selects_scope_and_split_modes() {
        assert_eq!(
            Options {
                scope: Scope::Dirs,
                ..options()
            }
            .select(false, false),
            None
        );
        assert_eq!(
            Options {
                scope: Scope::Files,
                ..options()
            }
            .select(true, false),
            None
        );
        let split = Options {
            dir_mode: Some(0o755),
            file_mode: Some(0o644),
            ..options()
        };
        assert_eq!(split.select(true, false), Some(0o755));
        assert_eq!(split.select(false, false), Some(0o644));
        assert_eq!(split.select(false, true), None);
        assert!(
            Options {
                file_mode: Some(0o644),
                ..options()
            }
            .validate()
            .is_err()
        );
    }
    struct Fake(Mutex<Vec<(String, u32)>>);
    impl Tree for Fake {
        async fn kind(&self, path: &str) -> Result<(bool, bool), String> {
            Ok((path == "/" || path == "/d", path == "/link"))
        }
        async fn children(&self, path: &str) -> Result<Vec<String>, String> {
            Ok(if path == "/" {
                vec!["/d".into(), "/link".into(), "/bad".into()]
            } else {
                vec!["/d/f".into()]
            })
        }
        async fn chmod(&self, path: &str, mode: u32) -> Result<(), String> {
            self.0.lock().unwrap().push((path.into(), mode));
            if path == "/bad" {
                Err("denied".into())
            } else {
                Ok(())
            }
        }
    }
    #[tokio::test]
    async fn fake_tree_is_postorder_skips_links_and_continues_after_failure() {
        let fake = Fake(Mutex::new(Vec::new()));
        let result = apply(
            &fake,
            "/".into(),
            Options {
                dir_mode: Some(0o755),
                file_mode: Some(0o644),
                ..options()
            },
        )
        .await;
        assert_eq!((result.changed, result.failed), (3, 1));
        assert_eq!(result.errors, ["/bad"]);
        let calls = fake.0.lock().unwrap();
        assert_eq!(
            *calls,
            vec![
                ("/bad".into(), 0o644),
                ("/d/f".into(), 0o644),
                ("/d".into(), 0o755),
                ("/".into(), 0o755)
            ]
        );
    }
    #[tokio::test]
    async fn nonrecursive_changes_only_root_and_symlink_root_is_skipped() {
        let fake = Fake(Mutex::new(Vec::new()));
        let result = apply(
            &fake,
            "/".into(),
            Options {
                recursive: false,
                ..options()
            },
        )
        .await;
        assert_eq!((result.changed, result.failed), (1, 0));
        assert_eq!(*fake.0.lock().unwrap(), vec![("/".into(), 0o600)]);
        let result = apply(&fake, "/link".into(), options()).await;
        assert_eq!((result.changed, result.failed), (0, 0));
        assert_eq!(fake.0.lock().unwrap().len(), 1);
    }
    #[test]
    fn errors_are_counted_beyond_the_twenty_path_limit() {
        let mut result = ChmodResult::default();
        for index in 0..25 {
            result.fail(format!("/denied/{index}"));
        }
        assert_eq!(result.failed, 25);
        assert_eq!(result.errors.len(), 20);
    }
    #[tokio::test]
    async fn setstat_packet_contains_only_permissions() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (client, mut server) = tokio::io::duplex(1024);
        let peer = tokio::spawn(async move {
            let len = server.read_u32().await.unwrap();
            let mut init = vec![0; len as usize];
            server.read_exact(&mut init).await.unwrap();
            assert_eq!(init[0], 1);
            server
                .write_all(&[0, 0, 0, 5, 2, 0, 0, 0, 3])
                .await
                .unwrap();
            let len = server.read_u32().await.unwrap();
            let mut packet = vec![0; len as usize];
            server.read_exact(&mut packet).await.unwrap();
            assert_eq!(packet[0], 9); // SSH_FXP_SETSTAT
            assert_eq!(&packet[5..9], &5_u32.to_be_bytes());
            assert_eq!(&packet[9..14], b"/file");
            assert_eq!(&packet[14..18], &4_u32.to_be_bytes()); // permissions flag only
            assert_eq!(&packet[18..22], &0o4755_u32.to_be_bytes());
            assert_eq!(packet.len(), 22);
            let mut reply = vec![101];
            reply.extend_from_slice(&packet[1..5]);
            reply.extend_from_slice(&[0; 12]); // success, empty message/language
            server.write_u32(reply.len() as u32).await.unwrap();
            server.write_all(&reply).await.unwrap();
        });
        let sftp = SftpSession::new(client).await.unwrap();
        Tree::chmod(&sftp, "/file", 0o4755).await.unwrap();
        peer.await.unwrap();
    }
}
