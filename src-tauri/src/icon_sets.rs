use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::ui_error::ui_err;

const MAX_SIZE: usize = 64 * 1024;
const MAX_FILES: usize = 200;
const ELEMENTS: &str = "svg g path circle ellipse rect line polyline polygon defs linearGradient radialGradient stop clipPath mask title desc use";
const ATTRIBUTES: &str = "d x y x1 y1 x2 y2 cx cy r rx ry width height points viewBox transform fill stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-miterlimit opacity fill-opacity stroke-opacity fill-rule clip-rule clip-path mask offset stop-color stop-opacity gradientUnits gradientTransform id class xmlns xmlns:xlink href xlink:href";

fn safe_name(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn suffix() -> String {
    let mut hash = std::collections::hash_map::RandomState::new().build_hasher();
    hash.write_u32(std::process::id());
    format!("{:016x}", hash.finish())
}

fn make_id(name: &str) -> String {
    let slug: String = name
        .to_ascii_lowercase()
        .chars()
        .take(47)
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    format!(
        "{}-{}",
        if slug.trim_matches('-').is_empty() {
            "icons"
        } else {
            slug.trim_matches('-')
        },
        suffix()
    )
}

fn svg_invalid(detail: &str) -> String {
    ui_err("SVG_INVALID").detail(detail).into()
}

fn io(error: std::io::Error) -> String {
    ui_err("FILE_ACCESS_FAILED").detail(error).into()
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn decode(value: &str) -> Result<String, String> {
    let mut result = String::new();
    let mut rest = value;
    while let Some(index) = rest.find('&') {
        result.push_str(&rest[..index]);
        rest = &rest[index + 1..];
        let end = rest
            .find(';')
            .ok_or_else(|| svg_invalid("unterminated entity"))?;
        let entity = &rest[..end];
        let c = match entity {
            "amp" => '&',
            "lt" => '<',
            "gt" => '>',
            "quot" => '"',
            "apos" => '\'',
            _ => {
                let code = if let Some(hex) = entity.strip_prefix("#x") {
                    u32::from_str_radix(hex, 16).ok()
                } else {
                    entity.strip_prefix('#').and_then(|n| n.parse().ok())
                };
                code.and_then(char::from_u32)
                    .ok_or_else(|| svg_invalid("unknown entity"))?
            }
        };
        result.push(c);
        rest = &rest[end + 1..];
    }
    result.push_str(rest);
    if result
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r'))
    {
        return Err(svg_invalid("invalid character"));
    }
    Ok(result)
}

fn safe_value(name: &str, value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if value.chars().any(char::is_control)
        || lower.contains("javascript:")
        || lower.contains("data:")
        || value.contains('\\')
    {
        return false;
    }
    if matches!(name, "href" | "xlink:href") {
        return fragment(value);
    }
    if name == "xmlns" {
        return value == "http://www.w3.org/2000/svg";
    }
    if name == "xmlns:xlink" {
        return value == "http://www.w3.org/1999/xlink";
    }
    let mut remaining = lower.as_str();
    while let Some(index) = remaining.find("url") {
        remaining = remaining[index + 3..].trim_start();
        if !remaining.starts_with('(') {
            continue;
        }
        let Some(end) = remaining.find(')') else {
            return false;
        };
        let target = remaining[1..end].trim().trim_matches(['\'', '"']);
        if !fragment(target) {
            return false;
        }
        remaining = &remaining[end + 1..];
    }
    true
}

fn fragment(value: &str) -> bool {
    value.strip_prefix('#').is_some_and(|id| {
        !id.is_empty()
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
    })
}

// A deliberately small XML grammar: quoted attributes, balanced tags, predefined/numeric
// entities and comments only. No DTDs, processing instructions, CDATA or namespaces
// beyond the fixed SVG/XLink declarations. Every accepted token is serialized anew.
struct Parser<'a> {
    rest: &'a str,
}
impl<'a> Parser<'a> {
    fn whitespace(&mut self) {
        self.rest = self.rest.trim_start_matches([' ', '\t', '\r', '\n']);
    }
    fn name(&mut self) -> Result<&'a str, String> {
        let len = self
            .rest
            .bytes()
            .take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b':'))
            .count();
        if len == 0 {
            return Err(svg_invalid("invalid name"));
        }
        let name = &self.rest[..len];
        self.rest = &self.rest[len..];
        Ok(name)
    }
    fn element(&mut self, depth: usize) -> Result<(String, String), String> {
        if depth > 64 || !self.rest.starts_with('<') {
            return Err(svg_invalid("invalid structure"));
        }
        self.rest = &self.rest[1..];
        let name = self.name()?.to_owned();
        let allowed = ELEMENTS.split_whitespace().any(|v| v == name);
        let mut output = format!("<{name}");
        let mut seen = BTreeSet::new();
        let empty;
        loop {
            let before = self.rest.len();
            self.whitespace();
            if self.rest.starts_with("/>") {
                self.rest = &self.rest[2..];
                empty = true;
                break;
            }
            if self.rest.starts_with('>') {
                self.rest = &self.rest[1..];
                empty = false;
                break;
            }
            if self.rest.len() == before {
                return Err(svg_invalid("attributes must be separated"));
            }
            let key = self.name()?.to_owned();
            if !seen.insert(key.clone()) {
                return Err(svg_invalid("duplicate attribute"));
            }
            self.whitespace();
            if !self.rest.starts_with('=') {
                return Err(svg_invalid("invalid attribute"));
            }
            self.rest = &self.rest[1..];
            self.whitespace();
            let quote = self
                .rest
                .chars()
                .next()
                .filter(|c| matches!(c, '\'' | '"'))
                .ok_or_else(|| svg_invalid("unquoted attribute"))?;
            self.rest = &self.rest[1..];
            let end = self
                .rest
                .find(quote)
                .ok_or_else(|| svg_invalid("incomplete attribute"))?;
            if self.rest[..end].contains('<') {
                return Err(svg_invalid("invalid attribute"));
            }
            let value = decode(&self.rest[..end])?.replace(['\t', '\n', '\r'], " ");
            self.rest = &self.rest[end + 1..];
            if ATTRIBUTES.split_whitespace().any(|v| v == key) && safe_value(&key, &value) {
                output.push_str(&format!(" {key}=\"{}\"", escape(&value)));
            }
        }
        if empty {
            output.push_str("/>");
        } else {
            output.push('>');
            loop {
                if self.rest.starts_with("</") {
                    self.rest = &self.rest[2..];
                    let close = self.name()?;
                    if close != name {
                        return Err(svg_invalid("mismatched end tag"));
                    }
                    self.whitespace();
                    if !self.rest.starts_with('>') {
                        return Err(svg_invalid("invalid end tag"));
                    }
                    self.rest = &self.rest[1..];
                    break;
                } else if self.rest.starts_with("<!--") {
                    let end = self
                        .rest
                        .find("-->")
                        .ok_or_else(|| svg_invalid("incomplete comment"))?;
                    if self.rest[4..end].contains("--") {
                        return Err(svg_invalid("invalid comment"));
                    }
                    self.rest = &self.rest[end + 3..];
                } else if self.rest.starts_with('<') {
                    output.push_str(&self.element(depth + 1)?.1);
                } else {
                    let end = self
                        .rest
                        .find('<')
                        .ok_or_else(|| svg_invalid("missing end tag"))?;
                    output.push_str(&escape(&decode(&self.rest[..end])?));
                    self.rest = &self.rest[end..];
                }
            }
            output.push_str(&format!("</{name}>"));
        }
        Ok((name, if allowed { output } else { String::new() }))
    }
}

