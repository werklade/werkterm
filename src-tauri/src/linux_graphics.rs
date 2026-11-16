//! WebKitGTK rendering workaround for NVIDIA GPUs on Linux.
//!
//! With an NVIDIA GPU WebKitGTK's DMA-BUF renderer can leave the window black, both with
//! the proprietary `nvidia` driver and with the free `nouveau` driver. A user report
//! named `WEBKIT_DISABLE_DMABUF_RENDERER=1` as the fix for the proprietary driver; a
//! tester confirmed it for nouveau (GTX 1060, X11, .deb and AppImage). For the
//! proprietary driver on Wayland the Tauri Linux graphics guide additionally recommends
//! `__NV_DISABLE_EXPLICIT_SYNC=1`, which we set as well because explicit sync problems
//! show the same symptom there and the report did not cover Wayland separately. That
//! variable is read only by the proprietary driver, so nouveau gets the DMA-BUF switch
//! alone. On hybrid laptops the switch is also applied when the window runs on the
//! integrated GPU; this only costs some rendering speed and can be turned off.
//!
//! Users keep full control: nothing is changed when they set any of the WebKit/NVIDIA
//! variables themselves or `WERKTERM_NO_WEBKIT_WORKAROUND=1`.
//! `WERKTERM_WEBKIT_WORKAROUND=1` forces the DMA-BUF switch without NVIDIA detection.
//! Variables set here are removed again for child processes (see `child_env`).

use std::fs;
use std::path::Path;

pub const DMABUF: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
pub const NV_EXPLICIT_SYNC: &str = "__NV_DISABLE_EXPLICIT_SYNC";
pub const COMPOSITING: &str = "WEBKIT_DISABLE_COMPOSITING_MODE";
pub const OPT_OUT: &str = "WERKTERM_NO_WEBKIT_WORKAROUND";
pub const FORCE: &str = "WERKTERM_WEBKIT_WORKAROUND";

/// Environment values the decision depends on (`None` = variable not set).
#[derive(Debug, Default, Clone)]
pub struct GraphicsEnv {
    pub gdk_backend: Option<String>,
    pub xdg_session_type: Option<String>,
    pub wayland_display: Option<String>,
    pub display: Option<String>,
    pub dmabuf: Option<String>,
    pub nv_explicit_sync: Option<String>,
    pub compositing: Option<String>,
    pub opt_out: Option<String>,
    pub force: Option<String>,
}

/// Kernel driver of a detected NVIDIA GPU.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NvidiaDriver {
    /// Proprietary `nvidia` kernel module.
    Proprietary,
    /// Free `nouveau` kernel module.
    Nouveau,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Session {
    Wayland,
    X11,
    Unknown,
}

/// Result of the decision: variables to set and warnings for stderr.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Decision {
    pub set: Vec<(&'static str, &'static str)>,
    pub warnings: Vec<String>,
}

fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|v| !v.is_empty())
}

/// On/off switch: 1/true/yes/on enable, unset/empty/0/false/no/off disable (any case).
/// Anything else disables and yields a warning.
fn switch(name: &str, value: &Option<String>, warnings: &mut Vec<String>) -> bool {
    let Some(value) = non_empty(value) else {
        return false;
    };
    match value.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => {
            warnings.push(format!(
                "werkterm: ignoring {name}={value:?}; use 1/true/yes/on or 0/false/no/off"
            ));
            false
        }
    }
}

fn parse_session(value: &str) -> Option<Session> {
    match value.to_ascii_lowercase().as_str() {
        "wayland" => Some(Session::Wayland),
        "x11" => Some(Session::X11),
        _ => None,
    }
}

/// Session type: GDK_BACKEND (first entry), then XDG_SESSION_TYPE, then WAYLAND_DISPLAY/DISPLAY.
pub fn session_type(env: &GraphicsEnv) -> Session {
    if let Some(session) = non_empty(&env.gdk_backend)
        .and_then(|v| v.split(',').next())
        .and_then(|v| parse_session(v.trim()))
    {
        return session;
    }
    if let Some(session) = non_empty(&env.xdg_session_type).and_then(parse_session) {
        return session;
    }
    if non_empty(&env.wayland_display).is_some() {
        Session::Wayland
    } else if non_empty(&env.display).is_some() {
        Session::X11
    } else {
        Session::Unknown
    }
}

