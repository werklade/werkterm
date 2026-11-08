use serde::Serialize;
use serde_json::{Map, Value, json};
use std::collections::hash_map::RandomState;
use std::fs::{self, OpenOptions};
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::Manager;

const MAX_SIZE: u64 = 256 * 1024;
const UI_KEYS: &str = "bg-content bg-app bg-panel bg-panel-alt bg-toolbar bg-menubar bg-input bg-hover bg-active bg-tab bg-tab-active fg-primary fg-secondary fg-muted fg-inverse accent accent-hover accent-hover-fill border border-strong focus-ring danger warning success on-accent monitor-ok monitor-warn monitor-critical selection backdrop shadow warning-bg error-bg indent-guide diff-added diff-deleted diff-added-text diff-deleted-text";
const TERMINAL_KEYS: &str = "background foreground cursor selectionBackground black red green yellow blue magenta cyan white brightBlack brightRed brightGreen brightYellow brightBlue brightMagenta brightCyan brightWhite";
const EDITOR_KEYS: &str = "keyword string comment number function type variable property operator tag attribute meta invalid gutter-fg active-line selection cursor";

#[derive(Serialize)]
pub struct StoredDesign {
    id: String,
    design: Value,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

fn random_suffix() -> String {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u32(std::process::id());
    format!("{:016x}", hasher.finish())
}

fn make_id(name: &str) -> String {
    let mut slug = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
        if slug.len() >= 47 {
            break;
        }
    }
    let slug = slug.trim_matches('-');
    format!(
        "{}-{}",
        if slug.is_empty() { "design" } else { slug },
        random_suffix()
    )
}

fn valid_color(value: &str) -> bool {
    (value.len() == 7 || value.len() == 9)
        && value.starts_with('#')
        && value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
}

fn validate_design(value: &Value) -> Result<Value, String> {
    let source = value
        .as_object()
        .ok_or("Ungültiges Design: Objekt erwartet.")?;
    let name = source
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Eigenes Design");
    let mut result = Map::new();
    result.insert(
        "name".into(),
        Value::String(name.chars().take(60).collect()),
    );
    for (group, keys) in [
        ("ui", UI_KEYS),
        ("terminal", TERMINAL_KEYS),
        ("editor", EDITOR_KEYS),
    ] {
        let mut colors = Map::new();
        if let Some(input) = source.get(group).and_then(Value::as_object) {
            for key in keys.split_whitespace() {
                if let Some(color) = input
                    .get(key)
                    .and_then(Value::as_str)
                    .filter(|color| valid_color(color))
                {
                    colors.insert(key.into(), Value::String(color.to_owned()));
                }
            }
        }
        result.insert(group.into(), Value::Object(colors));
    }
    Ok(Value::Object(result))
}

fn read_json(path: &Path) -> Result<Value, String> {
    let file =
        fs::File::open(path).map_err(|e| format!("Design konnte nicht geöffnet werden: {e}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_SIZE + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Design konnte nicht gelesen werden: {e}"))?;
    if bytes.len() as u64 > MAX_SIZE {
        return Err("Designdatei ist größer als 256 KB.".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("Ungültige Designdatei: {e}"))
}

fn parse_export(value: &Value) -> Result<Value, String> {
    if value.get("format").and_then(Value::as_str) != Some("werkterm-design") {
        return Err("Unbekanntes Dateiformat: Werkterm-Design erwartet.".into());
    }
    match value.get("version").and_then(Value::as_u64) {
        Some(1) => validate_design(value.get("design").ok_or("Design fehlt in der Datei.")?),
        Some(version) if version > 1 => {
            Err("Diese Designversion ist neuer als die unterstützte Version.".into())
        }
        _ => Err("Ungültige Designversion.".into()),
    }
}

fn atomic_write(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let temporary = parent.join(format!(".werkterm-design-{}.tmp", random_suffix()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let bytes = serde_json::to_vec_pretty(value)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        Ok::<_, Box<dyn std::error::Error>>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|e| format!("Design konnte nicht gespeichert werden: {e}"))
}

fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("designs"))
        .map_err(|e| e.to_string())
}

fn design_path(directory: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("Ungültige Design-ID.".into());
    }
    Ok(directory.join(format!("{id}.json")))
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("Designvorgang fehlgeschlagen: {e}"))?
}

#[tauri::command]
pub async fn designs_list(app: tauri::AppHandle) -> Result<Vec<StoredDesign>, String> {
    let directory = directory(&app)?;
    blocking(move || {
        if !directory.exists() {
            return Ok(Vec::new());
        }
        let mut designs = Vec::new();
        for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let Some(id) = path
                .file_stem()
                .and_then(|s| s.to_str())
                .filter(|id| valid_id(id))
            else {
                continue;
            };
            if let Ok(design) = read_json(&path).and_then(|value| validate_design(&value)) {
                designs.push(StoredDesign {
                    id: id.to_owned(),
                    design,
                });
            }
        }
        designs.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(designs)
    })
    .await
}

