import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import GoalTaskStudio, { parseGoalTaskPreview } from "./goal-task-studio";

describe("GoalTaskStudio", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("advances a visible task through the preview lifecycle", () => {
    render(<GoalTaskStudio />);
    const task = screen.getByRole("button", { name: /tune project workspace surface/i });
    fireEvent.click(task);
    expect(screen.getByText(/Advanced Tune project workspace surface/i)).toBeInTheDocument();
  });

  it("adds a task and filters the projection", () => {
    render(<GoalTaskStudio />);
    fireEvent.change(screen.getByLabelText("New task title"), { target: { value: "Write acceptance notes" } });
    fireEvent.click(screen.getByRole("button", { name: /add task/i }));
    expect(screen.getByRole("button", { name: /write acceptance notes/i })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Task filter"), { target: { value: "planned" } });
    expect(screen.getByRole("button", { name: /write acceptance notes/i })).toBeInTheDocument();
  });

  it("keeps task edits reversible inside the renderer preview", () => {
    render(<GoalTaskStudio />);
    const task = screen.getByRole("button", { name: /tune project workspace surface/i });
    fireEvent.click(task);
    fireEvent.click(screen.getByRole("button", { name: "Undo goal preview change" }));
    expect(screen.getByRole("button", { name: /tune project workspace surface/i })).toHaveTextContent("active");
    fireEvent.click(screen.getByRole("button", { name: "Redo goal preview change" }));
    expect(screen.getByRole("button", { name: /tune project workspace surface/i })).toHaveTextContent("done");
  });

  it("creates a goal and updates its renderer-local lifecycle", () => {
    render(<GoalTaskStudio />);
    fireEvent.change(screen.getByLabelText("New goal title"), { target: { value: "Ship the evidence loop" } });
    fireEvent.change(screen.getByLabelText("New goal outcome"), { target: { value: "Make research decisions easy to audit." } });
    fireEvent.click(screen.getByRole("button", { name: /create goal/i }));

    expect(screen.getByRole("heading", { name: "Ship the evidence loop" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Planned")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Goal lifecycle"), { target: { value: "active" } });
    expect(screen.getByDisplayValue("Active")).toBeInTheDocument();
  });

  it("navigates between goals with a visible position and bounded previous/next actions", () => {
    render(<GoalTaskStudio />);

    const previous = screen.getByRole("button", { name: "Previous goal" });
    const next = screen.getByRole("button", { name: "Next goal" });
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(previous).toBeDisabled();
    expect(next).toBeEnabled();

    fireEvent.change(screen.getByRole("textbox", { name: "Search tasks" }), { target: { value: "workspace surface" } });
    expect(screen.getByRole("textbox", { name: "Search tasks" })).toHaveValue("workspace surface");
    fireEvent.click(next);
    expect(screen.getByRole("heading", { name: "Build an evidence loop" })).toBeInTheDocument();
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Search tasks" })).toHaveValue("");
    expect(screen.getByRole("button", { name: /collect open questions/i })).toBeInTheDocument();
    expect(previous).toBeEnabled();
    expect(next).toBeDisabled();

    fireEvent.click(previous);
    expect(screen.getByRole("heading", { name: "Shape the Omnia UI" })).toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
  });

  it("surfaces dependency health and clears it when the prerequisite is done", () => {
    render(<GoalTaskStudio />);
    fireEvent.change(screen.getByLabelText("New goal title"), { target: { value: "Evidence dependency rehearsal" } });
    fireEvent.change(screen.getByLabelText("New goal outcome"), { target: { value: "Keep task dependencies explicit." } });
    fireEvent.click(screen.getByRole("button", { name: /create goal/i }));
    fireEvent.change(screen.getByLabelText("New task title"), { target: { value: "Define the evidence contract" } });
    fireEvent.click(screen.getByRole("button", { name: /add task/i }));
    fireEvent.change(screen.getByLabelText("New task title"), { target: { value: "Publish the evidence brief" } });
    fireEvent.change(screen.getByLabelText("New task dependency"), { target: { value: "task-" } });
    const dependencyOption = screen.getByRole("option", { name: "Define the evidence contract" }) as HTMLOptionElement;
    fireEvent.change(screen.getByLabelText("New task dependency"), { target: { value: dependencyOption.value } });
    fireEvent.click(screen.getByRole("button", { name: /add task/i }));

    expect(screen.getByText(/blocked by dependency/i)).toBeInTheDocument();
    const prerequisite = screen.getByRole("button", { name: /define the evidence contract/i });
    fireEvent.click(prerequisite);
    fireEvent.click(prerequisite);
    expect(screen.getByText(/dependencies clear/i)).toBeInTheDocument();
  });

  it("switches the portable export format without leaving the preview boundary", () => {
    render(<GoalTaskStudio />);
    expect(screen.getByLabelText("Goal export format")).toHaveValue("json");
    expect(screen.getByRole("button", { name: /copy json/i })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Goal export format"), { target: { value: "markdown" } });
    expect(screen.getByLabelText("Goal export format")).toHaveValue("markdown");
    expect(screen.getByRole("button", { name: /copy markdown/i })).toBeInTheDocument();
    expect(screen.getByText(/saved native goal drafts above are separate.*scheduling, and agent dispatch are not wired/i)).toBeInTheDocument();
  });

  it("parses a portable goal preview and rejects unsupported payloads", () => {
    const parsed = parseGoalTaskPreview(JSON.stringify({
      schema: "omnia.goal-task.preview.v1",
      scope: "renderer-session",
      selectedGoalId: "g-1",
      goals: [{ id: "g-1", title: "Imported goal", outcome: "Keep the plan reviewable.", status: "planned", tasks: [{ id: "t-1", title: "Imported task", status: "active", owner: "You" }] }],
    }));
    expect(parsed.selectedGoalId).toBe("g-1");
    expect(parsed.goals[0]?.tasks[0]?.title).toBe("Imported task");
    expect(() => parseGoalTaskPreview(JSON.stringify({ schema: "wrong", scope: "renderer-session", goals: [] }))).toThrow(/unsupported goal preview schema/i);
  });

  it("saves goal detail edits as one reversible renderer change", () => {
    render(<GoalTaskStudio />);
    fireEvent.change(screen.getByLabelText("Edit goal title"), { target: { value: "Shape the Omnia product UI" } });
    fireEvent.change(screen.getByLabelText("Edit goal outcome"), { target: { value: "Make the workspace easy to inspect, steer, and customize." } });
    fireEvent.click(screen.getByRole("button", { name: /save goal details/i }));
    expect(screen.getByRole("heading", { name: "Shape the Omnia product UI" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo goal preview change" }));
    expect(screen.getByRole("heading", { name: "Shape the Omnia UI" })).toBeInTheDocument();
  });

  it("supports dashboard search, priority filtering, and board view", () => {
    render(<GoalTaskStudio />);
    expect(screen.getByText("Mission plan dashboard")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Task priority filter"), { target: { value: "high" } });
    expect(screen.getByRole("button", { name: /tune project workspace surface/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /choose a durable storage boundary/i })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search tasks"), { target: { value: "chat navigation" } });
    expect(screen.getByRole("button", { name: /review chat navigation/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /tune project workspace surface/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Board view" }));
    expect(screen.getByRole("button", { name: /board view/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "Planned" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Active" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Done" })).toBeInTheDocument();
  });

  it("keeps the key plan metrics compact and reveals secondary metrics on demand", () => {
    render(<GoalTaskStudio />);

    const disclosure = screen.getByText("More planning metrics").closest("details");
    expect(disclosure).not.toBeNull();
    expect(disclosure).not.toHaveAttribute("open");
    expect(screen.getByRole("group", { name: "Key plan metrics" })).toBeVisible();
    expect(screen.getByText("Selected progress")).toBeVisible();
    expect(screen.getByText("Active tasks")).not.toBeVisible();

    fireEvent.click(screen.getByText("More planning metrics"));
    expect(disclosure).toHaveAttribute("open");
    expect(screen.getByText("Active tasks")).toBeVisible();
    expect(screen.getByText("High priority", { selector: ".goal-task-studio__summary-more span" })).toBeVisible();
    expect(screen.getByText("Due soon")).toBeVisible();
  });

  it("keeps dashboard actions discoverable through hover descriptions", () => {
    render(<GoalTaskStudio />);

    expect(screen.getByRole("button", { name: "List view" })).toHaveAttribute("title", "Show matching tasks as a compact list");
    expect(screen.getByRole("button", { name: "Board view" })).toHaveAttribute("title", "Show matching tasks grouped by status");
    expect(screen.getByRole("button", { name: "Undo goal preview change" })).toHaveAttribute("title", "Undo the last renderer-local goal or task change");
    expect(screen.getByRole("button", { name: "Redo goal preview change" })).toHaveAttribute("title", "Redo the next renderer-local goal or task change");
    expect(screen.getByRole("button", { name: /tune project workspace surface/i })).toHaveAttribute("title", "Advance “Tune project workspace surface” from Active to the next preview status");
    expect(screen.getByRole("button", { name: /create goal/i })).toHaveAttribute("title", "Create a renderer-local goal workstream");
  });

  it("normalizes legacy task previews with a medium priority", () => {
    const parsed = parseGoalTaskPreview(JSON.stringify({
      schema: "omnia.goal-task.preview.v1",
      scope: "renderer-session",
      selectedGoalId: "legacy",
      goals: [{ id: "legacy", title: "Legacy goal", outcome: "Keep old exports readable.", status: "planned", tasks: [{ id: "legacy-task", title: "Legacy task", status: "planned", owner: "You" }] }],
    }));
    expect(parsed.goals[0]?.tasks[0]?.priority).toBe("medium");
  });

  it("keeps dependency-blocked tasks from advancing and explains the wait state", () => {
    render(<GoalTaskStudio />);
    const blockedTask = screen.getByRole("button", { name: /choose a durable storage boundary/i });
    expect(blockedTask).toHaveAttribute("aria-disabled", "true");
    expect(blockedTask).toHaveAttribute("title", expect.stringMatching(/finish “Tune project workspace surface” first/i));
    fireEvent.click(blockedTask);
    expect(screen.getByText(/waiting for “Tune project workspace surface” to be completed/i)).toBeInTheDocument();
    expect(blockedTask).toHaveTextContent("planned");
  });

  it("shows a truthful cross-goal queue preview and focuses work in another goal", () => {
    render(<GoalTaskStudio />);
    expect(screen.getByRole("heading", { name: "Next work across goals" })).toBeInTheDocument();
    expect(screen.getByText("2 active")).toBeInTheDocument();
    expect(screen.getByText("2 blocked")).toBeInTheDocument();
    expect(screen.getByText(/read-only renderer projection/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /focus build an evidence loop task research-1/i }));
    expect(screen.getByRole("heading", { name: "Build an evidence loop" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /collect open questions/i })).toBeInTheDocument();
    expect(screen.getByText(/focused “collect open questions” in its goal/i)).toBeInTheDocument();
  });

  it("restores an in-progress draft when the same Project Plan surface remounts", () => {
    const first = render(<GoalTaskStudio projectId="project-alpha" />);
    fireEvent.change(screen.getByLabelText("New goal title"), { target: { value: "Evidence workspace" } });
    fireEvent.change(screen.getByLabelText("New goal outcome"), { target: { value: "Keep drafts available in this Project." } });
    fireEvent.click(screen.getByRole("button", { name: /create goal/i }));
    fireEvent.change(screen.getByLabelText("New task title"), { target: { value: "Unsubmitted task draft" } });
    fireEvent.change(screen.getByLabelText("Edit goal title"), { target: { value: "Evidence workspace draft" } });
    fireEvent.change(screen.getByLabelText("Edit goal outcome"), { target: { value: "Unsubmitted outcome edit." } });
    first.unmount();

    const remounted = render(<GoalTaskStudio projectId="project-alpha" />);
    expect(screen.getByRole("textbox", { name: "New task title" })).toHaveValue("Unsubmitted task draft");
    expect(screen.getByRole("textbox", { name: "Edit goal title" })).toHaveValue("Evidence workspace draft");
    expect(screen.getByRole("textbox", { name: "Edit goal outcome" })).toHaveValue("Unsubmitted outcome edit.");
    expect((screen.getByRole("combobox", { name: "Selected goal" }) as HTMLSelectElement).value).toMatch(/^goal-\d+$/);
    expect(screen.getByText(/restored this project's renderer-session goal draft/i)).toBeInTheDocument();
    remounted.unmount();

    render(<GoalTaskStudio projectId="project-beta" />);
    expect((screen.getByRole("combobox", { name: "Selected goal" }) as HTMLSelectElement).value).toBe("omnia-ui");
    expect(screen.queryByRole("option", { name: /evidence workspace/i })).not.toBeInTheDocument();
  });
});
