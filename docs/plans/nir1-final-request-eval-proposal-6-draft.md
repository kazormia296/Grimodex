# NIR-1 最終 request 評価の契約提案 proposal/6（draft）: Graph の評価の手順の、定常状態の最初の表示（first-render）の数え方を R1 の下で明文にする（K6/5 の行の改訂）

Status: draft／未確認（改訂 1）。確認後はこの bytes の SHA-256 を台帳に記録し、本文は編集しない

## あなたが決めること（3 行）

- CP-4 の Graph の評価で、定常状態の窓内に Graph を受けた親（first-render の候補）について、K6/2 の手順 3 の最終文の「開始時に READY でなかった sample は窓外」を、R1（slot を `empty` にする前提）の下で「R1 を満たし、その sample のための準備が 1 回だけ行われた」と読み替える（R-6）。follow-up の数え方は変えない。
- 同じ文の鮮度の印の句を案 (ii′) で読む: stamp が `fresh` の親に加え、S0 が読めなかった（`stamp0-missing`）親は、worker の drift の検査と返却時の再検証（②）を通ったことを条件に数える。S1 だけが読めなかった（`unavailable`）親は数えず、不一致（`stale`）は `[artifact]`（R-7）。どちらも合格基準の緩和で、2026-11-07 にユーザーが選んだ（起案の指示で、確認ではない）。
- それ以外の K6/5 の行（D 40 ms、Hybrid p95 の上限 94.2 ms〔B 54.2 ms〕、T_late 100 ms、W_f 100 ms、T_show 2 s、1%、失効の読み、F1〜F7・X1〜X13・R1〜R6・R8 の文面、R7 の既存の項目、Gold・fixture・trace の file）は変えない。first-render に数える条件に、狭める項目（「変える点」の 3 の FR-1〜FR-8）を足す。

## 冒頭の開示

- **正式 run s6r1 で起きたこと**（候補 master `a2309b95`、S4b `63bc9b90`、K6/5 の凍結 `07fc80ec`。記録は contracts の `docs/plans/nir1-cp4-records/s6-aggregation-s6r1/`、`quality-verdict-s6r1-1/`、訂正 `ce302ea1`）: harness の記録どおりの読みで、Gold の定常状態の pool の欠落が 163/270（許容 2）で HOLD。163 件はすべて、親の合流が D=40 ms の窓内に worker の Graph を受けた sample（`graph.outcome: graph-ready`、`joined: true`、再検証 passed〔推論〕、出所 `worker`、到着は Raw-ready の 20.8〜39.9 ms 後）で、子は出ていない。分類器はこれを first-render に数えず、follow-up も無いので F1 `parent-joined`（`followup.mjs:600-608`）で「表示されなかった」とした。表示 0/30 の variant は G-01/v1、G-03/base、G-06/base、G-08/base-usable、G-08/graph-recovered の 5 つ。
- **機構（コードで確かめた）**: 定常状態の first-render は `steadyStateInWindow`（`scripts/quality/nir1-graph-eval/join.mjs:113-120`）で決まり、窓内・出所 worker に加えて `startSlot.readyFresh === true` と `freshnessStamp.matched === true` を要る（`followup.mjs:485-490`）。(1) `readyFresh` は `kind == Ready && prepares_ready > LAST_CONSUMED_PREPARES_READY`（`electron/native/grimodex-node/src/nir1_graph_eval/mod.rs:446-453`）で、K6/4 の R1（K6/4:192）の下では構造的に false。D′ の製品は保留した query のために worker を準備してすぐ答え、READY を公開しない（`electron/native/grimodex-node/src/nir1_graph_product.rs:2376-2381`。以下この file を「product.rs」）。(2) stamp の S0 は製品の状態で、admit で wait 0 で読み（product.rs:2633-2636、`c_query_freshness.rs:10-29`）、読めなければ `stamp0-missing`。s6r1 の pool の 270 件のうち 267 件が `stamp0-missing`、3 件が `fresh`。したがって **D の値に関わらず、R1 の下では Gold の定常状態の first-render は数えられなかった**。D=10.84 ms では親が常に graph-late で follow-up で表示されたので表に出なかった（s5r6 も `notReadyAtStart` 30/30）。
- **R-6 は新しい規則である（言い過ぎの訂正）**: 文面は 2 つに食い違っていた。(甲) K6/2:695 の最終文、K6/4:52（first-render の可用性 ＝ K6/2 の (a) の窓内）、K6/4:127（「事実」: 手順の「新しい READY」は D′ で成り立たず、`steadyStateInWindow` は全 sample が窓外）、K6/4:299（H1。`steadyStateInWindow` は first-render の記録として残す）、DR-CP4-S1C1-8（`cp4-decisions.md:231`。`stamp0-missing` も窓内にしない）。(乙) K6/5 の変える点 5（K6/5:92）と K6/5-P1（K6/5:121）、K6/4-P2（K6/4:227）、K6/4:167（「K6/2 の手順の 5 のまま」。手順 3 に触れない）。R-6 は、K6/4 の変える点 4 から自動的に出る読みではなく、**この食い違いを解く新しい規則**である。また **K6/5:92 は「D′ の下では first-render は構造上 HOLD」を D=10.84 ms での観測によるものとし、D=40 ms で解けるとしたが、構造上の原因は R1 の下の `readyFresh` と stamp の条件で、D ではなかった**（K6/5 の起案の取り違え）。K6/5-P1 の試験（`followup.test.mjs:132-147`）と検出力の記録（contracts `3675c50e` の `k65-detection-2026-11-07/k64-k65-synthetic-detection-record.md:111`。枝 `claude/k65-harness`）は、R1 の下で起きない fixture（`test-support.mjs:73-74` の `startSlot: { readyFresh: true }`、stamp `fresh`）を使っていた。
- **緩和であること**: R-6 と R-7 は、どちらも /5 の harness の読み（と DR-CP4-S1C1-8）より窓内に数える側を広げる＝合格基準の緩和である（「緩和の一覧」）。
- **観測の後の改訂であること**: この draft は s6r1 の受領書・集計・品質判定と、Opus の独立検査・独立レビューの結果を見た後に起案・改訂した。K6/2:617、:620、K6/4 の変える点 16（K6/4:110）に従い、新しい draftRef（/6）で行い、ユーザーの確認を要し、/6 の凍結の後に始めた run だけで判定する。**s6r1 の受領書は /6 の判定に使わない**（この draft に書く s6r1 の値はすべて予告の参考値）。s6r1 は HOLD のまま記録する。
- **ユーザーの決定と選択（2026-11-07。どれも起案の指示で、確認ではない）**: contracts `user-confirmation-2026-11-07-s6r1-hold-k66.md`（`1e6ede44`。問 1「HOLD と記録して新版を起案」、問 2「契約の『子』の定義にそろえる」）と `user-confirmation-2026-11-07-k66-r6-stamp.md`（`e704f28f`。問 1「読み替える（推奨）」、問 2「取れない分は ② で数える・厳しい形（推奨）」＝案 (ii′)）。品質判定の G-08 の子は品質判定の事前登録 v2（別 file）で扱う。

## 緩和の一覧（と、足す狭める項目）

K6/5 の行より弱い読みになるのは次の 2 つで、ほかの物差し（D 40 ms、1%、W_f、T_late、T_show、lease、失効率の定義、Hybrid p95 の上限）は変えない。

