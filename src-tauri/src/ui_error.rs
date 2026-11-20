//! Error values for the UI. Commands keep returning `Result<_, String>`; the string is either a
//! bare code (`SESSION_CLOSED`) or a code followed by a JSON object
//! (`WRITE_FAILED: {"args":{"backup":"…"},"detail":"…"}`). The frontend translates the code via
//! the `error.<CODE>` key and appends `detail` (raw library text) unchanged.
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UiError {
    pub code: &'static str,
    pub args: Vec<(&'static str, String)>,
    pub detail: Option<String>,
}

impl UiError {
    pub fn new(code: &'static str) -> Self {
        Self {
            code,
            args: Vec::new(),
            detail: None,
        }
    }

    /// Fills the `{name}` placeholder of the translated text.
    pub fn arg(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.args.push((name, value.into()));
        self
    }

    /// Position of a JSON parse error as `{line}`/`{column}` args. Deliberately no detail:
    /// serde_json messages can quote values from user files (e.g. macro passwords).
    pub fn json_position(self, error: &serde_json::Error) -> Self {
        self.arg("line", error.line().to_string())
            .arg("column", error.column().to_string())
    }

    /// Raw, untranslated library text (io/russh errors). Shown after the translated text.
    pub fn detail(mut self, detail: impl fmt::Display) -> Self {
        self.detail = Some(detail.to_string());
        self
    }
}

/// Short form of [`UiError::new`].
pub fn ui_err(code: &'static str) -> UiError {
    UiError::new(code)
}

/// A bare code where a `&'static str` is needed (constants, `ok_or`). Listed by the
/// translation test like [`ui_err`].
pub const fn ui_code(code: &'static str) -> &'static str {
    code
}

/// Code of a wire-format error string (`CODE` or `CODE: …`), for Rust-internal decisions.
/// Returns `None` for free text.
pub fn code_of(error: &str) -> Option<&str> {
    let code = error.split_once(':').map_or(error, |(code, _)| code);
    let mut chars = code.chars();
    (chars.next().is_some_and(|c| c.is_ascii_uppercase())
        && code.len() > 1
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'))
    .then_some(code)
}

/// Readable, language-neutral form of a wire-format error for logs:
/// `CODE name=value …: detail`. Nested coded args (e.g. `error`) are rendered the same way;
/// free text is returned unchanged.
pub fn log_line(error: &str) -> String {
    let Some(code) = code_of(error) else {
        return error.to_owned();
    };
    let Some(payload) = error[code.len()..]
        .strip_prefix(": ")
        .and_then(|rest| rest.starts_with('{').then_some(rest))
    else {
        return error.to_owned();
    };
    let Ok(serde_json::Value::Object(payload)) = serde_json::from_str(payload) else {
        return error.to_owned();
    };
    let mut line = code.to_owned();
    if let Some(serde_json::Value::Object(args)) = payload.get("args") {
        for (name, value) in args {
            let value = value.as_str().map_or_else(|| value.to_string(), log_line);
            line.push_str(&format!(" {name}={value}"));
        }
    }
    if let Some(detail) = payload.get("detail").and_then(|d| d.as_str()) {
        line.push_str(": ");
        line.push_str(detail);
    }
    line
}

impl fmt::Display for UiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.args.is_empty() && self.detail.is_none() {
            return f.write_str(self.code);
        }
        let mut payload = serde_json::Map::new();
        if !self.args.is_empty() {
            let args = self
                .args
                .iter()
                .map(|(name, value)| ((*name).to_owned(), serde_json::Value::from(value.as_str())))
                .collect();
            payload.insert("args".into(), serde_json::Value::Object(args));
        }
        if let Some(detail) = &self.detail {
            payload.insert("detail".into(), detail.as_str().into());
        }
        write!(f, "{}: {}", self.code, serde_json::Value::Object(payload))
    }
}

impl From<UiError> for String {
    fn from(error: UiError) -> Self {
        error.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::path::Path;

    #[test]
    fn formats_bare_code_args_and_detail() {
        assert_eq!(String::from(ui_err("SESSION_CLOSED")), "SESSION_CLOSED");
        assert_eq!(
            String::from(ui_err("EXISTS").arg("name", "a\"b")),
            r#"EXISTS: {"args":{"name":"a\"b"}}"#
        );
        assert_eq!(
            UiError::new("WRITE_FAILED")
                .arg("backup", "x")
                .detail("os error 2")
                .to_string(),
            r#"WRITE_FAILED: {"args":{"backup":"x"},"detail":"os error 2"}"#
        );
        assert_eq!(
            ui_err("CANCELLED").detail("eof").to_string(),
            r#"CANCELLED: {"detail":"eof"}"#
        );
    }

    #[test]
    fn extracts_codes_only_from_coded_errors() {
        assert_eq!(code_of("CONFLICT"), Some("CONFLICT"));
        assert_eq!(code_of(r#"EXISTS: {"args":{}}"#), Some("EXISTS"));
        assert_eq!(code_of("SUDO_PASSWORD: Text"), Some("SUDO_PASSWORD"));
        assert_eq!(code_of("Nur mit SFTP"), None);
        assert_eq!(code_of("A"), None);
        assert_eq!(code_of(""), None);
    }

    #[test]
    fn log_lines_are_readable() {
        let wire = String::from(ui_err("SERIAL_REMOVED").arg("device", "/dev/ttyUSB0"));
        assert_eq!(log_line(&wire), "SERIAL_REMOVED device=/dev/ttyUSB0");
        let nested = String::from(
            ui_err("SSH_JUMP_HOST")
                .arg("name", "a")
                .arg("error", String::from(ui_err("CANCELLED").detail("eof"))),
        );
        assert_eq!(
            log_line(&nested),
            "SSH_JUMP_HOST error=CANCELLED: eof name=a"
        );
        assert_eq!(
            log_line(&String::from(
                ui_err("TELNET_CONNECTION_LOST").detail("reset")
            )),
            "TELNET_CONNECTION_LOST: reset"
        );
        assert_eq!(log_line("CONNECTION_ENDED"), "CONNECTION_ENDED");
        assert_eq!(log_line("free text"), "free text");
        assert_eq!(log_line("SUDO_DENIED: Text"), "SUDO_DENIED: Text");
    }

    fn rust_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                rust_files(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }

    /// Every `UiError::new("X"` / `ui_err("X"` / `ui_code("X"` call site, with the `.arg("name"` names of its
    /// builder chain (up to the end of the statement).
    fn call_sites(source: &str) -> Vec<(String, BTreeSet<String>)> {
        let mut sites = Vec::new();
        for opener in ["UiError::new(\"", "ui_err(\"", "ui_code(\""] {
            let mut rest = source;
            while let Some(start) = rest.find(opener) {
                let after = &rest[start + opener.len()..];
                let Some(end) = after.find('"') else { break };
                let code = &after[..end];
                rest = &after[end..];
                // Skip the opener inside this scanner and the pattern literals themselves.
                if code_of(code) != Some(code) {
                    continue;
                }
                let mut chain_end = rest.find([';', '\n']).unwrap_or(rest.len());
                // Multi-line builder chains: continue over lines that start with `.`.
                let mut tail = &rest[chain_end..];
                while let Some(line) = tail.strip_prefix('\n') {
                    let trimmed = line.trim_start();
                    if ![".arg(", ".detail(", ".json_position("]
                        .iter()
                        .any(|start| trimmed.starts_with(start))
                    {
                        break;
                    }
                    let line_end = line.find('\n').unwrap_or(line.len());
                    chain_end += 1 + line_end;
                    tail = &line[line_end..];
                }
                let chain = &rest[..chain_end];
                let mut args = BTreeSet::new();
                if chain.contains(".json_position(") {
                    args.extend(["line".to_owned(), "column".to_owned()]);
                }
                let mut scan = chain;
                while let Some(pos) = scan.find(".arg(\"") {
                    let name = &scan[pos + 6..];
                    let Some(end) = name.find('"') else { break };
                    args.insert(name[..end].to_owned());
                    scan = &name[end..];
                }
                sites.push((code.to_owned(), args));
            }
        }
        sites
    }

    #[test]
    fn every_backend_error_code_has_translations() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let read = |lang: &str| -> serde_json::Map<String, serde_json::Value> {
            let path = root
                .join("..")
                .join("src")
                .join("i18n")
                .join(format!("{lang}.json"));
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
        };
        let languages = [("de", read("de")), ("en", read("en"))];
        let mut files = Vec::new();
        rust_files(&root.join("src"), &mut files);
        let mut problems = Vec::new();
        let mut count = 0;
        for file in files {
            let source = std::fs::read_to_string(&file).unwrap();
            for (code, args) in call_sites(&source) {
                count += 1;
                for (lang, texts) in &languages {
                    let key = format!("error.{code}");
                    let text = |key: &str| texts.get(key).and_then(|v| v.as_str());
                    // Either a single text or plural forms `.one` + `.other` (chosen by {count}).
                    let forms: Vec<(String, &str)> = match text(&key) {
                        Some(single) => vec![(key.clone(), single)],
                        None => [".one", ".other"]
                            .iter()
                            .filter_map(|form| {
                                let full = format!("{key}{form}");
                                text(&full).map(|value| (full, value))
                            })
                            .collect(),
                    };
                    let plural = forms.len() == 2;
                    if forms.is_empty() || (forms.len() == 1 && text(&key).is_none()) {
                        problems.push(format!("{lang}: {key} fehlt ({})", file.display()));
                        continue;
                    }
                    if plural && !args.contains("count") {
                        problems.push(format!("{lang}: {key} hat Pluralformen, aber kein count"));
                    }
                    for (full, value) in &forms {
                        for arg in &args {
                            // The singular form may spell out the number instead of {count}.
                            if plural && arg == "count" {
                                continue;
                            }
                            if !value.contains(&format!("{{{arg}}}")) {
                                problems.push(format!("{lang}: {full} ohne {{{arg}}}"));
                            }
                        }
                    }
                }
            }
        }
        assert!(count > 0, "no UiError call sites found");
        assert!(problems.is_empty(), "{}", problems.join("\n"));
    }
}
