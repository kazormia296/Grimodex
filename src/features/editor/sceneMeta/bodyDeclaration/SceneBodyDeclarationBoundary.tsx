import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { debugLog, errorDetail } from "@/lib/debugLog";

/**
 * Error boundary of the Scene body declaration section (DR-PUBG-40-1,
 * DR-CB3-35 (1)). The section is a lazy chunk, so a chunk that fails to load
 * (a stale chunk name after an update, a damaged disk) rejects the lazy
 * component, and so does a render or effect error of the section. Either way
 * the section draws nothing and the failure is logged; it never reaches the
 * boundary above `SceneScopeEditor`, so the A1 controls of the same editor stay
 * rendered and operable. No UI text is added. It must live in the startup graph
 * (not in the lazy chunk): a boundary inside the chunk cannot catch the
 * chunk's own load failure. Same form as `ProfileEgressStatusBoundary`
 * (DR-DA2-62).
 */
export class SceneBodyDeclarationBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    debugLog.error("SceneBodyDeclaration", "declaration section failed", {
      sensitivity: "content-derived",
      fields: {
        error: errorDetail(error),
        componentStack: info.componentStack ?? "",
      },
    });
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
