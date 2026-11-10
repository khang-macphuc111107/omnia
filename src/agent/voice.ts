import { readPrefs, writePrefs } from "./prefs";

/**
 * Voice support: read-aloud via the on-device `speechSynthesis` voices of WebView2.
 *
 * Dictation never uses the Web Speech API (`webkitSpeechRecognition`): WebView2/Chromium
 * streams that audio to an online service. Dictation goes through the native
 * Windows.Media.SpeechRecognition bridge instead (see src-tauri/src/voice.rs).
 */

export const SPEECH_RATE_MIN = 0.5;
export const SPEECH_RATE_MAX = 2;
export const SPEECH_RATE_STEP = 0.1;
export const SPEECH_CHUNK_MAX = 240;

export interface VoicePrefs {
  /** BCP-47 dictation language; "" follows the Windows speech language. */
  language: string;
  /** `SpeechSynthesisVoice.voiceURI`; "" uses the system default voice. */
  voiceURI: string;
  rate: number;
  autoRead: boolean;
}

/** Mirrors `VoiceStatus` in src-tauri/src/voice.rs. */
export interface VoiceStatus {
  supported: boolean;
  available: boolean;
  languages: { tag: string; name: string }[];
  systemLanguage: string | null;
  micPermission: "allowed" | "denied" | "unknown";
  speechPrivacyAccepted: boolean | null;
  listening: boolean;
}

/** Payload of the `omnia-voice` event. `code` is set on errors. */
export interface VoiceEventPayload {
  kind: "partial" | "final" | "error" | "ended";
  text: string;
  code?: string;
}

export type VoiceSettingsTarget = "speech" | "microphone";

export function clampRate(value: unknown): number {
  const rate = typeof value === "number" && Number.isFinite(value) ? value : 1;
  return Math.round(Math.min(SPEECH_RATE_MAX, Math.max(SPEECH_RATE_MIN, rate)) * 10) / 10;
}

export function readVoicePrefs(): VoicePrefs {
  const prefs = readPrefs();
  return {
    language: typeof prefs.voiceLanguage === "string" ? prefs.voiceLanguage : "",
    voiceURI: typeof prefs.speechVoiceURI === "string" ? prefs.speechVoiceURI : "",
    rate: clampRate(prefs.speechRate),
    autoRead: prefs.autoRead === true,
  };
}

export function writeVoicePrefs(patch: Partial<VoicePrefs>): VoicePrefs {
  const next = { ...readVoicePrefs(), ...patch, ...("rate" in patch ? { rate: clampRate(patch.rate) } : {}) };
  writePrefs({
    voiceLanguage: next.language,
    speechVoiceURI: next.voiceURI,
    speechRate: next.rate,
    autoRead: next.autoRead,
  });
  return next;
}

/** Reduce assistant markdown to plain prose: code, tables and link targets are not read out. */
export function stripMarkdownForSpeech(markdown: string): string {
  let text = markdown.replace(/\r\n?/g, "\n");
  // Fenced code blocks (``` or ~~~), including an unterminated trailing one.
  text = text.replace(/^[ \t]*(\x60{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[\x60~]*[ \t]*(?=\n|(?![\s\S]))|(?![\s\S]))/gm, "\n");
  // HTML comments and tags.
  text = text.replace(/<!--[\s\S]*?-->/g, " ").replace(/<\/?[a-zA-Z][^>]*>/g, " ");
  // Images keep their alt text; links keep their label.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  text = text.replace(/^[ \t]*\[[^\]]+\]:\s+\S+.*$/gm, "");
  // Bare URLs are noise when spoken.
  text = text.replace(/\bhttps?:\/\/\S+/g, "link");
  // Tables: drop separator rows, turn pipes into pauses.
  text = text.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*(?:\n|(?![\s\S]))/gm, "");
  text = text.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_m, row: string) => row.split("|").map((cell) => cell.trim()).filter(Boolean).join(", ") + ".");
  // Block markers.
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  text = text.replace(/^[ \t]*>+[ \t]?/gm, "");
  text = text.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "");
  text = text.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "");
  // Inline emphasis and code.
  text = text.replace(/`+([^`\n]+)`+/g, "$1");
  text = text.replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, "$2").replace(/~~(.+?)~~/g, "$1");
  text = text.replace(/[`*]+/g, "");
  // Whitespace: paragraphs become pauses.
  text = text.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{2,}/g, "\n\n");
  return text.trim();
}

