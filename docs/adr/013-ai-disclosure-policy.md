# ADR 013: AI への開示方針（全部開示・作者の印は守る・位置の正しさは守る）

## Status

Accepted（J1・J2 は 2026-11-20 にユーザーが確認。J3〜J7 は推奨を既定とし、送信範囲が広がる J3(1) と J4(b) は別に確認する）

製品・アーキテクチャ方針の記録であり、実装・公開・runtime 有効化の承認ではない。

- J1（既定は全部開示、作者の印は守る＝(c)）はユーザーが選んだ（2026-11-19、contracts `5e02e4f2`）。J1 の範囲（IR・Graph 由来の応答は対象外）と J2（印の強さ。確認の記録の要旨は、hidden と年表 secret は「どの経路でも渡さない」、伏線 secret と suppress は「自動では渡さない」の 2 段と、今の挙動の追認）は、2026-11-20 に確認された（確認の記録 contracts `11dc9eda` の確認 3。IME の読みの一括推定から hidden を外すことは確認 4）。確認の記録は `claude/nir1-contracts` の commit で、この枝は master に merge しないので hash で引く。
- J3〜J7 と移行順は推奨を既定として記録する。ユーザーの確認が要るのは、送信範囲が広がる J3(1)（伏線の新規の既定を false にする）と J4(b)（まだ明かされていない情報の自動注入）で、実装の前に別に確認する。それ以外は integrator の判断として記録した（「確認の記録と、残る確認」）。
- 画面の判定（Graph の本文の宣言と veto）の撤去は、本 ADR では決めない。`nir1-c-body-disclosure-proposal/5`（K2/5。2026-11-20 に確認済み）による。
- 本 ADR は NIR-1 の残レーンの外にある。AGENTS.md の委任（worker／owner／lifecycle の技術判断）は効かない。
- 本 PR は文書だけを対象とする。prompt、既定値、DB migration、IPC、registry、runtime は変更しない。
- AI 指示・prompt の変更は動作契約なので、実装段階で `grimodex-author` と品質ゲートの対象になる（AGENTS.md「作業範囲と完了」）。
- 起案の基点は worktree `pubg5-dr20`（HEAD `04202c37`）。read-only で、build・test・cargo・vitest・Electron の起動はしていない。「ファイル:行」はこの基点のもの。(Fable)／(棚卸し) は、Fable の相談・棚卸し（contracts の外の `/home/grimodex/fusion-eval-data/design-notes/`）を引いただけの行で、【推測】【未確認】は確かめていないこと。
- 保存先は `docs/adr/013-ai-disclosure-policy.md`。番号は `docs/adr/` の最大が 012 で、local と remote の全 branch と tag（約 1,200 件。この PR の枝を除く）の `docs/adr/` に `013*` が無いことを、保存の前に `git ls-tree` で確かめた。他のマシン・セッションの未保存分は見えない。

## Authority / related decisions

- [ADR 002](002-phase-resolution-modes.md)：Codex Phase の解決モード（reading／story／auto）。本 ADR は「AI に隠すための仕組み」という位置づけだけを改める。モードと解決の挙動は変えない。
- [ADR 005](005-narrative-semantic-core-boundary.md)：IR retrieval の admission 契約（`:1195-1210`）。**PUB-G の前は変えない。PUB-G の後に見直す。** 理由は、見直すと G-07 の Gold と除外の期待値が動き、凍結のやり直しになるため。
- [ADR 009](009-narrative-scope-relation-contract.md)・[010](010-narrative-dependency-role-granularity-contract.md)・[011](011-narrative-ir-revision-semantics-contract.md)：Scope・依存・Revision。置き換えない。
- [ADR 012](012-work-focus-chat-and-context-boundary.md)：Work Focus と Chat のコンテキスト取得境界。本 ADR の「読み取り口」との整合は読んでいない【未確認】。「実装前の確認事項」に置く。
- 設計書：`docs/CONTEXT_INJECTION.md`、`docs/Grimodex_Chronicleパネル設計書.md`、`docs/Grimodex_伏線レジスタ設計書.md`、`docs/Grimodex_関連する過去シーンパネル設計書.md`、`docs/Grimodex_IME連携設計書.md`。
- 計画：`docs/plans/nir1-c-body-disclosure-proposal-5-draft.md`（K2/5。K2/4 `nir1-c-body-disclosure-proposal-4-draft.md` を置き換える。確認済み）、`docs/plans/nir1-d2a-graph-unrestricted-proposal-1-draft.md`（K3/2 の Graph の行の改訂。確認済み）、`docs/plans/nir1-related-scenes-precheck.md`、`docs/plans/narrative-ir-nir1-implementation-plan.md`（A8 など）。
- 記録：決定記録 `user-confirmation-2026-11-19-ai-disclosure-and-pubg-scope.md`（contracts `5e02e4f2`。以下「決定記録」）と、確認の記録 `user-confirmation-2026-11-20-pubg-pivot-confirmations.md`（contracts `11dc9eda`。以下「確認の記録」）。どちらも `docs/plans/nir1-pubg-records/` の file で、`claude/nir1-contracts` の commit にある。

### 別起案（本 ADR は決めない。2026-11-20 未明の追記を反映）

| 別起案 | 今の状態（決定記録の追記） |
|---|---|
| (a) 本文の宣言（K2/4 `graph-target-scene-body-disclosure`）の廃止 | **K2/5（`nir1-c-body-disclosure-proposal/5`）として確認済み（2026-11-20、確認の記録の確認 1）。** 廃止の方向で起案した。#968（OS ダイアログの廃止）は 2026-11-20 に merge せず閉じ、その分析は廃止の draftRef へ引き継ぐ。凍結の前は reader の判定（宣言の読込、束縛の照合、veto、quarantine）だけを外す。列（`body_declaration_json` など）は残して使わず、migration はしない。コードの撤去は PUB-G の後。 |
| (b) Graph の restricted 条件の解除 | **`nir1-d2a-graph-unrestricted-proposal/1` として確認済み（2026-11-20、確認の記録の確認 2。公開条件から D2a の前提も外す）。** 案 A（Native の restricted の要求を外し、Graph を R・IR と同じ扱いにする。Graph の応答は画面にだけ使い、AI 送信・Packing・履歴・書き出しには載せない）で進める。K3/2（`caller-profile-egress`）の Graph の行を改訂する新しい draftRef を起案する。起案の前に、`PublicationGuard.finish` が Graph の返却を覆うかと、unrestricted での cache key の意味を確かめた（読みで確認。残る点は draftRef の「実装前の確認事項」）。決定記録:40-45。 |
| (c) 関連シーンの未来の場面 | R の別枠で、PUB-G の後。過去の結果は変えない。 |
| (d) IR／Graph の作者視点 profile | PUB-G の後。 |
| (e) Scene Scope の一致（以下「Scope A1」） | 宣言と veto は外すが、Graph の追加の場面の Scope A1 の一致（`nir1_graph/scenes.rs:787-847` の 4 成分）は残す。公開の後に、外すか、以前からの場面だけを通すかを見直す。Scope A1 は秘密の仕組みではなく、関連の質のための選別である（決定記録:52-61、Fable の A1 相談 §0）。 |

