import { webcrypto } from "node:crypto";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectContextPanel } from "./ProjectContextPanel";
import { GRANT, PROJECT, SESSION, contextService, deferred, pointer, preparedRun } from "./__tests__/context-fixtures";

beforeEach(() => { vi.stubGlobal("crypto", webcrypto); });

describe("ProjectContextPanel", () => {
  it("labels native unavailability and disables preview actions", () => {
    const service = contextService(false); render(<ProjectContextPanel projectId={PROJECT} sessionId={SESSION} service={service} />);
    expect(screen.getByText(/Native project context is unavailable in browser preview/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Link files" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Choose folder" })).toBeDisabled(); expect(service.initialize).not.toHaveBeenCalled();
  });

  it("requires an explicit project and provides root-owned close control", () => {
    const onClose = vi.fn(); render(<ProjectContextPanel projectId={null} sessionId={SESSION} service={contextService()} onClose={onClose} />);
    expect(screen.getByText(/Choose a project session to link files/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close project context" })); expect(onClose).toHaveBeenCalledOnce();
  });

  it("displays source-missing state, verified retained text and native pointer receipts", async () => {
    const service = contextService(); service.listPointers = vi.fn().mockResolvedValue([pointer({ sourceExists: false })]);
    render(<ProjectContextPanel projectId={PROJECT} sessionId={SESSION} projectName="Research" service={service} />);
    await waitFor(() => expect(screen.getByRole("option", { name: /hello.txt/ })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Linked file"), { target: { value: "pointer-a" } });
    expect(screen.getByText(/Source missing; retained snapshot is available/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Read retained snapshot" })); await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Load pointer receipts" })); await waitFor(() => expect(screen.getByText("receipt-a")).toBeInTheDocument());
  });

  it("builds a native snapshot, renders citations and delegates opening to root", async () => {
    const service = contextService(); const open = vi.fn(); render(<ProjectContextPanel projectId={PROJECT} sessionId={SESSION} service={service} onCitationOpen={open} preparedRun={preparedRun} />);
    await waitFor(() => expect(screen.getByRole("option", { name: /approved/ })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Approved folder"), { target: { value: GRANT } });
    fireEvent.click(screen.getByRole("button", { name: "Build index" })); await waitFor(() => expect(screen.getByText("index-a")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Search project context"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Retrieve citations" })); await waitFor(() => expect(screen.getByRole("button", { name: /Open citation hello.txt/ })).toBeInTheDocument());
    expect(screen.getByText(/Not admitted to provider input/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Open citation hello.txt/ }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ projectId: PROJECT, sessionId: SESSION, grantId: GRANT, relativePath: "hello.txt", chunkId: "chunk-a", startLine: 1 }));
  });

  it("does not render the old project's data when props change during a request", async () => {
    const service = contextService(); const late = deferred<ReturnType<typeof pointer>[]>();
    service.listPointers = vi.fn().mockImplementationOnce(() => late.promise).mockResolvedValue([]);
    const view = render(<ProjectContextPanel projectId={PROJECT} sessionId={SESSION} service={service} />);
    await waitFor(() => expect(service.listPointers).toHaveBeenCalledOnce()); service.listGrants = vi.fn().mockResolvedValue([]);
    view.rerender(<ProjectContextPanel projectId="project-b" sessionId="session-b" service={service} />);
    late.resolve([pointer()]); await waitFor(() => expect(service.listPointers).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("option", { name: /hello.txt/ })).not.toBeInTheDocument();
  });

  it("stops an in-flight index wait and labels the native cancellation limit", async () => {
    const service = contextService(); service.buildIndex = vi.fn().mockReturnValue(new Promise(() => undefined));
    render(<ProjectContextPanel projectId={PROJECT} sessionId={SESSION} service={service} />);
    await waitFor(() => expect(screen.getByRole("option", { name: /approved/ })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Approved folder"), { target: { value: GRANT } }); fireEvent.click(screen.getByRole("button", { name: "Build index" }));
    await waitFor(() => expect(screen.getByText(/Native work has no cancellation command/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" })); expect(screen.getByRole("status")).toHaveTextContent(/late result will be ignored/);
  });

  it("shows denied native errors and requires reload after a failed picker batch", async () => {
    const service = contextService(); service.pickFiles = vi.fn().mockRejectedValue({ code: "permission_denied", message: "Read approval was denied" });
    render(<ProjectContextPanel projectId={PROJECT} sessionId={SESSION} service={service} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Link files" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Link files" })); await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Read approval was denied"));
    expect(service.pickFiles).toHaveBeenCalledOnce(); expect(screen.getByRole("button", { name: "Link files" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reload context" })).not.toBeDisabled();
  });

  it("keeps native actions fenced after closing and reopening while a picker is still pending", async () => {
    const service = contextService(); const late = deferred<Awaited<ReturnType<typeof service.pickFiles>>>(); service.pickFiles = vi.fn().mockReturnValue(late.promise);
    const first = render(<ProjectContextPanel projectId={PROJECT} sessionId={SESSION} service={service} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Link files" })).not.toBeDisabled()); fireEvent.click(screen.getByRole("button", { name: "Link files" }));
    await waitFor(() => expect(service.pickFiles).toHaveBeenCalledOnce()); first.unmount();
    render(<ProjectContextPanel projectId={PROJECT} sessionId={SESSION} service={service} />);
    await waitFor(() => expect(service.listPointers).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Reload context" })).not.toBeDisabled());
    expect(screen.getByRole("button", { name: "Link files" })).toBeDisabled(); expect(screen.getByText(/Native completion is uncertain/)).toBeInTheDocument();
    await act(async () => { late.resolve(null); }); fireEvent.click(screen.getByRole("button", { name: "Reload context" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Link files" })).not.toBeDisabled()); expect(service.pickFiles).toHaveBeenCalledOnce();
  });
});
