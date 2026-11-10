import { AlertTriangle, RefreshCw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface LazyLoadBoundaryProps {
  children: ReactNode;
  label: string;
  resetKey: string;
  errorClassName?: string;
  onDismiss: () => void;
  onRetry: () => void;
}

interface LazyLoadBoundaryState {
  error: Error | null;
}

export class LazyLoadBoundary extends Component<
  LazyLoadBoundaryProps,
  LazyLoadBoundaryState
> {
  state: LazyLoadBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): LazyLoadBoundaryState {
    return { error };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Chunk-loader diagnostics can include URLs or local build paths. Keep the
    // renderer copy redacted until native diagnostics own this telemetry path.
  }

  componentDidUpdate(previousProps: LazyLoadBoundaryProps): void {
    if (previousProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;

    const errorState = (
      <div className="lazy-load-error" role="alert">
        <AlertTriangle size={22} />
        <div>
          <strong>{this.props.label} could not be opened</strong>
          <p>Your current workspace state is intact. Retry the interface module or close it.</p>
        </div>
        <div className="lazy-load-error__actions">
          <button type="button" className="button button--secondary" onClick={this.props.onDismiss}>
            Close
          </button>
          <button type="button" className="button button--primary" onClick={this.props.onRetry}>
            <RefreshCw size={15} /> Retry
          </button>
        </div>
      </div>
    );

    if (this.props.errorClassName) {
      return <div className={this.props.errorClassName}>{errorState}</div>;
    }

    return (
      errorState
    );
  }
}
