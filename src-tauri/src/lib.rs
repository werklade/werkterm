mod commands;
pub mod editor;
pub mod local_fs;
pub mod pty;
pub mod secrets;
pub mod sessions;
pub mod ssh;
mod terminal_colors;

use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(editor::EditorDocs::default()))
        .setup(|app| {
            sessions::migrate_config(app.handle());
            editor::init_cache(app.handle()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .manage(Arc::new(pty::PtyManager::default()))
        .manage(Arc::new(ssh::SshManager::default()))
        .manage(Arc::new(commands::PendingPrompts::default()))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            sessions::recent::recent_list,
            sessions::recent::recent_add,
            sessions::recent::recent_clear,
            sessions::recent::last_tabs_list,
            sessions::recent::last_tabs_save,
            commands::local_shell_name,
            terminal_colors::import_mobaxterm_colors,
            editor::editor_open_remote,
            editor::editor_open_local,
            editor::editor_save,
            editor::editor_reload,
            editor::editor_close,
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill,
            commands::available_shells,
            ssh::monitor::ssh_monitor_start,
            ssh::monitor::ssh_monitor_stop,
            commands::ssh_connect,
            commands::ssh_cancel_connect,
            commands::ssh_answer_host_key,
            commands::ssh_answer_secret,
            commands::ssh_write,
            commands::ssh_resize,
            commands::ssh_close,
            commands::ssh_list_dir,
            commands::ssh_sudo_enable,
            commands::ssh_sudo_disable,
            commands::ssh_chmod,
            commands::ssh_download,
            commands::ssh_upload,
            commands::ssh_cancel_transfer,
            commands::ssh_mkdir,
            commands::ssh_create_file,
            commands::ssh_count_entries,
            commands::ssh_delete,
            commands::local_list_dir,
            sessions::sessions_list,
            sessions::sessions_save,
            sessions::sessions_delete,
            sessions::sessions_keyring_available,
            sessions::sessions_import_default_path,
            sessions::sessions_import_preview,
            sessions::sessions_import_commit
        ])
        .build(tauri::generate_context!())
        .unwrap_or_else(|error| {
            eprintln!("error while running tauri application: {error}");
            std::process::exit(1);
        })
        .run(|_, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                editor::clear_cache();
            }
        });
}