| # | 緩和 | 旧 → 新 | 効く規則・判定 | 根拠 | 「変える点」 |
| - | ---- | ------- | -------------- | ---- | ------------ |
| R-6 | 準備の句の読み（first-render の候補だけ） | 「開始時に新しい READY」（R1 の下では常に偽）→「R1 を満たし、その sample のための準備が 1 回だけ行われ、その worker の答えである」 | 定常状態の first-render の窓内（K6/4:167、K6/4-P2）、first-render の窓外率（開示）、表示の可用性の欠落率 | ユーザーの選択（`e704f28f` の問 1） | 1 |
| R-7 | 鮮度の印の句（案 (ii′)） | stamp が `fresh` のときだけ（/5 の harness と DR-CP4-S1C1-8）→ `fresh` に加え、`stamp0-missing` も ② を条件に数える（`unavailable` と `stale` は数えない） | 同上 | ユーザーの選択（`e704f28f` の問 2） | 2 |

- R-7 は K6/2:695 の字義（「鮮度の stamp が一致しなかった sample」）には沿う。字義が窓外とするのは「一致しなかった」もので、比べられなかった（null）ものは書いていない。null を窓外にしたのは DR-CP4-S1C1-8（lane の判断記録）と /5 の harness の読みである。そのため、K6/2 の文に対しては新しい読みの明文化、DR-CP4-S1C1-8 と /5 の harness の読みに対しては緩和として載せる。
- 足す狭める項目（「変える点」の 3。ユーザーの確認の範囲に入る）: N-a first-render にも R1 を当てる（今の harness は first-render なら `followup.mjs:585` で返り、R1 の検査〔X10。:587-595〕を当てない）。N-b first-render にも owner の counter と Native の begin の記録の整合を求める（F2 と同じ形）。N-c first-render の Graph にも「Graph を持つ」（F6 と同じ単位。K6/4 の In-scope attack 11）を求める。N-d 記録の誤りの検出（窓内に合流した親の stamp が `stale`、`driftAtQuery` か `prepareFailures` の差分が 0 でない、のどれかなら `[artifact]` で止める。製品はこれらの場合に合流させないので、その形は記録の誤り）。

## 鮮度の印の句

### 字義と読みの比較

| 出所 | `fresh`（一致） | `stale`（不一致） | `stamp0-missing`（S0 なし） | `unavailable`（S0 あり、S1 なし） |
| ---- | --------------- | ----------------- | --------------------------- | ------------------------------- |
| K6/2:695 の字義（「鮮度の stamp が一致しなかった sample も…窓外」） | 窓内にしうる | 窓外 | 書いていない | 書いていない |
| DR-CP4-S1C1-8（`cp4-decisions.md:231`）と /5 の harness（`join.mjs:118` の `matched === true`） | 窓内にしうる | 窓外 | 窓外（`matched: null`） | 窓外（`matched: null`） |
| **/6（案 (ii′)。採用）** | 窓内にしうる | 製品は query を投げないので合流しない。合流した記録は `[artifact]` | ② を条件に窓内にしうる | 窓外（分母に残す） |

### stamp、②、LP-GATE が何を保証するか（コードで確かめた事実。製品 repo は origin/master `a2309b95`）

- **①stamp（S0／S1）**: S0 は `admit`（product.rs:2633。D′ では release の後の `build_worker` の中）で親の main connection の `ReadIdentity`（`read_identity.rs:10-16`）を wait 0 で読む。S1 は query の直前（`serve_query`、product.rs:2793）。両方あって違えば `Stale` で worker に query を投げない（:2797-2806）。片方でも無ければ `stamp_unavailable` を数えて query を続ける（:2808）。モジュールの注記は「Never an authority: the worker's own registration-drift check stays final」（`c_query_freshness.rs:1-2`）。評価 build の記録（`nir1_graph_eval/mod.rs:308-317`）は `fresh`／`stale`／`stamp0-missing`／`unavailable` で、S0 が無いときは S1 の結果を残さない。**stamp の一致が保証するのは、「admit から query の直前まで、親の connection から見て commit が無かった」ことの、sample ごとの Native の観測である**。`unavailable` は S0 の後に S1 が読めなかった場合で、読取中の commit を含みうる（`c_query_freshness.rs:10-13` の「a commit raced the observation」）ので、/6 は数えない。
- **②-1 worker の drift の検査**: worker は query の snapshot を開いた直後に `ReadIdentity` が registration の時と同じかを確かめ（`src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_graph.rs:1021-1026`）、B の seal を確かめ（:1029-1033）、query の後にもう一度 identity を比べる（:1131-1148）。違えば `RegistrationDrift`（`worker_frame.rs:614`）で unavailable になり（product.rs:2852-2864）、合流しない。準備の失敗も unavailable で合流しない（product.rs:2400-2406）。admit から registration までの commit は覆わないが、その場合 worker はその commit の後の状態で registration するので、答えが admit の時点より古くなることはない（コードの読み。実機では確かめていない）。
- **②-2 返却時の再検証**: 親の participant read で、seed と B の seal の世代、表示する各 Scene の代表 path（A3 と pin）を照合し、全体で all-or-nothing（`related_scenes_requalification.rs:1-19`、:192-210）。製品はこれを通った Graph だけを合流させる（`related_scenes/graph.rs:739-751`）。**harness の `revalidation: "passed"` は観測ではなく推論**で、`graph-ready` の outcome と整数の `edgeCount` から推す（`run-sample.mjs:154-170`、`k64-record.mjs:300-306`）。
- **LP-GATE**（`nir1_graph_commit_gate.rs:1-27`、product.rs:2290-2301）: 保留した query の window（S0 の前から合流まで）の間、背景の incremental Freshness の cycle を入れない。止めるのは Freshness だけで、ほかの commit（保存、maintenance）は止めない。Graph の owner が window を開けるのを `graph_wait` の上限（既定 100 ms。`nir1_graph_commit_gate.rs:39` の `GRAPH_SECTION_WAIT`）まで待ち、過ぎれば window なしで進む（drift の検査は残る）。window を開けたかどうかの sample ごとの記録は受領書に無い。したがって LP-GATE は stamp の代わりの観測にはならない。
- **比べた結論（コードの読み）**: 表示した Graph の現在性の範囲としては、②-1（registration から query の終わり）と ②-2（query の後から合流まで）が、stamp の覆う区間を、admit から registration までの区間を除いて覆い、その区間の commit は答えを古くしない。**保証の範囲は stamp の一致と同等かそれ以上と読める**。一方、**証拠の形は弱まる**: stamp は sample ごとの Native の観測だが、②-1 は「drift なら合流しない」という製品のコードの契約、②-2 の passed は harness の推論である。`driftAtQuery` と `prepareFailures` の差分 0 は、合流した親では製品のコード上必ず成り立つ（上の行）ので、追加の観測ではなく、**記録の誤りを見つける検査**（N-d）として置く。② の結果を評価の記録に出す作業は後続の lane（(ii-b)）とする。

### 決定と、検討して採らなかった案

