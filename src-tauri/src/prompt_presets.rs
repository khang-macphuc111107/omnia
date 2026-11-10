//! Saved system-prompt presets: a small JSON list in the app data dir.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use omnia_harness::prompt::SystemPromptMode;
use serde::{Deserialize, Serialize};

use crate::error::{NativeError, NativeResult};

const FILE_NAME: &str = "agent-prompt-presets.json";
const MAX_PRESETS: usize = 100;
const MAX_NAME_CHARS: usize = 80;
const MAX_TEXT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromptPreset {
    /// Empty on first save; the store assigns one.
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub mode: SystemPromptMode,
    pub text: String,
}

pub struct PresetStore {
    file: PathBuf,
    lock: Mutex<()>,
}

fn failed(what: &str) -> NativeError {
    NativeError::new(
        "prompt_presets_failed",
        format!("Could not {what} prompt presets"),
    )
}

impl PresetStore {
    pub fn new(app_data_dir: &Path) -> Self {
        Self {
            file: app_data_dir.join(FILE_NAME),
            lock: Mutex::new(()),
        }
    }

    fn read(&self) -> Vec<PromptPreset> {
        std::fs::read(&self.file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn write(&self, presets: &[PromptPreset]) -> NativeResult<()> {
        let save = || -> std::io::Result<()> {
            if let Some(dir) = self.file.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let tmp = self.file.with_extension("json.tmp");
            std::fs::write(
                &tmp,
                serde_json::to_vec_pretty(presets).map_err(std::io::Error::other)?,
            )?;
            std::fs::rename(&tmp, &self.file)
        };
        save().map_err(|_| failed("save"))
    }

    pub fn list(&self) -> NativeResult<Vec<PromptPreset>> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        Ok(self.read())
    }

    /// Inserts, or replaces the preset with the same id; returns the full list.
    pub fn save(&self, mut preset: PromptPreset) -> NativeResult<Vec<PromptPreset>> {
        preset.name = preset.name.trim().chars().take(MAX_NAME_CHARS).collect();
        if preset.name.is_empty() {
            return Err(NativeError::invalid("name", "is empty"));
        }
        if preset.text.trim().is_empty() {
            return Err(NativeError::invalid("text", "is empty"));
        }
        if preset.text.len() > MAX_TEXT_BYTES {
            return Err(NativeError::invalid("text", "is too long"));
        }
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut presets = self.read();
        if preset.id.trim().is_empty() {
            preset.id = uuid::Uuid::new_v4().to_string();
        }
        if let Some(index) = presets.iter().position(|existing| existing.id == preset.id) {
            presets[index] = preset;
        } else if presets.len() >= MAX_PRESETS {
            return Err(NativeError::invalid("preset", "too many presets"));
        } else {
            presets.push(preset);
        }
        self.write(&presets)?;
        Ok(presets)
    }

    pub fn delete(&self, id: &str) -> NativeResult<Vec<PromptPreset>> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut presets = self.read();
        presets.retain(|preset| preset.id != id);
        self.write(&presets)?;
        Ok(presets)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preset(name: &str) -> PromptPreset {
        PromptPreset {
            id: String::new(),
            name: name.into(),
            mode: SystemPromptMode::Append,
            text: "be brief".into(),
        }
    }

    #[test]
    fn save_replace_delete_roundtrip() {
        let dir = std::env::temp_dir().join(format!("omnia-pp-{}", uuid::Uuid::new_v4()));
        let store = PresetStore::new(&dir);
        assert!(store.list().unwrap().is_empty());
        let list = store.save(preset(" Terse ")).unwrap();
        assert_eq!(list[0].name, "Terse");
        assert!(!list[0].id.is_empty());
        let mut edited = list[0].clone();
        edited.mode = SystemPromptMode::Replace;
        let list = store.save(edited).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(
            PresetStore::new(&dir).list().unwrap()[0].mode,
            SystemPromptMode::Replace
        );
        assert!(store.delete(&list[0].id).unwrap().is_empty());
    }

    #[test]
    fn rejects_blank_name_or_text() {
        let dir = std::env::temp_dir().join(format!("omnia-pp-{}", uuid::Uuid::new_v4()));
        let store = PresetStore::new(&dir);
        assert!(store.save(preset("  ")).is_err());
        let mut empty = preset("x");
        empty.text = " ".into();
        assert!(store.save(empty).is_err());
    }
}
