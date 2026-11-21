//! Logical session folders. A folder exists while a session lies in it or below it, or while it is
//! listed as an empty folder in `sessions.json` (`folders`). All changes here work on the loaded
//! session list in memory; the caller writes the result in one atomic replacement. Session ids and
//! jump-host references are never touched, only the `folder` field.
use super::SavedSession;
use crate::ui_error::ui_err;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashSet};

/// Upper bound for a folder path in characters.
pub const MAX_FOLDER_LENGTH: usize = 1024;

/// Folder of one session before (`folder`) and after (`expected`) a change, for undo.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FolderAssignment {
    pub id: String,
    pub folder: String,
    pub expected: String,
}

/// What a change did, so that undo turns back exactly this change: the sessions it moved and the
/// empty folders it added to or removed from the list.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LayoutSnapshot {
    pub sessions: Vec<FolderAssignment>,
    #[serde(default)]
    pub added: Vec<String>,
    #[serde(default)]
    pub removed: Vec<String>,
}

/// Result of a layout change. `changed == false` means nothing was written.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutChange {
    pub changed: bool,
    /// Number of sessions whose folder changed.
    pub moved: usize,
    /// Undo only: sessions left alone because they were deleted or moved elsewhere meanwhile.
    pub skipped: usize,
    pub undo: LayoutSnapshot,
}

/// Whitespace trimmed from folder segments, identical to `isTrimmed` in the frontend:
/// ASCII space, \t, \n, \r, \f, \v, the Unicode space separators (Zs) and U+FEFF.
pub fn is_trimmed(ch: char) -> bool {
    matches!(
        ch,
        ' ' | '\t'
            | '\n'
            | '\r'
            | '\u{0c}'
            | '\u{0b}'
            | '\u{feff}'
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}' | '\u{202f}' | '\u{205f}' | '\u{3000}'
    )
}

/// Same rules as the session tree in the frontend: segments split at `/`, trimmed, empty segments
/// dropped. Control characters and overlong paths are rejected. The root is the empty string.
pub fn normalize(path: &str) -> Result<String, String> {
    if path.chars().any(char::is_control) {
        return Err(ui_err("SESSION_FOLDER_INVALID").into());
    }
    let joined = lenient(path);
    check_length(&joined)?;
    Ok(joined)
}

fn check_length(path: &str) -> Result<(), String> {
    if path.chars().count() > MAX_FOLDER_LENGTH {
        return Err(ui_err("SESSION_FOLDER_INVALID").into());
    }
    Ok(())
}

/// Normalised form of a stored value; never fails (stored folders were never validated).
pub(crate) fn lenient(path: &str) -> String {
    path.split('/')
        .map(|segment| segment.trim_matches(is_trimmed))
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

/// `path` is `root` or lies below it. Every path lies within the root `""`.
pub fn is_within(path: &str, root: &str) -> bool {
    root.is_empty()
        || path == root
        || path
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _)| parent)
}

fn exists(sessions: &[SavedSession], folders: &[String], path: &str) -> bool {
    path.is_empty()
        || sessions
            .iter()
            .any(|s| is_within(&lenient(&s.folder), path))
        || folders.iter().any(|folder| is_within(folder, path))
}

/// Keeps only real empty folders: valid, unique, not holding a session and not implied by a deeper
/// empty folder. Sorted for a stable file.
pub fn normalize_list(sessions: &[SavedSession], folders: &[String]) -> Vec<String> {
    let used: HashSet<String> = sessions.iter().map(|s| lenient(&s.folder)).collect();
    let candidates: BTreeSet<String> = folders
        .iter()
        .filter_map(|folder| normalize(folder).ok())
        .filter(|folder| !folder.is_empty())
        .collect();
    candidates
        .iter()
        .filter(|folder| {
            !used.iter().any(|path| is_within(path, folder))
                && !candidates
                    .iter()
                    .any(|other| other != *folder && is_within(other, folder))
        })
        .cloned()
        .collect()
}

