use std::path::{Path, PathBuf};

use super::{ImportCandidate, ImportGateway, ImportPreview, SavedSession};

pub struct ImportBases {
    pub home: PathBuf,
    pub app_data: PathBuf,
    pub documents: PathBuf,
}

pub fn expand_key_path(value: &str, bases: &ImportBases) -> String {
    // MobaXterm writes Windows separators after its placeholders. Convert only
    // these relative suffixes when their injected destination is a Unix path;
    // literal paths may intentionally contain backslashes and stay untouched.
    let unix_relative = [
        ("_ProfileDir_", &bases.home),
        ("_AppDataDir_", &bases.app_data),
        ("_MyDocuments_", &bases.documents),
        ("_CurrentDrive_", &bases.home),
    ]
    .into_iter()
    .any(|(prefix, base)| value.starts_with(prefix) && base.to_string_lossy().starts_with('/'))
        || ((value == "~" || value.starts_with("~/") || value.starts_with("~\\"))
            && bases.home.to_string_lossy().starts_with('/'));
    let value = if unix_relative {
        value.replace('\\', "/")
    } else {
        value.to_owned()
    };
    let home = bases.home.to_string_lossy();
    let drive = home
        .get(..2)
        .filter(|prefix| prefix.ends_with(':'))
        .unwrap_or("");
    let expanded = value
        .replace("_ProfileDir_", &home)
        .replace("_AppDataDir_", &bases.app_data.to_string_lossy())
        .replace("_MyDocuments_", &bases.documents.to_string_lossy())
        .replace("_CurrentDrive_", drive);
    expand_home(&expanded, &bases.home)
}

pub(super) fn expand_home(value: &str, home: &Path) -> String {
    if value == "~" {
        home.to_string_lossy().into_owned()
    } else if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        let home_text = home.to_string_lossy();
        if home_text.starts_with('/') {
            // Preserve the imported Unix path syntax even in Windows tests.
            format!("{}/{rest}", home_text.trim_end_matches('/'))
        } else {
            home.join(rest).to_string_lossy().into_owned()
        }
    } else {
        value.to_owned()
    }
}

/// Single-gateway legacy SSH payload: indices include the initial session type 0.
/// Host/port/user are at 8/9/10, hence 7/8/9 in our fields after skip(1).
/// Verified against https://github.com/maferick/cablebag/blob/e97faf7017a2d324d8b9502c080373ab1ab84472/src-tauri/src/importers.rs
fn parse_gateway(fields: &[&str]) -> Result<Option<ImportGateway>, String> {
    let host = fields.get(7).copied().unwrap_or("").trim();
    if host.is_empty() {
        return Ok(None);
    }
    let invalid = || host.to_owned();
    let port = fields
        .get(8)
        .and_then(|p| p.parse::<u16>().ok())
        .filter(|p| *p != 0)
        .ok_or_else(invalid)?;
    let user = fields.get(9).copied().unwrap_or("").trim();
    // Multi-gateway/encoded payloads are deliberately not interpreted as a hostname.
    if user.is_empty()
        || host.chars().any(|c| c.is_whitespace() || c.is_control())
        || host.contains(['|', ';', ',', '@', '>', '<', '/', '\\'])
        || user.chars().any(|c| c.is_whitespace() || c.is_control())
        || user.contains(['|', ';', ',', '@', '>', '<'])
    {
        return Err(invalid());
    }
    Ok(Some(ImportGateway {
        host: host.into(),
        port,
        user: user.into(),
    }))
}

pub fn gateway_matches(gateway: &ImportGateway, sessions: &[SavedSession]) -> Vec<String> {
    sessions
        .iter()
        .filter(|s| {
            s.kind == "ssh"
                && s.host.eq_ignore_ascii_case(&gateway.host)
                && s.port == gateway.port
                && s.user.as_deref() == Some(gateway.user.as_str())
        })
        .map(|s| s.id.clone())
        .collect()
}

pub fn warn_unmapped_gateways(preview: &mut ImportPreview, sessions: &[SavedSession]) {
    for candidate in &preview.candidates {
        if let Some(gateway) = preview.gateways.get(&candidate.key) {
            let existing = gateway_matches(gateway, sessions).len();
            let imported = preview
                .candidates
                .iter()
                .filter(|c| {
                    c.key != candidate.key
                        && c.duplicate_of.is_none()
                        && c.host.eq_ignore_ascii_case(&gateway.host)
                        && c.port == gateway.port
                        && c.user.as_deref() == Some(gateway.user.as_str())
                })
                .count();
            if existing + imported != 1 {
                preview.warnings.push(format!(
                    "Gateway {} für {} nicht zugeordnet",
                    gateway.host, candidate.name
                ));
            }
        }
    }
}