/// Decides what to set before GTK/WebKit start. Pure, so it is tested on every platform.
/// `nvidia` is the detected NVIDIA driver (`None` = no NVIDIA GPU detected).
pub fn decide(env: &GraphicsEnv, nvidia: Option<NvidiaDriver>) -> Decision {
    let mut warnings = Vec::new();
    let opt_out = switch(OPT_OUT, &env.opt_out, &mut warnings);
    let force = switch(FORCE, &env.force, &mut warnings);
    let user_chose =
        env.dmabuf.is_some() || env.nv_explicit_sync.is_some() || env.compositing.is_some();
    let set = if opt_out || user_chose {
        Vec::new()
    } else if nvidia == Some(NvidiaDriver::Proprietary) {
        match session_type(env) {
            Session::Wayland => vec![(NV_EXPLICIT_SYNC, "1"), (DMABUF, "1")],
            Session::X11 | Session::Unknown => vec![(DMABUF, "1")],
        }
    } else if nvidia == Some(NvidiaDriver::Nouveau) || force {
        // __NV_DISABLE_EXPLICIT_SYNC is read only by the proprietary driver.
        vec![(DMABUF, "1")]
    } else {
        Vec::new()
    };
    Decision { set, warnings }
}

/// Detects an NVIDIA GPU and its kernel driver (`nvidia` or `nouveau`).
/// With several cards the proprietary driver wins. `root` is `/` at runtime and a fake
/// tree in tests. Any read error counts as "not detected".
pub fn detect_nvidia(root: &Path) -> Option<NvidiaDriver> {
    // Fixed kernel interfaces (procfs/sysfs), identical on every distribution.
    if root
        .join("proc")
        .join("driver")
        .join("nvidia")
        .join("version")
        .exists()
    {
        return Some(NvidiaDriver::Proprietary);
    }
    let cards = fs::read_dir(root.join("sys").join("class").join("drm")).ok()?;
    let mut found = None;
    for entry in cards.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // card0, card1 … but not connector entries like card0-HDMI-A-1.
        if !name.starts_with("card") || name.contains('-') {
            continue;
        }
        let device = entry.path().join("device");
        let vendor_ok = fs::read_to_string(device.join("vendor"))
            .map(|v| v.trim().eq_ignore_ascii_case("0x10de"))
            .unwrap_or(false);
        if !vendor_ok {
            continue;
        }
        let Ok(link) = fs::read_link(device.join("driver")) else {
            continue;
        };
        match link.file_name().and_then(|n| n.to_str()) {
            Some("nvidia") => return Some(NvidiaDriver::Proprietary),
            Some("nouveau") => found = Some(NvidiaDriver::Nouveau),
            _ => {}
        }
    }
    found
}

