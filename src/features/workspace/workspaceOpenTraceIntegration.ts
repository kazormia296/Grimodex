import { ensureRuntimeStoreComposition } from "@/application/composition/runtimeStoreCompositionLoader";
import type { LifecycleTransitionInput } from "@/application/lifecycle/lifecycleTrace";
import type {
  ProjectLifecycleTimingEvent,
  ProjectLifecycleTimingObserver,
} from "@/application/project/ProjectLifecycleRegistry";
import { createEditorInputScopeKey } from "@/features/editor/editorInputReady";
import type {
  WorkspaceOpenTrace,
  WorkspaceOpenTraceSpan,
  WorkspaceOpenTraceSpanName,
} from "./workspaceOpenTrace";

export function createWorkspaceOpenTransition(
  from: LifecycleTransitionInput["from"],
  targetWorkspacePath: string,
): LifecycleTransitionInput {
  return {
    kind: "workspace",
    from,
    to: {
      workspacePath: targetWorkspacePath,
      workspaceOpenRevision: null,
      projectId: null,
    },
  };
}

export async function runWorkspaceOpenTraceStep<T>(
  trace: WorkspaceOpenTrace,
  name: WorkspaceOpenTraceSpanName,
  run: () => Promise<T>,
): Promise<T> {
  const span = trace.startSpan(name);
  try {
    const result = await run();
    span.finish();
    return result;
  } catch (error) {
    span.fail();
    throw error;
  }
}

export function startRuntimeCompositionTrace(
  trace: WorkspaceOpenTrace,
): Promise<void> {
  const span = trace.startSpan("runtime-composition");
  try {
    return ensureRuntimeStoreComposition().then(
      () => span.finish(),
      (error) => {
        span.fail();
        throw error;
      },
    );
  } catch (error) {
    span.fail();
    throw error;
  }
}

function projectLifecycleSpanName(
  phase: ProjectLifecycleTimingEvent["phase"],
): WorkspaceOpenTraceSpanName {
  if (phase === "hydrateOptional") return "project-optional";
  if (phase === "activate") return "project-activation";
  return "project-critical";
}

export function createWorkspaceOpenProjectLifecycleTiming(
  trace: WorkspaceOpenTrace,
): ProjectLifecycleTimingObserver | undefined {
  if (!trace.enabled) return undefined;
  const spans = new Map<string, WorkspaceOpenTraceSpan>();
  return {
    onEvent(event) {
      const key = `${event.phase}:${event.participantId}`;
      if (event.status === "start") {
        spans.set(
          key,
          trace.startSpan(
            projectLifecycleSpanName(event.phase),
            event.participantId,
          ),
        );
        return;
      }
      const span = spans.get(key);
      spans.delete(key);
      if (event.status === "fail") span?.fail();
      else span?.finish();
    },
  };
}

export function setWorkspaceOpenTraceTarget(
  trace: WorkspaceOpenTrace,
  input: {
    projectId: string;
    workspacePath: string;
    workspaceOpenRevision: number;
  },
): void {
  trace.setTargetScopeKey(createEditorInputScopeKey(input));
}
