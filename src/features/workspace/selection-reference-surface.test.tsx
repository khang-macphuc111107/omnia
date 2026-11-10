import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSelectionReferenceDraft,
  createTextSelectionAnchor,
  selectionReferenceOriginId,
} from "./selection-reference";
import {
  SelectableReferenceContent,
  SelectionReferenceToolbar,
  SelectionReferenceTray,
} from "./selection-reference-surface";
import { useSelectionReferenceStore } from "./selection-reference-store";

const initialState = useSelectionReferenceStore.getState();
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function reference(selectionId: string, sourceId: string, exactText = "stable answer") {
  const sourceText = `A ${exactText} explains the invariant.`;
  const startOffset = 2;
  return createSelectionReferenceDraft({
    anchor: createTextSelectionAnchor({
      selectionId,
      sourceKind: "assistant-message",
      sourceId,
      sourceRevisionId: `revision-${sourceId}`,
      sourceText,
      startOffset,
      endOffset: startOffset + exactText.length,
      capturedAt: "2026-09-19T00:00:00.000Z",
    }),
    mode: "quote",
    sourceLabel: `Answer ${sourceId}`,
    authorLabel: "Omnia",
    createdAt: "2026-09-19T00:00:00.000Z",
  });
}

describe("selection reference surface", () => {
  afterEach(() => {
    useSelectionReferenceStore.setState(initialState, true);
    if (originalClipboardDescriptor) {
      Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
    } else {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    }
    document.body.innerHTML = "";
  });

  it("returns focus to a mounted original source and announces the result", () => {
    const selected = reference("selection-one", "message-one");
    useSelectionReferenceStore.setState({
      references: [selected],
      conversationId: "conversation-one",
      activeSelectionId: selected.anchor.selectionId,
    });

    render(
      <>
        <div id={selectionReferenceOriginId(selected.anchor)} tabIndex={-1}>
          Original answer
        </div>
        <SelectionReferenceTray />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open original Answer message-one" }));

    expect(document.getElementById(selectionReferenceOriginId(selected.anchor))).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent(/Returned to original Answer message-one/i);
  });

  it("keeps the unavailable-origin boundary explicit and supports reorder/remove announcements", () => {
    const first = reference("selection-one", "message-one");
    const second = reference("selection-two", "message-two", "another answer");
    useSelectionReferenceStore.setState({ references: [first, second], conversationId: "conversation-one" });

    render(<SelectionReferenceTray />);

    fireEvent.click(screen.getByRole("button", { name: "Open original Answer message-two" }));
    expect(screen.getByRole("status")).toHaveTextContent(/not mounted in this preview/i);

    fireEvent.click(screen.getByRole("button", { name: "Move reference 1 down" }));
    expect(screen.getByRole("status")).toHaveTextContent(/Moved reference 1 down/i);
    expect(useSelectionReferenceStore.getState().references.map((item) => item.id)).toEqual([second.id, first.id]);

    fireEvent.click(screen.getByRole("button", { name: "Remove reference 2" }));
    expect(screen.getByRole("status")).toHaveTextContent(/Removed reference 2/i);
    expect(useSelectionReferenceStore.getState().references.map((item) => item.id)).toEqual([second.id]);
  });

  it("marks selectable content as the renderer-local original target", () => {
    const selected = reference("selection-one", "message-one");

    render(
      <SelectableReferenceContent
        sourceKind={selected.anchor.sourceKind}
        sourceId={selected.anchor.sourceId}
        sourceRevisionId={selected.anchor.sourceRevisionId}
        sourceLabel={selected.sourceLabel}
      >
        <p>Original answer</p>
      </SelectableReferenceContent>,
    );

    const source = document.getElementById(selectionReferenceOriginId(selected.anchor));
    expect(source).toBeInTheDocument();
    expect(source).toHaveAttribute("data-selection-source-kind", "assistant-message");
    expect(source).toHaveAttribute("data-selection-source-id", "message-one");
    expect(source).toHaveAttribute("tabindex", "-1");
  });

  it("announces clipboard success and failure without claiming native persistence", async () => {
    const selected = reference("selection-one", "message-one");
    const captured = {
      anchor: selected.anchor,
      rect: { top: 10, right: 30, bottom: 20, left: 10, width: 20, height: 10 },
    } as const;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    render(
      <SelectionReferenceToolbar
        captured={captured}
        sourceLabel={selected.sourceLabel}
        onReference={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy selected text" }));
    await screen.findByRole("status");
    expect(writeText).toHaveBeenCalledWith(selected.anchor.exactText);
    expect(screen.getByRole("status")).toHaveTextContent(/Copied selected text/i);

    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    fireEvent.click(screen.getByRole("button", { name: "Copy selected text" }));
    expect(screen.getByRole("status")).toHaveTextContent(/Clipboard is unavailable/i);
  });
});
