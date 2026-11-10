import { describe, expect, it } from "vitest";

import { DomainError } from "./errors";
import {
  createOmniaTransferBundle,
  createOmniaTransferItem,
  validateOmniaTransferBundle,
} from "./omnia-data-transfer";

const updatedAt = "2026-10-17T00:00:00.000Z";

function makeBundle() {
  return createOmniaTransferBundle({
    bundleId: "bundle-1",
    createdAt: updatedAt,
    metadata: { purpose: "test" },
    items: [
      createOmniaTransferItem({
        kind: "project",
        id: "project-1",
        updatedAt,
        value: { name: "Omnia" },
      }),
    ],
  });
}

describe("Omnia transfer domain contract", () => {
  it("rejects non-object metadata instead of allowing it through the JSON boundary", () => {
    expect(() =>
      createOmniaTransferBundle({
        createdAt: updatedAt,
        metadata: [] as never,
      }),
    ).toThrow(DomainError);
  });

  it("validates manifest headers and malformed bundle shapes", () => {
    const bundle = makeBundle();
    expect(() =>
      validateOmniaTransferBundle({
        ...bundle,
        manifest: { ...bundle.manifest, schemaVersion: 99 as 1 },
      }),
    ).toThrow(DomainError);

    expect(() => validateOmniaTransferBundle({ ...bundle, items: null as never })).toThrow(DomainError);
  });

  it("rejects non-plain object item values", () => {
    expect(() =>
      createOmniaTransferItem({
        kind: "custom",
        id: "date-value",
        updatedAt,
        value: new Date(updatedAt) as never,
      }),
    ).toThrow(DomainError);
  });
});
