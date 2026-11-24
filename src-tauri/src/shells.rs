use crate::pty::{PtyError, ShellKind, ShellSpec, bash_osc7_startup, powershell_args};
use crate::ui_error::ui_err;
use serde::Serialize;
#[cfg(any(windows, test))]
use std::ffi::OsStr;
use std::path::Path;
use std::path::PathBuf;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfile {
    pub id: String,
    pub kind: ShellKind,
    pub label: String,
    pub version: Option<String>,
    pub is_default: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub struct WslDistro {
    pub name: String,
    pub default: bool,
    pub running: bool,
    pub version: Option<u8>,
}

pub fn parse_wsl_list(output: &[u8]) -> Vec<WslDistro> {
    let bytes = output.strip_prefix(&[0xff, 0xfe]).unwrap_or(output);
    let decoded = if bytes.len() != output.len()
        || (bytes.len() >= 2 && bytes.iter().take(64).skip(1).step_by(2).all(|&b| b == 0))
    {
        String::from_utf16_lossy(
            &bytes
                .as_chunks::<2>()
                .0
                .iter()
                .copied()
                .map(u16::from_le_bytes)
                .collect::<Vec<_>>(),
        )
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };

    decoded
        .replace('\0', "")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .skip(1)
        .filter_map(|line| {
            let default = line.starts_with('*');
            let mut fields = line.strip_prefix('*').unwrap_or(line).split_whitespace();
            let name = fields.next()?;
            let state = fields.next()?;
            let version = fields.next()?.parse().ok()?;
            if fields.next().is_some() || name.to_ascii_lowercase().starts_with("docker-desktop") {
                return None;
            }
            Some(WslDistro {
                name: name.to_owned(),
                default,
                running: state.eq_ignore_ascii_case("Running"),
                version: Some(version),
            })
        })
        .collect()
}

#[cfg(any(windows, test))]
fn path_key(path: &Path) -> String {
    let key = path.to_string_lossy().to_lowercase();
    #[cfg(windows)]
    let key = key.replace('/', "\\");
    key
}

#[cfg(any(windows, test))]
fn pwsh_candidates(
    path_var: Option<&OsStr>,
    program_files: Option<&Path>,
    local_app_data: Option<&Path>,
    exists: impl Fn(&Path) -> bool,
) -> Vec<PathBuf> {
    let alias =
        local_app_data.map(|dir| dir.join("Microsoft").join("WindowsApps").join("pwsh.exe"));
    let alias_key = alias.as_deref().map(|path| {
        std::path::absolute(path).map_or_else(|_| path_key(path), |absolute| path_key(&absolute))
    });
    let from_path = path_var
        .into_iter()
        .flat_map(std::env::split_paths)
        .map(|dir| dir.join("pwsh.exe"));
    let mut installations: Vec<_> = program_files
        .and_then(|dir| dir.join("PowerShell").read_dir().ok())
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("pwsh.exe"))
        .collect();
    installations.sort();

    let mut seen = std::collections::HashSet::new();
    let mut candidates: Vec<_> = from_path
        .chain(installations)
        .filter_map(|path| {
            let path = std::path::absolute(&path).unwrap_or(path);
            if alias_key
                .as_ref()
                .is_some_and(|key| *key == path_key(&path))
                || !exists(&path)
            {
                return None;
            }
            let path = path.canonicalize().unwrap_or(path);
            seen.insert(path_key(&path)).then_some(path)
        })
        .collect();
    if candidates.is_empty() {
        candidates.extend(alias.filter(|path| exists(path)));
    }
    candidates
}

fn profile_missing(id: &str) -> PtyError {
    let name = id
        .strip_prefix("pwsh:")
        .or_else(|| id.strip_prefix("wsl:"))
        .unwrap_or(id);
    PtyError::Operation(ui_err("PTY_PROFILE_MISSING").arg("name", name))
}

