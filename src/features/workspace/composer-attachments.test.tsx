import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ComposerAttachmentTray,
  composerAttachmentBlockReason,
  composerAttachmentFromView,
  summarizeComposerAttachments,
  type ComposerAttachmentItem,
} from "./composer-attachments";

const readyAttachment: ComposerAttachmentItem = {
  id: "attachment_ready",
  name: "PRODUCT_SPEC.md",
  kind: "document",
  sizeLabel: "33 KB",
  state: "ready",
};

describe("composer attachment presentation", () => {
  it("maps durable attachment extraction evidence into honest composer states", () => {
    expect(
      composerAttachmentFromView({
        id: "attachment_native",
        name: "architecture.pdf",
        kind: "document",
        size: "2.5 MB",
        state: "processing",
        extractionStatus: "running",
      }),
    ).toMatchObject({ state: "extracting", name: "architecture.pdf" });
    expect(
      composerAttachmentFromView({
        id: "attachment_skipped",
        name: "archive.zip",
        kind: "document",
        size: "8 MB",
        state: "warning",
        extractionStatus: "skipped",
      }).state,
    ).toBe("warning");
  });

  it("blocks submission whenever ingestion is incomplete or needs intervention", () => {
    const summary = summarizeComposerAttachments([
      readyAttachment,
      { ...readyAttachment, id: "attachment_processing", state: "extracting" },
      { ...readyAttachment, id: "attachment_failed", state: "failed" },
      { ...readyAttachment, id: "attachment_warning", state: "warning" },
    ]);

    expect(summary).toEqual({
      total: 4,
      ready: 1,
      processing: 1,
      preview: 0,
      warning: 1,
      failed: 1,
      blocksSubmission: true,
    });
    expect(composerAttachmentBlockReason(summary)).toMatch(/finish processing/i);
  });

  it("does not block a message when every selected attachment is ready", () => {
    const summary = summarizeComposerAttachments([
      readyAttachment,
      { ...readyAttachment, id: "attachment_ready_2", name: "diagram.png", kind: "image" },
    ]);

    expect(summary.blocksSubmission).toBe(false);
    expect(composerAttachmentBlockReason(summary)).toBeNull();
  });

  it("renders typed compact file chips, actionable progress and SVG remove actions without backend copy", () => {
    const onRemove = vi.fn();
    render(
      <ComposerAttachmentTray
        attachments={[
          readyAttachment,
          {
            id: "attachment_processing",
            name: "research.pdf",
            kind: "document",
            sizeLabel: "2.4 MB",
            state: "extracting",
          },
        ]}
        onRemove={onRemove}
      />,
    );

    expect(screen.queryByText(/Stored in Omnia locally|frozen bridge plan|provider dispatch/i)).not.toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Extracting")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove PRODUCT_SPEC.md" }).querySelector("svg")).toHaveAttribute("stroke-width", "1.75");
    fireEvent.click(screen.getByRole("button", { name: "Remove PRODUCT_SPEC.md" }));
    expect(onRemove).toHaveBeenCalledWith("attachment_ready");
  });

  it("offers retry only for a failed attachment", () => {
    const onRetry = vi.fn();
    render(
      <ComposerAttachmentTray
        attachments={[
          readyAttachment,
          {
            id: "attachment_failed",
            name: "broken.pdf",
            kind: "document",
            sizeLabel: "8 MB",
            state: "failed",
            statusDetail: "Encrypted PDFs are not supported yet.",
          },
        ]}
        onRemove={() => undefined}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByLabelText(/broken\.pdf.*Encrypted PDFs/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry PRODUCT_SPEC.md" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry broken.pdf" }));
    expect(onRetry).toHaveBeenCalledWith("attachment_failed");
  });

  it("keeps browser files explicitly preview-only and blocks sending them", () => {
    const browserPreview: ComposerAttachmentItem = {
      id: "browser_attachment_image",
      name: "diagram.png",
      kind: "image",
      sizeLabel: "18 KB",
      state: "preview",
      previewUrl: "blob:diagram-preview",
      previewType: "image",
    };
    const videoPreview: ComposerAttachmentItem = {
      id: "browser_attachment_video",
      name: "walkthrough.webm",
      kind: "document",
      sizeLabel: "2.1 MB",
      state: "preview",
      previewUrl: "blob:walkthrough-preview",
      previewType: "video",
    };
    const summary = summarizeComposerAttachments([browserPreview, videoPreview]);

    expect(summary.preview).toBe(2);
    expect(summary.blocksSubmission).toBe(true);
    expect(composerAttachmentBlockReason(summary)).toMatch(/not stored or uploadable/i);

    render(
      <ComposerAttachmentTray
        attachments={[browserPreview, videoPreview]}
        onRemove={() => undefined}
        boundaryMessage="Browser preview only; not uploaded or stored."
      />,
    );

    fireEvent.click(screen.getByText("diagram.png"));
    fireEvent.click(screen.getByText("walkthrough.webm"));
    expect(screen.getByRole("img", { name: "Preview of diagram.png" })).toHaveAttribute("src", "blob:diagram-preview");
    expect(screen.getByLabelText("Preview of walkthrough.webm")).toHaveAttribute("src", "blob:walkthrough-preview");
    expect(screen.getAllByText("Preview only")).toHaveLength(2);
    expect(screen.getByText("Browser preview only; not uploaded or stored.")).toBeInTheDocument();
  });

  it("separates genuine filename and source line metadata without fabricating context chips", () => {
    const { container } = render(<ComposerAttachmentTray attachments={[{ ...readyAttachment, name: "provider_gateway.rs:864-898", kind: "code" }]} onRemove={() => undefined} />);
    expect(screen.getByText("provider_gateway.rs")).toBeInTheDocument();
    expect(screen.getByText(":864-898")).toBeInTheDocument();
    expect(container.querySelector(".lucide-file-code-2")).not.toBeNull();
    expect(screen.queryByText(/@workspace:|\/btw ready/)).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