- **採用: 案 (ii′)**（ユーザーの選択 `e704f28f` の問 2）。数える: `fresh`、② を条件にした `stamp0-missing`。数えない: `unavailable`（分母に残す。窓外）、stamp の記録が無い（null）親。`stale` で合流した記録は `[artifact]`。
- **後続の lane（(ii-b)）**: ②-1 の drift の検査の結果と ②-2 の再検証の結果（drop の理由を含む）を、評価 build の Native の記録として sample ごとに出す。Native（評価 feature）のコードの変更なので、この確認では行わない（批准 9）。入ったら、②-2 の推論を観測に替える狭める変更を、K6/4 の変える点 16 の手続き（狭める方向。手順のファイルの新しい版とレビュー）か新しい draftRef で行う。

| 案 | 中身 | 採らなかった理由 | s6r1 での参考値（予告。R-6 を当てた場合） |
| -- | ---- | ---------------- | ---------------------------------------- |
| (i) 句を残す | `fresh` だけを数える | 今の製品はこの経路で S0 をほとんど取れず（267/270）、窓内に合流する親が多いほど欠落が増え、HOLD が続く見込み。stamp は製品の設計で authority ではない | first-render 2、follow-up 107、欠落 161/270。表示 0 の variant 3 つ |
| (ii) `unavailable` も数える | `matched !== false` を数える | `unavailable` は読取中の commit を含みうるので、数えると「commit が無かった」ことの手掛かりを捨てる（ユーザーが厳しい形を選んだ） | s6r1 の pool に `unavailable` は無く、(ii′) と同じ |
| (iii) 分母から外す | `matched !== true` の sample を分母から外す | 「分母から除かず」（K6/2:695）と「分母を pool すること」を弱め、s6r1 の時点で事実上判定できない | pool 3、pool 0 の variant 6 つで HOLD |
| (iii′) 窓内の `stamp0-missing` だけ外す | 失敗になる sample だけを結果を見て外す | K6/2:617 の「分母から除く」攻撃と K6/4 の In-scope attack 5 に当たる | pool 109、pool 0 の variant 3 つで HOLD |
| (iv) 製品で stamp を取る | 製品の owner が S0 を確実に取れるようにする | 製品の変更で、この契約の外。D′ の準備の時間と、D-final（`owner.begin`〔`nir1_graph_dfinal.rs:325`〕を通り、busy の原因を owner の stamp の counter〔`stamp0_missing`＋`stamp_unavailable`。:298-312、:406-425〕で推す）の到達と busy の帰属に影響しうる | 出せない |

## ユーザーが批准すること

1 回の明示の承認で扱うのは次の 9 点と、各項目が指す節の記述である。範囲の正本はこの一覧で、台帳の `confirmedScope` はこの一覧を指すだけにする。

1. 行の内容: /6 の行は、/5 の行（/4 の行に /5 の「変える点」の 1〜7 を当てたもの）に、この draft の「変える点」の 1〜8 を当てたものとする。表にない /5 の行の記述は変えない。
2. 準備の句（「変える点」の 1、R-6）。first-render の候補だけに当て、follow-up の数え方（F1〜F7、X1〜X13）は変えない。
3. 鮮度の印の句（「変える点」の 2、R-7。案 (ii′)）と、(ii-b) を後続の lane とすること。
4. first-render の条件の明文と狭める項目（「変える点」の 3、FR-1〜FR-8、N-a〜N-d）と、K6/5 の変える点 5・K6/5-P1 の読み替え（「変える点」の 4）。
5. 開示、品質（窓内に合流したが first-render に数えない親の扱いを含む）、記録（「変える点」の 5〜7）。
6. 緩和の一覧（R-6、R-7）と、これらが合格基準の緩和に当たること。
7. 効力と事前登録の凍結（「変える点」の 8。K6/5 の批准 7 と同じ 2 段）: (i) は /6 の行のうち (ii) 以外のすべてで、この承認で確認される。(ii) は K6/2 の 614 行の Delta、620 行の末尾の Lane unlocked、621 行の受入れへの影響に /4・/5・/6 の読み替えを当てたもので、事前の確認にとどまる。/6 で判定する CP-4 の run と条件の判定に使う診断は、/6 の凍結の後に始めたものに限る。s6r1 を含む /6 の凍結の前の receipt は使わない。
8. 変えないもの: 「前書き」の「変えないもの」。
9. 許さないもの: この確認そのものによる製品のコードの変更（(ii-b) の評価 build の記録を含む）。/6 の後に first-render の条件を広げること（新しい draftRef でだけ行う）。D、Hybrid p95 の上限、T_late、W_f、T_show、1% の変更。Gold、G-case の fixture と setup（seed の pin を含む）、凍結済みの trace の file の変更。dev の予行で凍結の fixture を使うこと。新しい authority・保存先・送信先・製品の入口。Graph の公開（PUB-G）と Session C-1 の承認。条件の成立の判定そのもの。/5 の行と /6 の行を結果を見て選び分けること。s6r1 の受領書を /6 の行で読み直して判定に使うこと。依存する契約と、K6/2・K6/3 のほかの contractId の行（`nir1-final-request-packing-eval`、`g01-eval-revision`）と `nir1-l6-l9-contract-proposal/7` の行は確認しない。

注記（批准の対象ではない）: 2026-11-07 のユーザーの回答（`1e6ede44` の問 1・問 2、`e704f28f` の問 1・問 2）は起案の指示と選択で、確認文ではない。FR-1〜FR-8 の書き分け、N-a〜N-d、harness の表、dev の予行の形は、起案者が integrator の指示と独立レビューを受けて置いたもので、ユーザーの選択を経ていない。

## 前書き

| 項目 | 値 |
| ---- | -- |
| draftRef | `nir1-final-request-eval-proposal/6` |
| contractId | `graph-eval-procedure`（K6/2 の条件付きの行、K6/4・K6/5 の行と同じ） |
| 版 | 改訂 1（2026-11-07）。下の「改訂の履歴」 |
| 起案日と基点 | 2026-11-07。製品 repo は origin/master `a2309b95`（#827。候補の worktree `cp4-formal-k65` と同じ commit）で確かめた。契約の bytes は `claude/nir1-contracts`（`e704f28f`）の worktree で読んだ。K6/5 の SHA-256 `1ad1088498e43dc3cd0deb1b7d74f18396eb3c07d4bd3834a8787de30ecd24a7`、K6/4 の `d205b35f71da6db3fe94ae881e1e500941090a8261b95343a3a50def5f6323c3`、K6/2 の `4ccca08314c022fd969308fa969e6fcb3e2c439fe12757bfec0e901b905676f8` は contracts で再計算し、`k65-freeze-record.md` と K6/5 の前書きの値と一致した。以下「K6/5:n」「K6/4:n」「K6/2:n」はそれぞれの draft の行 |
| baseline | `nir1-final-request-eval-proposal/5#graph-eval-procedure`（2026-11-07 に確認。凍結は `07fc80ec`） |
| 前提 | 候補は K6/4 の批准 5 の (a)〜(c) と K6/5 の変える点 6 を満たす。定常状態の sample の前提は K6/4 の R1 |
| 変えないもの | K6/5 の「変えないもの」（K6/5:63）と、K6/5 の「変える点」の 1〜7 の値と読み（D 40 ms、Hybrid p95 の上限 94.2 ms、B 54.2 ms、T_late 100 ms）。W_f 100 ms、T_show 2 s、1%、失効率の定義と物差し、F1〜F7、X1〜X13、R1〜R6・R8 の文面、R7 の既存の項目（R7 には項目を足すだけ。「変える点」の 7）、K6/4-P1〜P3、K6/4-N1〜N40、K6/5-N1〜N4、技術点 1〜3、批准 5 の候補の限定、批准 12 の製品の変更の要件、K6/4 の「品質」の文（K6/4:171）。(b)（実際の操作の trace）の規則（K6/2:715-737、K6/4 の変える点 15。trace の first-render は K6/2 の規則 2 のままで、`readyFresh` と stamp を要らない）。K6/2 の規則 4 の区分（K6/2 の読みの記録。開示: この区分は `readyFresh` を使う〔`availability.mjs:557-563`〕ので、R1 の下では graph-late がすべて「開始時に READY でない」になり、s6r1 の browsing の「freshness 174（`graph-late:stale-start`）」は実際の鮮度の問題を意味しない呼び名である。判定は K6/4 の読みで行うので、この draft では変えない）。K6/2 の品質の手順 8 の K6/2 の読み。Gold、G-case の fixture と setup、trace の file。K6/2、K6/4、K6/5 の bytes |

