//! Per-session SSH options in OpenSSH style (`-o Key=Value`, `Key=Value`, `Key Value`).
//!
//! Only a small, explicit set of keys is supported. Algorithm lists follow OpenSSH semantics:
//! `+a,b` appends to the defaults, `-a,b` removes from them, `^a,b` puts them first and a
//! plain list replaces the defaults. Without options the russh defaults stay untouched.
use crate::ui_error::{UiError, ui_err};
use russh::client::GexParams;
use russh::keys::{Algorithm, EcdsaCurve, HashAlg};
use russh::{Preferred, cipher, kex, mac};
use std::borrow::Cow;
use std::time::Duration;

/// Upper bound for the whole option text (session field and quick connect).
pub const MAX_TEXT_LEN: usize = 4096;
/// Upper bound for non-empty option lines.
pub const MAX_LINES: usize = 32;

const KEX_EXTENSIONS: [kex::Name; 4] = [
    kex::EXTENSION_SUPPORT_AS_CLIENT,
    kex::EXTENSION_SUPPORT_AS_SERVER,
    kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT,
    kex::EXTENSION_OPENSSH_STRICT_KEX_AS_SERVER,
];

/// Host key and user key algorithms russh 0.65 can verify/sign with the enabled features.
const KEY_ALGORITHMS: [&str; 7] = [
    "ssh-ed25519",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "rsa-sha2-512",
    "rsa-sha2-256",
    "ssh-rsa",
];

/// Supported option keys, lower case (`PubkeyAcceptedKeyTypes` is mapped to its new name).
const KEYS: [&str; 8] = [
    "kexalgorithms",
    "hostkeyalgorithms",
    "pubkeyacceptedalgorithms",
    "ciphers",
    "macs",
    "connecttimeout",
    "serveraliveinterval",
    "serveralivecountmax",
];

/// Security-key user key types russh 0.65 handles (`ALL_KEY_TYPES` in russh `keys/key.rs`);
/// only signed by the agent. Offered by default today, so they belong to the user key defaults.
const SK_KEY_ALGORITHMS: [&str; 2] = [
    "sk-ssh-ed25519@openssh.com",
    "sk-ecdsa-sha2-nistp256@openssh.com",
];

/// Group exchange: when chosen explicitly, groups down to 2048 bits are accepted
/// (russh rejects a client minimum below 2048; its default minimum is 3072).
const GEX_ALGORITHMS: [&str; 2] = [
    "diffie-hellman-group-exchange-sha1",
    "diffie-hellman-group-exchange-sha256",
];
const GEX_MIN_EXPLICIT: usize = 2048;

