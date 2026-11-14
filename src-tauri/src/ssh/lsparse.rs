use super::DirEntry;
use crate::ui_error::ui_code;

pub const UNSUPPORTED: &str = ui_code("SSH_LS_UNSUPPORTED");

fn token(input: &mut &str) -> Result<String, String> {
    *input = input.trim_start();
    let end = input.find(char::is_whitespace).ok_or(UNSUPPORTED)?;
    let result = input[..end].to_owned();
    *input = &input[end..];
    Ok(result)
}

pub fn mode_bits(mode: &str) -> Result<u32, String> {
    let chars: Vec<_> = mode.chars().collect();
    if chars.len() < 10 || !"-dlbcps?".contains(chars[0]) {
        return Err(UNSUPPORTED.into());
    }
    let mut bits = 0;
    for group in 0..3 {
        let start = 1 + group * 3;
        for (offset, expected, bit) in [(0, 'r', 4), (1, 'w', 2)] {
            match chars[start + offset] {
                '-' => (),
                c if c == expected => bits |= bit << ((2 - group) * 3),
                _ => return Err(UNSUPPORTED.into()),
            }
        }
        match chars[start + 2] {
            '-' => (),
            'x' => bits |= 1 << ((2 - group) * 3),
            c @ ('s' | 'S') if group < 2 => {
                bits |= if group == 0 { 0o4000 } else { 0o2000 };
                if c == 's' {
                    bits |= 1 << ((2 - group) * 3);
                }
            }
            c @ ('t' | 'T') if group == 2 => {
                bits |= 0o1000;
                if c == 't' {
                    bits |= 1;
                }
            }
            _ => return Err(UNSUPPORTED.into()),
        }
    }
    Ok(bits)
}

fn quoted(input: &mut &str) -> Result<String, String> {
    if !input.starts_with('"') {
        return Err(UNSUPPORTED.into());
    }
    let bytes = input.as_bytes();
    let mut result = Vec::new();
    let mut i = 1;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                *input = &input[i + 1..];
                return String::from_utf8(result).map_err(|_| UNSUPPORTED.into());
            }
            b'\\' => {
                i += 1;
                let byte = *bytes.get(i).ok_or(UNSUPPORTED)?;
                match byte {
                    b'"' | b'\\' => result.push(byte),
                    b'n' => result.push(b'\n'),
                    b't' => result.push(b'\t'),
                    b'a' => result.push(7),
                    b'b' => result.push(8),
                    b'f' => result.push(12),
                    b'r' => result.push(13),
                    b'v' => result.push(11),
                    b'0'..=b'7' => {
                        let mut value = u16::from(byte - b'0');
                        for _ in 0..2 {
                            if let Some(next @ b'0'..=b'7') = bytes.get(i + 1) {
                                i += 1;
                                value = value * 8 + u16::from(*next - b'0');
                            } else {
                                break;
                            }
                        }
                        result.push(u8::try_from(value).map_err(|_| UNSUPPORTED)?);
                    }
                    _ => return Err(UNSUPPORTED.into()),
                }
            }
            byte => result.push(byte),
        }
        i += 1;
    }
    Err(UNSUPPORTED.into())
}

pub fn parse(output: &str) -> Result<Vec<DirEntry>, String> {
    let mut entries = Vec::new();
    for line in output.lines() {
        if line.starts_with("total ") && line[6..].trim().parse::<u64>().is_ok() {
            continue;
        }
        if line.is_empty() {
            continue;
        }
        let mut rest = line;
        let mode = token(&mut rest)?;
        let permissions = mode_bits(&mode)?;
        token(&mut rest)?.parse::<u64>().map_err(|_| UNSUPPORTED)?;
        token(&mut rest)?;
        token(&mut rest)?;
        let size_token = token(&mut rest)?;
        let size = if size_token.ends_with(',') {
            size_token
                .trim_end_matches(',')
                .parse::<u64>()
                .map_err(|_| UNSUPPORTED)?;
            token(&mut rest)?.parse::<u64>().map_err(|_| UNSUPPORTED)?;
            0
        } else {
            size_token.parse::<u64>().map_err(|_| UNSUPPORTED)?
        };
        let modified = token(&mut rest)?.parse::<i64>().map_err(|_| UNSUPPORTED)?;
        let kind = match mode.as_bytes()[0] {
            b'd' => "dir",
            b'-' => "file",
            b'l' => "symlink",
            _ => "other",
        };
        rest = rest.trim_start();
        let name = quoted(&mut rest)?;
        if kind == "symlink" {
            rest = rest.strip_prefix(" -> ").ok_or(UNSUPPORTED)?;
            quoted(&mut rest)?;
        }
        if !rest.is_empty() {
            return Err(UNSUPPORTED.into());
        }
        if name.is_empty() {
            return Err(UNSUPPORTED.into());
        }
        if name == "." || name == ".." {
            continue;
        }
        entries.push(DirEntry {
            uid: None,
            gid: None,
            user: None,
            group: None,
            name,
            kind: kind.into(),
            size,
            permissions,
            modified: u64::try_from(modified).ok(),
            target_is_dir: false,
        });
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_gnu_listing() {
        let entries = parse(
            r#"total 4
drwxr-xr-x 2 user group 4096 123 "folder name"
-rw-r----- 1 u g 12 124 "file name"
lrwxrwxrwx 1 u g 4 125 "link" -> "folder name"
brw-rw---- 1 root disk 8, 1 126 "disk"
drwxr-xr-x 1 u g 0 127 "."
"#,
        )
        .unwrap();
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0].name, "folder name");
        assert_eq!(entries[1].permissions, 0o640);
        assert_eq!(entries[2].name, "link");
        assert_eq!(entries[3].size, 0);
    }
    #[test]
    fn parses_special_modes_and_rejects_bad_lines() {
        assert_eq!(mode_bits("-rwsr-Sr-t").unwrap(), 0o7745);
        assert_eq!(mode_bits("-rwSr-sr-T").unwrap(), 0o7654);
        assert!(parse("nonsense").is_err());
        assert!(parse("-rw-r--r-- 1 u g nope 123 name").is_err());
        assert!(mode_bits("-rZ-r--r--").is_err());
    }
    #[test]
    fn preserves_c_quoted_names_and_symlink_arrows() {
        let entries = parse(
            r#"-rw-r--r-- 1 u g 0 1 " leading trailing "
lrwxrwxrwx 1 u g 0 1 "a -> b" -> "target -> x"
-rw-r--r-- 1 u g 0 1 "\303\244\040\042\134\n\t"
-rw-r--r-- 1 u g 0 1 "日本語"
"#,
        )
        .unwrap();
        assert_eq!(entries[0].name, " leading trailing ");
        assert_eq!(entries[1].name, "a -> b");
        assert_eq!(entries[2].name, "ä \"\\\n\t");
        assert_eq!(entries[3].name, "日本語");
        assert!(parse(r#"-rw-r--r-- 1 u g 0 1 "bad\q""#).is_err());
    }
}
