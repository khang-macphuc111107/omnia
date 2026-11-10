import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  importComposerDraftBundle,
  importComposerPortableDraft,
  serializeComposerDraftBundle,
  serializeComposerDraftMarkdown,
} from "./composer-draft-contract";
import { ComposerDraftStudio } from "./composer-draft-studio";
import { useComposerDraftHistory } from "./composer-draft-history";

function Harness({ conversationId = "conversation-a" }: { conversationId?: string }) {
  const [draft, setDraft] = useState("Plan API");
  const controller = useComposerDraftHistory({ conversationId, value: draft, onChange: setDraft });
  return (
    <>
      <textarea aria-label="Harness draft" value={draft} onChange={(event) => controller.update(event.target.value, "typing")} />
      <ComposerDraftStudio conversationId={conversationId} draft={draft} controller={controller} />
    </>
  );
}

describe("Composer Draft Studio renderer preview", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("supports undo and redo for explicit draft changes", () => {
    render(<Harness />);
    const draft = screen.getByRole("textbox", { name: "Harness draft" });

    fireEvent.change(draft, { target: { value: "Plan API\n- authentication" } });
    expect(screen.getByRole("button", { name: "Undo draft change" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Redo draft change" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Undo draft change" }));
    expect(draft).toHaveValue("Plan API");
    expect(screen.getByRole("button", { name: "Redo draft change" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Redo draft change" }));
    expect(draft).toHaveValue("Plan API\n- authentication");
  });

  it("saves, restores, and removes named snapshots without leaving the renderer", () => {
    render(<Harness />);
    const draft = screen.getByRole("textbox", { name: "Harness draft" });

    fireEvent.change(draft, { target: { value: "Architecture notes" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Draft snapshot name" }), {
      target: { value: "Before refactor" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft snapshot" }));
    expect(screen.getByRole("list", { name: "Saved draft snapshots" })).toHaveTextContent(/Before refactor/);

    fireEvent.change(draft, { target: { value: "Changed content" } });
    fireEvent.click(screen.getByRole("button", { name: "Restore snapshot Before refactor" }));
    expect(draft).toHaveValue("Architecture notes");
    expect(screen.getByRole("status", { name: "Draft session status" })).toHaveTextContent(/Undo can return/);

    fireEvent.click(screen.getByRole("button", { name: "Undo draft change" }));
    expect(draft).toHaveValue("Changed content");

    fireEvent.click(screen.getByRole("button", { name: "Remove snapshot Before refactor" }));
    expect(screen.getByRole("region", { name: "Draft snapshots" })).toHaveTextContent(/No snapshots yet/);
  });

  it("compares a saved checkpoint with the live draft and refreshes stale diffs on demand", () => {
    render(<Harness />);
    const draft = screen.getByRole("textbox", { name: "Harness draft" });

    fireEvent.change(screen.getByRole("textbox", { name: "Draft snapshot name" }), { target: { value: "Baseline" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft snapshot" }));
    fireEvent.change(draft, { target: { value: "Plan API\n- authentication\n- retries" } });

    fireEvent.click(screen.getByRole("button", { name: "Compare now" }));
    const comparison = screen.getByRole("region", { name: "Draft version diff" });
    expect(comparison).toHaveTextContent("Baseline");
    expect(comparison).toHaveTextContent("2 added");
    expect(screen.getByRole("list", { name: "Version line changes" })).toHaveTextContent("- authentication");
    expect(comparison).toHaveTextContent("renderer preview");

    fireEvent.change(draft, { target: { value: "Plan API\n- authentication\n- retries\n- caching" } });
    expect(comparison).toHaveTextContent("Draft changed · compare again");
    fireEvent.click(screen.getByRole("button", { name: "Compare now" }));
    expect(comparison).toHaveTextContent("3 added");
  });

  it("keeps draft history and intent isolated by conversation id", () => {
    const { rerender } = render(<Harness conversationId="conversation-a" />);
    const draft = screen.getByRole("textbox", { name: "Harness draft" });
    fireEvent.change(draft, { target: { value: "A revision" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Draft snapshot name" }), { target: { value: "A checkpoint" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft snapshot" }));

    rerender(<Harness conversationId="conversation-b" />);
    expect(screen.getByRole("region", { name: "Draft snapshots" })).toHaveTextContent(/No snapshots yet/);
    expect(screen.getByRole("button", { name: "Undo draft change" })).toBeDisabled();

    fireEvent.click(screen.getByRole("radio", { name: /Report/ }));
    expect(screen.getByRole("radio", { name: /Report/ })).toHaveAttribute("aria-checked", "true");
  });

  it("validates JSON and portable Markdown drafts, then applies imported content to the current conversation", async () => {
    const payload = serializeComposerDraftBundle({
      conversationId: "external-conversation",
      mode: "research-note",
      title: "Imported note",
      content: "# Imported question",
      exportedAt: "2026-09-17T00:00:00.000Z",
    });
    expect(importComposerDraftBundle(payload)).toMatchObject({ ok: true });
    expect(importComposerDraftBundle(JSON.stringify({ scope: "other" }))).toMatchObject({ ok: false });

    const portableMarkdown = serializeComposerDraftMarkdown({
      conversationId: "external-conversation",
      mode: "code-note",
      title: "Portable note",
      content: "# Imported Markdown\n\n- portable",
      exportedAt: "2026-09-17T00:00:00.000Z",
    });
    expect(importComposerPortableDraft(portableMarkdown)).toMatchObject({
      ok: true,
      source: "markdown",
      bundle: { mode: "code-note", content: "# Imported Markdown\n\n- portable" },
    });
    expect(importComposerPortableDraft("# External Markdown\n\nPlain content")).toMatchObject({
      ok: true,
      source: "plain-markdown",
      bundle: { title: "External Markdown", mode: "chat" },
    });

    render(<Harness />);
    const file = new File([payload], "draft.json", { type: "application/json" });
    fireEvent.change(screen.getByLabelText("Import portable draft"), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Harness draft" })).toHaveValue("# Imported question"));
    expect(screen.getByRole("radio", { name: /Research note/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("status", { name: "Draft session status" })).toHaveTextContent(/current conversation/i);
  });

  it("switches the portable surface to readable Markdown and imports a plain Markdown file", async () => {
    render(<Harness />);

    const format = screen.getByRole("combobox", { name: "Portable draft format" });
    expect(format).toHaveValue("json");
    expect(screen.getByRole("button", { name: "Copy JSON" })).toBeInTheDocument();

    fireEvent.change(format, { target: { value: "markdown" } });
    expect(screen.getByRole("button", { name: "Copy Markdown" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export Markdown" })).toBeInTheDocument();
    expect(screen.getByText(/Markdown stays readable outside Omnia/i)).toBeInTheDocument();

    const file = new File(["# Borrowed outline\n\n- keep this"], "outline.md", { type: "text/markdown" });
    fireEvent.change(screen.getByLabelText("Import portable draft"), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Harness draft" })).toHaveValue("# Borrowed outline\n\n- keep this"));
    expect(screen.getByRole("status", { name: "Draft session status" })).toHaveTextContent(/plain Markdown draft imported/i);
  });

  it("exposes the renderer-only boundary instead of claiming native persistence", () => {
    render(<Harness />);
    expect(screen.getByRole("note")).toHaveTextContent(/renderer session/i);
    expect(screen.getByRole("note")).toHaveTextContent(/Native draft persistence.*planned/i);
    expect(screen.getByRole("note")).toHaveTextContent(/Browser downloads do not choose a workspace path/i);
  });
});