/// Algorithms that are only reachable via explicit opt-in and are considered weak.
const WEAK: [&str; 10] = [
    "diffie-hellman-group1-sha1",
    "diffie-hellman-group14-sha1",
    "diffie-hellman-group-exchange-sha1",
    "ssh-rsa",
    "aes128-cbc",
    "aes192-cbc",
    "aes256-cbc",
    "3des-cbc",
    "hmac-sha1",
    "hmac-sha1-etm@openssh.com",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ListKind {
    Kex,
    HostKey,
    Pubkey,
    Cipher,
    Mac,
}

impl ListKind {
    /// Lists of the same family (host key and public key algorithms) share their names,
    /// so a name missing from one of them is unknown rather than misplaced.
    fn family(self) -> u8 {
        match self {
            Self::Kex => 0,
            Self::HostKey | Self::Pubkey => 1,
            Self::Cipher => 2,
            Self::Mac => 3,
        }
    }
    fn option_name(self) -> &'static str {
        match self {
            Self::Kex => "KexAlgorithms",
            Self::HostKey => "HostKeyAlgorithms",
            Self::Pubkey => "PubkeyAcceptedAlgorithms",
            Self::Cipher => "Ciphers",
            Self::Mac => "MACs",
        }
    }

    /// Every name the user may write for this list.
    fn supported(self) -> Vec<&'static str> {
        match self {
            Self::Kex => kex::ALL_KEX_ALGORITHMS
                .iter()
                .map(|name| name.as_ref())
                .filter(|name| *name != kex::NONE.as_ref())
                .collect(),
            Self::HostKey => KEY_ALGORITHMS.to_vec(),
            Self::Pubkey => KEY_ALGORITHMS
                .iter()
                .chain(SK_KEY_ALGORITHMS.iter())
                .copied()
                .collect(),
            Self::Cipher => cipher::ALL_CIPHERS
                .iter()
                .map(|name| name.as_ref())
                .filter(|name| *name != cipher::NONE.as_ref() && *name != cipher::CLEAR.as_ref())
                .collect(),
            Self::Mac => mac::ALL_MAC_ALGORITHMS
                .iter()
                .map(|name| name.as_ref())
                .filter(|name| *name != mac::NONE.as_ref())
                .collect(),
        }
    }

    /// The list russh uses today without options (extension pseudo-algorithms excluded).
    fn defaults(self) -> Vec<String> {
        let preferred = Preferred::default();
        match self {
            Self::Kex => preferred
                .kex
                .iter()
                .filter(|name| !KEX_EXTENSIONS.contains(name))
                .map(|name| name.as_ref().to_owned())
                .collect(),
            Self::HostKey => preferred
                .key
                .iter()
                .map(|algorithm| algorithm.as_str().to_owned())
                .collect(),
            Self::Pubkey => preferred
                .key
                .iter()
                .map(|algorithm| algorithm.as_str().to_owned())
                .chain(SK_KEY_ALGORITHMS.iter().map(|name| (*name).to_owned()))
                .collect(),
            Self::Cipher => preferred
                .cipher
                .iter()
                .map(|name| name.as_ref().to_owned())
                .collect(),
            Self::Mac => preferred
                .mac
                .iter()
                .map(|name| name.as_ref().to_owned())
                .collect(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SshOptions {
    kex: Option<Vec<String>>,
    host_key: Option<Vec<String>>,
    pubkey: Option<Vec<String>>,
    ciphers: Option<Vec<String>>,
    macs: Option<Vec<String>>,
    pub connect_timeout: Option<Duration>,
    /// Seconds, 0 disables keepalives (overrides the session keepalive interval).
    pub server_alive_interval: Option<u32>,
    pub server_alive_count_max: Option<u32>,
    /// Weak algorithms the user explicitly opted into.
    pub legacy: Vec<String>,
    /// A group exchange algorithm was named explicitly (not via removal).
    explicit_gex: bool,
}

fn line_err(code: &'static str, line: usize) -> UiError {
    ui_err(code).arg("line", line.to_string())
}

/// Splits one line into key and value; `None` for a line without a valid key.
fn split_line(line: &str) -> Option<(&str, &str)> {
    let line = match line.strip_prefix("-o") {
        Some(rest) => rest.trim_start(),
        None => line,
    };
    let end = line.find(|c: char| c == '=' || c.is_whitespace())?;
    let (key, rest) = line.split_at(end);
    let rest = rest.trim_start();
    let rest = rest.strip_prefix('=').unwrap_or(rest).trim();
    let value = rest
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or(rest);
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some((key, value))
}

fn parse_list(
    kind: ListKind,
    value: &str,
    line: usize,
) -> Result<(Vec<String>, Vec<String>), UiError> {
    let (mode, list) = match value.chars().next() {
        Some(c @ ('+' | '-' | '^')) => (Some(c), &value[1..]),
        _ => (None, value),
    };
    let supported = kind.supported();
    let mut names: Vec<String> = Vec::new();
    for item in list.split(',') {
        let item = item.trim().to_ascii_lowercase();
        if item.is_empty() {
            return Err(line_err("SSH_OPTION_MALFORMED", line));
        }
        if !supported.contains(&item.as_str()) {
            if let Some(other) = [
                ListKind::Kex,
                ListKind::HostKey,
                ListKind::Pubkey,
                ListKind::Cipher,
                ListKind::Mac,
            ]
            .into_iter()
            .find(|other| {
                other.family() != kind.family() && other.supported().contains(&item.as_str())
            }) {
                return Err(line_err("SSH_OPTION_WRONG_LIST", line)
                    .arg("name", item)
                    .arg("option", other.option_name())
                    .arg("current", kind.option_name()));
            }
            return Err(line_err("SSH_OPTION_UNKNOWN_ALGORITHM", line).arg("name", item));
        }
        if !names.contains(&item) {
            names.push(item);
        }
    }
    let defaults = kind.defaults();
    let result: Vec<String> = match mode {
        None => names.clone(),
        Some('+') => {
            let mut result = defaults;
            result.extend(names.iter().cloned());
            dedup(result)
        }
        Some('^') => {
            let mut result = names.clone();
            result.extend(defaults);
            dedup(result)
        }
        _ => defaults
            .into_iter()
            .filter(|name| !names.contains(name))
            .collect(),
    };
    if result.is_empty() {
        return Err(line_err("SSH_OPTION_EMPTY_LIST", line));
    }
    let chosen = if mode == Some('-') { Vec::new() } else { names };
    Ok((result, chosen))
}

fn result_contains(list: &[String], name: &str) -> bool {
    list.iter().any(|item| item == name)
}

fn dedup(list: Vec<String>) -> Vec<String> {
    let mut result: Vec<String> = Vec::with_capacity(list.len());
    for name in list {
        if !result_contains(&result, &name) {
            result.push(name);
        }
    }
    result
}

fn parse_number(value: &str, line: usize, min: u32, max: u32) -> Result<u32, UiError> {
    value
        .parse::<u32>()
        .ok()
        .filter(|number| (min..=max).contains(number))
        .ok_or_else(|| {
            line_err("SSH_OPTION_RANGE", line)
                .arg("min", min.to_string())
                .arg("max", max.to_string())
        })
}

/// Checks only the size limits (cheap; also used for stored sessions before parsing).
fn check_limits(text: &str) -> Result<(), UiError> {
    let lines = text.lines().filter(|line| !line.trim().is_empty()).count();
    if text.len() > MAX_TEXT_LEN || lines > MAX_LINES {
        return Err(ui_err("SSH_OPTIONS_TOO_LONG")
            .arg("lines", MAX_LINES.to_string())
            .arg("chars", MAX_TEXT_LEN.to_string()));
    }
    Ok(())
}

/// Parses the option text; one option per line, empty lines and `#` comments are skipped.
/// Every error names the 1-based line.
pub fn parse(text: &str) -> Result<SshOptions, String> {
    parse_inner(text).map_err(String::from)
}

fn parse_inner(text: &str) -> Result<SshOptions, UiError> {
    check_limits(text)?;
    let mut options = SshOptions::default();
    let mut legacy: Vec<String> = Vec::new();
    let mut explicit_gex = false;
    let mut seen: Vec<String> = Vec::new();
    for (index, raw) in text.lines().enumerate() {
        let line = index + 1;
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let (original, value) =
            split_line(trimmed).ok_or_else(|| line_err("SSH_OPTION_MALFORMED", line))?;
        let mut key = original.to_ascii_lowercase();
        if key == "pubkeyacceptedkeytypes" {
            key = "pubkeyacceptedalgorithms".into();
        }
        if !KEYS.contains(&key.as_str()) {
            return Err(line_err("SSH_OPTION_UNKNOWN", line).arg("key", original));
        }
        if value.is_empty()
            || value.contains(|c: char| c.is_whitespace() || c.is_control() || c == '"')
        {
            return Err(line_err("SSH_OPTION_MALFORMED", line));
        }
        if seen.contains(&key) {
            return Err(line_err("SSH_OPTION_DUPLICATE", line).arg("key", original));
        }
        let mut list = |kind: ListKind| -> Result<Option<Vec<String>>, UiError> {
            let (list, chosen) = parse_list(kind, value, line)?;
            if kind == ListKind::Kex {
                explicit_gex |= chosen
                    .iter()
                    .any(|name| GEX_ALGORITHMS.contains(&name.as_str()));
            }
            legacy.extend(
                chosen
                    .into_iter()
                    .filter(|name| WEAK.contains(&name.as_str())),
            );
            Ok(Some(list))
        };
        match key.as_str() {
            "kexalgorithms" => options.kex = list(ListKind::Kex)?,
            "hostkeyalgorithms" => options.host_key = list(ListKind::HostKey)?,
            "pubkeyacceptedalgorithms" => options.pubkey = list(ListKind::Pubkey)?,
            "ciphers" => options.ciphers = list(ListKind::Cipher)?,
            "macs" => options.macs = list(ListKind::Mac)?,
            "connecttimeout" => {
                let seconds = parse_number(value, line, 1, 3600)?;
                options.connect_timeout = Some(Duration::from_secs(u64::from(seconds)));
            }
            "serveraliveinterval" => {
                options.server_alive_interval = Some(parse_number(value, line, 0, 3600)?)
            }
            "serveralivecountmax" => {
                options.server_alive_count_max = Some(parse_number(value, line, 1, 100)?)
            }
            _ => unreachable!("checked against KEYS"),
        }
        seen.push(key);
    }
    options.legacy = dedup(legacy);
    options.explicit_gex = explicit_gex;
    Ok(options)
}

fn key_algorithm(name: &str) -> Option<Algorithm> {
    Some(match name {
        "ssh-ed25519" => Algorithm::Ed25519,
        "ecdsa-sha2-nistp256" => Algorithm::Ecdsa {
            curve: EcdsaCurve::NistP256,
        },
        "ecdsa-sha2-nistp384" => Algorithm::Ecdsa {
            curve: EcdsaCurve::NistP384,
        },
        "ecdsa-sha2-nistp521" => Algorithm::Ecdsa {
            curve: EcdsaCurve::NistP521,
        },
        "rsa-sha2-512" => Algorithm::Rsa {
            hash: Some(HashAlg::Sha512),
        },
        "rsa-sha2-256" => Algorithm::Rsa {
            hash: Some(HashAlg::Sha256),
        },
        "ssh-rsa" => Algorithm::Rsa { hash: None },
        _ => return None,
    })
}

fn rsa_name(hash: Option<HashAlg>) -> &'static str {
    match hash {
        Some(HashAlg::Sha512) => "rsa-sha2-512",
        Some(HashAlg::Sha256) => "rsa-sha2-256",
        _ => "ssh-rsa",
    }
}

impl SshOptions {
    /// russh algorithm preferences; unchanged russh defaults for every list without option.
    pub fn preferred(&self) -> Preferred {
        let mut preferred = Preferred::default();
        if let Some(list) = &self.kex {
            let mut names: Vec<kex::Name> = list
                .iter()
                .filter_map(|name| kex::Name::try_from(name.as_str()).ok())
                .collect();
            names.extend(KEX_EXTENSIONS);
            preferred.kex = Cow::Owned(names);
        }
        if let Some(list) = &self.host_key {
            preferred.key = Cow::Owned(list.iter().filter_map(|n| key_algorithm(n)).collect());
        }
        if let Some(list) = &self.ciphers {
            preferred.cipher = Cow::Owned(
                list.iter()
                    .filter_map(|name| cipher::Name::try_from(name.as_str()).ok())
                    .collect(),
            );
        }
        if let Some(list) = &self.macs {
            preferred.mac = Cow::Owned(
                list.iter()
                    .filter_map(|name| mac::Name::try_from(name.as_str()).ok())
                    .collect(),
            );
        }
        preferred
    }

    /// Signature hash for an RSA user key, given the server's preference.
    /// `None`: PubkeyAcceptedAlgorithms forbids every RSA variant, skip the key.
    pub fn rsa_hash(&self, server: Option<HashAlg>) -> Option<Option<HashAlg>> {
        let Some(list) = &self.pubkey else {
            return Some(server);
        };
        if result_contains(list, rsa_name(server)) {
            return Some(server);
        }
        list.iter().find_map(|name| match name.as_str() {
            "rsa-sha2-512" => Some(Some(HashAlg::Sha512)),
            "rsa-sha2-256" => Some(Some(HashAlg::Sha256)),
            "ssh-rsa" => Some(None),
            _ => None,
        })
    }

    /// Group exchange limits: russh defaults unless group exchange was chosen explicitly.
    pub fn gex_params(&self) -> GexParams {
        let defaults = GexParams::default();
        if !self.explicit_gex {
            return defaults;
        }
        GexParams::new(
            GEX_MIN_EXPLICIT,
            defaults.preferred_group_size(),
            defaults.max_group_size(),
        )
        .unwrap_or(defaults)
    }

    /// Whether PubkeyAcceptedAlgorithms restricts user keys at all.
    pub fn restricts_user_keys(&self) -> bool {
        self.pubkey.is_some()
    }

    /// Whether a user key of this type may be offered under PubkeyAcceptedAlgorithms.
    pub fn accepts_key(&self, algorithm: &Algorithm) -> bool {
        match &self.pubkey {
            None => true,
            Some(_) if matches!(algorithm, Algorithm::Rsa { .. }) => self.rsa_hash(None).is_some(),
            Some(list) => result_contains(list, algorithm.as_str()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui_error::code_of;

    fn code(text: &str) -> String {
        code_of(&parse(text).unwrap_err()).unwrap().to_owned()
    }
    fn names<T: AsRef<str>>(list: &[T]) -> Vec<String> {
        list.iter().map(|name| name.as_ref().to_owned()).collect()
    }

    #[test]
    fn empty_text_keeps_russh_defaults_exactly() {
        let options = parse("\n  \n# comment\n").unwrap();
        assert_eq!(options, SshOptions::default());
        let preferred = options.preferred();
        let defaults = Preferred::default();
        assert_eq!(names(&preferred.kex), names(&defaults.kex));
        assert_eq!(names(&preferred.cipher), names(&defaults.cipher));
        assert_eq!(names(&preferred.mac), names(&defaults.mac));
        assert_eq!(preferred.key, defaults.key);
        assert!(!names(&defaults.cipher).contains(&"3des-cbc".to_owned()));
        assert!(!names(&defaults.cipher).iter().any(|n| n.ends_with("-cbc")));
        assert!(!names(&defaults.kex).iter().any(|n| n.ends_with("-sha1")));
    }

    #[test]
    fn accepts_all_three_forms_case_insensitively() {
        for text in [
            "-o KexAlgorithms=+diffie-hellman-group14-sha1",
            "-oKexAlgorithms=+diffie-hellman-group14-sha1",
            "kexalgorithms=+diffie-hellman-group14-sha1",
            "KEXALGORITHMS +DIFFIE-HELLMAN-GROUP14-SHA1",
            "  KexAlgorithms = +diffie-hellman-group14-sha1  ",
            "KexAlgorithms \"+diffie-hellman-group14-sha1\"",
        ] {
            let options = parse(text).unwrap();
            let kex = options.kex.unwrap();
            assert_eq!(kex.last().unwrap(), "diffie-hellman-group14-sha1", "{text}");
            assert_eq!(kex[..kex.len() - 1], ListKind::Kex.defaults()[..], "{text}");
            assert_eq!(options.legacy, ["diffie-hellman-group14-sha1"]);
        }
    }

    #[test]
    fn list_modes_follow_openssh() {
        let defaults = ListKind::Cipher.defaults();
        let replaced = parse("Ciphers aes128-cbc,aes256-ctr").unwrap();
        assert_eq!(replaced.ciphers.unwrap(), ["aes128-cbc", "aes256-ctr"]);
        let prepended = parse("Ciphers ^aes256-ctr,aes128-cbc").unwrap();
        let prepended = prepended.ciphers.unwrap();
        assert_eq!(prepended[..2], ["aes256-ctr", "aes128-cbc"]);
        assert_eq!(prepended.len(), defaults.len() + 1);
        let removed = parse("Ciphers -chacha20-poly1305@openssh.com").unwrap();
        assert!(removed.legacy.is_empty());
        assert_eq!(removed.ciphers.unwrap(), defaults[1..]);
        let appended = parse("Ciphers +aes256-ctr").unwrap();
        assert_eq!(appended.ciphers.unwrap(), defaults);
        assert_eq!(code("Ciphers -"), "SSH_OPTION_MALFORMED");
        let all = defaults.join(",");
        assert_eq!(code(&format!("Ciphers -{all}")), "SSH_OPTION_EMPTY_LIST");
    }

    #[test]
    fn reports_the_matching_option_for_misplaced_algorithms() {
        for (text, option, current) in [
            ("HostKeyAlgorithms=+hmac-sha1", "MACs", "HostKeyAlgorithms"),
            ("Ciphers hmac-sha2-256", "MACs", "Ciphers"),
            ("MACs aes128-cbc", "Ciphers", "MACs"),
            (
                "KexAlgorithms ssh-rsa",
                "HostKeyAlgorithms",
                "KexAlgorithms",
            ),
        ] {
            let error = parse(text).unwrap_err();
            assert_eq!(code_of(&error), Some("SSH_OPTION_WRONG_LIST"), "{error}");
            assert!(
                error.contains(&format!(r#""option":"{option}""#)),
                "{error}"
            );
            assert!(
                error.contains(&format!(r#""current":"{current}""#)),
                "{error}"
            );
        }

        for text in ["MACs hmac-md5", "Ciphers rot13"] {
            assert_eq!(code(text), "SSH_OPTION_UNKNOWN_ALGORITHM", "{text}");
        }
    }

    #[test]
    fn rejects_unknown_keys_algorithms_and_malformed_lines_with_line_number() {
        let error = parse("Ciphers +aes128-cbc\n\nProxyCommand=nc %h %p").unwrap_err();
        assert!(error.starts_with("SSH_OPTION_UNKNOWN:"), "{error}");
        assert!(error.contains("\"line\":\"3\"") && error.contains("ProxyCommand"));
        let error = parse("KexAlgorithms +diffie-hellman-group99-sha1").unwrap_err();
        assert!(
            error.starts_with("SSH_OPTION_UNKNOWN_ALGORITHM:"),
            "{error}"
        );
        assert!(error.contains("diffie-hellman-group99-sha1"));
        for text in [
            "Ciphers",
            "=aes128-ctr",
            "Ciphers a b",
            "Ciphers aes128-ctr,,aes256-ctr",
            "-o",
        ] {
            assert_eq!(code(text), "SSH_OPTION_MALFORMED", "{text}");
        }
        assert_eq!(code("Ciphers none"), "SSH_OPTION_UNKNOWN_ALGORITHM");
        assert_eq!(code("MACs none"), "SSH_OPTION_UNKNOWN_ALGORITHM");
        assert_eq!(code("KexAlgorithms none"), "SSH_OPTION_UNKNOWN_ALGORITHM");
        assert_eq!(
            code("HostKeyAlgorithms ssh-dss"),
            "SSH_OPTION_UNKNOWN_ALGORITHM"
        );
        assert_eq!(
            code("Ciphers aes128-ctr\nciphers aes256-ctr"),
            "SSH_OPTION_DUPLICATE"
        );
        assert_eq!(
            code("PubkeyAcceptedKeyTypes +ssh-rsa\nPubkeyAcceptedAlgorithms +ssh-rsa"),
            "SSH_OPTION_DUPLICATE"
        );
    }

    #[test]
    fn numbers_and_limits() {
        let options =
            parse("ConnectTimeout=60\nServerAliveInterval 0\nServerAliveCountMax=5").unwrap();
        assert_eq!(options.connect_timeout, Some(Duration::from_secs(60)));
        assert_eq!(options.server_alive_interval, Some(0));
        assert_eq!(options.server_alive_count_max, Some(5));
        for text in [
            "ConnectTimeout 0",
            "ConnectTimeout 3601",
            "ConnectTimeout x",
            "ServerAliveCountMax 0",
            "ServerAliveInterval -1",
        ] {
            assert_eq!(code(text), "SSH_OPTION_RANGE", "{text}");
        }
        let many = "ConnectTimeout 5\n".repeat(MAX_LINES + 1);
        assert_eq!(code(&many), "SSH_OPTIONS_TOO_LONG");
        assert_eq!(
            code(&format!("Ciphers {}", "a".repeat(MAX_TEXT_LEN))),
            "SSH_OPTIONS_TOO_LONG"
        );
    }

    #[test]
    fn every_supported_name_maps_to_russh() {
        for name in ListKind::Kex.supported() {
            assert!(kex::Name::try_from(name).is_ok(), "{name}");
        }
        for name in ListKind::Cipher.supported() {
            assert!(cipher::Name::try_from(name).is_ok(), "{name}");
        }
        for name in ListKind::Mac.supported() {
            assert!(mac::Name::try_from(name).is_ok(), "{name}");
        }
        for name in KEY_ALGORITHMS {
            assert_eq!(key_algorithm(name).unwrap().as_str(), name);
        }
        // Legacy algorithms this feature exists for.
        for (kind, name) in [
            (ListKind::Kex, "diffie-hellman-group1-sha1"),
            (ListKind::Kex, "diffie-hellman-group14-sha1"),
            (ListKind::Kex, "diffie-hellman-group-exchange-sha1"),
            (ListKind::Cipher, "aes128-cbc"),
            (ListKind::Cipher, "3des-cbc"),
            (ListKind::Mac, "hmac-sha1"),
            (ListKind::HostKey, "ssh-rsa"),
        ] {
            assert!(kind.supported().contains(&name), "{name}");
        }
    }

    #[test]
    fn maps_lists_to_russh_preferences() {
        let options = parse(
            "KexAlgorithms diffie-hellman-group1-sha1\nHostKeyAlgorithms ssh-rsa\nCiphers 3des-cbc,aes128-cbc\nMACs hmac-sha1",
        )
        .unwrap();
        let preferred = options.preferred();
        let mut kex = vec!["diffie-hellman-group1-sha1".to_owned()];
        kex.extend(names(&KEX_EXTENSIONS));
        assert_eq!(names(&preferred.kex), kex);
        assert_eq!(preferred.key.as_ref(), [Algorithm::Rsa { hash: None }]);
        assert_eq!(names(&preferred.cipher), ["3des-cbc", "aes128-cbc"]);
        assert_eq!(names(&preferred.mac), ["hmac-sha1"]);
        assert_eq!(
            names(&preferred.compression),
            names(&Preferred::default().compression)
        );
        assert_eq!(
            options.legacy,
            [
                "diffie-hellman-group1-sha1",
                "ssh-rsa",
                "3des-cbc",
                "aes128-cbc",
                "hmac-sha1"
            ]
        );
    }

    #[test]
    fn security_key_agent_keys_stay_allowed_with_list_modifiers() {
        for text in [
            "PubkeyAcceptedAlgorithms +ssh-rsa",
            "PubkeyAcceptedAlgorithms ^rsa-sha2-256",
            "PubkeyAcceptedAlgorithms -ssh-rsa",
        ] {
            let options = parse(text).unwrap();
            assert!(options.accepts_key(&Algorithm::SkEd25519), "{text}");
            assert!(
                options.accepts_key(&Algorithm::SkEcdsaSha2NistP256),
                "{text}"
            );
        }
        let replaced = parse("PubkeyAcceptedAlgorithms ssh-ed25519").unwrap();
        assert!(!replaced.accepts_key(&Algorithm::SkEd25519));
        let only_sk = parse("PubkeyAcceptedAlgorithms sk-ssh-ed25519@openssh.com").unwrap();
        assert!(only_sk.accepts_key(&Algorithm::SkEd25519));
        assert_eq!(
            code(
                "PubkeyAcceptedAlgorithms -sk-ssh-ed25519@openssh.com,sk-ecdsa-sha2-nistp256@openssh.com,ssh-ed25519,ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,ecdsa-sha2-nistp521,rsa-sha2-512,rsa-sha2-256,ssh-rsa"
            ),
            "SSH_OPTION_EMPTY_LIST"
        );
        for name in SK_KEY_ALGORITHMS {
            assert!(
                russh::keys::key::ALL_KEY_TYPES
                    .iter()
                    .any(|algorithm| algorithm.as_str() == name),
                "{name}"
            );
        }
        // HostKey and Pubkey are one family: no hint to the other key list.
        assert_eq!(
            code("HostKeyAlgorithms +sk-ssh-ed25519@openssh.com"),
            "SSH_OPTION_UNKNOWN_ALGORITHM"
        );
    }

    #[test]
    fn group_exchange_minimum_is_lowered_only_on_explicit_choice() {
        let default_min = GexParams::default().min_group_size();
        assert_eq!(default_min, 3072);
        assert_eq!(
            SshOptions::default().gex_params().min_group_size(),
            default_min
        );
        for text in [
            "KexAlgorithms +diffie-hellman-group-exchange-sha1",
            "KexAlgorithms ^diffie-hellman-group-exchange-sha256",
            "KexAlgorithms diffie-hellman-group-exchange-sha256,curve25519-sha256",
        ] {
            let gex = parse(text).unwrap().gex_params();
            assert_eq!(gex.min_group_size(), 2048, "{text}");
            assert_eq!(gex.max_group_size(), GexParams::default().max_group_size());
        }
        for text in [
            "KexAlgorithms -diffie-hellman-group-exchange-sha256",
            "KexAlgorithms +diffie-hellman-group14-sha1",
            "Ciphers +aes128-cbc",
        ] {
            assert_eq!(
                parse(text).unwrap().gex_params().min_group_size(),
                default_min,
                "{text}"
            );
        }
    }

    #[test]
    fn length_limit_counts_utf8_bytes() {
        // 2048 two-byte characters = 4096 bytes: still allowed by length, rejected as option.
        let at_limit = format!("#{}", "ä".repeat(2047));
        assert_eq!(at_limit.len(), 4095);
        assert!(parse(&at_limit).is_ok());
        let over = format!("#{}", "ä".repeat(2048));
        assert_eq!(code(&over), "SSH_OPTIONS_TOO_LONG");
    }

    #[test]
    fn pubkey_algorithms_select_rsa_hash_and_filter_keys() {
        let none = SshOptions::default();
        assert_eq!(
            none.rsa_hash(Some(HashAlg::Sha512)),
            Some(Some(HashAlg::Sha512))
        );
        assert!(none.accepts_key(&Algorithm::Ed25519));
        let only_sha1 = parse("PubkeyAcceptedKeyTypes ssh-rsa").unwrap();
        assert_eq!(only_sha1.rsa_hash(Some(HashAlg::Sha512)), Some(None));
        assert!(!only_sha1.accepts_key(&Algorithm::Ed25519));
        assert!(only_sha1.accepts_key(&Algorithm::Rsa { hash: None }));
        let no_rsa = parse("PubkeyAcceptedAlgorithms ssh-ed25519").unwrap();
        assert_eq!(no_rsa.rsa_hash(None), None);
        assert!(!no_rsa.accepts_key(&Algorithm::Rsa { hash: None }));
        assert!(no_rsa.accepts_key(&Algorithm::Ed25519));
        let sha2 = parse("PubkeyAcceptedAlgorithms -ssh-rsa").unwrap();
        assert_eq!(sha2.rsa_hash(None), Some(Some(HashAlg::Sha512)));
        assert_eq!(
            sha2.rsa_hash(Some(HashAlg::Sha256)),
            Some(Some(HashAlg::Sha256))
        );
    }
}