pub fn sanitize_svg(source: &str) -> Result<String, String> {
    if source.len() > MAX_SIZE {
        return Err(ui_err("SVG_TOO_LARGE").arg("limit", "64 KB").into());
    }
    let upper = source.to_ascii_uppercase();
    if upper.contains("<!DOCTYPE") || upper.contains("<!ENTITY") {
        return Err(ui_err("SVG_DOCTYPE").into());
    }
    let mut parser = Parser {
        rest: source.trim_start_matches('\u{feff}').trim(),
    };
    if parser.rest.starts_with("<?xml ") {
        let end = parser
            .rest
            .find("?>")
            .ok_or_else(|| svg_invalid("invalid XML declaration"))?;
        parser.rest = &parser.rest[end + 2..];
        parser.whitespace();
    }
    while parser.rest.starts_with("<!--") {
        let end = parser
            .rest
            .find("-->")
            .ok_or_else(|| svg_invalid("incomplete comment"))?;
        if parser.rest[4..end].contains("--") {
            return Err(svg_invalid("invalid comment"));
        }
        parser.rest = &parser.rest[end + 3..];
        parser.whitespace();
    }
    let (name, result) = parser.element(0)?;
    if name != "svg" || !parser.rest.trim().is_empty() {
        return Err(ui_err("SVG_ROOT_EXPECTED").into());
    }
    if result.len() > MAX_SIZE {
        return Err(ui_err("SVG_TOO_LARGE").arg("limit", "64 KB").into());
    }
    Ok(result)
}

