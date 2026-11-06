# Chronicle 抽出の prompt cache（送り方の決定記録）

2026-11-04。対象は narrative_observation_extract／narrative_event_synthesize／narrative_structured_repair の
要求（`send_chat_message` 経路）。

## 問題

抽出の 3 段は prompt 全体を 1 つの user message で送っていた。system も `systemCacheSegments` も無いので
`cache_control` が付かず、usage の cache_read は常に空だった。合成は 1 Scene で数十回呼ばれ、指示（約 1,200 字）は
毎回同じである。

## 決定

- prompt の文字列は変えない。`buildChroniclePromptArtifact` が組む
  `instruction + "\n\n# Context Set (chronicle.prompt/1)\n" + <Context Set の値> + "\n\n# Output (JSON only)\n" + outputShape` のうち、
  Context Set の値より前（`splitChroniclePromptForCache`）を静的 prefix とする。`prefix + rest` は元の
  `messages[0].content` と一字一句同じ（by construction。形が合わなければ分割しない）。
- 分割は cache が効く経路でだけ行う。Anthropic、または OpenRouter で model に `claude` を含む場合
  （grimodex-ai の `supports_prompt_cache` と同じ規則）。OpenRouter の Responses API（`apiVariant=responses`）は
  segment を無視するので分割しない。Anthropic は Responses API を使わない（Rust の `uses_responses_api` は OpenAI 系
  だけ）ので、残った global の `modelApiVariant=responses` で cache を止めない（試験で固定）。それ以外は従来どおり単一の user message。
- 分割するとき、prefix を `{role:"system"}` の message と `systemCacheSegments: [prefix]` で、残りを user message で渡す。
  chat と同じ仕組みで、Rust・IPC・契約の変更は無い。
- prefix が 512 字未満なら分割しない（Anthropic の最小 512 token に届かない見込みで、cache されないのに role だけ変わるため。字数は下限の目安で保証ではない）。
  legacy の structured repair は指示が短く、この条件で従来どおりになる（citation-id の repair は下記）。
- 本番の observation は citation-id-v2 の契約（`CITATION_ID_OBSERVATION_CONTRACT`、定数）で、同じ builder を通る。
  prefix は約 2,200 字で Scene・catalog を含まない（試験で固定）。
- structured repair は経路で分かれる。citation-id の repair は指示に観測の意味規則（`OBSERVATION_CLAIM_GUIDANCE`
  約 1,958 字など）を含み、prefix が 2,000 字を超えるので分割して cache する（試験で segment 非空・
  roles が `[system, user]`・壊れた出力と catalog が prefix に無いことを固定）。legacy の repair は指示が約 170 字で
  下限に届かず、従来どおり単一の user message のまま（試験で固定）。legacy の repair は恩恵が無いのは意図どおり。
- cache の segment に入れないもの：Scene 本文・cluster ref・Observation 行・evidence catalog・repair の壊れた出力
  （毎回変わる）。出力形式（outputShape）も静的だが Context Set の後ろにあるため prefix cache の対象にできない。
  順序は変えない（変えると prompt の指示の変更になる）。
- route の解決は `resolveChatAuditRoute`（transport が封じるのと同じ override > settings の優先順）を使う。解決の
  後から settings が変わると分割の有無と実 route がずれ得るが、結果は「cache が効かない」か「system と user に
  分かれる」だけで、送る文字列は変わらない。
- `input.send`（試験・live eval の注入）の経路は従来のまま（分割しない）。live eval では cache は働かない。

## 監査

- `finalRequestDigest`／`componentContractDigest`／`contextSetDigest` は分割前の artifact から計算するので値は変わらない。
  receipt の形・field は不変（新しい契約ではない）。
- 監査の request には分割後の messages と `modelVisibleContext.systemCacheSegments` が記録される（既存の chat と同じ形）。
  Rust の観測は実際の HTTP body（system が block の配列、`cache_control: ephemeral`）を記録する。
- `finalRequestDigest` は「正準 prompt（wire の messages を連結したもの＝分割前の単一 user message）」の digest であり、
  wire の形（`[system, user]`）の digest ではない。cache が効く経路の監査 request.messages は 2 件で、segment の
  本文は `modelVisibleContext.systemCacheSegments` にも出る。repo 内に wire の messages から digest を再計算する検証は
  無い（transport は protected field が不変であることだけを見る）。再計算する検証者は system と user を連結する。
  digest の値・receipt の形・束縛する対象（モデルが読む文字列）は変わらないので、新しい契約ではない。
  試験で「分割した経路と分割しない経路で 3 つの digest が一致」「連結が正準 prompt と一致」「監査 request の形」を固定した。
- single-shot の監査 usage に `cacheReadTokens`／`cacheWriteTokens` を通した（これまで transport が捨てていた）。
  usage の既存 field で、receipt の形は変わらない。cache の hit が無かった過去の行が全件空だった理由は
  `cache_control` が無かったことに加え、この脱落でもある。