### 改訂の履歴

| 版 | 日付 | 中身 |
| -- | ---- | ---- |
| 初版 | 2026-11-07 | 最初の起案（contracts `02af2760`）。鮮度の印の句は 4 案を並べたまま |
| 改訂 1 | 2026-11-07 | ユーザーの選択（`e704f28f`: R-6 を緩和として認める、対象は first-render の候補だけ。鮮度の印の句は案 (ii′)）と、Opus の独立レビュー（P1×5、P2×11、P3）を反映。主な直し: R-6 を first-render の候補に限った（follow-up の子の begin は `["pending","cached"]` で、当てると F1〜F7 と矛盾した）。準備の 1 回は owner の `preparesStarted`・`preparesReady` の差分で確かめる（`deferredReleased` は release の数で準備ではない）。dev の予行を凍結の fixture でなく、R1 の下の非凍結の dev fixture にした（`admitDevPreview` と E-7 と両立させる）。予行の止める条件を「全件で不成立」に直した。窓内に合流したが first-render に数えない親は品質で K6/4 の字義どおり FAIL と明記した。「新しい規則ではない」を撤回し、K6/5:92 の取り違えを開示した。`driftAtQuery`・`prepareFailures` は記録の誤りの検査と書き直した。字義の表、LP-GATE、採らなかった案の表、harness の表の誤り（`outcome.mjs`・`availability.mjs` の import）、引用の誤りを直した。**レビューの依頼には起案者の要約が含まれていて、完全な盲検ではなかった**（integrator の記録による） |

## 引き継ぐもの

1. /5 の行の内容を baseline とし、この draft の「変える点」の表を当てたものを /6 の行の内容とする。番号は「/6 の変える点 n」と呼ぶ。
2. /5 の行との関係: /6 の確認の後、CP-4 の判定は /6 の行で行う。/5 の行と凍結（`07fc80ec`）は履歴として残す。/5 の下の receipt（s6r1）は、その時点の候補の記録として有効なまま（HOLD）で、/6 の判定に使わない。/6 の確認の後は /5 の行で新しい判定をしない。
3. 事前登録: /5 の凍結の記録は残す。/6 の凍結は別の新しい commit で行う。/5 の凍結の後に起案者が見た観測: s6r1 の正式 run の受領書（Gold 13、parity 12、negative 3、trace 2、SP-P4、G-01 の診断）、S6 の集計（訂正 `ce302ea1` を含む）、品質判定、Opus の独立検査の結論、この draft の初版への Opus の独立レビュー、起案者が Gold の受領書から数えた stamp・D′ の counter・`startSlot.preparesReady` の連続の差の内訳。**この draft の規則は、すべてこれらを見た後に選ばれた**。どの観測も /6 の判定に使える診断ではなく、予告として扱う。

## 変える点（/5 の行との関係）

次の表の文だけを置き換える（または読み替える）。表にない記述は変えない。**1 と 2 は /5 の行（の harness の読み）より弱い読み**（R-6、R-7）。3 は狭める防御、4 は 1〜3 に伴う読み、5〜7 は開示・品質・記録、8 は事前登録の扱い。

