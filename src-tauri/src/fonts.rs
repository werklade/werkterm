use fontdb::{Database, FaceInfo, Language, Style};
use serde::Serialize;
use std::collections::{BTreeMap, hash_map::RandomState};
use std::fs::{self, File, OpenOptions};
use std::hash::{BuildHasher, Hasher};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use crate::ui_error::{ui_code, ui_err};

const MAX_SIZE: u64 = 20 * 1024 * 1024;
const EXTENSIONS: [&str; 2] = ["ttf", "otf"];
const TEMPORARY_PREFIX: &str = ".werkterm-font-";
const TEMPORARY_SUFFIX: &str = ".tmp";
/// Temporary files of an interrupted import are removed once they are older than this.
const TEMPORARY_MAX_AGE: Duration = Duration::from_secs(60 * 60);
static IMPORT_LOCK: Mutex<()> = Mutex::new(());
/// Scanning installed fonts is slow and they change rarely: kept until a refresh is requested.
static SYSTEM_FONTS: Mutex<Option<Arc<Vec<SystemFont>>>> = Mutex::new(None);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFont {
    family: String,
    monospaced: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedFont {
    id: String,
    family: String,
    monospaced: bool,
    weight: u16,
    style: &'static str,
}

#[derive(Debug, PartialEq)]
struct ParsedFont {
    family: String,
    monospaced: bool,
    weight: u16,
    style: &'static str,
}

impl ParsedFont {
    fn into_imported(self, id: String) -> ImportedFont {
        ImportedFont {
            id,
            family: self.family,
            monospaced: self.monospaced,
            weight: self.weight,
            style: self.style,
        }
    }
}

fn family_name(face: &FaceInfo) -> Option<String> {
    let (name, _) = face
        .families
        .iter()
        .find(|(_, language)| *language == Language::English_UnitedStates)
        .or_else(|| face.families.first())?;
    let name: String = name.chars().filter(|c| !c.is_control()).collect();
    let name: String = name.trim().chars().take(200).collect();
    let name = name.trim_end();
    (!name.is_empty()).then(|| name.to_owned())
}

fn style_name(style: Style) -> &'static str {
    match style {
        Style::Normal => "normal",
        Style::Italic => "italic",
        Style::Oblique => "oblique",
    }
}

fn parse_font(bytes: &[u8]) -> Result<ParsedFont, String> {
    let mut database = Database::new();
    database.load_font_data(bytes.to_vec());
    let face = database
        .faces()
        .next()
        .ok_or(ui_code("FONT_INVALID_FILE"))?;
    let family = family_name(face).ok_or(ui_code("FONT_INVALID_FILE"))?;
    Ok(ParsedFont {
        family,
        monospaced: face.monospaced,
        // CSS accepts 1..=1000; a broken OS/2 value falls back to regular.
        weight: Some(face.weight.0)
            .filter(|weight| (1..=1000).contains(weight))
            .unwrap_or(400),
        style: style_name(face.style),
    })
}

/// Readable face name for messages, e.g. "Fira Code Bold Italic".
fn face_label(family: &str, weight: u16, style: &str) -> String {
    let weight = match weight {
        100 => "Thin".to_owned(),
        200 => "ExtraLight".to_owned(),
        300 => "Light".to_owned(),
        400 => "Regular".to_owned(),
        500 => "Medium".to_owned(),
        600 => "SemiBold".to_owned(),
        700 => "Bold".to_owned(),
        800 => "ExtraBold".to_owned(),
        900 => "Black".to_owned(),
        other => other.to_string(),
    };
    match style {
        "italic" => format!("{family} {weight} Italic"),
        "oblique" => format!("{family} {weight} Oblique"),
        _ => format!("{family} {weight}"),
    }
}

/// Same face: family compared case-insensitively, plus weight and style.
fn find_duplicate<'a>(fonts: &'a [ImportedFont], font: &ParsedFont) -> Option<&'a ImportedFont> {
    let family = font.family.to_lowercase();
    fonts.iter().find(|existing| {
        existing.family.to_lowercase() == family
            && existing.weight == font.weight
            && existing.style == font.style
    })
}

