import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PRIMARY_ACTIVITIES, SECONDARY_ACTIVITIES } from "./activity-registry";
import { ActivityRail } from "./activity-rail";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();

describe("ActivityRail", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("routes every primary and secondary rail button to its renderer activity", () => {
    render(<ActivityRail />);

    for (const activity of [...PRIMARY_ACTIVITIES, ...SECONDARY_ACTIVITIES]) {
      const button = screen.getByRole("button", { name: activity.label });
      fireEvent.click(button);
      expect(useWorkspaceStore.getState().activeActivity).toBe(activity.id);
      expect(button).toHaveAttribute("aria-current", "page");
    }
  });

  it("keeps the approved rail icon-only with crisp monochrome SVG and hover descriptions", () => {
    render(<ActivityRail />);

    for (const activity of [...PRIMARY_ACTIVITIES, ...SECONDARY_ACTIVITIES]) {
      const button = screen.getByRole("button", { name: activity.label });
      expect(button).toHaveTextContent("");
      expect(button).toHaveAttribute("title", expect.stringContaining(activity.label));
      const icon = button.querySelector("svg");
      expect(icon).toHaveAttribute("stroke", "currentColor");
      expect(icon).toHaveAttribute("fill", "none");
      expect(icon).toHaveAttribute("stroke-width", "1.75");
    }
  });
});
