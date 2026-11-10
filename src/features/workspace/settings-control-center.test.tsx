import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { desktop } from "@/lib/desktop";

import {
  SETTINGS_CONTROL_SECTIONS,
  SettingsControlCenter,
} from "./settings-control-center";

describe("Settings Control Center preview", () => {
  it("renders rich privacy controls and keeps undo local to the renderer", () => {
    render(<SettingsControlCenter section="privacy" />);

    expect(screen.getByRole("heading", { name: "Omnia Control Center" })).toBeInTheDocument();
    expect(screen.getByText("Privacy & memory")).toBeInTheDocument();
    expect(screen.getByText(/native retention, encryption, memory writes/i)).toBeInTheDocument();

    const memoryToggle = screen.getByRole("checkbox", { name: "Suggest memories from chats" });
    expect(memoryToggle).toBeChecked();
    fireEvent.click(memoryToggle);
    expect(memoryToggle).not.toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent(/changed in the renderer preview/i);

    fireEvent.click(screen.getByRole("button", { name: "Undo preview change" }));
    expect(memoryToggle).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Redo preview change" }));
    expect(memoryToggle).not.toBeChecked();
  });

  it("filters controls and restores defaults with section/all reset affordances", () => {
    render(<SettingsControlCenter section="storage" />);

    const rootInput = screen.getByRole("textbox", { name: "Workspace root hint" });
    fireEvent.change(rootInput, { target: { value: "D:\\omnia-preview" } });
    expect(rootInput).toHaveValue("D:\\omnia-preview");

    const filter = screen.getByRole("textbox", { name: "Filter Control Center options" });
    fireEvent.change(filter, { target: { value: "attachment" } });
    expect(screen.getByRole("combobox", { name: "Attachment budget" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Workspace root hint" })).not.toBeInTheDocument();

    fireEvent.change(filter, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset section" }));
    expect(screen.getByRole("textbox", { name: "Workspace root hint" })).toHaveValue("C:\\Users\\khang\\source\\repos\\omnia");

    fireEvent.change(screen.getByRole("textbox", { name: "Workspace root hint" }), { target: { value: "D:\\omnia-preview" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
    expect(screen.getByRole("textbox", { name: "Workspace root hint" })).toHaveValue("C:\\Users\\khang\\source\\repos\\omnia");

    const exportPanel = screen.getByText("Keep your choices inspectable").closest("aside");
    expect(exportPanel).not.toBeNull();
    expect(within(exportPanel!).getByRole("button", { name: "Export JSON" })).toBeInTheDocument();
    expect(within(exportPanel!).getByRole("button", { name: "Import JSON" })).toBeInTheDocument();
  });

  it("resets one option as an undoable change without disturbing sibling options", () => {
    render(<SettingsControlCenter section="storage" />);

    const rootInput = screen.getByRole("textbox", { name: "Workspace root hint" });
    const snapshotsToggle = screen.getByRole("checkbox", { name: "Create recovery snapshots" });
    fireEvent.change(rootInput, { target: { value: "D:\\omnia-option-reset" } });
    fireEvent.click(snapshotsToggle);

    fireEvent.click(screen.getByRole("button", { name: "Reset Workspace root hint to default" }));
    expect(rootInput).toHaveValue("C:\\Users\\khang\\source\\repos\\omnia");
    expect(snapshotsToggle).not.toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent(/Workspace root hint was reset/i);

    fireEvent.click(screen.getByRole("button", { name: "Undo preview change" }));
    expect(rootInput).toHaveValue("D:\\omnia-option-reset");
    expect(snapshotsToggle).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Redo preview change" }));
    expect(rootInput).toHaveValue("C:\\Users\\khang\\source\\repos\\omnia");
  });

  it("imports a matching renderer snapshot without touching native state", async () => {
    render(<SettingsControlCenter section="storage" />);

    const rootInput = screen.getByRole("textbox", { name: "Workspace root hint" });
    const snapshot = new File([
      JSON.stringify({
        scope: "renderer-preview",
        version: 1,
        section: "storage",
        values: {
          workspaceRoot: "D:\\omnia-imported",
          attachmentQuota: "10-gb",
          snapshots: false,
          backupFormat: "jsonl",
          keepVersions: 24,
        },
      }),
    ], "omnia-storage-preview.json", { type: "application/json" });

    fireEvent.change(screen.getByLabelText("Import Control Center preview JSON"), {
      target: { files: [snapshot] },
    });

    await waitFor(() => expect(rootInput).toHaveValue("D:\\omnia-imported"));
    expect(screen.getByRole("combobox", { name: "Attachment budget" })).toHaveValue("10-gb");
    expect(screen.getByRole("checkbox", { name: "Create recovery snapshots" })).not.toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent(/renderer preview JSON imported/i);
  });

  it("moves all Control Center sections as one renderer-only bundle", async () => {
    const { rerender } = render(<SettingsControlCenter section="storage" />);

    fireEvent.change(screen.getByRole("textbox", { name: "Workspace root hint" }), {
      target: { value: "D:\\portable-omnia" },
    });
    expect(screen.getByRole("button", { name: "Reset section" })).toBeEnabled();

    rerender(<SettingsControlCenter section="network" />);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Request timeout" }), {
      target: { value: "75" },
    });

    fireEvent.change(screen.getByRole("combobox", { name: "Control Center snapshot scope" }), {
      target: { value: "all" },
    });
    expect(
      screen.getByText(
        new RegExp("Move all " + SETTINGS_CONTROL_SECTIONS.length + " preview sections", "i"),
      ),
    ).toBeInTheDocument();

    const bundle = new File([
      JSON.stringify({
        scope: "renderer-preview-bundle",
        version: 1,
        sections: {
          privacy: {
            memoryRetention: "30-days",
            proposeMemories: false,
            redactSensitive: true,
            learningLog: true,
            conversationIndexing: "active-chat",
          },
          storage: {
            workspaceRoot: "E:\\omnia-restored",
            attachmentQuota: "10-gb",
            snapshots: false,
            backupFormat: "markdown",
            keepVersions: 18,
          },
          network: {
            transport: "local-first",
            requestTimeout: 90,
            proxyMode: "direct",
            strictTls: true,
            offlineFallback: false,
          },
          desktop: {
            launchAtLogin: false,
            trayMode: "minimize",
            shortcut: "Ctrl+Shift+K",
            confirmDestructive: true,
            updateChannel: "preview",
          },
          diagnostics: {
            logLevel: "debug",
            traceWindow: "session",
            includeUiEvents: true,
            includeProviderMetadata: false,
            autoShareReports: false,
          },
        },
      }),
    ], "omnia-control-center-preview.json", { type: "application/json" });

    fireEvent.change(screen.getByLabelText("Import Control Center preview JSON"), {
      target: { files: [bundle] },
    });

    await waitFor(() => expect(screen.getByRole("spinbutton", { name: "Request timeout" })).toHaveValue(90));
    expect(screen.getByRole("combobox", { name: "Transport mode" })).toHaveValue("local-first");
    expect(screen.getByRole("status")).toHaveTextContent(/5 sections changed/i);

    rerender(<SettingsControlCenter section="storage" />);
    expect(screen.getByRole("textbox", { name: "Workspace root hint" })).toHaveValue("E:\\omnia-restored");
    expect(screen.getByRole("combobox", { name: "Preferred export format" })).toHaveValue("markdown");
  });

  it("does not add no-op reset or import steps to preview history", async () => {
    render(<SettingsControlCenter section="privacy" />);

    expect(screen.getByRole("button", { name: "Reset section" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset all" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Undo preview change" })).toBeDisabled();

    const identicalSnapshot = new File([
      JSON.stringify({
        scope: "renderer-preview",
        version: 1,
        section: "privacy",
        values: {
          memoryRetention: "90-days",
          proposeMemories: true,
          redactSensitive: true,
          learningLog: true,
          conversationIndexing: "active-project",
        },
      }),
    ], "omnia-privacy-preview.json", { type: "application/json" });

    fireEvent.change(screen.getByLabelText("Import Control Center preview JSON"), {
      target: { files: [identicalSnapshot] },
    });

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/already matches/i));
    expect(screen.getByRole("button", { name: "Undo preview change" })).toBeDisabled();
  });

  it("reports ignored values when a section import produces no change", async () => {
    render(<SettingsControlCenter section="privacy" />);

    const snapshot = new File([
      JSON.stringify({
        scope: "renderer-preview",
        version: 1,
        section: "privacy",
        values: { memoryRetention: "not-a-valid-retention" },
      }),
    ], "omnia-invalid-privacy-preview.json", { type: "application/json" });

    fireEvent.change(screen.getByLabelText("Import Control Center preview JSON"), {
      target: { files: [snapshot] },
    });

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/No section preview changes applied/i));
    expect(screen.getByRole("status")).toHaveTextContent(/ignored invalid values for Memory retention/i);
    expect(screen.getByRole("button", { name: "Undo preview change" })).toBeDisabled();
  });

  it("reports omitted sections when an all-sections import has no usable changes", async () => {
    render(<SettingsControlCenter section="storage" />);

    fireEvent.change(screen.getByRole("combobox", { name: "Control Center snapshot scope" }), {
      target: { value: "all" },
    });
    const bundle = new File([
      JSON.stringify({
        scope: "renderer-preview-bundle",
        version: 1,
        sections: {},
      }),
    ], "omnia-empty-control-center-preview.json", { type: "application/json" });

    fireEvent.change(screen.getByLabelText("Import Control Center preview JSON"), {
      target: { files: [bundle] },
    });

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/No all-sections preview changes applied/i));
    expect(screen.getByRole("status")).toHaveTextContent(/Privacy & memory was not included/i);
    expect(screen.getByRole("button", { name: "Undo preview change" })).toBeDisabled();
  });

  it("keeps history isolated by section and clears redo after a divergent edit", () => {
    const { rerender } = render(<SettingsControlCenter section="privacy" />);

    const memoryToggle = screen.getByRole("checkbox", { name: "Suggest memories from chats" });
    fireEvent.click(memoryToggle);
    fireEvent.click(screen.getByRole("button", { name: "Undo preview change" }));
    expect(screen.getByRole("button", { name: "Redo preview change" })).toBeEnabled();

    rerender(<SettingsControlCenter section="network" />);
    expect(screen.getByRole("button", { name: "Undo preview change" })).toBeDisabled();

    const timeout = screen.getByRole("spinbutton", { name: "Request timeout" });
    fireEvent.change(timeout, { target: { value: "75" } });
    fireEvent.click(screen.getByRole("button", { name: "Undo preview change" }));
    expect(timeout).toHaveValue(45);
    expect(screen.getByRole("button", { name: "Redo preview change" })).toBeEnabled();

    rerender(<SettingsControlCenter section="privacy" />);
    expect(screen.getByRole("button", { name: "Undo preview change" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo preview change" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Redo preview change" }));
    expect(screen.getByRole("checkbox", { name: "Suggest memories from chats" })).not.toBeChecked();

    fireEvent.click(screen.getByRole("checkbox", { name: "Redact sensitive fields in previews" }));
    expect(screen.getByRole("button", { name: "Redo preview change" })).toBeDisabled();
  });

  it("keeps Reset all reversible for every changed section", () => {
    const { rerender } = render(<SettingsControlCenter section="storage" />);

    const rootInput = screen.getByRole("textbox", { name: "Workspace root hint" });
    fireEvent.change(rootInput, { target: { value: "D:\\omnia-history" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Create recovery snapshots" }));

    rerender(<SettingsControlCenter section="network" />);
    const timeout = screen.getByRole("spinbutton", { name: "Request timeout" });
    fireEvent.change(timeout, { target: { value: "75" } });

    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
    expect(timeout).toHaveValue(45);

    rerender(<SettingsControlCenter section="storage" />);
    expect(screen.getByRole("textbox", { name: "Workspace root hint" })).toHaveValue("C:\\Users\\khang\\source\\repos\\omnia");
    expect(screen.getByRole("checkbox", { name: "Create recovery snapshots" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Undo preview change" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Undo preview change" }));
    expect(screen.getByRole("textbox", { name: "Workspace root hint" })).toHaveValue("D:\\omnia-history");
    expect(screen.getByRole("checkbox", { name: "Create recovery snapshots" })).not.toBeChecked();

    rerender(<SettingsControlCenter section="network" />);
    expect(screen.getByRole("button", { name: "Undo preview change" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Undo preview change" }));
    expect(screen.getByRole("spinbutton", { name: "Request timeout" })).toHaveValue(75);
  });

  it("applies built-in section presets as one reversible renderer preview step", () => {
    render(<SettingsControlCenter section="network" />);

    const transport = screen.getByRole("combobox", { name: "Transport mode" });
    const timeout = screen.getByRole("spinbutton", { name: "Request timeout" });
    expect(transport).toHaveValue("https-only");
    expect(timeout).toHaveValue(45);

    fireEvent.click(screen.getByRole("button", { name: "Apply Local-first preset" }));
    expect(transport).toHaveValue("local-first");
    expect(timeout).toHaveValue(60);
    expect(screen.getByRole("status")).toHaveTextContent(/local-first applied/i);

    fireEvent.click(screen.getByRole("button", { name: "Undo preview change" }));
    expect(transport).toHaveValue("https-only");
    expect(timeout).toHaveValue(45);
  });

  it("keeps saved Control Center presets renderer-local and removable", () => {
    render(<SettingsControlCenter section="desktop" />);

    fireEvent.change(screen.getByRole("textbox", { name: "Command palette shortcut" }), {
      target: { value: "Ctrl+Shift+O" },
    });
    const name = screen.getByRole("textbox", { name: "Save current Control Center preset" });
    fireEvent.change(name, { target: { value: "Office desktop" } });
    fireEvent.click(screen.getByRole("button", { name: "Save preset" }));

    const savedPreset = screen.getByRole("button", { name: "Apply Office desktop preset" });
    expect(savedPreset).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/renderer session.*native profile persistence remains planned/i);

    fireEvent.change(screen.getByRole("textbox", { name: "Command palette shortcut" }), {
      target: { value: "Ctrl+Alt+P" },
    });
    fireEvent.click(savedPreset);
    expect(screen.getByRole("textbox", { name: "Command palette shortcut" })).toHaveValue("Ctrl+Shift+O");

    fireEvent.click(screen.getByRole("button", { name: "Remove Office desktop custom preset" }));
    expect(screen.queryByRole("button", { name: "Apply Office desktop preset" })).not.toBeInTheDocument();
  });

  it("imports custom presets alongside a section snapshot without requiring native persistence", async () => {
    render(<SettingsControlCenter section="desktop" />);

    const snapshot = new File([
      JSON.stringify({
        scope: "renderer-preview",
        version: 1,
        section: "desktop",
        values: {
          launchAtLogin: true,
          trayMode: "minimize",
          shortcut: "Ctrl+Shift+P",
          confirmDestructive: true,
          updateChannel: "preview",
        },
        customPresets: [
          {
            id: "imported-demo",
            name: "Demo workstation",
            description: "A portable renderer-only desktop shape.",
            tone: "coral",
            values: {
              launchAtLogin: true,
              trayMode: "minimize",
              shortcut: "Ctrl+Shift+P",
              confirmDestructive: true,
              updateChannel: "preview",
            },
          },
        ],
      }),
    ], "omnia-desktop-preview.json", { type: "application/json" });

    fireEvent.change(screen.getByLabelText("Import Control Center preview JSON"), {
      target: { files: [snapshot] },
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Apply Demo workstation preset" })).toBeInTheDocument());
    expect(screen.getByRole("combobox", { name: "Window close behavior" })).toHaveValue("minimize");
    expect(screen.getByRole("status")).toHaveTextContent(/custom presets merged/i);
    expect(screen.getByText(/Native persistence remains planned/i)).toBeInTheDocument();
  });

  it("saves first change against an empty native store without expectedRevision=1 and flushes pending save on unmount", async () => {
    const loadSpy = vi.spyOn(desktop, "loadSettingsPermissionsSnapshot").mockResolvedValue({
      status: "empty",
    });
    const saveSpy = vi.spyOn(desktop, "saveSettingsPermissionsSnapshot").mockResolvedValue({
      status: "saved",
      revision: 1,
    });

    try {
      const { unmount } = render(
        <SettingsControlCenter
          section="privacy"
          runtime={{
            appName: "Omnia",
            appVersion: "0.1.0",
            platform: "windows",
            tauri: true,
            debug: true,
          }}
        />,
      );

      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent(/Native settings profile is empty/i),
      );
      expect(loadSpy).toHaveBeenCalledTimes(1);

      const memoryToggle = screen.getByRole("checkbox", { name: "Suggest memories from chats" });
      fireEvent.click(memoryToggle);

      // Unmount before the 200ms debounce timer fires to verify unmount flush + omitted expectedRevision
      unmount();

      await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(1));
      expect(saveSpy.mock.calls[0]?.[0]?.expectedRevision).toBeUndefined();
    } finally {
      loadSpy.mockRestore();
      saveSpy.mockRestore();
    }
  });

  it("serializes rapid sequential saves so the second save uses the revision returned by the first save", async () => {
    const loadSpy = vi.spyOn(desktop, "loadSettingsPermissionsSnapshot").mockResolvedValue({
      status: "empty",
    });
    let resolveFirstSave: ((value: { status: "saved"; revision: number }) => void) = () => {};
    const saveSpy = vi.spyOn(desktop, "saveSettingsPermissionsSnapshot")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstSave = resolve;
          }),
      )
      .mockResolvedValueOnce({
        status: "saved",
        revision: 2,
      });

    try {
      const { unmount } = render(
        <SettingsControlCenter
          section="privacy"
          runtime={{
            appName: "Omnia",
            appVersion: "0.1.0",
            platform: "windows",
            tauri: true,
            debug: true,
          }}
        />,
      );

      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent(/Native settings profile is empty/i),
      );

      const memoryToggle = screen.getByRole("checkbox", { name: "Suggest memories from chats" });
      fireEvent.click(memoryToggle);

      await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(1), { timeout: 1000 });
      expect(saveSpy.mock.calls[0]?.[0]?.expectedRevision).toBeUndefined();

      // Trigger a second change and unmount while the first save is still in-flight
      fireEvent.click(screen.getByRole("checkbox", { name: "Redact sensitive fields in previews" }));
      unmount();

      // Second save should wait for the first save to resolve
      expect(saveSpy).toHaveBeenCalledTimes(1);

      resolveFirstSave({
        status: "saved",
        revision: 1,
      });

      await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(2));
      expect(saveSpy.mock.calls[1]?.[0]?.expectedRevision).toBe(1);
    } finally {
      loadSpy.mockRestore();
      saveSpy.mockRestore();
    }
  });
});

