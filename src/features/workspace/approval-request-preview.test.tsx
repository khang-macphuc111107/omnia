import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  APPROVAL_REQUEST_BOUNDARY,
  DEFAULT_APPROVAL_REQUEST,
  approvalRequestRisk,
  approvalRequestValidation,
  safeApprovalRequestPayload,
} from "./approval-request-preview-contract";
import { ApprovalRequestPreview } from "./approval-request-preview";

describe("Approval Request Preview", () => {
  it("shows exact-request inputs, presets, and an explicit renderer-only boundary", () => {
    render(<ApprovalRequestPreview />);

    expect(screen.getByRole("heading", { name: "Approval Request Preview" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Approval request operation" })).toHaveValue("read-workspace");
    expect(screen.getByRole("textbox", { name: "Approval request target" })).toHaveValue("workspace://current-project");
    expect(screen.getByRole("button", { name: "Load Inspect safely approval request preset" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByText(new RegExp(APPROVAL_REQUEST_BOUNDARY, "i")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Stage for review/i })).toBeEnabled();
  });

  it("loads a high-risk command review shape and updates its bounded preview fields", () => {
    render(<ApprovalRequestPreview />);
    fireEvent.click(screen.getByRole("button", { name: "Load Command review approval request preset" }));

    expect(screen.getByRole("combobox", { name: "Approval request operation" })).toHaveValue("run-command");
    expect(screen.getByRole("combobox", { name: "Approval request scope" })).toHaveValue("once");
    expect(screen.getByRole("combobox", { name: "Approval request sandbox" })).toHaveValue("isolated-filesystem");
    expect(screen.getByText("Draft", { selector: ".approval-request-preview__state" })).toBeInTheDocument();
    expect(screen.getByText("high", { selector: ".is-high" })).toBeInTheDocument();
  });

  it("validates exact target, rationale, custom expiry, and secret policy before staging", () => {
    const invalid = {
      ...DEFAULT_APPROVAL_REQUEST,
      operation: "use-secret" as const,
      target: " ",
      rationale: " ",
      expiry: "custom" as const,
      customExpiry: "",
    };
    expect(approvalRequestValidation(invalid)).toEqual([
      "An exact target is required.",
      "A rationale is required for review.",
      "Choose a custom expiry timestamp.",
      "Secret use is blocked by the selected secret policy.",
    ]);
    expect(approvalRequestRisk(invalid)).toBe("high");

    render(<ApprovalRequestPreview />);
    fireEvent.change(screen.getByRole("textbox", { name: "Approval request target" }), { target: { value: " " } });
    fireEvent.click(screen.getByRole("button", { name: "Stage for review" }));
    expect(screen.getByRole("alert")).toHaveTextContent("An exact target is required.");
    expect(screen.getByRole("status")).toHaveTextContent(/Cannot stage this preview yet/i);
  });

  it("rehearses stage, revoke, restore, undo, and redo without calling it a native approval", () => {
    render(<ApprovalRequestPreview />);

    fireEvent.click(screen.getByRole("button", { name: "Stage for review" }));
    expect(screen.getByText("Staged for review", { selector: ".approval-request-preview__state" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/No approval receipt was created/i);

    fireEvent.click(screen.getByRole("button", { name: "Revoke preview" }));
    expect(screen.getByText("Revoked in preview", { selector: ".approval-request-preview__state" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore draft" }));
    expect(screen.getByText("Draft", { selector: ".approval-request-preview__state" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo approval request preview change" }));
    expect(screen.getByText("Revoked in preview", { selector: ".approval-request-preview__state" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Redo approval request preview change" }));
    expect(screen.getByText("Draft", { selector: ".approval-request-preview__state" })).toBeInTheDocument();
  });

  it("keeps request exports free of receipt and secret material", () => {
    const payload = safeApprovalRequestPayload(DEFAULT_APPROVAL_REQUEST);
    expect(payload.scope).toBe("omnia.approval-request.preview.v1");
    expect(JSON.stringify(payload)).toMatch(/renderer-local approval rehearsal only/i);
    expect(JSON.stringify(payload)).not.toContain("credential");
    expect(JSON.stringify(payload)).not.toContain("receiptId");
  });

  it("marks project scope but stays session-only", () => {
    render(<ApprovalRequestPreview projectId="project-alpha" />);
    expect(screen.getByText("Project-scoped renderer rehearsal")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Project-scoped approval request draft ready/i);
  });
});
