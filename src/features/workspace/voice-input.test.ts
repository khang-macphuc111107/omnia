import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createVoiceRecognition,
  formatVoiceRecognitionError,
  formatVoiceRecognitionInterruption,
  getSpeechRecognitionFactory,
  resolveVoiceLanguage,
  transcriptFromSpeechResults,
  type VoiceRecognitionLike,
  type VoiceRecognitionResultListLike,
} from "./voice-input";

class FakeRecognition implements VoiceRecognitionLike {
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  onstart: (() => void) | null = null;
  onresult: VoiceRecognitionLike["onresult"] = null;
  onerror: VoiceRecognitionLike["onerror"] = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
}

afterEach(() => {
  delete (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition;
  delete (globalThis as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  vi.restoreAllMocks();
});

describe("voice input adapter", () => {
  it("prefers the standard recognition constructor and configures visible dictation", () => {
    (globalThis as { SpeechRecognition?: typeof FakeRecognition }).SpeechRecognition = FakeRecognition;

    expect(getSpeechRecognitionFactory()).toBe(FakeRecognition);
    const recognition = createVoiceRecognition(globalThis, "en-US");

    expect(recognition).not.toBeNull();
    expect(recognition).toMatchObject({
      lang: "en-US",
      continuous: true,
      interimResults: true,
      maxAlternatives: 1,
    });
  });

  it("falls back to WebKit recognition and navigator language", () => {
    const target = {
      webkitSpeechRecognition: FakeRecognition,
      navigator: { language: "vi-VN" },
    };

    expect(getSpeechRecognitionFactory(target)).toBe(FakeRecognition);
    expect(resolveVoiceLanguage(target)).toBe("vi-VN");
    expect(createVoiceRecognition(target)).toMatchObject({ lang: "vi-VN" });
  });

  it("returns null when the browser has no speech recognition API", () => {
    expect(getSpeechRecognitionFactory({})).toBeNull();
    expect(createVoiceRecognition({})).toBeNull();
  });

  it("rebuilds the transcript from final and interim result entries", () => {
    const results = [
      { isFinal: true, length: 1, 0: { transcript: "Xin chào " } },
      { isFinal: false, length: 1, 0: { transcript: "Omnia" } },
    ] as unknown as VoiceRecognitionResultListLike;

    expect(transcriptFromSpeechResults(results)).toBe("Xin chào Omnia");
  });

  it("maps permission and capture failures to actionable messages", () => {
    expect(formatVoiceRecognitionError("not-allowed")).toMatch(/permission was denied/i);
    expect(formatVoiceRecognitionError("audio-capture")).toMatch(/microphone input/i);
    expect(formatVoiceRecognitionError("unknown-error")).toMatch(/Typed input remains available/i);
  });

  it("makes an unexpected recognition end recoverable", () => {
    expect(formatVoiceRecognitionInterruption()).toMatch(/transcript was kept in the draft/i);
    expect(formatVoiceRecognitionInterruption()).toMatch(/try the microphone again/i);
  });
});
