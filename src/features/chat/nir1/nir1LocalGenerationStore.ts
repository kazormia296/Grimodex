import { create } from "zustand";
import {
  createNir1LocalGenerationTurn,
  type Nir1LocalGenerationTurn,
  type Nir1LocalTurnPorts,
  type Nir1LocalTurnSnapshot,
  type Nir1LocalTurnTarget,
} from "@/application/chat/nir1LocalGenerationTurn";
import {
  cancelNir1LocalGeneration,
  continueNir1LocalGeneration,
  startNir1LocalGeneration,
} from "./nir1LocalGenerationApi";
import type { Nir1LocalPurposeGate } from "./nir1LocalPolicyGate";

/**
 * The document's local generations (DD-1c, DR-DD1C-4): the latest generation
 * of each local conversation, kept while the panel is unmounted and across
 * conversation and scene switches, so the polling runs to the terminal and
 * the stop stays reachable. Nothing is persisted; the handles stay inside the
 * state machines and are dropped at their terminals (a reload loses them,
 * DR-DD1B-19). A lazy chunk behind `NIR1_LOCAL_GENERATION_UI_ENABLED`.
 */

interface Nir1LocalGenerationState {
  /** The latest generation's snapshot of each conversation. */
  readonly turns: Readonly<Record<string, Nir1LocalTurnSnapshot>>;
}

export const useNir1LocalGenerationStore = create<Nir1LocalGenerationState>(
  () => ({ turns: {} }),
);

const DEFAULT_PORTS: Nir1LocalTurnPorts = {
  start: startNir1LocalGeneration,
  continue: continueNir1LocalGeneration,
  cancel: cancelNir1LocalGeneration,
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/** The latest machine of each conversation (older ones finish on their own). */
const latest = new Map<string, Nir1LocalGenerationTurn>();

function publish(snapshot: Nir1LocalTurnSnapshot): void {
  useNir1LocalGenerationStore.setState((state) => ({
    turns: { ...state.turns, [snapshot.conversationId]: snapshot },
  }));
}

/**
 * Start a generation for an accepted capture. A purpose the AI usage policy
 * hides or cannot read is refused here without IPC (the renderer's
 * `blockIfPolicyOff` layer; Native decides again).
 */
export function dispatchNir1LocalGeneration(
  target: Nir1LocalTurnTarget,
  gate: Nir1LocalPurposeGate,
  ports: Nir1LocalTurnPorts = DEFAULT_PORTS,
): void {
  if (gate.presentation !== "enabled") {
    latest.delete(target.conversationId);
    publish({
      ...target,
      phase: "refused",
      text: "",
      thinking: "",
      reason:
        gate.presentation === "pending"
          ? "NIR1_LOCAL_UNAVAILABLE"
          : gate.reason,
      ipcError: null,
      terminalCode: null,
      canCancel: false,
      cancelRequested: false,
    });
    return;
  }
  const turn = createNir1LocalGenerationTurn(target, ports, (snapshot) => {
    // Only the latest generation of the conversation is shown.
    if (latest.get(target.conversationId) === turn) publish(snapshot);
  });
  latest.set(target.conversationId, turn);
  turn.start();
}

/** Ask the conversation's latest generation to stop. */
export function cancelNir1LocalGenerationOf(conversationId: string): void {
  latest.get(conversationId)?.cancel();
}

export function useNir1LocalTurn(
  conversationId: string | null,
): Nir1LocalTurnSnapshot | null {
  return useNir1LocalGenerationStore((state) =>
    conversationId === null ? null : (state.turns[conversationId] ?? null),
  );
}

/** Tests only. */
export function resetNir1LocalGenerationsForTest(): void {
  latest.clear();
  useNir1LocalGenerationStore.setState({ turns: {} });
}