| n | 箇所 | 旧（要旨） | 新 | 理由 |
| - | ---- | ---------- | -- | ---- |
| 1 | 準備の句: K6/2:695 の最終文「開始時に READY でなかった sample …も、分母から除かず窓外に数える」を、定常状態の first-render の候補（親の合流が D の窓内に結果を受けた sample）に当てる箇所 | 開始時に slot が新しい READY でなかった sample は窓外。harness は `startSlot.readyFresh === true` を求める | first-render の候補について、「開始時に READY でなかった sample」は次のどれかに当たる sample と読む: (a) R1 の (1)〜(4) を満たさなかった（`reachedQuiet` が true でない、または R1 の 4 項目を記録から計算し直した値が自己申告と合わない）。(b) その sample のための準備が 1 回だけ行われ、その worker が答えたことが確かめられない: 親の Native の begin の記録がちょうど `["pending"]` でない、`startSlot.kind` が `empty` でない、その sample の owner の counter の差分（`dPrimeCounters`。(afterRelease か atEnd)−before。`k64-record.mjs:413-417`、:457-459）が `preparesStarted` 1・`preparesReady` 1・`deferredReleased` 1・`staleReadyRetired` 0 でない。(c) 次の sample があるのに、`startSlot.preparesReady` の差（次 − この）が 1 でない（counter の差分と食い違う記録は数えず、開示する）。これらは分母から除かず、first-render に数えない。`readyFresh` は条件に使わず、開示（`notReadyAtStart`）にだけ残す。**follow-up の数え方（F1〜F7、X1〜X13、X10 の R1）は変えない**（follow-up の sample の begin は `["pending","cached"]` で〔`followup.mjs:701-705` の F2〕、(b) を当てない） | 前の準備の残りや cache の結果ではなく、その sample のために 1 回だけ準備した worker の答えだけを数える、という K6/2 の目的を D′ の観測できる形で保つ（R-6。ユーザーの選択） |
| 2 | 鮮度の印の句: K6/2:695 の最終文「鮮度の stamp が一致しなかった sample も、分母から除かず窓外に数える」を first-render の候補に当てる箇所。DR-CP4-S1C1-8（lane の判断記録） | stamp が `fresh`（`matched: true`）でない親は窓外 | 案 (ii′): first-render の候補の stamp について、(1) `fresh` は数えうる。(2) `stamp0-missing` は、② を通ったことを条件に数えうる。② を通ったとは、親の Graph の ticket が `available` で宣言が `used`、合流の outcome が `graph-ready` で `joined`、窓内、`revalidation: "passed"`（推論）で整数の `edgeCount` があること（製品は drift で unavailable にし、再検証を通った Graph だけを合流させる）。(3) `unavailable` は数えない（窓外。分母に残す）。(4) stamp の記録が無い（null）親は数えない。(5) `stale` で合流した記録は `[artifact]`（N-d） | ユーザーの選択（R-7） |
| 3 | 定常状態の first-render の窓内の定義: K6/4:167、K6/4:52（用語）、K6/4-P2（:227）、K6/2:705（手順 5）を定常状態に当てる箇所、K6/2:708 | 窓内・worker 由来（harness はさらに `readyFresh` と stamp の一致） | 定常状態の sample を first-render の窓内に数えるのは、次をすべて満たすときだけ: FR-1 親の合流が D（40 ms）の窓内に、返却時の再検証を通った worker の結果を受けた（`classifyJoin` の窓内。境界の扱いは変えない。出所が `Cached` なら数えない〔K6/4-N39〕）。FR-2 1 の (a)〜(c) に当たらない。FR-3 2 の (1) か (2) に当たる（stamp の記録が無い親は数えない）。FR-4（N-b）owner の counter の差分が、`counters.after`（atEnd − before）と `countersAfterRelease`（afterRelease − before）の両方で `begins` 1・`lateCached` 0・`cacheHits` 0（`followup.mjs:670-697` の F2 と同じ読み方）で、R2 の終わりの cache が空。FR-5 親の宣言が `used`、`publishCount` 1、親の窓（`graphWindowMs`）が D と一致（K6/5 の変える点 6）。FR-6 sample の終わり（R4）までに、`graph-ready` の通知が無く、origin を問わず `followUp.child` が無く、`followUp.requeries[]`（DR-CP4-C7。`followup.mjs:456-465`）が空で、親の IR の再試行の timer（`followUp.parent.irRetryTimer`）が動いていない（K6/4-P2 の「子は出ない」を観測で確かめる。あれば数えず、記録の異常として開示）。FR-7（N-c）「Graph を持つ」: 再検証を通った Graph の edge が 1 件以上あり、事前登録した期待寄与の材料から寄与がある（F6 と同じ単位。DR-CP4-F-6 の `material-revision`）。親の寄与の記録が無い親は数えない（照合できたとしない）。FR-8（N-d）`stale` で合流した記録、`dPrimeCounters` の `driftAtQuery` か `prepareFailures` が 0 でない記録は `[artifact]` で止める。親の表示に D の後の Graph が混ざった、または親が 2 回以上公開した場合は、first-render の成否と別に FAIL（K6/4-N1。変えない） | 1 と 2 を当てた条件を 1 か所に書き、R1 と同じ水準の狭める防御を first-render にも当てる |
| 4 | K6/5 の変える点 5（K6/5:92）の「その sample は K6/4-P2 で first-render の窓内に数え、子は出ない（規則は変えない）」と、同じ行の「D′ の下では first-render は構造上 HOLD」を D=10.84 ms の観測とした記述。K6/5-P1（K6/5:121）。K6/4:299（H1）の「`steadyStateInWindow` は first-render の記録として残し」 | D=40 ms の窓内に親が Graph を受けた sample を数える（R1 との関係は書かれていない） | 「K6/4-P2 で first-render の窓内に数える」sample は 3 の FR-1〜FR-8 を満たす sample と読む。構造上の HOLD の原因は D ではなく R1 の下の `readyFresh` と stamp の条件だった（冒頭の開示）。K6/5-P1 は K6/6-P1 で置き換える。H1 の `steadyStateInWindow` は、K6/2 の字義の関数（K6/4 の候補の限定を満たさない候補の判定と開示に使う）と、/6 の first-render の関数に分ける | (甲)(乙) の食い違いを解く |
| 5 | first-render の窓外率（K6/4 の変える点 1。開示） | K6/2 の字義の条件で求める | 3 の条件で求めて書く。あわせて、K6/2 の字義の条件での件数（`notReadyAtStart`、`stampMismatch`、`stampWithoutComparison`、stamp の result の内訳）、1 の (a)〜(c) と 3 の FR-3〜FR-7 のどれで数えられなかったかの件数、境界の食い違い（`classifyJoin` の `joinedLateWithinTolerance`）の件数を case ごとに書く（開示だけ） | どの条件で数えたかを結果を見て選ばせない |
| 6 | 品質（K6/4:171、K6/2:708） | 表示された sample の表示の結果で測る。表示されなかった sample は R+IR に混ざりなく戻ったことを確かめる | 文は変えない。first-render の表示の結果は親の合流の結果で、子と同じ形の寄与の記録（edge の Revision の照合）を取り Evidence の照合に使う。**窓内に合流したが first-render に数えない親（3 の条件のどれかを欠く）は「表示されなかった sample」で、その一覧は Graph を含み R+IR と違うので、K6/4:171 の字義どおり品質は FAIL とする（`outcome.mjs:399-407` と同じ。新しい緩和を足さない）** | K6/4 の文を保つ |
| 7 | R7（query ごとの記録） | （既存の項目） | 既存の項目を変えずに足す: `startSlot.kind` と `preparesReady`、親の Native の begin の記録の並び、`dPrimeCounters` の差分（既存の 7 つに `preparesStarted`・`preparesReady` を足す）、stamp の result と `matched`、sample の終わりまでの通知・子・`requeries[]`・IR の再試行の timer、親の寄与の記録、3 の判定の内訳（FR-1〜FR-8 のどれを満たしたか） | 3 の判定を記録から計算し直せるようにする |
| 8 | 事前登録の凍結と効力の時点: K6/5 の変える点 7（K6/5:94） | 「この file」は /5 の bytes | 「この file」は /6 の bytes。/6 で判定する CP-4 の run と条件の判定に使う診断は、/6 の凍結の後に始めたものに限り、receipt の先頭に /6 の凍結の commit と SHA-256 を書く（/5 と /4 の凍結の commit と SHA-256 も併せて書く）。/6 の凍結の前の観測（s6r1 の受領書を含む）は予告で、/6 の判定に使わない | /5 の変える点 7 と同じ形 |

## 本文に入れないもの（手順の側で扱うもの）と理由

| 事項 | 本文に入れるか | 理由 |
| ---- | -------------- | ---- |
| 品質判定の G-08 の子の扱い（`1e6ede44` の問 2） | **入れない**。品質判定の事前登録 v2（`docs/plans/nir1-cp4-records/quality-verdict-prereg-v2-draft.md`）で扱う | 品質判定は手順外の補助の記録（DR-CP4-QV-0・QV-1）。K6/4:52 の「子」の定義は /6 で変えない。`index-ready` の再 query は K6/4 の X7 で follow-up に数えず、この行の可用性の判定にもともと入らない |
| DR-CP4-S1C1-8 の改訂 | 入れない。/6 の確認の後に `cp4-decisions.md` に新しい DR を足す | lane の判断記録 |
| (ii-b)（② の結果の評価の記録） | 入れない。後続の lane | Native（評価 feature）の変更。この確認による製品のコードの変更を許さない（批准 9） |

## threat model（/5 の行への加算）

この draft は新しい外への通信、保存、authority、subprocess、背景の処理、async の lifecycle を加えない（評価の読みと記録の項目だけを変える）。

