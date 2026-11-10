import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readPrefs } from "./prefs";
import {
  chunkForSpeech,
  clampRate,
  getSpeakingKey,
  maybeAutoRead,
  readVoicePrefs,
  speakMarkdown,
  stopSpeaking,
  stripMarkdownForSpeech,
  webSpeechRecognitionPresent,
  writeVoicePrefs,
} from "./voice";

function installStorage() {
  const data = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
    },
  });
}
installStorage();

class FakeUtterance {
  text: string;
  rate = 1;
  lang = "";
  voice: unknown = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

const spoken: FakeUtterance[] = [];
const synth = {
  speak: vi.fn((utterance: FakeUtterance) => void spoken.push(utterance)),
  cancel: vi.fn(() => void (spoken.length = 0)),
  getVoices: vi.fn(() => [
    { voiceURI: "vi-1", name: "An", lang: "vi-VN" },
    { voiceURI: "en-1", name: "Zira", lang: "en-US" },
  ]),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};

beforeEach(() => {
  window.localStorage.clear();
  spoken.length = 0;
  vi.clearAllMocks();
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
});
afterEach(() => {
  stopSpeaking();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "speechSynthesis");
});

describe("stripMarkdownForSpeech", () => {
  it("drops fenced code blocks, including an unterminated one", () => {
    expect(stripMarkdownForSpeech("Before\n\n```ts\nconst a = 1;\n```\n\nAfter")).toBe("Before\n\nAfter");
    expect(stripMarkdownForSpeech("Intro\n```\nnever closed\nmore")).toBe("Intro");
  });
  it("keeps inline code text, link labels and image alt text", () => {
    expect(stripMarkdownForSpeech("Run `npm test` then see [the docs](https://x.dev/a) ![chart](c.png)")).toBe(
      "Run npm test then see the docs chart",
    );
  });
  it("removes headings, list markers, quotes, emphasis and rules", () => {
    const md = "# Title\n\n- **bold** item\n- _soft_ item\n1. first\n> quoted\n\n---\n~~gone~~ stays";
    expect(stripMarkdownForSpeech(md)).toBe("Title\n\nbold item\nsoft item\nfirst\nquoted\n\ngone stays");
  });
  it("speaks bare URLs as 'link' and flattens tables", () => {
    expect(stripMarkdownForSpeech("See https://example.com/very/long?x=1 now")).toBe("See link now");
    expect(stripMarkdownForSpeech("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("a, b.\n1, 2.");
  });
  it("strips html tags and comments", () => {
    expect(stripMarkdownForSpeech("<b>hi</b><!-- hidden --> there")).toBe("hi there");
  });
  it("returns empty for code-only messages", () => {
    expect(stripMarkdownForSpeech("```\nonly code\n```")).toBe("");
  });
});

describe("chunkForSpeech", () => {
  it("splits at sentences and respects the limit", () => {
    const chunks = chunkForSpeech("One. Two! Three? " + "word ".repeat(80), 60);
    expect(chunks.every((chunk) => chunk.length <= 60)).toBe(true);
    expect(chunks[0]).toBe("One. Two! Three?");
  });
  it("keeps paragraphs apart", () => {
    expect(chunkForSpeech("First para.\n\nSecond para.")).toEqual(["First para.", "Second para."]);
  });
});

describe("voice preferences", () => {
  it("defaults and clamps", () => {
    expect(readVoicePrefs()).toEqual({ language: "", voiceURI: "", rate: 1, autoRead: false });
    expect(clampRate(9)).toBe(2);
    expect(clampRate(0)).toBe(0.5);
    expect(clampRate("x")).toBe(1);
  });
  it("persists in the shared agent prefs without disturbing other keys", () => {
    window.localStorage.setItem("omnia.agent.prefs.v1", JSON.stringify({ recentFolders: ["C:\\a"], notifyOnFinish: false }));
    writeVoicePrefs({ language: "vi-VN", voiceURI: "vi-1", rate: 1.46, autoRead: true });
    expect(readVoicePrefs()).toEqual({ language: "vi-VN", voiceURI: "vi-1", rate: 1.5, autoRead: true });
    expect(readPrefs()).toMatchObject({ recentFolders: ["C:\\a"], notifyOnFinish: false, speechRate: 1.5, autoRead: true });
  });
});

describe("speakMarkdown", () => {
  it("speaks stripped text with the saved voice and rate, and tracks speaking", () => {
    writeVoicePrefs({ voiceURI: "vi-1", rate: 1.2 });
    expect(speakMarkdown("**Xin chào.**\n\n```\nsecret code\n```", "k1")).toBe(true);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.text).toBe("Xin chào.");
    expect(spoken[0]?.rate).toBe(1.2);
    expect(spoken[0]?.lang).toBe("vi-VN");
    expect(getSpeakingKey()).toBe("k1");
    spoken[0]?.onend?.();
    expect(getSpeakingKey()).toBeNull();
  });
  it("refuses code-only text and cancels on stop", () => {
    expect(speakMarkdown("```\nx\n```", "k2")).toBe(false);
    expect(getSpeakingKey()).toBeNull();
    speakMarkdown("Hello there.", "k3");
    stopSpeaking();
    expect(synth.cancel).toHaveBeenCalled();
    expect(getSpeakingKey()).toBeNull();
  });
  it("a cancelled earlier reading cannot clear a newer one", () => {
    speakMarkdown("First.", "a");
    const first = spoken[0];
    speakMarkdown("Second.", "b");
    first?.onerror?.();
    expect(getSpeakingKey()).toBe("b");
  });
  it("auto-read only fires when enabled", () => {
    maybeAutoRead("Hello.", "s:1");
    expect(synth.speak).not.toHaveBeenCalled();
    writeVoicePrefs({ autoRead: true });
    maybeAutoRead("Hello.", "s:1");
    expect(synth.speak).toHaveBeenCalledTimes(1);
  });
});

describe("dictation engine", () => {
  it("reports whether the online Web Speech API exists (it is never used for dictation)", () => {
    expect(webSpeechRecognitionPresent()).toBe(false);
    vi.stubGlobal("webkitSpeechRecognition", class {});
    expect(webSpeechRecognitionPresent()).toBe(true);
  });
});
