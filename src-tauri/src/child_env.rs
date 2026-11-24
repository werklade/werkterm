//! Removes Werkterm's recorded start-up overrides and AppImage launcher settings
//! from child commands while preserving Werkterm's process environment.

use std::ffi::OsStr;
use std::sync::OnceLock;

#[cfg(unix)]
use std::{collections::HashSet, ffi::OsString, os::unix::ffi::OsStrExt, path::Path};

static SET_BY_WERKTERM: OnceLock<Vec<&'static str>> = OnceLock::new();

/// A command whose child environment can be edited.
pub trait EnvRemove {
    fn remove_env(&mut self, key: &OsStr);
    #[cfg(unix)]
    fn set_env(&mut self, key: &OsStr, value: &OsStr);
}

impl EnvRemove for std::process::Command {
    fn remove_env(&mut self, key: &OsStr) {
        self.env_remove(key);
    }

    #[cfg(unix)]
    fn set_env(&mut self, key: &OsStr, value: &OsStr) {
        self.env(key, value);
    }
}

impl EnvRemove for portable_pty::CommandBuilder {
    fn remove_env(&mut self, key: &OsStr) {
        self.env_remove(key);
    }

    #[cfg(unix)]
    fn set_env(&mut self, key: &OsStr, value: &OsStr) {
        self.env(key, value);
    }
}

/// Records the variables Werkterm set itself (first call wins).
#[cfg(target_os = "linux")]
pub fn record(keys: Vec<&'static str>) {
    let _ = SET_BY_WERKTERM.set(keys);
}

fn recorded() -> &'static [&'static str] {
    SET_BY_WERKTERM.get().map(Vec::as_slice).unwrap_or(&[])
}

fn strip_keys<C: EnvRemove>(command: &mut C, keys: &[&str]) {
    for key in keys {
        command.remove_env(OsStr::new(key));
    }
}

/// Strips start-up overrides and mounted or extracted AppImage launcher settings
/// from the child environment.
pub fn strip_inherited<C: EnvRemove>(command: &mut C) {
    strip_keys(command, recorded());
    #[cfg(unix)]
    strip_appimage(
        command,
        &std::env::vars_os().collect::<Vec<_>>(),
        std::env::current_exe().ok().as_deref(),
    );
}

#[cfg(unix)]
fn strip_appimage<C: EnvRemove>(command: &mut C, env: &[(OsString, OsString)], exe: Option<&Path>) {
    for (key, value) in appimage_changes(env, exe) {
        match value {
            Some(value) => command.set_env(&key, &value),
            None => command.remove_env(&key),
        }
    }
}

/// Requires an absolute, non-root APPDIR and either APPIMAGE or an executable in APPDIR.
#[cfg(unix)]
fn appimage_changes(
    env: &[(OsString, OsString)],
    exe: Option<&Path>,
) -> Vec<(OsString, Option<OsString>)> {
    let get = |name: &str| {
        env.iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_os_str())
    };
    let Some(appdir) = get("APPDIR")
        .map(Path::new)
        // A root APPDIR would match every absolute path.
        .filter(|path| path.is_absolute() && path.parent().is_some())
    else {
        return Vec::new();
    };
    if !(get("APPIMAGE").is_some_and(|value| !value.is_empty())
        || exe.is_some_and(|path| path.starts_with(appdir)))
    {
        return Vec::new();
    }

    let mut changes = Vec::new();
    for (key, value) in env {
        let value = match key.as_bytes() {
            b"APPDIR"
            | b"APPIMAGE"
            | b"ARGV0"
            | b"OWD"
            | b"PYTHONDONTWRITEBYTECODE"
            | b"GTK_THEME"
            | b"GST_REGISTRY_REUSE_PLUGIN_SCANNER" => None,
            b"LD_PRELOAD"
            | b"LD_LIBRARY_PATH"
            | b"PATH"
            | b"PYTHONPATH"
            | b"PERLLIB"
            | b"XDG_DATA_DIRS"
            | b"QT_PLUGIN_PATH"
            | b"GST_PLUGIN_SYSTEM_PATH"
            | b"GST_PLUGIN_SYSTEM_PATH_1_0"
            | b"GST_PLUGIN_PATH_1_0" => {
                let Some(change) = clean_path_list(
                    value,
                    appdir,
                    |byte| *byte == b':' || (key == "LD_PRELOAD" && *byte == b' '),
                    key == "XDG_DATA_DIRS",
                ) else {
                    continue;
                };
                change
            }
            _ if Path::new(value).is_absolute() && Path::new(value).starts_with(appdir) => None,
            _ => continue,
        };
        changes.push((key.clone(), value));
    }
    changes.sort_by(|(left, _), (right, _)| left.cmp(right));
    changes
}

