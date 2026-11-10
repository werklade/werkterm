use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

pub(crate) static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static SERIAL: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum Step {
    Text { text: String },
    Wait { ms: u64 },
    Prompt { label: String, secret: bool },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Macro {
    pub id: String,
    pub name: String,
    pub steps: Vec<Step>,
    pub shortcut: Option<String>,
    pub created: u64,
    pub updated: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MacroFile {
    version: u32,
    macros: Vec<Macro>,
}

fn valid_shortcut(value: &str) -> bool {
    if let Some(key) = value.strip_prefix("Ctrl+Alt+") {
        return key.len() == 1
            && key
                .bytes()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
    }
    value
        .strip_prefix("Ctrl+Shift+F")
        .and_then(|n| n.parse::<u8>().ok())
        .is_some_and(|n| (1..=12).contains(&n) && value == format!("Ctrl+Shift+F{n}"))
}

fn validate(items: &[Macro]) -> Result<(), String> {
    let mut ids = HashSet::new();
    let mut shortcuts = HashSet::new();
    for item in items {
        if item.id.is_empty() || !ids.insert(&item.id) {
            return Err("Ungültige oder doppelte Makro-ID".into());
        }
        if item.name.trim().is_empty() || item.name.chars().count() > 80 {
            return Err("Name muss 1–80 Zeichen lang sein".into());
        }
        if item.steps.len() > 500 {
            return Err("Maximal 500 Schritte erlaubt".into());
        }
        let mut bytes = 0usize;
        for step in &item.steps {
            match step {
                Step::Text { text } => bytes = bytes.saturating_add(text.len()),
                Step::Wait { ms } if *ms > 60_000 => {
                    return Err("Wartezeit muss 0–60000 ms betragen".into());
                }
                Step::Prompt { label, .. }
                    if label.trim().is_empty() || label.chars().count() > 200 =>
                {
                    return Err("Rückfrage benötigt eine Beschriftung (1–200 Zeichen)".into());
                }
                _ => (),
            }
        }
        if bytes > 65_536 {
            return Err("Makrotext überschreitet 64 KB".into());
        }
        if let Some(shortcut) = &item.shortcut {
            if !valid_shortcut(shortcut) {
                return Err("Ungültiges Makro-Tastenkürzel".into());
            }
            if !shortcuts.insert(shortcut) {
                return Err("Tastenkürzel bereits vergeben".into());
            }
        }
    }
    Ok(())
}

fn load(path: &Path) -> Result<Vec<Macro>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("Makrodatei konnte nicht gelesen werden".into()),
    };
    let file: MacroFile = serde_json::from_slice(&bytes)
        .map_err(|_| "Makrodatei ist beschädigt; Original bleibt erhalten")?;
    if file.version != 1 {
        return Err("Unbekannte Version der Makrodatei".into());
    }
    validate(&file.macros)?;
    Ok(file.macros)
}

fn write_atomic(path: &Path, macros: Vec<Macro>) -> Result<(), String> {
    load(path)?;
    validate(&macros)?;
    let bytes = serde_json::to_vec_pretty(&MacroFile { version: 1, macros })
        .map_err(|_| "Makros konnten nicht serialisiert werden")?;
    let parent = path.parent().ok_or("Ungültiger Makropfad")?;
    fs::create_dir_all(parent).map_err(|_| "Makroordner konnte nicht erstellt werden")?;
    let temp = parent.join(format!(
        ".macros-{}-{}.tmp",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        crate::data_dir::rename_retrying(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|_: std::io::Error| "Makrodatei konnte nicht atomar gespeichert werden".into())
}

fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::data_dir::resolve(app).map(|dir| dir.join("macros.json"))
}

#[tauri::command]
pub async fn macros_list(app: tauri::AppHandle) -> Result<Vec<Macro>, String> {
    let _guard = LOCK.lock().await;
    let path = path(&app)?;
    tauri::async_runtime::spawn_blocking(move || load(&path))
        .await
        .map_err(|_| "Makros konnten nicht geladen werden")?
}

#[tauri::command]
pub async fn macro_save(app: tauri::AppHandle, item: Macro) -> Result<(), String> {
    let _guard = LOCK.lock().await;
    let path = path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut items = load(&path)?;
        if let Some(existing) = items.iter_mut().find(|m| m.id == item.id) {
            *existing = item;
        } else {
            items.push(item);
        }
        write_atomic(&path, items)
    })
    .await
    .map_err(|_| "Makro konnte nicht gespeichert werden")?
}

#[tauri::command]
pub async fn macro_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let _guard = LOCK.lock().await;
    let path = path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut items = load(&path)?;
        items.retain(|m| m.id != id);
        write_atomic(&path, items)
    })
    .await
    .map_err(|_| "Makro konnte nicht gelöscht werden")?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> Macro {
        Macro {
            id: "one".into(),
            name: "Test".into(),
            steps: vec![
                Step::Text {
                    text: "ls\r".into(),
                },
                Step::Prompt {
                    label: "Passwort".into(),
                    secret: true,
                },
            ],
            shortcut: Some("Ctrl+Alt+1".into()),
            created: 1,
            updated: 1,
        }
    }
    #[test]
    fn roundtrip_version_and_corruption() {
        let dir = std::env::temp_dir().join(format!(
            "werkterm-macros-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        let path = dir.join("macros.json");
        assert!(load(&path).unwrap().is_empty());
        write_atomic(&path, vec![sample()]).unwrap();
        assert_eq!(load(&path).unwrap(), vec![sample()]);
        write_atomic(&path, vec![]).unwrap();
        assert!(load(&path).unwrap().is_empty());
        for invalid in ["broken", "{\"version\":2,\"macros\":[]}"] {
            fs::write(&path, invalid).unwrap();
            assert!(load(&path).is_err());
            assert!(write_atomic(&path, vec![sample()]).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), invalid);
        }
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn validation_boundaries() {
        let mut item = sample();
        assert!(validate(&[item.clone()]).is_ok());
        for name in ["".into(), " ".into(), "a".repeat(81)] {
            item.name = name;
            assert!(validate(&[item.clone()]).is_err());
        }
        item = sample();
        item.steps = vec![Step::Wait { ms: 60_001 }];
        assert!(validate(&[item.clone()]).is_err());
        item.steps = vec![Step::Wait { ms: 60_000 }; 500];
        assert!(validate(&[item.clone()]).is_ok());
        item.steps.push(Step::Wait { ms: 0 });
        assert!(validate(&[item.clone()]).is_err());
        item.steps = vec![Step::Text {
            text: "ä".repeat(32769),
        }];
        assert!(validate(&[item.clone()]).is_err());
        item.steps = vec![Step::Text {
            text: "a".repeat(65536),
        }];
        assert!(validate(&[item]).is_ok());
    }
    #[test]
    fn shortcut_duplicates_and_grammar() {
        let a = sample();
        let mut b = sample();
        b.id = "two".into();
        assert!(validate(&[a.clone(), b.clone()]).is_err());
        b.shortcut = Some("Ctrl+Shift+F12".into());
        assert!(validate(&[a, b]).is_ok());
        for value in [
            "Ctrl+Alt+a",
            "Ctrl+Shift+T",
            "Ctrl+Shift+F13",
            "Ctrl+Shift+F01",
        ] {
            assert!(!valid_shortcut(value));
        }
    }
}
