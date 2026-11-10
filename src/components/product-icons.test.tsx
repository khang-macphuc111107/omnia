import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OmniaLogo } from "./omnia-logo";
import { ProductIcon, type ProductIconName } from "./product-icons";

const productIconNames: ProductIconName[] = [
  "agent",
  "artifact",
  "browser",
  "citation",
  "environment",
  "memory",
  "model",
  "plan",
  "run",
  "skill",
  "task",
  "terminal",
];

describe("Omnia visual identity", () => {
  it("renders the complete semantic product-icon vocabulary", () => {
    const { container } = render(
      <>
        {productIconNames.map((name) => (
          <ProductIcon key={name} name={name} />
        ))}
      </>,
    );

    expect(
      [...container.querySelectorAll("[data-product-icon]")].map((icon) =>
        icon.getAttribute("data-product-icon"),
      ),
    ).toEqual(productIconNames);
    expect(container.querySelectorAll("svg[focusable='false']")).toHaveLength(
      productIconNames.length,
    );
  });

  it("keeps the product mark free from instance-specific paint servers", () => {
    const { container } = render(
      <>
        <OmniaLogo />
        <OmniaLogo compact tone="currentColor" variant="hex-core" />
      </>,
    );

    expect(container.querySelectorAll("defs, linearGradient, radialGradient")).toHaveLength(0);
    expect(container.querySelectorAll(".omnia-logo__aperture")).toHaveLength(2);
    expect(container.querySelectorAll(".omnia-logo__core")).toHaveLength(2);
    expect(container.querySelector(".omnia-logo--command-ring .omnia-logo__command")).toBeInTheDocument();
    expect(container.querySelector(".omnia-logo--hex-core .omnia-logo__command")).toBeNull();
  });
});
