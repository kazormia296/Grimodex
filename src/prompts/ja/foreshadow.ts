import { JSON_ONLY } from "../shared/jsonContract";

export function buildProposePastSetupsPromptJa(params: {
  intent: string;
  payoffSceneId: string;
  payoffExcerpt: string;
  sceneSummary: string;
  codexSummary: string;
}): string {
  return [
    "あなたは小説編集アシスタントです。",
    "回収シーンを成立させるために、過去シーンに置く setup 候補を提案してください。",
    "",
    "【ルール】",
    '- 既存テキストに適切な箇所がある場合は kind="designated_existing" とし、existingExcerpt（該当テキスト抜粋）とfromPosHint/toPosHint（概算位置）を含めること。',
    '- 既存テキストに適切な箇所がない場合は kind="inserted_new" とし、suggestedInsertionPoint（「○○の段落の後」等）とsuggestedText（挿入推奨文）を必ず含めること。',
    "- 両方の kind を混在させて提案してよい。",
    "",
    "JSON 形式:",
    '{"candidates":[{"sceneId":"...","kind":"designated_existing|inserted_new","existingExcerpt":"...","fromPosHint":1,"toPosHint":2,"suggestedInsertionPoint":"...","suggestedText":"...","rationale":"...","predictedStrength":"subtle|moderate|overt"}]}',
    JSON_ONLY,
    "",
    `intent: ${params.intent}`,
    `payoffSceneId: ${params.payoffSceneId}`,
    `payoffExcerpt: ${params.payoffExcerpt}`,
    "",
    "[pastScenes]",
    params.sceneSummary || "(none)",
    "",
    "[relatedCodex]",
    params.codexSummary || "(none)",
  ].join("\n");
}

export function buildEvaluateSetupStrengthPromptJa(params: {
  foreshadowIntent: string;
  setupExcerpt: string;
}): string {
  return [
    "あなたは小説編集アシスタントです。",
    "以下の「伏線テキスト」が、異なる読者ペルソナにとってどれほど伏線として気づかれるかを評価してください。",
    "payoff（回収シーン）の内容は渡しません。読者の初読視点で評価してください。",
    "",
    "【ペルソナ定義】",
    "- careful（精読者）: テキストを丁寧に読み、細かい描写も見逃さない読者",
    "- casual（普通の読者）: 標準的なペースで読み、印象に残る描写は覚えている読者",
    "- skim（流し読み）: ストーリーの大筋を追うだけで細部を読み飛ばす読者",
    "",
    "【強度の定義】",
    "- subtle: そのペルソナには伏線として気づかれにくい（自然に溶け込んでいる）",
    "- moderate: 気づく読者も気づかない読者もいる中程度の強さ",
    "- overt: そのペルソナには伏線だと明確に分かる（読者が意識する）",
    "",
    'JSON形式: {"careful":{"strength":"subtle|moderate|overt","reasoning":"..."},"casual":{"strength":"...","reasoning":"..."},"skim":{"strength":"...","reasoning":"..."}}',
    JSON_ONLY,
    "",
    `【伏線の意図】${params.foreshadowIntent}`,
    "",
    `【伏線テキスト】\n${params.setupExcerpt}`,
  ].join("\n");
}

export function buildAuditChapterPromptJa(params: {
  existingList: string;
  codexList: string;
  sceneTexts: string;
}): string {
  return [
    "あなたは小説編集アシスタントです。",
    "以下の章のシーン本文を読み、登録漏れの伏線候補を抽出してください。",
    "",
    "【ルール】",
    "- 本文に実際に書かれている描写・言及のみを根拠とする（推測・捏造禁止）",
    "- 「さりげない描写」「具体的なディテール」「繰り返される言及」「不自然な強調」を優先的に拾う",
    "- 既存伏線リストと意味が近い候補は similarToExistingForeshadowId にそのIDを入れる",
    "- confidence: 確信できない場合は low、中程度は medium、明らかな場合のみ high",
    "- 確信できない候補は提案しない（偽陽性を避ける）",
    "- 各候補に evidenceSceneId と evidenceExcerpt（本文からの直接引用、20〜80字）が必須",
    "",
    'JSON形式: {"candidates":[{"suggestedTitle":"...","suggestedIntent":"...","evidenceSceneId":"...","evidenceExcerpt":"...","rationale":"...","confidence":"low|medium|high","similarToExistingForeshadowId":"(省略可)"}]}',
    JSON_ONLY,
    "",
    "[既存登録済み伏線（除外リスト）]",
    params.existingList,
    "",
    "[関連Codex]",
    params.codexList,
    "",
    "[シーン本文]",
    params.sceneTexts,
  ].join("\n");
}
