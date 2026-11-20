use crate::pty::{Platform, PtyManager, ShellKind, program_in_path, resolve_shell};
use crate::ssh::{
    DirListing, PromptFuture, Prompter, SecretKind, SshConnection, SshManager, SshTarget, ssh_dir,
};
use crate::ui_error::ui_err;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::State;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::oneshot;

#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SshPrompt {
    HostKey {
        request_id: u32,
        host: String,
        port: u16,
        key_type: String,
        fingerprint: String,
    },
    Secret {
        request_id: u32,
        kind: &'static str,
        label: String,
    },
}

enum PendingAnswer {
    HostKey(oneshot::Sender<bool>),
    Secret(oneshot::Sender<Option<String>>),
}

pub struct PendingPrompts {
    next_id: AtomicU32,
    answers: Mutex<HashMap<u32, (u32, PendingAnswer)>>,
}

impl Default for PendingPrompts {
    fn default() -> Self {
        Self {
            next_id: AtomicU32::new(1),
            answers: Mutex::new(HashMap::new()),
        }
    }
}

impl PendingPrompts {
    fn cancel(&self, token: u32) {
        if let Ok(mut answers) = self.answers.lock() {
            let ids: Vec<_> = answers
                .iter()
                .filter_map(|(id, (owner, _))| (*owner == token).then_some(*id))
                .collect();
            for id in ids {
                match answers.remove(&id) {
                    Some((_, PendingAnswer::HostKey(sender))) => {
                        let _ = sender.send(false);
                    }
                    Some((_, PendingAnswer::Secret(sender))) => {
                        let _ = sender.send(None);
                    }
                    None => (),
                }
            }
        }
    }

    fn register(self: &Arc<Self>, token: u32, answer: PendingAnswer) -> Option<PendingPrompt> {
        let id = self
            .next_id
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .ok()?;
        self.answers.lock().ok()?.insert(id, (token, answer));
        Some(PendingPrompt {
            id,
            pending: Arc::clone(self),
            closed: None,
        })
    }
}

struct PendingPrompt {
    closed: Option<tauri::AppHandle>,
    id: u32,
    pending: Arc<PendingPrompts>,
}

impl Drop for PendingPrompt {
    fn drop(&mut self) {
        if let Some(app) = &self.closed {
            use tauri::Emitter;
            let _ = app.emit("tunnel-prompt-closed", self.id);
        }
        if let Ok(mut answers) = self.pending.answers.lock() {
            answers.remove(&self.id);
        }
    }
}

pub(crate) struct TauriPrompter {
    pub(crate) closed: Option<tauri::AppHandle>,
    pub(crate) connect_token: u32,
    pub(crate) pending: Arc<PendingPrompts>,
    pub(crate) channel: Channel<SshPrompt>,
}

impl Prompter for TauriPrompter {
    fn confirm_host_key(
        &self,
        host: String,
        port: u16,
        key_type: String,
        fingerprint: String,
    ) -> PromptFuture<bool> {
        let token = self.connect_token;
        let pending = Arc::clone(&self.pending);
        let channel = self.channel.clone();
        let closed = self.closed.clone();
        Box::pin(async move {
            let (sender, receiver) = oneshot::channel();
            let Some(mut request) = pending.register(token, PendingAnswer::HostKey(sender)) else {
                return false;
            };
            request.closed = closed;
            if channel
                .send(SshPrompt::HostKey {
                    request_id: request.id,
                    host,
                    port,
                    key_type,
                    fingerprint,
                })
                .is_err()
            {
                return false;
            }
            let accepted = tokio::time::timeout(Duration::from_secs(120), receiver)
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or(false);
            drop(request);
            accepted
        })
    }