fn font_extension(path: &Path) -> Result<&'static str, String> {
    let extension = path.extension().and_then(|s| s.to_str()).unwrap_or("");
    EXTENSIONS
        .into_iter()
        .find(|candidate| candidate.eq_ignore_ascii_case(extension))
        .ok_or_else(|| ui_err("FONT_UNSUPPORTED_TYPE").into())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && !id.starts_with('-')
        && id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

fn random_suffix() -> String {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u32(std::process::id());
    format!("{:016x}", hasher.finish())
}

fn make_id(family: &str) -> String {
    let mut slug = String::new();
    for c in family.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
        if slug.len() == 60 {
            break;
        }
    }
    let slug = slug.trim_end_matches('-');
    let slug = if slug.is_empty() { "font" } else { slug };
    format!("{slug}-{}", &random_suffix()[..8])
}

fn read_limited(file: File) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    file.take(MAX_SIZE + 1)
        .read_to_end(&mut bytes)
        .map_err(read_error)?;
    if bytes.len() as u64 > MAX_SIZE {
        return Err(ui_err("FONT_TOO_LARGE").arg("limit", "20 MB").into());
    }
    Ok(bytes)
}

fn read_error(error: io::Error) -> String {
    ui_err("FONT_READ_FAILED").detail(error).into()
}

fn save_error(error: io::Error) -> String {
    ui_err("FONT_SAVE_FAILED").detail(error).into()
}

fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(crate::data_dir::resolve(app)?.join("fonts"))
}

fn atomic_write(directory: &Path, path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = directory.join(format!(
        "{TEMPORARY_PREFIX}{}{TEMPORARY_SUFFIX}",
        random_suffix()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(save_error)?;
    let result = file.write_all(bytes).and_then(|()| file.sync_all());
    drop(file);
    let result = result.and_then(|()| fs::rename(&temporary, path));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(save_error)
}

fn imported_fonts(directory: &Path) -> Result<Vec<ImportedFont>, String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(read_error(error)),
    };
    let mut fonts = Vec::new();
    let now = SystemTime::now();
    for entry in entries {
        let entry = entry.map_err(read_error)?;
        let path = entry.path();
        if is_stale_temporary(&entry, now) {
            // Best effort: a file that cannot be removed now is tried again on the next listing.
            let _ = fs::remove_file(&path);
            continue;
        }
        let Some(id) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .filter(|id| valid_id(id))
        else {
            continue;
        };
        if font_extension(&path).is_err() || !entry.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        if let Ok(font) = File::open(&path)
            .map_err(read_error)
            .and_then(read_limited)
            .and_then(|bytes| parse_font(&bytes))
        {
            fonts.push(font.into_imported(id.to_owned()));
        }
    }
    Ok(fonts)
}

/// A temporary file left behind by an interrupted import, older than `TEMPORARY_MAX_AGE`.
fn is_stale_temporary(entry: &fs::DirEntry, now: SystemTime) -> bool {
    let name = entry.file_name();
    let Some(name) = name.to_str() else {
        return false;
    };
    if !name.starts_with(TEMPORARY_PREFIX) || !name.ends_with(TEMPORARY_SUFFIX) {
        return false;
    }
    let Ok(metadata) = entry.metadata() else {
        return false;
    };
    metadata.is_file()
        && metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > TEMPORARY_MAX_AGE)
}

fn scan_system_fonts() -> Vec<SystemFont> {
    let mut database = Database::new();
    database.load_system_fonts();
    let mut fonts = BTreeMap::<String, SystemFont>::new();
    for face in database.faces() {
        let Some(family) = family_name(face).filter(|name| !name.starts_with('.')) else {
            continue;
        };
        fonts
            .entry(family.to_lowercase())
            .and_modify(|font| font.monospaced |= face.monospaced)
            .or_insert(SystemFont {
                family,
                monospaced: face.monospaced,
            });
    }
    fonts.into_values().collect()
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| String::from(ui_err("BACKGROUND_TASK_FAILED").detail(e)))?
}

