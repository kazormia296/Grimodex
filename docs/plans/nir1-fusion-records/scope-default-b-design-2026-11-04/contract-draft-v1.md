# NIR-1 契約提案 nir1-scene-scope-default-proposal/1（draft）：新しい場面は project の Scope の既定を受け継ぐ

| 項目 | 内容 |
| ---- | ---- |
| draftRef#contractId | `nir1-scene-scope-default-proposal/1#scope-storage-authority` |
| Status | draft／未確認。確認されても、Graph・local 送信・activation UI の公開と、閾値・Gold・評価の規則の変更は許可しない |
| baseline | `nir1-l6-l9-contract-proposal/3#scope-storage-authority`（`docs/plans/nir1-l6-l9-execution-plan.md:229`、:296-305、L6 の表 :859-877）。X1/1（:247）、X1/3（:249）、K2/4（:251）の行は置き換えず、この行を加算で並べる。互いを前提にしない |
| 基点 | `origin/master` `a8c5fa65`（行番号は `f36dd696` と同じ） |
| ユーザーの選択 | 案 B（contracts `2cddfb14`）、U1〜U3 はすべて推奨（contracts `fd06db06`）。U1〜U3 は契約の確認ではない |
| 設計の理由 | `/home/grimodex/fusion-eval-data/scope-b/design-rev2.md`（以下 rev2）。この文書では理由を繰り返さない |

## 1. 規則

### 1.1 保存先
- R1. Native が project ごとに「場面の Scope の既定」を 0 または 1 つ持つ。新しい表 `narrative_scope_project_defaults`（SCHEMA 44）に保存し、`state`（`set`／`none`）、query identity、material 制約、OCC の `version`、`source_token`、`updated_at` を持つ（rev2 §3.2）。
- R2. 既定の中身は閉じた型とする。query identity の 3 軸（timeline／worldline／narrativeLayer）はすべて exact で、material 制約は query identity と同じ exact。holder と audience は reader に固定する。any と unresolved は持たない。
- R3. 既定の ref は、同じ project の registry の member でなければ書けない。registry の writer は、既定が使う ref を消す更新を拒否する。
- R4. 既定は registry、binding、project の Scope authority の token のどれにも入らない。既定の書込みは narrative の feed を書かない。既定の変更の履歴は canonical の change event として残す。残す範囲は変更前後の値、時刻、request の識別子で、本文は残さない。
- R5. 「既定を外す」は行を消さず、`state = none` にして `version` を進める。

### 1.2 継承の判定
- R6. 継承できる writer は、閉じた一覧の 3 つだけ：`tree_node_create_with_authority`、`apply_ai_tree_plan`、`promote_sticky`。
- R7. 継承するのは、次の (a)〜(d) をすべて満たすときだけ。判定するのは Native で、renderer には継承の可否も Scope の値も申告させない。
  - (a) origin が `human` か `ai-apply`。
  - (b) `original_transaction_id` と `undo_journal_id` が無い。AI の木構造計画では `redo` が false。route が `history-replay` でも `restore-or-migration` でもない。
  - (c) `source_uri` と `source_mtime` がどちらも無い。
  - (d) 既定が `set` で、その ref が同じ transaction の同じ snapshot の registry の member。
- R8. 継承するときは、binding を marker `explicit`、既定の値、version 1、新しい incarnation で書く。継承しないときは今どおり `unknown` を書く。どの場合も any には落とさない。既定の行が読めない、壊れている、dangling、別 project のときも `unknown` を書き、作成自体は失敗させない。
- R9. origin／lineage／route の申告の扱いは、既存の契約の作成の writer（route `human-direct` など）と同じで、新しい信頼を足さない。

### 1.3 継承しない経路
- R10. 次の経路は、既定があっても `unknown`（migration の backfill だけは `legacy-absent`）を書く。
  - 戻す経路：取り消し、やり直し、history-replay
  - 復元：ゴミ箱、project snapshot の本文 restore
  - 同期と取り込み：外部フォルダの同期、取り込み（origin `import`）
  - そのほか：本文保存での欠けた binding の修復、製品同梱サンプル、性能・容量の seed、migration の backfill
- R11. renderer のゴミ箱の restorer（今は未配線）を配線するときは、origin `restore` で呼ぶ。

### 1.4 作成画面と取り込み
- R12. 既定を初めて書くのは、`project_create` の optional な typed field（`sceneScopeDefault: "main-line"`）が渡されたときだけ。Native が同じ transaction で既定を書く。
  - 製品の作成画面は、チェックボックス「新しい場面を『本筋』で作る」を既定オンで出す。
  - field の無い `project_create` は、今どおり既定なしで作る。評価の harness はこの形で呼ぶ。
  - 次の 2 つは `project_create` を通らないので、既定なしで始まる：migration が作る最初の project、generic import が作る project。
