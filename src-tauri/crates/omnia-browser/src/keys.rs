//! Keyboard combo parsing ("ctrl+a", "Shift+Tab", "Enter") into CDP key events.

pub const ALT: u8 = 1;
pub const CTRL: u8 = 2;
pub const META: u8 = 4;
pub const SHIFT: u8 = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyDef {
    pub key: String,
    pub code: String,
    pub vk: u32,
    /// Text inserted by the key when no command modifier is held.
    pub text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyCombo {
    pub modifiers: u8,
    pub key: KeyDef,
}

fn def(key: &str, code: &str, vk: u32, text: Option<&str>) -> KeyDef {
    KeyDef {
        key: key.into(),
        code: code.into(),
        vk,
        text: text.map(str::to_string),
    }
}

/// Modifier name to bit.
pub fn modifier_bit(name: &str) -> Option<u8> {
    match name.trim().to_ascii_lowercase().as_str() {
        "alt" | "option" | "opt" => Some(ALT),
        "ctrl" | "control" => Some(CTRL),
        "meta" | "cmd" | "command" | "win" | "windows" | "super" => Some(META),
        "shift" => Some(SHIFT),
        _ => None,
    }
}

/// Parses a list like `["ctrl", "shift"]` into a bitmask.
pub fn parse_modifiers(names: &[String]) -> Result<u8, String> {
    let mut mask = 0;
    for name in names {
        mask |= modifier_bit(name).ok_or_else(|| format!("unknown modifier `{name}`"))?;
    }
    Ok(mask)
}

/// The key events used to press a modifier on its own.
pub fn modifier_keys(mask: u8) -> Vec<(u8, KeyDef)> {
    let mut keys = Vec::new();
    if mask & CTRL != 0 {
        keys.push((CTRL, def("Control", "ControlLeft", 17, None)));
    }
    if mask & ALT != 0 {
        keys.push((ALT, def("Alt", "AltLeft", 18, None)));
    }
    if mask & SHIFT != 0 {
        keys.push((SHIFT, def("Shift", "ShiftLeft", 16, None)));
    }
    if mask & META != 0 {
        keys.push((META, def("Meta", "MetaLeft", 91, None)));
    }
    keys
}

fn named_key(name: &str) -> Option<KeyDef> {
    let lower = name.to_ascii_lowercase();
    Some(match lower.as_str() {
        "enter" | "return" => def("Enter", "Enter", 13, Some("\r")),
        "tab" => def("Tab", "Tab", 9, None),
        "escape" | "esc" => def("Escape", "Escape", 27, None),
        "backspace" => def("Backspace", "Backspace", 8, None),
        "delete" | "del" => def("Delete", "Delete", 46, None),
        "insert" => def("Insert", "Insert", 45, None),
        "space" | "spacebar" => def(" ", "Space", 32, Some(" ")),
        "arrowup" | "up" => def("ArrowUp", "ArrowUp", 38, None),
        "arrowdown" | "down" => def("ArrowDown", "ArrowDown", 40, None),
        "arrowleft" | "left" => def("ArrowLeft", "ArrowLeft", 37, None),
        "arrowright" | "right" => def("ArrowRight", "ArrowRight", 39, None),
        "home" => def("Home", "Home", 36, None),
        "end" => def("End", "End", 35, None),
        "pageup" => def("PageUp", "PageUp", 33, None),
        "pagedown" => def("PageDown", "PageDown", 34, None),
        "shift" => def("Shift", "ShiftLeft", 16, None),
        "ctrl" | "control" => def("Control", "ControlLeft", 17, None),
        "alt" | "option" => def("Alt", "AltLeft", 18, None),
        "meta" | "cmd" | "command" | "win" | "windows" => def("Meta", "MetaLeft", 91, None),
        _ => {
            if let Some(n) = lower.strip_prefix('f').and_then(|n| n.parse::<u32>().ok()) {
                if (1..=12).contains(&n) {
                    return Some(def(&format!("F{n}"), &format!("F{n}"), 111 + n, None));
                }
            }
            return None;
        }
    })
}

fn char_key(c: char, shift: bool) -> KeyDef {
    if c.is_ascii_alphabetic() {
        let shown = if shift {
            c.to_ascii_uppercase()
        } else {
            c.to_ascii_lowercase()
        };
        return def(
            &shown.to_string(),
            &format!("Key{}", c.to_ascii_uppercase()),
            c.to_ascii_uppercase() as u32,
            Some(&shown.to_string()),
        );
    }
    if c.is_ascii_digit() {
        return def(
            &c.to_string(),
            &format!("Digit{c}"),
            c as u32,
            Some(&c.to_string()),
        );
    }
    let (code, vk) = match c {
        '-' => ("Minus", 189),
        '=' => ("Equal", 187),
        '[' => ("BracketLeft", 219),
        ']' => ("BracketRight", 221),
        ';' => ("Semicolon", 186),
        '\'' => ("Quote", 222),
        ',' => ("Comma", 188),
        '.' => ("Period", 190),
        '/' => ("Slash", 191),
        '\\' => ("Backslash", 220),
        '`' => ("Backquote", 192),
        '+' => ("Equal", 187),
        _ => ("", 0),
    };
    def(&c.to_string(), code, vk, Some(&c.to_string()))
}

/// Parses one combo such as `ctrl+shift+p`, `Enter` or `ctrl++`.
pub fn parse_combo(input: &str) -> Result<KeyCombo, String> {
    let s = input.trim();
    if s.is_empty() {
        return Err("empty key".into());
    }
    let (mods_part, key_part) = if s == "+" {
        ("", "+")
    } else if let Some(prefix) = s.strip_suffix("++") {
        (prefix, "+")
    } else if let Some(i) = s.rfind('+') {
        (&s[..i], &s[i + 1..])
    } else {
        ("", s)
    };
    let mut modifiers = 0;
    for token in mods_part.split('+').filter(|t| !t.is_empty()) {
        modifiers |= modifier_bit(token)
            .ok_or_else(|| format!("unknown modifier `{token}` in `{input}`"))?;
    }
    let key = if let Some(named) = named_key(key_part) {
        named
    } else if key_part.chars().count() == 1 {
        char_key(
            key_part.chars().next().unwrap_or(' '),
            modifiers & SHIFT != 0,
        )
    } else {
        return Err(format!("unknown key `{key_part}` in `{input}`"));
    };
    Ok(KeyCombo { modifiers, key })
}

/// Parses whitespace-separated combos, e.g. `ctrl+a Backspace`.
pub fn parse_sequence(input: &str) -> Result<Vec<KeyCombo>, String> {
    let combos: Vec<KeyCombo> = input
        .split_whitespace()
        .map(parse_combo)
        .collect::<Result<_, _>>()?;
    if combos.is_empty() {
        return Err("no keys given".into());
    }
    Ok(combos)
}

impl KeyCombo {
    /// Text the key would insert (none when ctrl/alt/meta is held).
    pub fn effective_text(&self) -> Option<&str> {
        if self.modifiers & (CTRL | ALT | META) != 0 {
            None
        } else {
            self.key.text.as_deref()
        }
    }

    /// Editing commands Chromium needs spelled out for headless key events.
    pub fn commands(&self) -> Vec<&'static str> {
        if self.modifiers & (CTRL | META) == 0 || self.modifiers & ALT != 0 {
            return Vec::new();
        }
        let shift = self.modifiers & SHIFT != 0;
        match (self.key.key.to_ascii_lowercase().as_str(), shift) {
            ("a", false) => vec!["selectAll"],
            ("c", false) => vec!["copy"],
            ("x", false) => vec!["cut"],
            ("v", false) => vec!["paste"],
            ("z", false) => vec!["undo"],
            ("z", true) | ("y", false) => vec!["redo"],
            _ => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ctrl_a() {
        let combo = parse_combo("ctrl+a").unwrap();
        assert_eq!(combo.modifiers, CTRL);
        assert_eq!(combo.key.key, "a");
        assert_eq!(combo.key.code, "KeyA");
        assert_eq!(combo.key.vk, 65);
        assert_eq!(combo.effective_text(), None);
        assert_eq!(combo.commands(), vec!["selectAll"]);
    }

    #[test]
    fn parses_named_and_shifted_keys() {
        let enter = parse_combo("Enter").unwrap();
        assert_eq!(enter.key.vk, 13);
        assert_eq!(enter.effective_text(), Some("\r"));
        let combo = parse_combo("Shift+Tab").unwrap();
        assert_eq!(combo.modifiers, SHIFT);
        assert_eq!(combo.key.key, "Tab");
        let upper = parse_combo("cmd+shift+P").unwrap();
        assert_eq!(upper.modifiers, META | SHIFT);
        assert_eq!(upper.key.key, "P");
        assert_eq!(parse_combo("F5").unwrap().key.vk, 116);
        assert_eq!(parse_combo("esc").unwrap().key.key, "Escape");
        assert_eq!(parse_combo("x").unwrap().effective_text(), Some("x"));
    }

    #[test]
    fn parses_plus_key_and_sequences() {
        let plus = parse_combo("ctrl++").unwrap();
        assert_eq!(plus.modifiers, CTRL);
        assert_eq!(plus.key.key, "+");
        assert_eq!(parse_combo("+").unwrap().key.key, "+");
        let seq = parse_sequence("ctrl+a  Backspace").unwrap();
        assert_eq!(seq.len(), 2);
        assert_eq!(seq[1].key.key, "Backspace");
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_combo("ctrl+nonsense").is_err());
        assert!(parse_combo("hyper+a").is_err());
        assert!(parse_combo("").is_err());
        assert!(parse_sequence("   ").is_err());
        assert_eq!(
            parse_modifiers(&["Ctrl".into(), "shift".into()]).unwrap(),
            CTRL | SHIFT
        );
        assert!(parse_modifiers(&["bogus".into()]).is_err());
    }
}
