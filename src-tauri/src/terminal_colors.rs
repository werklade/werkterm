use serde_json::{Map, Value};
use std::path::PathBuf;

const KEYS: [&str; 19] = [
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
    "foreground",
    "background",
    "cursor",
];
const INI_KEYS: [&str; 19] = [
    "Black",
    "Red",
    "Green",
    "Yellow",
    "Blue",
    "Magenta",
    "Cyan",
    "White",
    "BoldBlack",
    "BoldRed",
    "BoldGreen",
    "BoldYellow",
    "BoldBlue",
    "BoldMagenta",
    "BoldCyan",
    "BoldWhite",
    "ForegroundColour",
    "BackgroundColour",
    "CursorColour",
];
const DEFAULTS: [&str; 19] = [
    "#000000", "#cd3131", "#1e9d38", "#e3961a", "#1769ff", "#c5178a", "#19a679", "#c5c8c6",
    "#5f5f5f", "#f44747", "#6a9955", "#f38518", "#729fcf", "#c33882", "#29b8db", "#ffffff",
    "#c5c8c6", "#000000", "#1769ff",
];
/// Inspect only the Colors section. Unknown keys and invalid channels are ignored.
pub fn parse_colors(input: &str) -> Value {
    let mut result: Map<String, Value> = KEYS
        .iter()
        .zip(DEFAULTS)
        .map(|(key, value)| (String::from(*key), Value::from(value)))
        .collect();
    result.insert("selectionBackground".into(), Value::from("#3c3c3c"));
    let mut colors = false;
    for line in input.lines() {
        let line = line.trim().trim_start_matches('\u{feff}');
        if line.starts_with('[') {
            colors = line.eq_ignore_ascii_case("[Colors]");
            continue;
        }
        if !colors || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let Some(index) = INI_KEYS
            .iter()
            .position(|name| name.eq_ignore_ascii_case(key.trim()))
        else {
            continue;
        };
        let channels: Result<Vec<u8>, _> = value
            .split(',')
            .map(|part| part.trim().parse::<u8>())
            .collect();
        if let Ok(rgb) = channels
            && rgb.len() == 3
        {
            result.insert(
                KEYS[index].into(),
                Value::from(format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2])),
            );
        }
    }
    Value::Object(result)
}

#[tauri::command]
pub async fn import_mobaxterm_colors(path: Option<String>) -> Result<Value, String> {
    let path = match path {
        Some(path) => PathBuf::from(path),
        None => default_path().ok_or("Bitte MobaXterm.ini auswählen.")?,
    };
    // Keep file contents and paths out of errors: the file may contain credentials.
    // MobaXterm may store the file in a Windows code page; colors are ASCII, so a lossy
    // decode is enough and other sections never matter.
    let bytes = std::fs::read(path).map_err(|_| "Farbdatei konnte nicht gelesen werden.")?;
    Ok(parse_colors(&String::from_utf8_lossy(&bytes)))
}
fn default_path() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA")
            .map(|path| PathBuf::from(path).join("MobaXterm").join("MobaXterm.ini"))
    }
    #[cfg(not(windows))]
    {
        None
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_colors_and_valid_rgb() {
        let theme = parse_colors(
            "[Sessions]\nRed=1,2,3\n[Colors]\nRed=12,34,56\nBoldBlue=0,128,255\nForegroundColour=3,4,5\nGreen=256,2,3\nBlue=-1,2,3\nWhite=1,2\n[Other]\nRed=9,9,9",
        );
        assert_eq!(theme["red"], "#0c2238");
        assert_eq!(theme["brightBlue"], "#0080ff");
        assert_eq!(theme["foreground"], "#030405");
        assert_eq!(theme["green"], "#1e9d38");
        assert_eq!(theme["blue"], "#1769ff");
        assert_eq!(theme["white"], "#c5c8c6");
    }
    #[test]
    fn defaults_and_all_mappings() {
        let defaults = parse_colors("");
        for (key, value) in KEYS.iter().zip(DEFAULTS) {
            assert_eq!(defaults[key], value);
        }
        let input = format!(
            "[Colors]\n{}",
            INI_KEYS.map(|key| format!("{key}=17,33,254")).join("\n")
        );
        let theme = parse_colors(&input);
        for key in KEYS {
            assert_eq!(theme[key], "#1121fe");
        }
    }
}