### 呼び名（衝突を避ける）

- 「Scope A1」：Scene Scope の一致（上の (e)）。
- 「実装計画 A8」：`narrative-ir-nir1-implementation-plan.md:127` の A8 行。
- 「年表 secret 固定規則」：抽出の取り込みが年表を常に secret で作る確認済みの規則（`commit.rs:2287`、`:3137`、`compiler.ts:124-127`、2026-11-11 確認済み）。「A1」とだけ呼ぶと上の 2 つと衝突するので、この名前にした。

## Context

### 1. 「secret」に混ざっている 4 つのもの (Fable §1)

| # | 中身 | 例 | 性質 |
|---|---|---|---|
| 1 | 位置と状態の正しさ | Codex の Phase 解決（ADR 002:9-14）、あらすじの「これまで」、年表の ordinal の窓（Chronicle 設計書 `:288-293` の「2 軸の分離」） | 正確さ。隠す話ではない |
| 2 | 作者が項目に付けた印 | 伏線の secret（`src/locales/en.json:3547-3548`）、年表の secret と reveal（同 `:6151-6152`）、Codex の hidden／suppress（`docs/CONTEXT_INJECTION.md:114-115`） | 作者の選択。項目単位の opt-out |
| 3 | 画面側の関門 | IR の admission（`retrieval_admission/disclosure.rs:283-294`）、Graph の本文宣言と veto（K2/4 draft `:216-226`） | 作者の画面に出す前の判定 |
| 4 | 知らないふりの用途 | 読者ペルソナのコメントは本文だけを送る（`src/features/post-effect/pseudoCommentPayloadBuilder.ts:3-6`） | 用途が知識の不在を要求する |

「secret の印は IR の関門・年表から AI への秘密・Graph の veto の 3 役を兼ねる」という絡まりは、#2 と #3 が同じ印に乗っていることの症状である。

### 2. 実態：知識の層はすでに大きく開いている (棚卸し §1-A・§4、Fable §2.3)

- 開いている（判定なしで AI に渡る）：project／章のアウトライン全文、「これまでのあらすじ」（不具合で後の章も入っていた。#976 で修正済み）、semantic recall（読む順の関門なし）、agent tool の場面・Codex・伏線詳細、MCP の場面読込・Codex 一覧・伏線詳細、beat／inline の Codex 要約、伏線パネルの AI 監査、今の場面の secret な伏線。
- 閉じている：Codex の未来の Phase と contextMode（chat、MCP の writing context、post-effect）、年表の secret（全経路）、伏線の「未回収一覧」の secret、年表の ordinal の窓。
- 伏線 UI は「AI 文脈から除外」と広く書くが、実装は未回収一覧だけ（`en.json:3547-3548` 対 `docs/Grimodex_伏線レジスタ設計書.md:501-508`、ADR 002:160）。**今のマスクは「守っている」という表示のほうが実態より広い。**
- Codex の hidden は、`CONTEXT_INJECTION.md:66`・`:114` が「全経路で除外」と書くのに、agent tool・MCP の検索・beat／inline などで漏れていた。PR #981（merge 済み、2026-11-19）が主な経路を塞いだ（後述）。

### 3. マスクの本来の理由

ADR 002 自身が、AI への spoiler 防止を「読者体験のためではなく作者体験のため」（`:148`）、reading による一律の隠しを「その上位機能を入れるまでの妥当な落とし所」（`:158`）と書き、理想形を「真相を渡したうえでメタ指示で抑える」と述べる（`:150-156`）。伏線設計書の「既定が秘匿」の理由は「うっかり書いた伏線が AI に漏れるより事故が少ない」（`:530`）で、今のユーザーの考えと逆向きである。

### 4. ユーザーの決定 (contracts `5e02e4f2`、2026-11-19 深夜、と 2026-11-20 未明の追記)

- 画面はすべて開示してよい（逐語「画面はもちろん全て開示して問題ない認識です」）。
- AI へは「全部開示、作者の印は守る」（J1 の (c)）。位置の正しさは守る。ネタバラシは指示と応答の点検で抑える。
- J2〜J6 の細部は Fable の推奨を既定として起案し、確認の時に改めて示す。
- 本文の宣言は veto も含めて廃止（K2/5 で確認済み）。Graph は restricted なしでも使えるようにしたい（案 A）。関連シーンの未来の場面は R の別枠で PUB-G の後。
- 追記（2026-11-20 未明）：Graph の restricted は案 A で進める。#968 は閉じた。宣言のコードの撤去は PUB-G の後。Scope A1 の一致は残し、公開の後に見直す。

## Decision（J1・J2 は確認済み。それ以外は推奨を既定とする）

**D1 既定は全部開示（ラベル付き）。** 印の無い作品知識は AI に渡す。位置のラベル（「今の場面より前に明かされた／この後に明かされる／作者の計画で本文に無い」）を付ける。ただし範囲は下の「D1 の対象外」に限る。

**D2 作者が項目に付けた印は構造で守る。** 強さは 2 段に言語化する（J2）。
- 「AI に渡さない」：Codex の hidden、年表の secret（reveal の前）。
- 「自動では渡さない」：伏線の secret、Codex の suppress。自動の注入と一覧には入れないが、AI や作者が明示的に取りに行けば見える。
- 例外と、現時点で残る漏れは「D2 の例外と残る漏れ」に書く。

**D3 位置の正しさは守る。** Phase の解決、「これまで」の前後、年表の作中時点は、マスクではなく正確さとして揃える。位置の正本は 1 つに寄せる（「位置の正本」の節）。

**D4 勝手なネタバラシは振る舞いの層で抑える。** prompt の指示と、応答の点検（post-effect に 1 種足す非 blocking の警告）。stream は止めない。

**D5 知らないふりの用途は、全知の文脈に後からマスクを掛けず、材料を allowlist で組む専用の surface にする**（読者ペルソナの先例）。実装は後。

**D6 画面は作者に全部見せる。判定の撤去は本 ADR で決めず、K2/5 による。範囲は次に限る。**
- 撤去するもの：画面の追加枠の判定のうち、Graph の本文の宣言と veto。これは `nir1-c-body-disclosure-proposal/5`（K2/5、確認済み）が決める。本 ADR は重ねて決めない。関連シーンの R は、もともと秘密を判定しない。
- 残るもの 1：IR の admission（秘密＝false 必須、出典が query より前、`retrieval_admission/disclosure.rs:197`、`:283-294`）と、Graph の path の secret／POV／hidden 規則。**PUB-G の後に見直す。** 見直すと G-07 の Gold と除外の期待値が動くため、PUB-G の前はやらない。
- 残るもの 2：Graph の追加の場面の Scope A1 の一致（別起案 (e)）。これは**関連の質の選別**（時間軸・世界線・語りの層・知っている人・読み手）であり、秘密を守る仕組みではない。公開の後に見直す。
- したがって D6 は「画面の判定をすべて無くす」ではない。逐語の「全て開示して問題ない」は、判定を撤去する範囲（宣言と veto）の根拠であり、IR と Graph の path の規則を今撤去する根拠ではない。