pub fn parse(text: &str, bases: &ImportBases) -> Result<ImportPreview, String> {
    let mut result = ImportPreview::default();
    let mut in_bookmarks = false;
    let mut folder = String::new();
    let mut section = String::new();
    for line in text.trim_start_matches('\u{feff}').lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            section = line[1..line.len() - 1].to_owned();
            in_bookmarks = section == "Bookmarks"
                || section.strip_prefix("Bookmarks_").is_some_and(|suffix| {
                    !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit())
                });
            folder.clear();
            continue;
        }
        if !in_bookmarks || line.is_empty() || line.starts_with(';') {
            continue;
        }
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        if name == "SubRep" {
            folder = value.replace('\\', "/").trim_matches('/').to_owned();
            continue;
        }
        if name == "ImgNum" {
            continue;
        }
        let mut parts = value.split('#');
        if parts.next() != Some("") || parts.next() != Some("109") {
            result.skipped += 1;
            result.warnings.push(format!("Nicht belegtes MobaXterm-Sitzungsformat für {name} wurde übersprungen (Telnet/Seriell werden nicht geraten)"));
            continue;
        }
        let Some(payload) = parts.next() else {
            result.skipped += 1;
            continue;
        };
        if payload.split('%').next() != Some("0") {
            result.skipped += 1;
            result.warnings.push(format!(
                "Nicht belegter MobaXterm-Sitzungstyp für {name} wurde übersprungen"
            ));
            continue;
        }
        let fields: Vec<_> = payload.split('%').skip(1).collect();
        let host = fields.first().copied().unwrap_or("").trim();
        let port = fields
            .get(1)
            .and_then(|p| p.parse::<u16>().ok())
            .filter(|p| *p > 0);
        if name.trim().is_empty()
            || host.is_empty()
            || host.chars().any(char::is_whitespace)
            || port.is_none()
        {
            result.skipped += 1;
            result
                .warnings
                .push("Ungültiger MobaXterm-SSH-Eintrag wurde übersprungen".into());
            continue;
        }
        let optional = |index: usize| {
            fields
                .get(index)
                .map(|v| v.trim())
                .filter(|v| !v.is_empty())
        };
        let key = format!("mobaxterm:{section}:{name}");
        match parse_gateway(&fields) {
            Ok(Some(gateway)) => {
                result.gateways.insert(key.clone(), gateway);
            }
            Ok(None) => (),
            Err(host) => result.warnings.push(format!(
                "Gateway {host} für {} nicht zugeordnet (unbekanntes Format)",
                name.trim()
            )),
        }
        result.candidates.push(ImportCandidate {
            key,
            name: name.trim().into(),
            folder: folder.clone(),
            host: host.into(),
            port: port.unwrap_or(22),
            user: optional(2).map(str::to_owned),
            key_path: optional(13).map(|value| expand_key_path(value, bases)),
            one_key: None,
            duplicate_of: None,
        });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bases() -> ImportBases {
        ImportBases {
            home: PathBuf::from("C:\\Users\\alice"),
            app_data: PathBuf::from("C:\\AppData"),
            documents: PathBuf::from("C:\\Documents"),
        }
    }

    fn gateway_fixture(host: &str, port: &str, user: &str) -> String {
        // Payload positions (including type): 8=host, 9=port, 10=user, 14=key.
        let fields = [
            "0",
            "target.test",
            "22",
            "alice",
            "",
            "-1",
            "-1",
            "",
            host,
            port,
            user,
            "0",
            "0",
            "0",
            "",
            "",
            "-1",
        ];
        format!(
            "[Bookmarks]\nTarget=#109#{}#terminal\nGateway=#109#0%gateway.test%2222%bob#terminal\n",
            fields.join("%")
        )
    }

    #[test]
    fn reads_only_explicit_single_gateway_host_port_user() {
        let mut preview = parse(&gateway_fixture("gateway.test", "2222", "bob"), &bases()).unwrap();
        let gateway = preview.gateways.get("mobaxterm:Bookmarks:Target").unwrap();
        assert_eq!(
            (&*gateway.host, gateway.port, &*gateway.user),
            ("gateway.test", 2222, "bob")
        );
        warn_unmapped_gateways(&mut preview, &[]);
        assert!(preview.warnings.is_empty());
        preview.candidates.pop();
        warn_unmapped_gateways(&mut preview, &[]);
        assert_eq!(
            preview.warnings,
            ["Gateway gateway.test für Target nicht zugeordnet"]
        );
    }

    #[test]
    fn rejects_uncertain_gateway_formats_without_guessing_defaults() {
        for (host, port, user) in [
            ("gateway.test", "", "bob"),
            ("gateway.test", "0", "bob"),
            ("gateway.test", "invalid", "bob"),
            ("gateway.test", "22", ""),
            ("first|second", "22", "bob"),
            ("first;second", "22", "bob"),
        ] {
            let preview = parse(&gateway_fixture(host, port, user), &bases()).unwrap();
            assert!(preview.gateways.is_empty());
            assert!(
                preview
                    .warnings
                    .iter()
                    .any(|w| w.contains("nicht zugeordnet"))
            );
        }
        let preview = parse(&gateway_fixture("", "22", ""), &bases()).unwrap();
        assert!(preview.gateways.is_empty());
        assert!(preview.warnings.is_empty());
    }

    #[test]
    fn warns_when_multiple_imported_gateway_sessions_match() {
        let text = format!(
            "{}Other=#109#0%gateway.test%2222%bob#terminal\n",
            gateway_fixture("gateway.test", "2222", "bob")
        );
        let mut preview = parse(&text, &bases()).unwrap();
        warn_unmapped_gateways(&mut preview, &[]);
        assert_eq!(
            preview.warnings,
            ["Gateway gateway.test für Target nicht zugeordnet"]
        );
    }

    #[test]
    fn unknown_session_numbers_are_never_guessed_as_ssh() {
        // Only #109#0 is evidenced by the existing SSH fixtures. These arbitrary
        // unknown numbers deliberately make no claim about Telnet/serial codes.
        let text = "[Bookmarks]\nUnknown=#109#999%host%23%\nOther=#999#0%COM3%115200%\n";
        let parsed = parse(text, &bases()).unwrap();
        assert!(parsed.candidates.is_empty());
        assert_eq!(parsed.skipped, 2);
        assert_eq!(parsed.warnings.len(), 2);
    }

    #[test]
    fn imports_sections_crlf_and_skips_non_ssh() {
        let text = "[Bookmarks]\r\nSubRep=Work\\Servers\r\nImgNum=42\r\nFirst=#109#0%srv1.example.test%22%alice%%%%%%%%%%%_ProfileDir_\\id.ppk#rest\r\nShell=#105#0%local\r\n[Bookmarks_2]\r\nSubRep=Other\r\nSecond=#109#0%srv2.example.test%2200%#rest\r\n";
        let parsed = parse(text, &bases()).unwrap();
        assert_eq!(parsed.candidates.len(), 2);
        assert_eq!(parsed.skipped, 1);
        assert_eq!(parsed.candidates[0].folder, "Work/Servers");
        assert_eq!(parsed.candidates[0].user.as_deref(), Some("alice"));
        assert_eq!(
            parsed.candidates[0].key_path.as_deref(),
            Some("C:\\Users\\alice\\id.ppk")
        );
        assert_eq!(parsed.candidates[1].user, None);
        assert_eq!(parsed.candidates[1].port, 2200);
    }

    #[test]
    fn expands_injected_directories() {
        let bases = bases();
        assert_eq!(
            expand_key_path("_AppDataDir_\\key", &bases),
            "C:\\AppData\\key"
        );
        assert_eq!(
            expand_key_path("_MyDocuments_\\key", &bases),
            "C:\\Documents\\key"
        );
        assert_eq!(expand_key_path("_CurrentDrive_\\key", &bases), "C:\\key");
        assert_eq!(
            expand_key_path("_ProfileDir_\\key", &bases),
            "C:\\Users\\alice\\key"
        );
    }

    #[test]
    fn windows_relative_separators_follow_the_injected_unix_base() {
        let bases = ImportBases {
            home: PathBuf::from("/home/alice"),
            app_data: PathBuf::from("/home/alice/.config"),
            documents: PathBuf::from("/home/alice/Documents"),
        };
        for (input, expected) in [
            ("_ProfileDir_\\.ssh\\id_rsa", "/home/alice/.ssh/id_rsa"),
            (
                "_AppDataDir_\\keys\\id.ppk",
                "/home/alice/.config/keys/id.ppk",
            ),
            (
                "_MyDocuments_\\keys\\id.ppk",
                "/home/alice/Documents/keys/id.ppk",
            ),
            ("~/.ssh\\id.ppk", "/home/alice/.ssh/id.ppk"),
            ("~\\.ssh\\id.ppk", "/home/alice/.ssh/id.ppk"),
            ("_CurrentDrive_\\keys\\id.ppk", "/keys/id.ppk"),
            (
                "/literal/name\\with-backslash",
                "/literal/name\\with-backslash",
            ),
        ] {
            assert_eq!(expand_key_path(input, &bases), expected);
        }
    }
}
