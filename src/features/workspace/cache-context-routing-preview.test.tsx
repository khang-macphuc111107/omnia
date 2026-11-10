import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CacheContextRoutingPreview, DEFAULT_USER_MANAGED_CACHE_OBJECTS } from "./cache-context-routing-preview";

describe("CacheContextRoutingPreview", () => {
  it("exposes reversible local/provider controls and a prefix plan", () => {
    render(<CacheContextRoutingPreview />);

    expect(screen.getByRole("heading", { name: /Cache, context & route plan/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Local cache reuse mode" })).toHaveValue("safe-reuse");
    expect(screen.getByText(/Local reuse is not provider cache billing/i)).toBeInTheDocument();
    expect(screen.getByText("System + safety instructions")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Provider cache hint mode" }), { target: { value: "disabled" } });
    expect(screen.getByText(/Provider plan/i).parentElement).toHaveTextContent("blocked");

    fireEvent.click(screen.getByRole("button", { name: /Reset cache and context route draft/i }));
    expect(screen.getByRole("combobox", { name: "Provider cache hint mode" })).toHaveValue("auto");
  });

  it("can collapse and reopen the prefix plan", () => {
    render(<CacheContextRoutingPreview />);

    const toggle = screen.getByRole("button", { name: /Hide prefix plan/i });
    fireEvent.click(toggle);
    expect(screen.queryByText("System + safety instructions")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Show prefix plan/i }));
    expect(screen.getByText("System + safety instructions")).toBeInTheDocument();
  });

  it("inspects the redacted user-managed inventory and rehearses pin/invalidation actions", () => {
    render(<CacheContextRoutingPreview />);

    fireEvent.click(screen.getByRole("button", { name: /Inspect user-managed cache/i }));
    expect(screen.getByRole("region", { name: "User-managed cache inventory" })).toBeInTheDocument();
    expect(screen.getByText("Project context manifest")).toBeInTheDocument();
    expect(screen.getByText(/Demo inventory rows are seeded, redacted renderer data/i)).toBeInTheDocument();

    const pin = screen.getByRole("button", { name: /Unpin Project context manifest/i });
    fireEvent.click(pin);
    expect(screen.getByRole("button", { name: /Pin Project context manifest/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Invalidate stale and expired cache objects/i }));
    expect(screen.getByText(/marked invalidated in the renderer preview/i)).toBeInTheDocument();
  });

  it("exposes advanced cache policy controls without implying native writes", () => {
    render(<CacheContextRoutingPreview />);

    fireEvent.change(screen.getByRole("combobox", { name: "Local cache encryption boundary" }), { target: { value: "project-key" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Provider cache key strategy preview" }), { target: { value: "content-hash" } });
    expect(screen.getByRole("combobox", { name: "Local cache encryption boundary" })).toHaveValue("project-key");
    expect(screen.getByRole("combobox", { name: "Provider cache key strategy preview" })).toHaveValue("content-hash");
    expect(screen.getByText(/never sends cache hints/i)).toBeInTheDocument();
  });

  it("filters inventory states and only marks unpinned stale entries invalidated in the preview", () => {
    render(<CacheContextRoutingPreview />);
    fireEvent.click(screen.getByRole("button", { name: /Inspect user-managed cache/i }));
    const objects = screen.getByRole("list", { name: "Redacted local cache objects" });
    const filter = screen.getByRole("combobox", { name: "Local cache display filter" });
    expect(within(objects).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.change(filter, { target: { value: "reusable" } });
    expect(within(objects).getAllByRole("listitem")).toHaveLength(1);
    expect(within(objects).getByText("Project context manifest")).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: "invalidated" } });
    expect(within(objects).queryAllByRole("listitem")).toHaveLength(0);
    expect(within(objects).getByText(/No invalidated objects/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Invalidate stale and expired cache objects/i }));
    expect(within(objects).getAllByRole("listitem")).toHaveLength(2);
    expect(within(objects).getByText("README extraction")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Invalidate stale and expired cache objects/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Reset cache and context route draft/i }));
    expect(filter).toHaveValue("all");
    expect(within(objects).getAllByRole("listitem")).toHaveLength(3);
  });

  it("distinguishes explicit unknown from known blocked and stale states", () => {
    render(<CacheContextRoutingPreview initialLocalObjects={[
      ...DEFAULT_USER_MANAGED_CACHE_OBJECTS,
      { ...DEFAULT_USER_MANAGED_CACHE_OBJECTS[0]!, id: "missing-evidence", label: "Metadata unresolved", status: "unknown" },
      { ...DEFAULT_USER_MANAGED_CACHE_OBJECTS[0]!, id: "policy-blocked", label: "Policy blocked", status: "blocked" },
    ]} />);
    fireEvent.click(screen.getByRole("button", { name: /Inspect user-managed cache/i }));
    fireEvent.change(screen.getByRole("combobox", { name: "Local cache display filter" }), { target: { value: "unknown" } });
    const objects = screen.getByRole("list", { name: "Redacted local cache objects" });
    expect(within(objects).getByText("Metadata unresolved")).toBeInTheDocument();
    expect(within(objects).queryByText("Policy blocked")).not.toBeInTheDocument();
    expect(within(objects).queryByText("README extraction")).not.toBeInTheDocument();
  });
});
