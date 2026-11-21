//! Diagnostics for issue #28 (file drop under Wayland): with WERKTERM_DEBUG_DND=1 every native
//! drag-and-drop event of a window is written to stderr. Without the variable nothing happens.

use tauri::{DragDropEvent, Window, WindowEvent};

pub fn enabled() -> bool {
    std::env::var_os("WERKTERM_DEBUG_DND").is_some_and(|value| value == "1")
}

pub fn log(window: &Window, event: &WindowEvent) {
    let WindowEvent::DragDrop(drop) = event else {
        return;
    };
    let (kind, position, paths) = match drop {
        DragDropEvent::Enter { paths, position } => ("enter", Some(*position), paths.len()),
        DragDropEvent::Over { position } => ("over", Some(*position), 0),
        DragDropEvent::Drop { paths, position } => ("drop", Some(*position), paths.len()),
        DragDropEvent::Leave => ("leave", None, 0),
        _ => ("other", None, 0),
    };
    let scale = window.scale_factor().unwrap_or(f64::NAN);
    let size = window
        .inner_size()
        .map(|s| (s.width, s.height))
        .unwrap_or((0, 0));
    let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_default();
    match position {
        Some(p) => eprintln!(
            "werkterm dnd: {kind} x={:.1} y={:.1} paths={paths} scale={scale} inner={}x{} session={session}",
            p.x, p.y, size.0, size.1
        ),
        None => eprintln!(
            "werkterm dnd: {kind} scale={scale} inner={}x{} session={session}",
            size.0, size.1
        ),
    }
}
