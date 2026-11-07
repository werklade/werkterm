use crate::ssh::{DirEntry, DirListing};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub fn wsl_unc_path(distro: &str, path: &str) -> Result<PathBuf, String> {
    if distro.is_empty()
        || distro == "."
        || distro == ".."
        || distro
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
        || !path.starts_with('/')
        || path.contains('\\')
        || path.contains('\0')
    {
        return Err("Ungültige WSL-Distribution oder ungültiger Linux-Pfad".to_owned());
    }
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            value if value.contains(':') => return Err("Ungültiger Linux-Pfad".to_owned()),
            value => parts.push(value),
        }
    }
    let mut result = format!(r"\\wsl.localhost\{distro}");
    for part in parts {
        result.push('\\');
        result.push_str(part);
    }
    Ok(PathBuf::from(result))
}

/// Drop the Windows verbatim prefix that `canonicalize` adds (`\\?\C:\x`, `\\?\UNC\srv\x`).
fn display_local_path(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        path.to_owned()
    }
}

pub fn list_local_dir(path: String, wsl_distro: Option<String>) -> Result<DirListing, String> {
    let (directory, display_path) = if let Some(distro) = wsl_distro {
        if !cfg!(windows) {
            return Err("WSL ist nur unter Windows verfügbar".to_owned());
        }
        let directory = wsl_unc_path(&distro, &path)?;
        (directory, path)
    } else {
        let directory = if path.is_empty() {
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map(PathBuf::from)
                .ok_or_else(|| "Home-Verzeichnis ist nicht gesetzt".to_owned())?
        } else {
            PathBuf::from(path)
        };
        let directory = directory
            .canonicalize()
            .map_err(|error| format!("Verzeichnis kann nicht aufgelöst werden: {error}"))?;
        let display_path = display_local_path(&directory.to_string_lossy());
        (directory, display_path)
    };
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&directory)
        .map_err(|error| format!("Verzeichnis kann nicht gelesen werden: {error}"))?
    {
        let entry = entry
            .map_err(|error| format!("Verzeichniseintrag kann nicht gelesen werden: {error}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "." || name == ".." {
            continue;
        }
        let metadata = std::fs::symlink_metadata(entry.path())
            .map_err(|error| format!("Dateiinformationen können nicht gelesen werden: {error}"))?;
        let kind = if metadata.is_symlink() {
            "symlink"
        } else if metadata.is_dir() {
            "dir"
        } else if metadata.is_file() {
            "file"
        } else {
            "other"
        };
        entries.push(DirEntry {
            uid: None,
            gid: None,
            user: None,
            group: None,
            name,
            kind: kind.to_owned(),
            size: metadata.len(),
            permissions: permissions(&metadata),
            modified: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|time| time.as_secs()),
            target_is_dir: metadata.is_symlink() && Path::new(&entry.path()).is_dir(),
        });
    }
    entries.sort_by(|a, b| {
        (a.kind != "dir")
            .cmp(&(b.kind != "dir"))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(DirListing {
        sudo: false,
        path: display_path,
        mode: "local".to_owned(),
        entries,
    })
}

#[cfg(unix)]
fn permissions(metadata: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o7777
}

#[cfg(not(unix))]
fn permissions(metadata: &std::fs::Metadata) -> u32 {
    let mode = if metadata.is_dir() { 0o755 } else { 0o644 };
    if metadata.permissions().readonly() {
        mode & !0o222
    } else {
        mode
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_path_drops_verbatim_prefix() {
        assert_eq!(display_local_path(r"\\?\C:\Users\marck"), r"C:\Users\marck");
        assert_eq!(display_local_path(r"\\?\UNC\srv\share"), r"\\srv\share");
        assert_eq!(display_local_path("/home/marck"), "/home/marck");
    }

    #[test]
    fn converts_wsl_paths_without_escaping_share() {
        assert_eq!(
            wsl_unc_path("Ubuntu", "/home/marck").unwrap(),
            PathBuf::from(r"\\wsl.localhost\Ubuntu\home\marck")
        );
        assert_eq!(
            wsl_unc_path("Ubuntu-24.04", "/").unwrap(),
            PathBuf::from(r"\\wsl.localhost\Ubuntu-24.04")
        );
        assert_eq!(
            wsl_unc_path("Ubuntu", "/../../home").unwrap(),
            PathBuf::from(r"\\wsl.localhost\Ubuntu\home")
        );
        for (distro, path) in [
            ("", "/"),
            ("../x", "/"),
            ("Ubuntu", "relative"),
            ("Ubuntu", "/a\\b"),
            ("Ubuntu", "/a:b"),
        ] {
            assert!(wsl_unc_path(distro, path).is_err());
        }
    }

    #[test]
    fn lists_and_sorts_temp_directory() {
        let directory = std::env::temp_dir().join(format!(
            "werkterm-local-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        std::fs::create_dir(directory.join("zFolder")).unwrap();
        std::fs::write(directory.join("Beta file"), b"hello").unwrap();
        std::fs::write(directory.join("alpha"), b"x").unwrap();
        let listing = list_local_dir(directory.to_string_lossy().into_owned(), None).unwrap();
        assert_eq!(listing.mode, "local");
        assert_eq!(
            listing
                .entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["zFolder", "alpha", "Beta file"]
        );
        assert_eq!(listing.entries[0].kind, "dir");
        assert_eq!(listing.entries[2].size, 5);
        assert!(listing.entries[2].modified.is_some());
        assert_eq!(listing.entries[2].permissions & !0o7777, 0);
        std::fs::remove_dir_all(directory).unwrap();
    }
}

/// Save-dialog callers have already confirmed replacement of existing files.
#[tauri::command]
pub fn save_text_file(path: String, contents: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("Export path must be absolute".into());
    }
    std::fs::write(path, contents.as_bytes()).map_err(|error| error.to_string())
}

#[cfg(test)]
mod export_tests {
    #[test]
    fn rejects_relative_export_path() {
        assert!(super::save_text_file("relative.txt".into(), "text".into()).is_err());
    }
}
