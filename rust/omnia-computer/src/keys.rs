//! Key-combo parsing: `"ctrl+shift+s"`, `"alt+f4"`, `"enter"`, `"ctrl+a ctrl+c"`
//! into virtual-key sequences. Pure; the Windows sender lives in `input.rs`.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyStep {
    pub vk: u16,
    /// Needs `KEYEVENTF_EXTENDEDKEY` (arrows, nav cluster, Windows key).
    pub extended: bool,
}

/// Modifiers held while `key` is pressed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyChord {
    pub modifiers: Vec<KeyStep>,
    pub key: KeyStep,
}

pub const VK_SHIFT: u16 = 0x10;
pub const VK_CONTROL: u16 = 0x11;
pub const VK_MENU: u16 = 0x12;
pub const VK_LWIN: u16 = 0x5B;

fn step(vk: u16) -> KeyStep {
    KeyStep {
        vk,
        extended: false,
    }
}

fn ext(vk: u16) -> KeyStep {
    KeyStep { vk, extended: true }
}

/// Modifier key names only.
pub fn modifier(name: &str) -> Option<KeyStep> {
    Some(match name {
        "ctrl" | "control" | "ctl" => step(VK_CONTROL),
        "shift" => step(VK_SHIFT),
        "alt" | "menu" | "option" => step(VK_MENU),
        "win" | "windows" | "super" | "meta" | "cmd" | "lwin" => ext(VK_LWIN),
        _ => return None,
    })
}

fn named_key(name: &str) -> Option<KeyStep> {
    Some(match name {
        "enter" | "return" => step(0x0D),
        "tab" => step(0x09),
        "esc" | "escape" => step(0x1B),
        "space" | "spacebar" => step(0x20),
        "backspace" | "bksp" => step(0x08),
        "delete" | "del" => ext(0x2E),
        "insert" | "ins" => ext(0x2D),
        "home" => ext(0x24),
        "end" => ext(0x23),
        "pageup" | "pgup" => ext(0x21),
        "pagedown" | "pgdn" => ext(0x22),
        "up" | "arrowup" => ext(0x26),
        "down" | "arrowdown" => ext(0x28),
        "left" | "arrowleft" => ext(0x25),
        "right" | "arrowright" => ext(0x27),
        "capslock" | "caps" => step(0x14),
        "printscreen" | "prtsc" => ext(0x2C),
        "apps" | "contextmenu" => ext(0x5D),
        "plus" | "equals" | "equal" => step(0xBB),
        "minus" => step(0xBD),
        "comma" => step(0xBC),
        "period" | "dot" => step(0xBE),
        "slash" => step(0xBF),
        "backslash" => step(0xDC),
        "semicolon" => step(0xBA),
        "backtick" | "grave" => step(0xC0),
        "volumeup" => step(0xAF),
        "volumedown" => step(0xAE),
        "mute" | "volumemute" => step(0xAD),
        _ => return None,
    })
}

fn single_char_key(c: char) -> Option<KeyStep> {
    Some(match c {
        'a'..='z' => step(c.to_ascii_uppercase() as u16),
        '0'..='9' => step(c as u16),
        ';' => step(0xBA),
        '=' => step(0xBB),
        ',' => step(0xBC),
        '-' => step(0xBD),
        '.' => step(0xBE),
        '/' => step(0xBF),
        '`' => step(0xC0),
        '[' => step(0xDB),
        '\\' => step(0xDC),
        ']' => step(0xDD),
        '\'' => step(0xDE),
        _ => return None,
    })
}

/// Parse one non-modifier token into a key.
pub fn parse_key(token: &str) -> Result<KeyStep, String> {
    let t = token.trim().to_lowercase();
    if let Some(k) = named_key(&t) {
        return Ok(k);
    }
    if let Some(rest) = t.strip_prefix('f') {
        if let Ok(n) = rest.parse::<u16>() {
            if (1..=24).contains(&n) {
                return Ok(step(0x6F + n));
            }
        }
    }
    if let Some(rest) = t.strip_prefix("numpad") {
        if let Ok(n) = rest.parse::<u16>() {
            if n <= 9 {
                return Ok(step(0x60 + n));
            }
        }
    }
    let mut chars = t.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if let Some(k) = single_char_key(c) {
            return Ok(k);
        }
    }
    Err(format!("unknown key \"{token}\""))
}

