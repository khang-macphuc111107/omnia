import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentMeshPreview } from "./agent-mesh-preview";

describe("AgentMeshPreview", () => {
  it("renders a bounded graph with truthful renderer-only wording", () => {
    render(<AgentMeshPreview linkedWorkCount={3} />);

    expect(screen.getByRole("heading", { name: "Agent Mesh & coordination" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Agent graph" })).toHaveTextContent("Omnia orchestrator");
    expect(screen.getByRole("list", { name: "Agent graph" })).toHaveTextContent("Truthfulness verifier");
    expect(screen.getByRole("region", { name: "Agent mesh coordination preview" })).toHaveTextContent("Renderer-local coordination preview");
    expect(screen.getByRole("region", { name: "Agent mesh coordination preview" })).toHaveTextContent("3 visible background items");
  });

  it("filters attention agents and exposes selected-agent rehearsal actions", () => {
    render(<AgentMeshPreview />);

    fireEvent.change(screen.getByRole("combobox", { name: "Agent mesh focus" }), { target: { value: "attention" } });
    const graph = screen.getByRole("list", { name: "Agent graph" });
    expect(within(graph).getByRole("button", { name: /Truthfulness verifier\. Blocked/i })).toBeInTheDocument();
    expect(within(graph).queryByRole("button", { name: /Omnia orchestrator/i })).not.toBeInTheDocument();

    fireEvent.click(within(graph).getByRole("button", { name: /Truthfulness verifier\. Blocked/i }));
    const detail = screen.getByRole("complementary", { name: "Selected agent detail" });
    expect(detail).toHaveTextContent("No provider or filesystem access");
    fireEvent.click(within(detail).getByRole("button", { name: /Reclaim lease/i }));
    expect(screen.getByRole("status")).toHaveTextContent("Renderer-local preview only");
  });

  it("switches between mailbox and leases without claiming native mutations", () => {
    render(<AgentMeshPreview />);

    fireEvent.click(screen.getByRole("tab", { name: /Mailbox/i }));
    expect(screen.getByRole("list", { name: "Agent mailbox messages" })).toHaveTextContent("source-ledger projections");
    fireEvent.click(screen.getByRole("button", { name: /^Acknowledge$/ }));
    expect(screen.getByRole("status")).toHaveTextContent("no native mutation");

    fireEvent.click(screen.getByRole("tab", { name: /Leases/i }));
    expect(screen.getByRole("list", { name: "Agent task leases" })).toHaveTextContent("task:ui-preview");
    expect(screen.getByRole("complementary", { name: "Selected agent lease" })).toHaveTextContent("cannot acquire, heartbeat, or release a native lease");
  });

  it("shows an illustrative lease lifecycle timeline without presenting native journal authority", () => {
    render(<AgentMeshPreview />);

    fireEvent.click(screen.getByRole("tab", { name: /Leases/i }));
    const detail = screen.getByRole("complementary", { name: "Selected agent lease" });
    const timeline = within(detail).getByRole("region", { name: "Lease lifecycle timeline" });

    expect(timeline).toHaveTextContent("Lifecycle timeline");
    expect(timeline).toHaveTextContent("Acquired");
    expect(timeline).toHaveTextContent("Renewed");
    expect(timeline).toHaveTextContent("Latest illustrative heartbeat");
    expect(timeline).toHaveTextContent("not a native journal, lease receipt, or recovery authority");
  });

  it("shows a lifecycle board that reuses the selected agent contract", () => {
    render(<AgentMeshPreview />);

    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    const board = screen.getByRole("list", { name: "Agent lifecycle board" });
    expect(board).toHaveTextContent("Running");
    expect(board).toHaveTextContent("Attention");
    expect(within(board).getByRole("button", { name: /Truthfulness verifier\. Blocked/i })).toBeInTheDocument();

    fireEvent.click(within(board).getByRole("button", { name: /Truthfulness verifier\. Blocked/i }));
    expect(screen.getByRole("complementary", { name: "Selected agent detail" })).toHaveTextContent("No provider or filesystem access");
    expect(screen.getByRole("region", { name: "Agent mesh coordination preview" })).toHaveTextContent("Moving agents between lanes is not available");
  });

  it("searches agents, mailbox messages, and leases without leaving stale detail visible", () => {
    render(<AgentMeshPreview />);

    const search = screen.getByRole("searchbox", { name: "Search mesh records" });
    fireEvent.change(search, { target: { value: "truthfulness" } });
    const graph = screen.getByRole("list", { name: "Agent graph" });
    expect(within(graph).getByRole("button", { name: /Truthfulness verifier\. Blocked/i })).toBeInTheDocument();
    expect(within(graph).queryByRole("button", { name: /UI builder/i })).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "no-such-record" } });
    fireEvent.click(screen.getByRole("tab", { name: /Mailbox/i }));
    expect(screen.getByRole("list", { name: "Agent mailbox messages" })).toHaveTextContent("No mailbox messages match the current search and filters");
    expect(screen.getByRole("complementary", { name: "Selected mailbox message" })).toHaveTextContent("Select a mailbox message");

    fireEvent.change(search, { target: { value: "source-ledger" } });
    const mailbox = screen.getByRole("list", { name: "Agent mailbox messages" });
    expect(within(mailbox).getByRole("button", { name: /source-ledger projections/i })).toBeInTheDocument();
    expect(within(mailbox).getAllByRole("button")).toHaveLength(1);

    fireEvent.click(screen.getByRole("tab", { name: /Leases/i }));
    fireEvent.change(search, { target: { value: "stale-verifier" } });
    const leases = screen.getByRole("list", { name: "Agent task leases" });
    expect(within(leases).getByRole("button", { name: /task:stale-verifier/i })).toBeInTheDocument();
    expect(within(leases).getAllByRole("button")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByRole("list", { name: "Agent task leases" })).toHaveTextContent("task:ui-preview");
  });

  it("filters mailbox delivery and sensitivity without changing the native boundary", () => {
    render(<AgentMeshPreview />);

    fireEvent.click(screen.getByRole("tab", { name: /Mailbox/i }));
    fireEvent.change(screen.getByRole("combobox", { name: "Mailbox delivery filter" }), { target: { value: "unread" } });
    const mailbox = screen.getByRole("list", { name: "Agent mailbox messages" });
    expect(mailbox).toHaveTextContent("Three source-ledger projections");
    expect(mailbox).toHaveTextContent("Should a blocked child");
    expect(mailbox).not.toHaveTextContent("Keep this slice renderer-local");

    fireEvent.change(screen.getByRole("combobox", { name: "Mailbox sensitivity filter" }), { target: { value: "sensitive" } });
    expect(mailbox).toHaveTextContent("Should a blocked child");
    expect(mailbox).not.toHaveTextContent("Three source-ledger projections");
    expect(screen.getByRole("region", { name: "Agent mesh coordination preview" })).toHaveTextContent("does not spawn agents, send mailbox messages");
  });

  it("supports visible mailbox selection and bulk acknowledgement as session-only triage", () => {
    render(<AgentMeshPreview />);

    fireEvent.click(screen.getByRole("tab", { name: /Mailbox/i }));
    fireEvent.click(screen.getByRole("button", { name: "Select visible" }));
    expect(screen.getByText("4 selected · 4 visible")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Acknowledge selected" }));
    expect(screen.getByRole("status")).toHaveTextContent("Acknowledged 4 mailbox messages in this renderer session");
    expect(screen.getByRole("tab", { name: /Mailbox/i })).toHaveTextContent("0");

    fireEvent.change(screen.getByRole("combobox", { name: "Mailbox delivery filter" }), { target: { value: "unread" } });
    expect(screen.getByRole("list", { name: "Agent mailbox messages" })).toHaveTextContent("No mailbox messages match the current search and filters");
    expect(screen.getByRole("region", { name: "Agent mesh coordination preview" })).toHaveTextContent("no native mutation was made");
  });

  it("keeps selection controls accessible when a mailbox record is selected", () => {
    render(<AgentMeshPreview />);

    fireEvent.click(screen.getByRole("tab", { name: /Mailbox/i }));
    fireEvent.click(screen.getByRole("button", { name: /Three source-ledger projections/i }));
    const detail = screen.getByRole("complementary", { name: "Selected mailbox message" });
    expect(detail).toHaveTextContent("Awaiting acknowledgement");
    fireEvent.click(within(detail).getByRole("button", { name: /^Acknowledge$/ }));
    expect(detail).toHaveTextContent("Acknowledged");
    expect(within(detail).getByRole("button", { name: /^Mark unread$/ })).toBeInTheDocument();
  });

  it("links mesh tabs to panels and supports roving keyboard navigation", () => {
    render(<AgentMeshPreview />);

    const tablist = screen.getByRole("tablist", { name: "Agent mesh view" });
    const meshTab = within(tablist).getByRole("tab", { name: "Mesh" });
    const mailboxTab = within(tablist).getByRole("tab", { name: /Mailbox/i });
    expect(meshTab).toHaveAttribute("aria-controls", "agent-mesh-panel-mesh");
    expect(meshTab).toHaveAttribute("tabindex", "0");
    expect(mailboxTab).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tabpanel", { name: "Mesh" })).toHaveAttribute("aria-labelledby", meshTab.id);

    meshTab.focus();
    fireEvent.keyDown(meshTab, { key: "ArrowRight" });
    const boardTab = within(tablist).getByRole("tab", { name: "Board" });
    expect(boardTab).toHaveFocus();
    expect(boardTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: /Board/i })).toHaveAttribute("aria-labelledby", boardTab.id);

    fireEvent.keyDown(boardTab, { key: "ArrowRight" });
    expect(mailboxTab).toHaveFocus();
    expect(mailboxTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: /Mailbox/i })).toHaveAttribute("aria-labelledby", mailboxTab.id);
  });

  it("previews scoped JSON and Markdown exports without claiming native persistence", () => {
    render(<AgentMeshPreview />);

    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    const exportRegion = screen.getByRole("region", { name: "Agent mesh export preview" });
    expect(exportRegion).toHaveTextContent("No durable write");
    expect(within(exportRegion).getByRole("code")).toHaveTextContent("omnia.agent-mesh.preview.v1");

    fireEvent.change(within(exportRegion).getByRole("combobox", { name: "Agent mesh export scope" }), { target: { value: "attention" } });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent('"selection": "attention"');
    expect(within(exportRegion).getByRole("code")).toHaveTextContent("Truthfulness verifier");
    expect(within(exportRegion).getByRole("code")).not.toHaveTextContent("UI builder");

    fireEvent.change(within(exportRegion).getByRole("combobox", { name: "Agent mesh export format" }), { target: { value: "markdown" } });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent("# Omnia agent mesh preview");
    expect(within(exportRegion).getByRole("code")).toHaveTextContent("## Agents");
  });
});
