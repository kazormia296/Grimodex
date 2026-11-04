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
  （grimodex-ai の `supports_prompt_cache` と同じ規則）。Responses API（`apiVariant=responses`）は segment を
  無視するので分割しない。それ以外は従来どおり単一の user message。
- 分割するとき、prefix を `{role:"system"}` の message と `systemCacheSegments: [prefix]` で、残りを user message で渡す。
  chat と同じ仕組みで、Rust・IPC・契約の変更は無い。
- prefix が 512 字未満なら分割しない（Anthropic の最小 512 token に届かず、cache されないのに role だけ変わるため）。
  structured repair の指示は短く、この条件で従来どおりになる。
- cache の segment に入れないもの：Scene 本文・cluster ref・Observation 行・evidence catalog・repair の壊れた出力
  （毎回変わる）。出力形式（outputShape）も静的だが Context Set の後ろにあるため prefix cache の対象にできない。
  順序は変えない（変えると prompt の指示の変更になる）。
- route の解決は `resolveChatAuditRoute`（transport が封じるのと同じ override > settings の優先順）を使う。解決の
  後から settings が変わると分割の有無と実 route がずれ得るが、結果は「cache が効かない」か「system と user に
  分かれる」だけで、送る文字列は変わらない。
- `input.send`（試験・live eval の注入）の経路は従来のまま。

## 監査

- `finalRequestDigest`／`componentContractDigest`／`contextSetDigest` は分割前の artifact から計算するので値は変わらない。
  receipt の形・field は不変（新しい契約ではない）。
- 監査の request には分割後の messages と `modelVisibleContext.systemCacheSegments` が記録される（既存の chat と同じ形）。
  Rust の観測は実際の HTTP body（system が block の配列、`cache_control: ephemeral`）を記録する。

## 残る課題

- 効果は audit の usage（`cacheReadTokens`／`cacheWriteTokens`）で測る。prefix の token 数は字数からの推定で、
  合成の prefix は約 1,230 字。
- 指示が user から system に移る（文字列は同じ）。モデルの挙動への影響は Gold／測定で確かめる。
- outputShape を cache に含めるには出力形式を Context Set の前へ移す必要がある。prompt の順序の変更なので、
  grimodex-author の品質規則の対象として別 lane で扱う。
