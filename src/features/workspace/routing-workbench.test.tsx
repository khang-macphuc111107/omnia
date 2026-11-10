import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { initialProviders } from "./mock-data";
import { RoutingWorkbench } from "./routing-workbench";

describe("RoutingWorkbench", () => {
  it("shows an explicit automatic route and allows a candidate route to be selected", () => {
    const onModelProfileChange = vi.fn();
    render(<RoutingWorkbench providers={initialProviders} modelProfileId="auto" onModelProfileChange={onModelProfileChange} />);

    expect(screen.getByRole("heading", { name: "Routing Workbench" })).toBeInTheDocument();
    expect(screen.getByText("Auto route")).toBeInTheDocument();
    const candidates = screen.getByRole("list", { name: "Eligible model routes" });
    fireEvent.click(within(candidates).getByRole("button", { name: /Atlas Reasoning/i }));
    expect(onModelProfileChange).toHaveBeenCalledWith("quality");
  });

  it("keeps fallback permissions visibly preview-only and filters local-only candidates", () => {
    render(<RoutingWorkbench providers={initialProviders} modelProfileId="auto" onModelProfileChange={() => undefined} />);

    fireEvent.change(screen.getAllByRole("combobox")[1]!, { target: { value: "approved-connections" } });
    expect(screen.getByText(/every destination needs explicit data-class approval/i)).toBeInTheDocument();
    fireEvent.change(screen.getAllByRole("combobox")[0]!, { target: { value: "local" } });
    expect(screen.getByText(/Only local candidates are selectable/i)).toBeInTheDocument();
    expect(screen.getByText(/does not store a policy/i)).toBeInTheDocument();
  });

  it("keeps routing policy choices reversible and preserves candidate button semantics", () => {
    render(<RoutingWorkbench providers={initialProviders} modelProfileId="auto" onModelProfileChange={() => undefined} />);

    const preference = screen.getAllByRole("combobox")[0]!;
    fireEvent.change(preference, { target: { value: "quality" } });
    expect(preference).toHaveValue("quality");
    expect(screen.getByText(/Routing policy changed in the renderer preview/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo routing preview change" }));
    expect(preference).toHaveValue("auto");
    fireEvent.click(screen.getByRole("button", { name: "Redo routing preview change" }));
    expect(preference).toHaveValue("quality");
    fireEvent.click(screen.getByRole("button", { name: "Reset routing preview" }));
    expect(preference).toHaveValue("auto");

    const candidates = screen.getByRole("list", { name: "Eligible model routes" });
    expect(within(candidates).getByRole("button", { name: /Atlas Reasoning/i })).toBeInTheDocument();
    expect(within(candidates).getAllByRole("listitem").length).toBeGreaterThan(0);
  });

  it("filters route candidates locally and keeps arrow navigation inside the visible set", () => {
    render(<RoutingWorkbench providers={initialProviders} modelProfileId="auto" onModelProfileChange={() => undefined} />);

    const search = screen.getByRole("textbox", { name: "Search route candidates" });
    fireEvent.change(search, { target: { value: "Atlas" } });
    const candidates = screen.getByRole("list", { name: "Eligible model routes" });
    expect(within(candidates).getByRole("button", { name: /Atlas Reasoning/i })).toBeInTheDocument();
    expect(within(candidates).queryByRole("button", { name: /Schema Guardian/i })).not.toBeInTheDocument();

    const capability = screen.getByRole("combobox", { name: "Route capability filter" });
    fireEvent.change(capability, { target: { value: "reasoning" } });
    expect(within(candidates).getByRole("button", { name: /Atlas Reasoning/i })).toBeInTheDocument();

    fireEvent.keyDown(within(candidates).getByRole("button", { name: /Atlas Reasoning/i }), { key: "Home" });
    expect(within(candidates).getByRole("button", { name: /Atlas Reasoning/i })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Reset route candidate filters" })).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Reset route candidate filters" }));
    expect(search).toHaveValue("");
    expect(capability).toHaveValue("all");
  });

  it("lets users save, apply, and remove renderer-local routing profiles", () => {
    const onModelProfileChange = vi.fn();
    render(<RoutingWorkbench providers={initialProviders} modelProfileId="auto" onModelProfileChange={onModelProfileChange} />);

    const name = screen.getByRole("textbox", { name: "Routing profile name" });
    fireEvent.change(name, { target: { value: "Fast local coding" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    expect(screen.getByRole("button", { name: "Apply Fast local coding routing profile" })).toBeInTheDocument();
    expect(screen.getByText(/saved for this renderer session/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Apply Local & private routing profile" }));
    expect(screen.getAllByRole("combobox")[0]).toHaveValue("local");

    fireEvent.click(screen.getByRole("button", { name: "Remove Fast local coding routing profile" }));
    expect(screen.queryByRole("button", { name: "Apply Fast local coding routing profile" })).not.toBeInTheDocument();
  });

  it("serializes the visible routing profile as a bounded portable preview", () => {
    render(<RoutingWorkbench providers={initialProviders} modelProfileId="auto" onModelProfileChange={() => undefined} />);

    const preview = screen.getByLabelText("Routing profile export preview");
    expect(preview).toHaveTextContent("omnia.routing-profile-preview.v1");
    expect(preview).toHaveTextContent("No native routing policy was written");
    expect(preview).toHaveTextContent("No provider fallback was authorized or dispatched");

    fireEvent.change(screen.getByRole("combobox", { name: "Routing profile export format" }), { target: { value: "markdown" } });
    expect(preview).toHaveTextContent("# Omnia routing profile preview");
    expect(preview).toHaveTextContent("## Boundary");
  });
});
