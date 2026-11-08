use serde::Serialize;
#[cfg(target_os = "linux")]
use std::os::unix::fs::MetadataExt;

#[derive(Serialize)]
#[cfg(target_os = "linux")]
pub(super) struct Permission {
    device: String,
    group: String,
    username: String,
    guessed: bool,
    already_member: bool,
    os_id: String,
    os_id_like: String,
}
fn valid_username(value: &str) -> bool {
    let value = value.strip_suffix('$').unwrap_or(value);
    let mut chars = value.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c == '_')
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}
fn passwd(text: &str, uid: u32) -> Option<(&str, u32)> {
    text.lines().find_map(|line| {
        let fields: Vec<_> = line.split(':').collect();
        if fields.len() >= 7 && fields[2].parse::<u32>().ok()? == uid {
            Some((fields[0], fields[3].parse().ok()?))
        } else {
            None
        }
    })
}
fn group(text: &str, gid: u32) -> Option<(&str, Vec<&str>)> {
    text.lines().find_map(|line| {
        let fields: Vec<_> = line.split(':').collect();
        if fields.len() == 4 && fields[2].parse::<u32>().ok()? == gid && !fields[0].is_empty() {
            Some((fields[0], fields[3].split(',').collect()))
        } else {
            None
        }
    })
}
fn member(members: &[&str], username: &str, primary: Option<u32>, gid: Option<u32>) -> bool {
    members.contains(&username) || primary.is_some_and(|primary| Some(primary) == gid)
}
fn release_value(text: &str, key: &str) -> String {
    text.lines()
        .find_map(|line| line.strip_prefix(&format!("{key}=")))
        .unwrap_or("")
        .trim_matches(['"', '\''])
        .to_owned()
}
#[cfg(target_os = "linux")]
pub(super) fn inspect(device: &str) -> Result<Permission, String> {
    let groups = std::fs::read_to_string("/etc/group").unwrap_or_default();
    let accounts = std::fs::read_to_string("/etc/passwd").unwrap_or_default();
    // SAFETY: getuid has no arguments or memory preconditions.
    let account = passwd(&accounts, unsafe { libc::getuid() });
    let username = account
        .map(|a| a.0.to_owned())
        .or_else(|| std::env::var("USER").ok())
        .unwrap_or_default();
    if !valid_username(&username) {
        return Err("Benutzername ungewöhnlich, bitte manuell".into());
    }
    // metadata follows symlinks, including /dev/serial/by-id links.
    let gid = std::fs::metadata(device).ok().map(|m| m.gid());
    let resolved = gid.and_then(|gid| group(&groups, gid));
    let guessed = resolved.is_none();
    let fallback_gid = groups.lines().find_map(|line| {
        let fields: Vec<_> = line.split(':').collect();
        (fields.len() == 4 && fields[0] == "dialout")
            .then(|| fields[2].parse::<u32>().ok())
            .flatten()
    });
    let (name, members) = resolved
        .or_else(|| fallback_gid.and_then(|gid| group(&groups, gid)))
        .unwrap_or(("dialout", vec![]));
    let release = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
    Ok(Permission {
        device: device.into(),
        group: name.into(),
        guessed,
        already_member: member(
            &members,
            &username,
            account.map(|a| a.1),
            if guessed { fallback_gid } else { gid },
        ),
        username,
        os_id: release_value(&release, "ID"),
        os_id_like: release_value(&release, "ID_LIKE"),
    })
}
fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\"'\"'"))
}
#[derive(Serialize)]
struct OptionCommand {
    label: String,
    command: String,
    needs_root_password: bool,
    hint: String,
}
const PRIVILEGE: [&str; 4] = ["sudo", "doas", "pkexec", "su"];
const GROUP_TOOLS: [&str; 4] = ["usermod", "gpasswd", "addgroup", "adduser"];
fn root_command(tool: &str, group: &str, user: &str) -> String {
    let (g, u) = (quote(group), quote(user));
    match tool {
        "usermod" => format!("usermod -aG {g} {u}"),
        "gpasswd" => format!("gpasswd -a {u} {g}"),
        _ => format!("{tool} {u} {g}"),
    }
}
fn options(group: &str, user: &str, has: impl Fn(&str) -> bool) -> Vec<OptionCommand> {
    let mut result = vec![];
    for privilege in PRIVILEGE.into_iter().filter(|p| has(p)) {
        for tool in GROUP_TOOLS.into_iter().filter(|p| has(p)) {
            let cmd = root_command(tool, group, user);
            result.push(OptionCommand {
                label: format!("{privilege} + {tool}"),
                command: if privilege == "su" {
                    format!("su -c {}", quote(&cmd))
                } else {
                    format!("{privilege} {cmd}")
                },
                needs_root_password: privilege == "su",
                hint: if privilege == "su" {
                    "Fragt das Root-Passwort"
                } else {
                    "Authentifizierung erfolgt im Terminal"
                }
                .into(),
            });
        }
    }
    result
}
fn install_hint(id: &str, like: &str) -> &'static str {
    for distro in std::iter::once(id).chain(like.split_whitespace()) {
        match distro {
            "debian" | "ubuntu" => return "apt install sudo",
            "alpine" => return "apk add sudo oder apk add doas",
            "arch" => return "pacman -S sudo",
            "fedora" | "rhel" => return "dnf install sudo",
            "opensuse" | "opensuse-leap" | "opensuse-tumbleweed" | "suse" => {
                return "zypper install sudo";
            }
            _ => (),
        }
    }
    "Als root ein Berechtigungswerkzeug (sudo, doas, pkexec oder su) und ein Gruppenwerkzeug installieren."
}
#[cfg(target_os = "linux")]
pub(super) fn fix_options(device: &str) -> Result<serde_json::Value, String> {
    let info = inspect(device)?;
    let has = crate::pty::program_in_path;
    let commands = options(&info.group, &info.username, has);
    let missing: Vec<_> = PRIVILEGE
        .into_iter()
        .chain(GROUP_TOOLS)
        .filter(|p| !has(p))
        .collect();
    Ok(serde_json::json!({ "options": commands, "missing": missing,
        "install_hint": install_hint(&info.os_id, &info.os_id_like),
        "root_command": root_command("usermod", &info.group, &info.username) }))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parsers_and_membership() {
        assert_eq!(
            passwd("broken\na:x:1000:20:A:/home/a:/bin/sh", 1000),
            Some(("a", 20))
        );
        assert_eq!(passwd("a:x:no:20:A:/a:/bin/sh", 1000), None);
        let (name, users) = group("bad\ntty:x:20:a,abc", 20).unwrap();
        assert_eq!(name, "tty");
        assert!(member(&users, "a", None, Some(20)));
        assert!(!member(&users, "ab", None, Some(20)));
        assert!(member(&[], "a", Some(20), Some(20)));
        assert!(!member(&[], "a", None, None));
    }
    #[test]
    fn usernames() {
        for name in ["a", "_user", "user-1", "machine$"] {
            assert!(valid_username(name));
        }
        for name in ["", "1user", "A", "a;b", "a$b", "a\n", "$"] {
            assert!(!valid_username(name));
        }
    }
    #[test]
    fn combinations_and_quoting() {
        assert!(options("tty", "a", |_| false).is_empty());
        assert!(options("tty", "a", |p| PRIVILEGE.contains(&p)).is_empty());
        assert!(options("tty", "a", |p| GROUP_TOOLS.contains(&p)).is_empty());
        for privilege in PRIVILEGE {
            for tool in GROUP_TOOLS {
                let opts = options("tty", "a", |p| p == privilege || p == tool);
                assert_eq!(opts.len(), 1);
                assert_eq!(opts[0].needs_root_password, privilege == "su");
                let expected = match tool {
                    "usermod" => "usermod -aG 'tty' 'a'",
                    "gpasswd" => "gpasswd -a 'a' 'tty'",
                    "addgroup" => "addgroup 'a' 'tty'",
                    _ => "adduser 'a' 'tty'",
                };
                assert_eq!(
                    opts[0].command,
                    if privilege == "su" {
                        format!("su -c {}", quote(expected))
                    } else {
                        format!("{privilege} {expected}")
                    }
                );
            }
        }
        assert_eq!(
            options("tty", "a", |_| true)[0].command,
            "sudo usermod -aG 'tty' 'a'"
        );
        assert_eq!(root_command("gpasswd", "tty", "a"), "gpasswd -a 'a' 'tty'");
        assert_eq!(quote("a'b"), "'a'\"'\"'b'");
        assert_eq!(quote("$(id); `id` $USER"), "'$(id); `id` $USER'");
        assert_eq!(
            options("tty", "a", |p| p == "su" || p == "usermod")[0].command,
            "su -c 'usermod -aG '\"'\"'tty'\"'\"' '\"'\"'a'\"'\"''"
        );
        let command = root_command("usermod", "a'b", "user$");
        assert_eq!(
            options("a'b", "user$", |p| p == "su" || p == "usermod")[0].command,
            format!("su -c {}", quote(&command))
        );
        assert_eq!(install_hint("mint", "ubuntu debian"), "apt install sudo");
        assert_eq!(
            release_value("ID=\"alpine\"\nID_LIKE=debian", "ID"),
            "alpine"
        );
    }
}