#[tauri::command]
pub async fn designs_save(
    app: tauri::AppHandle,
    id: Option<String>,
    design: Value,
) -> Result<String, String> {
    let directory = directory(&app)?;
    blocking(move || {
        let design = validate_design(&design)?;
        let id = id.unwrap_or_else(|| make_id(design["name"].as_str().unwrap_or("design")));
        let path = design_path(&directory, &id)?;
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        atomic_write(&path, &design)?;
        Ok(id)
    })
    .await
}

#[tauri::command]
pub async fn designs_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let directory = directory(&app)?;
    blocking(
        move || match fs::remove_file(design_path(&directory, &id)?) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Design konnte nicht gelöscht werden: {error}")),
        },
    )
    .await
}

#[tauri::command]
pub async fn designs_export(
    app: tauri::AppHandle,
    id: Option<String>,
    design: Option<Value>,
    path: String,
) -> Result<(), String> {
    let directory = directory(&app)?;
    blocking(move || {
        let design = match id {
            Some(id) => validate_design(&read_json(&design_path(&directory, &id)?)?)?,
            None => validate_design(&design.ok_or("Kein Design zum Exportieren gewählt.")?)?,
        };
        atomic_write(
            Path::new(&path),
            &json!({"format":"werkterm-design", "version":1, "design":design}),
        )
    })
    .await
}

#[tauri::command]
pub async fn designs_import(path: String) -> Result<Value, String> {
    blocking(move || parse_export(&read_json(Path::new(&path))?)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_bounded_safe_and_unique() {
        for name in ["../../../../", "Über schönes Design", "", &"a".repeat(200)] {
            let id = make_id(name);
            assert!(valid_id(&id));
            assert_ne!(id, make_id(name));
        }
        for id in ["../a", "A", "", "a/b", "a\\b"] {
            assert!(!valid_id(id));
        }
    }

    #[test]
    fn validation_drops_unknown_and_invalid_values() {
        let result = validate_design(&json!({"name":"a".repeat(80), "extra":true, "ui":{"accent":"#12345678", "danger":"#123", "unknown":"#123456"}, "terminal":{"brightBlack":"#AbCdEf"}, "editor":{"keyword":"red"}})).unwrap();
        assert_eq!(result["name"].as_str().unwrap().len(), 60);
        assert!(result.get("extra").is_none());
        assert_eq!(result["ui"], json!({"accent":"#12345678"}));
        assert_eq!(result["terminal"]["brightBlack"], "#AbCdEf");
        assert_eq!(result["editor"], json!({}));
        assert!(validate_design(&Value::Null).is_err());
    }

    #[test]
    fn validation_keeps_accent_hover_fill() {
        let result = validate_design(&json!({"name":"a", "ui":{"accent-hover-fill":"#e07d22"}})).unwrap();
        assert_eq!(result["ui"], json!({"accent-hover-fill":"#e07d22"}));
    }

    #[test]
    fn import_checks_format_and_version() {
        assert!(parse_export(&json!({"format":"other", "version":1,"design":{}})).is_err());
        assert!(
            parse_export(&json!({"format":"werkterm-design", "version":2,"design":{}}))
                .unwrap_err()
                .contains("neuer")
        );
        assert!(
            parse_export(&json!({"format":"werkterm-design", "version":0,"design":{}})).is_err()
        );
        assert!(
            parse_export(&json!({"format":"werkterm-design", "version":1,"design":{}})).is_ok()
        );
    }
    #[test]
    fn atomic_write_replaces_existing_file_without_leaving_temporary_files() {
        let directory =
            std::env::temp_dir().join(format!("werkterm-design-test-{}", random_suffix()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("design.json");
        atomic_write(&path, &json!({"name": "Before"})).unwrap();
        atomic_write(&path, &json!({"name": "After"})).unwrap();
        assert_eq!(read_json(&path).unwrap(), json!({"name": "After"}));
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn import_accepts_exact_limit_and_rejects_one_extra_byte() {
        let directory =
            std::env::temp_dir().join(format!("werkterm-design-test-{}", random_suffix()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("design.json");
        let mut bytes = serde_json::to_vec(
            &json!({"format":"werkterm-design", "version":1, "design":{"name":"Boundary"}}),
        )
        .unwrap();
        bytes.resize(MAX_SIZE as usize, b' ');
        fs::write(&path, &bytes).unwrap();
        assert_eq!(
            parse_export(&read_json(&path).unwrap()).unwrap()["name"],
            "Boundary"
        );
        bytes.push(b' ');
        fs::write(&path, bytes).unwrap();
        assert!(read_json(&path).unwrap_err().contains("256 KB"));
        fs::remove_dir_all(directory).unwrap();
    }
}
