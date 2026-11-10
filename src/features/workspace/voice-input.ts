/**
 * Small, browser-owned voice-input adapter for the composer.
 *
 * This module deliberately does not open a microphone by itself.  The caller
 * must create the recognizer in response to an explicit user gesture and must
 * keep the visible listening state active while recognition is running.  That
 * makes the capability usable in browser previews and Tauri webviews without
 * pretending that native microphone permission or provider-side audio upload
 * has already been implemented.
 */

export interface VoiceRecognitionAlternativeLike {
  readonly transcript: string;
  readonly confidence?: number;
}

export interface VoiceRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: VoiceRecognitionAlternativeLike | undefined;
}

export interface VoiceRecognitionResultListLike {
  readonly length: number;
  readonly [index: number]: VoiceRecognitionResultLike | undefined;
}

export interface VoiceRecognitionResultEventLike extends Event {
  readonly resultIndex: number;
  readonly results: VoiceRecognitionResultListLike;
}

export interface VoiceRecognitionErrorEventLike extends Event {
  readonly error?: string;
  readonly message?: string;
}

export interface VoiceRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: VoiceRecognitionResultEventLike) => void) | null;
  onerror: ((event: VoiceRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

export type VoiceRecognitionFactory = new () => VoiceRecognitionLike;

interface VoiceRecognitionGlobal {
  SpeechRecognition?: VoiceRecognitionFactory;
  webkitSpeechRecognition?: VoiceRecognitionFactory;
}

/**
 * Resolve the standard and WebKit-prefixed constructors without relying on
 * non-portable DOM typings.  Supplying a target keeps this function easy to
 * test and prevents server-side rendering from touching `window`.
 */
export function getSpeechRecognitionFactory(
  target: unknown = globalThis,
): VoiceRecognitionFactory | null {
  if (target === null || (typeof target !== "object" && typeof target !== "function")) {
    return null;
  }
  const scope = target as VoiceRecognitionGlobal;
  const factory = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
  return typeof factory === "function" ? factory : null;
}

/**
 * Prefer the user's browser language, then Vietnamese because Omnia's default
 * workspace locale is Vietnamese, and finally English as a stable fallback.
 */
export function resolveVoiceLanguage(target: unknown = globalThis): string {
  if (target !== null && typeof target === "object") {
    const navigatorLike = (target as { navigator?: { language?: unknown } }).navigator;
    if (typeof navigatorLike?.language === "string" && navigatorLike.language.trim()) {
      return navigatorLike.language;
    }
  }
  return "vi-VN";
}

/**
 * Create a recognizer configured for visible dictation.  Recognition remains
 * continuous so a longer explanation can be spoken; the composer still owns
 * the stop button and can abort it at any time.
 */
export function createVoiceRecognition(
  target: unknown = globalThis,
  language = resolveVoiceLanguage(target),
): VoiceRecognitionLike | null {
  const factory = getSpeechRecognitionFactory(target);
  if (!factory) return null;

  const recognition = new factory();
  recognition.lang = language;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  return recognition;
}

/**
 * Convert the complete recognition result list into one deterministic string.
 * The Web Speech API may replace interim entries in-place, so rebuilding from
 * the list avoids duplicated words when a final result arrives.
 */
export function transcriptFromSpeechResults(
  results: VoiceRecognitionResultListLike,
): string {
  const parts: string[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const alternative = result?.[0];
    if (alternative?.transcript) parts.push(alternative.transcript);
  }
  return parts.join("");
}

/**
 * Keep provider and browser errors explicit instead of hiding microphone
 * permission failures behind a generic "something went wrong" toast.
 */
export function formatVoiceRecognitionError(error: string | undefined): string {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone permission was denied. Allow microphone access, then try again.";
    case "audio-capture":
      return "No microphone input is available to the browser.";
    case "network":
      return "The browser speech service is unavailable. Check connectivity or use typed input.";
    case "aborted":
      return "Voice input was stopped.";
    case "no-speech":
      return "No speech was detected. Try speaking again.";
    default:
      return "Voice input could not start. Typed input remains available.";
  }
}

/**
 * SpeechRecognition can stop without an error event (for example after a
 * browser service timeout or a transient webview interruption). Keep that
 * boundary visible and tell the user that the draft is still recoverable.
 */
export function formatVoiceRecognitionInterruption(): string {
  return "Voice input ended unexpectedly. Your transcript was kept in the draft; try the microphone again or continue typing.";
}
