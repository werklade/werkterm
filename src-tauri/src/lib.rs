mod commands;
pub mod editor;
mod keygen;
pub mod local_fs;
mod local_ports;
pub mod pty;
pub mod secrets;
pub mod serial;
mod session_log;
pub mod sessions;
pub mod ssh;
pub mod telnet;
mod terminal_colors;
pub mod tunnels;

use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(tunnels::TunnelManager::default()))
        .manage(Arc::new(keygen::KeygenState::default()))
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
            telnet::telnet_connect,
            telnet::terminal_write,
            telnet::terminal_resize,
            telnet::terminal_close,
            telnet::terminal_cancel_connect,
            telnet::serial_break,
            serial::serial_ports,
            serial::serial_connect,
            local_fs::save_text_file,
            session_log::session_log_start,
            session_log::session_log_stop,
            session_log::session_log_open_folder,
            tunnels::tunnels_list,
            tunnels::tunnel_save,
            tunnels::tunnel_delete,
            tunnels::tunnel_start,
            tunnels::tunnel_stop,
            tunnels::tunnel_list_status,
            tunnels::tunnel_autostart,
            keygen::keygen_begin,
            keygen::keygen_generate,
            keygen::keygen_save,
            keygen::keygen_close,
            local_ports::local_ports,
            sessions::recent::recent_list,
            sessions::recent::recent_add,
            sessions::recent::recent_clear,
            sessions::recent::last_tabs_list,
            sessions::recent::last_tabs_save,
            commands::local_shell_name,
            commands::platform,
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
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                use tauri::Manager;
                let manager = app.state::<Arc<tunnels::TunnelManager>>();
                tauri::async_runtime::block_on(manager.stop_all());
                telnet::stop_all();
                session_log::stop_all();
                editor::clear_cache();
            }
        });
}

// The unit-test executable does not inherit Tauri's Windows application manifest.
// Native dialog symbols pulled in by the prompt lifecycle need Common Controls v6.
#[cfg(all(test, windows))]
mod windows_test_manifest {
    macro_rules! manifest_dependency {
        ($directive:literal) => {
            #[used]
            #[unsafe(link_section = ".drectve")]
            static MANIFEST_DEPENDENCY: [u8; $directive.len()] = *$directive;
        };
    }
    manifest_dependency!(b" /MANIFESTDEPENDENCY:\"type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'\" ");
}
