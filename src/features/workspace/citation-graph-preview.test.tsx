import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CitationGraphPreview } from "./citation-graph-preview";

describe("citation graph preview", () => {
  it("renders the evidence map with explicit preview boundaries", () => {
    render(<CitationGraphPreview />);

    expect(screen.getByRole("region", { name: "Citation graph preview" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Citation graph" })).toBeInTheDocument();
    expect(screen.getByText("Preview only")).toBeInTheDocument();
    expect(screen.getAllByText("10/10").length).toBeGreaterThan(0);
    expect(screen.getByText(/No retrieval or verification is running here/i)).toBeInTheDocument();
  });

  it("filters nodes and lets the user inspect a connected record", () => {
    render(<CitationGraphPreview />);

    fireEvent.change(screen.getByRole("combobox", { name: "Citation graph node kind" }), {
      target: { value: "source" },
    });

    expect(screen.getByText("4/10")).toBeInTheDocument();
    expect(screen.getByText("No matching claims.")).toBeInTheDocument();

    const sourceButtons = screen.getAllByRole("button", { name: /Harness architecture notes/ });
    fireEvent.click(sourceButtons[0]!);
    expect(screen.getByRole("heading", { name: "Harness architecture notes" })).toBeInTheDocument();
    expect(screen.getByText(/Connected records/i)).toBeInTheDocument();
  });

  it("opens a portable export preview and switches format", () => {
    render(<CitationGraphPreview />);

    fireEvent.click(screen.getByRole("button", { name: "Export graph" }));
    expect(screen.getByRole("region", { name: "Citation graph export preview" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Citation graph export format" }), {
      target: { value: "markdown" },
    });
    const exportRegion = screen.getByRole("region", { name: "Citation graph export preview" });
    expect(exportRegion).toHaveTextContent("# Omnia citation graph preview");
    expect(exportRegion).toHaveTextContent(/No retrieval, provider request, source verification, or durable write/i);
  });

  it("focuses the selected node and its directly connected records", () => {
    render(<CitationGraphPreview />);

    fireEvent.change(screen.getByRole("combobox", { name: "Citation graph focus mode" }), {
      target: { value: "selected" },
    });

    expect(screen.getAllByText("5/10").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Showing the selected node and its directly connected records/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByRole("combobox", { name: "Citation graph focus mode" })).toHaveValue("all");
    expect(screen.getAllByText("10/10").length).toBeGreaterThanOrEqual(2);
  });

  it("labels the selected-neighborhood scope in export previews", () => {
    render(<CitationGraphPreview />);

    fireEvent.change(screen.getByRole("combobox", { name: "Citation graph focus mode" }), {
      target: { value: "selected" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Export graph" }));

    const exportRegion = screen.getByRole("region", { name: "Citation graph export preview" });
    expect(exportRegion).toHaveTextContent('"view": "selected-neighborhood"');
  });

  it("inspects a shortest path between two visible records", () => {
    render(<CitationGraphPreview />);

    fireEvent.change(screen.getByRole("combobox", { name: "Citation graph focus mode" }), {
      target: { value: "path" },
    });

    expect(screen.getByRole("region", { name: "Citation graph path inspector" })).toHaveTextContent(/Shortest path inspector/i);
    expect(screen.getByRole("combobox", { name: "Citation graph path start" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Citation graph path target" })).toBeInTheDocument();
    expect(screen.getByText(/breadth-first path/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Export graph" }));
    expect(screen.getByRole("region", { name: "Citation graph export preview" })).toHaveTextContent('"view": "shortest-path"');
  });

  it("summarizes connected clusters and focuses a selected cluster", () => {
    render(<CitationGraphPreview />);

    fireEvent.change(screen.getByRole("combobox", { name: "Citation graph focus mode" }), {
      target: { value: "cluster" },
    });

    expect(screen.getByRole("region", { name: "Citation graph cluster inspector" })).toHaveTextContent(/Connected cluster inspector/i);
    expect(screen.getByRole("button", { name: /Cluster 1/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cluster 2/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Cluster 2/ }));
    expect(screen.getByText("2/10")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Export graph" }));
    expect(screen.getByRole("region", { name: "Citation graph export preview" })).toHaveTextContent('"view": "connected-cluster"');
  });
});
