/**
 * Agent foreshadow writes — chat-agent counterpart of the MCP foreshadow
 * tools, on the same tracked path (tracked_foreshadow_create/update:
 * entity + undo_journal + change_event in one tx, surface "in-app-agent").
 */
import type { ForeshadowRow } from "@/features/foreshadow/types";

export type AgentForeshadowLoadBearing = "critical" | "supporting" | "optional";

export interface AgentForeshadowCreateInput {
  title: string;
  intent?: string;
  notes?: string;
  loadBearing?: AgentForeshadowLoadBearing;
  /** Defaults to true (MCP parity): secret plants stay out of AI context. */
  secret?: boolean;
}

export interface AgentForeshadowUpdateInput {
  foreshadowId: string;
  title?: string;
  intent?: string;
  notes?: string;
  loadBearing?: AgentForeshadowLoadBearing;
  payoffConfirmed?: boolean;
  abandoned?: boolean;
  secret?: boolean;
}

export async function agentCreateForeshadow(
  _input: AgentForeshadowCreateInput,
): Promise<ForeshadowRow> {
  throw new Error("unimplemented");
}

export async function agentUpdateForeshadow(
  _input: AgentForeshadowUpdateInput,
): Promise<ForeshadowRow> {
  throw new Error("unimplemented");
}