**D7 変更は「追認＋ラベル＋既定値の見直し」から始める。文言と既定値を先、判定の撤去は後。** 送信量を増やす変更（未適用の Phase や reveal 前の出来事の自動注入）は測定の後。

### D1 の対象外：IR・Graph 由来の応答（新しい分類）

- IR・Graph 由来の応答（IR の抽出物、Graph の path Evidence・excerpt など）は、**J1 の「全部開示」の対象外**である。
- 理由は実装計画 A8 の「新しい送信先やデータ分類への送信は未承認。通常製品の既存送信同意も新しい IR／Graph 情報の外部送信許可へ自動拡張しない」（`narrative-ir-nir1-implementation-plan.md:127`）。J1 の回答が IR／Graph 由来を含むかは、決定記録に書かれていない。
- この区別を明記する。
  - **Graph の応答を画面だけで使い、AI の request・Packing・履歴・書き出しに載せない**のは、経路の契約である（別起案 (b) の案 A、決定記録:40-45）。データの秘匿ではない。
  - **場面の本文などの元データ**は、各経路の読み取り口から AI に渡す。J1 の「全部開示」はこちらに掛かる。
  - 「AI は場面本文を読めるのに、Graph の excerpt は載せない」という見え方は、この区別から来る。矛盾ではない。
- 新しい consumer（chat の IR tool、Packing、local 生成）に IR／Graph 由来の情報を載せる設計は、PUB-G の後（D7、J11）で別に決める。本 ADR では単純になると言わない。

### D2 の例外と残る漏れ

**例外（作者視点で、保護を迂回してよいと決まっているもの）**

| 例外 | 内容 | 根拠 |
|---|---|---|
| 抽出の経路 | `narrative_*`、`generic_import_*`、`chronicle_extract`、`plot_thread_propose` など約 24 経路。作者視点で保護を迂回してよい決定 | memory `nir-extraction-context-decisions`。repo では `nir1-proposal-findings-design-draft.md:93` が「repo の中では未確認」と自己申告（棚卸し）。Fable の相談 #10 が repo への記録を求めている。 |
| IME の辞書 | hidden／suppress も既定で含める。**ローカルで AI 送信ではない**。設定で除外可能 | `docs/Grimodex_IME連携設計書.md:140` |

**現時点で残る漏れ（「どの経路でも」と言い切れない範囲）。** PR #981 の本文が自ら挙げた、#981 では直さないもの。
- 年表の参加者名（`chronicle_codex_names`）
- project の統計の件数
- `list_codex_tags` の usageCount
- hidden の id への `update_codex_entry` の応答
- beat の povName
- MCP は Phase の override による hidden を見ない（`context.rs` と同じ base の判定）

**IME の読みの一括推定（AI 送信。例外にしない）。** hidden の項目の名前と別名が provider に届いていた（`ReadingsBackfillSection.tsx`。PR #981 本文「残漏れ」）。確認 4 と 2026-11-21 の回答で「直す（hidden は送らない）」と決まった。一括推定の対象から hidden を外す。項目ごとの「AIで推定」も、hidden の項目では使えない（ボタンを無効にする。2026-11-21 の回答、contracts 19605110）。hidden の項目の読みは作者が手で入れる（確認文 3）。送信の直前にも `inferReadings` が hidden を再判定して落とす（base の mode。判定に失敗したら送らない）。IME の辞書は、ローカルで AI 送信ではないので、例外の表のままである。

D2 の「AI に渡さない」は、これらを直すまでは**主な内容の経路**についての約束で、派生情報（件数、名前、tag 数）を含む完全な約束ではない。確認文 4 のとおり、hidden を送らない向き（確認 4 と同じ）で次の PR で直すことを既定とする（integrator の判断）。許容として明記する場合は、その旨を改めて決める。

**当場面の secret な伏線の扱い（定義との整合）。** 「自動では渡さない」を厳密に読むと、今の場面に紐づく secret な伏線（setup／payoff）が自動の文脈に入る現状（棚卸し 1-A。`api.ts:733-`、`sceneContextSource.ts:1357-1376`）と合わない。既定は、「今書いている場面に紐づく伏線は、その場面の文脈として扱う」と定義に書き足して現状を追認する案とする。厳密に除く案との選択は確認文 2 に含めたが、確認の記録の要旨に明記は無く、「今の挙動の追認」に含むと integrator が読んだ（除く案は選ばれていない）。除く案は、本文の生成で必要な文脈を削るので推奨しない【推測】。

## 既存の記述との関係（どれを置き換えるか）

| 既存の記述 | 置き換える | 追補する | 変えない |
|---|---|---|---|
| ADR 002:148 「spoiler 防止は作者体験のため」 | | ○ 理由は残し、「AI に隠すのが既定」から「開示が既定、作者の印だけ構造で守る」へ位置づけを移す | |
| ADR 002:103 「ミステリー・叙述トリック系では reading 必須」 | ○ 「AI に隠すために必須」の言い方を外す。Phase を解決する軸としては reading のまま（挙動は不変）。ADR 本文の改訂は Amendment で行い、元の文は残す | | モード 3 種の維持、auto の既定 |
| ADR 002:158 「reading で一律隠す＝上位機能までの落とし所」 | | ○ 上位機能は「ラベル＋指示＋応答の点検」で実現し、`aiVisibility` 属性は作らない。Phase 単位で渡さない選択は contextMode の override（`codex_entry_phases.context_mode_override`、棚卸し：migrate.rs:913）が既に担う | |
| ADR 002:160 「伏線 secret を先行導入」 | | ○ secret の意味を「自動では渡さない」に確定。新規の既定は J3 | |
| ADR 002 `:193` Amendment（IR は ADR 002 の mode と policy を継承） | | | ○ PUB-G の前は変えない。PUB-G の後に見直す |
| ADR 005:1195-1210（IR retrieval の継承、Retrieval disclosure contract） | | ○ 注記：R（画面）は「読む順の絞り」で、開示の契約の主語は IR retrieval。precheck 自身が「reading-order filtering alone does not implement that contract」と書く（`nir1-related-scenes-precheck.md:21-23`）。IR admission と Graph の path 規則は PUB-G の後に見直す | ○ 契約本文と `policies/narrative/retrieval-disclosure.json` は PUB-G の前は変えない |
| 伏線設計書:530 「既定が秘匿であるべき理由」 | ○ J3 の確認後 | | |
| 伏線設計書:501 「未明かしの真相を AI に執筆させる場面など」 | | ○ 用途は「0 が要る項目に作者が印を付ける」へ限定 | |
| `en.json:3547-3548` 伏線の secret 文言（と ja） | ○ 「自動の注入と未回収一覧から除外。AI が明示的に取りに行けば見える」へ | | |
| Chronicle 設計書:281（opt-in、既定は表示）、:302-311（全経路で強制、MCP は fail-closed、UI は対象外） | | | ○ 年表の secret は作者の印として残す。「AI に渡さない」と呼ぶ |
| `CONTEXT_INJECTION.md:66`、`:114`（hidden は全経路で除外） | | ○ 節「全部開示（ラベル付き）」と実態の表を足す。「全経路」は「例外と残る漏れ」の表で限定する | ○ 文書どおりに実装を直す（PR #981） |
| `CONTEXT_INJECTION.md` の注入順・cache 配置 | | | ○ |
| K2/4 本文の宣言（draft `:14`、`:216-226`） | | | 別起案 (a) で扱う（ここでは決めない） |
| 年表 secret 固定規則（`commit.rs:2287`、`:3137`、`compiler.ts:124-127`、2026-11-11 確認済み） | | | ○ 見直しの要否は J3 (2) で伺う（確認済みの規則の改訂は別起案） |