    fn ask_secret(&self, kind: SecretKind, label: String) -> PromptFuture<Option<String>> {
        let token = self.connect_token;
        let pending = Arc::clone(&self.pending);
        let channel = self.channel.clone();
        let closed = self.closed.clone();
        Box::pin(async move {
            let (sender, receiver) = oneshot::channel();
            let mut request = pending.register(token, PendingAnswer::Secret(sender))?;
            request.closed = closed;
            let kind = match kind {
                SecretKind::Username => "username",
                SecretKind::Password => "password",
                SecretKind::Passphrase => "passphrase",
            };
            if channel
                .send(SshPrompt::Secret {
                    request_id: request.id,
                    kind,
                    label,
                })
                .is_err()
            {
                return None;
            }
            let secret = tokio::time::timeout(Duration::from_secs(120), receiver)
                .await
                .ok()
                .and_then(Result::ok)
                .flatten();
            drop(request);
            secret
        })
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pty_spawn(
    app: tauri::AppHandle,
    tab_id: u32,
    state: State<'_, Arc<PtyManager>>,
    kind: ShellKind,
    cols: u16,
    rows: u16,
    shell_integration: bool,
    start_command: Option<crate::pty::StartCommand>,
    serial_permission_shell: Option<bool>,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<Option<u32>>,
) -> Result<u32, String> {
    let manager = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let mut spec = resolve_shell(
            kind,
            Platform::current(),
            std::env::var("SHELL").ok(),
            shell_integration,
            program_in_path,
        )
        .map_err(|error| error.to_string())?;
        crate::pty::apply_start_command(&mut spec, start_command)?;
        #[cfg(target_os = "linux")]
        if serial_permission_shell == Some(true) && matches!(kind, ShellKind::Local) {
            // A dedicated POSIX shell announces readiness at its first interactive prompt.
            // ENV is cleared so startup scripts cannot consume the queued admin command.
            spec.program = "/bin/sh".into();
            spec.args = vec!["-i".into()];
            spec.env.extend([
                ("ENV".into(), String::new()),
                (
                    "PS1".into(),
                    "\u{1b}]777;werkterm-serial-ready\u{7}$ ".into(),
                ),
            ]);
        }
        #[cfg(not(target_os = "linux"))]
        let _ = serial_permission_shell;
        let exit_app = app.clone();
        manager
            .spawn(
                &spec,
                cols,
                rows,
                Box::new(move |bytes| {
                    crate::session_log::output(&app, tab_id, &bytes);
                    let _ = on_data.send(InvokeResponseBody::Raw(bytes));
                }),
                Box::new(move |code| {
                    crate::session_log::finish(&exit_app, tab_id);
                    let _ = on_exit.send(code);
                }),
            )
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| String::from(ui_err("PTY_START_FAILED")))?
}

#[tauri::command]
pub async fn pty_write(
    state: State<'_, Arc<PtyManager>>,
    id: u32,
    data: String,
) -> Result<(), String> {
    let manager = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        manager
            .write(id, data.as_bytes())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| String::from(ui_err("PTY_WRITE_FAILED")))?
}

#[tauri::command]
pub async fn pty_resize(
    state: State<'_, Arc<PtyManager>>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let manager = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        manager
            .resize(id, cols, rows)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| String::from(ui_err("PTY_RESIZE_FAILED")))?
}

#[tauri::command]
pub async fn pty_kill(state: State<'_, Arc<PtyManager>>, id: u32) -> Result<(), String> {
    let manager = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        manager.kill(id).map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| String::from(ui_err("PTY_KILL_FAILED")))?
}

#[tauri::command]
pub async fn available_shells() -> Result<Vec<ShellKind>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut shells = vec![ShellKind::Local];
        if cfg!(windows) && program_in_path("wsl.exe") {
            shells.push(ShellKind::Wsl);
        }
        shells
    })
    .await
    .map_err(|_| String::from(ui_err("SHELLS_UNAVAILABLE")))
}

