import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LazyLoadBoundary } from "./lazy-load-boundary";

function ThrowingChild({ error }: { error: Error }): never {
  throw error;
}

describe("LazyLoadBoundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("contains loader failures without exposing raw diagnostic text", () => {
    const onDismiss = vi.fn();
    const onRetry = vi.fn();

    render(
      <LazyLoadBoundary
        label="Command palette"
        resetKey="0"
        errorClassName="modal-scrim command-scrim"
        onDismiss={onDismiss}
        onRetry={onRetry}
      >
        <ThrowingChild error={new Error("C:\\private\\bundle\\command.js?token=secret")} />
      </LazyLoadBoundary>,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Command palette could not be opened");
    expect(alert).not.toHaveTextContent("private");
    expect(alert.closest(".modal-scrim")).toHaveClass("command-scrim");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("clears the contained failure when the retry key changes", () => {
    const onDismiss = vi.fn();
    const onRetry = vi.fn();
    const { rerender } = render(
      <LazyLoadBoundary
        label="Dialog"
        resetKey="0"
        onDismiss={onDismiss}
        onRetry={onRetry}
      >
        <ThrowingChild error={new Error("chunk failed")} />
      </LazyLoadBoundary>,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();

    rerender(
      <LazyLoadBoundary
        label="Dialog"
        resetKey="1"
        onDismiss={onDismiss}
        onRetry={onRetry}
      >
        <div>Recovered dialog module</div>
      </LazyLoadBoundary>,
    );

    expect(screen.getByText("Recovered dialog module")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
