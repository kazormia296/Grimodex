export type ForeshadowStrength = "subtle" | "moderate" | "overt";
export type ForeshadowKind =
  | "designated_existing"
  | "inserted_new"
  | "rewritten";
export type ForeshadowAttribution = "human" | "ai";

export type DerivedLabel =
  | "planned"
  | "seeded"
  | "paid"
  | "needs_strengthening"
  | "orphan_payoff"
  | "abandoned";

export interface ForeshadowRow {
  id: string;
  projectId: string;
  title: string;
  intent: string | null;
  notes: string | null;
  payoffSceneId: string | null;
  payoffFromPos: number | null;
  payoffToPos: number | null;
  payoffConfirmed: boolean;
  abandoned: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ForeshadowSetupRow {
  id: string;
  foreshadowId: string;
  sceneId: string;
  fromPos: number;
  toPos: number;
  kind: ForeshadowKind;
  strength: ForeshadowStrength | null;
  aiStrength: ForeshadowStrength | null;
  aiReasoning: string | null;
  attribution: ForeshadowAttribution;
  aiRationale: string | null;
  lastEvaluatedAt: Date | null;
  isOrphan: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ForeshadowWithLabel extends ForeshadowRow {
  label: DerivedLabel;
  setupCount: number;
}
