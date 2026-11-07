//! Secret-free connection history and terminal restore descriptors.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;
static LOCK: Mutex<()> = Mutex::new(());
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Recent {
    Saved {
        session_id: String,
        name: String,
        at: u64,
    },
    Quick {
        target: String,
        at: u64,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum LastTab {
    Local {},
    Wsl {},
    Saved { session_id: String },
    Quick { target: String },
}
#[derive(Serialize, Deserialize)]
struct History {
    version: u8,
    items: Vec<Recent>,
}
fn path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(name))
        .map_err(|e| e.to_string())
}
fn read(path: &Path) -> Result<Vec<Recent>, String> {
    match fs::read(path) {
        Ok(bytes) => {
            let history: History = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            if history.version != 1 {
                return Err("Unbekannte Verlaufsversion".into());
            }
            Ok(history.items)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e.to_string()),
    }
}
// Only malformed content is recovered; filesystem errors remain visible.
fn recover_corrupt(path: &Path, valid: impl FnOnce(&[u8]) -> bool) -> Result<(), String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    if !valid(&bytes) {
        let backup = path.with_extension("json.bak");
        match fs::remove_file(&backup) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
        fs::rename(path, backup).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn save_tabs(path: &Path, tabs: &[LastTab]) -> Result<(), String> {
    recover_corrupt(path, |bytes| {
        serde_json::from_slice::<Vec<LastTab>>(bytes).is_ok()
    })?;
    atomic(path, &tabs)
}
fn atomic(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let parent = path.parent().ok_or("Ungültiger Pfad")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = path.with_extension(format!(
        "json.{}.{}.tmp",
        std::process::id(),
        super::SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let mut created = false;
    let result = (|| -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        created = true;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)
    })();
    if created && result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|e| e.to_string())
}
fn validate_target(target: &str) -> Result<(), String> {
    let parsed = target.parse::<crate::ssh::SshTarget>()?;
    if parsed.user.contains([':', '/', '\\']) || target.chars().any(char::is_control) {
        return Err("Ungültiges Verbindungsziel".into());
    }
    Ok(())
}
fn add(path: &Path, item: Recent) -> Result<(), String> {
    if let Recent::Quick { target, .. } = &item {
        validate_target(target)?;
    }
    recover_corrupt(path, |bytes| {
        serde_json::from_slice::<History>(bytes).is_ok_and(|h| h.version == 1)
    })?;
    let mut items = read(path)?;
    prepend(&mut items, item);
    atomic(path, &History { version: 1, items })
}
fn prepend(items: &mut Vec<Recent>, item: Recent) {
    items.retain(|old| match (old, &item) {
        (Recent::Saved { session_id: a, .. }, Recent::Saved { session_id: b, .. }) => a != b,
        (Recent::Quick { target: a, .. }, Recent::Quick { target: b, .. }) => a != b,
        _ => true,
    });
    items.insert(0, item);
    items.truncate(20);
}
#[tauri::command]
pub fn recent_list(app: tauri::AppHandle) -> Result<Vec<Recent>, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    Ok(read(&path(&app, "recent.json")?).unwrap_or_default())
}
#[tauri::command]
pub fn recent_add(app: tauri::AppHandle, item: Recent) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let path = path(&app, "recent.json")?;
    add(&path, item)
}
#[tauri::command]
pub fn recent_clear(app: tauri::AppHandle) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    atomic(
        &path(&app, "recent.json")?,
        &History {
            version: 1,
            items: vec![],
        },
    )
}
#[tauri::command]
pub fn last_tabs_list(app: tauri::AppHandle) -> Result<Vec<LastTab>, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    Ok(fs::read(path(&app, "last-tabs.json")?)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default())
}
#[tauri::command]
pub fn last_tabs_save(app: tauri::AppHandle, tabs: Vec<LastTab>) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    for tab in &tabs {
        if let LastTab::Quick { target } = tab {
            validate_target(target)?;
        }
    }
    save_tabs(&path(&app, "last-tabs.json")?, &tabs)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn order_duplicates_limit() {
        let mut items = vec![];
        for at in 0..25 {
            prepend(
                &mut items,
                Recent::Quick {
                    target: format!("user@host{at}"),
                    at,
                },
            );
        }
        assert_eq!(items.len(), 20);
        let item = Recent::Quick {
            target: "user@host10".into(),
            at: 30,
        };
        prepend(&mut items, item.clone());
        assert_eq!(items[0], item);
        assert_eq!(items.len(), 20);
    }
    #[test]
    fn atomic_roundtrip_and_saved_duplicates() {
        let dir =
            std::env::temp_dir().join(format!("werkterm-recent-roundtrip-{}", std::process::id()));
        let path = dir.join("recent.json");
        assert!(read(&path).unwrap().is_empty());
        let saved = Recent::Saved {
            session_id: "id".into(),
            name: "New name".into(),
            at: 2,
        };
        add(
            &path,
            Recent::Saved {
                session_id: "id".into(),
                name: "Old name".into(),
                at: 1,
            },
        )
        .unwrap();
        add(
            &path,
            Recent::Quick {
                target: "u@host".into(),
                at: 1,
            },
        )
        .unwrap();
        add(&path, saved.clone()).unwrap();
        assert_eq!(read(&path).unwrap()[0], saved);
        assert_eq!(read(&path).unwrap().len(), 2);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        let value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(value["items"][0]["sessionId"], "id");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn secrets_are_rejected() {
        assert!(validate_target("user:password@host").is_err());
        assert!(validate_target("u@host\nsecret").is_err());
        assert!(validate_target("u@[::1]:2222").is_ok());
        assert!(
            serde_json::from_str::<LastTab>(r#"{"type":"local","password":"secret"}"#).is_err()
        );
    }
    #[test]
    fn last_tabs_roundtrip() {
        let tabs = vec![
            LastTab::Local {},
            LastTab::Wsl {},
            LastTab::Saved {
                session_id: "id".into(),
            },
            LastTab::Quick {
                target: "u@host".into(),
            },
        ];
        let bytes = serde_json::to_vec(&tabs).unwrap();
        assert_eq!(
            String::from_utf8(bytes.clone()).unwrap(),
            r#"[{"type":"local"},{"type":"wsl"},{"type":"saved","sessionId":"id"},{"type":"quick","target":"u@host"}]"#
        );
        assert_eq!(
            serde_json::from_slice::<Vec<LastTab>>(&bytes).unwrap(),
            tabs
        );
    }
    #[test]
    fn corrupt_file_is_preserved() {
        let dir = std::env::temp_dir().join(format!("werkterm-recent-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("recent.json");
        fs::write(&path, "broken").unwrap();
        assert!(read(&path).unwrap_or_default().is_empty());
        assert!(
            add(
                &path,
                Recent::Quick {
                    target: "u@host".into(),
                    at: 1
                }
            )
            .is_ok()
        );
        assert_eq!(read(&path).unwrap().len(), 1);
        assert_eq!(
            fs::read_to_string(path.with_extension("json.bak")).unwrap(),
            "broken"
        );
        fs::write(&path, "broken again").unwrap();
        add(
            &path,
            Recent::Quick {
                target: "u@host".into(),
                at: 2,
            },
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(path.with_extension("json.bak")).unwrap(),
            "broken again"
        );
        let tabs_path = dir.join("last-tabs.json");
        fs::write(&tabs_path, "invalid").unwrap();
        save_tabs(&tabs_path, &[LastTab::Local {}]).unwrap();
        assert_eq!(
            fs::read_to_string(tabs_path.with_extension("json.bak")).unwrap(),
            "invalid"
        );
        save_tabs(&tabs_path, &[]).unwrap();
        assert_eq!(
            fs::read_to_string(tabs_path.with_extension("json.bak")).unwrap(),
            "invalid"
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