fn lock_error(error: impl std::fmt::Display) -> String {
    ui_err("BACKGROUND_TASK_FAILED").detail(error).into()
}

/// Installed font families. The first call scans the system; later calls reuse the result unless `refresh` is set.
#[tauri::command]
pub async fn fonts_list_system(refresh: Option<bool>) -> Result<Vec<SystemFont>, String> {
    let refresh = refresh.unwrap_or(false);
    blocking(move || {
        if !refresh && let Some(fonts) = SYSTEM_FONTS.lock().map_err(lock_error)?.as_ref() {
            return Ok(fonts.as_ref().clone());
        }
        // Scanned without holding the lock; two first calls at once only scan twice.
        let fonts = Arc::new(scan_system_fonts());
        *SYSTEM_FONTS.lock().map_err(lock_error)? = Some(Arc::clone(&fonts));
        Ok(fonts.as_ref().clone())
    })
    .await
}

#[tauri::command]
pub async fn fonts_list_imported(app: tauri::AppHandle) -> Result<Vec<ImportedFont>, String> {
    let directory = directory(&app)?;
    blocking(move || {
        let mut fonts = imported_fonts(&directory)?;
        fonts.sort_by_cached_key(|font| (font.family.to_lowercase(), font.id.clone()));
        Ok(fonts)
    })
    .await
}

#[tauri::command]
pub async fn fonts_import(app: tauri::AppHandle, path: String) -> Result<ImportedFont, String> {
    blocking(move || {
        let path = Path::new(&path);
        let extension = font_extension(path)?;
        let bytes = read_limited(File::open(path).map_err(read_error)?)?;
        let font = parse_font(&bytes)?;
        // Keep the duplicate check and write together across concurrent imports.
        let _guard = IMPORT_LOCK
            .lock()
            .map_err(|e| String::from(ui_err("FONT_SAVE_FAILED").detail(e)))?;
        let directory = directory(&app)?;
        if find_duplicate(&imported_fonts(&directory)?, &font).is_some() {
            let name = face_label(&font.family, font.weight, font.style);
            return Err(ui_err("FONT_ALREADY_IMPORTED").arg("name", name).into());
        }
        fs::create_dir_all(&directory).map_err(save_error)?;
        let id = loop {
            let id = make_id(&font.family);
            if !directory
                .join(format!("{id}.ttf"))
                .try_exists()
                .map_err(save_error)?
                && !directory
                    .join(format!("{id}.otf"))
                    .try_exists()
                    .map_err(save_error)?
            {
                break id;
            }
        };
        atomic_write(
            &directory,
            &directory.join(format!("{id}.{extension}")),
            &bytes,
        )?;
        Ok(font.into_imported(id))
    })
    .await
}

#[tauri::command]
pub async fn fonts_read(app: tauri::AppHandle, id: String) -> Result<tauri::ipc::Response, String> {
    if !valid_id(&id) {
        return Err(ui_code("FONT_INVALID_ID").into());
    }
    let directory = directory(&app)?;
    blocking(move || {
        for extension in EXTENSIONS {
            match File::open(directory.join(format!("{id}.{extension}"))) {
                Ok(file) => return Ok(tauri::ipc::Response::new(read_limited(file)?)),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(read_error(error)),
            }
        }
        Err(ui_code("FONT_NOT_FOUND").into())
    })
    .await
}

