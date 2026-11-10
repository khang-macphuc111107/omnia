import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_IDE_WORKSPACE_FILES, SOVEREIGN_IDE_REMOTE_STORAGE_KEY } from "@/domain/sovereign-ide-remote-desktop";
import { MessageMarkdown, OPEN_CODE_IN_IDE_EVENT, takePendingCodeInIdeRequest } from "./markdown";
import { SovereignIdeRemoteWorkbench } from "./sovereign-ide-remote-workbench";
import { setWorkspaceSurface } from "./workspace-mode-switcher";

describe("Image 19 Open in IDE integration", () => {
  beforeEach(() => {
    window.localStorage?.removeItem?.(SOVEREIGN_IDE_REMOTE_STORAGE_KEY);
    takePendingCodeInIdeRequest();
    setWorkspaceSurface("chat");
  });
  afterEach(() => {
    takePendingCodeInIdeRequest();
    setWorkspaceSurface("chat");
  });

  it("navigates to an existing file without applying the suggested code", () => {
    const file = DEFAULT_IDE_WORKSPACE_FILES[1]!;
    render(<><MessageMarkdown content={`\`\`\`rust ${file.path}:3-6\n// do not overwrite the file\n\`\`\``} /><SovereignIdeRemoteWorkbench /></>);
    fireEvent.click(screen.getAllByRole("button", { name: "Open in IDE" })[0]!);
    expect(screen.getByTestId("ide-code-editor-textarea")).toHaveValue(file.content);
    expect(screen.queryByRole("dialog", { name: "Code preview" })).not.toBeInTheDocument();
    expect(document.documentElement.dataset.workspaceSurface).toBe("code");
  });

  it("survives lazy mounting and shows an unknown snippet read-only without creating a file", () => {
    const snippet = 'const value = "<script>not HTML</script>";';
    const markdown = render(<MessageMarkdown content={`\`\`\`ts src/not-a-real-file.ts:12-16\n${snippet}\n\`\`\``} />);
    fireEvent.click(screen.getByRole("button", { name: "Open in IDE" }));
    markdown.unmount();
    render(<SovereignIdeRemoteWorkbench />);
    const dialog = screen.getByRole("dialog", { name: "Code preview" });
    const preview = within(dialog).getByRole("textbox", { name: "Read-only code snippet" });
    expect(preview).toHaveValue(snippet);
    expect(preview).toHaveAttribute("readonly");
    expect(dialog).toHaveTextContent("Your project files are unchanged.");
    expect(screen.getByTestId("ide-code-editor-textarea")).toHaveValue(DEFAULT_IDE_WORKSPACE_FILES[0]!.content);
    expect(dialog.querySelector("script")).toBeNull();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Code preview" })).not.toBeInTheDocument();
  });

  it("ignores malformed navigation events without changing a buffer", () => {
    render(<SovereignIdeRemoteWorkbench />);
    act(() => { window.dispatchEvent(new CustomEvent(OPEN_CODE_IN_IDE_EVENT, { detail: { code: 123 } })); });
    expect(screen.getByTestId("ide-code-editor-textarea")).toHaveValue(DEFAULT_IDE_WORKSPACE_FILES[0]!.content);
    expect(screen.queryByRole("dialog", { name: "Code preview" })).not.toBeInTheDocument();
  });
});
