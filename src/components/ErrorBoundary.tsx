import React from "react";

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
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-foreground">
          <h1 className="text-xl font-bold">予期しないエラーが発生しました</h1>
          <p className="max-w-md text-center text-sm text-muted-foreground">
            アプリケーションで問題が発生しました。再読み込みしてください。
          </p>
          <details className="max-w-lg text-xs text-muted-foreground">
            <summary className="cursor-pointer">詳細</summary>
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
            再読み込み
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
