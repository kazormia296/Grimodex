import React from "react";
import i18next from "@/lib/i18n";
import { debugLog, errorDetail } from "@/lib/debugLog";

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    debugLog.error(
      "ErrorBoundary",
      error.message,
      errorDetail(error) + "\n" + (info.componentStack ?? ""),
    );
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-foreground">
          <h1 className="text-xl font-bold">{i18next.t("error.unexpected")}</h1>
          <p className="max-w-md text-center text-sm text-muted-foreground">
            {i18next.t("error.description")}
          </p>
          <details className="max-w-lg text-xs text-muted-foreground">
            <summary className="cursor-pointer">
              {i18next.t("error.details")}
            </summary>
            <pre className="mt-2 overflow-auto rounded bg-muted p-2">
              {this.state.error?.message}
              {"\n"}
              {this.state.error?.stack}
            </pre>
          </details>
          <button
            type="button"
            onClick={this.handleReload}
            className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
          >
            {i18next.t("error.reload")}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
