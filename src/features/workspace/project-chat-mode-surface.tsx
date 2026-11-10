import { Check, FolderKanban, MessageSquareText } from "lucide-react";

export type ProjectChatMode = "project" | "chat";

interface ProjectChatModeSurfaceProps {
  mode: ProjectChatMode;
  projectCount: number;
  chatCount: number;
  projectLabel?: string;
  projectDisabled?: boolean;
  chatDisabled?: boolean;
  onChange: (mode: ProjectChatMode) => void;
}

/**
 * Explicitly presents Omnia's two primary workspace shapes.
 *
 * This is a renderer-local destination choice. It does not create a Project,
 * move a Chat, freeze context, or grant native permission by itself.
 */
export function ProjectChatModeSurface({
  mode,
  projectCount,
  chatCount,
  projectLabel = "Project workspace",
  projectDisabled = false,
  chatDisabled = false,
  onChange,
}: ProjectChatModeSurfaceProps) {
  const options = [
    {
      id: "project" as const,
      label: "Project",
      description: "Scoped instructions, files, memory, and Chats.",
      count: projectCount,
      countLabel: projectCount === 1 ? "available Project" : "available Projects",
      icon: FolderKanban,
      disabled: projectDisabled,
    },
    {
      id: "chat" as const,
      label: "Chat",
      description: "A focused conversation with optional Project context.",
      count: chatCount,
      countLabel: chatCount === 1 ? "visible Chat" : "visible Chats",
      icon: MessageSquareText,
      disabled: chatDisabled,
    },
  ];

  return (
    <div className="project-chat-mode-surface" aria-label="Primary workspace mode">
      <div className="project-chat-mode-surface__intro">
        <span className="eyebrow">Primary shape</span>
        <p>Choose the container you want Omnia to open. You can refine context and model settings next.</p>
      </div>
      <div className="project-chat-mode-surface__options" role="radiogroup" aria-label="Project or Chat mode">
        {options.map((option) => {
          const Icon = option.icon;
          const selected = mode === option.id;
          const disabled = option.disabled;
          return (
            <button
              key={option.id}
              type="button"
              className={selected ? "project-chat-mode-surface__option is-selected" : "project-chat-mode-surface__option"}
              role="radio"
              aria-checked={selected}
              aria-label={`${option.label} mode`}
              disabled={disabled}
              onClick={() => onChange(option.id)}
            >
              <span className={`project-chat-mode-surface__icon project-chat-mode-surface__icon--${option.id}`} aria-hidden="true">
                <Icon size={17} />
              </span>
              <span className="project-chat-mode-surface__copy">
                <strong>{option.label}</strong>
                <small>{option.description}</small>
                <em>{option.count} {option.countLabel}</em>
              </span>
              <span className="project-chat-mode-surface__state" aria-hidden="true">
                {selected ? <Check size={15} /> : null}
              </span>
            </button>
          );
        })}
      </div>
      <div className="project-chat-mode-surface__selection" role="status" aria-live="polite">
        <span className="project-chat-mode-surface__selection-dot" aria-hidden="true" />
        <span>
          <strong>{mode === "project" ? projectLabel : "Standalone Chat"}</strong>
          <small>{mode === "project" ? "Project scope selected · Chat will open inside this workspace." : "Chat scope selected · no Project membership is attached."}</small>
        </span>
      </div>
      <small className="project-chat-mode-surface__boundary">Preview only · this choice changes the setup draft, not native storage or provider execution.</small>
    </div>
  );
}