#[tauri::command]
pub async fn ssh_cancel_connect(
    state: State<'_, Arc<SshManager>>,
    pending: State<'_, Arc<PendingPrompts>>,
    connect_token: u32,
) -> Result<(), String> {
    state.cancel_connect(connect_token).await;
    pending.cancel(connect_token);
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_connect(
    app: tauri::AppHandle,
    state: State<'_, Arc<SshManager>>,
    pending: State<'_, Arc<PendingPrompts>>,
    tab_id: u32,
    target: String,
    session_id: Option<String>,
    ssh_options: Option<String>,
    connect_token: u32,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<Option<u32>>,
    on_prompt: Channel<SshPrompt>,
) -> Result<SshConnection, String> {
    let target: SshTarget = target.parse()?;
    let session = match session_id {
        Some(id) => Some(crate::sessions::find(&app, &id).await?),
        None => None,
    };
    let jump_sessions = match &session {
        Some(session) => crate::sessions::jump_chain(&app, session).await?,
        None => Vec::new(),
    };
    if let Some(session) = &session {
        crate::sessions::validate_target(session, &target)?;
    }
    // Saved sessions carry their own options; the argument is for quick connect only.
    let options = crate::ssh::options::parse(match &session {
        Some(session) => &session.ssh_options,
        None => ssh_options.as_deref().unwrap_or_default(),
    })?;
    let prompter = Arc::new(TauriPrompter {
        closed: None,
        connect_token,
        pending: Arc::clone(pending.inner()),
        channel: on_prompt,
    });
    let exit_app = app.clone();
    state
        .inner()
        .connect_with_session(
            connect_token,
            target,
            session,
            options,
            jump_sessions,
            cols,
            rows,
            ssh_dir()?.join("known_hosts"),
            prompter,
            Box::new(move |bytes| {
                crate::session_log::output(&app, tab_id, &bytes);
                let _ = on_data.send(InvokeResponseBody::Raw(bytes));
            }),
            Box::new(move |code| {
                crate::session_log::finish(&exit_app, tab_id);
                let _ = on_exit.send(code);
            }),
        )
        .await
}

#[tauri::command]
pub async fn ssh_answer_host_key(
    state: State<'_, Arc<PendingPrompts>>,
    request_id: u32,
    accept: bool,
) -> Result<(), String> {
    let sender = {
        let mut answers = state
            .answers
            .lock()
            .map_err(|_| String::from(ui_err("SSH_PROMPT_FAILED")))?;
        if !matches!(
            answers.get(&request_id),
            Some((_, PendingAnswer::HostKey(_)))
        ) {
            return Err(ui_err("SSH_PROMPT_EXPIRED").into());
        }
        answers.remove(&request_id)
    };
    if let Some((_, PendingAnswer::HostKey(sender))) = sender {
        let _ = sender.send(accept);
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_answer_secret(
    state: State<'_, Arc<PendingPrompts>>,
    request_id: u32,
    mut secret: Option<String>,
) -> Result<(), String> {
    let sender = {
        let mut answers = state
            .answers
            .lock()
            .map_err(|_| String::from(ui_err("SSH_PROMPT_FAILED")))?;
        if !matches!(
            answers.get(&request_id),
            Some((_, PendingAnswer::Secret(_)))
        ) {
            if let Some(secret) = secret.as_mut() {
                secret.clear();
            }
            return Err(ui_err("SSH_PROMPT_EXPIRED").into());
        }
        answers.remove(&request_id)
    };
    if let Some((_, PendingAnswer::Secret(sender))) = sender
        && let Err(mut secret) = sender.send(secret)
        && let Some(secret) = secret.as_mut()
    {
        secret.clear();
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_write(
    state: State<'_, Arc<SshManager>>,
    id: u32,
    data: String,
) -> Result<(), String> {
    state.write(id, data.as_bytes()).await
}

#[tauri::command]
pub async fn ssh_resize(
    state: State<'_, Arc<SshManager>>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.resize(id, cols, rows).await
}

#[tauri::command]
pub async fn ssh_close(state: State<'_, Arc<SshManager>>, id: u32) -> Result<(), String> {
    state.close(id).await
}

#[tauri::command]
pub async fn ssh_list_dir(
    state: State<'_, Arc<SshManager>>,
    id: u32,
    path: String,
) -> Result<DirListing, String> {
    state.list_dir(id, path).await
}

#[tauri::command]
pub async fn local_list_dir(
    path: String,
    wsl_distro: Option<String>,
) -> Result<DirListing, String> {
    tauri::async_runtime::spawn_blocking(move || crate::local_fs::list_local_dir(path, wsl_distro))
        .await
        .map_err(|_| String::from(ui_err("LOCAL_FS_READ_DIR")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prompts_use_frontend_field_names() {
        let host = serde_json::to_value(SshPrompt::HostKey {
            request_id: 7,
            host: "host".into(),
            port: 22,
            key_type: "ssh-ed25519".into(),
            fingerprint: "SHA256:test".into(),
        })
        .unwrap();
        assert_eq!(host["type"], "hostKey");
        assert_eq!(host["requestId"], 7);
        assert_eq!(host["keyType"], "ssh-ed25519");
        let secret = serde_json::to_value(SshPrompt::Secret {
            request_id: 8,
            kind: "password",
            label: "user@host".into(),
        })
        .unwrap();
        assert_eq!(secret["type"], "secret");
        assert_eq!(secret["requestId"], 8);
    }
    #[test]
    fn canceled_prompt_removes_pending_answer() {
        let pending = Arc::new(PendingPrompts::default());
        let (sender, receiver) = oneshot::channel();
        let request = pending.register(1, PendingAnswer::HostKey(sender)).unwrap();
        assert_eq!(pending.answers.lock().unwrap().len(), 1);
        drop(request);
        assert!(pending.answers.lock().unwrap().is_empty());
        assert!(receiver.blocking_recv().is_err());
    }
    #[test]
    fn cancellation_rejects_only_prompts_for_its_connection() {
        let pending = Arc::new(PendingPrompts::default());
        let (host, host_answer) = oneshot::channel();
        let (secret, secret_answer) = oneshot::channel();
        let (other, mut other_answer) = oneshot::channel();
        let _host = pending.register(7, PendingAnswer::HostKey(host)).unwrap();
        let _secret = pending.register(7, PendingAnswer::Secret(secret)).unwrap();
        let _other = pending.register(8, PendingAnswer::HostKey(other)).unwrap();
        pending.cancel(7);
        assert!(!host_answer.blocking_recv().unwrap());
        assert_eq!(secret_answer.blocking_recv().unwrap(), None);
        assert!(matches!(
            other_answer.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        assert_eq!(pending.answers.lock().unwrap().len(), 1);
    }
}

#[tauri::command]
pub async fn ssh_download(
    state: State<'_, Arc<SshManager>>,
    id: u32,
    remote_path: String,
    local_path: String,
    transfer_id: u32,
    on_progress: Channel<crate::ssh::TransferProgress>,
) -> Result<(), String> {
    state
        .download(id, remote_path, local_path, transfer_id, &move |progress| {
            let _ = on_progress.send(progress);
        })
        .await
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_upload(
    state: State<'_, Arc<SshManager>>,
    id: u32,
    local_path: String,
    remote_dir: String,
    overwrite: bool,
    transfer_id: u32,
    on_progress: Channel<crate::ssh::TransferProgress>,
) -> Result<(), String> {
    state
        .upload(
            id,
            local_path,
            remote_dir,
            overwrite,
            transfer_id,
            &move |progress| {
                let _ = on_progress.send(progress);
            },
        )
        .await
}
#[tauri::command]
pub async fn ssh_cancel_transfer(
    state: State<'_, Arc<SshManager>>,
    transfer_id: u32,
) -> Result<(), String> {
    state.cancel_transfer(transfer_id).await;
    Ok(())
}
#[tauri::command]
pub async fn ssh_mkdir(
    state: State<'_, Arc<SshManager>>,
    id: u32,
    parent: String,
    name: String,
) -> Result<(), String> {
    state.mkdir(id, parent, name).await
}
#[tauri::command]
pub async fn ssh_create_file(
    state: State<'_, Arc<SshManager>>,
    id: u32,
    parent: String,
    name: String,
) -> Result<(), String> {
    state.create_file(id, parent, name).await
}
#[tauri::command]
pub async fn ssh_count_entries(
    state: State<'_, Arc<SshManager>>,
    id: u32,
    path: String,
) -> Result<u64, String> {
    state.count_entries(id, path).await
}
#[tauri::command]
pub async fn ssh_delete(
    state: State<'_, Arc<SshManager>>,
    id: u32,
    path: String,
    recursive: bool,
) -> Result<(), String> {
    state.delete(id, path, recursive).await
}

#[tauri::command]
pub async fn ssh_sudo_enable(
    state: State<'_, Arc<SshManager>>,
    id: u32,
    password: Option<String>,
) -> Result<(), String> {
    state.sudo_enable(id, password).await
}
#[tauri::command]
pub async fn ssh_sudo_disable(state: State<'_, Arc<SshManager>>, id: u32) -> Result<(), String> {
    state.sudo_disable(id).await
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_chmod(
    state: State<'_, Arc<SshManager>>,
    id: u32,
    path: String,
    mode: u32,
    recursive: bool,
    scope: crate::ssh::permissions::Scope,
    dir_mode: Option<u32>,
    file_mode: Option<u32>,
) -> Result<crate::ssh::permissions::ChmodResult, String> {
    state
        .chmod(
            id,
            path,
            crate::ssh::permissions::Options {
                mode,
                recursive,
                scope,
                dir_mode,
                file_mode,
            },
        )
        .await
}

#[tauri::command]
pub fn local_shell_name() -> String {
    if cfg!(windows) {
        return "PowerShell".into();
    }
    std::env::var("SHELL")
        .ok()
        .and_then(|s| {
            std::path::Path::new(&s)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "sh".into())
}

#[tauri::command]
pub fn platform() -> &'static str {
    std::env::consts::OS
}
