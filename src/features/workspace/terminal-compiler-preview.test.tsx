import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TerminalCompilerPreview } from "./terminal-compiler-preview";

describe("Terminal and compiler preview", () => {
  it("exposes toolchain, target, command, and policy controls", () => {
    render(<TerminalCompilerPreview projectName="Omnia Demo" filePath="src/main.ts" />);

    expect(screen.getByRole("heading", { name: "Terminal & compiler preview" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Compiler toolchain" })).toHaveValue("node");
    expect(screen.getByRole("combobox", { name: "Compiler target" })).toHaveValue("test");
    expect(screen.getByRole("textbox", { name: "Preview command" })).toHaveValue("npm run test -- src/main.test.ts");
    expect(screen.getByRole("region", { name: "Terminal preview output" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Compiler run options" })).toBeInTheDocument();
    expect(screen.getByText(/no process, compiler, shell, or filesystem access/i)).toBeInTheDocument();
  });

  it("switches toolchains, rehearses a command, and keeps the boundary visible", () => {
    render(<TerminalCompilerPreview projectName="Omnia Demo" filePath="src/main.ts" />);
    const output = screen.getByRole("region", { name: "Terminal preview output" });

    fireEvent.change(screen.getByRole("combobox", { name: "Compiler toolchain" }), { target: { value: "rust" } });
    expect(screen.getByRole("textbox", { name: "Preview command" })).toHaveValue("cargo test");
    fireEvent.change(screen.getByRole("combobox", { name: "Compiler target" }), { target: { value: "build" } });
    fireEvent.click(screen.getByRole("button", { name: "Run command preview" }));

    expect(within(output).getByText(/completed · no process, shell, compiler, network, or file write/i)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/no process was started/i);
    expect(screen.getByText(/Native compiler discovery.*Planned/i)).toBeInTheDocument();
  });

  it("resets and clears output without creating a durable run", () => {
    render(<TerminalCompilerPreview projectName="Omnia Demo" />);
    fireEvent.click(screen.getByRole("button", { name: "Clear terminal preview output" }));
    expect(screen.getByText(/Output cleared/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset terminal compiler preview" }));
    expect(screen.getByText(/Terminal preview reset/i)).toBeInTheDocument();
    expect(screen.getByText(/no durable run receipt/i)).toBeInTheDocument();
  });

  it("applies a built-in toolchain profile across command and run policy controls", () => {
    render(<TerminalCompilerPreview projectName="Omnia Demo" />);

    fireEvent.click(screen.getByRole("button", { name: "Apply Rust Tauri build toolchain profile" }));

    expect(screen.getByRole("combobox", { name: "Compiler toolchain" })).toHaveValue("rust");
    expect(screen.getByRole("combobox", { name: "Compiler target" })).toHaveValue("build");
    expect(screen.getByRole("combobox", { name: "Compiler profile" })).toHaveValue("debug");
    expect(screen.getByRole("textbox", { name: "Preview command" })).toHaveValue("cargo test");
    expect(screen.getByRole("button", { name: "Apply Rust Tauri build toolchain profile" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/Rust Tauri build selected.*no native toolchain was discovered/i)).toBeInTheDocument();
  });

  it("saves, removes, and previews a custom toolchain profile in the renderer session", () => {
    render(<TerminalCompilerPreview projectName="Omnia Demo" />);

    fireEvent.change(screen.getByRole("textbox", { name: "Preview command" }), { target: { value: "npm run lint" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Toolchain profile name" }), { target: { value: "Lint gate" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    expect(screen.getByRole("button", { name: "Apply Lint gate toolchain profile" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/Lint gate saved for this renderer session/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Terminal toolchain profile export preview")).toHaveTextContent(/omnia\.terminal-toolchain-profile-preview\.v1/);

    fireEvent.change(screen.getByRole("combobox", { name: "Toolchain profile export format" }), { target: { value: "markdown" } });
    expect(screen.getByLabelText("Terminal toolchain profile export preview")).toHaveTextContent(/# Omnia terminal toolchain profile preview/);

    fireEvent.click(screen.getByRole("button", { name: "Remove Lint gate toolchain profile" }));
    expect(screen.queryByRole("button", { name: "Apply Lint gate toolchain profile" })).not.toBeInTheDocument();
    expect(screen.getByText(/Lint gate removed from this renderer session/i)).toBeInTheDocument();
  });

  it("imports a validated JSON export as session-only profiles without running commands", () => {
    render(<TerminalCompilerPreview projectName="Omnia Demo" />);
    const exported = screen.getByLabelText("Terminal toolchain profile export preview").textContent ?? "";
    fireEvent.change(screen.getByRole("textbox", { name: "Terminal toolchain profile JSON to import" }), { target: { value: exported } });
    fireEvent.click(screen.getByRole("button", { name: "Import profile previews" }));

    expect(screen.getByRole("button", { name: "Apply Active terminal preview (imported current) toolchain profile" })).toBeInTheDocument();
    expect(screen.getByLabelText("Terminal profile import status")).toHaveTextContent(/Imported 5 profile previews into this renderer session only/i);
    expect(screen.getByText(/commands are never executed/i)).toBeInTheDocument();
  });

  it("rejects malformed profile imports without changing the saved profile list", () => {
    render(<TerminalCompilerPreview projectName="Omnia Demo" />);
    fireEvent.change(screen.getByRole("textbox", { name: "Terminal toolchain profile JSON to import" }), { target: { value: JSON.stringify({ schema: "wrong", savedProfiles: [] }) } });
    fireEvent.click(screen.getByRole("button", { name: "Import profile previews" }));

    expect(screen.getByText(/Import rejected: unsupported terminal profile schema/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /imported current.*toolchain profile/i })).not.toBeInTheDocument();
  });

  it("searches the ecosystem catalog and keeps planned entries disconnected from rehearsal", () => {
    render(<TerminalCompilerPreview projectName="Omnia Demo" />);

    fireEvent.change(screen.getByRole("textbox", { name: "Search toolchains" }), { target: { value: "CUDA" } });
    const catalog = screen.getByRole("complementary", { name: "Toolchain catalog" });
    expect(within(catalog).getByRole("button", { name: /CUDA Toolkit/ })).toBeInTheDocument();
    expect(within(catalog).queryByRole("button", { name: /Node.js/ })).not.toBeInTheDocument();

    fireEvent.click(within(catalog).getByRole("button", { name: /CUDA Toolkit/ }));
    expect(within(catalog).getByRole("region", { name: "CUDA Toolkit catalog details" })).toHaveTextContent(/no runtime was bundled, detected, or invoked/i);
    expect(within(catalog).getByRole("button", { name: "Native support planned" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Compiler toolchain" })).toHaveValue("node");
    expect(screen.getByRole("textbox", { name: "Preview command" })).toHaveValue("npm run test -- src/main.test.ts");
  });

  it("filters catalog entries by domain and applies only connected templates", () => {
    render(<TerminalCompilerPreview projectName="Omnia Demo" />);
    const catalog = screen.getByRole("complementary", { name: "Toolchain catalog" });

    fireEvent.click(within(catalog).getByRole("button", { name: /Science & data/ }));
    expect(within(catalog).getByRole("button", { name: /Julia/ })).toBeInTheDocument();
    expect(within(catalog).getByRole("button", { name: /Fortran/ })).toBeInTheDocument();

    fireEvent.click(within(catalog).getByRole("button", { name: /Python/ }));
    fireEvent.click(within(catalog).getByRole("button", { name: "Use template in rehearsal" }));
    expect(screen.getByRole("combobox", { name: "Compiler toolchain" })).toHaveValue("python");
    expect(screen.getByRole("textbox", { name: "Preview command" })).toHaveValue("python -m pytest");
    expect(screen.getByRole("status")).toHaveTextContent(/not a detected or installed toolchain/i);
  });

  it("compares two renderer-local profiles and highlights policy differences", () => {
    render(<TerminalCompilerPreview projectName="Omnia Demo" />);

    expect(screen.getByRole("region", { name: "Compare toolchain profiles" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Compare profile A" })).toHaveValue("terminal-node-test");
    expect(screen.getByRole("combobox", { name: "Compare profile B" })).toHaveValue("terminal-python-data");
    expect(screen.getByText("3 differences")).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Command npm run test -- src\/main\.test\.ts python -m pytest/ })).toHaveClass("is-different");
    expect(screen.getByText(/renderer-local and descriptive/i)).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Compare profile B" }), { target: { value: "terminal-node-test" } });

    expect(screen.getByText("0 differences")).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Command npm run test -- src\/main\.test\.ts npm run test -- src\/main\.test\.ts/ })).not.toHaveClass("is-different");
  });

  it("keeps comparison controls in sync with a saved custom profile and reset", () => {
    render(<TerminalCompilerPreview projectName="Omnia Demo" />);

    fireEvent.change(screen.getByRole("textbox", { name: "Preview command" }), { target: { value: "npm run lint" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Toolchain profile name" }), { target: { value: "Lint gate" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    const compareProfileA = screen.getByRole("combobox", { name: "Compare profile A" });
    const customOption = within(compareProfileA).getByRole("option", { name: "Lint gate" });
    fireEvent.change(compareProfileA, { target: { value: customOption.getAttribute("value") ?? "" } });
    expect(compareProfileA).toHaveValue(customOption.getAttribute("value"));
    expect(within(screen.getByRole("region", { name: "Compare toolchain profiles" })).getByText(/\d+ differences/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset terminal compiler preview" }));
    expect(screen.getByRole("combobox", { name: "Compare profile A" })).toHaveValue("terminal-node-test");
    expect(screen.getByRole("combobox", { name: "Compare profile B" })).toHaveValue("terminal-python-data");
  });
});
