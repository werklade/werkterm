//! Read-only local socket inventory. No sockets or network connections are opened.
use serde::Serialize;
use std::collections::HashMap;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct LocalPort {
    protocol: String,
    address: String,
    port: u16,
    pid: Option<u32>,
    process: Option<String>,
}

#[cfg(any(target_os = "linux", test))]
fn proc_address(value: &str) -> Option<(String, u16)> {
    let (address, port) = value.split_once(':')?;
    let port = u16::from_str_radix(port, 16).ok()?;
    let address = match address.len() {
        8 => std::net::Ipv4Addr::from(u32::from_str_radix(address, 16).ok()?.to_ne_bytes())
            .to_string(),
        32 => {
            let mut bytes = [0_u8; 16];
            for (chunk, out) in address
                .as_bytes()
                .as_chunks::<8>()
                .0
                .iter()
                .zip(bytes.as_chunks_mut::<4>().0.iter_mut())
            {
                let word = u32::from_str_radix(std::str::from_utf8(chunk).ok()?, 16).ok()?;
                out.copy_from_slice(&word.to_ne_bytes());
            }
            std::net::Ipv6Addr::from(bytes).to_string()
        }
        _ => return None,
    };
    Some((address, port))
}

#[cfg(any(target_os = "linux", test))]
fn parse_proc(input: &str, protocol: &str) -> Vec<(LocalPort, u64)> {
    input
        .lines()
        .filter_map(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.len() < 10 || (protocol.starts_with("TCP") && fields[3] != "0A") {
                return None;
            }
            let (address, port) = proc_address(fields[1])?;
            if port == 0 {
                return None;
            }
            Some((
                LocalPort {
                    protocol: protocol.into(),
                    address,
                    port,
                    pid: None,
                    process: None,
                },
                fields[9].parse().ok()?,
            ))
        })
        .collect()
}

#[cfg(any(target_os = "windows", test))]
fn parse_netstat(input: &str) -> Vec<LocalPort> {
    input
        .lines()
        .filter_map(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            let protocol = *fields.first()?;
            let pid = match protocol {
                "TCP"
                    if fields.len() == 5
                        && (fields[3].starts_with("LISTEN")
                            || fields[3].starts_with("ABH")
                            || matches!(fields[2], "0.0.0.0:0" | "[::]:0")) =>
                {
                    fields[4]
                }
                "UDP" if fields.len() == 4 => fields[3],
                _ => return None,
            };
            let (address, port) = fields[1].rsplit_once(':')?;
            let port = port.parse().ok()?;
            if port == 0 {
                return None;
            }
            Some(LocalPort {
                protocol: protocol.into(),
                address: address.trim_start_matches('[').trim_end_matches(']').into(),
                port,
                pid: if protocol == "TCP" {
                    Some(pid.parse().ok()?)
                } else {
                    pid.parse().ok()
                },
                process: None,
            })
        })
        .collect()
}

#[cfg(any(target_os = "windows", test))]
fn parse_tasklist(input: &str) -> HashMap<u32, String> {
    input
        .lines()
        .filter_map(|line| {
            // tasklist emits quoted CSV, including doubled quotes inside names.
            let mut fields = Vec::new();
            let mut value = String::new();
            let mut quoted = false;
            let mut chars = line.chars().peekable();
            while let Some(ch) = chars.next() {
                match ch {
                    '"' if quoted && chars.peek() == Some(&'"') => {
                        value.push('"');
                        chars.next();
                    }
                    '"' => quoted = !quoted,
                    ',' if !quoted => {
                        fields.push(std::mem::take(&mut value));
                    }
                    _ => value.push(ch),
                }
            }
            fields.push(value);
            if quoted || fields.len() < 2 {
                return None;
            }
            Some((fields[1].parse().ok()?, fields[0].clone()))
        })
        .collect()
}

#[cfg(target_os = "linux")]
fn inventory() -> Result<Vec<LocalPort>, String> {
    use std::{fs, path::Path};
    let mut sockets = Vec::new();
    let mut readable = false;
    for (file, protocol) in [
        ("tcp", "TCP"),
        ("tcp6", "TCP6"),
        ("udp", "UDP"),
        ("udp6", "UDP6"),
    ] {
        if let Ok(input) = fs::read_to_string(Path::new("/proc/net").join(file)) {
            readable = true;
            sockets.extend(parse_proc(&input, protocol));
        }
    }
    if !readable {
        return Err("Lokale Socket-Tabellen sind nicht lesbar.".into());
    }
    let wanted: std::collections::HashSet<_> = sockets.iter().map(|(_, inode)| *inode).collect();
    let mut owners = HashMap::new();
    for entry in fs::read_dir("/proc")
        .map_err(|_| "Prozessliste ist nicht lesbar.")?
        .flatten()
    {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(fds) = fs::read_dir(entry.path().join("fd")) else {
            continue;
        };
        for fd in fds.flatten() {
            let Ok(target) = fs::read_link(fd.path()) else {
                continue;
            };
            let text = target.to_string_lossy();
            let Some(inode) = text
                .strip_prefix("socket:[")
                .and_then(|s| s.strip_suffix(']'))
                .and_then(|s| s.parse::<u64>().ok())
            else {
                continue;
            };
            if wanted.contains(&inode) {
                let name = fs::read_to_string(entry.path().join("comm"))
                    .ok()
                    .map(|name| name.trim().to_owned());
                owners.entry(inode).or_insert((pid, name));
            }
        }
    }
    Ok(sockets
        .into_iter()
        .map(|(mut socket, inode)| {
            if let Some((pid, name)) = owners.get(&inode) {
                socket.pid = Some(*pid);
                socket.process.clone_from(name);
            }
            socket
        })
        .collect())
}

