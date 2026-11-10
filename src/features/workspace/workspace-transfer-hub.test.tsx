import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import WorkspaceTransferHub from "./workspace-transfer-hub";
import { useWorkspaceStore } from "./store";
import { buildWorkspaceTransferManifest, serializeWorkspaceTransferManifest } from "./workspace-transfer-contract";

const initialState = useWorkspaceStore.getState();

afterEach(() => {
  useWorkspaceStore.setState(initialState, true);
  document.body.innerHTML = "";
});

describe("WorkspaceTransferHub", () => {
  it("renders direction, profile, selection controls, and truthful boundary", () => {
    render(<WorkspaceTransferHub />);

    expect(screen.getByRole("heading", { name: "Workspace Transfer Hub" })).toBeInTheDocument();
    expect(screen.getByText(/renderer-local.*metadata-only.*no durable write/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Generate transfer preview/i })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Chats & drafts" })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Workspace transfer profile" })).toHaveValue("portable");
  });

  it("prepares an inspectable manifest and supports undo/redo around content selection", () => {
    render(<WorkspaceTransferHub />);

    const chats = screen.getByRole("checkbox", { name: "Chats & drafts" });
    fireEvent.click(chats);
    expect(chats).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Undo workspace transfer change" }));
    expect(chats).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Redo workspace transfer change" }));
    expect(chats).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: /Generate transfer preview/i }));
    const preview = screen.getByRole("region", { name: "Workspace transfer manifest preview" });
    expect(within(preview).getByRole("code")).toHaveTextContent(/omnia\.workspace-transfer\.preview\.v1/i);
    expect(within(preview).getByText("preview-only", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/renderer-local transfer preview/i);
  });

  it("stages a valid imported manifest without mutating workspace records", () => {
    const manifest = buildWorkspaceTransferManifest({
      mode: "import",
      scope: "workspace",
      profile: "support",
      format: "json",
      redaction: "safe",
      target: "Imported support bundle",
      selection: {
        conversations: true,
        projects: true,
        memoryCandidates: true,
        skills: false,
        artifacts: false,
        attachments: false,
        runEvidence: true,
      },
      counts: {
        conversations: 1,
        projects: 1,
        memoryCandidates: 2,
        skills: 0,
        artifacts: 0,
        attachments: 0,
        runEvidence: 4,
      },
      estimatedBytes: 2_048,
      records: 8,
    });
    render(<WorkspaceTransferHub />);

    fireEvent.click(screen.getByRole("button", { name: /Import/i }));
    const importBox = screen.getByRole("textbox", { name: "Workspace transfer manifest import" });
    fireEvent.change(importBox, { target: { value: serializeWorkspaceTransferManifest(manifest, "json") } });
    fireEvent.click(screen.getByRole("button", { name: /Stage manifest in preview/i }));

    expect(screen.getByRole("status")).toHaveTextContent(/Staged 8 records/i);
    expect(screen.getByRole("region", { name: "Workspace transfer manifest preview" })).toHaveTextContent(/Imported support bundle/i);
  });
});
