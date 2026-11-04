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
