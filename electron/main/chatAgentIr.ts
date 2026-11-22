/**
 * chat IR S1-A (DR-CHATIR-S1-27): Main's gate of `chat_agent_ir_select`, the
 * one-shot that hands the chat agent approved Chronicle IR.
 *
 * It is closed in every launch. There is no CI seam and no opener (design 4.3:
 * a seam would be a way to open the route that the confirmed threat model's
 * matrix does not have); how the route is opened is S3's decision, under the
 * same approval. The gate runs first in the invoke handler, before the sender,
 * the profile gate, the argument check and Native are reached, so a refused call
 * has used nothing. Native's own gate (`PrePublicationEntry::ChatAgentIr`) and
 * the renderer's constant are the other two closures.
 */
import type { Envelope } from "../shared/ipcContract.js";

export const CHAT_AGENT_IR_COMMAND = "chat_agent_ir_select";
export const CHAT_AGENT_IR_GATE_CLOSED = "CHAT_IR_GATE_CLOSED";

/**
 * A refusal envelope while the gate is closed, `null` for any other command.
 * An error, not an IR status: the closed gate is not an answer of the route.
 */
export function chatAgentIrGateRefusal(command: string): Envelope | null {
  if (command !== CHAT_AGENT_IR_COMMAND) return null;
  return {
    ok: false,
    error: `${CHAT_AGENT_IR_GATE_CLOSED}: the chat IR route is closed`,
  };
}