pub fn resolve_profile(
    id: &str,
    kind: ShellKind,
    profiles: &[ShellProfile],
    system_root: &Path,
    cmd_path: Option<&Path>,
    shell_integration: bool,
) -> Result<ShellSpec, PtyError> {
    let profile = profiles
        .iter()
        .find(|profile| {
            profile.kind == kind
                && (profile.id == id
                    || (profile.id.starts_with("pwsh:")
                        && id.starts_with("pwsh:")
                        && profile.id.to_lowercase() == id.to_lowercase()))
        })
        .ok_or_else(|| profile_missing(id))?;

    let (program, args) = match (kind, profile.id.as_str()) {
        (ShellKind::Local, "powershell") => (
            powershell_path(system_root).to_string_lossy().into_owned(),
            powershell_args(shell_integration),
        ),
        (ShellKind::Local, "cmd") => (
            cmd_path
                .ok_or_else(|| profile_missing(id))?
                .to_string_lossy()
                .into_owned(),
            Vec::new(),
        ),
        (ShellKind::Local, found) if found.starts_with("pwsh:") => (
            found["pwsh:".len()..].to_owned(),
            powershell_args(shell_integration),
        ),
        (ShellKind::Wsl, found) if found.starts_with("wsl:") => {
            let mut args = vec!["-d".to_owned(), found["wsl:".len()..].to_owned()];
            if shell_integration {
                args.extend(["-e".into(), "bash".into(), "-c".into(), bash_osc7_startup()]);
            }
            ("wsl.exe".into(), args)
        }
        _ => return Err(profile_missing(id)),
    };
    Ok(ShellSpec {
        program,
        args,
        env: Vec::new(),
    })
}

fn powershell_path(system_root: &Path) -> PathBuf {
    system_root.join("System32/WindowsPowerShell/v1.0/powershell.exe")
}

pub fn detect_profiles() -> Vec<ShellProfile> {
    #[cfg(windows)]
    {
        windows::detect().profiles
    }
    #[cfg(not(windows))]
    Vec::new()
}

