export type ImportRepairActionKind =
  | "encoding-select"
  | "decoder-override"
  | "role-override"
  | "partition-adjust"
  | "schema-map";

export interface EncodingDecision {
  readonly encoding: string;
  readonly confidence: "certain" | "likely" | "manual";
  readonly hadBom: boolean;
  readonly candidates?: readonly string[];
}

export interface ImportRepairAction {
  readonly actionId: string;
  readonly kind: ImportRepairActionKind;
  readonly targetKey: string;
  readonly label: string;
  readonly appliedAt?: string;
}

export interface ImportRepairRevision {
  readonly revisionId: string;
  readonly captureId: string;
  readonly actions: readonly ImportRepairAction[];
  readonly encodingDecisions: Readonly<Record<string, EncodingDecision>>;
  readonly createdAt: string;
}