/// Parse `"ctrl+shift+s"` into one chord. A bare modifier (`"shift"`, `"win"`)
/// is a chord whose key is the modifier itself.
pub fn parse_chord(spec: &str) -> Result<KeyChord, String> {
    let spec = spec.trim();
    if spec.is_empty() {
        return Err("empty key combo".into());
    }
    let (head, last) = if spec == "+" {
        ("", "plus")
    } else if let Some(h) = spec.strip_suffix("++") {
        (h, "plus")
    } else if let Some(i) = spec.rfind('+') {
        (&spec[..i], &spec[i + 1..])
    } else {
        ("", spec)
    };
    let mut modifiers = Vec::new();
    for m in head.split('+').filter(|m| !m.trim().is_empty()) {
        let name = m.trim().to_lowercase();
        modifiers.push(
            modifier(&name)
                .ok_or_else(|| format!("\"{m}\" is not a modifier (ctrl, shift, alt, win)"))?,
        );
    }
    if modifiers.is_empty() {
        if let Some(m) = modifier(&last.trim().to_lowercase()) {
            return Ok(KeyChord { modifiers, key: m });
        }
    }
    Ok(KeyChord {
        modifiers,
        key: parse_key(last)?,
    })
}

/// Parse a whitespace-separated sequence of chords: `"ctrl+a ctrl+c"`.
pub fn parse_keys(spec: &str) -> Result<Vec<KeyChord>, String> {
    let chords: Vec<KeyChord> = spec
        .split_whitespace()
        .map(parse_chord)
        .collect::<Result<_, _>>()?;
    if chords.is_empty() {
        return Err("empty key combo".into());
    }
    Ok(chords)
}

/// Flattened press/release sequence: `(step, is_down)`.
pub fn chord_events(chord: &KeyChord) -> Vec<(KeyStep, bool)> {
    let mut ev: Vec<(KeyStep, bool)> = chord.modifiers.iter().map(|m| (*m, true)).collect();
    ev.push((chord.key, true));
    ev.push((chord.key, false));
    ev.extend(chord.modifiers.iter().rev().map(|m| (*m, false)));
    ev
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_combos() {
        let c = parse_chord("ctrl+shift+s").unwrap();
        assert_eq!(
            c.modifiers.iter().map(|m| m.vk).collect::<Vec<_>>(),
            vec![VK_CONTROL, VK_SHIFT]
        );
        assert_eq!(c.key.vk, b'S' as u16);
        let c = parse_chord("alt+F4").unwrap();
        assert_eq!((c.modifiers[0].vk, c.key.vk), (VK_MENU, 0x73));
        let c = parse_chord("win+r").unwrap();
        assert_eq!((c.modifiers[0].vk, c.key.vk), (VK_LWIN, b'R' as u16));
        assert_eq!(parse_chord("enter").unwrap().key.vk, 0x0D);
        assert_eq!(parse_chord("f5").unwrap().key.vk, 0x74);
        assert_eq!(parse_chord("F24").unwrap().key.vk, 0x87);
    }

    #[test]
    fn extended_and_punctuation() {
        assert!(parse_chord("down").unwrap().key.extended);
        assert!(parse_chord("ctrl+delete").unwrap().key.extended);
        assert!(!parse_chord("tab").unwrap().key.extended);
        assert_eq!(parse_chord("ctrl+/").unwrap().key.vk, 0xBF);
        assert_eq!(parse_chord("ctrl+-").unwrap().key.vk, 0xBD);
        assert_eq!(parse_chord("ctrl+plus").unwrap().key.vk, 0xBB);
        assert_eq!(parse_chord("ctrl++").unwrap().key.vk, 0xBB);
        assert_eq!(parse_chord("numpad5").unwrap().key.vk, 0x65);
    }

    #[test]
    fn bare_modifier_and_errors() {
        let c = parse_chord("win").unwrap();
        assert!(c.modifiers.is_empty());
        assert_eq!(c.key.vk, VK_LWIN);
        assert!(parse_chord("").is_err());
        assert!(parse_chord("ctrl+nonsense").is_err());
        assert!(parse_chord("foo+a").is_err());
        assert!(parse_chord("f25").is_err());
    }

    #[test]
    fn sequences_and_events() {
        let seq = parse_keys("ctrl+a  ctrl+c").unwrap();
        assert_eq!(seq.len(), 2);
        let ev = chord_events(&parse_chord("ctrl+shift+s").unwrap());
        let shape: Vec<(u16, bool)> = ev.iter().map(|(k, d)| (k.vk, *d)).collect();
        assert_eq!(
            shape,
            vec![
                (VK_CONTROL, true),
                (VK_SHIFT, true),
                (b'S' as u16, true),
                (b'S' as u16, false),
                (VK_SHIFT, false),
                (VK_CONTROL, false)
            ]
        );
        assert!(parse_keys("   ").is_err());
    }
}
