import {
  EDITOR_INPUT_READY_EVENT,
  type EditorInputReadyDetail,
} from "@/features/editor/editorInputReady";
import { debugLog } from "@/lib/debugLog";

export const WORKSPACE_OPEN_TRACE_EVENT = "grimodex:workspace-open-trace";
export const WORKSPACE_OPEN_TRACE_TIMEOUT_MS = 30_000;

export const WORKSPACE_OPEN_TRACE_SOURCES = [
  "startup-auto",
  "launcher-card",
  "workspace-menu-recent",
  "folder-picker",
  "direct",
  "trust-confirmed",
] as const;

export type WorkspaceOpenTraceSource =
  (typeof WORKSPACE_OPEN_TRACE_SOURCES)[number];

export const WORKSPACE_OPEN_TRACE_SPAN_NAMES = [
  "path-validation",
  "project-load-gate",
  "strict-quiescence",
  "runtime-composition",
  "native-ipc",
  "project-resolution",
  "settings-reread",
  "workspace-hydration",
  "project-critical",
  "project-optional",
  "project-activation",
  "authority-publish",
] as const;

export type WorkspaceOpenTraceSpanName =
  (typeof WORKSPACE_OPEN_TRACE_SPAN_NAMES)[number];

export type WorkspaceOpenTraceSpanStatus = "finished" | "failed";
export type WorkspaceOpenTraceResult = "ready" | "failed";

export interface WorkspaceOpenTraceSpanSummary {
  name: WorkspaceOpenTraceSpanName;
  /** Static ProjectLifecycle participant id; never an entity identifier. */
  participantId?: string;
  status: WorkspaceOpenTraceSpanStatus;
  startOffsetMs: number;
  durationMs: number;
}

/**
 * The serialized trace is deliberately an allowlist. Workspace paths, entity
 * identifiers, document content, SQL, and exception text have no field here
 * and must never be added as generic metadata.
 */
export interface WorkspaceOpenTraceSummary {
  version: 1;
  runId: string;
  source: WorkspaceOpenTraceSource;
  result: WorkspaceOpenTraceResult;
  totalDurationMs: number;
  requestToInputReadyMs: number | null;
  launcherFirstPaintOffsetMs: number | null;
  launcherIdleMs: number | null;
  launcherToInputReadyMs: number | null;
  transientLauncherVisible: boolean;
  spans: readonly WorkspaceOpenTraceSpanSummary[];
}

export interface WorkspaceOpenTraceSpan {
  finish: () => void;
  fail: () => void;
}

export interface WorkspaceOpenTrace {
  readonly enabled: boolean;
  readonly runId: string | null;
  startSpan: (
    name: WorkspaceOpenTraceSpanName,
    participantId?: string,
  ) => WorkspaceOpenTraceSpan;
  setTargetScopeKey: (scopeKey: string) => void;
  recordLauncherFirstPaint: () => void;
  fail: () => WorkspaceOpenTraceSummary | null;
  getSummary: () => WorkspaceOpenTraceSummary | null;
  dispose: () => void;
}

type WorkspaceOpenTraceEventTarget = Pick<
  EventTarget,
  "addEventListener" | "removeEventListener" | "dispatchEvent"
>;

export interface WorkspaceOpenTraceDependencies {
  dev?: boolean;
  now?: () => number;
  createRunId?: () => string;
  eventTarget?: WorkspaceOpenTraceEventTarget | null;
  log?: (summary: WorkspaceOpenTraceSummary) => void;
}

interface MutableSpan {
  name: WorkspaceOpenTraceSpanName;
  participantId: string | undefined;
  startedAt: number;
  finishedAt: number | null;
  status: WorkspaceOpenTraceSpanStatus | null;
}

const NOOP_SPAN: WorkspaceOpenTraceSpan = Object.freeze({
  finish: () => {},
  fail: () => {},
});

const NOOP_TRACE: WorkspaceOpenTrace = Object.freeze({
  enabled: false,
  runId: null,
  startSpan: () => NOOP_SPAN,
  setTargetScopeKey: () => {},
  recordLauncherFirstPaint: () => {},
  fail: () => null,
  getSummary: () => null,
  dispose: () => {},
});

let activeTrace: WorkspaceOpenTraceImpl | null = null;
let lastLauncherPaintAt: number | null = null;

function defaultNow(): number {
  return performance.now();
}

function defaultRunId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint32Array(4);
  globalThis.crypto?.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(8, "0")).join(
    "-",
  );
}

function defaultEventTarget(): WorkspaceOpenTraceEventTarget | null {
  return typeof window === "undefined" ? null : window;
}

