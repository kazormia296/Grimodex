# NIR-1 CP-4：編集 trace に残る失効の別 lane の設計案（草稿）

状態：**草稿の初版**。独立レビューを受けていない。ユーザーにはまだ示していない。製品・harness・fixture・S2・S4・閾値・Gold は変えていない（この文書を足しただけ）。
基点：master `22b74a25`。測定は S4b'''（`60bf9dc4`）・候補 `22b74a25`（DR-CP4-S6-2、PR #775）。
方向の確認：ユーザーが 2026-11-02 に S7 の報告へ「それで行きましょう」と返した（contracts `5cefa6da`。報告末尾の見立て〔(A) 案 1：HOLD を受け入れ、残る失効を X1-5 と同じ型の別 lane で設計する〕への同意と読んだ。自由記述で、AskUserQuestion ではない）。確認の範囲は**設計の起案と独立レビューまで**。実装・診断 run・再測定は、この設計を示して改めて確認する（契約・authority の改訂が要る案は、新しい draftRef として確認するまで実装に入らない）。
材料：read-only の調査 2 件（調査 A＝begin の前の取消し、調査 B＝follow-up の失効）。どちらも subagent の報告で、integrator が主要なコード位置を確かめた（下の「確かめた点」）。調査の記録は scratchpad にあり、リポジトリには入れていない。

## 要点

1. 編集 trace の失効（Q=201）の残りは **3 つの別の原因**で、いずれも B（Graph の Index）の入力が変わっていないのに失われている。X1-5 と同じ「過剰な無効化」の型に見えるが、**3 つのうち確定しているのは 1 つだけ**。

   | 線 | 件数 | 読み | 原因 | 確度 |
   |---|---|---|---|---|
   | LP-A | 8 | K6/2・K6/4 | `index-ready` の通知で、まだ begin を送っていない世代を renderer が取り消す | 経路は確認済み。過剰と判定 |
   | LP-B | 3 | K6/4 | worker の canonical registration が登録の窓の中の別 commit（`data_version` の drift）で拒否され、再試行されない | 経路は確認済み。拒否の分岐は推測 |
   | LP-C | 4 | K6/4 | child の begin 後の Main 側の再検査が `invalidated` を返す | Main 側までは確認済み。分岐は未確定。意図か過剰かも未判定 |

2. **LP-A は renderer の hook だけの変更**で、IPC・Native・`scope-storage-authority`・保存範囲に触れない。効果の見込みは K6/2 の失効 8→0（0%）、K6/4 は 15→7（3.48%）。
3. LP-B と LP-C は、**原因の分岐を決める診断（eval build の計装による dev run）が先**。診断は正式の測定ではなく、製品 build には入らない。
4. 3 つを全部直せば K6/4 の失効は理屈の上では 0 になるが、**見込みであって保証ではない**。race が原因の失効は、直した後に別の窓の race が見えることがある。再測定が要る。
5. 緩和（失効の読みの変更など）は採らない。列挙は §5。

## 1. 事実（測定。S4b'''・候補 `22b74a25`・編集 trace、Q=201、U=193）

| | 件数 | 率 | 内訳 |
|---|---|---|---|
| K6/2 の読み | 8 | 3.98% | すべて `cancelledBeforeBegin`（DR-CP4-V-3 の厳しい側の読み） |
| K6/4 の再計算 | 15 | 7.46% | i-b-seal 11（上の 8 ＋ 親の登録不可 3）＋ iii（child の合流の無効化）4 |

物差しは 1%（Q=201 で 2 件以下）。開始時の B の封印は 201/201 current（X1-5 の効果）。7 件の B は trace 全体で generation 1・dirty false のまま。

## 2. LP-A：`index-ready` で begin の前の世代を取り消す（8 件）

### 2.1 機構（確認済み）

- 8 件（traceIndex 57・74・96・107・118・155・176・187）は同じ形：`related-scenes:index-ready` の通知の 3.4〜4.5 ms 後に親の fetch が呼ばれ、1.1〜1.4 ms（2 件は約 40 ms）で `cancelled`（`rawStatus: not-started`、begin の API 行なし）。約 404 ms 後に同じ鍵の再 query が出て、begin・公開・`graph-ready` の子まで完走する。8 件とも開始時の封印は `current`、A3 は eligible。編集の向きは関係しない。
- 前の正式の run（#48・#72・#200）と dev の稽古（4 件）にも同じ 1 ms 幅の署名が記録されている（DR-CP4-V-3）。3 回の run で再現する系統的な race。
- 通知の遅れは二峰（seal から 150〜250 ms が 149 件、400〜666 ms が 9 件）。遅い 9 件は tree の更新から 400 ms の timer の発火より後になり、`run()` の開始〜begin の前の窓に落ちる。**9 件目は #139**（通知の 0.1 ms 後に呼出し、begin の後に取り消されたので K6/2 は「その他」、K6/4 は X11 に入った）。
- 取消しの経路：
  1. `useNir1RelatedScenes.ts:147-150`：`index-ready` の listener が状態を見ずに `setRefresh`。
  2. `:355-358`：effect の cleanup が `abort.abort()`。
  3. `fetchNir1RelatedScenes.ts` の `stopIfContextChanged()` が `cancelled` を返し、begin（237 付近）に届かない。