## 位置の正本

AI 経路と画面が「場面の前後」をどこから取るかには、**4 つの実装**がある。1 つに寄せることを移行に入れる。

| 実装 | 位置 | 状態 |
|---|---|---|
| TS：`buildReadingOrder`（`src/features/codex/context/sceneTimeIndex.ts:52`）。`computeGlobalSceneOrder`（`src/features/codex/phaseResolver.ts:41-45`）は `buildReadingOrder` へ委譲するだけ | 木の DFS（兄弟は sortOrder、同値は id で決定的に）。archived は除く | **正本の候補。** chat の Phase 解決、年表、伏線などが使う。PR #976（merge 済み、2026-11-19）は、あらすじ・直前の場面・伏線の Setup の提案も `buildReadingOrder` の上の `listScenesBeforeInReadingOrder` に揃えた。起案の基点の worktree には `cmpKeys` による比較が残っていた（`contextBuilder.ts:2365`、`sceneContextSource.ts:1026`。#976 の前の状態） |
| Native：`reading_rank`（`derive_live_scene_projection` から作る。IR admission の `query_reading_rank`） | 同じ DFS | **揃っている。** TS と共有の fixture `src/features/codex/context/fixtures/reading-order-parity.json` で parity を取る（`reading_order_tests.rs:1-8`、`readingOrderParity.test.ts:3`）。Graph-only の順序もここから取る |
| MCP：DFS（`grimodex-mcp/src/tools/context.rs:253-276`、`collect_story_so_far`） | 同じ DFS | **順は揃うが parity の外。** shared fixture に入っていない（fixture を参照する試験は上の 2 つだけ、grep）。archived を除かないため、archived のある project で chat のあらすじと食い違う（#976 本文）。TS の正本と同じ定義とコメントにある（`:250-253`） |
| R：renderer の `sceneOrder`（`fetchRelatedScenes.ts:123`、`fetchNir1RelatedScenes.ts:194` が `computeSceneTimeIndex(nodes, mode)` を使う） | **mode で順が変わる**（story／auto では story 順）。`computeSceneTimeIndex` は `@deprecated`（`phaseResolver.ts`） | **意図してずれている。** 「読む順で前」を story 軸で決めうる（`selectRelatedScenes.ts:136-140`）。Graph-only は Native の `reading_rank`（reading 順）なので、R と Graph で軸が違いうる |

寄せる方針（案）。
1. 正本は `buildReadingOrder`（TS）と、それと fixture で parity を取る Native の `reading_rank`。`computeGlobalSceneOrder` は別名として残す。
2. MCP の DFS を shared fixture の parity に入れ、archived の扱いを揃える。
3. AI 経路での sortOrder の文字列比較を試験で禁じる（#976 の試験を一般化する）。
4. R の story／auto は、「位置の軸」として扱いを ADR 002 の mode に委ね、本 ADR では直さない。K2/5 も「この食い違いは今回直さない」としている。AI 経路が story 軸を使うか reading 軸を使うかは、registry の宣言（下の「実装前の確認事項」）で明示する。

## 横断で要るもの

「層」を作るのではなく、関数数個と検査にとどめる。案 A（読む位置×用途の profile を 1 つの層で全経路に強制）は作らない（Fable §3.1）。

1. **読む位置の正本**：上の節。
2. **AI 向けの読み取り口をデータの種類ごとに 1 つ**：Codex＝`resolveCodexContextExposure`（`src/features/codex/context/codexVisibilityPolicy.ts:38`、棚卸し）、年表＝`projectVisibleChronicle`（`src/features/chronicle/chronicleSnapshot.ts:400`、棚卸し）、伏線＝`listOpenForeshadowsForContext`（`src/features/foreshadow/api.ts:644`、棚卸し）、場面本文・あらすじ＝位置の正本の上、recall の位置ラベル。迂回している読取（agent tool、MCP、beat／inline）をここへ寄せ、AI 経路の module が生の API を import しないことを architecture の検査で落とす。
   - PR #981（merge 済み）は、agent tool の Codex 系、MCP、beat／inline、地図の AI Branch、伏線の提案と章の監査（`detectRelatedCodex`）を、hidden について正本の判定（TS は Phase 解決後の `canIncludeResolvedCodexContext(mode, "explicit-pin")`、MCP は base の `context_mode = 'hidden'`）に寄せる。ここでの「寄せる」は hidden だけで、suppress・mentioned・Phase による絞り込みは足さない（全部開示の方針のため）。
   - `detectRelatedCodex`（`foreshadow/api.ts:1357-1363`）の迂回も、#981 の対象に入っている。
   - 読み取り口へ寄せる残りの作業（architecture の検査、生 API の import 禁止）は、#981 の後に移行の段 2 で行う。
3. **経路の宣言**：`AiPathEntry`（`src/features/ai-verification/aiPathRegistry.ts:76`）に「どの知識 profile か、位置を何から取るか、どの読み取り口を通るか」を足す。足し忘れを落とす完全性の試験の型はすでにある（同 `:1-6`、`aiPathRegistry.test.ts:221-`）。欄名と Gate B2 の digest は「実装前の確認事項」に置く。
4. **ラベルの整形**：項目に「今の位置に対して既知か未開示か、どこで明かされるか」を付ける共通の整形。文面は `grimodex-author` の手順で決める。例：`〈この後・未開示〉第 15 場「回想」で判明：アリスは真犯人。いま書いている場面の読者はまだ知らない。`