/// A folder that loses its last content through a move stays as an empty folder, like in a file
/// manager. Only removing it explicitly makes it disappear.
fn keep_sources(sessions: &[SavedSession], folders: &mut Vec<String>, sources: &[String]) {
    for source in sources {
        if !source.is_empty() && !exists(sessions, folders, source) {
            folders.push(source.clone());
        }
    }
}

/// Normalises the list after a change and records which empty folders the change added/removed.
fn finish(
    sessions: &[SavedSession],
    folders: &mut Vec<String>,
    before: &[String],
    moved: Vec<FolderAssignment>,
    skipped: usize,
) -> LayoutChange {
    *folders = normalize_list(sessions, folders);
    let before_set: BTreeSet<&String> = before.iter().collect();
    let after_set: BTreeSet<&String> = folders.iter().collect();
    let added: Vec<String> = after_set
        .difference(&before_set)
        .map(|f| (*f).clone())
        .collect();
    let removed: Vec<String> = before_set
        .difference(&after_set)
        .map(|f| (*f).clone())
        .collect();
    LayoutChange {
        changed: !moved.is_empty() || !added.is_empty() || !removed.is_empty(),
        moved: moved.len(),
        skipped,
        undo: LayoutSnapshot {
            sessions: moved,
            added,
            removed,
        },
    }
}

/// Moves the given sessions into `target` (`""` = root).
pub fn move_sessions(
    sessions: &mut [SavedSession],
    folders: &mut Vec<String>,
    ids: &[String],
    target: &str,
) -> Result<LayoutChange, String> {
    let target = normalize(target)?;
    let wanted: HashSet<&str> = ids.iter().map(String::as_str).collect();
    if wanted
        .iter()
        .any(|id| !sessions.iter().any(|s| s.id == *id))
    {
        return Err(ui_err("SESSION_NOT_FOUND").into());
    }
    let before = folders.clone();
    let mut moved = Vec::new();
    let mut sources = Vec::new();
    for session in sessions.iter_mut() {
        if !wanted.contains(session.id.as_str()) || lenient(&session.folder) == target {
            continue;
        }
        moved.push(FolderAssignment {
            id: session.id.clone(),
            folder: session.folder.clone(),
            expected: target.clone(),
        });
        sources.push(lenient(&session.folder));
        session.folder = target.clone();
    }
    if moved.is_empty() {
        return Ok(LayoutChange::default());
    }
    keep_sources(sessions, folders, &sources);
    Ok(finish(sessions, folders, &before, moved, 0))
}

/// Renames or moves the folder `from` to `to`; every session and folder below follows. Moving a
/// folder into its own subtree is rejected; an existing `to` is merged. Every resulting path is
/// checked first: if one would be invalid, nothing changes.
pub fn rename_folder(
    sessions: &mut [SavedSession],
    folders: &mut Vec<String>,
    from: &str,
    to: &str,
) -> Result<LayoutChange, String> {
    let from = normalize(from)?;
    let to = normalize(to)?;
    if from.is_empty() || to.is_empty() {
        return Err(ui_err("SESSION_FOLDER_INVALID").into());
    }
    if from == to {
        return Ok(LayoutChange::default());
    }
    if is_within(&to, &from) {
        return Err(ui_err("SESSION_FOLDER_INTO_ITSELF").into());
    }
    if !exists(sessions, folders, &from) {
        return Err(ui_err("SESSION_FOLDER_NOT_FOUND").into());
    }
    let replace = |path: &str| format!("{to}{}", &path[from.len()..]);
    // Plan and validate every resulting path before changing anything.
    let mut planned = Vec::new();
    for (index, session) in sessions.iter().enumerate() {
        let current = lenient(&session.folder);
        if is_within(&current, &from) {
            let next = replace(&current);
            normalize(&next)?;
            planned.push((index, next));
        }
    }
    let mut renamed = folders.clone();
    for folder in renamed.iter_mut() {
        if is_within(folder, &from) {
            *folder = replace(folder);
            check_length(folder)?;
        }
    }
    let before = std::mem::replace(folders, renamed);
    let mut moved = Vec::new();
    for (index, next) in planned {
        let session = &mut sessions[index];
        moved.push(FolderAssignment {
            id: session.id.clone(),
            folder: session.folder.clone(),
            expected: next.clone(),
        });
        session.folder = next;
    }
    keep_sources(sessions, folders, &[parent(&from).to_owned()]);
    Ok(finish(sessions, folders, &before, moved, 0))
}

