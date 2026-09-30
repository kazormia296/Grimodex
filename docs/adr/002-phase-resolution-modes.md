# ADR-002: Codex Phase 解決モードを 3 種類維持する

## ステータス

採用済み (2026-05-13)、mixed story-time semantics 改訂 (2026-07-12)

## コンテキスト

Codex（キャラクター/世界観/設定エントリ）は物語の進行に伴って状態が変わる。例: 「主人公アリス」の Codex を scene-3 で「変身後」、scene-12 で「覚醒後」に切り替えたい。Grimodex はこれを **Phase システム** で表現する (`codex_entry_phases` テーブル + `codex_phase_detail_overrides`)。

- Phase は **アンカーシーン** を持つ
- DetailsTab / AI 文脈ビルダーが「ある scene を編集中」に Codex の現在状態を計算する時、アンカーが「その scene 以前」にある Phase を順に積み上げて summary / content / detail-values を上書きする (`phaseResolver.ts:resolveCodexState`)

「以前」かどうかの判定には reading / story の両軸を持つ `SceneTimeIndex` が必要で、`PhaseResolutionMode` (`reading` / `story` / `auto`) が使用軸と fallback policy を決める。

このモードがなぜ複数あるのか、なぜ統合・削除できないのかを記録しておく（経験上、設計意図が時間とともに自分でも分からなくなるため）。

## モード定義

| モード    | 順序計算                                                                                                                                                        | 想定読者                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `reading` | live Scene のツリー DFS 順（執筆順 / 読者開示順）                                                                                                               | 叙述トリック・ミステリー作品                        |
| `auto`    | live Scene **全件**に明示的な非空 `story_time_order` が揃うまでは project 全体を reading。揃った時点で story                                                    | 既定推奨。story-time 編集途中の未来情報漏洩を防ぐ   |
| `story`   | 明示 story key と reading 順の forward-fill 継承を使う。current または当該 entry の有効 Phase anchor が story 軸で引けなければ entry 全体を reading へ fallback | 部分設定中でも story-time を明示的に使う power user |

`auto` と `story` は意図的に異なる。`auto` は project-wide coverage gate を持つ安全既定、`story` は entry 単位の all-or-nothing fallback を持つ明示モードである。`null`、空文字、whitespace-only の `story_time_order` はすべて未設定として扱う。

## 決定

3 モードをそのまま維持する。特に `reading` モードは削除しない。

順序計算と Phase 適用を分離する。

- `SceneTimeIndex` は mode 非依存で `readingOrder`、`explicitStoryOrder`、`inheritedStoryOrder`、coverage 件数を保持する
- `resolveApplicablePhases` が mode、TemporalAnchor、entry の Phase 群を受け、適用対象・使用軸・fallback 理由を一意に返す
- `resolveCodexState` は適用対象 Phase の override を Base へ順番に重ねる

単一の `Map<sceneId, number>` は entry 単位 fallback を表現できないため、Phase semantics の正本にはしない。移行期間中のみ legacy UI 用の total-order projection を残す。

## mixed story-time と安全 fallback

旧実装は scheduled Scene をすべて先に並べ、unscheduled Scene を reading 順で末尾へ置いていた。例えば Ch.8 だけを scheduled にすると `order(Ch.8) < order(Ch.1)` になり、Ch.8 anchor の未来 Phase が Ch.1 に適用され得た。

改訂後は次の規則を採る。

1. `auto` の coverage 対象は削除・archive されていない Scene 全件。0 Scene は reading 扱い
2. `auto` は coverage が 100% になるまで reading。継承値は coverage を満たしたとは数えない
3. `story` は reading 順に直前の明示 story key を forward-fill する。作品冒頭の未設定連続領域は継承不可
4. null/deleted anchor は先に無効 Phase として除外し、fallback 判定を誘発させない
5. `story` で current または残った有効 anchor のどれかが story 軸で引けなければ、その entry の全 Phase を reading で解決する

同一 story key の決定的順序は `anchor reading-order → phase.created_at → phase.id`。適用 cutoff にも anchor reading-order を使い、同じ story bucket の reading 上後方にある Phase が前方 Scene へ漏れないようにする。Scene 時点の解決では、同じ current Scene にアンカーされた Phase をすべて inclusive に適用する。一方、特定 Phase のプレビューでは決定的順序上の対象 Phase で厳密に cutoff し、同じ Scene にアンカーされた後続 sibling Phase を含めない。

`currentSceneId = null` の多義性は廃止方向とし、TemporalAnchor を明示する。