/// Leaves lists without APPDIR entries untouched. Removes one GTK system share
/// entry after a dropped entry in XDG_DATA_DIRS, and a final empty entry after
/// a dropped entry. Keeps other empty entries and the first copy of each path.
/// Joins the remaining entries with colons or removes the variable if none remain.
#[cfg(unix)]
fn clean_path_list(
    value: &OsStr,
    appdir: &Path,
    separator: impl FnMut(&u8) -> bool,
    xdg: bool,
) -> Option<Option<OsString>> {
    let mut entries = value.as_bytes().split(separator).peekable();
    let mut seen = HashSet::new();
    let mut retained = Vec::new();
    let mut removed_appdir = false;
    let mut removed_system_share = false;
    let mut previous_dropped = false;

    while let Some(entry) = entries.next() {
        let inside_appdir =
            !entry.is_empty() && Path::new(OsStr::from_bytes(entry)).starts_with(appdir);
        let injected_system_share = xdg
            && previous_dropped
            && !removed_system_share
            && matches!(entry, b"/usr/share" | b"/usr/share/");
        let trailing_empty = entry.is_empty() && previous_dropped && entries.peek().is_none();
        removed_appdir |= inside_appdir;
        removed_system_share |= injected_system_share;
        previous_dropped = inside_appdir || injected_system_share || trailing_empty;
        if !previous_dropped && (entry.is_empty() || seen.insert(entry)) {
            retained.push(entry);
        }
    }

    removed_appdir.then(|| {
        (!retained.is_empty()).then(|| OsStr::from_bytes(&retained.join(&b':')).to_os_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[derive(Default)]
    struct Fake(Vec<OsString>);

    impl EnvRemove for Fake {
        fn remove_env(&mut self, key: &OsStr) {
            self.0.push(key.to_owned());
        }

        #[cfg(unix)]
        fn set_env(&mut self, key: &OsStr, _: &OsStr) {
            self.0.push(key.to_owned());
        }
    }

    #[test]
    fn strips_given_keys() {
        let mut fake = Fake::default();
        strip_keys(&mut fake, &["A", "B"]);
        assert_eq!(fake.0, ["A", "B"]);
    }

    #[test]
    fn nothing_recorded_means_no_op() {
        // Tests never call `record`, so the global list stays empty.
        let mut fake = Fake::default();
        strip_keys(&mut fake, recorded());
        assert!(fake.0.is_empty());
    }

    #[test]
    fn removes_from_real_command() {
        let mut command = std::process::Command::new("x");
        command.env("WERKTERM_CHILD_ENV_TEST", "1");
        strip_keys(&mut command, &["WERKTERM_CHILD_ENV_TEST"]);
        let entry = command
            .get_envs()
            .find(|(key, _)| *key == "WERKTERM_CHILD_ENV_TEST");
        assert_eq!(entry, Some(("WERKTERM_CHILD_ENV_TEST".as_ref(), None)));
    }

    #[cfg(unix)]
    const APPDIR: &str = "/tmp/.mount_werkteNDDNmJ";

    #[cfg(unix)]
    fn appimage_env() -> Vec<(OsString, OsString)> {
        let library_path = [
            "usr/lib",
            "usr/lib/i386-linux-gnu",
            "usr/lib/x86_64-linux-gnu",
            "usr/lib32",
            "usr/lib64",
            "lib",
            "lib/i386-linux-gnu",
            "lib/x86_64-linux-gnu",
            "lib32",
            "lib64",
        ]
        .map(|path| format!("{APPDIR}/{path}/"))
        .join(":");
        let path = format!(
            "{APPDIR}/usr/bin/:{APPDIR}/usr/sbin/:{APPDIR}/usr/games/:{APPDIR}/bin/:{APPDIR}/sbin/:/usr/local/bin:/usr/bin"
        );
        [
            ("APPDIR", APPDIR.into()),
            ("APPIMAGE", "/opt/Werkterm.AppImage".into()),
            ("ARGV0", "./Werkterm.AppImage".into()),
            ("OWD", "/home/user".into()),
            ("GTK_THEME", "Adwaita:dark".into()),
            ("PYTHONDONTWRITEBYTECODE", "1".into()),
            ("GST_REGISTRY_REUSE_PLUGIN_SCANNER", "no".into()),
            ("LD_LIBRARY_PATH", format!("{library_path}:/opt/custom/lib")),
            ("PATH", path),
            (
                "XDG_DATA_DIRS",
                format!(
                    "{APPDIR}/usr/share:/usr/share:{APPDIR}/usr/share/:/usr/local/share:/usr/share"
                ),
            ),
            ("GIO_MODULE_DIR", format!("{APPDIR}//usr/lib/gio/modules")),
        ]
        .map(|(key, value)| (key.into(), OsString::from(value)))
        .into()
    }

    #[cfg(unix)]
    #[test]
    fn strips_appimage_paths_and_launcher_variables() {
        let mut env = appimage_env();
        env.extend([
            (
                "LD_PRELOAD".into(),
                format!("{APPDIR}/preload.so /opt/user.so").into(),
            ),
            ("HOME".into(), "/home/user".into()),
            ("SIBLING".into(), format!("{APPDIR}X/lib").into()),
            ("PERLLIB".into(), "/opt/perl".into()),
            (
                "PYTHONPATH".into(),
                format!("{APPDIR}/usr/share/pyshared/:{APPDIR}:/tmp/.mount_werkteNDDNmJX/lib")
                    .into(),
            ),
        ]);
        let expected = [
            ("APPDIR", None),
            ("APPIMAGE", None),
            ("ARGV0", None),
            ("GIO_MODULE_DIR", None),
            ("GST_REGISTRY_REUSE_PLUGIN_SCANNER", None),
            ("GTK_THEME", None),
            ("LD_LIBRARY_PATH", Some("/opt/custom/lib")),
            ("LD_PRELOAD", Some("/opt/user.so")),
            ("OWD", None),
            ("PATH", Some("/usr/local/bin:/usr/bin")),
            ("PYTHONDONTWRITEBYTECODE", None),
            ("PYTHONPATH", Some("/tmp/.mount_werkteNDDNmJX/lib")),
            ("XDG_DATA_DIRS", Some("/usr/local/share:/usr/share")),
        ]
        .map(|(key, value)| (OsString::from(key), value.map(OsString::from)));
        assert_eq!(appimage_changes(&env, None), expected);
    }

    #[cfg(unix)]
    #[test]
    fn removes_library_path_without_a_previous_value() {
        let mut env = appimage_env();
        let (_, library_path) = env
            .iter_mut()
            .find(|(key, _)| key == "LD_LIBRARY_PATH")
            .unwrap();
        *library_path = library_path
            .to_str()
            .unwrap()
            .strip_suffix("/opt/custom/lib")
            .unwrap()
            .into();
        assert!(appimage_changes(&env, None).contains(&("LD_LIBRARY_PATH".into(), None)));
    }

    #[cfg(unix)]
    #[test]
    fn requires_valid_appdir_and_appimage_evidence() {
        for (appdir, appimage) in [
            (Some(APPDIR), None),
            (Some(APPDIR), Some("")),
            (Some("relative"), Some("/opt/Werkterm.AppImage")),
            (Some(""), Some("/opt/Werkterm.AppImage")),
            (Some("/"), Some("/opt/Werkterm.AppImage")),
            (None, Some("/opt/Werkterm.AppImage")),
        ] {
            let mut env = appimage_env();
            env.retain(|(key, _)| key != "APPDIR" && key != "APPIMAGE");
            env.extend(
                [("APPDIR", appdir), ("APPIMAGE", appimage)]
                    .into_iter()
                    .filter_map(|(key, value)| Some((key.into(), value?.into()))),
            );
            let exe = format!("{APPDIR}X/usr/bin/werkterm");
            assert!(appimage_changes(&env, Some(Path::new(&exe))).is_empty());
        }
    }

    #[cfg(unix)]
    #[test]
    fn strips_extracted_appimage_environment() {
        let mut env = appimage_env();
        let expected = appimage_changes(&env, None)
            .into_iter()
            .filter(|(key, _)| key != "APPIMAGE")
            .collect::<Vec<_>>();
        env.retain(|(key, _)| key != "APPIMAGE");
        let exe = format!("{APPDIR}/usr/bin/werkterm");

        assert_eq!(appimage_changes(&env, Some(Path::new(&exe))), expected);
    }

    #[cfg(unix)]
    #[test]
    fn cleans_path_lists_with_launcher_entries() {
        for (key, value, expected) in [
            (
                "PATH",
                format!("{APPDIR}/usr/bin/::/usr/bin"),
                Some(Some(":/usr/bin")),
            ),
            (
                "PATH",
                format!("{APPDIR}/usr/bin/:::/usr/bin"),
                Some(Some("::/usr/bin")),
            ),
            (
                "LD_LIBRARY_PATH",
                format!("{APPDIR}/usr/lib/:{APPDIR}/lib64/:"),
                Some(None),
            ),
            ("PATH", ":/usr/bin".into(), None),
            (
                "XDG_DATA_DIRS",
                format!(
                    "{APPDIR}/usr/share/:{APPDIR}/usr/share:/usr/share:/usr/local/share:/usr/share"
                ),
                Some(Some("/usr/local/share:/usr/share")),
            ),
            (
                "XDG_DATA_DIRS",
                format!("{APPDIR}/usr/share/:{APPDIR}/usr/share:/usr/share/:"),
                Some(None),
            ),
            (
                "XDG_DATA_DIRS",
                format!("{APPDIR}/usr/share/:{APPDIR}/usr/share:/usr/share:"),
                Some(None),
            ),
            (
                "XDG_DATA_DIRS",
                format!("{APPDIR}/usr/share/:{APPDIR}/usr/share:/usr/share:/usr/share:/opt/share"),
                Some(Some("/usr/share:/opt/share")),
            ),
            ("LD_PRELOAD", "/opt/user.so".into(), None),
            ("LD_PRELOAD", format!("{APPDIR}/preload.so "), Some(None)),
            (
                "LD_PRELOAD",
                format!("{APPDIR}/preload.so:/opt/user.so /opt/other.so"),
                Some(Some("/opt/user.so:/opt/other.so")),
            ),
        ] {
            let env = [
                ("APPDIR".into(), APPDIR.into()),
                ("APPIMAGE".into(), "/opt/Werkterm.AppImage".into()),
                (key.into(), OsString::from(&value)),
            ];
            let change = appimage_changes(&env, None)
                .into_iter()
                .find_map(|(name, value)| (name == key).then_some(value));
            assert_eq!(
                change,
                expected.map(|value| value.map(OsString::from)),
                "{key}={value}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn preserves_non_utf8_path_entries() {
        let mut env = appimage_env();
        let mut value = format!("{APPDIR}/plugins:").into_bytes();
        value.extend_from_slice(b":/opt/\xff:/opt/\xff:");
        env.push((
            "QT_PLUGIN_PATH".into(),
            OsStr::from_bytes(&value).to_owned(),
        ));
        let expected = OsStr::from_bytes(b":/opt/\xff:").to_owned();
        assert!(appimage_changes(&env, None).contains(&("QT_PLUGIN_PATH".into(), Some(expected))));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn child_process_receives_sanitized_environment() {
        let env = appimage_env();
        let mut command = std::process::Command::new("/usr/bin/env");
        command
            .env_clear()
            .envs(env.iter().map(|(key, value)| (key, value)));
        strip_appimage(&mut command, &env, None);

        let output = command.output().unwrap();
        assert!(output.status.success());
        let stdout = String::from_utf8(output.stdout).unwrap();
        let values: std::collections::HashMap<_, _> = stdout
            .lines()
            .map(|line| line.split_once('=').unwrap())
            .collect();
        assert!(values.values().all(|value| !value.contains(APPDIR)));
        assert_eq!(values.get("LD_LIBRARY_PATH"), Some(&"/opt/custom/lib"));
    }
}