/// Turns back exactly the change described by `layout`: a session returns to its old folder only
/// if it is still where the change put it, and only the empty folders the change added or removed
/// are taken out or put back. Old folder values are restored as they were, even if they would not
/// pass today's rules. Returns the inverse snapshot and the number of skipped sessions.
pub fn restore(
    sessions: &mut [SavedSession],
    folders: &mut Vec<String>,
    layout: &LayoutSnapshot,
) -> Result<LayoutChange, String> {
    let before = folders.clone();
    let mut moved = Vec::new();
    let mut skipped = 0;
    for assignment in &layout.sessions {
        match sessions.iter_mut().find(|s| s.id == assignment.id) {
            Some(session) if session.folder == assignment.expected => {
                if session.folder != assignment.folder {
                    moved.push(FolderAssignment {
                        id: session.id.clone(),
                        folder: session.folder.clone(),
                        expected: assignment.folder.clone(),
                    });
                    session.folder = assignment.folder.clone();
                }
            }
            _ => skipped += 1,
        }
    }
    folders.retain(|folder| !layout.added.contains(folder));
    folders.extend(layout.removed.iter().cloned());
    Ok(finish(sessions, folders, &before, moved, skipped))
}

/// Adds an empty folder. An existing folder is an error, so a typo does not go unnoticed.
pub fn create_folder(
    sessions: &[SavedSession],
    folders: &mut Vec<String>,
    path: &str,
) -> Result<(), String> {
    let path = normalize(path)?;
    if path.is_empty() {
        return Err(ui_err("SESSION_FOLDER_INVALID").into());
    }
    if exists(sessions, folders, &path) {
        return Err(ui_err("SESSION_FOLDER_EXISTS").into());
    }
    folders.push(path);
    *folders = normalize_list(sessions, folders);
    Ok(())
}

/// Takes `path` and its empty subfolders out of the list; the parent folder stays. Sessions are not
/// checked here (see `remove_folder` and the folder delete).
pub fn drop_folder(sessions: &[SavedSession], folders: &mut Vec<String>, path: &str) {
    folders.retain(|folder| !is_within(folder, path));
    keep_sources(sessions, folders, &[parent(path).to_owned()]);
    *folders = normalize_list(sessions, folders);
}

