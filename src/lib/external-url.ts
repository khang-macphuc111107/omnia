/**
 * Returns one renderer-safe external URL or null.
 *
 * Model output, retrieved content and citation metadata are all untrusted. The
 * renderer therefore accepts only absolute HTTP(S) URLs and never forwards
 * credentials embedded in an authority component.
 */
export function normalizeExternalHttpUrl(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}
