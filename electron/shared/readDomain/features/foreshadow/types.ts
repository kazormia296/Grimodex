export type ForeshadowStrength = "subtle" | "moderate" | "overt";
export type ForeshadowLoadBearing = "critical" | "supporting" | "optional";
export type ForeshadowKind =
  | "designated_existing"
  | "inserted_new"
  | "rewritten";
export type ForeshadowAttribution = "human" | "ai";
export type ForeshadowPersona = "careful" | "casual" | "skim";

export interface PersonaEvaluation {
  strength: ForeshadowStrength;
  reasoning: string;
}

export interface AiEvaluation {
  careful: PersonaEvaluation;
  casual: PersonaEvaluation;
  skim: PersonaEvaluation;
}

const VALID_STRENGTHS = new Set<string>(["subtle", "moderate", "overt"]);

function isPersonaEvaluation(v: unknown): v is PersonaEvaluation {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.strength === "string" &&
    VALID_STRENGTHS.has(o.strength) &&
    typeof o.reasoning === "string"
  );
}

/** aiReasoning カラムを AiEvaluation として解析する。Phase 1 の平文や不正 JSON は null を返す。 */
export function safeParseAiEvaluation(
  json: string | null,
): AiEvaluation | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as Record<string, unknown>;
    if (
      isPersonaEvaluation(o.careful) &&
      isPersonaEvaluation(o.casual) &&
      isPersonaEvaluation(o.skim)
    ) {
      return { careful: o.careful, casual: o.casual, skim: o.skim };
    }
    return null;
  } catch {
    return null;
  }
}

export type DerivedLabel =
  | "planned"
  | "seeded"
  | "paid"
  | "critical_weak"
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
  secret: boolean;
  loadBearing: ForeshadowLoadBearing | null;
  /** Aggregate OCC token. Every successful root update advances it once. */
  version: number;
  /** リンク先 Codex が変更された時刻。setup の lastEvaluatedAt より新しければ
   *  「Codex 変更により再評価が必要」として stale 扱いにする（未設定/null=未変更）。
   *  DB mapper は常に設定するが、テスト/内部 mapper の省略を許すため optional。 */
  codexLinkDirtyAt?: Date | null;
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
  /** Phase 2 以降は AiEvaluation の JSON 文字列 */
  aiReasoning: string | null;
  attribution: ForeshadowAttribution;
  aiRationale: string | null;
  lastEvaluatedAt: Date | null;
  isOrphan: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** UI 表示用：ロード時に treeNodes.updatedAt から付与。永続化しない。 */
  sceneUpdatedAt?: string;
}

export interface ForeshadowWithLabel extends ForeshadowRow {
  label: DerivedLabel;
  setupCount: number;
}

// ── AI 監査パス ───────────────────────────────────────────────────

export interface ChapterAuditRequest {
  chapterId: string;
  scenes: Array<{
    sceneId: string;
    title: string;
    bodyText: string;
    orderIndex: number;
  }>;
  existingForeshadows: Array<{
    id: string;
    title: string;
    intent: string | null;
  }>;
  relatedCodex: Array<{
    id: string;
    name: string;
    summary: string;
  }>;
}

export interface AuditCandidate {
  suggestedTitle: string;
  suggestedIntent: string;
  evidenceSceneId: string;
  evidenceExcerpt: string;
  rationale: string;
  confidence: "low" | "medium" | "high";
  similarToExistingForeshadowId?: string;
}

// ── 章別統計 ──────────────────────────────────────────────────────

export interface ChapterForeshadowStats {
  chapterId: string;
  totalScenes: number;
  scenesWithBody: number;
  byLabel: Partial<Record<DerivedLabel, number>>;
  orphanCount: number;
  needsStrengtheningCount: number;
}
