import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectDeckLazySurface } from "./project-deck-lazy-surface";

type DemoProps = { readonly value: string };

function demoModule() {
  return {
    default: ({ value }: DemoProps) => (
      <section role="region" aria-label="Loaded project workbench">
        {value}
      </section>
    ),
  };
}

describe("ProjectDeckLazySurface", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows an honest renderer-local loading state and resolves the optional workbench", async () => {
    let resolve: ((module: ReturnType<typeof demoModule>) => void) | undefined;
    const load = () => new Promise<ReturnType<typeof demoModule>>((next) => { resolve = next; });

    render(
      <ProjectDeckLazySurface
        label="Project context"
        load={load}
        props={{ value: "Context ready" }}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(/Loading Project context/i);
    expect(screen.getByText(/optional project workbench is loading/i)).toBeInTheDocument();

    await act(async () => {
      resolve?.(demoModule());
    });

    expect(await screen.findByRole("region", { name: "Loaded project workbench" })).toHaveTextContent(
      "Context ready",
    );
  });

  it("retries a failed optional workbench without exposing loader diagnostics", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let attempt = 0;
    const load = vi.fn(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error("C:\\private\\project-deck.js?token=secret"))
        : Promise.resolve(demoModule());
    });

    render(
      <ProjectDeckLazySurface
        label="Project IDE"
        load={load}
        props={{ value: "IDE ready" }}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/Project IDE could not be opened/i);
    expect(screen.getByRole("alert")).not.toHaveTextContent(/private|token=secret/i);

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    expect(await screen.findByRole("region", { name: "Loaded project workbench" })).toHaveTextContent(
      "IDE ready",
    );
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("can dismiss a failed optional workbench while preserving the surrounding shell", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const load = () => Promise.reject(new Error("chunk unavailable"));

    render(
      <ProjectDeckLazySurface
        label="Project Twin"
        load={load}
        props={{ value: "unused" }}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/current workspace state is intact/i);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/native persistence|provider dispatch|filesystem access/i)).not.toBeInTheDocument();
  });
});
