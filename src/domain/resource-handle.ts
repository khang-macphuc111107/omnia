import { assertDomain } from "./errors";
import { assertNonBlank } from "./shared";

/**
 * Validates a renderer-safe reference to a host-owned resource.
 *
 * Resource handles deliberately cannot contain path separators. The trusted
 * native broker resolves the opaque identifier and revalidates the underlying
 * resource immediately before use; clients never gain authority by supplying
 * a raw Windows, UNC, POSIX, or URL path.
 */
export function assertOpaqueResourceHandle(value: string, label = "resource handle"): string {
  const normalized = assertNonBlank(value, label, 320);
  assertDomain(
    /^[a-z][a-z0-9._-]{1,63}:[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/.test(normalized) &&
      !normalized.includes("/") &&
      !normalized.includes("\\"),
    "invalid_argument",
    `${label} must be an opaque native handle, not a filesystem path.`,
    { label },
  );
  return normalized;
}
