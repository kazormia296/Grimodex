# ADR-002: Codex Phase 解決モードを 3 種類維持する

## ステータス

採用済み (2026-05-13)

## コンテキスト

Codex（キャラクター/世界観/設定エントリ）は物語の進行に伴って状態が変わる。例: 「主人公アリス」の Codex を scene-3 で「変身後」、scene-12 で「覚醒後」に切り替えたい。Grimodex はこれを **Phase システム** で表現する (`codex_entry_phases` テーブル + `codex_phase_detail_overrides`)。

- Phase は **アンカーシーン** を持つ
- DetailsTab / AI 文脈ビルダーが「ある scene を編集中」に Codex の現在状態を計算する時、アンカーが「その scene 以前」にある Phase を順に積み上げて summary / content / detail-values を上書きする (`phaseResolver.ts:resolveCodexState`)

「以前」かどうかの判定にはシーンに **順序インデックス** を振る必要がある。この順序の作り方が `PhaseResolutionMode` で 3 種類 (`reading` / `story` / `auto`) ある (`phaseResolver.ts:computeSceneTimeIndex`)。

このモードがなぜ複数あるのか、なぜ統合・削除できないのかを記録しておく（経験上、設計意図が時間とともに自分でも分からなくなるため）。

## モード定義

| モード | 順序計算 | 想定読者 |
|---|---|---|
| `reading` | TipTap ツリーの DFS 順（執筆順 / 読者開示順） | 叙述トリック・ミステリー作品 |
| `story` | `scenes.story_time_order` 昇順 → 未設定は reading 順で末尾追加 | フラッシュバック・時系列入れ替え作品 |
| `auto` | story と実装は同一 | 既定推奨。storyTime 設定の有無で挙動が自動調整される |

`story` と `auto` は現状 `computeSceneTimeIndex` 内で実装が完全一致。`auto` は将来「project に storyTime 設定済み scene が 1 件もなければ reading 動作に倒す」など差別化する余地として名前を分けてある。現実装では同じ。

## 決定

3 モードをそのまま維持する。特に `reading` モードは削除しない。

## なぜ統合できないか — AI に叙述トリックが漏れる例

具体例で証明する。

### セットアップ

ミステリー作品。

- アリスは作品開始よりずっと前に犯行に及んでいる（pre-story）
- scene-15 で過去のフラッシュバック回想として読者に「アリス = 真犯人」が明かされる
- scene-15 の `story_time_order` は **過去**（事件発生時刻）
- scene-15 の DFS 順は **中盤**（執筆 manuscript で 15 番目）
- 作者は「アリス = 真犯人」Phase を **scene-15 にアンカー**（「ここで明かされる」設定）
- 作者は現在 scene-7（現在進行形、まだ事件発覚前）を AI に補完依頼中

### 処理の流れ

`chatStore.ts:188` → `resolveCodexState(entry, phases, ..., effectiveSceneId="scene-7", globalSceneOrder)` で計算:

1. globalSceneOrder を resolutionMode に従って生成
2. `currentOrder = order("scene-7")`
3. 各 phase について `anchorOrder = order("scene-15")` を比較
4. `anchorOrder ≤ currentOrder` なら phase を適用

### `reading` モード

- DFS 順: `order("scene-15") = 14`, `order("scene-7") = 6`
- `14 ≤ 6` → false → phase 適用されず
- AI には **Base のアリス（無実そう）** が渡る → ネタバレ防止 ✓

### `story` モード

- storyTimeOrder 順: scene-15 は過去なので `order("scene-15") = 0`, scene-7 は現在なので `order("scene-7") = 7`
- `0 ≤ 7` → true → phase 適用
- AI には **「真犯人アリス」** が渡る → 出力に犯人示唆が混ざる危険 ✗

### 回避策の不在

`story` モードのままミステリーでネタバレを防ぐには、Phase アンカーを「物語時系列で真実が成立する時点」より前にずらす必要がある。しかしミステリーの構造上、犯行は pre-story（manuscript 開始前）に起きている → アンカー可能なシーンが存在しない → 回避不能。

代替案として「真実は Base に書かず Phase で管理する」も検討したが、Phase アンカーが先頭 scene でも `order(scene-1) ≤ order(any-scene)` で常に適用されるので意味がない。

ゆえに **ミステリー・叙述トリック系では `reading` モード必須**。

### 対称な議論

フラッシュバック多用作品では `story` モード必須。例: scene-20 が時系列上の過去への回想で、その scene を執筆中の AI 補完に「まだ起きていない未来の Phase（scene-19 の事件）」が適用されると物語崩壊。`reading` モードでは scene-20 の DFS 順 > scene-19 の DFS 順なので適用されてしまう。`story` モードならフラッシュバックの storyTimeOrder は過去なので scene-19 の Phase は適用されない。

## auto を既定に推奨する根拠

`auto` は意味として「storyTime が設定されているなら時系列を尊重、未設定なら reading 順にフォールバック」。

