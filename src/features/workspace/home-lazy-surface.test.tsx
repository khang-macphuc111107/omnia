import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HomeLazySurface } from "./home-lazy-surface";

type DemoProps = { readonly value: string };

function demoModule() {
  return {
    default: ({ value }: DemoProps) => (
      <section role="region" aria-label="Loaded home preview">
        {value}
      </section>
    ),
  };
}

describe("HomeLazySurface", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps optional Home workbenches renderer-local while loading", async () => {
    let resolve: ((module: ReturnType<typeof demoModule>) => void) | undefined;
    const load = () => new Promise<ReturnType<typeof demoModule>>((next) => { resolve = next; });

    render(<HomeLazySurface label="Goals and tasks" load={load} props={{ value: "Goals ready" }} />);

    expect(screen.getByRole("status")).toHaveTextContent(/Loading Goals and tasks/);

    await act(async () => {
      resolve?.(demoModule());
    });

    expect(await screen.findByRole("region", { name: "Loaded home preview" })).toHaveTextContent("Goals ready");
  });

  it("retries a failed optional Home chunk without losing the shell boundary", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let attempt = 0;
    const load = vi.fn(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error("chunk unavailable"))
        : Promise.resolve(demoModule());
    });

    render(<HomeLazySurface label="Automation" load={load} props={{ value: "Automation ready" }} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Automation could not be opened/i);
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    expect(await screen.findByRole("region", { name: "Loaded home preview" })).toHaveTextContent("Automation ready");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("can dismiss a failed optional Home workbench while preserving honest boundaries", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const load = () => Promise.reject(new Error("chunk unavailable"));

    render(<HomeLazySurface label="Release evidence" load={load} props={{ value: "unused" }} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/current workspace state is intact/i);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/native persistence|provider dispatch|filesystem access/i)).not.toBeInTheDocument();
  });
});
