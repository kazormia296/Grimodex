import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { debugLog, errorDetail } from "@/lib/debugLog";

/**
 * Error boundary of the status display (DR-DA2-62, R3-7). It lives in the
 * startup graph on purpose: a boundary inside the lazy chunk cannot catch the
 * chunk's own load failure or its module-evaluation errors. A failure of the
 * display (chunk, render, effect) draws nothing and is logged, instead of
 * reaching the app root's full-screen `ErrorBoundary`.
 *
 * It never closes the AI entrances itself (an unknown state closes nothing,
 * the same as "loading" and "unknown"). The closure is written by the
 * Indicator's own effect, which sits outside the inner boundary of the
 * rendering below, so an exception of the rendering cannot stop it
 * (DR-DA2-64). The chat panel's probe closes its own entrances independently.
 * The same class is used twice: around the lazy chunk in
 * `ProfileEgressStatusSlot` and around the rendering inside the chunk.
 */
export class ProfileEgressStatusBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    debugLog.error("ProfileEgressStatus", "status display failed", {
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
