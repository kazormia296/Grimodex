import { invoke } from "@/lib/tauri";

export type Nir1PackingItem =
  | {
      readonly kind: "raw";
      readonly id: string;
      readonly text: string;
      readonly tokens: number;
    }
  | {
      readonly kind:
        | "acceptedIr"
        | "graphEvidence"
        | "authorDeclared"
        | "unreviewedForReview";
      readonly id: string;
      readonly text: string;
      readonly tokens: number;
      readonly atomicGroup: string;
    };

export interface Nir1PackingRequest {
  readonly budgetTokens: number;
  readonly items: readonly Nir1PackingItem[];
}

export interface Nir1PackedContext {
  readonly selectedIds: readonly string[];
  readonly omittedIds: readonly string[];
  readonly usedTokens: number;
  readonly remainingTokens: number;
}

/**
 * Applies the Native task-aware packing contract. Packing is request-local;
 * it does not persist context or transfer review history into a writing turn.
 */
export function packNir1Context(
  request: Nir1PackingRequest,
): Promise<Nir1PackedContext> {
  return invoke("nir1_pack_context", {
    payload: {
      budgetTokens: request.budgetTokens,
      items: request.items.map((item) => ({ ...item })),
    },
  });
}
