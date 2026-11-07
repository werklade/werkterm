use super::{ChannelMsg, PHASE_TIMEOUT, SftpSession, SshManager, quote, reply};
use std::sync::Arc;

// A timed-out exec setup must close its channel even before into_stream().
struct PendingChannel(Option<russh::Channel<russh::client::Msg>>);
impl PendingChannel {
    fn channel(&mut self) -> Result<&mut russh::Channel<russh::client::Msg>, &'static str> {
        self.0.as_mut().ok_or(FAILED)
    }
    fn into_stream(mut self) -> Result<russh::ChannelStream<russh::client::Msg>, &'static str> {
        self.0.take().map(russh::Channel::into_stream).ok_or(FAILED)
    }
}
impl Drop for PendingChannel {
    fn drop(&mut self) {
        if let Some(channel) = self.0.take() {
            tokio::spawn(async move {
                let _ = tokio::time::timeout(PHASE_TIMEOUT, channel.close()).await;
            });
        }
    }
}

const FAILED: &str = "SUDO_FAILED: sudo-SFTP konnte nicht gestartet werden (Passwort oder Serverkonfiguration prüfen)";
pub(super) const SEARCH: &str = "for p in /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/sftp-server /usr/lib/sftp-server /usr/sbin/sftp-server; do if [ -x \"$p\" ]; then printf '%s\\n' \"$p\"; exit 0; fi; done; exit 1";

// No Debug implementation: this buffer must never enter diagnostics.
struct Secret(Vec<u8>);
impl Drop for Secret {
    fn drop(&mut self) {
        self.0.fill(0);
        std::hint::black_box(&mut self.0);
    }
}
fn denied(output: &[u8]) -> bool {
    let text = String::from_utf8_lossy(output).to_ascii_lowercase();
    [
        "not in the sudoers",
        "not allowed",
        "may not run",
        "not permitted",
    ]
    .iter()
    .any(|s| text.contains(s))
}
impl SshManager {
    pub(crate) async fn sudo_active(&self, id: u32) -> Result<bool, String> {
        Ok(self.session(id).await?.sudo_sftp.lock().await.is_some())
    }
    pub async fn sudo_enable(&self, id: u32, password: Option<String>) -> Result<(), String> {
        let mut password = password.map(|value| Secret(value.into_bytes()));
        if password
            .as_ref()
            .is_some_and(|s| s.0.contains(&b'\n') || s.0.contains(&b'\r') || s.0.contains(&0))
        {
            return Err(FAILED.into());
        }
        let session = self.session(id).await?;
        if session.sftp.get().is_none() {
            return Err("Nur mit SFTP verfügbar".into());
        }
        // Serialize toggles, including setup, so disable cannot race publication.
        let mut active = session.sudo_sftp.lock().await;
        if active.is_some() {
            return Ok(());
        }
        let result = tokio::time::timeout(PHASE_TIMEOUT, async {
            if password.is_none() {
                let channel = session
                    .handle
                    .channel_open_session()
                    .await
                    .map_err(|_| FAILED)?;
                let mut guard = PendingChannel(Some(channel));
                let channel = guard.channel()?;
                let check = async {
                    channel
                        .exec(true, "LC_ALL=C sudo -n true")
                        .await
                        .map_err(|_| FAILED)?;
                    let mut output = Vec::new();
                    let mut code = None;
                    while let Some(msg) = channel.wait().await {
                        match msg {
                            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                                let remaining = 8192_usize.saturating_sub(output.len());
                                output.extend_from_slice(&data[..data.len().min(remaining)]);
                            }
                            ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                            ChannelMsg::Close | ChannelMsg::Failure => break,
                            _ => {}
                        }
                    }
                    if code == Some(0) {
                        Ok(())
                    } else if denied(&output) {
                        Err("SUDO_DENIED: sudo nicht erlaubt")
                    } else {
                        Err("SUDO_PASSWORD: sudo verlangt ein Passwort")
                    }
                }
                .await;
                let _ = channel.close().await;
                check?;
            }
            let path = super::exec(&session.handle, SEARCH.into())
                .await
                .map_err(|_| "SUDO_NO_SFTP: sftp-server nicht gefunden")?;
            let path = path.trim();
            // Only accept the fixed candidates; never execute arbitrary stdout.
            if ![
                "/usr/lib/openssh/sftp-server",
                "/usr/libexec/openssh/sftp-server",
                "/usr/lib/ssh/sftp-server",
                "/usr/libexec/sftp-server",
                "/usr/lib/sftp-server",
                "/usr/sbin/sftp-server",
            ]
            .contains(&path)
            {
                return Err("SUDO_NO_SFTP: sftp-server nicht gefunden");
            }
            let channel = session
                .handle
                .channel_open_session()
                .await
                .map_err(|_| FAILED)?;
            let mut guard = PendingChannel(Some(channel));
            let channel = guard.channel()?;
            let command = format!(
                "sudo {} {}",
                // -k makes sudo always read the password line, even with cached
                // credentials; otherwise the line would reach sftp-server.
                if password.is_some() {
                    "-k -S -p ''"
                } else {
                    "-n"
                },
                quote(path)
            );
            let setup = async {
                channel.exec(true, command).await.map_err(|_| FAILED)?;
                reply(channel).await.map_err(|_| FAILED)?;
                if let Some(secret) = password.take() {
                    // Do not realloc a password-bearing Vec: wipe the original
                    // allocation before releasing it.
                    let mut line = Secret(Vec::with_capacity(secret.0.len() + 1));
                    line.0.extend_from_slice(&secret.0);
                    line.0.push(b'\n');
                    drop(secret);
                    let sent = channel.data(line.0.as_slice()).await;
                    drop(line);
                    sent.map_err(|_| FAILED)?;
                }
                Ok::<_, &str>(())
            }
            .await;
            if let Err(error) = setup {
                let _ = channel.close().await;
                return Err(error);
            }
            SftpSession::new(guard.into_stream()?)
                .await
                .map(Arc::new)
                .map_err(|_| FAILED)
        })
        .await
        .map_err(|_| FAILED.to_owned())?
        .map_err(str::to_owned)?;
        *active = Some(result);
        Ok(())
    }
    pub async fn sudo_disable(&self, id: u32) -> Result<(), String> {
        let session = self.session(id).await?;
        if let Some(sftp) = session.sudo_sftp.lock().await.take() {
            // Stop routing new work immediately. Existing Arc leases (transfers)
            // finish on the original channel before that channel is closed.
            if Arc::strong_count(&sftp) == 1 {
                let _ = sftp.close().await;
            } else {
                let owner = Arc::downgrade(&session);
                tokio::spawn(async move {
                    while Arc::strong_count(&sftp) > 1
                        && owner
                            .upgrade()
                            .is_some_and(|s| !s.finished.load(std::sync::atomic::Ordering::Acquire))
                    {
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                    let _ = sftp.close().await;
                });
            }
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn search_is_posix_and_candidates_are_in_order() {
        assert_eq!(
            SEARCH,
            "for p in /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/sftp-server /usr/lib/sftp-server /usr/sbin/sftp-server; do if [ -x \"$p\" ]; then printf '%s\\n' \"$p\"; exit 0; fi; done; exit 1"
        );
        assert!(denied(b"user is not in the sudoers file"));
        assert!(!denied(b"a password is required"));
    }
    #[test]
    fn quoting_handles_shell_metacharacters() {
        assert_eq!(quote("/a'b;$(id)\n"), "'/a'\\''b;$(id)\n'");
        assert_eq!(quote(""), "''");
    }
}