function defaultLog(summary: WorkspaceOpenTraceSummary): void {
  debugLog.info("workspace-open", "trace completed", {
    sensitivity: "safe",
    fields: { ...summary, spans: [...summary.spans] },
  });
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

const SAFE_PROJECT_LIFECYCLE_PARTICIPANT_IDS = new Set([
  "settings",
  "tree",
  "codex-load",
  "snippets-load",
  "chat-history-load",
  "foreshadow-load",
  "labels-load",
  "grid-load",
  "trash-load",
  "scene-codex-pins-load",
  "scene-beat-pov-load",
  "plot-threads-load",
  "external-mounts",
]);

function sanitizeParticipantId(
  participantId: string | undefined,
): string | undefined {
  return participantId &&
    SAFE_PROJECT_LIFECYCLE_PARTICIPANT_IDS.has(participantId)
    ? participantId
    : undefined;
}

function isMatchingReadyDetail(
  value: unknown,
  targetScopeKey: string | null,
): value is EditorInputReadyDetail {
  if (!value || typeof value !== "object" || targetScopeKey === null) {
    return false;
  }
  const detail = value as Partial<EditorInputReadyDetail>;
  return detail.foreground === true && detail.scopeKey === targetScopeKey;
}

class WorkspaceOpenTraceImpl implements WorkspaceOpenTrace {
  readonly enabled = true;
  readonly runId: string;

  private readonly startedAt: number;
  private readonly source: WorkspaceOpenTraceSource;
  private readonly rawNow: () => number;
  private readonly eventTarget: WorkspaceOpenTraceEventTarget | null;
  private readonly log: (summary: WorkspaceOpenTraceSummary) => void;
  private readonly spans: MutableSpan[] = [];
  private lastObservedAt: number;
  private targetScopeKey: string | null = null;
  private launcherFirstPaintAt: number | null;
  private launcherWasVisibleBeforeRequest: boolean;
  private terminalSummary: WorkspaceOpenTraceSummary | null = null;
  private disposed = false;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    source: WorkspaceOpenTraceSource,
    dependencies: Required<
      Pick<WorkspaceOpenTraceDependencies, "now" | "createRunId" | "log">
    > & {
      eventTarget: WorkspaceOpenTraceEventTarget | null;
    },
  ) {
    this.source = source;
    this.rawNow = dependencies.now;
    this.eventTarget = dependencies.eventTarget;
    this.log = dependencies.log;
    this.startedAt = dependencies.now();
    this.lastObservedAt = this.startedAt;
    this.runId = dependencies.createRunId();
    this.launcherFirstPaintAt =
      source === "launcher-card" ? lastLauncherPaintAt : null;
    this.launcherWasVisibleBeforeRequest =
      this.launcherFirstPaintAt !== null &&
      this.launcherFirstPaintAt <= this.startedAt;
    this.eventTarget?.addEventListener(
      EDITOR_INPUT_READY_EVENT,
      this.onEditorInputReady,
    );
    this.timeoutHandle = setTimeout(() => {
      this.finish("failed");
    }, WORKSPACE_OPEN_TRACE_TIMEOUT_MS);
  }

  startSpan(
    name: WorkspaceOpenTraceSpanName,
    participantId?: string,
  ): WorkspaceOpenTraceSpan {
    if (this.terminalSummary || this.disposed) return NOOP_SPAN;
    const span: MutableSpan = {
      name,
      participantId: sanitizeParticipantId(participantId),
      startedAt: this.captureNow(),
      finishedAt: null,
      status: null,
    };
    this.spans.push(span);
    return {
      finish: () => this.closeSpan(span, "finished"),
      fail: () => this.closeSpan(span, "failed"),
    };
  }

  setTargetScopeKey(scopeKey: string): void {
    if (this.terminalSummary || this.disposed) return;
    this.targetScopeKey = scopeKey;
  }

  recordLauncherFirstPaint(): void {
    this.recordLauncherFirstPaintAt(this.captureNow());
  }

  fail(): WorkspaceOpenTraceSummary | null {
    return this.finish("failed");
  }

  getSummary(): WorkspaceOpenTraceSummary | null {
    return this.terminalSummary;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimeout();
    this.removeReadyListener();
    if (activeTrace === this) activeTrace = null;
  }

  captureNow(): number {
    const observedAt = this.rawNow();
    this.lastObservedAt = Math.max(this.lastObservedAt, observedAt);
    return this.lastObservedAt;
  }

  recordLauncherFirstPaintAt(paintedAt: number): void {
    if (this.terminalSummary || this.disposed) return;
    if (this.launcherFirstPaintAt === null) {
      this.launcherFirstPaintAt = paintedAt;
      this.launcherWasVisibleBeforeRequest = paintedAt <= this.startedAt;
    }
  }

  private readonly onEditorInputReady = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!isMatchingReadyDetail(detail, this.targetScopeKey)) return;
    this.finish("ready");
  };

  private closeSpan(
    span: MutableSpan,
    status: WorkspaceOpenTraceSpanStatus,
  ): void {
    if (span.status || this.terminalSummary || this.disposed) return;
    span.finishedAt = this.captureNow();
    span.status = status;
  }

  private finish(
    result: WorkspaceOpenTraceResult,
  ): WorkspaceOpenTraceSummary | null {
    if (this.terminalSummary || this.disposed) return this.terminalSummary;
    const terminalAt = this.captureNow();
    for (const span of this.spans) {
      if (span.status) continue;
      span.finishedAt = terminalAt;
      span.status = result === "ready" ? "finished" : "failed";
    }

    const inputReadyAt = result === "ready" ? terminalAt : null;
    const launcherPaintAt = this.launcherFirstPaintAt;
    const summary: WorkspaceOpenTraceSummary = Object.freeze({
      version: 1,
      runId: this.runId,
      source: this.source,
      result,
      totalDurationMs: roundMilliseconds(terminalAt - this.startedAt),
      requestToInputReadyMs:
        inputReadyAt === null
          ? null
          : roundMilliseconds(inputReadyAt - this.startedAt),
      launcherFirstPaintOffsetMs:
        launcherPaintAt === null
          ? null
          : roundMilliseconds(launcherPaintAt - this.startedAt),
      launcherIdleMs:
        launcherPaintAt === null || !this.launcherWasVisibleBeforeRequest
          ? null
          : roundMilliseconds(this.startedAt - launcherPaintAt),
      launcherToInputReadyMs:
        launcherPaintAt === null || inputReadyAt === null
          ? null
          : roundMilliseconds(inputReadyAt - launcherPaintAt),
      transientLauncherVisible:
        this.source === "startup-auto" &&
        launcherPaintAt !== null &&
        launcherPaintAt >= this.startedAt,
      spans: Object.freeze(
        this.spans.map((span) =>
          Object.freeze({
            name: span.name,
            ...(span.participantId
              ? { participantId: span.participantId }
              : {}),
            status: span.status ?? "failed",
            startOffsetMs: roundMilliseconds(span.startedAt - this.startedAt),
            durationMs: roundMilliseconds(
              (span.finishedAt ?? terminalAt) - span.startedAt,
            ),
          }),
        ),
      ),
    });
    this.terminalSummary = summary;
    this.clearTimeout();
    this.removeReadyListener();
    if (activeTrace === this) activeTrace = null;
    try {
      this.log(summary);
    } catch {
      // Diagnostics must never alter Workspace-open recovery behavior.
    }
    try {
      this.eventTarget?.dispatchEvent(
        new CustomEvent<WorkspaceOpenTraceSummary>(WORKSPACE_OPEN_TRACE_EVENT, {
          detail: summary,
        }),
      );
    } catch {
      // A diagnostic consumer must not turn a completed open into a failure.
    }
    return summary;
  }

  private removeReadyListener(): void {
    this.eventTarget?.removeEventListener(
      EDITOR_INPUT_READY_EVENT,
      this.onEditorInputReady,
    );
  }

  private clearTimeout(): void {
    if (this.timeoutHandle === null) return;
    clearTimeout(this.timeoutHandle);
    this.timeoutHandle = null;
  }
}

