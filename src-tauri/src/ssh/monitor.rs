use super::*;
use tauri::{State, ipc::Channel};

use crate::monitor::{MonitorParser, MonitorSample, SCRIPT};

pub(super) struct MonitorTask {
    stop: oneshot::Sender<()>,
    done: tokio::task::JoinHandle<()>,
}
pub(super) async fn stop_session(session: &Session) {
    let mut guard = session.monitor.lock().await;
    if let Some(task) = guard.take() {
        let _ = task.stop.send(());
        let _ = task.done.await;
    }
}
#[tauri::command]
pub async fn ssh_monitor_stop(state: State<'_, Arc<SshManager>>, id: u32) -> Result<(), String> {
    if let Ok(session) = state.session(id).await {
        stop_session(&session).await;
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn ssh_monitor_start(
    state: State<'_, Arc<SshManager>>,
    id: u32,
    on_sample: Channel<MonitorSample>,
) -> Result<(), String> {
    let session = state.session(id).await?;
    let mut guard = session.monitor.lock().await;
    if let Some(task) = guard.take() {
        let _ = task.stop.send(());
        let _ = task.done.await;
    }
    if session.monitor_closed.load(Ordering::Acquire) {
        return Err(crate::ui_error::ui_err("SSH_SESSION_ENDED").into());
    }
    let mut channel = tokio::time::timeout(PHASE_TIMEOUT, session.handle.channel_open_session())
        .await
        .map_err(|_| crate::ui_error::ui_code("MONITOR_TIMEOUT"))?
        .map_err(ssh_error)?;
    let setup = tokio::time::timeout(PHASE_TIMEOUT, async {
        channel
            .exec(true, format!("sh -c {}", quote(SCRIPT)))
            .await
            .map_err(ssh_error)?;
        reply(&mut channel).await
    })
    .await;
    if !matches!(setup, Ok(Ok(()))) {
        let _ = tokio::time::timeout(PHASE_TIMEOUT, channel.close()).await;
        return Err(crate::ui_error::ui_err("MONITOR_REJECTED").into());
    }
    if session.monitor_closed.load(Ordering::Acquire) {
        let _ = tokio::time::timeout(PHASE_TIMEOUT, channel.close()).await;
        return Err(crate::ui_error::ui_err("SSH_SESSION_ENDED").into());
    }
    let (stop, mut stopped) = oneshot::channel();
    let done = tokio::spawn(async move {
        let mut parser = MonitorParser::default();
        'read: loop {
            tokio::select! {
                _ = &mut stopped => break,
                message = channel.wait() => match message {
                    Some(ChannelMsg::Data { data }) => {
                        for sample in parser.feed(&data) {
                            if on_sample.send(sample).is_err() { break 'read; }
                        }
                        if parser.is_unsupported() { break; }
                    }
                    Some(ChannelMsg::Close | ChannelMsg::Eof | ChannelMsg::Failure) | None => break,
                    _ => {}
                }
            }
        }
        let _ = tokio::time::timeout(PHASE_TIMEOUT, channel.eof()).await;
        let _ = tokio::time::timeout(PHASE_TIMEOUT, channel.close()).await;
    });
    *guard = Some(MonitorTask { stop, done });
    Ok(())
}
