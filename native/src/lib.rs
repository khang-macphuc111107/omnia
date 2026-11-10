//! UI projection only. Durable sessions and provider authority remain in the
//! existing Rust services; this shell must not invent a second database.
pub mod session_form;
pub mod sessions;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Mode {
    #[default]
    Chat,
    Browser,
    Ide,
}

impl Mode {
    pub fn from_command(id: u16) -> Option<Self> {
        match id {
            101 => Some(Self::Chat),
            102 => Some(Self::Browser),
            103 => Some(Self::Ide),
            _ => None,
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            Self::Chat => "Chat / No project\n\nNative scratch workspace. Session metadata is managed in the native session panel. Provider delivery is not connected; this draft is not persisted.",
            Self::Browser => "Browser\n\nNo browser engine is running. Native browser tabs, navigation and permissions are pending service integration.\n\nYour chat draft remains available below.",
            Self::Ide => "IDE\n\nNative editor service integration is pending. No files are opened or changed by this shell.\n\nYour chat draft remains available below.",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_projectless_chat_projection() {
        assert_eq!(Mode::default(), Mode::Chat);
        assert!(Mode::default().description().contains("No project"));
    }

    #[test]
    fn command_routing_rejects_unknown_commands() {
        assert_eq!(Mode::from_command(101), Some(Mode::Chat));
        assert_eq!(Mode::from_command(102), Some(Mode::Browser));
        assert_eq!(Mode::from_command(103), Some(Mode::Ide));
        assert_eq!(Mode::from_command(0), None);
        assert_eq!(Mode::from_command(u16::MAX), None);
    }
}