export function beginWorkspaceOpenTrace(
  source: WorkspaceOpenTraceSource,
  dependencies: WorkspaceOpenTraceDependencies = {},
): WorkspaceOpenTrace {
  const dev =
    dependencies.dev ?? (import.meta.env.DEV && typeof window !== "undefined");
  if (!dev) return NOOP_TRACE;

  // A previous open can still be waiting for editor input-ready after its
  // request guard has settled. Preserve a terminal diagnostic instead of
  // silently dropping that run when a new Workspace request supersedes it.
  activeTrace?.fail();
  const trace = new WorkspaceOpenTraceImpl(source, {
    now: dependencies.now ?? defaultNow,
    createRunId: dependencies.createRunId ?? defaultRunId,
    eventTarget:
      dependencies.eventTarget === undefined
        ? defaultEventTarget()
        : dependencies.eventTarget,
    log: dependencies.log ?? defaultLog,
  });
  activeTrace = trace;
  return trace;
}

export function getActiveWorkspaceOpenTrace(): WorkspaceOpenTrace | null {
  return activeTrace;
}

/**
 * Record the latest launcher paint even when no open request is active. A
 * later launcher-card trace can then report both launcher idle time and the
 * complete launcher-to-input-ready interval.
 */
export function recordActiveWorkspaceLauncherPaint(
  now: () => number = defaultNow,
): void {
  const paintedAt = activeTrace?.captureNow() ?? now();
  lastLauncherPaintAt = paintedAt;
  activeTrace?.recordLauncherFirstPaintAt(paintedAt);
}

export function resetWorkspaceOpenTraceForTests(): void {
  activeTrace?.dispose();
  activeTrace = null;
  lastLauncherPaintAt = null;
}