### 「70 余りの経路」を文脈を組む場所で束ねる（実測）

`AI_PATHS` は 69 件（`aiPathRegistry.ts:519-1600`）、runtime route が 1 件（`:1601-`、`browser_byok_web`）で、計 70。次の表で 69 件すべてに割り当てた（6+2+7+10+24+9+2+9＝69）。

| # | 組み立て点（系統） | 件数 | 経路 id | 実装 | 確かさ |
|---|---|---|---|---|---|
| 1 | chat の文脈（`contextBuilder.ts`、`context/` の planner と source、`chatContextPreparationComposition.ts`） | 6 | chat_agent_main、chat_stream_non_agent、ab_chat、cli_chat_stream、codex_app_server、codex_app_cli_fallback | TS | chat_agent_main・chat_stream は確認。ab_chat・cli・codex_app が同じ文脈を継ぐかは【推測】 |
| 2 | agent tool の読取（`READ_ONLY_EXECUTORS` 24 件、`toolExecutors.ts:2068`。作品を読むのは約 21） | 2（＋#1 の chat_agent_main） | agent_research_subagent、context_creator | TS | context_creator の tool は 4 件（`contextCreatorApi.ts:50-57`）。sub-agent は `toolExecutors.ts:2460`、`:2566-2578` |
| 3 | beat／inline の文脈 | 7 | inline_ai_stream、ab_inline、beat_generation、beat_alternative、beats_from_synopsis、synopsis_from_beats、beat_role | TS | `buildBeatContext` は `generateBeatOnce.ts`、`useBeatGeneration.ts`、`generateBeatAlternative.ts` の 3 つだけ。inline は `inlineAiContext.ts` |
| 4 | post-effect の payload | 10 | post_effect_* 10 件 | TS で組み Rust が送る | `src/features/post-effect/*PayloadBuilder.ts` が 7 つ＋ impact-review の `snapshot.ts` ＋ live reader |
| 5 | 抽出の文脈 | 24 | narrative_* 18、generic_import_* 4、chronicle_extract、plot_thread_propose | TS | 作者視点でよいと決定済み（D2 の例外） |
| 6 | 単発の補助（対象は作者が選ぶ） | 9 | synopsis、summarization、foreshadow_audit_chapter、foreshadow_propose_past_setups、foreshadow_evaluate_setup_strength、codex_judgment、codex_yomi、map_branch、tree_scaffold | TS | 伏線の AI 監査は全伏線（secret 含む）の title／intent を送る（`foreshadowStore.ts:1320-1324`、棚卸し）。codex_yomi は IME の読みの推定（確認 4 で hidden を一括推定の対象から外す。個別の「AIで推定」も不可） |
| 7 | local 生成の Packing | 2 | nir1_local_generation_writing、nir1_local_generation_review | Rust（閉） | D1 の対象外（IR／Graph 由来） |
| 8 | 作品データを組まない／選別だけ | 9 | session_title、ai_connection_test、agent_call_limit、relation_injection（評価用）、semantic_search、semantic_embedding_index、semantic_reranker、semantic_reranker_shadow、fts_search | — | embedding・recall は #1 に入る候補の選別で、位置ラベルの対象（読む順の関門が無い。`sceneContextSource.ts:1286`） |
| 外 | MCP | — | （registry の外） | Rust | `grimodex-mcp/src/tools/*.rs`、`db.rs`。位置は DFS |
| 外 | browser_byok_web | 1 | — | — | Web Editor は廃止済み（ユーザー決定 2026-10-14）。対象外 |

- 系統で数えると 8 か所（#1〜#7＋MCP）。builder／executor の単位では約 45（抽出・Packing・MCP を除く）【推測】。
- 設計への含意：宣言は**経路（registry の単位、70 件）**に置く。強制は**読み取り口（データの種類ごと、4〜5 個）**に置き、builder 単位の個別修正に頼らない。TS と Rust の二重実装（MCP、Packing）は残る。年表の世界状態は TS と Rust のずれを fixture で止めている（`docs/Grimodex_MCPサーバー設計書.md:782`、Fable）。同じやり方を位置（上の parity）と hidden に当てる。

## 「3・4・5 辺りは許容していた」の定義（棚卸し §4 (b) との突き合わせ）

ユーザーの逐語は「AI経路の1は不具合で良いと思います。3,4,5辺りは許容していた気がします。」（決定記録:11）。「経路の番号」は、決定記録:36 が「AI 経路の 1（『これまでのあらすじ』と『直前の場面』の前後）」と書き、棚卸し §4 (b) の「守っていない経路（重い順）」の 1) と一致する。したがって番号は棚卸し §4 (b) のものと読む。

| 棚卸し §4 (b) | 中身 | ユーザーの言及 | 本 ADR での扱い |
|---|---|---|---|
| 1 | chat の storySoFar／previousScene とその UI（sortOrder 比較） | 不具合 | PR #976（merge 済み）で修正。D3 |
| 2 | semantic recall（読む順の関門なし、既定 on） | **言及なし** | J4 (a)：今どおり。位置のラベルだけ足す |
| 3 | agent tool の伏線詳細・Codex・scene | 許容していた気がする | 下記 |
| 4 | MCP の `get_foreshadow_detail`・Codex 一覧と検索・`read_scene` | 許容していた気がする | 下記 |
| 5 | 当場面の secret 伏線と `projectOutline`／`chapterOutlines` | 許容していた気がする | 当場面の伏線は D2 の追記で定義に入れる。アウトラインは作者の全文で、J4 (a)：今どおり |
| 6 | beat／inline の Codex 要約 | **言及なし** | hidden の分は PR #981 で塞ぐ。それ以外は今どおり |
| 7 | 伏線パネルの AI 監査（全伏線の title／intent） | **言及なし** | 作者の明示操作で、D2 の「明示的に取りに行けば見える」に入る【推測】 |
| 8 | R（作者向けの画面） | 「画面は全部開示」 | D6 |

- 3・4 のうち、**伏線の詳細（secret 不問）**、**scene 系の読取**は、D2 と J4 (a) の意味では仕様になる。「自動では渡さない」は、明示的に取りに行けば見える、という定義だからである。
- 3・4 のうち、**Codex の hidden** は「AI に渡さない」に反するので、「許容していた」の範囲の外に置く。この範囲を狭めるのは PR #981 で、**3・4（と、言及の無い 6）のうち hidden の分だけ**である。suppress・mentioned・Phase は #981 でも足さない。
- ユーザーの発言は「許容していた気がします」と曖昧なので、番号の読み（3＝agent tool、4＝MCP、5＝当場面の secret 伏線とアウトライン）と、hidden だけを狭めることを、確認文 4 で 1 文として確かめる（未確認。#981 は merge 済みで、hidden の主な経路は塞がれた）。

### 実施済みの修正（この ADR の確認を待たなかった）