- `base`: Phase を 1 件も適用しない
- `latest`: null/deleted anchor を除く全 valid Phase を決定的順序で適用する
- `scene(sceneId)`: その Scene 時点までを適用する
- `phase(phaseId)`: 対象 Phase を含む直後の状態までを適用する。同一アンカー Scene の後続 Phase は除外する。対象 Phase またはその Scene anchor が存在しない場合は適用なしとして理由を返す

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

`resolveApplicablePhases({ phases, index, mode, anchor: scene("scene-7") })` で計算:

1. mode に従って entry の使用軸を決定
2. current Scene と valid Phase anchors を同じ軸の値へ写像
3. story key 同値時は reading-order も含めて cutoff を比較
4. applicable Phase を決定的に sort して `resolveCodexState` が適用

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

`auto` は「作中時系列が project 全体について宣言済みになった時だけ story 軸へ切り替える」。

- storyTime を一切設定しないユーザー → reading 動作
- 一部だけ設定 → project 全体で reading を維持し、編集中の部分設定を semantic order に混ぜない
- 全部設定 → story 動作

これにより story-time 編集途中に Phase が過去へ遡及する事故を避けつつ、設定完了後は自動的に story-time を利用できる。明示的に部分設定を使いたい場合だけ `story` を選ぶ。

ただし「既定値」には **2 つのレイヤ** があり、値が食い違っている点に注意（2026-06-20 追記）:

1. **in-memory ストアの初期値**: `phaseStore.ts` は `resolutionMode` を `"reading"` で初期化する。これはプロジェクトが 1 件もロードされる前のブートストラップ用フォールバック。
2. **DB スキーマの既定値**: `schema.ts` と Rust migration は `projects.phaseResolutionMode` を `"auto"` で定義する。したがって新規作成プロジェクトは DB 上で `"auto"` を受け取る。

プロジェクトがロードされると (`projectStore.ts:106-108`)、DB の値が取得され `setResolutionMode()` 経由で in-memory ストアへ同期される。つまり:

- どのプロジェクトもロードされる前 → in-memory 状態は `"reading"`
- 新規プロジェクト → DB 上は `"auto"`
- auto 導入前から存在する既存プロジェクト → 保存済みのモードを保持、または DB の既定値にフォールバック

カラムは NOT NULL であり、mixed semantics 改訂に DB migration は不要。保存済み mode は維持し、`auto` の意味だけを安全側へ更新する。`reading` の挙動は不変である。

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

- `src/features/codex/context/sceneTimeIndex.ts` — mode 非依存 Index と legacy total-order projection
- `src/features/codex/context/resolveApplicablePhases.ts` — mode / TemporalAnchor / fallback / deterministic sort の正本
- `src/features/codex/context/resolvedCodexContext.ts` — batch Phase 解決と effective visibility policy の正本
- `src/features/codex/phaseResolver.ts` — Base への Phase override 適用と legacy API 互換
- `src/features/codex/phaseStore.ts` — Index キャッシュと `resolutionMode` の in-memory 初期値 (`"reading"`)
- `src/features/chat/context/sources/sceneContextSource.ts` — Scene AI 文脈の temporal / visibility 適用
- `src/features/chat/context/sources/nonSceneContextSource.ts` — folder / project / Codex 等の AI 文脈 source adapter
- `src/features/settings/categories/ProjectCategory.tsx:202` — Settings UI
- `src/features/codex/components/TimelineTab.tsx` — モード表示バッジ + Popover
- `src/db/schema.ts` の `projects.phaseResolutionMode` カラム — DB 永続化

## Amendment — Semantic Retrieval disclosure inheritance

Narrative IR Retrieval inherits `PhaseResolutionMode` and the disclosure
policy defined by this ADR. Semantic relevance does not grant disclosure
authority. Candidate admission must apply the same reading/story/auto temporal
resolution before ranking and must additionally enforce spoiler, secret,
viewpoint, knowledge-holder, audience, Worldline, Timeline, and Narrative
Layer scope.

In particular, Reader Knowledge must not be silently reused as Character
Knowledge, and a future Phase or unreached story-time assertion must not enter
the candidate set merely because its embedding score is high. The machine-
readable C1.5 contract is
`policies/narrative/retrieval-disclosure.json`; C1.5 defines and tests the
policy without wiring it into the Retrieval runtime.

## 関連メモリ

- `project_codex_phase_scene_context.md` — Scene context が Scene タブ専属である件
- `project_codex_layer_semantics.md` — Codex の 4 層構造
