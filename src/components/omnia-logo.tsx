interface OmniaLogoProps {
  size?: number;
  compact?: boolean;
  tone?: "brand" | "currentColor";
  label?: string | null;
  /**
   * The renderer's selected identity direction. `command-ring` is the L01
   * direction from the brand catalog; `hex-core` remains available for
   * surfaces that still need the legacy/native-compatible silhouette.
   */
  variant?: "command-ring" | "hex-core";
}

/**
 * The Omnia renderer mark. The selected L01 command-ring direction stays
 * legible as a single-color 16 px glyph; the legacy hex-core direction remains
 * available for native-compatible surfaces until the app-icon assets are
 * intentionally regenerated.
 */
export function OmniaLogo({
  size = 28,
  compact = false,
  tone = "brand",
  label = "Omnia",
  variant = "command-ring",
}: OmniaLogoProps) {
  const className = [
    "omnia-logo",
    compact ? "omnia-logo--compact" : "",
    tone === "currentColor" ? "omnia-logo--current-color" : "",
    `omnia-logo--${variant}`,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      className={className}
      role={label === null ? undefined : "img"}
      aria-label={label ?? undefined}
      aria-hidden={label === null ? "true" : undefined}
    >
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
        {variant === "command-ring" ? (
          <>
            <path
              className="omnia-logo__aperture"
              d="M16 4.5a11.5 11.5 0 1 0 8.25 3.5"
              fill="none"
            />
            <path
              className="omnia-logo__command"
              d="m20.5 4.75 4.75.5-1.5 4.5"
              fill="none"
            />
            <circle className="omnia-logo__core" cx="16" cy="16" r="2.25" fill="currentColor" />
          </>
        ) : (
          <>
            <path
              className="omnia-logo__aperture"
              fillRule="evenodd"
              d="M16 2.5 27.7 9.25v13.5L16 29.5 4.3 22.75V9.25L16 2.5Zm0 5.05-7.3 4.22v8.46l7.3 4.22 7.3-4.22v-8.46L16 7.55Z"
            />
            <path
              className="omnia-logo__core"
              fill="currentColor"
              d="M16 10.7 20.6 16 16 21.3 11.4 16 16 10.7Z"
            />
          </>
        )}
      </svg>
    </span>
  );
}