#[cfg(target_os = "windows")]
fn inventory() -> Result<Vec<LocalPort>, String> {
    use std::{os::windows::process::CommandExt, process::Command};
    let output = Command::new("netstat")
        .arg("-ano")
        .creation_flags(0x08000000)
        .output()
        .map_err(|_| "netstat konnte nicht gestartet werden.")?;
    if !output.status.success() {
        return Err("netstat ist fehlgeschlagen.".into());
    }
    let mut ports = parse_netstat(&String::from_utf8_lossy(&output.stdout));
    let names = Command::new("tasklist")
        .args(["/FO", "CSV", "/NH"])
        .creation_flags(0x08000000)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| parse_tasklist(&String::from_utf8_lossy(&output.stdout)))
        .unwrap_or_default();
    for port in &mut ports {
        port.process = port.pid.and_then(|pid| names.get(&pid).cloned());
    }
    Ok(ports)
}

#[tauri::command]
pub async fn local_ports() -> Result<Vec<LocalPort>, String> {
    tauri::async_runtime::spawn_blocking(inventory)
        .await
        .map_err(|_| "Portliste konnte nicht gelesen werden.".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn proc_decodes_native_words_and_filters_states() {
        if cfg!(target_endian = "little") {
            assert_eq!(
                proc_address("0100007F:0016"),
                Some(("127.0.0.1".into(), 22))
            );
            assert_eq!(
                proc_address("00000000000000000000000001000000:1F90"),
                Some(("::1".into(), 8080))
            );
            assert_eq!(
                proc_address("0000000000000000FFFF00000100007F:0035"),
                Some(("::ffff:127.0.0.1".into(), 53))
            );
        }
        let rows = " 0: 00000000:0050 00000000:0000 0A 0:0 00:0 0 1000 0 42\n1: 0100007F:0016 00000000:0000 01 0:0 00:0 0 1000 0 43\ninvalid";
        assert_eq!(parse_proc(rows, "TCP").len(), 1);
        assert_eq!(parse_proc(rows, "UDP").len(), 2);
        assert_eq!(parse_proc(rows, "TCP")[0].1, 42);
        assert!(proc_address("wrong:1234").is_none());
    }
    #[test]
    fn windows_oem_listeners() {
        let bytes = b"TCP 0.0.0.0:22 0.0.0.0:0 ABH\x99REN 123\nTCP [::]:80 [::]:0 UNKNOWN 456\nTCP 127.0.0.1:90 1.2.3.4:50 ESTABLISHED 7\nTCP 0.0.0.0:99 0.0.0.0:0 LISTENING nope";
        assert_eq!(parse_netstat(&String::from_utf8_lossy(bytes)).len(), 2);
        assert_eq!(parse_netstat("TCP [::]:22 [::]:0 ABHÖREN 9").len(), 1);
    }
    #[test]
    fn windows_parsers_support_ipv6_and_csv() {
        let rows = "TCP 127.0.0.1:22 0.0.0.0:0 LISTENING 123\nTCP [::1]:8080 [::]:0 LISTENING 456\nTCP 1.2.3.4:90 2.3.4.5:90 ESTABLISHED 9\nUDP [fe80::1%7]:53 *:* 123\nUDP 0.0.0.0:68 *:* 5\nTCP bad *:* LISTENING nope";
        let parsed = parse_netstat(rows);
        assert_eq!(parsed.len(), 4);
        assert_eq!(parsed[1].address, "::1");
        assert_eq!(parsed[2].address, "fe80::1%7");
        assert_eq!(parsed[2].port, 53);
        let names = parse_tasklist(
            "\"example, app.exe\",\"123\",\"Console\",\"1\"\n\"a\"\"b.exe\",\"456\"\ninvalid",
        );
        assert_eq!(names.get(&123).unwrap(), "example, app.exe");
        assert_eq!(names.get(&456).unwrap(), "a\"b.exe");
    }
}