pub(crate) fn resolve_installed_profile(
    id: &str,
    kind: ShellKind,
    shell_integration: bool,
) -> Result<ShellSpec, PtyError> {
    #[cfg(windows)]
    {
        let installed = windows::detect();
        resolve_profile(
            id,
            kind,
            &installed.profiles,
            &installed.system_root,
            installed.cmd_path.as_deref(),
            shell_integration,
        )
    }
    #[cfg(not(windows))]
    {
        let _ = (kind, shell_integration);
        Err(profile_missing(id))
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::ffi::c_void;
    use std::io::Read;
    use std::os::windows::{ffi::OsStrExt, process::CommandExt};
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VS_FIXEDFILEINFO, VerQueryValueW,
    };

    pub(super) struct Installed {
        pub profiles: Vec<ShellProfile>,
        pub system_root: PathBuf,
        pub cmd_path: Option<PathBuf>,
    }

    pub(super) fn detect() -> Installed {
        let system_root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_default();
        let cmd_path = Some(system_root.join("System32/cmd.exe"))
            .filter(|path| path.is_absolute() && path.is_file())
            .or_else(|| {
                let path = std::path::absolute(std::env::var_os("ComSpec")?).ok()?;
                path.is_file().then_some(path)
            });

        let candidates = pwsh_candidates(
            std::env::var_os("PATH").as_deref(),
            std::env::var_os("ProgramFiles").as_deref().map(Path::new),
            std::env::var_os("LOCALAPPDATA").as_deref().map(Path::new),
            |path| {
                path.symlink_metadata()
                    .is_ok_and(|metadata| !metadata.is_dir())
            },
        );
        let mut pwsh: Vec<_> = candidates
            .into_iter()
            .map(|path| {
                let version = product_version(&path);
                let preview = version
                    .as_ref()
                    .is_some_and(|value| value.to_lowercase().contains("preview"))
                    || path
                        .parent()
                        .and_then(Path::file_name)
                        .is_some_and(|folder| {
                            folder.to_string_lossy().to_lowercase().contains("preview")
                        });
                let label = match &version {
                    Some(value) => format!("PowerShell {value}"),
                    None if preview => "PowerShell 7 (Preview)".to_owned(),
                    None => "PowerShell 7".to_owned(),
                };
                let version_numbers = version.as_deref().map(|value| {
                    value
                        .split(|c: char| !c.is_ascii_digit())
                        .filter_map(|part| part.parse::<u32>().ok())
                        .collect::<Vec<_>>()
                });
                (
                    preview,
                    version_numbers,
                    ShellProfile {
                        id: format!("pwsh:{}", path.display()),
                        kind: ShellKind::Local,
                        label,
                        version,
                        is_default: false,
                    },
                )
            })
            .collect();
        pwsh.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| b.1.cmp(&a.1)));
        let mut profiles: Vec<_> = pwsh.into_iter().map(|(_, _, profile)| profile).collect();

        if system_root.is_absolute() && powershell_path(&system_root).is_file() {
            profiles.push(ShellProfile {
                id: "powershell".into(),
                kind: ShellKind::Local,
                label: "Windows PowerShell 5.1".into(),
                version: Some("5.1".into()),
                is_default: false,
            });
        }
        if cmd_path.is_some() {
            profiles.push(ShellProfile {
                id: "cmd".into(),
                kind: ShellKind::Local,
                label: "cmd".into(),
                version: None,
                is_default: false,
            });
        }

        let mut distros = wsl_output().map_or_else(Vec::new, |bytes| parse_wsl_list(&bytes));
        distros.sort_by_cached_key(|distro| (!distro.default, distro.name.to_lowercase()));
        profiles.extend(distros.into_iter().map(|distro| ShellProfile {
            id: format!("wsl:{}", distro.name),
            kind: ShellKind::Wsl,
            label: distro.name,
            version: distro.version.map(|version| version.to_string()),
            is_default: distro.default,
        }));
        Installed {
            profiles,
            system_root,
            cmd_path,
        }
    }

    fn wsl_output() -> Option<Vec<u8>> {
        if !crate::pty::program_in_path("wsl.exe") {
            return None;
        }
        let mut child = Command::new("wsl.exe")
            .args(["--list", "--verbose"])
            .creation_flags(0x0800_0000)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut stdout = child.stdout.take().expect("stdout was piped");
        // Drain the pipe concurrently so large listings can finish before the deadline.
        let (send, receive) = mpsc::channel();
        let reader = thread::Builder::new().spawn(move || {
            let mut bytes = Vec::new();
            if stdout.read_to_end(&mut bytes).is_ok() {
                let _ = send.send(bytes);
            }
        });
        if reader.is_ok() {
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match child.try_wait() {
                    Ok(Some(status)) => {
                        return status
                            .success()
                            .then(|| {
                                receive
                                    .recv_timeout(
                                        deadline.saturating_duration_since(Instant::now()),
                                    )
                                    .ok()
                            })
                            .flatten();
                    }
                    Ok(None) => thread::sleep(remaining.min(Duration::from_millis(20))),
                    Err(_) => break,
                }
            }
        }
        let _ = child.kill();
        // Reap the process without extending the caller's deadline.
        let _ = thread::Builder::new().spawn(move || child.wait());
        None
    }

    fn product_version(path: &Path) -> Option<String> {
        let filename: Vec<_> = path.as_os_str().encode_wide().chain([0]).collect();
        // SAFETY: filename is NUL-terminated and the output handle is optional.
        let size = unsafe { GetFileVersionInfoSizeW(filename.as_ptr(), std::ptr::null_mut()) };
        if size == 0 {
            return None;
        }
        let mut buffer = vec![0_u32; (size as usize).div_ceil(4)];
        // SAFETY: buffer is writable for at least size bytes.
        if unsafe { GetFileVersionInfoW(filename.as_ptr(), 0, size, buffer.as_mut_ptr().cast()) }
            == 0
        {
            return None;
        }

        let query = |key: &str| -> Option<(*mut c_void, usize)> {
            let key: Vec<_> = key.encode_utf16().chain([0]).collect();
            let mut data = std::ptr::null_mut();
            let mut length = 0;
            // SAFETY: buffer holds a version resource and key is NUL-terminated.
            let ok = unsafe {
                VerQueryValueW(buffer.as_ptr().cast(), key.as_ptr(), &mut data, &mut length)
            };
            (ok != 0 && !data.is_null()).then_some((data, length as usize))
        };

        if let Some((data, length)) = query(r"\VarFileInfo\Translation") {
            for index in 0..length / 4 {
                // SAFETY: the translation block contains length bytes of language/codepage pairs.
                let pair = unsafe { data.cast::<[u16; 2]>().add(index).read_unaligned() };
                let key = format!(
                    r"\StringFileInfo\{:04x}{:04x}\ProductVersion",
                    pair[0], pair[1]
                );
                if let Some((value, length)) = query(&key) {
                    // SAFETY: a string query returns length UTF-16 code units.
                    let units = unsafe { std::slice::from_raw_parts(value.cast::<u16>(), length) };
                    let version = String::from_utf16_lossy(units.split(|&unit| unit == 0).next()?);
                    if let Some(token) = version.split_whitespace().next() {
                        return Some(token.to_owned());
                    }
                }
            }
        }

        let (data, length) = query(r"\")?;
        if length < std::mem::size_of::<VS_FIXEDFILEINFO>() {
            return None;
        }
        // SAFETY: the root query returns a VS_FIXEDFILEINFO of the checked size.
        let fixed = unsafe { data.cast::<VS_FIXEDFILEINFO>().read_unaligned() };
        let ms = fixed.dwProductVersionMS;
        let ls = fixed.dwProductVersionLS;
        (fixed.dwSignature == 0xfeef04bd && (ms != 0 || ls != 0))
            .then(|| format!("{}.{}.{}.{}", ms >> 16, ms & 0xffff, ls >> 16, ls & 0xffff))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_wsl_list_in_each_encoding() {
        let listing = "\r\n  NAME            STATUS          VERSION\r\n\
                       * Ubuntu          rUnNiNg         2\r\n\
                         Debian          Stopped         1\r\n\
                         D\0istro         Wird-ausgeführt 2\r\n\
                         docker-desktop  Running         2\r\n\
                         Docker-Desktop-Data Stopped     2\r\n\
                         malformed       Running\r\n\
                         bad-version     Stopped         x\r\n\
                         extra-field     Running         2 trailing\r\n";
        let utf16: Vec<_> = listing.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let with_bom = [&[0xff, 0xfe], utf16.as_slice()].concat();
        let expected = [
            WslDistro {
                name: "Ubuntu".into(),
                default: true,
                running: true,
                version: Some(2),
            },
            WslDistro {
                name: "Debian".into(),
                default: false,
                running: false,
                version: Some(1),
            },
            WslDistro {
                name: "Distro".into(),
                default: false,
                running: false,
                version: Some(2),
            },
        ];
        for bytes in [listing.as_bytes(), &utf16, &with_bom] {
            assert_eq!(parse_wsl_list(bytes), expected);
        }
    }

    #[test]
    fn rejects_wsl_errors_and_empty_output() {
        for bytes in [
            &b""[..],
            b"\r\n",
            b"Windows Subsystem for Linux has no installed distributions.\r\n",
            b"\xff\x12\x03\r\n",
        ] {
            assert!(parse_wsl_list(bytes).is_empty());
        }
    }

    #[test]
    fn collects_pwsh_in_source_order_without_duplicates_or_redundant_alias() {
        let root =
            std::env::temp_dir().join(format!("werkterm-pwsh-candidates-{}", std::process::id()));
        let first = root.join("first");
        let second = root.join("second");
        let installations = root.join("program-files");
        let stable = installations.join("PowerShell/7");
        let preview = installations.join("PowerShell/7-preview");
        let app_data = root.join("app-data");
        let alias = app_data.join("Microsoft").join("WindowsApps");
        std::fs::create_dir_all(&stable).unwrap();
        std::fs::create_dir_all(&preview).unwrap();
        let uppercase = root.join("FIRST");
        let path = std::env::join_paths([&first, &uppercase, &second, &alias, &stable]).unwrap();
        let found = pwsh_candidates(Some(&path), Some(&installations), Some(&app_data), |_| true);
        let alias_only = std::env::join_paths([&alias]).unwrap();
        let found_alias = pwsh_candidates(Some(&alias_only), None, Some(&app_data), |_| true);
        let found_none =
            pwsh_candidates(Some(&path), Some(&installations), Some(&app_data), |_| {
                false
            });
        std::fs::remove_dir_all(&root).unwrap();

        assert_eq!(
            found,
            [first, second, stable, preview]
                .map(|dir| std::path::absolute(dir.join("pwsh.exe")).unwrap())
        );
        assert_eq!(found_alias, [alias.join("pwsh.exe")]);
        assert!(found_none.is_empty());
    }

    #[test]
    fn resolves_installed_profiles_and_preserves_argument_boundaries() {
        let root = Path::new("/Windows");
        let cmd = root.join("System32/cmd.exe");
        let distro = "Distro;literal";
        let profiles = [
            ("pwsh:/Apps/pwsh.exe", ShellKind::Local),
            ("powershell", ShellKind::Local),
            ("cmd", ShellKind::Local),
            ("wsl:Distro;literal", ShellKind::Wsl),
        ]
        .map(|(id, kind)| ShellProfile {
            id: id.into(),
            kind,
            label: String::new(),
            version: None,
            is_default: false,
        });
        let resolve =
            |id, kind, integrate| resolve_profile(id, kind, &profiles, root, Some(&cmd), integrate);
        for (id, program) in [
            ("pwsh:/apps/PWSH.EXE", "/Apps/pwsh.exe".into()),
            ("powershell", powershell_path(root)),
        ] {
            let plain = resolve(id, ShellKind::Local, false).unwrap();
            assert_eq!(plain.program, program.to_string_lossy());
            assert_eq!(plain.args, ["-NoLogo"]);
            assert_eq!(
                resolve(id, ShellKind::Local, true).unwrap().args,
                powershell_args(true)
            );
        }
        let cmd_spec = resolve("cmd", ShellKind::Local, true).unwrap();
        assert_eq!(cmd_spec.program, cmd.to_string_lossy());
        assert!(cmd_spec.args.is_empty());

        let wsl = resolve("wsl:Distro;literal", ShellKind::Wsl, false).unwrap();
        assert_eq!(wsl.program, "wsl.exe");
        assert_eq!(wsl.args, ["-d", distro]);
        assert_eq!(
            resolve("wsl:Distro;literal", ShellKind::Wsl, true)
                .unwrap()
                .args,
            ["-d", distro, "-e", "bash", "-c", &bash_osc7_startup()]
        );

        for (id, kind, name) in [
            ("wsl:Distro;literal", ShellKind::Local, distro),
            ("cmd", ShellKind::Wsl, "cmd"),
            ("pwsh:/unknown.exe", ShellKind::Local, "/unknown.exe"),
            ("wsl:Missing", ShellKind::Wsl, "Missing"),
            ("unknown", ShellKind::Local, "unknown"),
        ] {
            let error = resolve(id, kind, false).unwrap_err().to_string();
            assert_eq!(
                error,
                format!(r#"PTY_PROFILE_MISSING: {{"args":{{"name":"{name}"}}}}"#)
            );
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn installed_profiles_are_unavailable_on_other_platforms() {
        assert!(detect_profiles().is_empty());
        assert!(resolve_installed_profile("cmd", ShellKind::Local, false).is_err());
    }
}
