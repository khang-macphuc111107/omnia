import type { ReactNode, SVGProps } from "react";

export type ProductIconName =
  | "agent"
  | "artifact"
  | "browser"
  | "citation"
  | "environment"
  | "memory"
  | "model"
  | "plan"
  | "run"
  | "skill"
  | "task"
  | "terminal";

export interface ProductIconProps
  extends Omit<SVGProps<SVGSVGElement>, "children" | "name"> {
  name: ProductIconName;
  size?: number;
  strokeWidth?: number;
}

const paths: Record<ProductIconName, ReactNode> = {
  agent: (
    <>
      <path d="M12 3.5 18.75 7.25v9.5L12 20.5l-6.75-3.75v-9.5z" />
      <path d="M8.5 9.25H12m0 0v5.5m0-5.5 3.5-2M12 14.75l3.5 2" />
    </>
  ),
  artifact: (
    <>
      <path d="M7 3.75h7l3 3v13.5H7z" />
      <path d="M14 3.75v3h3M9.5 11h5M9.5 14h5M9.5 17h3" />
    </>
  ),
  browser: (
    <>
      <rect x="3.75" y="4.75" width="16.5" height="14.5" rx="2.25" />
      <path d="M3.75 8.5h16.5M7 6.65h.01M9.35 6.65h.01" />
    </>
  ),
  citation: (
    <>
      <path d="M7.25 6.25h9.5v13H7.25z" />
      <path d="M9.75 9.5h4.5M9.75 12.5h4.5M9.75 15.5h2.75M5 4h9.5" />
    </>
  ),
  environment: (
    <>
      <path d="M12 3.5 19 7.25v9.5L12 20.5 5 16.75v-9.5z" />
      <path d="m5 7.25 7 3.75 7-3.75M12 11v9.5" />
    </>
  ),
  memory: (
    <>
      <path d="M6.25 4.25h10a2 2 0 0 1 2 2v13.5l-6.25-3-6.25 3V6.25a2 2 0 0 1 2-2Z" />
      <path d="M9 8h6M9 11h4" />
    </>
  ),
  model: (
    <>
      <path d="m12 3.75 7.25 4L12 11.5l-7.25-3.75z" />
      <path d="m4.75 12 7.25 4 7.25-4M4.75 16.25l7.25 4 7.25-4" />
    </>
  ),
  plan: (
    <>
      <path d="M7 4.25h10v15.5H7z" />
      <path d="M9.5 8h5M9.5 12h5M9.5 16h3" />
      <path d="m4.75 8 .75.75L7 7.25m-2.25 5 .75.75L7 11.5" />
    </>
  ),
  run: (
    <>
      <circle cx="12" cy="12" r="8.25" />
      <path d="m10.5 8.5 5 3.5-5 3.5z" />
    </>
  ),
  skill: (
    <>
      <path d="M5 6.5h5.25V12H5zM13.75 6.5H19V12h-5.25zM5 15.5h5.25V21H5z" />
      <path d="M16.5 15.25v5.5M13.75 18h5.5" />
    </>
  ),
  task: (
    <>
      <path d="M8 4.25h8v3H8zM6 6.75h12v13H6z" />
      <path d="m9 13 2 2 4-4" />
    </>
  ),
  terminal: (
    <>
      <rect x="3.75" y="4.75" width="16.5" height="14.5" rx="2.25" />
      <path d="m7.25 9 3 3-3 3M12.75 15h4" />
    </>
  ),
};

/**
 * Omnia's object vocabulary. These marks identify durable product entities;
 * ordinary utility actions continue to use Lucide icons.
 */
export function ProductIcon({
  name,
  size = 20,
  strokeWidth = 1.75,
  ...props
}: ProductIconProps) {
  const ariaLabel = props["aria-label"];

  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={ariaLabel === undefined ? props.role : (props.role ?? "img")}
      aria-hidden={ariaLabel === undefined ? "true" : undefined}
      focusable="false"
      data-product-icon={name}
    >
      {paths[name]}
    </svg>
  );
}
