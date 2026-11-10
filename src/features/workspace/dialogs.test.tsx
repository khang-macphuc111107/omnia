import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ProviderDialog, providerTemplates } from "./dialogs";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();

describe("provider dialog truthfulness", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    delete window.__TAURI_INTERNALS__;
    document.body.innerHTML = "";
  });

  it("describes the OpenAI adapter that is actually wired", () => {
    const openAi = providerTemplates.find((template) => template.id === "openai");
    expect(openAi?.description).toContain("Responses API");
    expect(openAi?.description).not.toContain("Chat Completions");
  });

  it("offers DeepSeek as a fixed OpenAI-compatible connection", () => {
    const deepSeek = providerTemplates.find((template) => template.id === "deepseek");
    expect(deepSeek).toMatchObject({
      label: "DeepSeek",
      providerType: "deepseek",
      endpoint: "https://api.deepseek.com/v1",
      kind: "OpenAI-compatible",
      authScheme: "bearer",
      allowCustomEndpoint: false,
    });
  });

  it.each(["Azure OpenAI", "Custom adapter"])(
    "marks %s as planned and prevents connection actions",
    (label) => {
      render(<ProviderDialog onClose={() => undefined} />);

      const templateButton = screen.getByRole("button", { name: new RegExp(label, "i") });
      fireEvent.click(templateButton);

      expect(screen.getByText("Planned adapter · unavailable in this preview")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Not available" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Planned" })).toBeDisabled();
    },
    15_000,
  );

  it("only exposes the fixed Google API-key authentication path", () => {
    render(<ProviderDialog onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /Google Gemini/i }));

    const authentication = screen.getByRole("combobox");
    expect(authentication).toHaveValue("api-key-header");
    expect(authentication.querySelectorAll("option")).toHaveLength(1);
    expect(screen.queryByText("Custom headers")).not.toBeInTheDocument();
  });

  it("labels the pre-save provider check as configuration validation", () => {
    render(<ProviderDialog onClose={() => undefined} />);

    expect(screen.getByRole("button", { name: "Validate configuration" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Test connection" })).not.toBeInTheDocument();
  });

  it("keeps a saved browser preflight separate from native connected state", async () => {
    delete window.__TAURI_INTERNALS__;
    render(<ProviderDialog onClose={() => undefined} />);

    fireEvent.change(screen.getByPlaceholderText("sk-…"), { target: { value: "sk-preview" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate configuration" }));
    expect(await screen.findByText("Configuration preflight passed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add preview connection" }));

    await waitFor(() => {
      expect(useWorkspaceStore.getState().providers[0]).toMatchObject({
        source: "preview",
        state: "configuration-validated",
      });
    });
    expect(useWorkspaceStore.getState().providers[0]?.state).not.toBe("connected");
  });
});
