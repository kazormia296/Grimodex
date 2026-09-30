import {
  DURATION_KINDS,
  NARRATIVE_FRAMES,
  OBSERVATION_ACTUALITIES,
} from "@/features/chronicle/extraction/schemas";

function choices(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join("、");
}

/** Shared model-visible claim contract; enum vocabulary comes from the parser. */
export const OBSERVATION_CLAIM_GUIDANCE = `JSON のルートはオブジェクトとし、observations 配列だけを持たせます。説明用の欄や別のラッパーを追加しないでください。各 Observation の localId は空でない文字列です。payload.predicate は何が起きた、または想定されたかを示す空でない述語です。
payload.actuality は ${choices(OBSERVATION_ACTUALITIES)} のいずれかです。"actual" は本文で成立が示された出来事、"planned" は計画、"intended" は意図、"attempted" は試み、"prevented" は阻止された出来事、"hypothetical" は条件付きの仮定、"counterfactual" は現実とは異なる仮定、"dreamed" は夢の内容を表します。計画・仮定・夢の内容を "actual" に置き換えないでください。本文から出来事の位置付けを判断できない場合は "unknown" を使います。
誰かが聞いた、伝え聞いた、噂として報告した内容で本文が真実を保証していない場合は "rumored" を使います。未確認の伝聞内容を "actual" や "unknown" に置き換えず、話者の attribution と narrativeFrame も本文どおり保持してください。
assertion.attribution は "narrator"、"unknown"、または "character:本文中の人物表記" の形式です。assertion.narrativeFrame は ${choices(NARRATIVE_FRAMES)} のいずれかです。"story-world" は作中の現実、"flashback" は回想、"dream" は夢、"reported" は報告・発話内、"hypothetical" は仮定内の叙述の枠を表し、枠を判断できなければ "unknown" を使います。
attribution は主張の帰属、narrativeFrame は叙述の枠、actuality は出来事の様態を表す独立した軸です。人物が話した行為と発話内の内容を混同せず、各 Observation が何を主張するかに応じて値を選んでください。報告の枠だから "actual"、人物帰属だから "rumored" と決め付けないでください。本文で裏付けられた出来事は、人物の報告内でも "actual" と character の attribution / "reported" の組合せを保持します。帰属は夢か現実かを表す欄ではなく、その主張を提示する主体です。語り手が夢の内容を述べる場合も "narrator" を保持します。
payload.participants は配列です。参加者を出す場合、各要素は {"surface":"本文中の表記","role":"出来事での役割"} のオブジェクトとし、文字列だけの要素は許可しません。surface と role はどちらも空でない文字列にしてください。参加者を本文から特定できない場合は [] にしてください。
payload.temporalExpressions は本文中の時間表現を文字列で並べる配列です。各要素は文字列であり、日時オブジェクトや座標値にしないでください。時間表現が無ければ [] にし、推測の暦日へ変換しないでください。
payload.durationKind は ${choices(DURATION_KINDS)} のいずれかです。"instant" は瞬間的な出来事、"bounded-interval" は区切られた期間、"ongoing-process" は継続中の過程を表します。本文だけでは継続時間を判定できない場合は、既定値へ決め打ちせず "unknown" を使い、推測で補わないでください。
任意の payload.semanticType を出す場合は出来事の分類を文字列で、payload.locationSurface を出す場合は本文中の場所表記を文字列で示します。本文から得られなければ任意欄を省略してください。出力例の値を既定値にせず、本文に応じて各欄を選んでください。`;

/** Citation IDs remain a separate protocol from legacy sourceRef + quote. */
export const CITATION_ID_OBSERVATION_GUIDANCE = `各 Observation は localId、evidenceRefs、assertion、payload の欄だけを持ちます。evidenceRefs は提示済み ID の空でない配列とし、同じ Observation 内に重複 ID を入れないでください。ID は一字一句そのままコピーし、ID の代わりに引用本文、座標、Source View ref を出力しないでください。`;