- In-scope attacks（加える）: 21. R1 を満たさない、または準備が 1 回だけと確かめられない親を first-render に数える。22. 前の sample の準備の残り（`staleReadyRetired` のあるもの、begin が 2 件以上のもの、`preparesReady` の差分が 1 でないもの）の結果を first-render に数える。23. stamp の結果によって数えるかを結果を見て選ぶ（2 で (ii′) に固定する）。24. `unavailable` の親を `stamp0-missing` と同じに数える。25. stamp が取れなかった sample のうち失敗になるものだけを分母から外す（(iii′)）。26. 寄与の空の Graph、期待寄与の材料からの寄与の無い Graph を first-render の成功と数える。27. 子・`requeries[]`・IR の再試行・`graph-ready` の通知が出た sample を first-render と数える。28. 準備の句と鮮度の印の句の試験を、R1 の下で起きない fixture（`readyFresh: true`、slot が `ready`）だけで済ませる（K6/5-P1 で起きた形）。29. R-6 の (b) を follow-up に当てて、F1〜F7 を満たす follow-up を落とす（または逆に、follow-up の条件で first-render を数える）。30. s6r1 の受領書、または dev の予行を /6 の判定に使う、/5 と /6 の行を結果を見て選び分ける。31. 窓内に合流したが first-render に数えない親を、品質で hold に留める（K6/4:171 の FAIL より弱い扱い）。
- Mandatory defenses（加える）: 「変える点」の 1〜3、5〜8。3 の条件は観測の前に /6 の凍結と手順のファイルの版で固定し、独立 reviewer のレビューを受ける。分類器は、R1 の下の現実の形の合成の記録（`startSlot: { kind: "empty", readyFresh: false }`、stamp が `fresh`・`stamp0-missing`・`unavailable`・`stale`・null のそれぞれ、`dPrimeCounters` と counter の差分つき）で受入れの K6/6-P・N を期待どおりに分けることを観測の前に示して記録する。**FR のどれかが全件で成立することは止める理由にしないが、その条件が空の検査でないことは、その条件だけを破った合成の負例（K6/6-N1〜N12）を分類器が落とすこと（検出力の記録）で示す**。
- **dev の予行（Mandatory defense）**: S4 の 7 回目の凍結の前に、D=40 ms の候補で、R1 の下の dev fixture（G-case の構造をまねた非凍結の fixture。凍結の G-case の fixture とその材料の写しは使わない。`admission.mjs:816-837` の `admitDevPreview` と `dev-fixture.mjs` の E-7 の防御のまま）で、定常状態の予行（preview。判定に使わない）を 1 回以上行い、3 の FR-1〜FR-8 と 1 の (a)〜(c) の各条件について、窓内に合流した親のうち満たした件数と満たさなかった件数を記録する。**窓内に合流した親が 1 件以上あるのに first-render が 0 件、または FR のどれかが窓内に合流した親の全件で不成立なら、凍結に進まず integrator に返す**（s6r1 の前にこの予行が無く、構造上数えられないことを見落とした）。Gold の G-case は正式の受入れの経路（`admitGraphCaseRun`）でだけ見る。予行の結果は予告で、/6 の判定に使わない。**予行が /6 の凍結の後に落ちた場合に取れる道は、新しい draftRef（/7）か、K6/4 の変える点 16 の狭める方向の変更だけ**（K6/4:110。/6 の条件を広げることはしない）。
- Acceptance implications（読み替え）: K6/5 の Acceptance implications のとおり。定常状態の first-render は「変える点」の 3 で読む。ほかは変えない。
- 残余（開示）: (1) ②-2 の passed は推論で、(ii-b) まで観測にならない。(2) 境界: s6r1 の窓内の 163 件のうち 8 件が Raw-ready の 39 ms 後より遅く、境界の許容は 0.01 ms（`constants.mjs:153` の `BOUNDARY_TOLERANCE_MS`）。first-render を数えるようになると、境界の食い違い（renderer の時刻と製品の合流の判定の差）が欠落の件数に直接効く重みが増す。境界の扱いは変えず、件数を開示する（5）。

## 受入れ（/5 の行への加算）

番号は `K6/6-` を付ける。合成の記録の基は、s6r1 の受領書の実際の sample の形（R1 の下の値）にする（`test-support.mjs` の `readyFresh: true`・slot `ready` の fixture を基にしない）。

- K6/6-P1（K6/5-P1 を置き換える）: `startSlot.kind: empty`、`readyFresh: false`、R1 を満たし、begin が `["pending"]`、`dPrimeCounters` の差分が `preparesStarted` 1・`preparesReady` 1・`deferredReleased` 1・`staleReadyRetired` 0・`driftAtQuery` 0・`prepareFailures` 0、counter の差分 `begins` 1・`lateCached` 0・`cacheHits` 0（after と afterRelease の両方）、親が D=40 ms の窓内（Raw-ready の後 11、25、40 ms）に worker の結果を受けて `used`、通知・子・`requeries[]`・IR の再試行が無く、寄与がある sample は、stamp が `fresh` でも `stamp0-missing` でも first-render の窓内で、子は出ない。
- K6/6-P2: 同じ case に first-render と follow-up の sample があり、表示の結果が同じなら、品質を両方の表示の結果で測る。
- K6/6-P3: follow-up の sample（begin `["pending","cached"]`、F1〜F7 を満たす）は、R-6 の (b) を当てずに follow-up の成功に数える（s6r1 の follow-up 107 件の形）。
- K6/6-N1: R1 の `reachedQuiet: false`、または R1 の 4 項目の計算し直しが自己申告と合わない sample で親が窓内に合流した（数えない）。
- K6/6-N2: begin が `["pending"]` でない、`startSlot.kind` が `empty` でない、`staleReadyRetired` 1、`deferredReleased` 0、`preparesStarted` か `preparesReady` の差分が 1 でない、のどれかの窓内の親（数えない）。
- K6/6-N3: stamp が `unavailable` の窓内の親（数えない。分母に残る）。stamp の記録が null の窓内の親（数えない）。
- K6/6-N4: 窓内に合流した親の stamp が `stale`（`[artifact]` で止まる）。
- K6/6-N5: counter の差分が after か afterRelease で `lateCached` 1 以上か `cacheHits` 1 以上、または R2 の終わりに cache が残った sample の窓内の親（数えない）。
- K6/6-N6: 窓内に合流した親の後に `graph-ready` の通知、子（origin を問わない）、`requeries[]` の行、IR の再試行の timer のどれかがあった sample（数えず、開示）。
- K6/6-N7: 窓内に合流したが edge が 0 件、期待寄与の材料からの寄与が無い、または親の寄与の記録が無い親（数えない）。
- K6/6-N8: 窓内に合流した `stamp0-missing` の親だけを分母から外した receipt（(iii′)。拒否）。
- K6/6-N9: receipt の先頭に /6 の凍結の commit と SHA-256 が無い、または /6 の凍結の前に始めた run（s6r1 を含む）の receipt を /6 で判定した。
- K6/6-N10: 窓内に合流した親で `dPrimeCounters` の `driftAtQuery` か `prepareFailures` が 0 でない記録（記録の誤り。`[artifact]`）。
- K6/6-N11: 次の sample の `startSlot.preparesReady` との差が 1 でない窓内の親（counter の差分と食い違う。数えず、開示）。
- K6/6-N12: 窓内に合流したが 3 の条件のどれかを欠く親の一覧が R+IR と違うのに、品質を FAIL にしなかった判定（K6/4:171）。

## 範囲と他の lane への影響