- ai_usage 台帳（`recordAiUsage`）も 3 段で `cacheReadTokens`／`cacheWriteTokens` を記録する。Anthropic の
  `input_tokens` は cache 分を含まない（合計 = input + read + write）ので、`tokensIn` は非 cache 分だけになり、
  cache の読み書きは専用列に入る（chat と同じ列の意味）。

## 残る課題

- 効果は audit の usage と ai_usage 台帳の `cacheReadTokens`／`cacheWriteTokens` で測る。prefix の token 数は
  字数からの推定で、合成の prefix は約 1,230 字（約 1,100 token/回の入力のうち 700〜800 token 程度の見込み）。
- 下限 512 字は Sonnet 5.5（cache 最小 512 token）を想定した目安で、モデル別の最小値ではない。最小が大きい model
  （1,024 以上など）では role が system になるだけで cache されない（cache_creation = 0）。下限未満の書き込みは課金されない
  ので追加費用は無い。モデル別の下限が必要になったら `route.model` で引く。
- 指示が user から system に移る（文字列は同じ）。モデルの挙動への影響は Gold／測定で確かめる。
  `GDX-NARR-EVIDENCE-001`／`SEMANTIC-001` が 3 つの run\*Task を実装対象に挙げるので、merge 前に
  grimodex-impact-gate と live eval で退行が無いことを確かめてから有効にする（段階展開するなら citation-id の
  observation を先にする）。live eval は注入 send を使うので分割されず、この変更の影響を測れない点に注意。
- outputShape を cache に含めるには出力形式を Context Set の前へ移す必要がある。prompt の順序の変更なので、
  grimodex-author の品質規則の対象として別 lane で扱う。

## Heavy の確認の手段（diagnostic harness）

merge の前に要る「指示が user から system に移っても品質が変わらない」ことの確認の手段。既存の live eval
（`chronicleProduction.live.test.ts`）は OpenRouter と注入の `send` を使い、`send` があると route を解決せず分割しない
ので、分割の経路を通せない。そこで診断だけの harness を足した。置き場は
`scripts/quality/chronicle-prompt-cache-diag/`。**diagnostic only で、certification・認証 run・baseline・fixture・
`evals/narrative/manifest.yaml` の attempt 規則には関わらない。**

### 設計

- 製品の `runObservationExtractionTask`／`runEventSynthesisTask`（と `runProductionChroniclePipeline` の
  clustering・proposal planning・scoring）を **そのまま** 通す。prompt の文言は書き直さない。
- 製品の `buildChroniclePromptRequest` も本物。差し替えるのは 2 点だけ。
  - `resolveChroniclePromptRoute`：分割あり＝Anthropic に解決、分割なし＝cache 非対応の route（openai）に解決。
  - `sendChatMessageWithThinking`（transport）：task が組んだ `messages`／`systemCacheSegments` を Anthropic の
    Messages API へ fetch で直接送る（`anthropicPayload.ts`）。
- payload は製品の Rust（`build_anthropic_chat_body`／`build_system_payload`／`anthropic_beta_headers`）と揃える。
  分割あり＝`system` が `[{type:"text", text:<prefix>, cache_control:{type:"ephemeral"}}]`、user が rest、
  header に `anthropic-beta: prompt-caching-2024-07-31`。分割なし＝`system` 無しで user に全文。
  temperature・thinking は付けず、`max_tokens` は claude の major 5 以上で 32,000（製品の既定）。
  単体試験で、分割ありの system block に `cache_control` が付くこと、system と user の連結が元の prompt と
  一字一句同じこと、分割なしに `system` が無いことを固定した（API は mock）。
  製品との差：製品の transport は 429 を `send_with_429_retry` で扱うが、harness は 429／5xx／529／通信エラーを
  最大 4 回まで backoff で再送する。それ以外（監査 ledger・IPC・Rust の HTTP 層）は通らない。
- case は Gold から種を固定して選ぶ：`chronicle-micro-v1` から 3、`chronicle-motif-boundary-v1` から 2
  （seed `chronicle-prompt-cache-diag/v1`、`selection.ts`）。各 case を {分割あり, 分割なし} × 2 run、
  分割あり／なしを交互に走らせる。
- 記録するのは件数・score・digest・usage だけ（本文・題名・LLM の応答は入れない）。run ごとに、観測数・
  仮説数・採用された提案数（`plannedProposals`）・Gold の採点（`passed`、dimension 合計の TP／FP／FN、
  critical violation 数、parse failure 数）・観測の意味 field を正規化した graph digest・dispatch ごとの
  usage（input／output／cache_read／cache_write）と応答 digest、製品が組んだ request の形（roles と segment 数）。
  失敗した呼出しは件数で記録し、その run は failed とする。
- report は `.artifacts/chronicle-prompt-cache-diag/<runId>/report.{json,md}`（repo には commit しない）。
- key は env `ANTHROPIC_API_KEY`、または製品の profile の `ai-keys.json`（safeStorage、keyring の
  "Chromium Safe Storage"）を Electron の helper で復号して FIFO で受け取る（PD 評価と同じ方式）。値は log・report・
  stdout に出さず、子の vitest の env にだけ渡す。keyring・`ai-keys.json` は読むだけで書かない。
