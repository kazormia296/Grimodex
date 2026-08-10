import type { NarrativeGoalInference } from "@/features/narrative-extraction/ir/inferences/narrativeGoal";
import type { NarrativeOpenQuestionInference } from "@/features/narrative-extraction/ir/inferences/narrativeOpenQuestion";
import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import type { ForeshadowSetupSignalInference } from "@/features/narrative-extraction/ir/inferences/foreshadowSetupSignal";
import type { ForeshadowPayoffSignalInference } from "@/features/narrative-extraction/ir/inferences/foreshadowPayoffSignal";
import type { DocumentRef } from "@/features/narrative-extraction/temporal/nodes";
import {
  isMaterialPayoffSignal,
  isMaterialSetupSignal,
} from "./foreshadowGates";

export interface ForeshadowSignalIndexEntry {
  readonly signalId: string;
  readonly documentRef: DocumentRef;
  readonly clusterKey: string;
  readonly readingOrderIndex: number;
  readonly kind: "setup" | "payoff";
}

export interface ForeshadowSignalIndex {
  readonly setupEntries: readonly ForeshadowSignalIndexEntry[];
  readonly payoffEntries: readonly ForeshadowSignalIndexEntry[];
  readonly byClusterKey: ReadonlyMap<
    string,
    readonly ForeshadowSignalIndexEntry[]
  >;
}

export interface BuildForeshadowSignalIndexInput {
  readonly goals?: readonly NarrativeGoalInference[];
  readonly questions?: readonly NarrativeOpenQuestionInference[];
  readonly events?: readonly EventHypothesis[];
  readonly setupSignals?: readonly ForeshadowSetupSignalInference[];
  readonly payoffSignals?: readonly ForeshadowPayoffSignalInference[];
  /**
   * Resolves cluster identity for a setup/payoff signal. Returning null drops
   * the signal (unresolved cluster / failed gate upstream).
   */
  readonly resolveClusterKey?: (input: {
    readonly signalId: string;
    readonly kind: "setup" | "payoff";
    readonly documentRef: DocumentRef;
  }) => string | null;
}

function stubClusterFromDocument(documentRef: DocumentRef): string {
  return `doc-cluster:${documentRef}`;
}

/**
 * Build deterministic indexes from goal/question/event stubs plus explicit
 * setup/payoff signal inferences. Materiality gates mirror foreshadowGates.
 */
export function buildForeshadowSignalIndex(
  input: BuildForeshadowSignalIndexInput,
): ForeshadowSignalIndex {
  const resolveClusterKey =
    input.resolveClusterKey ??
    ((row) => stubClusterFromDocument(row.documentRef));

  const entries: ForeshadowSignalIndexEntry[] = [];
  const groups = new Map<string, ForeshadowSignalIndexEntry[]>();

  const pushEntry = (entry: ForeshadowSignalIndexEntry) => {
    entries.push(entry);
    const bucket = groups.get(entry.clusterKey);
    if (bucket) bucket.push(entry);
    else groups.set(entry.clusterKey, [entry]);
  };

  for (const signal of input.setupSignals ?? []) {
    if (signal.kind !== "foreshadow.setup-signal") continue;
    const payload = signal.payload;
    if (
      !isMaterialSetupSignal({
        materiality: payload.materiality,
        signalKind: payload.signalKind,
      })
    ) {
      continue;
    }
    const clusterKey = resolveClusterKey({
      signalId: payload.signalId,
      kind: "setup",
      documentRef: payload.documentRef,
    });
    if (!clusterKey) continue;
    pushEntry({
      signalId: payload.signalId,
      documentRef: payload.documentRef,
      clusterKey,
      readingOrderIndex: payload.readingOrderIndex,
      kind: "setup",
    });
  }

  for (const signal of input.payoffSignals ?? []) {
    if (signal.kind !== "foreshadow.payoff-signal") continue;
    const payload = signal.payload;
    if (
      !isMaterialPayoffSignal({
        materiality: payload.materiality,
      })
    ) {
      continue;
    }
    const clusterKey = resolveClusterKey({
      signalId: payload.signalId,
      kind: "payoff",
      documentRef: payload.documentRef,
    });
    if (!clusterKey) continue;
    pushEntry({
      signalId: payload.signalId,
      documentRef: payload.documentRef,
      clusterKey,
      readingOrderIndex: payload.readingOrderIndex,
      kind: "payoff",
    });
  }

  // Stub hooks: goals/questions/events contribute cluster keys only (no IR mutation).
  void input.goals;
  void input.questions;
  void input.events;

  return {
    setupEntries: entries.filter((e) => e.kind === "setup"),
    payoffEntries: entries.filter((e) => e.kind === "payoff"),
    byClusterKey: groups,
  };
}
