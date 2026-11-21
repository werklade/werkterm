//! Touchpad pinch on Linux (issue #27).
//!
//! WebKitGTK zooms the whole page on a touchpad pinch through its own `GtkGestureZoom`; JavaScript
//! never sees an event for it, so the frontend's zoom guard cannot stop it. This module turns that
//! gesture off and attaches our own, which reports the pinch to the frontend as the `pinch-zoom`
//! event. The frontend applies it to the focused terminal or editor font, never to the interface.
//!
//! Windows needs nothing: wry turns WebView2's pinch zoom off (`IsPinchZoomEnabled = false`).

use serde::Serialize;

/// Tauri event sent to the main window for every step of a pinch.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const PINCH_EVENT: &str = "pinch-zoom";

/// GObject data key under which WebKitWebViewBase (GTK 3) keeps its zoom gesture.
/// Not public API: WebKit offers no way to turn the gesture off (WebKit bug 273304).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const WEBKIT_ZOOM_GESTURE_KEY: &str = "wk-view-zoom-gesture";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PinchPhase {
    Begin,
    Update,
    End,
}

/// Payload of [`PINCH_EVENT`].
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct PinchPayload {
    pub phase: PinchPhase,
    /// Scale since the gesture began (1.0 = unchanged, 2.0 = fingers twice as far apart).
    pub scale: f64,
}

impl PinchPayload {
    /// Builds the payload; an unusable scale (not finite, zero or negative) yields None, except for
    /// begin and end, which carry the neutral scale 1.0 instead so the frontend still sees them.
    pub fn new(phase: PinchPhase, scale: f64) -> Option<Self> {
        let valid = scale.is_finite() && scale > 0.0;
        let scale = match (phase, valid) {
            (_, true) => scale,
            (PinchPhase::Update, false) => return None,
            (_, false) => 1.0,
        };
        Some(Self { phase, scale })
    }
}

#[cfg(target_os = "linux")]
mod gtk_pinch {
    use super::{PINCH_EVENT, PinchPayload, PinchPhase, WEBKIT_ZOOM_GESTURE_KEY};
    use gtk::glib::{
        self, Cast, ObjectExt, StaticType,
        translate::{IntoGlib, from_glib_none},
    };
    use gtk::prelude::{EventControllerExt, GestureExt};
    use std::cell::RefCell;
    use tauri::{Emitter, Manager};

    thread_local! {
        // GTK 3 widgets do not own their event controllers, so the gesture lives here, on the GTK
        // main thread, for the lifetime of the app. GTK objects are not Send, so not Tauri state.
        static OWN_GESTURE: RefCell<Option<gtk::GestureZoom>> = const { RefCell::new(None) };
    }

    /// WebKit's own zoom gesture, if the web view has one under the expected key and type.
    fn webkit_zoom_gesture(widget: &gtk::Widget) -> Option<gtk::GestureZoom> {
        let expected = gtk::GestureZoom::static_type().into_glib();
        // SAFETY: called on the GTK main thread while `widget` is alive. WebKitWebViewBase stores
        // its zoom gesture under this key with g_object_set_data_full and holds that reference
        // for the widget's lifetime, so a non-null value points to a live GTypeInstance (WebKit's
        // contract, not public API). The type is checked with g_type_check_instance_is_a before
        // the pointer is used as a GtkGestureZoom; only then from_glib_none takes our own strong
        // reference. Data of another type under the key is ignored.
        unsafe {
            let pointer =
                widget.data::<glib::gobject_ffi::GTypeInstance>(WEBKIT_ZOOM_GESTURE_KEY)?;
            let instance = pointer.as_ptr();
            if glib::gobject_ffi::g_type_check_instance_is_a(instance, expected)
                == glib::ffi::GFALSE
            {
                return None;
            }
            Some(from_glib_none(instance.cast::<gtk::ffi::GtkGestureZoom>()))
        }
    }

    /// Turns WebKit's pinch zoom off. Logs once if its gesture is not found; our own gesture
    /// claims the pinch anyway (see `attach`).
    fn disable_webkit_zoom(widget: &gtk::Widget) {
        let Some(gesture) = webkit_zoom_gesture(widget) else {
            eprintln!(
                "pinch: WebKit zoom gesture not found; relying on claiming the pinch in the capture phase"
            );
            return;
        };
        let before = gesture.propagation_phase();
        // Without a phase GTK no longer feeds events to the gesture, so it never starts.
        gesture.set_propagation_phase(gtk::PropagationPhase::None);
        gesture.reset();
        #[cfg(debug_assertions)]
        eprintln!("pinch: WebKit zoom gesture phase {before:?} -> None");
        #[cfg(not(debug_assertions))]
        let _ = before;
    }

    fn emit(app: &tauri::AppHandle, phase: PinchPhase, scale: f64) {
        if let Some(payload) = PinchPayload::new(phase, scale) {
            let _ = app.emit_to("main", PINCH_EVENT, payload);
        }
    }

    fn attach(app: tauri::AppHandle, widget: &gtk::Widget) {
        disable_webkit_zoom(widget);
        let gesture = gtk::GestureZoom::new(widget);
        // Capture: runs before the web view handles the event. Claiming the sequence at begin
        // stops the pinch events there, so WebKit's gesture does not get them either, even if it
        // could not be turned off above.
        gesture.set_propagation_phase(gtk::PropagationPhase::Capture);
        let begin_app = app.clone();
        gesture.connect_begin(move |gesture, _| {
            gesture.set_state(gtk::EventSequenceState::Claimed);
            emit(&begin_app, PinchPhase::Begin, 1.0)
        });
        let update_app = app.clone();
        gesture.connect_scale_changed(move |_, scale| emit(&update_app, PinchPhase::Update, scale));
        gesture.connect_end(move |gesture, _| emit(&app, PinchPhase::End, gesture.scale_delta()));
        OWN_GESTURE.with(|own| *own.borrow_mut() = Some(gesture));
    }

    /// Hooks the main window's web view. Never fails the app start: problems are only logged.
    pub fn install(app: &tauri::AppHandle) {
        let Some(window) = app.get_webview_window("main") else {
            eprintln!("pinch: main window not found; touchpad pinch is not redirected");
            return;
        };
        let handle = app.clone();
        if let Err(error) = window.with_webview(move |webview| {
            let widget = webview.inner().upcast::<gtk::Widget>();
            attach(handle, &widget);
        }) {
            eprintln!("pinch: cannot reach the web view: {error}");
        }
    }
}

#[cfg(target_os = "linux")]
pub use gtk_pinch::install;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_valid_scale() {
        let payload = PinchPayload::new(PinchPhase::Update, 1.25).unwrap();
        assert_eq!(payload.scale, 1.25);
        assert_eq!(payload.phase, PinchPhase::Update);
    }

    #[test]
    fn drops_an_unusable_update() {
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(PinchPayload::new(PinchPhase::Update, scale), None);
        }
    }

    #[test]
    fn begin_and_end_always_arrive_with_a_neutral_scale_if_needed() {
        for phase in [PinchPhase::Begin, PinchPhase::End] {
            let payload = PinchPayload::new(phase, f64::NAN).unwrap();
            assert_eq!(payload.scale, 1.0);
            assert_eq!(payload.phase, phase);
        }
    }

    #[test]
    fn serializes_for_the_frontend() {
        let payload = PinchPayload::new(PinchPhase::End, 0.5).unwrap();
        assert_eq!(
            serde_json::to_value(payload).unwrap(),
            serde_json::json!({ "phase": "end", "scale": 0.5 })
        );
    }
}
