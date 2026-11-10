import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SovereignBrowserWorkbench } from "./sovereign-browser-workbench";
import { SovereignIdeRemoteWorkbench } from "./sovereign-ide-remote-workbench";
import { useWorkspaceStore } from "./store";
import { setWorkspaceSurface } from "./workspace-mode-switcher";

const initialState = useWorkspaceStore.getState();
const forbiddenChromeGlyph = /[\p{Extended_Pictographic}☆✦●]/u;
const forbiddenReviewChrome = /Cache Hit|28[,.]4(?:10|k)\s*(?:tok|cached)|Cache 94%|154\.2 tok\/s|150\+ tok\/s|Harness: Custom|DFS: 4 Nodes|PRE-ORDER DFS SESSION DAG|parallel subagents|Local Cache Proxy|Anthropic\/OpenAI Cache Harness|9 Official Harnesses Ready|Verified: Math & Citations Pass|builtin_numeric_claim_verifier|ANTI-HALLUCINATION AUDIT|Local: Qwen2\.5|LOCAL SOVEREIGN AI|Patched VS Code|omnia\.code-workspace \(Multi-Root|Stealth: Turnstile Pass|Browser Use Ready|Isolated 2nd Input Ready|10x Human-Seek Pacing|HOST BROWSER PROFILE & COOKIE BRIDGE|ULTRA IDM\+ & CLOUD\/PDF GRABBER|Ask in \/btw|@all-3-tabs/i;

function expectCleanChrome(root: HTMLElement) {
  const controls = root.querySelectorAll(
    'button, [role="tab"], summary, header, [role="status"]',
  );
  for (const control of controls) {
    expect(control.textContent ?? "", control.outerHTML).not.toMatch(forbiddenChromeGlyph);
  }
  for (const svg of root.querySelectorAll("button svg, [role=tab] svg")) {
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("stroke", "currentColor");
  }
}

function expectPrimaryModes(root: HTMLElement) {
  const switcher = within(root).getByTestId("workspace-mode-switcher");
  expect(within(switcher).getAllByRole("button")).toHaveLength(3);
  for (const mode of ["chat", "code", "browser"] as const) {
    expect(within(switcher).getByTestId(`workspace-mode-tab-${mode}`)).toBeEnabled();
  }
}

function expectIconControl(root: HTMLElement, title: string) {
  const button = within(root).getByRole("button", { name: title });
  expect(button).toHaveAttribute("title", title);
  expect(button.querySelector("svg")).toBeInTheDocument();
  expect(button.textContent?.trim()).toBe("");
  return button;
}

function expectFocusedAiPanel(root: HTMLElement, inputTestId: string, sendTestId: string) {
  expect(within(root).queryAllByRole("tab")).toHaveLength(0);
  expect(within(root).getByTestId(inputTestId)).toHaveAttribute("placeholder", "Ask anything...");
  expect(within(root).getByTestId(sendTestId)).toHaveAccessibleName("Send");
  expectIconControl(root, "New chat");
  expectIconControl(root, "Chat history");
  expect(root).not.toHaveTextContent(forbiddenReviewChrome);
}

// These are DOM/accessibility regressions for the reported screenshot defects.
// Real viewport geometry is checked by the separate Chromium smoke harness;
// JSDOM cannot prove pixel layout or the availability of a native host.
describe("Full-window workbench chrome regression contracts", () => {
  beforeEach(() => {
    window.localStorage?.clear?.();
    window.sessionStorage?.clear?.();
    useWorkspaceStore.setState(initialState, true);
    setWorkspaceSurface("chat");
    delete window.__TAURI_INTERNALS__;
  });

  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState(initialState, true);
    setWorkspaceSurface("chat");
  });

  it("Images 21–23: keeps IDE navigation reachable with one focused coding panel and deliberate utility access", () => {
    setWorkspaceSurface("code");
    render(<SovereignIdeRemoteWorkbench />);

    const workbench = screen.getByTestId("sovereign-ide-remote-workbench");
    expectPrimaryModes(workbench);
    // The AI panel is opt-in (editor-first default); open it deliberately.
    expect(within(workbench).queryByTestId("ide-agy-ai-sidebar")).not.toBeInTheDocument();
    fireEvent.click(within(workbench).getByTestId("ide-toggle-agy-sidebar-btn"));
    const sidebar = within(workbench).getByTestId("ide-agy-ai-sidebar");
    expectFocusedAiPanel(sidebar, "ide-agy-ai-input", "ide-agy-ai-send-btn");
    expectIconControl(workbench, "Open project folder");
    const apply = within(sidebar).queryByRole("button", { name: "Apply to editor" });
    if (apply) {
      expect(apply).toHaveAttribute("title", "Apply to editor");
      expect(apply.querySelector("svg")).toBeInTheDocument();
      expect(apply.textContent?.trim()).toBe("");
    }
    expect(workbench).not.toHaveTextContent(forbiddenReviewChrome);
    expectCleanChrome(workbench);
    fireEvent.click(within(workbench).getByTestId("workspace-mode-tab-chat"));
    expect(document.documentElement.dataset.workspaceSurface).toBe("chat");
  });

  it("Images 0–2: keeps browser navigation compact and the single AI panel independent of F12", () => {
    setWorkspaceSurface("browser");
    render(<SovereignBrowserWorkbench />);

    const workbench = screen.getByTestId("sovereign-browser-workbench");
    expectPrimaryModes(workbench);
    expect(within(workbench).getByTestId("omnibox-input")).toBeInTheDocument();
    const profile = expectIconControl(workbench, "Browser profile (click to switch profile or import cookies)");
    expect(profile).not.toHaveTextContent("Chrome Canary");
    expect(within(workbench).queryByTestId("browser-ai-copilot-sidebar")).not.toBeInTheDocument();
    fireEvent.click(within(workbench).getByTestId("browser-copilot-toggle-btn"));
    const sidebar = within(workbench).getByTestId("browser-ai-copilot-sidebar");
    expectFocusedAiPanel(sidebar, "browser-copilot-prompt-input", "browser-copilot-send-btn");
    expect(within(workbench).getByTestId("toggle-devtools-btn")).toHaveAttribute("aria-pressed", "false");
    expect(within(workbench).queryByTestId("sovereign-f12-devtools-dock")).not.toBeInTheDocument();
    expect(workbench).not.toHaveTextContent(forbiddenReviewChrome);
    expectCleanChrome(workbench);
    fireEvent.click(within(workbench).getByTestId("browser-copilot-toggle-btn"));
    expect(screen.queryByTestId("browser-ai-copilot-sidebar")).not.toBeInTheDocument();
    fireEvent.click(within(workbench).getByTestId("workspace-mode-tab-code"));
    expect(document.documentElement.dataset.workspaceSurface).toBe("code");
  });
});