#[derive(Serialize)]
pub struct StoredIconSet {
    id: String,
    name: String,
    icons: Vec<String>,
}
#[derive(Serialize)]
pub struct ImportResult {
    id: String,
    warnings: Vec<String>,
}
#[derive(Serialize)]
pub struct ExportResult {
    written: usize,
    skipped: Vec<String>,
}

fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::data_dir::resolve(app).map(|p| p.join("icon-sets"))
}
fn set_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !safe_name(id, 64) {
        return Err(ui_err("ICON_SET_INVALID_ID").into());
    }
    let path = root.join(id);
    if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(ui_err("ICON_SET_SYMLINK").into());
    }
    Ok(path)
}
fn read_svg(path: &Path) -> Result<String, String> {
    if !fs::symlink_metadata(path).map_err(io)?.is_file() {
        return Err(ui_err("SVG_NOT_FILE").into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(io)?
        .take(MAX_SIZE as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    sanitize_svg(std::str::from_utf8(&bytes).map_err(|_| String::from(ui_err("SVG_NOT_UTF8")))?)
}
fn load_set(path: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut icons = BTreeMap::new();
    for entry in fs::read_dir(path).map_err(io)? {
        let path = entry.map_err(io)?.path();
        if path.extension().and_then(|v| v.to_str()) != Some("svg") {
            continue;
        }
        if icons.len() >= MAX_FILES {
            return Err(ui_err("ICON_SET_TOO_MANY")
                .arg("max", MAX_FILES.to_string())
                .into());
        }
        if let Some(name) = path
            .file_stem()
            .and_then(|v| v.to_str())
            .filter(|v| safe_name(v, 40))
        {
            icons.insert(name.to_owned(), read_svg(&path)?);
        }
    }
    Ok(icons)
}
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| String::from(ui_err("BACKGROUND_TASK_FAILED").detail(e)))?
}

#[tauri::command]
pub async fn icon_sets_list(app: tauri::AppHandle) -> Result<Vec<StoredIconSet>, String> {
    let root = directory(&app)?;
    blocking(move || {
        if !root.exists() {
            return Ok(Vec::new());
        }
        let mut sets = Vec::new();
        for entry in fs::read_dir(&root).map_err(io)? {
            let entry = entry.map_err(io)?;
            let id = entry.file_name().to_string_lossy().into_owned();
            if !safe_name(&id, 64) {
                continue;
            }
            let path = set_path(&root, &id)?;
            if !path.is_dir() {
                continue;
            }
            let meta = path.join("meta.json");
            if !fs::symlink_metadata(&meta).is_ok_and(|m| m.is_file() && m.len() <= MAX_SIZE as u64)
            {
                continue;
            }
            let value: serde_json::Value = match fs::read(&meta)
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
            {
                Some(v) => v,
                None => continue,
            };
            if let Some(name) = value["name"].as_str()
                && let Ok(icons) = load_set(&path)
            {
                sets.push(StoredIconSet {
                    id,
                    name: name.chars().take(60).collect(),
                    icons: icons.into_keys().collect(),
                });
            }
        }
        sets.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
        Ok(sets)
    })
    .await
}
#[tauri::command]
pub async fn icon_sets_load(
    app: tauri::AppHandle,
    id: String,
) -> Result<BTreeMap<String, String>, String> {
    let root = directory(&app)?;
    blocking(move || load_set(&set_path(&root, &id)?)).await
}

fn import_set(
    root: &Path,
    folder: &Path,
    name: &str,
    known: &[String],
) -> Result<ImportResult, String> {
    if known.len() > MAX_FILES || known.iter().any(|v| !safe_name(v, 40)) {
        return Err(ui_err("ICON_NAMES_INVALID").into());
    }
    let name: String = name.trim().chars().take(60).collect();
    if name.is_empty() {
        return Err(ui_err("ICON_SET_NAME_EMPTY").into());
    }
    let mut warnings = Vec::new();
    let mut icons = BTreeMap::new();
    let mut count = 0;
    for entry in fs::read_dir(folder)
        .map_err(|e| String::from(ui_err("ICON_FOLDER_READ_FAILED").detail(e)))?
    {
        let path = entry.map_err(io)?.path();
        if path.extension().and_then(|v| v.to_str()) != Some("svg") {
            continue;
        }
        count += 1;
        if count > MAX_FILES {
            warnings.push(
                ui_err("ICON_IMPORT_LIMIT")
                    .arg("max", MAX_FILES.to_string())
                    .into(),
            );
            break;
        }
        let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("");
        if !known.iter().any(|v| v == stem) {
            warnings.push(
                ui_err("ICON_UNKNOWN_NAME")
                    .arg(
                        "name",
                        path.file_name().unwrap_or_default().to_string_lossy(),
                    )
                    .into(),
            );
            continue;
        }
        match read_svg(&path) {
            Ok(svg) => {
                icons.insert(stem.to_owned(), svg);
            }
            Err(e) => warnings.push(
                ui_err("ICON_FILE_SKIPPED")
                    .arg("name", stem)
                    .arg("error", e)
                    .into(),
            ),
        }
    }
    if icons.is_empty() {
        return Err(match warnings.into_iter().next() {
            Some(first) => ui_err("ICON_NONE_VALID").arg("error", first).into(),
            None => ui_err("ICON_NONE_FOUND").into(),
        });
    }
    fs::create_dir_all(root).map_err(io)?;
    let id = make_id(&name);
    let destination = set_path(root, &id)?;
    let staging = root.join(format!(".import-{}", suffix()));
    fs::create_dir(&staging).map_err(io)?;
    let result = (|| {
        for (name, svg) in icons {
            write_new(&staging.join(format!("{name}.svg")), svg.as_bytes())?;
        }
        write_new(
            &staging.join("meta.json"),
            &serde_json::to_vec(&serde_json::json!({"name": name}))
                .map_err(|e| String::from(ui_err("ICON_SET_SAVE_FAILED").detail(e)))?,
        )?;
        fs::rename(&staging, destination).map_err(io)?;
        Ok(ImportResult { id, warnings })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(staging);
    }
    result
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(io)?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(io)
}
#[tauri::command]
pub async fn icon_sets_import(
    app: tauri::AppHandle,
    folder: String,
    name: String,
    known: Vec<String>,
) -> Result<ImportResult, String> {
    let root = directory(&app)?;
    blocking(move || import_set(&root, Path::new(&folder), &name, &known)).await
}
#[tauri::command]
pub async fn icon_sets_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let root = directory(&app)?;
    blocking(move || match fs::remove_dir_all(set_path(&root, &id)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(ui_err("ICON_SET_DELETE_FAILED").detail(e).into()),
    })
    .await
}
#[tauri::command]
pub async fn icon_sets_export_template(
    folder: String,
    icons: BTreeMap<String, String>,
) -> Result<ExportResult, String> {
    blocking(move || {
        if icons.len() > MAX_FILES || icons.keys().any(|v| !safe_name(v, 40)) {
            return Err(ui_err("ICON_NAMES_INVALID").into());
        }
        let mut result = ExportResult {
            written: 0,
            skipped: Vec::new(),
        };
        for (name, svg) in icons {
            let svg = sanitize_svg(&svg)?;
            let path = Path::new(&folder).join(format!("{name}.svg"));
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    file.write_all(svg.as_bytes())
                        .and_then(|()| file.sync_all())
                        .map_err(|e| {
                            String::from(ui_err("ICON_TEMPLATE_WRITE_FAILED").detail(e))
                        })?;
                    result.written += 1;
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    result.skipped.push(name)
                }
                Err(e) => return Err(ui_err("ICON_TEMPLATE_WRITE_FAILED").detail(e).into()),
            }
        }
        Ok(result)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_builtin_svg_templates_can_be_exported() {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/assets/icons");
        for entry in fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|v| v.to_str()) != Some("svg") {
                continue;
            }
            let source = fs::read_to_string(&path).unwrap();
            let clean = sanitize_svg(&source).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            assert_eq!(sanitize_svg(&clean).unwrap(), clean);
            assert_eq!(
                clean.matches("class=\"wl-fill\"").count(),
                source.matches("class=\"wl-fill\"").count(),
                "{}",
                path.display()
            );
            if source.contains("<path") {
                assert!(clean.contains("<path"), "{}", path.display());
            }
            if source.contains(" d=") {
                assert!(clean.contains(" d="), "{}", path.display());
            }
        }
    }
    #[test]
    fn sanitizer_preserves_duotone_class() {
        let source = r#"<svg><path class="wl-fill" d="M3 3h18v18H3z"/><rect class="wl-fill" x="4" y="4" width="8" height="8"/></svg>"#;
        assert_eq!(sanitize_svg(source).unwrap(), source);
    }
    #[test]
    fn sanitizer_removes_active_content() {
        let svg = sanitize_svg(r##"<svg onload="alert(1)"><script>alert(1)</script><path d="M1 2" onclick="x()"/><use href="https://evil"/><use href="#local"/><path fill="url(https://evil)"/><image href="data:x"/></svg>"##).unwrap();
        assert!(!svg.contains("script"));
        assert!(!svg.contains("onload"));
        assert!(!svg.contains("onclick"));
        assert!(!svg.contains("https"));
        assert!(!svg.contains("image"));
        assert!(svg.contains("href=\"#local\""));
        assert!(sanitize_svg("<!DOCTYPE svg><svg/>").is_err());
        assert!(sanitize_svg("<!ENTITY x 'bad'><svg/>").is_err());
    }
    #[test]
    fn tabler_survives_and_entities_are_reserialized() {
        let source = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 4h8"/><title>A &amp; B</title></svg>"#;
        assert_eq!(sanitize_svg(source).unwrap(), source);
        let svg = sanitize_svg(r#"<svg><path fill="url(&#104;ttps://evil)"/><use href="&#106;avascript:alert(1)"/></svg>"#).unwrap();
        assert!(!svg.contains("href"));
        assert!(!svg.contains("fill"));
    }
    #[test]
    fn malformed_and_unsafe_names_are_rejected() {
        assert!(
            sanitize_svg(&format!(
                "<svg><title>{}</title></svg>",
                "\"".repeat(20_000)
            ))
            .is_err()
        );
        for source in [
            "<g/>",
            "<svg><path></svg>",
            "<svg/>junk",
            "<svg a='1'a='2'/>",
            "<svg><path d='&unknown;'/></svg>",
        ] {
            assert!(sanitize_svg(source).is_err(), "{source}");
        }
        for id in ["", "../x", "a/b", "A", "a\\b", &"a".repeat(65)] {
            assert!(!safe_name(id, 64));
        }
        assert!(safe_name(&make_id("Über ../ Icons"), 64));
    }
    #[test]
    fn import_skips_unknown_and_oversized_files() {
        let root = std::env::temp_dir().join(format!("werkterm-icons-test-{}", suffix()));
        let input = root.join("input");
        let output = root.join("output");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("home.svg"), "<svg><path d='M1 2'/></svg>").unwrap();
        fs::write(input.join("unknown.svg"), "<svg/>").unwrap();
        fs::write(input.join("save.svg"), " ".repeat(MAX_SIZE + 1)).unwrap();
        let imported =
            import_set(&output, &input, "Test", &["home".into(), "save".into()]).unwrap();
        assert_eq!(imported.warnings.len(), 2);
        assert!(
            imported
                .warnings
                .contains(&r#"ICON_UNKNOWN_NAME: {"args":{"name":"unknown.svg"}}"#.to_owned())
        );
        assert!(
            imported
                .warnings
                .iter()
                .any(|w| w.starts_with("ICON_FILE_SKIPPED:") && w.contains("SVG_TOO_LARGE"))
        );
        let loaded = load_set(&set_path(&output, &imported.id).unwrap()).unwrap();
        assert_eq!(loaded.len(), 1);
        assert!(loaded.contains_key("home"));
        fs::remove_dir_all(root).unwrap();
    }
}