/// Applies the workaround. Must run first in `main`, before any thread exists.
#[cfg(target_os = "linux")]
pub fn apply() {
    use std::env::{var, var_os};
    // var_os: a set-but-non-UTF-8 value still counts as the user's choice.
    let raw = |key: &str| var_os(key).map(|v| v.to_string_lossy().into_owned());
    let env = GraphicsEnv {
        gdk_backend: var("GDK_BACKEND").ok(),
        xdg_session_type: var("XDG_SESSION_TYPE").ok(),
        wayland_display: var("WAYLAND_DISPLAY").ok(),
        display: var("DISPLAY").ok(),
        dmabuf: raw(DMABUF),
        nv_explicit_sync: raw(NV_EXPLICIT_SYNC),
        compositing: raw(COMPOSITING),
        opt_out: raw(OPT_OUT),
        force: raw(FORCE),
    };
    let nvidia = detect_nvidia(Path::new("/"));
    let decision = decide(&env, nvidia);
    for warning in &decision.warnings {
        eprintln!("{warning}");
    }
    if decision.set.is_empty() {
        return;
    }
    for (key, value) in &decision.set {
        // SAFETY: set_var is unsafe since edition 2024 because setenv races with
        // concurrent getenv in other threads. This runs as the first statement of
        // `main`: the Rust runtime has started no threads, and Tauri, GTK, WebKit and
        // Tokio are not initialized yet, so no other thread can read the environment.
        unsafe { std::env::set_var(key, value) };
    }
    crate::child_env::record(decision.set.iter().map(|(key, _)| *key).collect());
    let list: Vec<String> = decision
        .set
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect();
    let reason = match nvidia {
        Some(NvidiaDriver::Proprietary) => "NVIDIA driver detected",
        Some(NvidiaDriver::Nouveau) => "NVIDIA GPU with nouveau driver detected",
        None => "forced by WERKTERM_WEBKIT_WORKAROUND",
    };
    eprintln!(
        "werkterm: set {} ({reason}); disable with {OPT_OUT}=1",
        list.join(" ")
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> GraphicsEnv {
        GraphicsEnv::default()
    }

    const P: Option<NvidiaDriver> = Some(NvidiaDriver::Proprietary);
    const N: Option<NvidiaDriver> = Some(NvidiaDriver::Nouveau);

    fn vars(e: &GraphicsEnv, nvidia: Option<NvidiaDriver>) -> Vec<(&'static str, &'static str)> {
        decide(e, nvidia).set
    }

    #[test]
    fn nothing_without_nvidia_or_force() {
        let e = GraphicsEnv {
            xdg_session_type: Some("wayland".into()),
            ..env()
        };
        assert_eq!(decide(&e, None), Decision::default());
    }

    #[test]
    fn nvidia_x11_sets_dmabuf_only() {
        let e = GraphicsEnv {
            xdg_session_type: Some("x11".into()),
            ..env()
        };
        assert_eq!(vars(&e, P), vec![(DMABUF, "1")]);
        assert_eq!(vars(&env(), P), vec![(DMABUF, "1")]);
    }

    #[test]
    fn nvidia_wayland_sets_both() {
        let e = GraphicsEnv {
            wayland_display: Some("wayland-0".into()),
            ..env()
        };
        assert_eq!(vars(&e, P), vec![(NV_EXPLICIT_SYNC, "1"), (DMABUF, "1")]);
    }

    #[test]
    fn nouveau_sets_dmabuf_only_even_on_wayland() {
        let e = GraphicsEnv {
            wayland_display: Some("wayland-0".into()),
            ..env()
        };
        assert_eq!(vars(&e, N), vec![(DMABUF, "1")]);
        let e = GraphicsEnv {
            xdg_session_type: Some("x11".into()),
            ..env()
        };
        assert_eq!(vars(&e, N), vec![(DMABUF, "1")]);
        assert_eq!(vars(&env(), N), vec![(DMABUF, "1")]);
    }

    #[test]
    fn user_variables_win() {
        for e in [
            GraphicsEnv {
                dmabuf: Some("0".into()),
                ..env()
            },
            GraphicsEnv {
                dmabuf: Some(String::new()),
                ..env()
            },
            GraphicsEnv {
                nv_explicit_sync: Some("0".into()),
                ..env()
            },
            GraphicsEnv {
                compositing: Some("1".into()),
                ..env()
            },
            GraphicsEnv {
                opt_out: Some("1".into()),
                force: Some("1".into()),
                ..env()
            },
        ] {
            assert!(vars(&e, P).is_empty(), "{e:?}");
            assert!(vars(&e, N).is_empty(), "{e:?}");
        }
    }

    #[test]
    fn switch_values() {
        for on in ["1", "true", "YES", " On "] {
            let e = GraphicsEnv {
                opt_out: Some(on.into()),
                ..env()
            };
            assert_eq!(decide(&e, P), Decision::default(), "{on}");
            assert_eq!(decide(&e, N), Decision::default(), "{on}");
            let e = GraphicsEnv {
                force: Some(on.into()),
                ..env()
            };
            assert_eq!(vars(&e, None), vec![(DMABUF, "1")], "{on}");
        }
        for off in ["", "0", "false", "No", "OFF"] {
            let e = GraphicsEnv {
                opt_out: Some(off.into()),
                force: Some(off.into()),
                ..env()
            };
            assert_eq!(decide(&e, None), Decision::default(), "{off}");
            assert_eq!(vars(&e, P), vec![(DMABUF, "1")], "{off}");
        }
    }

    #[test]
    fn invalid_switch_warns_and_counts_as_unset() {
        let e = GraphicsEnv {
            opt_out: Some("2".into()),
            force: Some("maybe".into()),
            ..env()
        };
        let decision = decide(&e, P);
        assert_eq!(decision.set, vec![(DMABUF, "1")]);
        assert_eq!(decision.warnings.len(), 2);
        assert!(decision.warnings[0].contains(OPT_OUT));
        assert!(decision.warnings[1].contains(FORCE));
        assert!(vars(&e, None).is_empty());
    }

    #[test]
    fn session_order() {
        let e = GraphicsEnv {
            gdk_backend: Some("x11,wayland".into()),
            xdg_session_type: Some("wayland".into()),
            wayland_display: Some("wayland-0".into()),
            ..env()
        };
        assert_eq!(session_type(&e), Session::X11);
        let e = GraphicsEnv {
            gdk_backend: Some("broadway".into()),
            xdg_session_type: Some("Wayland".into()),
            ..env()
        };
        assert_eq!(session_type(&e), Session::Wayland);
        let e = GraphicsEnv {
            xdg_session_type: Some("tty".into()),
            display: Some(":0".into()),
            ..env()
        };
        assert_eq!(session_type(&e), Session::X11);
        assert_eq!(session_type(&env()), Session::Unknown);
    }

    /// Fake procfs/sysfs tree in the system temp dir, removed on drop.
    struct FakeRoot(std::path::PathBuf);

    impl FakeRoot {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("werkterm-gpu-test-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        /// Adds cardN with the given PCI vendor and driver name.
        /// Returns false when the platform refuses symlinks (Windows without rights).
        fn card(&self, card: &str, vendor: &str, driver: &str) -> bool {
            let device = self
                .0
                .join("sys")
                .join("class")
                .join("drm")
                .join(card)
                .join("device");
            fs::create_dir_all(&device).unwrap();
            fs::write(device.join("vendor"), format!("{vendor}\n")).unwrap();
            let target = self.0.join("bus").join("pci").join("drivers").join(driver);
            fs::create_dir_all(&target).unwrap();
            #[cfg(unix)]
            let linked = std::os::unix::fs::symlink(&target, device.join("driver")).is_ok();
            #[cfg(windows)]
            let linked = std::os::windows::fs::symlink_dir(&target, device.join("driver")).is_ok();
            linked
        }
    }

    impl Drop for FakeRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn detects_proprietary_nvidia_via_proc() {
        let root = FakeRoot::new("proc");
        let dir = root.0.join("proc").join("driver").join("nvidia");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("version"), "NVRM version: 550\n").unwrap();
        assert_eq!(detect_nvidia(&root.0), P);
    }

    #[test]
    fn missing_files_are_not_detected() {
        let root = FakeRoot::new("empty");
        assert_eq!(detect_nvidia(&root.0), None);
        assert_eq!(detect_nvidia(&root.0.join("does-not-exist")), None);
        // Vendor file without driver link.
        let device = root
            .0
            .join("sys")
            .join("class")
            .join("drm")
            .join("card0")
            .join("device");
        fs::create_dir_all(&device).unwrap();
        fs::write(device.join("vendor"), "0x10de\n").unwrap();
        assert_eq!(detect_nvidia(&root.0), None);
    }

    #[test]
    fn sysfs_driver_decides() {
        let cases = [
            ("nvidia", "0x10de", "nvidia", P),
            ("nouveau", "0x10de", "nouveau", N),
            ("intel", "0x8086", "i915", None),
            ("connector", "0x10de", "nvidia", None),
        ];
        for (name, vendor, driver, expected) in cases {
            let root = FakeRoot::new(name);
            let card = if name == "connector" {
                "card0-HDMI-A-1"
            } else {
                "card0"
            };
            if !root.card(card, vendor, driver) {
                eprintln!("skipping {name}: symlinks not permitted here");
                continue;
            }
            assert_eq!(detect_nvidia(&root.0), expected, "{name}");
        }
    }

    #[test]
    fn proprietary_card_wins_over_nouveau_card() {
        // Both orders, because the read_dir order is not guaranteed.
        for (first, second) in [("nouveau", "nvidia"), ("nvidia", "nouveau")] {
            let root = FakeRoot::new(&format!("multi-{first}"));
            if !root.card("card0", "0x10de", first) || !root.card("card1", "0x10de", second) {
                eprintln!("skipping multi-{first}: symlinks not permitted here");
                continue;
            }
            assert_eq!(detect_nvidia(&root.0), P, "{first}+{second}");
        }
    }

    #[test]
    fn proc_file_wins_over_nouveau_card() {
        let root = FakeRoot::new("proc-nouveau");
        let dir = root.0.join("proc").join("driver").join("nvidia");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("version"), "NVRM version: 550\n").unwrap();
        // Without symlink rights the card stays unlinked; the proc file alone decides.
        let _ = root.card("card0", "0x10de", "nouveau");
        assert_eq!(detect_nvidia(&root.0), P);
    }
}
