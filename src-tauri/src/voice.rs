//! On-device dictation for the composer via Windows.Media.SpeechRecognition.
//!
//! Commands: `voice_status`, `voice_start`, `voice_stop`, `voice_open_settings`.
//! Recognition progress is emitted to the renderer as `omnia-voice` events
//! (`partial`, `final`, `error`, `ended`).
//!
//! Privacy note: this is the OS recognizer, not the WebView2 Web Speech API
//! (`webkitSpeechRecognition`), which streams audio to an online service and is
//! deliberately never used. The Windows dictation topic constraint itself can
//! use Microsoft's online speech service when the Windows setting "Online speech
//! recognition" is on; that setting is also what the HRESULT 0x80045509 error
//! refers to. Omnia cannot force the recognizer offline and says so in the UI.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;

use crate::error::{NativeError, NativeResult};

pub const VOICE_EVENT: &str = "omnia-voice";

/// HRESULT: the user has not accepted the Windows online speech privacy policy.
pub const HRESULT_SPEECH_PRIVACY_DECLINED: u32 = 0x8004_5509;
/// HRESULT: E_ACCESSDENIED (microphone blocked by the privacy settings).
pub const HRESULT_ACCESS_DENIED: u32 = 0x8007_0005;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VoiceEventKind {
    Partial,
    Final,
    Error,
    Ended,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VoiceEvent {
    pub kind: VoiceEventKind,
    pub text: String,
    /// Machine-readable failure code for `error` events (drives the settings button).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'static str>,
}

impl VoiceEvent {
    pub fn partial(text: impl Into<String>) -> Self {
        Self {
            kind: VoiceEventKind::Partial,
            text: text.into(),
            code: None,
        }
    }
    pub fn final_text(text: impl Into<String>) -> Self {
        Self {
            kind: VoiceEventKind::Final,
            text: text.into(),
            code: None,
        }
    }
    pub fn ended() -> Self {
        Self {
            kind: VoiceEventKind::Ended,
            text: String::new(),
            code: None,
        }
    }
    pub fn error(failure: &VoiceFailure) -> Self {
        Self {
            kind: VoiceEventKind::Error,
            text: failure.message.clone(),
            code: Some(failure.code),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceFailure {
    pub code: &'static str,
    pub message: String,
}

impl VoiceFailure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// Map a WinRT/COM HRESULT to a user-facing failure.
pub fn map_hresult(hresult: i32) -> VoiceFailure {
    match hresult as u32 {
        HRESULT_SPEECH_PRIVACY_DECLINED => VoiceFailure::new(
            "speech_privacy_declined",
            "Windows speech recognition is turned off. Turn on \"Online speech recognition\" in Settings > Privacy & security > Speech, then try again.",
        ),
        HRESULT_ACCESS_DENIED => VoiceFailure::new(
            "microphone_denied",
            "Microphone access is blocked. Allow microphone access for desktop apps in Settings > Privacy & security > Microphone, then try again.",
        ),
        other => VoiceFailure::new(
            "recognizer_failed",
            format!("The speech recognizer failed (0x{other:08X})."),
        ),
    }
}

/// Map a `SpeechRecognitionResultStatus` value reported when a continuous
/// session completes. `None` means a normal end (success, user stop, idle timeout).
pub fn status_failure(status: i32) -> Option<VoiceFailure> {
    let (code, message) = match status {
        0 | 5 | 7 | 8 => return None,
        1 => ("language_unsupported", "Dictation is not supported for this language. Pick another language in Settings > Voice."),
        2 | 3 => ("recognizer_failed", "The speech recognizer could not be set up."),
        4 => ("audio_quality", "The audio quality was too low to recognise speech."),
        9 => ("network_failure", "Speech recognition needs a network connection for this language."),
        10 => ("microphone_unavailable", "No microphone is available. Connect one and check Settings > Privacy & security > Microphone."),
        _ => ("recognizer_failed", "The speech recognizer stopped unexpectedly."),
    };
    Some(VoiceFailure::new(code, message))
}

/// Validate a BCP-47 style tag (`en-US`, `vi`, `zh-Hans-CN`) before it reaches WinRT.
pub fn validate_language_tag(tag: &str) -> Result<String, String> {
    let tag = tag.trim();
    if tag.is_empty() || tag.len() > 35 {
        return Err("language tag must be 1-35 characters".into());
    }
    let invalid = || format!("\"{tag}\" is not a valid language tag (expected e.g. en-US)");
    let mut parts = tag.split('-');
    let primary = parts.next().unwrap_or_default();
    if !matches!(primary.len(), 2 | 3) || !primary.chars().all(|c| c.is_ascii_alphabetic()) {
        return Err(invalid());
    }
    for part in parts {
        if !(1..=8).contains(&part.len()) || !part.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(invalid());
        }
    }
    Ok(tag.to_string())
}

/// Only these two Windows settings pages may be opened from the renderer.
pub fn settings_uri(target: &str) -> Option<&'static str> {
    match target {
        "speech" => Some("ms-settings:privacy-speech"),
        "microphone" => Some("ms-settings:privacy-microphone"),
        _ => None,
    }
}

/// Combine the per-user and desktop-app (`NonPackaged`) microphone consent values.
pub fn combine_microphone_consent(user: Option<&str>, desktop: Option<&str>) -> &'static str {
    let is = |value: Option<&str>, want: &str| value.is_some_and(|v| v.eq_ignore_ascii_case(want));
    if is(user, "Deny") || is(desktop, "Deny") {
        "denied"
    } else if is(user, "Allow") && (desktop.is_none() || is(desktop, "Allow")) {
        "allowed"
    } else {
        "unknown"
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VoiceLanguage {
    pub tag: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    /// The OS exposes a speech recognizer to this build.
    pub supported: bool,
    /// Supported and at least one dictation language is available.
    pub available: bool,
    pub languages: Vec<VoiceLanguage>,
    pub system_language: Option<String>,
    /// `allowed`, `denied` or `unknown` (not detectable).
    pub mic_permission: &'static str,
    /// Windows "Online speech recognition" accepted; `None` when not detectable.
    pub speech_privacy_accepted: Option<bool>,
    pub listening: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceStartRequest {
    #[serde(default)]
    pub language: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceOpenSettingsRequest {
    pub target: String,
}

fn emit(app: &AppHandle, event: &VoiceEvent) {
    let _ = app.emit(VOICE_EVENT, event);
}

#[tauri::command]
pub async fn voice_status() -> NativeResult<VoiceStatus> {
    tauri::async_runtime::spawn_blocking(status_blocking)
        .await
        .map_err(|_| NativeError::new("voice_failed", "Voice status check was interrupted."))
}

#[tauri::command]
pub async fn voice_start(app: AppHandle, request: VoiceStartRequest) -> NativeResult<()> {
    let language = match request
        .language
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty())
    {
        Some(tag) => Some(
            validate_language_tag(tag)
                .map_err(|reason| NativeError::invalid("language", reason))?,
        ),
        None => None,
    };
    let result = tauri::async_runtime::spawn_blocking(move || platform::start(app, language))
        .await
        .map_err(|_| NativeError::new("voice_failed", "Voice start was interrupted."))?;
    result.map_err(|failure| native_error(&failure))
}

#[tauri::command]
pub async fn voice_stop(app: AppHandle) -> NativeResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        platform::stop();
        emit(&app, &VoiceEvent::ended());
    })
    .await
    .map_err(|_| NativeError::new("voice_failed", "Voice stop was interrupted."))
}

#[tauri::command]
pub fn voice_open_settings(app: AppHandle, request: VoiceOpenSettingsRequest) -> NativeResult<()> {
    let uri = settings_uri(&request.target)
        .ok_or_else(|| NativeError::invalid("target", "must be \"speech\" or \"microphone\""))?;
    app.opener().open_url(uri, None::<&str>).map_err(|_| {
        NativeError::new(
            "voice_settings_failed",
            "Windows settings could not be opened.",
        )
    })
}

fn native_error(failure: &VoiceFailure) -> NativeError {
    let code: &'static str = match failure.code {
        "speech_privacy_declined" => "voice_speech_privacy_declined",
        "microphone_denied" => "voice_microphone_denied",
        "language_unsupported" => "voice_language_unsupported",
        "already_listening" => "voice_already_listening",
        "unsupported" => "voice_unsupported",
        _ => "voice_failed",
    };
    NativeError::new(code, failure.message.clone())
}