### 2.2 判定：過剰（範囲は狭い）

- `index-ready` での再 query 自体は意図した挙動（#567。dsn §3.4）。過剰なのは「まだ begin を送っていない世代を捨てる」部分。
- 根拠（コードで確認）：dense の検索結果は **`beginRelatedScenes` の応答**から来る（`fetchNir1RelatedScenes.ts` の begin の後で `response.denseHits` を使う）。emit は publication の commit の後（`related_scenes/build.rs:45-49`、`:277-292`）。よって通知の後に送る begin は新しい index を読む。begin の前に走る検索は sparse（FTS）だけで、これは `index-ready` の対象ではない。**捨てなくても古い index の結果は表示されない**。
- 失うもの（今の挙動）：1 回の query、約 400 ms の表示の遅れ、Graph の follow-up（親が無いので K6/4 は X12）。

### 2.3 案 LP-A1（推奨）：`graph-ready` と同じ型で扱う

- 変更箇所：`src/features/related-scenes/useNir1RelatedScenes.ts` だけ。`index-ready` の listener を、React の state を通さず同期で判定する。
  - 世代が **begin を送る前**（timer の待ち、または `run()` の開始〜begin の前の in-flight）：取り消さない。これから送る begin は通知の後になる。
  - 世代が **begin を送った後**：`graphReadyDuringFetch`（DR-CP3A-49）と同じく世代に印を付け、公開の後に 1 回だけ refresh する。
  - 表示済み（idle）：今どおり `setRefresh`。
  - 「begin を送ったか」は、fetch に callback を渡すか、session の `readinessRevision` を begin の直前に読んで比べる。listener と timer は同じ renderer thread の task なので、判定は同期で決まり、effect の cleanup に頼らない。
- **debounce の張り直し**：今は正常な cycle でも通知で 400 ms をやり直している（通知＋約 405 ms）。止めると counted query が約 200 ms 早まり、測定の形が変わる。**張り直しは残す**（ref で張り直す）。これを守る試験を足す。
- 効果の見込み：K6/2 の失効 8→0。#139 も解消（K6/2 の other と K6/4 の X11 が 1 減る）。K6/4 は 15→7。取り消されなくなった 8 件が別の follow-up の失敗（X1／X5 など）に移る率は、正常な query の基準率（約 7/193）なら 0〜1 件。
- リスクと試験：
  - `useNir1RelatedScenes.followUpWindow.test.tsx:204`（「index-ready と、通知と同時の tree の変化には印を付けない」）、DR-WF-8 (a)（`index-ready` と `graph-ready` の 2 つの `setRefresh` が 1 回の描画にまとまると `byGraphReady` になる）、DR-RSJ-6／DR-WF-3 の鍵の一致の判定と当たる。`index-ready` が `setRefresh` を通らなくなると、この合流の場合の扱いが変わる。graph-ready の経路は変えず、試験で固定する。
  - 追加する試験：通知と seed の読取の解決の**順序 2 通り**（通知が先／seed の読取が先）で、timer の発火の直後〜begin の前に `index-ready` が来ても、その世代は begin まで進む。begin の後に来たら公開の後に 1 回だけ取り直す。
  - 判定の誤り（本当は begin が通知より前だったのに「前」と見る）は、表示が 1 世代古い index になる。begin の送信の時点を正しく取れば起きない。**この点を独立レビューで最も厚く見る**。
- K6/4 の規則との整合（integrator の確認事項）：F4（`index-ready` が親の世代と子の間に無いこと）と X7（`index-ready` 起因の query は率に数えない）は、**子**の分類の規則。調査 A は、K6/2・K6/4 の draft と dsn に「`index-ready` は必ず再 query を起こす」と固定した文言を見つけなかった。通知が親の `tFetch` の後・begin の前に来る場合は、LP-A1 でも K6/4 では X7 になる（今は X12）。**規則の文言を網羅して確かめる**のは独立レビューの項目に入れる。
- 触れる契約・authority：IPC 契約、Native、`scope-storage-authority`、保存範囲、送信先のいずれにも触れない見込み。lane の decisions（RS-JOIN／WF-WINDOW の追記）で足りる見込み。ただし**製品の変更なので、候補の作り直しと再測定が要る**（§4）。

