import React from "react";
import { AlertTriangle } from "lucide-react";

interface FeaturePanelErrorBoundaryProps {
  children: React.ReactNode;
  closeLabel: string;
  onClose: () => void;
}

interface FeaturePanelErrorBoundaryState {
  error: Error | null;
}

/** Contains a feature-panel failure so one malformed configuration cannot unmount the application. */
class FeaturePanelErrorBoundary extends React.Component<
  FeaturePanelErrorBoundaryProps,
  FeaturePanelErrorBoundaryState
> {
  state: FeaturePanelErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): FeaturePanelErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Feature configuration panel failed", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex min-h-40 flex-col items-center justify-center gap-3 p-4 text-center">
        <AlertTriangle className="h-8 w-8 text-red-500" />
        <p className="max-w-full break-words text-sm text-red-600 dark:text-red-400">
          {this.state.error.message}
        </p>
        <button
          type="button"
          onClick={this.props.onClose}
          className="rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700"
        >
          {this.props.closeLabel}
        </button>
      </div>
    );
  }
}

export default FeaturePanelErrorBoundary;