/// Blocking status probe; also the native-test entry point (needs no microphone).
pub fn status_blocking() -> VoiceStatus {
    platform::status()
}

#[cfg(windows)]
mod platform {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;

    use windows::core::{Interface, HSTRING, PCWSTR};
    use windows::Foundation::TypedEventHandler;
    use windows::Globalization::Language;
    use windows::Media::SpeechRecognition::{
        ISpeechRecognitionConstraint, SpeechContinuousRecognitionCompletedEventArgs,
        SpeechContinuousRecognitionResultGeneratedEventArgs, SpeechContinuousRecognitionSession,
        SpeechRecognitionHypothesisGeneratedEventArgs, SpeechRecognitionResultStatus,
        SpeechRecognitionScenario, SpeechRecognitionTopicConstraint, SpeechRecognizer,
    };
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
    };

    use super::*;

    struct Active {
        recognizer: SpeechRecognizer,
        session: SpeechContinuousRecognitionSession,
    }

    static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);
    /// Generation of the live session; handlers of a replaced/stopped one go quiet.
    static GENERATION: AtomicU64 = AtomicU64::new(0);

    fn init_com() {
        // WinRT needs an apartment; tolerate a thread that already has one.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }

    fn lock() -> std::sync::MutexGuard<'static, Option<Active>> {
        ACTIVE.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn registry_string(subkey: &str, name: &str) -> Option<String> {
        let (subkey, name) = (wide(subkey), wide(name));
        let mut buffer = [0u16; 64];
        let mut size = std::mem::size_of_val(&buffer) as u32;
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                PCWSTR(subkey.as_ptr()),
                PCWSTR(name.as_ptr()),
                RRF_RT_REG_SZ,
                None,
                Some(buffer.as_mut_ptr().cast()),
                Some(&mut size),
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let units = (size as usize / 2).min(buffer.len());
        Some(
            String::from_utf16_lossy(&buffer[..units])
                .trim_end_matches('\0')
                .to_string(),
        )
    }

    fn registry_dword(subkey: &str, name: &str) -> Option<u32> {
        let (subkey, name) = (wide(subkey), wide(name));
        let mut value = 0u32;
        let mut size = 4u32;
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                PCWSTR(subkey.as_ptr()),
                PCWSTR(name.as_ptr()),
                RRF_RT_REG_DWORD,
                None,
                Some((&mut value as *mut u32).cast()),
                Some(&mut size),
            )
        };
        (status == ERROR_SUCCESS).then_some(value)
    }

    pub fn status() -> VoiceStatus {
        init_com();
        let mut languages = Vec::new();
        if let Ok(list) = SpeechRecognizer::SupportedTopicLanguages() {
            for language in list {
                let tag = language
                    .LanguageTag()
                    .map(|t| t.to_string())
                    .unwrap_or_default();
                if tag.is_empty() {
                    continue;
                }
                let name = language
                    .DisplayName()
                    .map(|n| n.to_string())
                    .ok()
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| tag.clone());
                languages.push(VoiceLanguage { tag, name });
            }
        }
        let system_language = SpeechRecognizer::SystemSpeechLanguage()
            .ok()
            .and_then(|l| l.LanguageTag().ok())
            .map(|t| t.to_string())
            .filter(|t| !t.is_empty());
        const MIC: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
        let user = registry_string(MIC, "Value");
        let desktop = registry_string(&format!(r"{MIC}\NonPackaged"), "Value");
        let speech_privacy_accepted = registry_dword(
            r"Software\Microsoft\Speech_OneCore\Settings\OnlineSpeechPrivacy",
            "HasAccepted",
        )
        .map(|v| v != 0);
        VoiceStatus {
            supported: true,
            available: !languages.is_empty(),
            languages,
            system_language,
            mic_permission: combine_microphone_consent(user.as_deref(), desktop.as_deref()),
            speech_privacy_accepted,
            listening: lock().is_some(),
        }
    }

    fn fail(error: &windows::core::Error) -> VoiceFailure {
        map_hresult(error.code().0)
    }

    pub fn start(app: AppHandle, language: Option<String>) -> Result<(), VoiceFailure> {
        init_com();
        if lock().is_some() {
            return Err(VoiceFailure::new(
                "already_listening",
                "Dictation is already running.",
            ));
        }
        let recognizer = match language {
            Some(tag) => {
                let lang =
                    Language::CreateLanguage(&HSTRING::from(tag.as_str())).map_err(|_| {
                        VoiceFailure::new(
                            "language_unsupported",
                            format!("\"{tag}\" is not a valid language tag."),
                        )
                    })?;
                SpeechRecognizer::Create(&lang).map_err(|_| {
                    VoiceFailure::new(
                        "language_unsupported",
                        format!("Dictation is not available for \"{tag}\". Install its speech pack in Windows language settings."),
                    )
                })?
            }
            None => SpeechRecognizer::new().map_err(|e| fail(&e))?,
        };
        let constraint = SpeechRecognitionTopicConstraint::Create(
            SpeechRecognitionScenario::Dictation,
            &HSTRING::from("dictation"),
        )
        .map_err(|e| fail(&e))?;
        let constraint: ISpeechRecognitionConstraint = constraint.cast().map_err(|e| fail(&e))?;
        recognizer
            .Constraints()
            .and_then(|c| c.Append(&constraint))
            .map_err(|e| fail(&e))?;
        let compiled = recognizer
            .CompileConstraintsAsync()
            .and_then(|op| op.get())
            .map_err(|e| fail(&e))?;
        let status = compiled.Status().map_err(|e| fail(&e))?;
        if status != SpeechRecognitionResultStatus::Success {
            return Err(status_failure(status.0).unwrap_or_else(|| {
                VoiceFailure::new(
                    "recognizer_failed",
                    "The speech recognizer could not be set up.",
                )
            }));
        }

        let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        let live = move || GENERATION.load(Ordering::SeqCst) == generation;

        let hypothesis_app = app.clone();
        recognizer
            .HypothesisGenerated(&TypedEventHandler::<
                SpeechRecognizer,
                SpeechRecognitionHypothesisGeneratedEventArgs,
            >::new(move |_, args| {
                if let (true, Some(args)) = (live(), args.as_ref()) {
                    let text = args.Hypothesis()?.Text()?.to_string();
                    if !text.trim().is_empty() {
                        emit(&hypothesis_app, &VoiceEvent::partial(text));
                    }
                }
                Ok(())
            }))
            .map_err(|e| fail(&e))?;

        let session = recognizer
            .ContinuousRecognitionSession()
            .map_err(|e| fail(&e))?;
        let result_app = app.clone();
        session
            .ResultGenerated(&TypedEventHandler::<
                SpeechContinuousRecognitionSession,
                SpeechContinuousRecognitionResultGeneratedEventArgs,
            >::new(move |_, args| {
                if let (true, Some(args)) = (live(), args.as_ref()) {
                    let result = args.Result()?;
                    // Rejected (3) results are noise the engine itself discarded.
                    let rejected = result.Confidence().map(|c| c.0 == 3).unwrap_or(false);
                    let text = result.Text()?.to_string();
                    if !rejected && !text.trim().is_empty() {
                        emit(&result_app, &VoiceEvent::final_text(text));
                    }
                }
                Ok(())
            }))
            .map_err(|e| fail(&e))?;
        let done_app = app.clone();
        session
            .Completed(&TypedEventHandler::<
                SpeechContinuousRecognitionSession,
                SpeechContinuousRecognitionCompletedEventArgs,
            >::new(move |_, args| {
                if live() {
                    let failure = args
                        .as_ref()
                        .and_then(|a| a.Status().ok())
                        .and_then(|s| status_failure(s.0));
                    if let Some(failure) = failure {
                        emit(&done_app, &VoiceEvent::error(&failure));
                    }
                    // Retire this session before telling the UI it ended.
                    GENERATION.fetch_add(1, Ordering::SeqCst);
                    lock().take();
                    emit(&done_app, &VoiceEvent::ended());
                }
                Ok(())
            }))
            .map_err(|e| fail(&e))?;

        session
            .StartAsync()
            .and_then(|op| op.get())
            .map_err(|e| fail(&e))?;
        *lock() = Some(Active {
            recognizer,
            session,
        });
        Ok(())
    }

    pub fn stop() {
        init_com();
        // Silence handlers first so a late result cannot arrive after `ended`.
        GENERATION.fetch_add(1, Ordering::SeqCst);
        let active = lock().take();
        if let Some(active) = active {
            let _ = active.session.StopAsync().and_then(|op| op.get());
            let _ = active.recognizer.Close();
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;

    pub fn status() -> VoiceStatus {
        VoiceStatus {
            supported: false,
            available: false,
            languages: Vec::new(),
            system_language: None,
            mic_permission: "unknown",
            speech_privacy_accepted: None,
            listening: false,
        }
    }

    pub fn start(_app: AppHandle, _language: Option<String>) -> Result<(), VoiceFailure> {
        Err(VoiceFailure::new(
            "unsupported",
            "Dictation is only available on Windows.",
        ))
    }

    pub fn stop() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_tags_are_validated() {
        for ok in ["en-US", "vi", "zh-Hans-CN", " ja ", "fil-PH"] {
            assert!(validate_language_tag(ok).is_ok(), "{ok}");
        }
        assert_eq!(validate_language_tag(" en-GB ").unwrap(), "en-GB");
        for bad in [
            "",
            "e",
            "english",
            "en_US",
            "en--US",
            "en-",
            "12",
            "en-US-toolongsubtag",
            "en US",
            "../x",
        ] {
            assert!(validate_language_tag(bad).is_err(), "{bad}");
        }
        assert!(validate_language_tag(&"a".repeat(40)).is_err());
    }

    #[test]
    fn hresults_map_to_actionable_failures() {
        let privacy = map_hresult(0x8004_5509u32 as i32);
        assert_eq!(privacy.code, "speech_privacy_declined");
        assert!(privacy.message.contains("Online speech recognition"));
        assert_eq!(map_hresult(0x8007_0005u32 as i32).code, "microphone_denied");
        let other = map_hresult(0x8000_4005u32 as i32);
        assert_eq!(other.code, "recognizer_failed");
        assert!(other.message.contains("0x80004005"));
    }

    #[test]
    fn completion_statuses_distinguish_failures_from_normal_ends() {
        for normal in [0, 5, 7, 8] {
            assert!(status_failure(normal).is_none(), "{normal}");
        }
        assert_eq!(status_failure(1).unwrap().code, "language_unsupported");
        assert_eq!(status_failure(10).unwrap().code, "microphone_unavailable");
        assert_eq!(status_failure(99).unwrap().code, "recognizer_failed");
    }

    #[test]
    fn event_payloads_serialize_for_the_renderer() {
        let partial = serde_json::to_value(VoiceEvent::partial("hello wor")).unwrap();
        assert_eq!(
            partial,
            serde_json::json!({"kind": "partial", "text": "hello wor"})
        );
        let fin = serde_json::to_value(VoiceEvent::final_text("hello world")).unwrap();
        assert_eq!(
            fin,
            serde_json::json!({"kind": "final", "text": "hello world"})
        );
        assert_eq!(
            serde_json::to_value(VoiceEvent::ended()).unwrap(),
            serde_json::json!({"kind": "ended", "text": ""})
        );
        let error =
            serde_json::to_value(VoiceEvent::error(&map_hresult(0x8004_5509u32 as i32))).unwrap();
        assert_eq!(error["kind"], "error");
        assert_eq!(error["code"], "speech_privacy_declined");
    }

    #[test]
    fn only_privacy_pages_can_be_opened() {
        assert_eq!(settings_uri("speech"), Some("ms-settings:privacy-speech"));
        assert_eq!(
            settings_uri("microphone"),
            Some("ms-settings:privacy-microphone")
        );
        assert_eq!(settings_uri("https://example.com"), None);
        assert_eq!(settings_uri(""), None);
    }

    #[test]
    fn microphone_consent_combines_user_and_desktop_values() {
        assert_eq!(
            combine_microphone_consent(Some("Allow"), Some("Allow")),
            "allowed"
        );
        assert_eq!(combine_microphone_consent(Some("Allow"), None), "allowed");
        assert_eq!(
            combine_microphone_consent(Some("Allow"), Some("Deny")),
            "denied"
        );
        assert_eq!(
            combine_microphone_consent(Some("Deny"), Some("Allow")),
            "denied"
        );
        assert_eq!(combine_microphone_consent(None, None), "unknown");
        assert_eq!(combine_microphone_consent(Some("Prompt"), None), "unknown");
    }

    #[test]
    fn start_request_rejects_unknown_fields() {
        assert!(serde_json::from_str::<VoiceStartRequest>(r#"{"language":"en-US"}"#).is_ok());
        assert!(serde_json::from_str::<VoiceStartRequest>("{}").is_ok());
        assert!(serde_json::from_str::<VoiceStartRequest>(r#"{"x":1}"#).is_err());
    }

    /// Needs no microphone: the probe must return a well-formed status without panicking.
    #[test]
    fn status_probe_is_well_formed() {
        let status = status_blocking();
        assert!(["allowed", "denied", "unknown"].contains(&status.mic_permission));
        assert_eq!(
            status.available,
            status.supported && !status.languages.is_empty()
        );
        assert!(!status.listening);
        for language in &status.languages {
            assert!(
                validate_language_tag(&language.tag).is_ok(),
                "{}",
                language.tag
            );
            assert!(!language.name.is_empty());
        }
        serde_json::to_value(&status).expect("status serializes");
    }
}