### 2.4 案 LP-A2（補助、単独では推奨しない）：`index-ready` の遅れを減らす

`related_scenes/build.rs` の 250 ms の再試行や、build の publish と renderer の `db_execute` の競合。遅れが起きる率が下がるだけで race は残る。仮説（build の書込みが renderer の読取を一時的に止める）は未確認。

## 3. LP-B／LP-C：follow-up の失効（K6/4 の読みで 7 件）

### 3.1 LP-B：親の登録不可（3 件。traceIndex 14・99・123）

- 確認済み：D′ の held query の release 後の worker の prepare が `StartupRegistrationRefused`（worker bin `nir1-c-query-worker.rs:250`、分類 `c_query_worker.rs:3008-3011`）で失敗し、`prepare_failure`（`electron/native/grimodex-node/src/nir1_graph_product.rs:2786`）が `(RegistrationUnavailable, Count)` を返す。**再試行はなく**、2 s の backoff が付く。次の query の `preparesReady` が増えていない。settle が 35〜39 ms で、成功 185 件の最小 41.2 ms より早い。
- 推測：拒否の分岐は **post-flight の identity drift**（`nir1_graph.rs:686`。`ReadIdentity` が DB 全体の `data_version` を含む）。B の入力に触れない commit（Chronicle の publish、Freshness、audit）でも拒否になる。ただし成功した 184 件も同じ時間帯に commit を持つので、時刻の重なりだけでは確認にならない。
- 判定：分岐が drift なら**過剰**（X1-5 と同じ型）。
- 案 **LP-B1（推奨）**：drift のときだけ登録を有界に再試行する（最大 2 回）。owner 側で `run_deferred` から `build_worker` をもう一度呼び、新しい commit 済み state で proof を取り直す（費用は worker 1 回分、35〜40 ms）。proof の意味（「その commit 済み state に pin した proof でだけ query する」）は変えない。遅れで X3 late の「その他」に移る可能性がある（失効ではない）。worker の startup diagnostic の allowlist に drift を 1 行足す（worker protocol の内部。IPC 契約は変えない）。NIR-1 の委任の「worker／owner の技術判断」に当たる。
- 案 LP-B2：drift による prepare 失敗を backoff に数えない（`BindingLost` と同じ扱い）。trace の 3 件は直接減らない。
- **案 LP-B3（proof の定義の変更。推奨しない）**：登録の identity を B の入力に絞る。漏れると古い proof で query する。`scope-storage-authority` と C-query の registration の契約の改訂が要り、委任の外。
- 分岐が `read_seal` が None（consumer freshness を含む製品の述語と、harness の startSeal〔`dirty_cache_flag` だけ〕の差）だった場合は別の問題で、X1/3 の Delta の範囲に入るかの判定が要る（確認が要る見込み）。

### 3.2 LP-C：child の合流の無効化（4 件。traceIndex 95・160・178・190）

- 確認済み：child は `graph-ready` の通知で始まり、Native の cache から `cached` で渡った（worker の Graph は届いていた）。R＋IR は表示された。Graph だけが Main の `graph_continue` の後段で `invalidated`。B は generation 1・clean、Chronicle の generation は child の間に変わっていない。
- 強い相関：child の begin の `firstSnapshotElapsedMs` が 4 件だけ 3.85〜7.02 ms（成功 181 件は最大 3.66 ms）。4/4 対 0/181。**因果の向きは未確認**（同じ background 処理が「遅れ」と「無効化」の両方を起こしている、と読むのが自然）。
- `invalidated` を返し得る Main の分岐が 6 つあり（lease、edge epoch、`current_operation`〔Chronicle に束縛された IR batch の再検証を含む〕、requalification の Dropped、requalification の Err、最後の `current_request`）、**どれかは受領書から決まらない**。意図した挙動か過剰かも未判定。
- 案（分岐の確定が先）：
  - LP-C1：requalification の current 性を B の material に限る（X1-5 (a)-1b と同じ考え方）。requalification の規則（CP-3a の K1b、DR-CP3A-27／29）と `typed-revision-material` に触れる。**契約の範囲の確認が要る見込み**。
  - LP-C2：Chronicle に束縛された batch の再検証が、IR の結果を変えない変化で false になっているなら、判定を IR の material の変化に絞る。exact R（DSN §3.1）を崩さない証明が要る。契約の確認が要る見込み。
  - LP-C3（上流）：child の begin の時点で connection を持つ background の処理を特定し、`graph-ready` の follow-up の短い窓（W_f 100 ms）と重ならないよう順序付ける。lifecycle／owner の技術判断の範囲。
- 無効化が**意図した挙動**（Chronicle が実際に変わって IR が古くなった）だった場合は、Graph を止めるのが正しい。その場合は「失効」の分類の側の問題（IR 側との揃え方）になり、製品を変えない。診断で決める。