- 使い方：`node scripts/quality/chronicle-prompt-cache-diag/run.mjs`（`--check-key` は key の取得だけを確かめる）。
  `GDX_DIAG_RUNS`／`GDX_DIAG_CASE_IDS`／`GDX_DIAG_MODEL` で絞れる。試験は
  `vitest --config scripts/quality/chronicle-prompt-cache-diag/vitest.config.mjs --run`（key が無ければ live は skip）。

### 変えないもの

認証 run・baseline・fixture・Gold の case file・`evals/narrative/manifest.yaml`・製品の経路（`src/` の
transport、Rust、IPC、契約）。harness は `src/` の既存の関数を import するだけで、`src/` に変更を加えない。

### 判定の読み方

閾値は置かない。各 case × 指標について、同じ形の 2 run の差の最大（`withinMax`）と、分割あり／なしの平均の差
（`betweenMeanDiff`）を並べ、`betweenMeanDiff <= withinMax` なら `within-noise`、超えたら `exceeds-noise`、
失敗した run があれば `incomplete` と印を付ける。印は機械的な目安で、「変わらない」の判断は integrator と
ユーザーが表を見て行う。run が 2 回だけなので `withinMax` は小さく見積もられやすく（0 になり得る）、
`exceeds-noise` は即「退行」ではなく、run を増やすか内容を見る合図として読む。graph digest の一致は、
観測の意味 field（actuality・attribution・narrativeFrame・evidence・clustering・significance・proposalGate）の
集合が完全に一致したことを示す。応答の文字列は sampling で揺れるので、応答 digest の一致は要求しない。

### 結果（2026-11-06、claude-sonnet-5-5、Anthropic Messages API 直接）

Gold 5 件（`chronicle-micro-v1` から blocked-attempt-004・rumor-only-003・significance-gate-014、
`chronicle-motif-boundary-v1` から sword-atmosphere-019・sword-character-theory-018。seed 固定）を
{分割あり, なし} × 2 run（+ 差が出た 3 件を 5 run に拡張）で実行した。失敗した run 0、失敗した呼出し 0、再送 0、
request の形の不一致 0（分割ありは全呼出しが `[system, user]`＋segment 1、なしは `[user]`）。

- 本番の採点（quote の完全一致で Gold に対応づく）は、Sonnet が Gold より少し長い span を引用するため、
  分割あり／なしの**両方**で全 case が `passed=0`・TP が 0 に近い。これは今回の変更と無関係な既存の性質で、
  比較の道具としては鈍い。そのため harness は quote の包含で対応づける緩い指標
  （requiredCovered・actualityMatch・significanceMatch・proposalGateMatch・forbiddenClaimed）を足している
  （診断だけで、本番の採点・certification には使わない）。
- 差が無かったもの（5 件すべて、全 run）：parse failure 0、critical violation（019 の 1 件は両形で同じ）、
  requiredCovered、actualityMatch、proposalGateMatch、forbiddenClaimed、観測数・仮説数・提案数
  （019・018 の ±1 件のばらつきは分割なしだけでなく分割ありの run でも、別の report でも両方向に出る）。
- 差が出たもの：`significance`（合成の重要度）。significance-gate-014 は 5 run とも一貫して、分割ありが
  Gold の significance に 2/2 一致、分割なしが 1/2 一致（分割ありの方が Gold に近い）。rumor-only-003 は
  分割ありが minor×3、分割なしが incidental を 1〜2 件含む（Gold の significance 指定が無く、採否には影響しない。
  分割なしの run の間でも minor／incidental が揺れる）。
- 緩い指標以外の graph digest は 5 件中 1〜3 件で形の間に差がある。差の部分は significance／hypotheses が中心で、
  018 の attribution（"character:ダリオ"／"character:衛兵ダリオ" の表記揺れ）は分割なしの run の間でも出る。
- usage：分割ありは cache_read が全呼出しの 2 回目以降に載る（合計 8,422〜26,161 token、観測 prefix が約 1,658、
  合成 prefix が約 851 token）。入力（非 cache 分）は分割なしの約 4 分の 1（例 2,740 対 11,162）。cache_write は
  この実行では 0（同じ prefix を直前の実行が書いて 5 分の TTL 内に残っていたため。初回は観測 1,658・合成 851 token の
  書込みを別の smoke で確認した）。出力 token は同程度。
- 読み：件数と意味の指標（actuality・採否・forbidden・critical）は分割あり／なしで退行を示さず、差は
  significance の割り当て（borderline の incidental／minor、gate case の major 判定）に限られる。gate case では
  分割ありの方が Gold に一致した。2 run（拡張で 5 run）の範囲では、digest の違いは「指示が system に移ったこと」と
  sampling の揺れを分離できていない。significance の方向が再現するので、変化はある（悪化ではない）と読むのが正確で、
  「完全に同一」とは言えない。判断は表（`.artifacts/chronicle-prompt-cache-diag/`）を見て integrator とユーザーが行う。
