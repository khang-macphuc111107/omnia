import type { ReactNode } from "react";

import "./screen-header.css";

interface ScreenHeaderProps {
  /**
   * Screen name. The shell top bar already shows the view label, so the title
   * is only exposed to assistive technology (sr-only h1).
   */
  title: string;
  /** Slim actions toolbar: view switchers and primary buttons. */
  action?: ReactNode;
}

/**
 * Compact screen header: no eyebrow, big title or description, just a slim
 * actions row. Keeps one visually hidden h1 so every screen has a heading.
 */
export function ScreenHeader({ title, action }: ScreenHeaderProps) {
  return (
    <header className={action ? "screen-header screen-header--compact" : "screen-header screen-header--compact screen-header--bare"}>
      <h1 className="sr-only">{title}</h1>
      {action ? (
        <div className="screen-header__actions" role="group" aria-label={`${title} actions`}>
          {action}
        </div>
      ) : null}
    </header>
  );
}
