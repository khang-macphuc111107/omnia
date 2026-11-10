import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SecurityPolicyPreview } from "./security-policy-preview";

describe("Security policy preview", () => {
  it("renders posture profiles and keeps the boundary visible", () => {
    render(<SecurityPolicyPreview />);

    expect(screen.getByRole("heading", { name: "Security policy preview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use Explore all (visual) security profile" })).toBeInTheDocument();
    expect(screen.getByText(/does not grant native authority/i, { selector: "p" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Security policy Network" })).toHaveValue("approved-hosts");
    expect(screen.getByRole("heading", { name: "Compare guardrail profiles" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Compare left security profile" })).toHaveValue("balanced");
    expect(screen.getByRole("combobox", { name: "Compare right security profile" })).toHaveValue("developer");
  });

  it("compares two declared profiles without changing the active policy draft", () => {
    render(<SecurityPolicyPreview />);

    fireEvent.change(screen.getByRole("combobox", { name: "Compare left security profile" }), { target: { value: "lockdown" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Compare right security profile" }), { target: { value: "explore-all" } });

    expect(screen.getByRole("list", { name: "Profile comparison differences" })).toHaveTextContent(/Unknown operations/i);
    expect(screen.getByRole("combobox", { name: "Security policy Network" })).toHaveValue("approved-hosts");
    expect(screen.getByText(/descriptive preview signals/i)).toBeInTheDocument();
  });

  it("applies a profile and supports reversible fine-grained edits", () => {
    render(<SecurityPolicyPreview />);

    fireEvent.click(screen.getByRole("button", { name: "Use Lockdown security profile" }));
    expect(screen.getByRole("combobox", { name: "Security policy Network" })).toHaveValue("offline");
    expect(screen.getByRole("status")).toHaveTextContent(/Lockdown selected/i);

    fireEvent.change(screen.getByRole("combobox", { name: "Security policy Network" }), { target: { value: "public-https" } });
    expect(screen.getByRole("combobox", { name: "Security policy Network" })).toHaveValue("public-https");
    fireEvent.click(screen.getByRole("button", { name: "Undo security policy preview change" }));
    expect(screen.getByRole("combobox", { name: "Security policy Network" })).toHaveValue("offline");
    fireEvent.click(screen.getByRole("button", { name: "Redo security policy preview change" }));
    expect(screen.getByRole("combobox", { name: "Security policy Network" })).toHaveValue("public-https");
  });

  it("shows a change summary and can reset to Balanced defaults", () => {
    render(<SecurityPolicyPreview />);
    fireEvent.click(screen.getByRole("button", { name: "Use Explore all (visual) security profile" }));

    expect(screen.getByRole("heading", { name: "Change summary" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Security policy changes from Balanced" })).toHaveTextContent(/Unknown operations/i);
    expect(screen.getByText(/does not grant native authority/i, { selector: "p" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByRole("combobox", { name: "Security policy Network" })).toHaveValue("approved-hosts");
    expect(screen.getByRole("status")).toHaveTextContent(/reset to Balanced/i);
  });

  it("imports a policy JSON preview into the renderer session", async () => {
    render(<SecurityPolicyPreview />);
    const snapshot = new File([JSON.stringify({
      scope: "omnia.security-policy.preview.v1",
      version: 1,
      policy: {
        profile: "lockdown",
        confirmation: "every-operation",
        unknownOperations: "deny",
        network: "offline",
        filesystem: "approved-roots",
        secrets: "blocked",
        telemetry: "off",
        desktop: "blocked",
      },
    })], "omnia-security-policy.json", { type: "application/json" });

    fireEvent.change(screen.getByLabelText("Import security policy preview JSON"), { target: { files: [snapshot] } });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Security policy Network" })).toHaveValue("offline"));
    expect(screen.getByRole("status")).toHaveTextContent(/Imported security policy preview applied/i);
  });
});
