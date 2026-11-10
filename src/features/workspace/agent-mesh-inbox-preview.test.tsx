import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentMeshInboxPreview } from "./agent-mesh-inbox-preview";

describe("AgentMeshInboxPreview", () => {
  it("renders a triage queue with truthful preview wording", () => {
    render(<AgentMeshInboxPreview linkedWorkCount={2} />);

    expect(screen.getByRole("heading", { name: "Inbox triage cockpit" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Agent Mesh inbox messages" })).toHaveTextContent("Source-ledger projections are stale");
    expect(screen.getByRole("region", { name: "Agent Mesh inbox preview" })).toHaveTextContent("Renderer-local inbox rehearsal");
    expect(screen.getByRole("region", { name: "Agent Mesh inbox preview" })).toHaveTextContent("2 linked background items");
  });

  it("filters decision messages and supports bulk renderer-session triage", () => {
    render(<AgentMeshInboxPreview />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Needs decision" }));
    const list = screen.getByRole("list", { name: "Agent Mesh inbox messages" });
    expect(list).toHaveTextContent("Source-ledger projections are stale");
    expect(list).toHaveTextContent("Blocked child needs lease recovery review");
    expect(list).not.toHaveTextContent("Agent Mesh preview is ready");

    fireEvent.click(screen.getByRole("button", { name: "Select visible" }));
    fireEvent.click(screen.getByRole("button", { name: "Triage selected" }));
    expect(screen.getByRole("status")).toHaveTextContent("Triaged 3 messages");
    expect(screen.getByRole("region", { name: "Agent Mesh inbox preview" })).toHaveTextContent("No native mailbox mutation was made");
  });

  it("exposes route summaries and can return a route to the queue", () => {
    render(<AgentMeshInboxPreview />);

    fireEvent.click(screen.getByRole("tab", { name: "Routes" }));
    expect(screen.getByRole("tabpanel", { name: "Inbox routes" })).toHaveTextContent("Evidence researcher → Omnia orchestrator");
    fireEvent.click(within(screen.getByRole("tabpanel", { name: "Inbox routes" })).getByRole("button", { name: "Open route Evidence researcher → Omnia orchestrator" }));
    expect(screen.getByRole("tab", { name: "Triage queue" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("list", { name: "Agent Mesh inbox messages" })).toHaveTextContent("Source-ledger projections are stale");
  });

  it("keeps selected message actions and session tags local", () => {
    render(<AgentMeshInboxPreview />);

    const detail = screen.getByRole("complementary", { name: "Selected inbox message" });
    fireEvent.click(within(detail).getByRole("button", { name: "Escalate" }));
    expect(detail).toHaveTextContent("Escalated");
    fireEvent.change(within(detail).getByRole("textbox", { name: "Session tag" }), { target: { value: "needs-review" } });
    fireEvent.click(within(detail).getByRole("button", { name: "Add session tag" }));
    expect(detail).toHaveTextContent("#needs-review");
    expect(screen.getByRole("status")).toHaveTextContent("renderer session");
  });

  it("records preview actions in the session activity tab", () => {
    render(<AgentMeshInboxPreview />);

    fireEvent.click(screen.getByRole("button", { name: "Prepare reply" }));
    fireEvent.click(screen.getByRole("tab", { name: "Session activity" }));
    const activity = screen.getByRole("tabpanel", { name: "Inbox session activity" });
    expect(activity).toHaveTextContent("Prepared a reply draft");
    expect(activity).toHaveTextContent("no durable receipt");
  });
});
