use super::DirEntry;

pub const UNSUPPORTED: &str = "Server unterstützt weder SFTP noch GNU ls (--time-style)";

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
        let name = rest.trim_start();
        let name = if kind == "symlink" {
            name.split_once(" -> ").ok_or(UNSUPPORTED)?.0
        } else {
            name
        };
        if name.is_empty() {
            return Err(UNSUPPORTED.into());
        }
        if name == "." || name == ".." {
            continue;
        }
        entries.push(DirEntry {
            name: name.into(),
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
        let entries = parse("total 4\ndrwxr-xr-x 2 user group 4096 123 folder name\n-rw-r----- 1 u g 12 124 file name\nlrwxrwxrwx 1 u g 4 125 link -> folder name\nbrw-rw---- 1 root disk 8, 1 126 disk\ndrwxr-xr-x 1 u g 0 127 .\n").unwrap();
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
}