- R13. registry を初めて作るときは、本筋の語彙 `timeline:main`／`worldline:prime`／`layer:manuscript` を入れる。対象は、まだ registry の行が無い project で、migration の backfill を含む。語彙だけでは挙動は変わらない。
- R14. 取り込みで作られた場面は、Native が継承しない。
  - 取り込みの画面のチェック「取り込みのあと、取り込んだ場面に既定を当てる」は既定オフ。
  - ON のときだけ、取り込みの完了後に renderer が既存の writer `narrative_scene_scope_update` を場面ごとに呼ぶ。対象は `unknown` の場面だけで、作者の操作として扱う。
  - 結果は部分適用でありうるので、当てた件数と当てられなかった件数を画面に出す。

### 1.5 既存のデータ
- R15. migration は、既存の project に既定を入れず、既存の binding も変えない。
- R16. 作者は次の 2 つの操作で既定を当てられる。どちらも既存の writer を場面ごとに呼ぶ操作で、新しい一括 writer は作らない。
  - 設定画面で既定を選ぶ。
  - 場面・章・project の単位で「未設定の場面に既定を当てる」を押す。対象は `unknown` の場面だけで、`legacy-absent` は別の操作と警告にする。

### 1.6 失効
- R17. 既定の設定・変更では、何も失効しない。対象には、既存の binding、registry、Revision、Index、本文の宣言が含まれる。
- R18. 既存の場面に既定を当てるのは、A1 の設定の変更として扱う。今の規則どおり、その場面に依存するものを失効させる。
- R19. 既定のために registry に ref を足すのは、registry の変更として扱う。今の規則どおり、project 全体の依存を失効させる。画面で事前に警告する。
- R20. 継承で作った binding は、新しい incarnation の作成として今の規則に従う。

### 1.7 開示の防御（変えないもの）
- R21. 次はすべて今のまま変えない。
  - `unknown`／`unresolved` の fail closed（query 側、材料側、Graph の `explicit` 要件）
  - query identity に any を作らないこと
  - ADR 009 の any と unresolved の区別
  - 案 D（`unknown` を any や legacy-absent と同じに扱う）を採らないこと
  - 読書順（strict reading-before-S2）
  - 秘密を出さないこと
  - 人の承認を要すること
  - `legacy-absent` へ戻せないこと
  - 復元・undo で旧資格を復活させないこと
  - binding の形と v1 の token の式
  - registry の変更で全件を失効させる規則（X1/1 Q2）

## 2. Trusted／Untrusted、攻撃
- Trusted actors：変えない。既定の writer と reader、継承の判定は Native に置く。
- Untrusted actors：今の一覧に 2 つを加える。どちらも開示の認可の根拠にしない。
  - renderer が申告する既定の値
  - `project_create` の `sceneScopeDefault`
- In-scope attacks（追加）：
  - 別 project の既定の参照
  - registry に無い ref を持つ既定
  - dangling な既定から any への fallback
  - 戻す・復元・同期・取り込みの経路での黙った継承
  - renderer の申告による Scope の値の持ち込み
  - 既定の変更で既存の場面が書き換わること
- Out-of-scope attacks：今と同じ。renderer が origin を `human` と偽った作成は作者の作成として扱われ、既定の値だけを書ける。既存の Scope の writer より弱いので、この行では防御の対象にしない。

## 3. Mandatory defenses
- MD1. 継承の判定（R7）は 1 つの Native の関数にまとめる。3 つの writer は、origin と lineage を検証した後、同じ transaction の中でこの関数を呼ぶ。
- MD2. 作成の種類を表す閉じた引数（継承する／しない）を binding の作成関数に渡す。bool にはしない。継承しない経路は、すべて「しない」を渡す。
- MD3. 既定と registry は同じ snapshot で読み、exact な project と ref を要求する。合わなければ `unknown` を書く（R8）。
- MD4. 既定の writer は、OCC、冪等、型の検証、registry の所属の検証を行う。binding、registry、authority の token は書かない（R4）。
- MD5. 新しい表を、generic SQL の拒否一覧と保護 writer の一覧に加える。renderer は既定を IPC の typed command だけで読み書きする。main は引数を再検証する。
- MD6. 作成の command（`tree_node_create` など）の payload には field を足さない。