| lane | 影響 |
| ---- | ---- |
| CP-4 の手順（S2 追補、S3、S4 の 7 回目の凍結） | harness の変更（下の表）、/6 の凍結の head の receipt への記録、K6/6-P・N の合成の記録による検出力の記録の取り直し、R1 の下の dev fixture での予行 |
| 品質判定（手順外の補助） | 事前登録 v2（別 file）。表示の判定が /6 の 3 に従い、窓内に合流したが数えない親は FAIL にそろえる |
| DR-CP4（lane の判断記録） | DR-CP4-S1C1-8 の「(a) では窓内にしない」の改訂（(ii′) に合わせる） |
| (ii-b) の lane（後続） | 評価 build の Native に、② の結果を sample ごとに出す記録を足す（製品のコードの変更。別の判断と独立レビュー） |
| 製品 | 影響しない |
| PUB-G／Session C-1 | 開示の項目（first-render の窓外率）の求め方が 3 になる。PUB-G の承認は置き換えない |
| parity、診断の負例（N2〜N4）、SP-P4、G-01 の診断 | 影響しない（parity は Graph を測らない。負例は `returnedSceneIds` で判定し、表示の判定を使わない〔`frozen-diagnostics.mjs:790-850`〕。SP-P4 と G-01 の診断は first-render の数え方を使わない） |
| DD-1、DP-H、K6/3、P の評価 | 影響しない |

### この draft が確認されたときに変わる harness の file（実装はしない。製品 repo の `a2309b95` の行）

| file | 変わる中身 | pin（S2 の `SOURCE_PINS`） |
| ---- | ---------- | --- |
| `scripts/quality/nir1-graph-eval/join.mjs` | `:113-120` の `steadyStateInWindow`（K6/2 の字義。`readyFresh`・`matched === true`）を別名（例: `k62SteadyStateInWindow`）で残し、/6 の first-render の関数を足す（または followup.mjs に置く）。注記（`:108-112`）を直す | `p1-harness-core`（`865a3e2b`。pin のし直し） |
| `scripts/quality/nir1-graph-eval/followup.mjs` | `:485-490` の定常状態の `firstRender` を 3 の FR-1〜FR-8 にする（R1 の検査〔`:587-595`〕を first-render の候補にも当てる、counter〔after と afterRelease〕・通知・子・`requeries[]`・IR の再試行・寄与の条件、N-d の `[artifact]`）。`:600-608` の F1 `parent-joined` は 3 を満たさない窓内の親の理由として残し、どの FR で落ちたかを detail に書く。follow-up の経路と trace の側は変えない | `k65-merge-followup`（`8489ae57`。pin のし直し） |
| `scripts/quality/nir1-graph-eval/outcome.mjs` | `:29` と `:323` の `steadyStateInWindow` の import を K6/2 の字義の別名に替える（`k62AvailableQuality` は K6/2 の読み）。`k64AvailableQuality`（`:370-`）は `classifyFollowUp` に従い、表示されない sample の FAIL（`:399-407`）は変えない | `p2p3-harness-admission`（pin のし直し） |
| `scripts/quality/nir1-graph-eval/availability.mjs` | `:71`・`:81` の import、`:283` の `entry.inWindow`（K6/2 の窓内）・`:296` の `qualityHold`（K6/2 の読み）と、/6 の first-render の件数を分けて持つ（K6/2 の窓内は開示、/6 の first-render は判定）。case ごとの開示に 1 の (a)〜(c)、FR ごとの件数、境界の食い違いの件数を足す（5）。`:557-563` の (b) の K6/2 の区分は変えない | `p1-harness-core`（pin のし直し） |
| `scripts/quality/nir1-graph-eval/run-sample.mjs` | `:361-375` の `windowOutCause`（preview の開示）の `not-ready-at-start` を、1 の (a)〜(c) の理由に置き換える。`:390-430` の `previewSummary`（`:402` の import を含む）も同じ | `p1-harness-core`（pin のし直し） |
| `scripts/quality/nir1-graph-eval/k64-record.mjs` | `:59-67` の `DPRIME_COUNTER_KEYS` に `preparesStarted`・`preparesReady` を足す（評価 build の JSON はすでに出している: `nir1_graph_eval/mod.rs:695-696`。Native の変更は要らない）。親の合流の結果について、子と同じ `contributionBasis`・`materialRevision` を記録する（FR-7。子は `:496-517` の `paths` から作る。親の答えから同じ形を取れるかは実装の時に確かめ、hook の消費者の観測に無ければ renderer の probe〔`renderer/cp4-k64-probe.tsx`〕に読取を足す）。R7 の追加の項目を写す | 実装の時に `harnessPinOf` で確かめる |
| `scripts/quality/nir1-graph-eval/constants.mjs`、`procedure-file.mjs`、`procedure/k64-procedure.v2.json` → v3（新規。値は v2 と同じ） | /6 の凍結の descriptor を足す。手順のファイルの `contract` を /6 に（値の key と値は変えない）。v2 を残して /6 の束縛を S2 にだけ置く形もありうる（実装の時に決める） | `k65-freeze-source`、`k65-harness-d40`（pin のし直し） |
| `scripts/quality/nir1-graph-eval/admission.mjs`、`frozen-k64-admission.mjs`、`receipt.mjs`、`frozen-diagnostics.mjs`、`diagnostic-runner.mjs` | `head.k66`（/6 の凍結）の読取と照合 | `k65-g01-e2e-admission`、`k65-harness-d40`、`k65-receipt-p95-head`、`k65-n2-n3-enforcement`（pin のし直し） |
| `scripts/quality/nir1-graph-eval/dev-fixture.mjs` と dev fixture（新規か既存の拡張） | R1 の下の dev の予行のために、G-case の構造をまねた非凍結の fixture（窓内に合流する親が出る大きさ）を用意する。凍結の fixture と材料の写しを拒む防御（E-7）は変えない | 実装の時に確かめる |
| `scripts/quality/nir1-graph/observation-prep.mjs` | `CONTRACTS` に /6 を別の key で足す（`CONTRACTS.k64` は trace の束縛のため K6/4 のまま）。`:473` の `K64_VALUES` は変えない | 凍結の検査そのもの |
| `scripts/quality/nir1-graph-eval/quality-verdict.mjs`、`quality-verdict-cli.mjs` | 品質判定の事前登録 v2 に合わせる（`:368-371` の表示されない sample を hold から fail に、G-08 の子の扱い） | pin の外（DR-CP4-QV-1） |
| `evals/nir1-graph/observation-prep.v1.json`（S2 追補） | `contracts` に /6、`userConfirmations` に /6、`k66Readings`（R-6、R-7、FR-1〜FR-8、dev の予行の記録、s6r1 を見た後の改訂であることとレビューが完全な盲検でなかったことの開示） | S4 が束縛 |
| `evals/nir1-graph/observation-prep-freeze.v1.json` | S4 の 7 回目の凍結 | — |
| 試験（`followup.test.mjs`、`join.test.mjs`、`availability.test.mjs`、`outcome.test.mjs`、`k64-record.test.mjs`、`test-support.mjs`、quality-verdict の試験） | K6/6-P1〜P3、K6/6-N1〜N12 の合成の例を R1 の下の現実の形で足す。`test-support.mjs` の既定の fixture は K6/2 の読みの試験に残し、/6 の試験には R1 の形の fixture を別に足す。K6/5-P1 の試験は K6/6-P1 に置き換える | 試験は pin の対象外 |
| 検出力の記録 | K6/6-P・N の合成の記録で取り直す（前回は contracts `3675c50e`） | — |
| 変えないもの | trace の file、`trace-record.mjs`、(b) の分類、T_late・W_f・T_show・D の定数と照合、Gold、凍結の fixture、`K64_VALUES` | — |