1. PR #976（merge 済み、2026-11-19）：「これまでのあらすじ」「直前の場面」「伏線の Setup の提案」を読む順の正本に揃えた。現在の場面が読む順に無いとき（archived・孤児）は空になる。archived とその配下は「前」に入らない（Phase 解決と同じ扱い）。MCP の `collect_story_so_far` は archived を除かないので、MCP とチャットのあらすじが食い違う点は #976 の範囲の外。
2. PR #981（merge 済み、2026-11-19）：Codex の hidden の漏れを塞いだ。J1 (c)（印は守る）に揃えるもの。範囲は上の「読み取り口」の項。残漏れは「D2 の例外と残る漏れ」。Electron の実機での確認はしていない（#981 本文）。

## 移行の順序

| 段 | 内容 | 挙動の変化 |
|---|---|---|
| 0 | PR #976（あらすじの前後）と PR #981（hidden の漏れ）。いずれも merge 済み（2026-11-19） | あり（修正） |
| 1 | 本 ADR の確認と決定 | なし |
| 2 | 読む位置の正本を 1 つにする（MCP の DFS を parity の fixture に入れ、archived を揃える。AI 経路の sortOrder 比較を試験で禁じる）。残る迂回を寄せ、registry に宣言の欄を足す | なし |
| 3 | #981 の残漏れを塞ぐか許容として明記する（確認文 4） | あり（文書どおりに） |
| 4 | 漏れの小さな測定（J5） | なし |
| 5 | UI 文言を実装に合わせる。伏線の新規の既定を変える（J3）。既存の印の見直し導線 | あり |
| 6 | ラベル付きの注入と指示（開いている経路にラベル。未来の Phase・reveal 前の出来事を入れるかは測定の後。J4） | あり（prompt。品質ゲート対象） |
| 7 | 応答の点検（post-effect に 1 種）、読者／キャラクターの専用 surface | 追加（任意） |
| 8 | IR／Graph の作者視点 profile、IR admission と Graph の path 規則の見直し、関連シーンの未来の枠（R の別枠）。PUB-G の後 | あり |

要点は 2 つ。**文言と既定値が先、判定の撤去は後**（既存の印が「AI に見せない」と表示したまま黙って送られる事故を避ける）。**送信量を増やす変更は測定の後**。最初の到達点は「挙動はほぼ変えず、意味・文言・ラベルをそろえる」。

## 評価・凍結・契約への影響（まとめ）

| 変更 | 評価・凍結 | 契約 |
|---|---|---|
| AI 側の方針（chat、tool、MCP、文言、既定値） | 影響なし（CP-4 は関連シーンだけを測る）。prompt を変えるなら AI behavior の品質ゲート | J3 (2) は確認済みの規則の改訂。ほかは設計書と ADR 002 |
| 本文の宣言の廃止（別起案 (a)） | G-01〜G-08 の追加の場面は入れ替わらない見込み。宣言の addendum、事前登録（S2）、CB-4 の試験は改版し、最後の凍結に入れる。K2/5 は確認済み。最後の凍結は、reader の PR と S4 の枝の改版の準備の後 | K2/4 の改訂（K2/5。確認済み、委任の外だった） |
| Graph の restricted 条件の解除（別起案 (b)） | 最後の凍結で、unrestricted の Graph の parity を測り足す（閾値は変えない） | K3/2 の Graph 行の改訂（`nir1-d2a-graph-unrestricted-proposal/1`。確認済み） |
| IR の admission・Graph の path の開示を緩める | G-07 の Gold と除外の期待値が動く。凍結のやり直し | ADR 005、policy、K2/4。PUB-G の前はやらない |
| 関連シーンの未来の枠（R、別 file） | 影響なし（評価の harness は製品の関連シーンのファイルを名指しで組み込む） | なし（設計書の改訂） |

## Consequences / Risks

- 得：棚卸しの「守っていない経路」の多くが、穴ではなく仕様になる（伏線詳細、scene 系の読取、アウトラインなど）。画面の追加枠の判定（宣言と veto）という 1 役が外れ、secret の 3 役のうち Graph の宣言と veto の分が整理される。MCP の外部 agent、整合・伏線の監査など、**作品データを各読み取り口から渡す** consumer の設計が単純になる。表示と実態が合う。
- 得にならないもの：IR admission と Graph の path 規則は PUB-G の後まで残る（「3 役が 1 役に戻る」のは、その後の見直しが済んだ時）。IR／Graph 由来の情報を載せる consumer（chat の IR tool、Packing、local 生成）の設計は、本 ADR では単純にならない（D1 の対象外、D7／J11）。
- 失：本文の生成で、明かしてほしくないことが文章に出る率は 0 にならない（→ D2 の印と D5 で補う）。外部 provider に渡る量が J3 (1) と J4 (b) で増えうる。ADR 002 の「ミステリーは reading 必須」の言い方を直す必要がある。NIR-1 の IR／Graph の評価は読者の知識で定義されている（G-07 `goldDefinition`）ので、AI 側の方針と別に扱う。
- 害の大きさは小さい側に寄る【推測】：生成文は候補として作者の目の前に出て、採否は作者が決める。`propose_scene_body` は staging で止まる（`docs/Grimodex_AIエージェント設計書.md:330`、Fable）。beat／inline が採否の UI を通るかは未確認。
- 位置で絞る hard gate も万能ではない（日付 filter でも 71〜81% で後の情報が漏れる。Temporal Leakage、`nir-prior-art-2026-11-05.md:120`、Fable、照合済み）。だから全経路のマスクの徹底（案 A）は高くつき、採らない。

## 実装前の確認事項

確認文の対象ではなく、実装を始める前に確かめる技術事項。