- storyTime を一切設定しないユーザー → 全 scene が「未設定」扱い → 実質 reading 動作
- 一部だけ設定 → 設定済み scene は時系列、未設定は manuscript 末尾で fallback
- 全部設定 → 完全に時系列

ユーザーの操作量に対して常に妥当な結果になる。新規プロジェクトの既定値として安全。

ただし `phaseStore.ts:66` の現在の初期値は `"reading"`。これは過去の互換性のためで、将来 `"auto"` に変える際は既存プロジェクトの `phase_resolution_mode` カラム値マイグレーション（NULL を `"auto"` に置換するか、`"reading"` を維持するか）が必要なので別 PR で扱う。

## reading モードの品質トレードオフ

`reading` モードでスポイラー防止する設計には、AI 出力品質が落ちる方向のトレードオフがある。

AI が「アリス = 真犯人」を **知らない** 状態で scene-7 を書くと:

- 「無実そうな振る舞い」を平均的なキャラクターとして書いてしまい、後で読み返した時に伏線として機能する描写が入らない
- 読者の二度読み体験（「あ、ここの仕草、もう犯人だと暗示してたんだ」）が成立しない
- 整合性ミスのリスク（無実前提で書いた習慣が、後の真相と矛盾する）

逆に AI が真相を **知った上で** scene-7 を書けば:

- 真犯人ならではの微細な違和感（視線、言い淀み、選択的な情報開示）を仕込める
- 後の reveal scene との辻褄合わせが自然になる
- 叙述トリック作品としての完成度が上がる可能性

つまり「AI への spoiler 防止」は **読者体験のためではなく作者体験のため** の設計判断。作者が「次の場面で AI にトリックを匂わせてほしくない（自分のペースで明かしたい）」場合に有効。

理想形は **メタ指示で切り替えられる** こと: AI に「真相は X だが、現時点では伏線として匂わせる程度に留めて書け」と渡せれば両立する。ただしこれを汎用的に運用するには:

- Phase に「AI に開示するが出力には現さない」フラグ
- chat 側で「伏線として使ってよい Phase」「絶対秘匿の Phase」の区別
- プロンプト側の指示テンプレート

の追加実装が必要で、UI・データモデル・プロンプトエンジニアリングすべてのコストが大きい。

現設計（reading モードで一律隠す）は **その上位機能を入れるまでの妥当な落とし所**。将来 Phase に `aiVisibility` のような属性を足せば、reading モードの粒度を細かくできる余地はある。

同じ「AI への spoiler 制御は作者体験のため」という思想を、より単純な形で **Foreshadow 側に先行導入した**。`foreshadows.secret` フラグ（boolean、新規作成時 default=true）が ON の伏線は `listOpenForeshadowsForContext` の L2 ブロックから除外される。Phase のような scene 順序依存の解決は不要なため、1 カラム追加で完結している。

## 検討した代替案

### A) 1 モードに統合

却下。`reading` と `story` はそれぞれ別個の創作ニーズ（叙述トリック vs フラッシュバック）に対応しており、片方を消すと他方のジャンルがソフトとして対応不能になる。

### B) TimelineTab に view 専用 toggle を入れる

却下。Phase の並びは AI に渡る順序そのものなので、表示と semantics を別軸にすると「TimelineTab では story 順に並んで見えるが AI 文脈は reading 順」というズレが起きる。デバッグ時に混乱しかしない。

代わりに TimelineTab には現在の resolutionMode を示すバッジ + Settings へのショートカット Popover を置いた（commit `620ba71`）。

### C) Phase アンカーを 2 つ持つ（reveal anchor + truth anchor）

将来検討。truth_anchor を「物語時系列上の真実成立点」、reveal_anchor を「読者に明かされる点」として、AI 文脈構築時にどちらを使うかをモードで切り替える設計。reading/story の 2 モードに対する 1 つの Phase で両ジャンルに対応できる可能性がある。

ただし UI 複雑度（Phase 編集ダイアログにアンカーが 2 つ）、データモデル変更、既存 Phase マイグレーションが必要で現時点ではコスト過大。reading vs story のモード切替で代替可能なので保留。

## 関連箇所

- `src/features/codex/phaseResolver.ts` — 順序計算 (`computeGlobalSceneOrder`, `computeSceneTimeIndex`) と Phase 適用 (`resolveCodexState`)
- `src/features/codex/phaseStore.ts:66` — `resolutionMode` 状態と現在の既定値
- `src/features/chat/chatStore.ts:188` — AI 文脈構築での `resolveCodexState` 呼び出し
- `src/features/settings/categories/ProjectCategory.tsx:202` — Settings UI
- `src/features/codex/components/TimelineTab.tsx` — モード表示バッジ + Popover
- `src/db/schema.ts` の `projects.phaseResolutionMode` カラム — DB 永続化

## 関連メモリ

- `project_codex_phase_scene_context.md` — Scene context が Scene タブ専属である件
- `project_codex_layer_semantics.md` — Codex の 4 層構造