S4 が pin する harness の変更は、S4 の枝でだけ merge する（2026-11-07 の C7 #826 の前例）。

## 確かめられなかったこと

1. `stamp0-missing` がこの経路でほぼ全件になる原因（release の直後の admit で main connection を何が握っているか）。
2. ② が実機の G-case で stamp の一致と同じ件を落とすか（コードの読みだけ）。s6r1 の pool では `driftAtQuery` の差分は全件 0、`stale` の stamp は 0 件。(ii-b) の後に確かめられる。
3. 親の合流の結果の寄与の記録（FR-7）を今の hook の消費者の観測から取れるか（`k64-record.mjs:496-517` は子の `paths`）。取れなければ renderer の probe の読取を足す（harness の表）。dev の予行で検出される。
4. D=40 ms の G-case で、R-6・R-7 の下の first-render の率（s6r1 の値は予告。窓内に合流した 163 件では `startSlot.preparesReady` の差が 158 件で 1、各受領書の最後の sample の 5 件は次の sample が無く確かめられない。`preparesStarted`・`preparesReady` の差分は受領書に無い〔今の `DPRIME_COUNTER_KEYS` に無い〕）。
5. 改訂 1 の独立レビューはまだない。

（初版の未確認 4「`dPrimeCounters` が差分か」は閉じた: `k64-record.mjs:413-417`、:457-459 で (afterRelease か atEnd) − before の差分）

## 確認の扱い

- 確認は、台帳の Confirmation protocol に従い、`nir1-final-request-eval-proposal/6` と `graph-eval-procedure` を曖昧さなく特定するユーザーの明示の承認で行う。構造化質問なら、質問の文が draftRef、contractId、確認に出す版の SHA-256 を名指し、ちょうど 1 つの `draftRef#contractId` を示す。承認の効力は批准 7 の 2 段。
- 確認の質問の文には、(1) 緩和の一覧（R-6、R-7）、(2) 狭める項目（FR-1〜FR-8、N-a〜N-d）、(3) D・p95 の上限・T_late ほかの値と follow-up の数え方は変えないこと、(4) s6r1 は HOLD のままで、/6 の判定は /6 の凍結の後の run に限ること、(5) この改訂は s6r1 の観測の後に起案したこと、(6) ② の passed は推論で (ii-b) は後続の lane であること、を書く。
- 2026-11-07 のユーザーの回答（`1e6ede44`、`e704f28f`）、計画への同意、merge の指示、包括的な返答は、確認として扱わない。
- この draft は合格基準の緩和を含むので、続行計画 §12.1 の「重要な変更」にあたる。CP-4 は AGENTS.md の NIR-1 の残レーンに入っておらず、技術判断の事前委任も無い。

### 確認までの手順

1. 初版、Opus の独立レビュー、ユーザーの選択（`e704f28f`）、改訂 1（この file）。
2. 改訂 1 の独立レビュー（または最終 pass）の要否は integrator が決める（行う場合は read-only で、起案者の結論は渡さない）。確認に出す版の SHA-256 を確定する。
3. ユーザーの確認と確認の記録（`user-confirmation-2026-11-xx-k66-graph-eval-procedure.md`）。
4. contracts の凍結（`k66-freeze-record.md`）。台帳の更新（master への PR。byte 同一の取り込み）。
5. その後に、harness の実装、試験と検出力の記録、R1 の下の dev fixture での予行、S2 追補、S3 の独立レビュー、S4 の 7 回目の凍結、取り直しの正式 run。

## 確認後の記録（この draft の外で行う。台帳への取り込みの提案）

- 台帳の補足の見出し: 「2026-11-xx補足（K6/6）」。経緯に s6r1 の HOLD と機構、(甲)(乙) の食い違い、K6/5:92 の取り違え、ユーザーの決定と選択（`1e6ede44`、`e704f28f`）を書く。行 ID は `K6/6-1`。
- 確認台帳の行の案（/5 の行の下に足す。/5 の行は消さない）:

| contractId | draftRef | confirmedRef | confirmedScope | 備考 |
| ---------- | -------- | ------------ | -------------- | ---- |
| `graph-eval-procedure` | `nir1-final-request-eval-proposal/6` | `nir1-final-request-eval-proposal/6#graph-eval-procedure`（批准7の(i)についてだけ。(ii)は `preConfirmationRef`） | K6/6の範囲: draft冒頭の「ユーザーが批准すること」の1〜9（この一覧が範囲の正本）。/6の行の内容は、/5の行に/6の「変える点」の1〜8を当てたもの。定常状態のfirst-renderは、窓内に合流した親のうち、R1を満たし、そのsampleのための準備が1回だけ行われ（owner の `preparesStarted`・`preparesReady` の差分1ほか）、stampが `fresh`か、`stamp0-missing`で②（worker の drift の検査と返却時の再検証）を通り、counter・宣言・通知・子・寄与の条件（FR-1〜FR-8）を満たすものだけを数える。`unavailable`は数えず、`stale`は[artifact]。窓内に合流したが数えない親は品質でFAIL（K6/4:171）。**合格基準の緩和（2つ）**: 準備の句の読み（R-6。first-renderの候補だけ）、鮮度の印の句の(ii′)（R-7）。D 40 ms、Hybrid p95の上限94.2 ms、T_late 100 ms、W_f 100 ms、T_show 2 s、1%、失効の読み、F1〜F7、X1〜X13、R1〜R6・R8の文面、follow-upの数え方は/5のまま。(b)の規則、Gold、fixture、trace、(ii-b)の製品の記録、依存する契約、ほかのcontractIdの行、proposal/7の行は確認しない | (i)は確認済みで、記録の時点からCP-4の可用性と品質の判定に使う（/5の行に替わる。/5の行とs6r1のreceiptは履歴として残し、/5の行で新しい判定はしない）。/6の凍結の前に始めたrunは/6の判定に使わない。この確認は、Graphの製品公開、新しいauthority・保存先・送信先・製品の入口、製品のコードの変更を許可しない |

- 台帳の注の案: /5 の行の備考の末尾に「2026-11-xx 追記（K6/6）: /6 の確認の後、CP-4 の判定は /6 の行で行い、この行で新しい判定はしない。s6r1 の receipt は、この行の下の HOLD の記録として残る」。
- 確認されなければ、CP-4 は /5 の行のままで、R1 の下では定常状態の first-render が数えられず、D=40 ms の候補では (a) が構造上 HOLD に寄る。別の案は /7 で起案する。

## 確認文

contractId の選択: **`graph-eval-procedure`**（K6/2 の条件付きの行、K6/4・K6/5 の行と同じ）。

- 理由: (1) この差分は、/5 の行の定常状態の first-render の数え方の明文化と、それに連動する記録・開示の改訂で、新しい契約の主題ではない。(2) 新しい authority、保存先、送信先、製品の入口を加えない。(3) `nir1-final-request-packing-eval`（K6/3 の行）の内容に触れない。(4) 確認は contractId ごとの 1 回の承認。

承認の例（固定の文でなくてよい）:

- I confirm draftRef nir1-final-request-eval-proposal/6 for contractId graph-eval-procedure.