1. **registry の欄名**：`AiPathEntry` に足す欄の名前は `disclosure` を避ける。`ai-policy` では「disclosure＝AI 送信の同意」（`AiDataConsentRoute`、`aiPathRegistry.ts:5-6` で import）で、意味が衝突する。【提案】`workKnowledge`。
2. **Gate B2 の digest**：`aiPathRegistry.ts` の file digest は Gate B2 の束縛に入っている（`scripts/quality/certify-gate-b2.mjs:517`、`certify-gate-b2-bindings.mjs:79`、`freeze-gate-b2-candidate.mjs:236`）。欄を足す編集は digest を変えるため、Gate B2 の receipt との関係を実装の前に確かめる。
3. **ADR 012 との整合**：Work Focus と Chat のコンテキスト取得境界と、本 ADR の「読み取り口」が矛盾しないか。
4. **ADR 013 の番号**：保存の前に確認済み（Status の注）。別マシンや別セッションの未保存分は見えないので、PR の merge の直前に origin/master の `docs/adr/` をもう一度見る。
5. **ab_chat・cli・codex_app が chat の文脈を継ぐか**（経路 6 件の割り当て）。
6. **beat／inline の検出 Codex の上流（`matchedEntryIds` ←`codexMatchOrchestrator.ts`）が hidden を除くか**。#981 は要約の送信側を直すが、上流の確認は本文に無い。
7. **MCP FTS（`db.rs:677-679`）と pinned Codex（`chatApi.ts:842`）の hidden の扱い**。#981 は MCP の名前・LIKE・FTS を対象に挙げるが、個別には読んでいない。
8. **IME の読みの推定の hidden の除外**：確認 4 で「一括推定の対象から hidden を外す」と決まった（個別の「AIで推定」も不可）。個別推定での hidden の扱いは **2026-11-21 に回答済み：送らない**（ボタンでも送らず、読みは作者が手で入れる。contracts 19605110）。実装済み：一括推定は hidden を対象から外し、個別の「AIで推定」は hidden の項目で無効にし、送信の直前にも `inferReadings` が hidden を再判定して落とす（判定に失敗したら送らない）。
9. **別起案 (b) の前提**：`PublicationGuard.finish` が Graph の返却を覆うか、unrestricted での cache key の意味（決定記録:44）。読みでは確認済みで、click handle と activation をまたぐ operation は draftRef の「実装前の確認事項」に残る。
10. **AI 経路の registry 全体で、unrestricted の Graph 応答が chat に混ざらないこと**（grep 1 回の根拠を、経路全体に当て直す）。

## 確認の対象と状態（Fable の推奨を既定に置く）

### J1 AI への開示の既定：全部開示（ラベル付き）、作者の印は守る — **回答済み**
- 選択肢：(a) 今のまま／(b) 全経路でマスクを徹底／(c) 全部開示（ラベル付き、印は守る）／(d) 全部開示（印も無くす）。
- ユーザーの回答：**(c)**（2026-11-19、contracts `5e02e4f2`）。
- (c) と (d) の差は、作者が印を付けた項目の扱いだけ。(c) の理由は、既存の hidden や年表の secret を黙って送らないことと、本文の生成で 0 にしたい項目に指示以外の手段を残すこと。
- 回答に無かった範囲：J1 が IR・Graph 由来の応答（新しい分類）を含むか。本 ADR は**含まない**と書く（D1 の対象外）。**確認 3 の (a)（2026-11-20）で確認された。** 「記録に無かった点の確認」で、J1 の範囲を狭める方向の文言である。

### J2 印の強さ（意味）と例外
- **確認済み（2026-11-20、確認 3 の (b)。範囲は上のとおり）。** Codex の hidden と年表の secret は「どの経路でも AI に渡さない」、伏線の secret と Codex の suppress は「自動では渡さない（作者が尋ねたり tool で開いたりすれば渡る）」。今の挙動の追認で、設計書と UI 文言を実装に合わせる。当場面に紐づく伏線は、その場面の文脈として自動に含める（現状追認。確認の記録の要旨に明記は無く、「今の挙動の追認」に含むと integrator が読んだ）。
- 例外：抽出の経路（作者視点）、IME の辞書（ローカル）。IME の読みの推定は AI 送信だが例外にせず、確認 4 で hidden を一括推定の対象から外すと決まった（個別の「AIで推定」も不可、確認文 3）。
- 影響：agent tool が伏線の詳細を secret でも返すこと（`toolExecutors.ts:1442-1444` は project の境界だけを守る）は、この意味なら仕様になる。

### J3 既定値
- (1) 伏線の新規の既定を true から **false** に。agent と MCP の作成の既定も同じ値（`docs/Grimodex_AIエージェント設計書.md:326`、`docs/Grimodex_MCPサーバー設計書.md:775`、Fable）。既存の印は自動では変えない。**新規の伏線は未回収一覧で既定で AI に渡る**ので、外部 provider への送信の既定が広がる。
- (2) 年表 secret 固定規則（確認済み、2026-11-11）は当面そのまま。J1 の後に見直す。「抽出した出来事が既定で AI から隠れる」ことは全部開示と逆向きだが、この規則は「IR に通すために版の印を外しても、年表から AI への秘密は保つ」回避策で、年表の secret を残す限り矛盾はしない。見直す場合は確認済みの規則の改訂（別起案）。
- 既存 project の印は変えず、作者が見直す導線（一括で外す操作）は移行の段 5 で出す。

### J4 まだ明かされていない情報を自動の注入に入れるか
- (a) 入れない（今の Phase と年表の挙動。recall・アウトライン・tool では今どおり見える）／(b) ラベル付きで入れる。
- 既定：**まず (a)＋開いている経路へのラベル**。(b) は測定（J5）の後。(a) は自動注入の送信内容を増やさない（ラベル文字列のみ）。(b) は外部 provider に渡る内容が増える（Codex の未来の Phase、reveal 前の出来事、secret な伏線の一覧）ので、別の確認が要る。

### J5 振る舞いの層の測定
- 既定：**小さな測定を先に**。未開示の項目を数個持つ場面で、(i) 項目を除外、(ii) ラベル付きで渡して「本文では明かさない」と指示、(iii) ラベルなしで渡す、の 3 つを比べ、明示の漏れ・伏線としての利用・後の事実との矛盾を数える。その後、指示＋非 blocking の応答の点検。
- 根拠：「話すな」という方針は直接の問いではほぼ守られるが、間接の問いでは漏れが大きく増える（CoPriva。`nir-prior-art-2026-11-06.md:574`、Fable。会議録の質問応答で、小説の本文生成の測定ではない）。点検は明示の漏れしか拾えない。
- 現状の prompt に抑える指示は年表の説明文の 1 か所だけ（`src/prompts/ja/chatSystem.ts:178-182`）。
- 生成は subagent を優先する。API を使うなら総額は別に伺う。

### J6 opt-in のマスクの用途
- 既定：方針だけ決め、実装は後。読者の反応を「ここまで読んだ読者」に広げるか、キャラクターの視点の対話を作るか。形の原則は「全知の chat に後からマスクを掛けない。材料を allowlist で組む専用の surface にする」。
- 土台：Scene Scope の knowledge holder／audience（棚卸し「データの側」10）。POV は今 veto にしか使われない（同 8）。

### J7 画面の方針の明文化：K2/5 による
- 画面の判定（宣言と veto）の撤去は、K2/5（`nir1-c-body-disclosure-proposal/5`）で確認された（確認の記録の確認 1）。ADR には「画面の判定の撤去は K2/5 による」とだけ書き、確認文を別に求めない（二重の確認をしない）。
- IR admission と Graph の path 規則は PUB-G の後に見直す。Scope A1 の一致は関連の質の選別として残す。これらは K2/5 の範囲と D6 に書いた。

## 確認の記録と、残る確認

