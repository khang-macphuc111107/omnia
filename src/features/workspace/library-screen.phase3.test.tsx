import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LibraryScreen } from "./library-screen";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();

describe("artifact workbench preview", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("opens a versioned artifact into preview, diff, and metadata tabs", () => {
    useWorkspaceStore.setState({
      conversations: [],
      attachments: [],
      artifacts: [
        {
          id: "artifact-demo",
          name: "demo.md",
          type: "Markdown",
          projectName: "Omnia Desktop",
          updatedLabel: "just now",
          sizeLabel: "2 KB",
          versionCount: 3,
        },
      ],
    });

    render(<LibraryScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Inspect artifact demo.md" }));
    fireEvent.click(screen.getByRole("button", { name: "Open artifact" }));

    expect(screen.getByRole("region", { name: "Artifact workbench for demo.md" })).toBeInTheDocument();
    expect(screen.getByText(/Renderer preview · revision 3/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "v1" }));
    expect(screen.getByText(/Renderer preview · revision 1/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Diff" }));
    expect(screen.getByText(/No predecessor revision/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Metadata" }));
    expect(screen.getByText("artifact-demo")).toBeInTheDocument();
    expect(screen.getByText("Not hydrated")).toBeInTheDocument();
  });

  it("filters provenance, sorts visible records, and previews a renderer-local export", () => {
    useWorkspaceStore.setState({
      conversations: [
        {
          id: "conversation-library",
          activeBranchId: "branch-library",
          title: "Library source review",
          excerpt: "Inspect the source",
          updatedAt: "2026-08-13T00:00:00.000Z",
          updatedLabel: "Yesterday",
          projectId: "project-library",
          projectName: "Omnia Desktop",
          pinned: false,
          archived: false,
          hasDraft: false,
          unread: false,
          runState: null,
          draft: "",
          messages: [
            {
              id: "message-library",
              role: "user",
              content: "Inspect the source",
              createdAt: "2026-08-13T00:00:00.000Z",
              status: "complete",
              modelLabel: null,
              runId: null,
              attachments: [
                {
                  id: "attachment-library",
                  name: "source.md",
                  kind: "document",
                  size: "4 KB",
                  state: "ready",
                  messageId: "message-library",
                  createdAt: "2026-08-13T00:00:00.000Z",
                },
              ],
              branchIndex: 1,
              branchCount: 1,
            },
          ],
        },
      ],
      attachments: [],
      artifacts: [
        {
          id: "artifact-large",
          name: "architecture.md",
          type: "Markdown",
          projectName: "Omnia Desktop",
          updatedLabel: "just now",
          sizeLabel: "12 KB",
          versionCount: 4,
        },
        {
          id: "artifact-small",
          name: "notes.md",
          type: "Markdown",
          projectName: "Omnia Desktop",
          updatedLabel: "2 days ago",
          sizeLabel: "2 KB",
          versionCount: 1,
        },
      ],
    });

    render(<LibraryScreen />);

    fireEvent.change(screen.getByRole("combobox", { name: "Filter by provenance" }), {
      target: { value: "project" },
    });
    expect(screen.getByRole("button", { name: "Inspect artifact architecture.md" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Inspect file source.md" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Sort library" }), {
      target: { value: "name" },
    });
    const visibleCards = screen.getAllByRole("button", { name: /Inspect artifact/ });
    expect(visibleCards[0]).toHaveAccessibleName("Inspect artifact architecture.md");

    fireEvent.click(screen.getByRole("button", { name: "Select architecture.md for bulk actions" }));
    expect(screen.getByRole("region", { name: "Bulk library actions" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview selected export" }));
    expect(screen.getByText(/"scope": "selected-items"/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByRole("region", { name: "Bulk library actions" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide index preview" }));

    fireEvent.click(screen.getByRole("button", { name: "Preview index export" }));
    expect(screen.getByRole("region", { name: "Library export preview" })).toBeInTheDocument();
    expect(screen.getByText(/omnia\.library\.preview\.v1/)).toBeInTheDocument();
    expect(screen.getAllByText(/no file was written/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Durable export.*remain planned/i)).toBeInTheDocument();
  });

  it("does not keep a stale artifact detail panel when the selected record is filtered out", () => {
    useWorkspaceStore.setState({
      conversations: [],
      attachments: [],
      artifacts: [
        {
          id: "artifact-gallery-visible",
          name: "visible.md",
          type: "Markdown",
          projectName: "Omnia Desktop",
          updatedLabel: "just now",
          sizeLabel: "2 KB",
          versionCount: 2,
        },
        {
          id: "artifact-gallery-other",
          name: "other.md",
          type: "Markdown",
          projectName: "Omnia Desktop",
          updatedLabel: "yesterday",
          sizeLabel: "1 KB",
          versionCount: 1,
        },
      ],
    });

    render(<LibraryScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Inspect artifact visible.md" }));
    expect(screen.getByRole("complementary", { name: "Selected library item" })).toHaveTextContent("visible.md");

    fireEvent.change(screen.getByRole("textbox", { name: "Search library" }), {
      target: { value: "other" },
    });

    expect(screen.queryByRole("complementary", { name: "Selected library item" })).not.toBeInTheDocument();
    expect(screen.getByText(/Selected record hidden by current filters/i)).toBeInTheDocument();
    const collectionHeading = screen.getByRole("heading", { name: "All content" }).parentElement;
    expect(collectionHeading).toHaveTextContent("1 item");
    expect(collectionHeading).toHaveTextContent("2 total");
    expect(collectionHeading).toHaveTextContent("other");

    fireEvent.click(screen.getByRole("button", { name: "Clear library search" }));
    expect(screen.getByRole("complementary", { name: "Selected library item" })).toHaveTextContent("visible.md");
  });

  it("saves, applies, and deletes renderer-local library views", () => {
    useWorkspaceStore.setState({
      conversations: [],
      attachments: [],
      artifacts: [
        {
          id: "artifact-saved-view",
          name: "saved-view.md",
          type: "Markdown",
          projectName: "Omnia Desktop",
          updatedLabel: "just now",
          sizeLabel: "1 KB",
          versionCount: 1,
        },
      ],
    });

    render(<LibraryScreen />);

    fireEvent.change(screen.getByRole("combobox", { name: "Sort library" }), {
      target: { value: "name" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Search library" }), {
      target: { value: "saved" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "New saved library view name" }), {
      target: { value: "Saved artifacts" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save view/ }));

    expect(screen.getByText(/Saved “Saved artifacts” in this renderer preview/)).toBeInTheDocument();
    const savedViewSelect = screen.getByRole("combobox", { name: "Saved library view" }) as HTMLSelectElement;
    const savedViewId = savedViewSelect.value;
    expect(savedViewId).not.toBe("manual");

    fireEvent.change(screen.getByRole("textbox", { name: "Search library" }), {
      target: { value: "mutated" },
    });
    fireEvent.change(savedViewSelect, { target: { value: savedViewId } });
    expect(screen.getByRole("textbox", { name: "Search library" })).toHaveValue("saved");
    expect(screen.getByText(/Applied “Saved artifacts” in this renderer preview/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete saved library view" }));
    expect(savedViewSelect.value).toBe("manual");
    expect(screen.getByText(/Deleted “Saved artifacts” from this renderer session/)).toBeInTheDocument();
  });

  it("offers markdown copy and browser download actions without claiming native export", async () => {
    useWorkspaceStore.setState({
      conversations: [],
      attachments: [],
      artifacts: [
        {
          id: "artifact-export",
          name: "report.md",
          type: "Markdown",
          projectName: "Omnia Desktop",
          updatedLabel: "just now",
          sizeLabel: "3 KB",
          versionCount: 2,
        },
      ],
    });

    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:omnia-library-preview"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    render(<LibraryScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Preview index export" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Library export format" }), {
      target: { value: "markdown" },
    });

    expect(screen.getByText(/# Omnia library export preview/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("# Omnia library export preview"));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(screen.getByText(/Started a browser download/i)).toBeInTheDocument();

    click.mockRestore();
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    else Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    if (createObjectUrlDescriptor) Object.defineProperty(URL, "createObjectURL", createObjectUrlDescriptor);
    if (revokeObjectUrlDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeObjectUrlDescriptor);
  });
});
