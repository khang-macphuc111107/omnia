import { describe, expect, it } from "vitest";

import {
  createChatTransportAdapterRegistry,
  type ChatTransportRequest,
} from "./omnia-chat-transport";

function request(protocol: ChatTransportRequest["protocol"]): ChatTransportRequest {
  return {
    schemaVersion: 1,
    requestId: "request_test_001",
    attemptId: "attempt_test_001",
    protocol,
    model: "model-test",
    instructions: [
      {
        id: "instruction-1",
        role: "system",
        content: [{ type: "input_text", text: "Be concise." }],
      },
    ],
    messages: [
      {
        id: "message-1",
        role: "user",
        content: [{ type: "input_text", text: "Hello" }],
      },
    ],
    parameters: { temperature: 0.2 },
  };
}

describe("chat transport protocol adapters", () => {
  it("resolves the built-in adapter for each renderer protocol", () => {
    const registry = createChatTransportAdapterRegistry();

    expect(registry.resolveProtocol("responses").descriptor().id).toBe("openai.responses");
    expect(registry.resolveProtocol("messages").descriptor().id).toBe("anthropic.messages");
    expect(registry.resolveProtocol("chat-completions").descriptor().id).toBe("openai.chat-completions");
    expect(registry.resolveProtocol("custom").descriptor().id).toBe("custom.declarative");
  });

  it("translates canonical messages to the OpenAI Responses input field", () => {
    const adapter = createChatTransportAdapterRegistry().resolveProtocol("responses");
    const translation = adapter.translate(request("responses"));

    expect(translation.body).toMatchObject({
      model: "model-test",
      input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
    });
    expect("messages" in translation.body).toBe(false);
    expect(translation.notes.some((note) => note.code === "responses.input")).toBe(true);
  });

  it("keeps system instructions separate for Anthropic Messages", () => {
    const adapter = createChatTransportAdapterRegistry().resolveProtocol("messages");
    const translation = adapter.translate(request("messages"));

    expect(translation.body).toMatchObject({
      model: "model-test",
      system: [{ role: "system", content: [{ type: "input_text", text: "Be concise." }] }],
      messages: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
    });
  });

  it("namespaces custom adapter input instead of pretending a wire protocol", () => {
    const adapter = createChatTransportAdapterRegistry().resolveProtocol("custom");
    const translation = adapter.translate(request("custom"));

    expect(translation.body).toHaveProperty("canonical");
    expect(translation.notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "custom.canonical", support: "native" }),
    ]));
  });
});
