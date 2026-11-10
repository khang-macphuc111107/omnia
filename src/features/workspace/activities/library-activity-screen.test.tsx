import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import LibraryActivityScreen from "./library-activity-screen";

describe("LibraryActivityScreen", () => {
  it("opens one workbench at a time and keeps the optional surfaces lazy", async () => {
    render(<LibraryActivityScreen />);

    const picker = screen.getByRole("combobox", { name: "Open workbench" });
    expect(picker).toHaveValue("research");
    // 19 workbenches minus Browser and IDE, which are rail views.
    expect(picker.querySelectorAll("option")).toHaveLength(17);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Research notebook" })).toBeInTheDocument());

    fireEvent.change(picker, { target: { value: "algorithms" } });
    await waitFor(() => expect(screen.getByRole("heading", { name: /Algorithm & CP Lab/i })).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Research notebook" })).not.toBeInTheDocument();
  });

  it("keeps renderer-local boundary copy with the selected workbench", async () => {
    render(<LibraryActivityScreen />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Research notebook" })).toBeInTheDocument());
    fireEvent.change(screen.getByRole("combobox", { name: "Open workbench" }), { target: { value: "algorithms" } });
    await waitFor(() => expect(screen.getByRole("heading", { name: /Algorithm & CP Lab/i })).toBeInTheDocument());

    expect(screen.getByRole("region", { name: /Algorithms workbench preview/i })).toHaveTextContent("Renderer-local");
  });

  it("groups every workbench in one keyboard-native picker without duplicating rail views", async () => {
    render(<LibraryActivityScreen />);

    const picker = screen.getByRole("combobox", { name: "Open workbench" });
    expect(screen.getByRole("group", { name: "Tools" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Research & writing" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Technical labs" })).toBeInTheDocument();
    // Browser and Code are rail views; Library must not offer a second entry point.
    expect(screen.queryByRole("navigation", { name: /quick switcher/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Sovereign Browser/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Sovereign IDE/i })).not.toBeInTheDocument();
    fireEvent.change(picker, { target: { value: "academic" } });

    expect(picker).toHaveValue("academic");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Academic Studio" })).toBeInTheDocument(), {
      timeout: 4000,
    });
  });
});

