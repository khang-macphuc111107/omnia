import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import WorkspaceExportCenter, { compareWorkspaceExportDrafts, filterWorkspaceExportProfiles, filterWorkspaceExportRecords, type WorkspaceExportProfile } from "./workspace-export-center";
import { buildWorkspaceExportProjection, serializeWorkspaceExport, type WorkspaceExportRecord } from "./workspace-export-contract";

describe("WorkspaceExportCenter", () => {
  it("filters, searches, sorts, and prioritizes renderer-session export profiles", () => {
    const baseDraft = {
      scope: "workspace" as const,
      redaction: "safe" as const,
      format: "json" as const,
      includeAttachmentMetadata: true,
      selection: {
        conversations: true, projects: true, memories: false, skills: false, providers: false,
        artifacts: false, attachments: false, runs: false, diagnostics: false, appearance: false,
      },
    };
    const profiles: WorkspaceExportProfile[] = [
      { id: "builtin", name: "Safe handoff", description: "Built-in", origin: "builtin", draft: baseDraft },
      { id: "saved", name: "Debug trace", description: "Saved developer trace", origin: "saved", draft: { ...baseDraft, redaction: "developer", format: "jsonl" } },
      { id: "imported", name: "Imported brief", description: "Imported markdown handoff", origin: "imported", draft: { ...baseDraft, format: "markdown" } },
    ];
    expect(filterWorkspaceExportProfiles({ profiles, query: "markdown", origin: "all", favoritesOnly: false, favoriteIds: new Set(), sort: "recent" }).map((profile) => profile.id)).toEqual(["imported"]);
    expect(filterWorkspaceExportProfiles({ profiles, query: "", origin: "saved", favoritesOnly: false, favoriteIds: new Set(), sort: "name" }).map((profile) => profile.id)).toEqual(["saved"]);
    expect(filterWorkspaceExportProfiles({ profiles, query: "", origin: "all", favoritesOnly: true, favoriteIds: new Set(["imported"]), sort: "favorites" }).map((profile) => profile.id)).toEqual(["imported"]);
  });
  it("compares export history drafts by renderer controls only", () => {
    const changes = compareWorkspaceExportDrafts({
      historyDraft: {
        scope: "workspace",
        redaction: "safe",
        format: "json",
        includeAttachmentMetadata: false,
        selection: {
          conversations: true,
          projects: true,
          memories: false,
          skills: false,
          providers: false,
          artifacts: false,
          attachments: false,
          runs: false,
          diagnostics: false,
          appearance: false,
        },
      },
      currentDraft: {
        scope: "active-project",
        redaction: "developer",
        format: "markdown",
        includeAttachmentMetadata: true,
        selection: {
          conversations: true,
          projects: true,
          memories: true,
          skills: false,
          providers: false,
          artifacts: false,
          attachments: false,
          runs: false,
          diagnostics: false,
          appearance: false,
        },
      },
    });

    expect(changes.map((change) => change.key)).toEqual([
      "scope",
      "redaction",
      "format",
      "includeAttachmentMetadata",
      "selection.memories",
    ]);
    expect(changes[0]).toMatchObject({ label: "Scope", previous: "workspace", current: "active-project" });
    expect(changes[3]).toMatchObject({ label: "Attachment metadata", previous: "Excluded", current: "Included" });
  });

  it("renders category controls, summary, and truthful boundary", () => {
    render(<WorkspaceExportCenter />);

    expect(screen.getByRole("heading", { name: "Export Center" })).toBeInTheDocument();
    expect(screen.getByText(/no durable write/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/include attachment metadata/i)).toBeChecked();
    expect(screen.getByRole("button", { name: /generate preview/i })).toBeInTheDocument();
  });

  it("changes format and category selection without leaving the preview surface", () => {
    render(<WorkspaceExportCenter />);

    fireEvent.change(screen.getByLabelText("Format"), { target: { value: "markdown" } });
    fireEvent.click(screen.getByLabelText(/Chats & drafts/i));

    expect(screen.getByRole("button", { name: /copy markdown/i })).toBeInTheDocument();
    expect(screen.getByText("Total records")).toBeInTheDocument();
    expect(screen.getByText("Renderer projection")).toBeInTheDocument();
  });

  it("inspects, compares, restores, and removes a renderer-session history entry", () => {
    render(<WorkspaceExportCenter />);

    fireEvent.click(screen.getByRole("button", { name: /generate preview/i }));
    expect(screen.getByRole("region", { name: "Selected export history entry" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Preview generated" })).toBeInTheDocument();
    expect(screen.getByText(/Current draft matches this entry/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Format"), { target: { value: "markdown" } });
    expect(screen.getByText(/1 setting differs/i)).toBeInTheDocument();
    const detail = screen.getByRole("region", { name: "Selected export history entry" });
    const currentDraftComparison = within(detail).getByRole("group", { name: "Current draft comparison" });
    expect(within(currentDraftComparison).getByText("Format")).toBeInTheDocument();
    expect(within(currentDraftComparison).getByText(/json → markdown/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Restore settings" }));
    expect(screen.getByText(/Restored “Preview generated” settings/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Format")).toHaveValue("json");

    fireEvent.click(screen.getByRole("button", { name: "Remove entry" }));
    expect(screen.queryByRole("region", { name: "Selected export history entry" })).not.toBeInTheDocument();
    expect(screen.getByText(/No export actions match this filter/i)).toBeInTheDocument();
  });

  it("compares controls between two renderer-session history entries without restoring payloads", () => {
    render(<WorkspaceExportCenter />);

    fireEvent.click(screen.getByRole("button", { name: /generate preview/i }));
    fireEvent.change(screen.getByLabelText("Format"), { target: { value: "markdown" } });
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "active-project" } });
    fireEvent.click(screen.getByRole("button", { name: /generate preview/i }));

    const compareSelect = screen.getByLabelText("Compare export history entry") as HTMLSelectElement;
    const firstEntry = Array.from(compareSelect.options).find((option) => option.textContent?.includes("workspace · JSON"));
    expect(firstEntry?.value).toBeTruthy();
    fireEvent.change(compareSelect, { target: { value: firstEntry!.value } });

    const comparison = screen.getByRole("group", { name: "History entry comparison" });
    expect(within(comparison).getByRole("heading", { name: "2 settings differ" })).toBeInTheDocument();
    expect(within(comparison).getByText("active-project → workspace")).toBeInTheDocument();
    expect(within(comparison).getByText("markdown → json")).toBeInTheDocument();
    expect(within(comparison).getByText(/payload records and workspace data are not compared or restored/i)).toBeInTheDocument();
  });

  it("supports bulk category selection and session-only profile import controls", async () => {
    const { container } = render(<WorkspaceExportCenter />);

    fireEvent.click(screen.getByRole("button", { name: /Clear all/i }));
    expect(screen.getByLabelText(/Chats & drafts/i)).not.toBeChecked();
    expect(screen.getByText(/0 of 10 categories selected/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Select all/i }));
    expect(screen.getByLabelText(/Chats & drafts/i)).toBeChecked();
    expect(screen.getByText(/10 of 10 categories selected/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Export Safe handoff/i })).toBeInTheDocument();

    const profilePayload = JSON.stringify({
      schema: "omnia.workspace-export-profile.preview.v1",
      version: 1,
      profile: {
        name: "Imported support profile",
        description: "Imported in the test session",
        draft: {
          scope: "workspace",
          redaction: "developer",
          format: "jsonl",
          includeAttachmentMetadata: true,
          selection: {
            conversations: true,
            projects: true,
            memories: false,
            skills: false,
            providers: false,
            artifacts: true,
            attachments: true,
            runs: true,
            diagnostics: true,
            appearance: false,
          },
        },
      },
    });
    const profileFile = new File([profilePayload], "profile.json", { type: "application/json" });
    Object.defineProperty(profileFile, "text", { value: async () => profilePayload });
    const profileInput = container.querySelector<HTMLInputElement>('input[type="file"][accept=".json"]');
    expect(profileInput).not.toBeNull();
    fireEvent.change(profileInput!, { target: { files: [profileFile] } });

    expect(await screen.findByText(/Imported “Imported support profile” into this renderer session/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Apply Imported support profile/i })).toBeInTheDocument();
  });

  it("supports profile search, source filters, favorites, and filter reset", () => {
    render(<WorkspaceExportCenter />);
    expect(screen.getByRole("button", { name: "Apply Safe handoff" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search export profiles" }), { target: { value: "developer" } });
    expect(screen.getByRole("button", { name: "Apply Developer trace" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply Safe handoff" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search export profiles" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Favorite Safe handoff" }));
    fireEvent.click(screen.getByRole("button", { name: "Favorites only" }));
    expect(screen.getByRole("button", { name: "Unfavorite Safe handoff" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply Developer trace" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Favorites only" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Export profile source" }), { target: { value: "builtin" } });
    expect(screen.getByRole("button", { name: "Apply Safe handoff" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Export profile source" }), { target: { value: "imported" } });
    expect(screen.getByText(/No export profiles match/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear profile filters" }));
    expect(screen.getByRole("button", { name: "Apply Developer trace" })).toBeInTheDocument();
  });

  it("keeps active chat and project scopes tied to provenance metadata", () => {
    const records: WorkspaceExportRecord[] = [
      {
        kind: "conversation",
        id: "chat-a",
        label: "Chat A",
        summary: "",
        metadata: { conversationId: "chat-a", projectId: "project-a" },
      },
      {
        kind: "conversation",
        id: "chat-b",
        label: "Chat B",
        summary: "",
        metadata: { conversationId: "chat-b", projectId: "project-a" },
      },
      {
        kind: "attachment",
        id: "attachment-a",
        label: "Attachment A",
        summary: "",
        metadata: { conversationId: "chat-a", projectId: "project-a" },
      },
      {
        kind: "attachment",
        id: "attachment-unowned",
        label: "Unowned attachment",
        summary: "",
        metadata: { conversationId: null, projectId: null },
      },
      {
        kind: "artifact",
        id: "artifact-a",
        label: "Artifact A",
        summary: "",
        metadata: { project: "Project A" },
      },
      {
        kind: "provider",
        id: "provider-a",
        label: "Provider",
        summary: "",
        metadata: {},
      },
    ];

    expect(filterWorkspaceExportRecords({
      records,
      scope: "active-chat",
      activeConversationId: "chat-a",
      activeProjectId: "project-a",
      activeProjectName: "Project A",
    }).map((record) => record.id)).toEqual(["chat-a", "attachment-a", "artifact-a", "provider-a"]);

    expect(filterWorkspaceExportRecords({
      records,
      scope: "active-project",
      activeConversationId: "chat-a",
      activeProjectId: "project-a",
      activeProjectName: "Project A",
    }).map((record) => record.id)).toEqual(["chat-a", "chat-b", "attachment-a", "artifact-a", "provider-a"]);
  });

  it("reviews imported records separately from current renderer data without restoring app state", async () => {
    const projection = buildWorkspaceExportProjection({
      scope: "custom",
      redaction: "safe",
      generatedAt: "2026-09-24T00:00:00.000Z",
      selection: {
        conversations: false, projects: true, memories: false, skills: false, providers: false,
        artifacts: false, attachments: false, runs: false, diagnostics: false, appearance: false,
      },
      records: [{ kind: "project", id: "import-only", label: "Imported reference", summary: "Review, not restore", metadata: { projectId: "import-only" } }],
    });
    const { container } = render(<WorkspaceExportCenter />);
    const file = new File([serializeWorkspaceExport(projection, "json")], "omnia-preview.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => serializeWorkspaceExport(projection, "json") });
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput!, { target: { files: [file] } });

    const review = await screen.findByRole("region", { name: "Imported bundle review" });
    expect(within(review).getByText("Imported reference")).toBeInTheDocument();
    expect(within(review).getByText(/never creates or replaces Chats, Projects/i)).toBeInTheDocument();
    expect(screen.getByText(/No app data was restored/i)).toBeInTheDocument();
    expect(container.querySelector(".workspace-export-center__payload")?.textContent).not.toContain("import-only");

    fireEvent.change(within(review).getByPlaceholderText(/Title, ID, kind/i), { target: { value: "missing" } });
    expect(within(review).getByText(/No imported records match/i)).toBeInTheDocument();
    fireEvent.click(within(review).getByRole("button", { name: "Close review" }));
    expect(screen.queryByRole("region", { name: "Imported bundle review" })).not.toBeInTheDocument();
  });
});
