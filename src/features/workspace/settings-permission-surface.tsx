import { PermissionControlCenter } from "./permission-control-center";
import { PermissionMatrixStudio } from "./permission-matrix-studio";
import { PermissionPresetLab } from "./permission-preset-lab";
import { ApprovalRequestPreview } from "./approval-request-preview";
import { projectPermissionDraftContext } from "./session-permission-contract";
import { SecurityPolicyPreview } from "./security-policy-preview";

export default function SettingsPermissionSurface({ projectId }: { readonly projectId?: string | null | undefined }) {
  const context = projectPermissionDraftContext(projectId);
  return <div className="settings-permission-surface">
    <PermissionMatrixStudio projectId={projectId} />
    <PermissionControlCenter projectId={projectId} />
    <PermissionPresetLab key={context} projectId={projectId} />
    <ApprovalRequestPreview key={`approval-${context}`} projectId={projectId} />
    <SecurityPolicyPreview key={`security-${context}`} projectId={projectId} />
  </div>;
}