/// Removes a folder without sessions, including its empty subfolders. The parent folder stays.
pub fn remove_folder(
    sessions: &[SavedSession],
    folders: &mut Vec<String>,
    path: &str,
) -> Result<(), String> {
    let path = normalize(path)?;
    if path.is_empty() {
        return Err(ui_err("SESSION_FOLDER_INVALID").into());
    }
    if sessions
        .iter()
        .any(|s| is_within(&lenient(&s.folder), &path))
    {
        return Err(ui_err("SESSION_FOLDER_NOT_EMPTY").into());
    }
    if !exists(sessions, folders, &path) {
        return Err(ui_err("SESSION_FOLDER_NOT_FOUND").into());
    }
    drop_folder(sessions, folders, &path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui_error::code_of;

    fn session(id: &str, folder: &str, jump: Option<&str>) -> SavedSession {
        let mut session: SavedSession = serde_json::from_value(serde_json::json!({
            "id": id, "name": id, "folder": folder, "host": "host.test", "port": 22,
            "user": null, "auth": { "type": "default" }, "source": null
        }))
        .unwrap();
        session.jump_session_id = jump.map(Into::into);
        session
    }
    fn folders_of(sessions: &[SavedSession]) -> Vec<(&str, &str)> {
        sessions
            .iter()
            .map(|s| (s.id.as_str(), s.folder.as_str()))
            .collect()
    }
    fn code(result: Result<impl std::fmt::Debug, String>) -> String {
        code_of(&result.unwrap_err()).unwrap().to_owned()
    }

    #[test]
    fn normalizes_like_the_tree_and_rejects_control_characters() {
        assert_eq!(normalize(" Lab // Linux / ").unwrap(), "Lab/Linux");
        assert_eq!(normalize("///").unwrap(), "");
        assert_eq!(code(normalize("Lab\nLinux")), "SESSION_FOLDER_INVALID");
        assert_eq!(
            code(normalize(&"a".repeat(MAX_FOLDER_LENGTH + 1))),
            "SESSION_FOLDER_INVALID"
        );
        assert!(is_within("Lab/Linux", "Lab"));
        assert!(is_within("Lab", "Lab"));
        assert!(!is_within("Labor", "Lab"));
        assert!(is_within("Lab", ""));
    }

    #[test]
    fn moves_sessions_keeps_ids_jump_hosts_and_the_emptied_source() {
        let mut sessions = vec![
            session("gw", "Lab", None),
            session("web", "Lab", Some("gw")),
            session("db", "Prod", None),
        ];
        let mut folders = Vec::new();
        let change = move_sessions(
            &mut sessions,
            &mut folders,
            &["gw".into(), "web".into()],
            " Prod / Web ",
        )
        .unwrap();
        assert!(change.changed);
        assert_eq!(change.moved, 2);
        assert_eq!(
            folders_of(&sessions),
            [("gw", "Prod/Web"), ("web", "Prod/Web"), ("db", "Prod")]
        );
        assert_eq!(sessions[1].jump_session_id.as_deref(), Some("gw"));
        // "Lab" lost its last session and stays as an empty folder.
        assert_eq!(folders, ["Lab"]);
        // Undo puts everything back, including the empty-folder list.
        let undo = restore(&mut sessions, &mut folders, &change.undo).unwrap();
        assert_eq!(
            folders_of(&sessions),
            [("gw", "Lab"), ("web", "Lab"), ("db", "Prod")]
        );
        assert!(folders.is_empty());
        assert_eq!(undo.moved, 2);
        // Nothing to do: no change, nothing to write.
        let none = move_sessions(&mut sessions, &mut folders, &["db".into()], "Prod").unwrap();
        assert!(!none.changed);
        assert_eq!(
            code(move_sessions(
                &mut sessions,
                &mut folders,
                &["missing".into()],
                ""
            )),
            "SESSION_NOT_FOUND"
        );
    }

    #[test]
    fn moving_into_an_empty_folder_drops_it_from_the_list() {
        let mut sessions = vec![session("a", "", None)];
        let mut folders = vec!["Empty".to_owned()];
        let change = move_sessions(&mut sessions, &mut folders, &["a".into()], "Empty").unwrap();
        assert!(folders.is_empty());
        restore(&mut sessions, &mut folders, &change.undo).unwrap();
        assert_eq!(folders, ["Empty"]);
        assert_eq!(sessions[0].folder, "");
    }

    #[test]
    fn renames_folders_with_all_subfolders_and_merges() {
        let mut sessions = vec![
            session("a", "Lab", None),
            session("b", "Lab/ Linux", Some("a")),
            session("c", "Labor", None),
            session("d", "Prod", None),
        ];
        let mut folders = vec!["Lab/Empty".to_owned()];
        let change = rename_folder(&mut sessions, &mut folders, "Lab", "Test/Lab").unwrap();
        assert_eq!(change.moved, 2);
        assert_eq!(
            folders_of(&sessions),
            [
                ("a", "Test/Lab"),
                ("b", "Test/Lab/Linux"),
                ("c", "Labor"),
                ("d", "Prod")
            ]
        );
        assert_eq!(folders, ["Test/Lab/Empty"]);
        assert_eq!(sessions[1].jump_session_id.as_deref(), Some("a"));
        restore(&mut sessions, &mut folders, &change.undo).unwrap();
        assert_eq!(sessions[1].folder, "Lab/ Linux");
        assert_eq!(folders, ["Lab/Empty"]);
        // Merging into an existing folder is allowed.
        rename_folder(&mut sessions, &mut folders, "Lab", "Prod").unwrap();
        assert_eq!(
            folders_of(&sessions),
            [
                ("a", "Prod"),
                ("b", "Prod/Linux"),
                ("c", "Labor"),
                ("d", "Prod")
            ]
        );
    }

    #[test]
    fn rejects_moves_into_the_own_subtree_and_unknown_folders() {
        let mut sessions = vec![session("a", "Lab/Linux", None)];
        let mut folders = Vec::new();
        for target in ["Lab/Linux/Deep", "Lab/Linux/x/y"] {
            assert_eq!(
                code(rename_folder(
                    &mut sessions,
                    &mut folders,
                    "Lab/Linux",
                    target
                )),
                "SESSION_FOLDER_INTO_ITSELF"
            );
        }
        assert_eq!(
            code(rename_folder(&mut sessions, &mut folders, "Lab", "Lab/Sub")),
            "SESSION_FOLDER_INTO_ITSELF"
        );
        assert_eq!(
            code(rename_folder(&mut sessions, &mut folders, "Nope", "Other")),
            "SESSION_FOLDER_NOT_FOUND"
        );
        assert_eq!(
            code(rename_folder(&mut sessions, &mut folders, "Lab", "")),
            "SESSION_FOLDER_INVALID"
        );
        assert!(
            !rename_folder(&mut sessions, &mut folders, "Lab", " Lab ")
                .unwrap()
                .changed
        );
        assert_eq!(sessions[0].folder, "Lab/Linux");
    }

    #[test]
    fn moving_a_folder_out_keeps_its_parent_and_renames_empty_folders() {
        let mut sessions = vec![session("a", "Lab/Linux", None)];
        let mut folders = Vec::new();
        rename_folder(&mut sessions, &mut folders, "Lab/Linux", "Linux").unwrap();
        assert_eq!(sessions[0].folder, "Linux");
        assert_eq!(folders, ["Lab"]);
        rename_folder(&mut sessions, &mut folders, "Lab", "Archive").unwrap();
        assert_eq!(folders, ["Archive"]);
    }

    #[test]
    fn empty_folders_are_created_normalised_and_removed() {
        let sessions = vec![session("a", "Lab", None)];
        let mut folders = Vec::new();
        create_folder(&sessions, &mut folders, "Lab/New").unwrap();
        create_folder(&sessions, &mut folders, "Other").unwrap();
        assert_eq!(folders, ["Lab/New", "Other"]);
        assert_eq!(
            code(create_folder(&sessions, &mut folders, "Lab")),
            "SESSION_FOLDER_EXISTS"
        );
        assert_eq!(
            code(create_folder(&sessions, &mut folders, " / ")),
            "SESSION_FOLDER_INVALID"
        );
        // A deeper empty folder implies its parent.
        create_folder(&sessions, &mut folders, "Other/Deep").unwrap();
        assert_eq!(folders, ["Lab/New", "Other/Deep"]);
        assert_eq!(
            code(remove_folder(&sessions, &mut folders, "Lab")),
            "SESSION_FOLDER_NOT_EMPTY"
        );
        remove_folder(&sessions, &mut folders, "Other/Deep").unwrap();
        assert_eq!(folders, ["Lab/New", "Other"]);
        remove_folder(&sessions, &mut folders, "Other").unwrap();
        assert_eq!(folders, ["Lab/New"]);
        assert_eq!(
            code(remove_folder(&sessions, &mut folders, "Missing")),
            "SESSION_FOLDER_NOT_FOUND"
        );
        let list = normalize_list(
            &sessions,
            &[
                "Lab".into(),
                "B".into(),
                " B ".into(),
                "bad\u{7}".into(),
                "".into(),
            ],
        );
        assert_eq!(list, ["B"]);
    }

    #[test]
    fn restore_skips_sessions_changed_meanwhile_and_tolerates_old_values() {
        // An old value that today's rules reject is put back unchanged.
        let mut sessions = vec![
            session("a", "Old\u{7}Name", None),
            session("b", "Lab", None),
            session("c", "Lab", None),
        ];
        let mut folders = vec!["Keep".to_owned()];
        let change = move_sessions(
            &mut sessions,
            &mut folders,
            &["a".into(), "b".into(), "c".into()],
            "Target",
        )
        .unwrap();
        // The emptied "Lab" is kept; the invalid old folder cannot be listed as an empty folder.
        assert_eq!(change.undo.added, ["Lab"]);
        // Meanwhile: "b" moved elsewhere, "c" deleted, a new empty folder appeared.
        sessions[1].folder = "Elsewhere".into();
        sessions.remove(2);
        folders.push("New".into());
        let undo = restore(&mut sessions, &mut folders, &change.undo).unwrap();
        assert_eq!(undo.moved, 1);
        assert_eq!(undo.skipped, 2);
        assert_eq!(
            folders_of(&sessions),
            [("a", "Old\u{7}Name"), ("b", "Elsewhere")]
        );
        // Only the difference of the move is turned back: "Lab" goes, "Keep" and "New" stay.
        assert_eq!(folders, ["Keep", "New"]);
        let gone = LayoutSnapshot {
            sessions: vec![FolderAssignment {
                id: "deleted".into(),
                folder: "Old".into(),
                expected: "Target".into(),
            }],
            ..Default::default()
        };
        let none = restore(&mut sessions, &mut folders, &gone).unwrap();
        assert!(!none.changed);
        assert_eq!(none.skipped, 1);
    }

    #[test]
    fn rename_checks_every_resulting_path_before_changing_anything() {
        let deep = "d".repeat(MAX_FOLDER_LENGTH - 6);
        let mut sessions = vec![
            session("a", "Lab", None),
            session("b", &format!("Lab/{deep}"), None),
            session("c", "Old/\u{7}x", None),
        ];
        let mut folders = vec!["Lab/Empty".to_owned()];
        let before = (sessions.clone(), folders.clone());
        assert_eq!(
            code(rename_folder(&mut sessions, &mut folders, "Lab", "Longer")),
            "SESSION_FOLDER_INVALID"
        );
        assert_eq!(
            code(rename_folder(&mut sessions, &mut folders, "Old", "New")),
            "SESSION_FOLDER_INVALID"
        );
        assert_eq!((sessions, folders), before);
    }

    #[test]
    fn trims_the_same_whitespace_as_the_frontend() {
        assert_eq!(lenient("\u{feff}Lab"), "Lab");
        assert_eq!(lenient(" Lab"), "Lab");
        assert_eq!(lenient("\u{a0}Lab\u{3000}/\u{2009}x\u{0b}"), "Lab/x");
        // U+0085 is a control character, not trimmed (and rejected for new paths).
        assert_eq!(lenient("\u{85}Lab"), "\u{85}Lab");
        assert_eq!(code(normalize("\u{85}Lab")), "SESSION_FOLDER_INVALID");
        // U+2028 is White_Space for str::trim but not Zs: kept like in the frontend.
        assert_eq!(lenient("\u{2028}Lab"), "\u{2028}Lab");
    }
}