#[tauri::command]
pub async fn fonts_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err(ui_code("FONT_INVALID_ID").into());
    }
    let directory = directory(&app)?;
    blocking(move || {
        for extension in EXTENSIONS {
            match fs::remove_file(directory.join(format!("{id}.{extension}"))) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(ui_err("FONT_DELETE_FAILED").detail(error).into()),
            }
        }
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_font_rejects_garbage_and_empty_bytes() {
        for bytes in [b"not a font".as_slice(), b""] {
            assert_eq!(parse_font(bytes).unwrap_err(), "FONT_INVALID_FILE");
        }
    }

    #[test]
    fn font_extension_accepts_ttf_and_otf() {
        assert_eq!(font_extension(Path::new("font.TTF")).unwrap(), "ttf");
        assert_eq!(font_extension(Path::new("font.otf")).unwrap(), "otf");
        for path in ["font.woff", "font"] {
            assert_eq!(
                font_extension(Path::new(path)).unwrap_err(),
                "FONT_UNSUPPORTED_TYPE"
            );
        }
    }

    #[test]
    fn valid_id_checks_length_and_characters() {
        for id in ["", "../x", "A", "-a", &"a".repeat(81)] {
            assert!(!valid_id(id));
        }
        assert!(valid_id(&make_id("JetBrains Mono")));
        assert!(valid_id(&"a".repeat(80)));
    }

    #[test]
    fn make_id_uses_family_slug_and_eight_hex_digits() {
        let id = make_id("JetBrains Mono");
        let suffix = id.strip_prefix("jetbrains-mono-").unwrap();
        assert_eq!(suffix.len(), 8);
        assert!(suffix.bytes().all(|c| c.is_ascii_hexdigit()));
        assert!(make_id("?!").starts_with("font-"));
    }

    fn imported(id: &str, family: &str, weight: u16, style: &'static str) -> ImportedFont {
        ImportedFont {
            id: id.into(),
            family: family.into(),
            monospaced: true,
            weight,
            style,
        }
    }

    fn parsed(family: &str, weight: u16, style: &'static str) -> ParsedFont {
        ParsedFont {
            family: family.into(),
            monospaced: true,
            weight,
            style,
        }
    }

    #[test]
    fn find_duplicate_matches_family_case_insensitively_with_weight_and_style() {
        let fonts = [
            imported("fira-code-1", "Fira Code", 400, "normal"),
            imported("fira-code-2", "Fira Code", 700, "italic"),
        ];
        let id = |font: ParsedFont| find_duplicate(&fonts, &font).map(|f| f.id.clone());
        assert_eq!(
            id(parsed("fira code", 400, "normal")).unwrap(),
            "fira-code-1"
        );
        assert_eq!(
            id(parsed("FIRA CODE", 700, "italic")).unwrap(),
            "fira-code-2"
        );
        // Another weight or style of the same family is a new face, not a duplicate.
        assert!(id(parsed("Fira Code", 700, "normal")).is_none());
        assert!(id(parsed("Fira Code", 400, "oblique")).is_none());
        assert!(id(parsed("Hack", 400, "normal")).is_none());
    }

    #[test]
    fn face_label_names_weight_and_style() {
        assert_eq!(face_label("Fira Code", 400, "normal"), "Fira Code Regular");
        assert_eq!(
            face_label("Fira Code", 700, "italic"),
            "Fira Code Bold Italic"
        );
        assert_eq!(face_label("Hack", 450, "oblique"), "Hack 450 Oblique");
    }

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("werkterm-fonts-test-{}", random_suffix()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write_aged(path: &Path, age: Duration) {
        let file = File::create(path).unwrap();
        file.set_modified(SystemTime::now() - age).unwrap();
    }

    #[test]
    fn listing_removes_only_stale_temporary_files() {
        let temp = TempDir::new();
        let stale = temp.0.join(".werkterm-font-0123456789abcdef.tmp");
        let fresh = temp.0.join(".werkterm-font-fedcba9876543210.tmp");
        let other = temp.0.join("notes.tmp");
        write_aged(&stale, Duration::from_secs(2 * 60 * 60));
        write_aged(&fresh, Duration::from_secs(60));
        write_aged(&other, Duration::from_secs(2 * 60 * 60));
        assert!(imported_fonts(&temp.0).unwrap().is_empty());
        assert!(!stale.exists());
        assert!(fresh.exists());
        assert!(other.exists());
    }

    #[test]
    fn listing_skips_broken_files_and_a_missing_directory() {
        let temp = TempDir::new();
        fs::write(temp.0.join("broken-0123abcd.ttf"), b"not a font").unwrap();
        assert!(imported_fonts(&temp.0).unwrap().is_empty());
        assert!(imported_fonts(&temp.0.join("missing")).unwrap().is_empty());
    }
}
