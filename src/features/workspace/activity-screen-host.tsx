import { AlertTriangle, RefreshCw } from "lucide-react";
import {
  Component,
  Suspense,
  lazy,
  useMemo,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";

import type { AppRuntimeInfo } from "@/lib/desktop";
import type { CoreRuntimeInfo } from "@/lib/core-protocol";

import {
  activityDescriptor,
  loadActivityScreen,
  type ActivityScreenModule,
  type NonChatActivityId,
} from "./activity-registry";
import "./screen-header.css";

export type ActivityModuleLoader = (
  activity: NonChatActivityId,
) => Promise<ActivityScreenModule>;

interface ActivityLoadBoundaryProps {
  children: ReactNode;
  label: string;
  onRetry: () => void;
}

interface ActivityLoadBoundaryState {
  error: Error | null;
}

class ActivityLoadBoundary extends Component<
  ActivityLoadBoundaryProps,
  ActivityLoadBoundaryState
> {
  state: ActivityLoadBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ActivityLoadBoundaryState {
    return { error };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // The native diagnostics path will receive a redacted client event once
    // the durable telemetry service is wired. Do not print arbitrary loader
    // errors because URLs and local build paths can appear in module messages.
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="activity-load-state activity-load-state--error" role="alert">
        <span className="activity-load-state__icon">
          <AlertTriangle size={22} />
        </span>
        <div>
          <span className="eyebrow">Activity unavailable</span>
          <h1>{this.props.label} could not be opened</h1>
          <p>
            Omnia kept the current workspace state intact. Retry loading this interface
            module; no provider request or native operation was started.
          </p>
        </div>
        <button type="button" className="button button--secondary" onClick={this.props.onRetry}>
          <RefreshCw size={15} /> Retry
        </button>
      </div>
    );
  }
}

function ActivityLoadingState({ activity }: { activity: NonChatActivityId }) {
  const descriptor = activityDescriptor(activity);
  return (
    <div className="activity-load-inline" role="status" aria-live="polite">
      <span className="activity-load-inline__spinner" aria-hidden="true" />
      <span>Opening {descriptor.label}…</span>
    </div>
  );
}

export function ActivityScreenHost({
  activity,
  runtime,
  coreRuntime = null,
  loadScreen = loadActivityScreen,
}: {
  activity: NonChatActivityId;
  runtime: AppRuntimeInfo;
  coreRuntime?: CoreRuntimeInfo | null | undefined;
  loadScreen?: ActivityModuleLoader;
}) {
  const [retryKey, setRetryKey] = useState(0);
  const Screen = useMemo(
    () => lazy(() => loadScreen(activity)),
    [activity, loadScreen, retryKey],
  );
  const descriptor = activityDescriptor(activity);
  const resetKey = `${activity}:${retryKey}`;

  return (
    <ActivityLoadBoundary
      key={resetKey}
      label={descriptor.label}
      onRetry={() => setRetryKey((value) => value + 1)}
    >
      <Suspense fallback={<ActivityLoadingState activity={activity} />}>
        <Screen runtime={runtime} coreRuntime={coreRuntime} />
      </Suspense>
    </ActivityLoadBoundary>
  );
}