確認の記録（contracts `11dc9eda`）の問いは、点検の指摘（技術語を減らす、二重の確認をやめる、重要な変更に絞る）に合わせて、統合者が平易にまとめた。確認文の正確な入力は要らず、同意・修正の回答で足りる。draftRef は `ai-knowledge-disclosure-policy/1`（案）。各文は、その項目だけを確認し、他の項目の確認を代行しない。確認の対象は 1〜5・7 に絞り、それ以外は integrator の判断として記録した。

| 文 | 内容 | 状態 |
|---|---|---|
| 0 | 【J1・記録】`#ai-default-disclosure`：AI への開示の既定は「印の無い作品知識は位置のラベル付きで全部渡し、作者が付けた印（Codex の hidden、年表の secret）と位置の正しさは守る」。ADR 002 の「AI に隠すのが既定」の位置づけをこの範囲で追補する | 回答済み（2026-11-19、(c)） |
| 1 | 【J1 の範囲】`#ai-default-disclosure-scope`：上の「全部開示」は IR・Graph 由来の応答（新しいデータ分類）を含まない。Graph の応答は画面だけで使い、AI の request・Packing・履歴・書き出しには載せない（経路の契約）。場面の本文などの元データは各経路の読み取り口から AI に渡す。実装計画 A8 の「既存の送信同意を自動で広げない」を維持する | **確認済み（2026-11-20、確認 3 の (a)。記録に無かった点の確認）** |
| 2 | 【J2】`#ai-author-mark-strength`：Codex の hidden と年表の secret は「AI に渡さない」、伏線の secret と Codex の suppress は「自動では渡さない（明示的に取りに行けば見える。今書いている場面に紐づく伏線は、その場面の文脈として自動に含める）」と定め、抽出の経路と IME の辞書は対象外とし、設計書と UI 文言をこの意味に合わせる | **確認済み（2026-11-20、確認 3 の (b)）。確認の記録の要旨は 2 段の強さと今の挙動の追認で、当場面の伏線の自動の扱いと、抽出の経路・IME の辞書を対象外とすることは要旨に明記が無く、「今の挙動の追認」に含むと integrator が読んだ** |
| 3 | 【IME の読みの推定】`#ai-ime-reading-inference`：IME の読みの一括推定（AI 送信）が、hidden の項目の名前と別名を provider に送る現状は直す。hidden の項目は一括推定の対象から外し、読みは作者が手で入れるか個別に推定する。例外にしない | **確認済み（2026-11-20、確認 4。直す）**。確認当時の記録。2026-11-21 の回答で、個別の「AIで推定」も不可に更新（contracts 19605110） |
| 4 | 【hidden の修正の範囲】`#hidden-leak-fix`：「3・4 辺りは許容していた」は agent tool（3）と MCP（4）を指すと読み、そのうち Codex の hidden の返却だけを許容の外とする。PR #981（merge 済み）がその主な経路を塞いだ。#981 に残る派生情報（年表の参加者名、統計の件数、tag の usageCount、hidden の id への更新の応答、beat の povName、MCP の Phase override）は、hidden を送らない向き（確認 3 と同じ）で次の PR で直すことを既定とする。許容として明記する場合は、その旨を回答してほしい | **未確認**（番号の読みと残漏れの扱い。送信範囲は狭まる方向で、広がらない） |
| 5 | 【J3 (1)】`#ai-default-secret-foreshadow`：伏線の新規の既定の secret を false にする（既存の印は自動では変えず、見直しの導線を出す）。新規の伏線は未回収一覧で既定で AI に渡る | **別に確認する（未確認）。外部 provider への送信が広がる** |
| 7 | 【J4】`#ai-unrevealed-auto-injection`：まだ明かされていない情報（Codex の未来の Phase、reveal 前の出来事）は、当面は自動の注入に入れず、開いている経路への位置のラベルだけを足す。入れる場合（J4 (b)）は測定の後に別の確認を求める | 既定は (a)＋ラベルで送信範囲は広がらない。**(b) は別に確認する（未確認）** |

### 統合者の判断として記録するもの（確認の対象にしない）

確認の対象を重要な変更に絞る方針（2026-10-25）に合わせ、次は推奨を既定として記録する。変える場合は新しい確認が要る。

- J3 (2)（文 6）：年表 secret 固定規則（確認済み、2026-11-11）は当面そのまま維持し、見直しの要否は本方針の実装後に別の起案で伺う。変更なしの記録。
- J5（文 8）：ネタバラシの抑制は、まず 3 条件の小さな測定を行い（生成は subagent を優先、API を使う場合の総額は別に確認）、その後に prompt の指示と非 blocking の応答の点検で行う。測定の手順は技術判断。
- J6（文 9）：知らないふりが必要な用途（読者の反応を「ここまで読んだ読者」に、キャラクターの視点の対話）は、全知の文脈にマスクを掛けず材料を絞った専用の surface とする方針だけを今決め、実装は後にする。
- 位置の正本（文 11）：TS の `buildReadingOrder` と、fixture で parity を取る Native の `reading_rank` を正本とし、MCP の DFS を同じ fixture に入れて揃える。R の story／auto の軸は本方針では変えない。
- 移行の順序（文 12）：「文言・既定値・ラベルを先、判定の撤去を後、送信量を増やす変更は測定の後」の順で進め、各段の prompt 変更は品質ゲートを通す。
- 画面の判定の撤去（旧文 10、J7）：K2/5 による。本 ADR では確認を重ねない。

別起案として確認済み、または別に確認を求める（本 ADR の確認に含めない）：本文の宣言（K2/4）の廃止（K2/5、確認済み）、Graph の restricted 条件の解除（確認済み）、最後の凍結の開始（別の承認）、Scope A1 の公開後の見直し、R の別枠の未来の場面、IR／Graph の作者視点 profile、IR admission と Graph の path 規則の見直し。

## 未確認・【推測】

- 実行・test・build はしていない。「ファイル:行」は起案の基点（`04202c37`）のもの。
- #976・#981 は `gh pr view` の本文を読んだだけで、diff 本体は読んでいない（両方とも merge 済み、2026-11-19）。
- 経路 69＋1 の割り当ては registry の surface／layer からの分類。ab_chat・cli・codex_app の継承、builder 単位の約 45 は【推測】。
- 位置の正本：MCP が shared fixture に入っていないことは grep（参照する試験が 2 つだけ）による。MCP 側の別の parity 試験の有無は見ていない。
- 当場面の secret な伏線を「自動に含める」既定は、本文の生成で必要という【推測】に基づく（確認 3 の (b) の「今の挙動の追認」に含むと integrator が読んだ。要旨に明記は無い）。
- `matchedEntryIds` の上流、MCP FTS、pinned Codex、IME の読みの推定の個別推定での扱い、ADR 012 との整合、Gate B2 との関係は「実装前の確認事項」に置いた。
- 確認文 4（番号の読みと残漏れの扱い）、確認文 5（J3(1)）、J4(b) は、ユーザーの確認を受けていない。
