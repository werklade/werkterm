use crate::pty::{Platform, PtyManager, ShellKind, program_in_path, resolve_shell};
use std::sync::Arc;
use tauri::State;
use tauri::ipc::{Channel, InvokeResponseBody};

#[tauri::command]
pub fn pty_spawn(
    state: State<'_, Arc<PtyManager>>,
    kind: ShellKind,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<Option<u32>>,
) -> Result<u32, String> {
    let spec = resolve_shell(
        kind,
        Platform::current(),
        std::env::var("SHELL").ok(),
        program_in_path,
    )
    .map_err(|error| error.to_string())?;
    state
        .spawn(
            &spec,
            cols,
            rows,
            Box::new(move |bytes| {
                let _ = on_data.send(InvokeResponseBody::Raw(bytes));
            }),
            Box::new(move |code| {
                let _ = on_exit.send(code);
            }),
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn pty_write(state: State<'_, Arc<PtyManager>>, id: u32, data: String) -> Result<(), String> {
    state
        .write(id, data.as_bytes())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, Arc<PtyManager>>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state
        .resize(id, cols, rows)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, Arc<PtyManager>>, id: u32) -> Result<(), String> {
    state.kill(id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn available_shells() -> Vec<ShellKind> {
    let mut shells = vec![ShellKind::Local];
    if cfg!(windows) && program_in_path("wsl.exe") {
        shells.push(ShellKind::Wsl);
    }
    shells
}
