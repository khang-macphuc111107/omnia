import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageAttachmentCard, attachmentPreviewType } from "./message-attachment";
import type { AttachmentView } from "./types";

function attachment(
  patch: Partial<AttachmentView> = {},
): AttachmentView {
  return {
    id: "attachment-message-preview",
    name: "recording.webm",
    kind: "document",
    mediaType: "video/webm",
    size: "2.4 MB",
    state: "ready",
    ...patch,
  };
}

describe("MessageAttachmentCard", () => {
  it("renders an image only when an explicit renderer-local URL is present", () => {
    render(
      <MessageAttachmentCard
        attachment={attachment({
          name: "diagram.png",
          kind: "image",
          mediaType: "image/png",
          previewUrl: "blob:diagram-preview",
          previewType: "image",
        })}
      />,
    );

    expect(screen.getByRole("img", { name: "Preview of diagram.png" })).toHaveAttribute(
      "src",
      "blob:diagram-preview",
    );
    expect(screen.getByText("2.4 MB")).toBeInTheDocument();
    expect(screen.getByLabelText(/Local file preview/i)).toBeInTheDocument();
    expect(screen.queryByText(/renderer-local|native media bytes|extraction planned/)).not.toBeInTheDocument();
  });

  it("supports video and audio controls without treating metadata as media bytes", () => {
    const { rerender } = render(
      <MessageAttachmentCard
        attachment={attachment({
          name: "walkthrough.mp4",
          mediaType: "video/mp4",
          previewUrl: "blob:walkthrough-preview",
          previewType: "video",
        })}
      />,
    );

    expect(document.querySelector("video")).toHaveAttribute("src", "blob:walkthrough-preview");
    expect(document.querySelector("video")).toHaveAttribute("controls");

    rerender(
      <MessageAttachmentCard
        attachment={attachment({
          name: "voice.wav",
          mediaType: "audio/wav",
          previewUrl: "blob:voice-preview",
          previewType: "audio",
        })}
      />,
    );

    expect(document.querySelector("audio")).toHaveAttribute("src", "blob:voice-preview");
    expect(document.querySelector("audio")).toHaveAttribute("controls");
  });

  it("keeps native metadata-only attachments display-only", () => {
    render(
      <MessageAttachmentCard
        attachment={attachment({
          name: "native-photo.png",
          kind: "image",
          mediaType: "image/png",
        })}
      />,
    );

    expect(document.querySelector("img,video,audio")).toBeNull();
    const card = screen.getByLabelText(/native-photo\.png, 2\.4 MB/i);
    expect(card).toHaveTextContent("2.4 MB");
    expect(card).toHaveAttribute("title", "native-photo.png. File content is unavailable in this preview.");
    expect(card).not.toHaveTextContent(/Display only|extraction planned/);
  });

  it("rejects remote URLs and can infer the media type from local preview metadata", () => {
    expect(
      attachmentPreviewType(
        attachment({ mediaType: "audio/ogg", previewUrl: "https://example.test/audio.ogg" }),
      ),
    ).toBeNull();
    expect(
      attachmentPreviewType(
        attachment({ mediaType: "audio/ogg", previewUrl: "blob:audio-preview" }),
      ),
    ).toBe("audio");
  });
});
