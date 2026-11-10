import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ContextPreflightPreview, { type ContextPreflightSource } from "./context-preflight-preview";

const sources: ContextPreflightSource[] = [
  {
    id: "folders",
    label: "Workspace folders",
    count: 2,
    estimatedTokens: 900,
    status: "review",
    detail: "Folder scope still needs native evidence.",
    selected: true,
  },
  {
    id: "instructions",
    label: "Project instructions",
    count: 1,
    estimatedTokens: 600,
    status: "ready",
    detail: "Selected for the renderer preview.",
    selected: true,
  },
  {
    id: "memories",
    label: "Relevant memories",
    count: 3,
    estimatedTokens: 480,
    status: "planned",
    detail: "Retrieval is planned.",
    selected: true,
  },
  {
    id: "skills",
    label: "Enabled skills",
    count: 0,
    estimatedTokens: 0,
    status: "excluded",
    detail: "No skills selected.",
    selected: false,
  },
];

describe("ContextPreflightPreview", () => {
  it("surfaces source, budget, and native-freeze gates", () => {
    render(<ContextPreflightPreview projectName="Omnia" projectHealth="not-compiled" sources={sources} estimatedTokens={1980} budgetTokens={3200} />);

    const region = screen.getByRole("region", { name: /preflight before compile/i });
    expect(region).toHaveTextContent("Workspace folders");
    expect(region).toHaveTextContent("Review");
    expect(region).toHaveTextContent("Authority and provenance");
    expect(region).toHaveTextContent(/Immutable context freeze/i);
    expect(region).toHaveTextContent(/native context revision/i);
    expect(region).toHaveTextContent(/Renderer-local/);
  });

  it("evaluates a blocked budget and exposes a renderer-local decision log", () => {
    render(<ContextPreflightPreview projectName="Omnia" projectHealth="not-compiled" sources={sources} estimatedTokens={4200} budgetTokens={3200} />);

    fireEvent.click(screen.getByRole("button", { name: /run preflight/i }));
    const region = screen.getByRole("region", { name: /preflight before compile/i });
    expect(within(region).getAllByText(/blocked source or budget gate/i)).not.toHaveLength(0);
    expect(screen.getByText(/Blocked in preview/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /preview decision log/i }));
    const log = screen.getByRole("code");
    expect(log).toHaveTextContent(/omnia\.context-preflight\.preview\.v2/);
    expect(log).toHaveTextContent(/no file read/i);
    expect(within(region).getByRole("combobox", { name: /report format/i })).toHaveValue("json");
  });

  it("records user exclusions and reasons in the decision log and recalculates the budget", () => {
    render(<ContextPreflightPreview projectName="Omnia" projectHealth="not-compiled" sources={sources} estimatedTokens={1980} budgetTokens={3200} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /include workspace folders in preflight/i }));
    expect(screen.getByRole("checkbox", { name: /include workspace folders in preflight/i })).not.toBeChecked();
    fireEvent.change(screen.getByRole("combobox", { name: /exclusion reason for workspace folders/i }), { target: { value: "sensitive" } });
    fireEvent.click(screen.getByRole("button", { name: /run preflight/i }));
    fireEvent.click(screen.getByRole("button", { name: /preview decision log/i }));

    const log = screen.getByRole("code");
    expect(log).toHaveTextContent('"estimatedTokens": 1080');
    expect(log).toHaveTextContent('"reasonCode": "sensitive"');
    expect(log).toHaveTextContent("Sensitive or private");
    expect(log).toHaveTextContent(/\"exclusions\"/);
  });

  it("keeps empty source groups unavailable rather than letting them be selected", () => {
    render(<ContextPreflightPreview projectName="Omnia" projectHealth="not-compiled" sources={sources} estimatedTokens={1980} budgetTokens={3200} />);

    const emptySkills = screen.getByRole("checkbox", { name: /include enabled skills in preflight/i });
    expect(emptySkills).toBeDisabled();
    expect(emptySkills).not.toBeChecked();
  });

  it("resets source exclusions to the incoming renderer snapshot", () => {
    render(<ContextPreflightPreview projectName="Omnia" projectHealth="not-compiled" sources={sources} estimatedTokens={1980} budgetTokens={3200} />);

    const folders = screen.getByRole("checkbox", { name: /include workspace folders in preflight/i });
    fireEvent.click(folders);
    expect(folders).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: /^reset$/i }));
    expect(folders).toBeChecked();
  });

  it("withholds the aggregate estimate when project access is blocked", () => {
    render(<ContextPreflightPreview projectName="Omnia" projectHealth="missing-access" sources={sources} estimatedTokens={1980} budgetTokens={3200} />);

    const region = screen.getByRole("region", { name: /preflight before compile/i });
    expect(region).toHaveTextContent(/Unknown|Withheld/);
    expect(region).toHaveTextContent(/Context access is blocked/i);
    expect(region).not.toHaveTextContent("62%");

    fireEvent.click(screen.getByRole("button", { name: /preview decision log/i }));
    expect(screen.getByRole("code")).toHaveTextContent('"estimatedTokens": null');
    expect(screen.getByRole("code")).toHaveTextContent('"estimateStatus": "withheld"');
  });

  it("blocks over-budget project health without exposing an aggregate admission estimate", () => {
    render(<ContextPreflightPreview projectName="Omnia" projectHealth="over-budget" sources={sources} estimatedTokens={6400} budgetTokens={3200} />);

    const region = screen.getByRole("region", { name: /preflight before compile/i });
    expect(region).toHaveTextContent(/aggregate budget admission is withheld/i);
    expect(region).toHaveTextContent(/Blocked in preview/i);
    expect(region).not.toHaveTextContent(/\d+%/);

    fireEvent.click(screen.getByRole("button", { name: /preview decision log/i }));
    expect(screen.getByRole("code")).toHaveTextContent('"estimatedTokens": null');
    expect(screen.getByRole("code")).toHaveTextContent('"estimateStatus": "withheld"');
  });

  it("lets the user choose a delivery mode and makes source admission explicit", () => {
    render(<ContextPreflightPreview projectName="Omnia" projectHealth="not-compiled" sources={sources} estimatedTokens={1980} budgetTokens={3200} />);

    const region = screen.getByRole("region", { name: /preflight before compile/i });
    const mode = within(region).getByRole("combobox", { name: "Context delivery mode" });
    expect(mode).toHaveValue("auto");

    fireEvent.change(mode, { target: { value: "full" } });
    expect(mode).toHaveValue("full");
    expect(region).toHaveTextContent(/Include every available source group/i);
    expect(within(region).getByRole("checkbox", { name: /include workspace folders in preflight/i })).toBeChecked();
    expect(within(region).getByRole("checkbox", { name: /include workspace folders in preflight/i })).toBeDisabled();

    fireEvent.change(mode, { target: { value: "manifest-only" } });
    expect(region).toHaveTextContent(/Send source metadata only/i);
    expect(within(region).getByRole("checkbox", { name: /include project instructions in preflight/i })).not.toBeChecked();

    fireEvent.click(within(region).getByRole("button", { name: /preview decision log/i }));
    expect(within(region).getByRole("code")).toHaveTextContent('"mode": "manifest-only"');
    expect(within(region).getByRole("code")).toHaveTextContent('"estimatedTokens": 0');
  });

  it("keeps required current input in the request when delivery is manifest-only", () => {
    const requiredSources: ContextPreflightSource[] = [
      {
        id: "draft",
        label: "Current draft",
        count: 1,
        estimatedTokens: 80,
        status: "ready",
        detail: "The user request remains required.",
        selected: true,
        required: true,
      },
      {
        id: "folders",
        label: "Workspace folders",
        count: 1,
        estimatedTokens: 500,
        status: "review",
        detail: "Folder scope still needs native evidence.",
        selected: true,
      },
    ];

    render(<ContextPreflightPreview projectName="Omnia" projectHealth="not-compiled" sources={requiredSources} estimatedTokens={580} budgetTokens={1000} />);
    const region = screen.getByRole("region", { name: /preflight before compile/i });
    fireEvent.change(within(region).getByRole("combobox", { name: "Context delivery mode" }), { target: { value: "manifest-only" } });

    const draft = within(region).getByRole("checkbox", { name: /include current draft in preflight/i });
    const folders = within(region).getByRole("checkbox", { name: /include workspace folders in preflight/i });
    expect(draft).toBeChecked();
    expect(draft).toBeDisabled();
    expect(folders).not.toBeChecked();

    fireEvent.click(within(region).getByRole("button", { name: /preview decision log/i }));
    expect(within(region).getByRole("code")).toHaveTextContent('"estimatedTokens": 80');
    expect(within(region).getByRole("code")).toHaveTextContent('"required": true');
  });
});