## 4. 受入れ試験の要件
- A1（正例）：既定のある project で、3 つの writer の forward の作成が `explicit`（既定の値）を書き、cold reopen の後も同じ。本筋の場面どうしで IR と Graph が出る。
- A2（R7・R10 の負例）：既定があっても次の場合は `unknown` になる。
  - 削除の undo（章の削除の undo を含み、配下の全場面）
  - 作成の redo、AI 計画の redo、付箋の昇格の undo／redo、route `history-replay`
  - 外部 source を持つ作成（mount）、origin `import`、origin `restore`
  - ゴミ箱、snapshot の restore、本文保存の修復、サンプル、seed
  - 既定なし、`state = none`、dangling、別 project
- A3（静的な試験）：継承する側の定数は、許可した 3 関数の中の、判定の関数の結果で守られた分岐にだけ現れる。判定の関数がそれを返す分岐は 1 つだけ。
- A4（R4・R17）：既定の書込みの前後で、全 binding の bytes、registry の行、project の Scope authority の token が同じ。`none` に変えて再設定しても、token が前の値に戻らない。
- A5（R3）：registry から既定が使う ref を消す更新は拒否される。
- A6（R13・R15）：migration の後、既存の project に既定の行が無く、binding が変わらない。公開版（schema 2）からの更新では registry に語彙が入り、場面は `legacy-absent` のまま。
- A7（R12・R14）：
  - 作成画面のチェックの有無と、`project_create` の field の有無が対応する。
  - 取り込みのチェックが OFF なら、取り込んだ場面は `unknown` のまま。
  - ON なら完了後のループで `explicit` になり、部分適用が表示される。
- A8（開示）：読書順と秘密の既存の負例が変わらない。query だけを変えた場面については、Scope 欄が material を追随させることを試験する（rev2 §7.3、§8.4）。
- A9（評価）：CP-4 の凍結 setup と DP-H の harness が、新しい初期状態（語彙あり・場面は `unknown`）から最後まで通る。Gate A2 の upgrade の試験の期待値を確かめる。

## 5. 範囲外（この行は確認しない）
- 復元・undo で元の Scope を保つこと（保存範囲の追加。別の draftRef が要る）
- 章（folder）ごとの既定と、直前の兄弟の場面からの継承
- 人物を holder／audience の既定にすること
- material を query と別の値にする既定
- 関連場面の wire の理由の集合の変更
- 新しい 1 transaction の一括 writer
- サンプルの場面を本筋にすること
- 既存の project への既定の自動投入（U3）
- 案 γ（migration が最初の project に既定を入れること。L0 の確認が先）
- PUB-G の開示文の確定（PUB-G の確認で聞く）
- Graph・local 送信・activation UI の公開
- 閾値・Gold・評価の規則・凍結済みの trace の変更
- 新しい送信先

## 6. 確認台帳の新旧の対照（proposal/3 の文 → この行）

| proposal/3 の文（l6-l9） | この行での扱い |
| ---- | ---- |
| :299「Native-owned project registryとsceneごとのclosed binding」 | 保存するものに、project ごとの Scope の既定（新しい表）を足す（R1〜R5） |
| :870「新規、複製、import、削除後のID再利用｜…Scope markerは未設定なら`unknown`」 | 「未設定」を「R7 を満たさない」と読む。R7 を満たす新規の作成は `explicit`（既定の値）。import と削除後の ID の再利用（undo）は `unknown` のまま（R10） |
| :861「`legacy-absent`／`explicit`／`unknown` Scope marker」 | 値の集合は変えない。`explicit` には、作者の project の設定から Native が書いたものも含む |
| :873「markerのない部分snapshot、不明な復旧｜`unknown`」 | 変えない（R10） |
| :299「registry／setting／incarnation mutationは同一transactionで依存…をinvalidate」 | 変えない。既定の変更はこの mutation に当たらず、何も失効させない（R17）。既定を当てる操作と registry の変更は、今の規則に従う（R18、R19） |
| :301 Untrusted actors | renderer の既定の値と `sceneScopeDefault` を加える（§2） |
| :302 In-scope attacks（unknownからanyへのfallback ほか） | 残す。§2 の 6 項を加える |
| :304 Mandatory defenses（rendererを認可根拠にせず、unknown／unresolvedはfail closed） | 残す。MD1〜MD6 を加える |
| :305 Acceptance implications | 残す。A1〜A9 を加える |
| :299「authorityは既存project Scope authorityを再利用し、第二のauthorityを作らない」 | 変えない。既定は authority の token に入れない（R4） |
