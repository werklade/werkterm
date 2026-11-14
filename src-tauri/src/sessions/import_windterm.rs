use std::path::Path;

use serde::Deserialize;

use super::{ImportCandidate, ImportPreview, OneKeyRef};
use crate::ui_error::ui_err;

#[derive(Deserialize)]
struct WindSession {
    #[serde(rename = "session.protocol", default)]
    protocol: String,
    #[serde(rename = "session.label", default)]
    label: String,
    #[serde(rename = "session.group", default)]
    group: String,
    #[serde(rename = "session.target", default)]
    target: String,
    #[serde(rename = "session.port")]
    port: Option<serde_json::Value>,
    #[serde(rename = "ssh.identityFilePath.windows")]
    windows_key: Option<String>,
    #[serde(rename = "ssh.identityFilePath.linux")]
    linux_key: Option<String>,
    #[serde(rename = "session.oneKey")]
    one_key: Option<String>,
}

// Deliberately deserialize only the public metadata. Authentication and expect
// fields are ignored by serde and never materialized as application values.
#[derive(Deserialize)]
struct PublicOneKey {
    uuid: String,
    #[serde(default)]
    name: String,
    #[serde(rename = "type", default)]
    kind: String,
}

pub(super) fn parse_json<T: serde::de::DeserializeOwned>(text: &str) -> serde_json::Result<T> {
    serde_json::from_str(text.trim_start_matches('\u{feff}'))
}

pub fn parse(text: &str, one_keys: Option<&str>, home: &Path) -> Result<ImportPreview, String> {
    let sessions: Vec<WindSession> = parse_json(text)
        .map_err(|error| String::from(ui_err("WINDTERM_CORRUPT").json_position(&error)))?;
    let mut result = ImportPreview::default();
    if let Some(text) = one_keys {
        match parse_json::<Vec<PublicOneKey>>(text) {
            Ok(keys) => {
                result.one_keys = keys
                    .into_iter()
                    .map(|key| OneKeyRef {
                        uuid: key.uuid,
                        name: key.name,
                        kind: key.kind,
                    })
                    .collect()
            }
            Err(_) => result
                .warnings
                .push(ui_err("WINDTERM_ONEKEY_METADATA").into()),
        }
    }
    for session in sessions {
        if !session.protocol.eq_ignore_ascii_case("SSH") {
            result.skipped += 1;
            continue;
        }
        let target = session.target.trim();
        let (user, host) = target
            .rsplit_once('@')
            .map_or((None, target), |(user, host)| {
                (
                    Some(user.trim())
                        .filter(|user| !user.is_empty())
                        .map(str::to_owned),
                    host,
                )
            });
        let port = match session.port {
            None => Some(22),
            Some(serde_json::Value::Number(value)) => {
                value.as_u64().and_then(|value| u16::try_from(value).ok())
            }
            Some(serde_json::Value::String(value)) => value.parse::<u16>().ok(),
            _ => None,
        }
        .filter(|port| *port > 0);
        if session.label.trim().is_empty()
            || host.is_empty()
            || host.chars().any(char::is_whitespace)
            || port.is_none()
        {
            result.skipped += 1;
            result
                .warnings
                .push(ui_err("WINDTERM_INVALID_ENTRY").into());
            continue;
        }
        let key = if cfg!(windows) {
            session.windows_key
        } else {
            session.linux_key
        };
        result.candidates.push(ImportCandidate {
            key: format!(
                "windterm:{}",
                serde_json::to_string(&(&session.label, &session.group, target, port))
                    .map_err(|error| String::from(ui_err("IMPORT_KEY_FAILED").detail(error)))?
            ),
            name: session.label.trim().into(),
            folder: session
                .group
                .replace('>', "/")
                .split('/')
                .map(str::trim)
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("/"),
            host: host.into(),
            port: port.unwrap_or(22),
            user,
            key_path: key
                .filter(|key| !key.trim().is_empty())
                .map(|key| super::import_mobaxterm::expand_home(&key, home)),
            one_key: session.one_key.filter(|key| !key.is_empty()),
            duplicate_of: None,
        });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_bom_in_sessions_profiles_and_onekeys() {
        let profiles: serde_json::Value = parse_json("\u{feff}{\"path\":\"profile\"}").unwrap();
        assert_eq!(profiles["path"], "profile");
        let result = parse(
            "\u{feff}[{\"session.protocol\":\"SSH\",\"session.label\":\"Test\",\"session.target\":\"host\"}]",
            Some("\u{feff}[{\"uuid\":\"key\",\"name\":\"Name\"}]"),
            Path::new("home"),
        ).unwrap();
        assert_eq!(result.candidates.len(), 1);
        assert_eq!(result.one_keys.len(), 1);
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn import_keys_survive_reordering() {
        let first = serde_json::json!({"session.protocol":"SSH","session.label":"First","session.target":"alice@srv1.example.test"});
        let second = serde_json::json!({"session.protocol":"SSH","session.label":"Second","session.target":"srv2.example.test"});
        let original = parse(
            &serde_json::json!([first, second]).to_string(),
            None,
            Path::new("home"),
        )
        .unwrap();
        let reordered = parse(
            &serde_json::json!([second, first]).to_string(),
            None,
            Path::new("home"),
        )
        .unwrap();
        assert_eq!(original.candidates[0].key, reordered.candidates[1].key);
        assert_eq!(original.candidates[1].key, reordered.candidates[0].key);
    }

    #[test]
    fn parses_targets_groups_and_onekeys_without_secrets() {
        let text = r#"[
          {"session.protocol":"SSH","session.label":"First","session.group":"Work > Servers/Test","session.target":"alice@srv1.example.test","session.port":2200,"ssh.identityFilePath.windows":"~/id.ppk","ssh.identityFilePath.linux":"~/id.ppk"},
          {"session.protocol":"SSH","session.label":"Second","session.target":"srv2.example.test","session.oneKey":"invented-id"},
          {"session.protocol":"Shell","session.label":"Local"}
        ]"#;
        let keys = r#"[{"uuid":"invented-id","name":"Test key","type":"SSH","auth":"NEVER_RETURN_THIS","expect":{"password":"NEVER_RETURN_EITHER"}}]"#;
        let result = parse(text, Some(keys), Path::new("test-home")).unwrap();
        assert_eq!(result.candidates.len(), 2);
        assert_eq!(result.skipped, 1);
        assert_eq!(result.candidates[0].user.as_deref(), Some("alice"));
        assert_eq!(result.candidates[0].folder, "Work/Servers/Test");
        assert_eq!(result.candidates[0].port, 2200);
        assert_eq!(result.candidates[1].user, None);
        assert_eq!(result.candidates[1].one_key.as_deref(), Some("invented-id"));
        let serialized = serde_json::to_value(&result).unwrap();
        assert_eq!(
            serialized["oneKeys"][0],
            serde_json::json!({"uuid":"invented-id","name":"Test key","kind":"SSH"})
        );
        assert!(!serialized.to_string().contains("NEVER_RETURN"));
        assert!(!serialized.to_string().contains("expect"));
    }

    #[test]
    fn malformed_onekeys_do_not_discard_sessions() {
        let result = parse("[]", Some("invalid"), Path::new("test-home")).unwrap();
        assert_eq!(result.warnings, ["WINDTERM_ONEKEY_METADATA"]);
        assert!(parse("{}", None, Path::new("test-home")).is_err());
    }
}
