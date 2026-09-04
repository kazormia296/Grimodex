import type { Transaction } from "@tiptap/pm/state";
import type { DocumentKey } from "./document/documentKey";
import { serializeTransactionSteps } from "./editorEventPolicy";
import {
  recordChangeEvent,
  type TimelapseAcceptedEnqueueReceipt,
  type TimelapseDocumentRef,
  type RecordEventInput,
} from "@/features/timelapse/recorder";
import {
  createTimelapseDocumentCaptureAccumulator,
  isTimelapseReplacementFenceActiveForDocument,
  type TimelapseDocumentCaptureAccumulator,
  type TimelapseDocumentIdentity,
} from "@/features/timelapse/documentCoverage";
import { debugLog } from "@/lib/debugLog";

export type MiniEditorDocumentKey = Extract<
  DocumentKey,
  { kind: "codex" | "snippet" }
>;

/** Immutable identity of the body actually loaded into a mini editor. */
export interface LoadedMiniEditorTimelapseAuthority {
  readonly projectId: string;
  readonly documentKey: MiniEditorDocumentKey;
  readonly documentIdentity: TimelapseDocumentIdentity;
  readonly captureAccumulator: TimelapseDocumentCaptureAccumulator;
  /** Latest accepted doc.step capability for this loaded body. */
  document?: TimelapseDocumentRef;
}

export interface MiniEditorTimelapsePorts {
  recordChangeEvent: (
    input: RecordEventInput,
  ) => TimelapseAcceptedEnqueueReceipt | null | void;
  reportCaptureFailure: (error: unknown) => void;
}

const defaultPorts: MiniEditorTimelapsePorts = {
  recordChangeEvent,
  reportCaptureFailure() {
    // Step JSON can include author prose. Keep production logging fixed and
    // content-free while preserving the editor's fail-soft behavior.
    debugLog.warn("timelapse", "mini editor capture failed", {
      sensitivity: "safe",
      fields: {
        operation: "recordMiniEditorTransaction",
        outcome: "failed",
      },
    });
  },
};

export function createLoadedMiniEditorTimelapseAuthority(
  projectId: string,
  documentKey: MiniEditorDocumentKey,
): LoadedMiniEditorTimelapseAuthority {
  const copiedDocumentKey =
    documentKey.kind === "codex"
      ? {
          kind: "codex" as const,
          id: documentKey.id,
          phaseId: documentKey.phaseId,
        }
      : { kind: "snippet" as const, id: documentKey.id };
  const documentIdentity: TimelapseDocumentIdentity =
    copiedDocumentKey.kind === "codex"
      ? {
          projectId,
          domain: "codex",
          entityType: "codex_entry",
          entityId: copiedDocumentKey.id,
        }
      : {
          projectId,
          domain: "snippet",
          entityType: "snippet",
          entityId: copiedDocumentKey.id,
        };
  return {
    projectId,
    documentKey: copiedDocumentKey,
    documentIdentity,
    captureAccumulator:
      createTimelapseDocumentCaptureAccumulator(documentIdentity),
  };
}

export function recordMiniEditorTransaction(
  input: {
    transaction: Transaction;
    authority: LoadedMiniEditorTimelapseAuthority | null;
    isApplyingExternalUpdate: boolean;
  },
  ports: MiniEditorTimelapsePorts = defaultPorts,
): void {
  const { transaction, authority, isApplyingExternalUpdate } = input;
  if (!transaction.docChanged || !authority || isApplyingExternalUpdate) {
    return;
  }

  const { documentKey } = authority;
  // Phase bodies do not yet have a matching baseline/replay stream. They must
  // never be recorded against the base Codex entity.
  if (documentKey.kind === "codex" && documentKey.phaseId !== null) return;

  if (
    isTimelapseReplacementFenceActiveForDocument(
      authority.projectId,
      documentKey,
    )
  ) {
    // Fence denial is expected during an authoritative replacement and must
    // not poison the accepted prefix for a later retry.
    return;
  }

  try {
    const receipt = ports.recordChangeEvent({
      domain: documentKey.kind === "codex" ? "codex" : "snippet",
      opType: "doc.step",
      projectId: authority.projectId,
      sceneId: null,
      entityType: documentKey.kind === "codex" ? "codex_entry" : "snippet",
      entityId: documentKey.id,
      payload: {
        steps: serializeTransactionSteps(transaction.steps),
      },
    });
    if (receipt?.document) authority.document = receipt.document;
    authority.captureAccumulator.accept(receipt ?? null);
    if (authority.captureAccumulator.broken) {
      authority.document = undefined;
    }
  } catch (error) {
    authority.captureAccumulator.markBroken();
    authority.document = undefined;
    ports.reportCaptureFailure(error);
  }
}