/** Split into utterance-sized pieces at sentence/paragraph boundaries (long utterances stall in Chromium). */
export function chunkForSpeech(text: string, max = SPEECH_CHUNK_MAX): string[] {
  const chunks: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    const sentences = paragraph.match(/[^.!?。！？]+[.!?。！？]*\s*/g) ?? [paragraph];
    let current = "";
    for (const raw of sentences) {
      let sentence = raw.trim();
      if (!sentence) continue;
      while (sentence.length > max) {
        const cut = sentence.lastIndexOf(" ", max);
        const at = cut > max / 2 ? cut : max;
        if (current) {
          chunks.push(current);
          current = "";
        }
        chunks.push(sentence.slice(0, at).trim());
        sentence = sentence.slice(at).trim();
      }
      if (current && current.length + sentence.length + 1 > max) {
        chunks.push(current);
        current = sentence;
      } else {
        current = current ? `${current} ${sentence}` : sentence;
      }
    }
    if (current) chunks.push(current);
  }
  return chunks.filter(Boolean);
}

export function speechSynthesisAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

/** Dictation must stay on the native bridge; this exists so the rule is testable and documented. */
export function webSpeechRecognitionPresent(): boolean {
  return typeof window !== "undefined" && ("webkitSpeechRecognition" in window || "SpeechRecognition" in window);
}

type Listener = () => void;
let speakingKey: string | null = null;
let generation = 0;
const listeners = new Set<Listener>();

function setSpeaking(key: string | null) {
  speakingKey = key;
  for (const listener of [...listeners]) listener();
}

/** Subscribe to speaking changes (for `useSyncExternalStore`). */
export function subscribeSpeaking(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The key passed to the active `speak`, or null when idle. */
export function getSpeakingKey(): string | null {
  return speakingKey;
}

export function stopSpeaking(): void {
  generation += 1;
  try {
    if (speechSynthesisAvailable()) window.speechSynthesis.cancel();
  } catch {
    /* ignore */
  }
  setSpeaking(null);
}

export function listVoices(): SpeechSynthesisVoice[] {
  try {
    return speechSynthesisAvailable() ? window.speechSynthesis.getVoices() : [];
  } catch {
    return [];
  }
}

/** Voices load asynchronously in Chromium; call back when the list changes. */
export function onVoicesChanged(callback: () => void): () => void {
  if (!speechSynthesisAvailable()) return () => undefined;
  const synth = window.speechSynthesis;
  synth.addEventListener?.("voiceschanged", callback);
  return () => synth.removeEventListener?.("voiceschanged", callback);
}

/**
 * Read markdown aloud with the saved voice and rate. Returns false when nothing speakable
 * remains or speech is unavailable. Starting a new reading cancels the previous one.
 */
export function speakMarkdown(markdown: string, key: string, prefs: VoicePrefs = readVoicePrefs()): boolean {
  if (!speechSynthesisAvailable()) return false;
  const chunks = chunkForSpeech(stripMarkdownForSpeech(markdown));
  stopSpeaking();
  if (chunks.length === 0) return false;
  const mine = generation;
  const synth = window.speechSynthesis;
  const voice = prefs.voiceURI ? listVoices().find((entry) => entry.voiceURI === prefs.voiceURI) : undefined;
  setSpeaking(key);
  chunks.forEach((chunk, index) => {
    const utterance = new SpeechSynthesisUtterance(chunk);
    utterance.rate = prefs.rate;
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    const finish = () => {
      if (generation === mine && index === chunks.length - 1) setSpeaking(null);
    };
    utterance.onend = finish;
    utterance.onerror = () => {
      // A cancel() fires `error` on the cut-off utterance; only a still-current reading ends here.
      if (generation === mine) {
        generation += 1;
        setSpeaking(null);
      }
    };
    synth.speak(utterance);
  });
  return true;
}

/** Auto-read the final assistant text of a finished run, when the user opted in. */
export function maybeAutoRead(markdown: string | null, key: string): void {
  try {
    if (!markdown || !readVoicePrefs().autoRead) return;
    speakMarkdown(markdown, key);
  } catch {
    /* best effort */
  }
}
