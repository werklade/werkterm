mod commands;
pub mod local_fs;
pub mod pty;
pub mod ssh;

use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(pty::PtyManager::default()))
        .manage(Arc::new(ssh::SshManager::default()))
        .manage(Arc::new(commands::PendingPrompts::default()))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill,
            commands::available_shells,
            commands::ssh_connect,
            commands::ssh_answer_host_key,
            commands::ssh_answer_secret,
            commands::ssh_write,
            commands::ssh_resize,
            commands::ssh_close,
            commands::ssh_list_dir,
            commands::local_list_dir
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|error| {
            eprintln!("error while running tauri application: {error}");
            std::process::exit(1);
        });
}
