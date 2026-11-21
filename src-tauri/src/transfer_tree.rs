//! Recursive folder listings for folder uploads and downloads (issue #11).
//!
//! Both sides (remote via SFTP, local via `std::fs`) produce the same [`TreeListing`]:
//! relative paths joined with `/`, directories parent-first, files with their size.
//! Symbolic links are never followed below the selected folder; they are skipped and counted.
use crate::ui_error::{UiError, ui_err};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// More entries than this abort the listing instead of starting a partial transfer.
pub const MAX_ENTRIES: usize = 10_000;
/// Deepest directory level below the selected folder (its direct children are level 1).
pub const MAX_DEPTH: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeFile {
    /// Relative path below the selected folder, segments joined with `/`.
    pub path: String,
    pub size: u64,
    pub executable: bool,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeListing {
    /// Relative directory paths, parents before children.
    pub dirs: Vec<String>,
    pub files: Vec<TreeFile>,
    pub skipped_symlinks: u32,
    pub skipped_other: u32,
    /// Files and folders whose name cannot be used on the target side (not transferred).
    pub skipped_invalid: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TreeKind {
    Dir,
    File { size: u64, executable: bool },
    Symlink,
    Other,
}

/// A name that is safe as one path segment on both sides: no traversal, no separator of
/// either platform, no NUL. A remote `a\b` would become two segments on Windows.
pub fn tree_name_ok(name: &str) -> bool {
    !(name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0']))
}

/// Whether Windows can create a file or folder with this name: none of `<>:"|?*`, no control
/// characters, no trailing dot or space, no reserved device name (also with an extension,
/// e.g. `nul.txt`). Pure function so it is tested on every platform.
pub fn windows_name_ok(name: &str) -> bool {
    const RESERVED: [&str; 4] = ["CON", "PRN", "AUX", "NUL"];
    if name
        .chars()
        .any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        || name.ends_with(['.', ' '])
    {
        return false;
    }
    let stem = name.split('.').next().unwrap_or(name).trim_end_matches(' ');
    let upper = stem.to_uppercase();
    if RESERVED.contains(&upper.as_str()) {
        return false;
    }
    let numbered = |prefix: &str| {
        upper.strip_prefix(prefix).is_some_and(|rest| {
            matches!(
                rest,
                "1" | "2"
                    | "3"
                    | "4"
                    | "5"
                    | "6"
                    | "7"
                    | "8"
                    | "9"
                    | "\u{b9}"
                    | "\u{b2}"
                    | "\u{b3}"
            )
        })
    };
    !(numbered("COM") || numbered("LPT"))
}

/// Comparison key of a relative path on Windows: case-insensitive, trailing dots and spaces
/// of every segment ignored (Windows strips them).
fn windows_key(path: &str) -> String {
    path.split('/')
        .map(|segment| segment.trim_end_matches(['.', ' ']).to_lowercase())
        .collect::<Vec<_>>()
        .join("/")
}

impl TreeListing {
    fn entries(&self) -> usize {
        self.dirs.len()
            + self.files.len()
            + self.skipped_symlinks as usize
            + self.skipped_other as usize
            + self.skipped_invalid as usize
    }

    /// Fails as soon as the entry limit is reached, so callers can stop listing early.
    pub fn check_limit(&self) -> Result<(), String> {
        if self.entries() >= MAX_ENTRIES {
            Err(ui_err("TREE_TOO_MANY")
                .arg("limit", MAX_ENTRIES.to_string())
                .into())
        } else {
            Ok(())
        }
    }

    /// Records one entry below the relative directory `parent` (`""` is the selected folder).
    /// Returns the relative path of a directory that has to be listed next. Names that are not
    /// usable on the target (`windows`: target is a Windows file system) are skipped and counted.
    pub fn add(
        &mut self,
        parent: &str,
        name: &str,
        kind: TreeKind,
        windows: bool,
    ) -> Result<Option<String>, String> {
        self.check_limit()?;
        let usable = tree_name_ok(name) && (!windows || windows_name_ok(name));
        let path = if parent.is_empty() {
            name.to_owned()
        } else {
            format!("{parent}/{name}")
        };
        match kind {
            TreeKind::Dir | TreeKind::File { .. } if !usable => {
                self.skipped_invalid += 1;
                Ok(None)
            }
            TreeKind::Dir => {
                if path.split('/').count() > MAX_DEPTH {
                    return Err(ui_err("TREE_TOO_DEEP")
                        .arg("limit", MAX_DEPTH.to_string())
                        .into());
                }
                self.dirs.push(path.clone());
                Ok(Some(path))
            }
            TreeKind::File { size, executable } => {
                self.files.push(TreeFile {
                    path,
                    size,
                    executable,
                });
                Ok(None)
            }
            TreeKind::Symlink => {
                self.skipped_symlinks += 1;
                Ok(None)
            }
            TreeKind::Other => {
                self.skipped_other += 1;
                Ok(None)
            }
        }
    }

    /// Names that differ only in case or trailing dots/spaces would overwrite each other on
    /// Windows; such a folder is rejected before anything is transferred.
    pub fn check_windows_clashes(&self) -> Result<(), String> {
        let mut seen = std::collections::HashSet::new();
        for path in self
            .dirs
            .iter()
            .chain(self.files.iter().map(|file| &file.path))
        {
            if !seen.insert(windows_key(path)) {
                return Err(ui_err("TREE_NAME_CLASH").arg("name", path.as_str()).into());
            }
        }
        Ok(())
    }

    /// Sorted by path: a parent (`a`) always sorts before its children (`a/b`).
    pub fn finish(mut self) -> Self {
        self.dirs.sort();
        self.files.sort_by(|a, b| a.path.cmp(&b.path));
        self
    }
}

fn fs_error(code: UiError, error: std::io::Error) -> String {
    code.detail(error).into()
}

#[cfg(unix)]
fn is_executable(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_metadata: &std::fs::Metadata) -> bool {
    false
}

/// Permissions for a newly uploaded file: 0644, or 0755 if the local file is executable.
pub fn new_file_mode(metadata: &std::fs::Metadata) -> u32 {
    if is_executable(metadata) {
        0o755
    } else {
        0o644
    }
}

/// Lists a local folder recursively. The selected folder itself may be a link; nothing below it
/// is followed.
/// `cancelled` is checked before every directory.
pub fn list_local_tree(root: &Path, cancelled: &dyn Fn() -> bool) -> Result<TreeListing, String> {
    if !root.is_absolute() {
        return Err(ui_err("PATH_NOT_ABSOLUTE").into());
    }
    let meta = std::fs::metadata(root)
        .map_err(|error| fs_error(UiError::new("LOCAL_FS_METADATA"), error))?;
    if !meta.is_dir() {
        return Err(ui_err("TREE_NOT_DIRECTORY").into());
    }
    let mut tree = TreeListing::default();
    let mut pending: Vec<(PathBuf, String)> = vec![(root.to_path_buf(), String::new())];
    while let Some((directory, relative)) = pending.pop() {
        if cancelled() {
            return Err(ui_err("CANCELLED").into());
        }
        tree.check_limit()?;
        for entry in std::fs::read_dir(&directory)
            .map_err(|error| fs_error(UiError::new("LOCAL_FS_READ_DIR"), error))?
        {
            let entry =
                entry.map_err(|error| fs_error(UiError::new("LOCAL_FS_READ_DIR"), error))?;
            let file_name = entry.file_name();
            let meta = std::fs::symlink_metadata(entry.path())
                .map_err(|error| fs_error(UiError::new("LOCAL_FS_METADATA"), error))?;
            let kind = if meta.is_symlink() {
                TreeKind::Symlink
            } else if meta.is_dir() {
                TreeKind::Dir
            } else if meta.is_file() {
                TreeKind::File {
                    size: meta.len(),
                    executable: is_executable(&meta),
                }
            } else {
                TreeKind::Other
            };
            // A name that is not valid UTF-8 cannot be sent over SFTP: skipped and counted.
            let name = file_name.to_str().unwrap_or("");
            if let Some(child) = tree.add(&relative, name, kind, false)? {
                pending.push((entry.path(), child));
            }
        }
    }
    Ok(tree.finish())
}

/// Creates a local folder for a folder download. An existing folder is reused; an existing
/// file or link with that name is an error.
pub fn ensure_local_dir(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(ui_err("PATH_NOT_ABSOLUTE").into());
    }
    let check = |path: &Path| match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !meta.is_symlink() => Ok(true),
        Ok(_) => Err(String::from(
            ui_err("TARGET_NOT_DIRECTORY").arg("name", path.to_string_lossy()),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(fs_error(UiError::new("LOCAL_FS_METADATA"), error)),
    };
    if check(path)? {
        return Ok(());
    }
    match std::fs::create_dir(path) {
        Ok(()) => Ok(()),
        // Created concurrently: fine as long as it is a real directory now.
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && check(path)? => Ok(()),
        Err(error) => Err(fs_error(UiError::new("LOCAL_FS_CREATE_DIR"), error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    fn temp_dir(label: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "werkterm-tree-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        directory
    }
    fn never() -> bool {
        false
    }
    const FILE: TreeKind = TreeKind::File {
        size: 1,
        executable: false,
    };

    #[test]
    fn tree_names_reject_traversal_and_both_separators() {
        for name in ["", ".", "..", "a/b", "a\\b", "a\0b"] {
            assert!(!tree_name_ok(name), "{name:?}");
        }
        for name in [
            "file.txt",
            "a b",
            "Ä ö ü ß",
            "日本",
            "#1 (copy)",
            "..hidden",
            ".env",
        ] {
            assert!(tree_name_ok(name), "{name}");
        }
    }

    #[test]
    fn windows_names_follow_the_win32_rules() {
        for name in [
            "a<b",
            "a>b",
            "a:b",
            "a\"b",
            "a|b",
            "a?b",
            "a*b",
            "tab\there",
            "bell\u{7}",
            "trailing.",
            "trailing ",
            "CON",
            "con",
            "Prn.txt",
            "aux.tar.gz",
            "NUL",
            "nul .txt",
            "COM1",
            "com9.log",
            "LPT1",
            "lpt5.x",
            "COM\u{b9}",
            "LPT\u{b3}",
        ] {
            assert!(!windows_name_ok(name), "{name:?} must be rejected");
        }
        for name in [
            "file.txt",
            ".env",
            "..hidden",
            "CONSOLE",
            "con1",
            "COM0",
            "COM10",
            "LPT",
            "nul_x",
            "a.con",
            "Ä ö ü",
            "日本語",
            "x (1)",
            "a.b.c",
        ] {
            assert!(windows_name_ok(name), "{name:?} must be accepted");
        }
    }

    #[test]
    fn unusable_names_are_skipped_and_counted() {
        let mut tree = TreeListing::default();
        assert_eq!(tree.add("", "a\\b", FILE, false).unwrap(), None);
        assert_eq!(tree.add("", "..", TreeKind::Dir, false).unwrap(), None);
        assert_eq!(tree.add("", "nul.txt", FILE, false).unwrap(), None);
        assert_eq!(tree.add("", "nul.txt", FILE, true).unwrap(), None);
        assert_eq!(tree.add("", "x:y", TreeKind::Dir, true).unwrap(), None);
        // Links and special files keep their own counters, whatever their name.
        tree.add("", "a/b", TreeKind::Symlink, true).unwrap();
        tree.add("", "x\\y", TreeKind::Other, true).unwrap();
        assert_eq!(tree.files.len(), 1);
        assert_eq!(tree.files[0].path, "nul.txt");
        assert_eq!(
            (
                tree.skipped_invalid,
                tree.skipped_symlinks,
                tree.skipped_other
            ),
            (4, 1, 1)
        );
    }

    #[test]
    fn windows_clashes_ignore_case_and_trailing_dots() {
        let mut tree = TreeListing::default();
        tree.add("", "Readme.md", FILE, false).unwrap();
        tree.add("", "src", TreeKind::Dir, false).unwrap();
        tree.add("src", "main.rs", FILE, false).unwrap();
        assert!(tree.check_windows_clashes().is_ok());
        tree.add("", "README.md", FILE, false).unwrap();
        let error = tree.check_windows_clashes().unwrap_err();
        assert!(error.starts_with("TREE_NAME_CLASH"), "{error}");
        assert!(error.contains("README.md"), "{error}");
        let mut tree = TreeListing::default();
        tree.add("", "Logs", TreeKind::Dir, false).unwrap();
        tree.add("", "logs.", FILE, false).unwrap();
        assert!(tree.check_windows_clashes().is_err());
        let mut tree = TreeListing::default();
        tree.add("", "a", TreeKind::Dir, false).unwrap();
        tree.add("a", "x", FILE, false).unwrap();
        tree.add("", "b", TreeKind::Dir, false).unwrap();
        tree.add("b", "X", FILE, false).unwrap();
        assert!(tree.check_windows_clashes().is_ok());
    }

    #[test]
    fn lists_nested_folders_parent_first_with_special_names() {
        let root = temp_dir("list");
        std::fs::create_dir_all(root.join("Ä b").join("ü #1")).unwrap();
        std::fs::create_dir(root.join("empty")).unwrap();
        std::fs::write(root.join("top.txt"), b"12345").unwrap();
        std::fs::write(root.join("Ä b").join("ü #1").join("deep (1).log"), b"x").unwrap();
        let tree = list_local_tree(&root, &never).unwrap();
        assert_eq!(tree.dirs, ["empty", "Ä b", "Ä b/ü #1"]);
        assert_eq!(
            tree.files
                .iter()
                .map(|file| (file.path.as_str(), file.size))
                .collect::<Vec<_>>(),
            [("top.txt", 5), ("Ä b/ü #1/deep (1).log", 1)]
        );
        assert_eq!((tree.skipped_symlinks, tree.skipped_invalid), (0, 0));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancelled_listing_stops_before_the_next_folder() {
        let root = temp_dir("cancel");
        std::fs::create_dir(root.join("sub")).unwrap();
        std::fs::write(root.join("sub").join("f"), b"x").unwrap();
        let calls = std::cell::Cell::new(0);
        let cancelled = || {
            calls.set(calls.get() + 1);
            calls.get() > 1
        };
        assert_eq!(list_local_tree(&root, &cancelled).unwrap_err(), "CANCELLED");
        assert_eq!(calls.get(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_files_and_relative_roots() {
        let root = temp_dir("file");
        std::fs::write(root.join("file"), b"x").unwrap();
        assert_eq!(
            list_local_tree(&root.join("file"), &never).unwrap_err(),
            "TREE_NOT_DIRECTORY"
        );
        assert_eq!(
            list_local_tree(Path::new("relative"), &never).unwrap_err(),
            "PATH_NOT_ABSOLUTE"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn entry_limit_aborts_instead_of_truncating() {
        let mut tree = TreeListing::default();
        for index in 0..MAX_ENTRIES {
            tree.add("", &format!("f{index}"), FILE, false).unwrap();
        }
        let error = tree.check_limit().unwrap_err();
        assert!(error.starts_with("TREE_TOO_MANY"), "{error}");
        let error = tree
            .add("", "one-more", TreeKind::Symlink, false)
            .unwrap_err();
        assert!(error.contains("10000"), "{error}");
    }

    #[test]
    fn depth_limit_applies_to_directories() {
        let mut tree = TreeListing::default();
        let mut parent = String::new();
        for _ in 0..MAX_DEPTH {
            parent = tree
                .add(&parent, "d", TreeKind::Dir, false)
                .unwrap()
                .unwrap();
        }
        assert_eq!(parent.split('/').count(), MAX_DEPTH);
        // A file at the deepest level is fine, another folder level is not.
        tree.add(&parent, "f", FILE, false).unwrap();
        let error = tree.add(&parent, "d", TreeKind::Dir, false).unwrap_err();
        assert!(error.starts_with("TREE_TOO_DEEP"), "{error}");
    }

    #[test]
    fn deep_local_folder_hits_depth_limit() {
        let root = temp_dir("deep");
        let mut path = root.clone();
        for _ in 0..=MAX_DEPTH {
            path.push("d");
        }
        if std::fs::create_dir_all(&path).is_err() {
            // Path length limits of the platform; the limit itself is covered above.
            std::fs::remove_dir_all(root).unwrap();
            return;
        }
        let error = list_local_tree(&root, &never).unwrap_err();
        assert!(error.starts_with("TREE_TOO_DEEP"), "{error}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_skipped_and_executables_marked() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let root = temp_dir("links");
        let outside = temp_dir("outside");
        std::fs::write(outside.join("secret"), b"x").unwrap();
        symlink(&outside, root.join("dir-link")).unwrap();
        symlink(outside.join("secret"), root.join("file-link")).unwrap();
        std::fs::write(root.join("run.sh"), b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(root.join("run.sh"), std::fs::Permissions::from_mode(0o750))
            .unwrap();
        std::fs::write(root.join("plain"), b"").unwrap();
        std::fs::set_permissions(root.join("plain"), std::fs::Permissions::from_mode(0o640))
            .unwrap();
        let tree = list_local_tree(&root, &never).unwrap();
        assert_eq!(tree.skipped_symlinks, 2);
        assert!(tree.dirs.is_empty());
        assert_eq!(
            tree.files
                .iter()
                .map(|file| (file.path.as_str(), file.executable))
                .collect::<Vec<_>>(),
            [("plain", false), ("run.sh", true)]
        );
        let meta = std::fs::metadata(root.join("run.sh")).unwrap();
        assert_eq!(new_file_mode(&meta), 0o755);
        assert_eq!(
            new_file_mode(&std::fs::metadata(root.join("plain")).unwrap()),
            0o644
        );
        // The selected folder itself may be a link.
        let linked = list_local_tree(&root.join("dir-link"), &never).unwrap();
        assert_eq!(linked.files.len(), 1);
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_local_names_are_skipped() {
        use std::os::unix::ffi::OsStrExt;
        let root = temp_dir("utf8");
        let name = std::ffi::OsStr::from_bytes(b"bad\xff");
        if std::fs::write(root.join(name), b"x").is_ok() {
            let tree = list_local_tree(&root, &never).unwrap();
            assert_eq!((tree.files.len(), tree.skipped_invalid), (0, 1));
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ensure_local_dir_creates_and_reuses_but_never_replaces_files() {
        let root = temp_dir("ensure");
        let target = root.join("neu ä");
        ensure_local_dir(&target).unwrap();
        assert!(target.is_dir());
        std::fs::write(target.join("keep"), b"data").unwrap();
        ensure_local_dir(&target).unwrap();
        assert_eq!(std::fs::read(target.join("keep")).unwrap(), b"data");
        std::fs::write(root.join("file"), b"x").unwrap();
        let error = ensure_local_dir(&root.join("file")).unwrap_err();
        assert!(error.starts_with("TARGET_NOT_DIRECTORY"), "{error}");
        assert_eq!(std::fs::read(root.join("file")).unwrap(), b"x");
        assert_eq!(
            ensure_local_dir(Path::new("rel")).unwrap_err(),
            "PATH_NOT_ABSOLUTE"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