## 4. 順序と手順

1. **LP-A1 を先に**：確度が最も高く、renderer だけで、契約に触れない。実装 → hook の試験 → 独立コードレビュー → PR。
2. **診断（LP-D）**：eval build（`nir1-graph-eval` feature。製品 build に symbol も文字列も無い）に、(a) worker の登録の `Ok(false)` の分岐（drift／seal None／未完了）、(b) `await_request` の `Invalidated` の出所、(c) Main の commit の時刻と、child の begin の時点で connection を持つ処理、を記録する計装を足し、dev run（台帳なし、正式の測定に数えない）で LP-B・LP-C の分岐を決める。静かなマシンが要る（race の再現のため）。
3. **LP-B1／LP-C の修正**を、診断の結果に従って。契約の改訂が要るもの（LP-B3、LP-C1、LP-C2）は、新しい draftRef としてユーザーに確認するまで実装しない。
4. **新しい候補での再測定**：製品を変えるので候補の commit が変わる。台帳の key は（候補の commit、S4 の commit、run の種類）なので、新しい候補は新しい key で始められる見込み。**S4 を凍結し直さずに再測定できるか、観測の後の再測定として何を開示するかは、未確認**（S2 の limits、DR-CP4-S4-6／S4-7 の運用条件を確かめる。結論が 5 回目の S4 の凍結なら、DR-CP4-S4-6 によりユーザーの確認が要る）。再測定の前に、閾値・Gold・読み・harness を変えていないことを DR に書く。
5. 再測定の結果が物差しを超えたまま、または別の失効が現れた場合は、HOLD のまま次の設計に戻る（緩和には進まない）。

## 5. 採らない案（緩和にあたる。列挙のみ）

結果を見た後の読みの変更は閾値の緩和にあたり、ユーザーの明示の判断が要る。この設計では推奨しない。

- 取り消された親を Q から除く（DR-CP4-V-3 の (C)）。
- 最初に begin した再 query を親にする（Q の定義の変更。DR-CP4-V-3 の (R)）。
- `cancelledBeforeBegin` を失効 (i) から外す、または U に入れる読み。
- `parent-ticket-registration-unavailable`／`child-join-invalidated` を失効に数えない（DR-CP4-K64-5 の (B)）、registration-unavailable を「その他」に分類し直す。
- harness が child の Graph の無効化を見たときにもう 1 回 child を出す、または次の操作の前に `index-ready` を待つ。
- D′ の held query の期限や W_f／T_late を延ばす（K6/4 の値の変更）。
- 本文だけの保存で Chronicle の index を dirty にしない・`index-ready` を出さない（Raw／IR は本文に依存するので正しさの変更。X1-5 は Graph(B) の dirty だけを外した）。

## 6. 判断の分担

- **integrator の技術判断（委任の範囲）**：LP-A1 の実装の形、LP-B1 の再試行の形と回数、診断の計装の項目、試験の形。
- **ユーザーの確認が要る点**：①この設計の方向（LP-A1 → 診断 → LP-B／C の順）と、実装・診断 run の着手。②再測定の手続き（S4 の扱い。§4 の 4）。③契約の改訂が要る案（LP-B3、LP-C1、LP-C2）を採る場合。④診断 run をいつ走らせるか（静かなマシン）。

## 7. 確かめた点・確かめられなかった点

確かめた点（integrator がコードで確認）：hook の `index-ready` の listener（`useNir1RelatedScenes.ts:147-150`）と cleanup の abort（`:355-358` 付近）、fetch の `cancelled` の返却位置と begin の呼出し、dense の結果が begin の応答から来ること、worker の登録の拒否（`nir1-c-query-worker.rs:250`、`nir1_graph_product.rs:2786`、`nir1_graph.rs:686` の drift 判定）、台帳の key の構成。K6/4 draft の F4／X7 の文言（`nir1-final-request-eval-proposal-4-draft.md:142,155`）の存在。

確かめられなかった点：
1. 通知→呼出しが 3.4〜4.5 ms に揃う理由（仮説：build の publish が renderer の `db_execute` を一時的に止める）。通知と timer の発火のどちらが先か。LP-A1 の判定はどちらの順でも同じ。
2. 通知の遅れが 250 ms の再試行 1 回分にあたるか。
3. LP-B の拒否の分岐、LP-C の `Invalidated` の出所と、意図か過剰か。
4. 製品の `read_seal` と harness の startSeal の差が実際に開いたか。
5. LP-A1 を入れた後の実際の件数（再測定が要る）。
6. K6/2・K6/4 の draft と dsn に `index-ready` を固定した文言が無いこと（調査 A の grep の範囲。網羅は独立レビューで）。
