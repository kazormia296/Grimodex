# 伏線の「AI にこの伏線を見せない」の廃止（FSR/1）の実装の判断の記録

- 起案：`docs/plans/nir1-foreshadow-secret-ai-side-retire-proposal-1-draft.md`（FSR/1。ユーザー確認 102・105・118〜120・123・129・130。記録は contracts の `docs/plans/nir1-pubg-records/user-confirmation-2026-11-22-chronicle-scene-review-apply.md`）。
- 方針：伏線の `secret` を、**AI への渡し方についてだけ**やめる。未回収・未放棄の伏線は全部 AI に渡す。列と既存の値は残す。関連する過去シーンの判定（A3）・本文の宣言の veto・作者向けの警告（目のアイコン）は、列を読み続ける。製品の変更は最後の凍結の前に master に入れ、**公開版（release）には、全部（F1・F2・F3・F9・F10）が入った後に、F7 の測定の結果をユーザーに見せてから出す**。
- 担当：grimodex-23。実装は PR を分ける：F1（この版）→ F3・F2（同じ release。F2 は F3 より先に出さない）→ F9（回収済みの一覧）→ F10（省いたときの 1 行）。

## 1. この PR の範囲：F1（渡し方）

**入れる**：未回収の伏線の一覧から `secret` の条件を外す 5 か所と、それに合わせた試験・golden・説明文・設計書。
**入れない**：`create_foreshadow`・`update_foreshadow` の `secret` の引数と既定（ON）、画面のチェック（F2）、書き口の既定の変更（F3）、列の DEFAULT、undo／trash の既定、回収済みの一覧（F9）、省いたときの 1 行（F10）、関連する過去シーンの判定・本文の宣言の veto・目のアイコン、`events.secret`（CSR/1）。

### DR-FSR-1　未回収の伏線の一覧から、`secret` の条件を外す（F1）

- 外した所：Native `foreshadow.rs` の `list_open_for_context`（`WHERE project_id = ? AND payoff_confirmed = 0 AND abandoned = 0`）、renderer の in-browser 枝（`src/features/foreshadow/api.ts` の `readOpenForeshadowWire`）、MCP `db.rs` の `list_open_foreshadows`、MCP `tools/context.rs` の `get_writing_context`（今の場面の仕込み・回収の 2 本と、全体の未回収）。**この 5 か所で、チャットの自動の文脈（「### 未回収の伏線」）、アプリ内の `list_open_foreshadows`（core は Native の wire を使う）、MCP の `list_open_foreshadows` と `get_writing_context` が揃う。**
- 残す条件：`project_id`・`payoff_confirmed = 0`・`abandoned = 0`（MCP の今の場面の仕込みは `s.is_orphan = 0` も）。**回収済みと放棄は、今までどおり、自動の一覧にも、指定なしの道具にも含めない**（確認 102 の文は「未回収の伏線を全部」）。形（題・意図・状態の印・重要度・仕込みの件数）と、枠（約 1000 token。超えると critical だけ）は変えない（超えて省いたときの 1 行は F10）。
- **アプリ内の今の場面の伏線（`foreshadow.rs` の scene の関連）と、`get_foreshadow_detail` は、元から `secret` を見ない（変えない）。** MCP の `get_writing_context` だけが、今の場面の伏線を `secret` で除いていた食い違いは、解消した（アプリ内と揃う）。
- core `electron/shared/readDomain/core/foreshadowTools.ts` の本体のコードは変えない（注とコメントだけ）。wire に `secret` の列は無いので、core はもともと再び絞らない。DR-MP4-24（Mastra の「list は `secret = 0`、detail は判定なし。非対称。MP-4 は同値で写し、変えない」）は、**この非対称を解消する側に変わった**。固定していた試験・golden・Native の SQL の写し（`readCore.mainAdapter.test.ts`）を直した。Mastra の担当（grimodex-32）には、PR で中身（list の第 1 case に `secret = 1` の伏線 `fs-2` が入ること）を見てもらう。

## 2. 残る制限（F1 の後。F1 だけでは公開しない）

起案の §3 の 1〜4 のとおり（どれも、ユーザーに伝えた上で確認済み）。この PR に特有の点：

- **この PR の後も、`create_foreshadow` の既定は ON のまま**（F3 で OFF にする）。AI が作る伏線は、`secret = 1` で保存されるが、AI への渡し方では、もう効かない。`create_foreshadow` の説明は「secret items are hidden from list_open_foreshadows and AI context …」と言っており、**この PR の後は偽り**になる。F3 で、道具の定義から `secret` を消すときに直す（AI 指示の資産。`grimodex-author` の品質ゲートを通す別の PR）。
- 画面のチェック「AI にこの伏線を見せない（ネタバレ防止）」は、F2 まで残る。ON にしても、AI への渡し方には効かない。**公開版には、F1・F2・F3 が全部入った後でだけ出す**。
- 題・意図・メモの文中の hidden の名前は、判定できず、そのまま渡る（起案の §3 の 2。確認 120 (a)）。
- 実 addon（`mastraReadParity.pipeline.spec.ts`）は、hosted の `electron-native` が最終の確認。

## 3. 検証

（PR の本文に書く。）
