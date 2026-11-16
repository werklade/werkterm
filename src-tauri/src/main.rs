// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // These two calls must stay first: they check the session and set environment
    // variables before any thread or GTK exists.
    #[cfg(target_os = "linux")]
    {
        werkterm_lib::linux_graphics::ensure_graphical_session();
        werkterm_lib::linux_graphics::apply();
    }
    werkterm_lib::run()
}
