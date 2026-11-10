import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MediaEndpointConsolePreview, mediaEndpointConsoleExport } from "./media-endpoint-console-preview";
import { DEFAULT_MEDIA_ENDPOINT_PROFILES } from "./media-endpoint-profile-studio";

describe("Media endpoint console preview", () => {
  it("summarizes declared routes while keeping live health unverified", () => {
    render(<MediaEndpointConsolePreview />);

    const console = screen.getByRole("region", { name: "Endpoint landscape" });
    expect(within(console).getByText("Endpoint health is unknown until a native probe exists.")).toBeInTheDocument();
    expect(within(console).getByText("Not probed")).toBeInTheDocument();
    expect(within(console).getAllByText("Omnia preview route").length).toBeGreaterThan(0);
    expect(within(console).getByText("OpenAI-compatible gateway")).toBeInTheDocument();
    expect(within(console).getByText(/nativeRuntime: not-tested-by-this-probe/i)).toBeInTheDocument();
  });

  it("filters routes by modality and declared capability", () => {
    render(<MediaEndpointConsolePreview />);
    const console = screen.getByRole("region", { name: "Endpoint landscape" });

    fireEvent.click(within(console).getByRole("button", { name: /Video 2/i }));
    expect(within(console).getByText("OpenAI-compatible gateway")).toBeInTheDocument();
    expect(within(console).queryByText("Local model gateway")).not.toBeInTheDocument();

    fireEvent.click(within(console).getByLabelText("Declared for selected modality"));
    expect(within(console).getByText("OpenAI-compatible gateway")).toBeInTheDocument();
    expect(within(console).queryByText("Local model gateway")).not.toBeInTheDocument();
  });

  it("shows the selected route modality matrix and redacted export", () => {
    render(<MediaEndpointConsolePreview />);
    const console = screen.getByRole("region", { name: "Endpoint landscape" });

    fireEvent.click(within(console).getByRole("button", { name: /Local model gateway/i }));
    const detail = within(console).getByRole("complementary", { name: "Local model gateway route details" });
    expect(within(detail).getByText("Image")).toBeInTheDocument();
    expect(within(detail).getByText("Video")).toBeInTheDocument();
    expect(within(detail).getByText("Not declared")).toBeInTheDocument();

    fireEvent.click(within(console).getByRole("button", { name: "Preview JSON" }));
    expect(within(console).getByRole("code")).toHaveTextContent("opaque://redacted-ref");
    expect(within(console).getByRole("code")).toHaveTextContent("No provider request");
  });

  it("exports a stable preview bundle without credential values", () => {
    const payload = mediaEndpointConsoleExport([{ ...DEFAULT_MEDIA_ENDPOINT_PROFILES[0]!, credentialRef: "real-secret-value" }]);
    expect(payload).toContain('"format": "omnia.media-endpoint-profiles.preview.v1"');
    expect(payload).toContain('"health": "not-probed"');
    expect(payload).toContain("opaque://redacted-ref");
    expect(payload).not.toContain("real-secret-value");
  });
});
