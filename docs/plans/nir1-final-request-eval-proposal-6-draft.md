# NIR-1 最終 request 評価の契約提案 proposal/6（draft）: Graph の評価の手順の、定常状態の最初の表示（first-render）の数え方を R1 の下で明文にする（K6/5 の行の改訂）

Status: draft／未確認（改訂 2）。確認後はこの bytes の SHA-256 を台帳に記録し、本文は編集しない

## あなたが決めること（3 行）

- CP-4 の定常状態で、窓内に Graph を受けた親（first-render の候補）について、K6/2 の手順 3 の最終文の「開始時に READY でなかった sample は窓外」を、R1 の下で「R1 を満たし、その sample のための準備が 1 回だけ行われた」と読み替え（R-6）、鮮度の印の句を案 (ii′) で読む（`fresh` と、S0 が読めなかった `stamp0-missing` を数え、`unavailable` は数えず、`stale` は `[artifact]`。R-7）。どちらも合格基準の緩和で、follow-up の数え方は変えない。
- **帰結**: 窓内に合流して Graph が表示に寄与した親（`graph.joined`、宣言 `used`、`edgeCount` 1 以上）が first-render の条件を 1 つでも欠くと、Scene の一覧が R+IR と同じでも、その variant の品質は FAIL（可用性の 1% の許容は効かない）。`unavailable` の親もこれに当たる。R-7 の「② を条件に」は、今の harness では合流した親を独立に落とせない（実効は `unavailable` を除くだけ）。
- それ以外の K6/5 の行（D 40 ms、Hybrid p95 の上限 94.2 ms〔B 54.2 ms〕、T_late 100 ms、W_f 100 ms、T_show 2 s、1%、失効の読み、F1〜F7・X1〜X13・R1〜R6・R8 の文面、R7 の既存の項目、手順のファイル v2、Gold・fixture・trace の file）は変えない。

## 冒頭の開示

- **正式 run s6r1 で起きたこと**（候補 master `a2309b95`、S4b `63bc9b90`、K6/5 の凍結 `07fc80ec`。記録は contracts の `docs/plans/nir1-cp4-records/s6-aggregation-s6r1/`、`quality-verdict-s6r1-1/`、訂正 `ce302ea1`）: harness の記録どおりの読みで、Gold の定常状態の pool の欠落が 163/270（許容 2）で HOLD。163 件はすべて、親の合流が D=40 ms の窓内に worker の Graph を受けた sample（`graph.outcome: graph-ready`、`joined: true`、宣言 `used`、`edgeCount` 1〜3、到着は Raw-ready の 20.8〜39.9 ms 後）で、子は出ていない。分類器はこれを first-render に数えず、F1 `parent-joined`（`followup.mjs:600-608`）で「表示されなかった」とした。表示 0/30 の variant は G-01/v1、G-03/base、G-06/base、G-08/base-usable、G-08/graph-recovered の 5 つ。
- **機構（コードで確かめた）**: 定常状態の first-render は `steadyStateInWindow`（`scripts/quality/nir1-graph-eval/join.mjs:113-120`）で決まり、`startSlot.readyFresh === true` と `freshnessStamp.matched === true` を要る（`followup.mjs:485-490`）。(1) `readyFresh` は `kind == Ready && prepares_ready > LAST_CONSUMED_PREPARES_READY`（`electron/native/grimodex-node/src/nir1_graph_eval/mod.rs:446-453`）で、K6/4 の R1（K6/4:192）の下では構造的に false。D′ の製品は保留した query のために worker を準備してすぐ答え、READY を公開しない（`electron/native/grimodex-node/src/nir1_graph_product.rs:2376-2381`。以下「product.rs」）。(2) stamp の S0 は admit で wait 0 で読み（product.rs:2633-2636、`c_query_freshness.rs:10-29`）、読めなければ `stamp0-missing`。s6r1 の pool の 270 件のうち 267 件が `stamp0-missing`、3 件が `fresh`。したがって **D の値に関わらず、R1 の下では Gold の定常状態の first-render は数えられなかった**。
- **R-6 は新しい規則である**: 文面は 2 つに食い違っていた。(甲) K6/2:695 の最終文、K6/4:52、K6/4:127（「事実」）、K6/4:299（H1）、DR-CP4-S1C1-8（`cp4-decisions.md:231`）。(乙) K6/5 の変える点 5（K6/5:92）と K6/5-P1（K6/5:121）、K6/4-P2（K6/4:227）、K6/4:167。R-6 は **この食い違いを解く新しい規則**である。また **K6/5:92 は「D′ の下では first-render は構造上 HOLD」を D=10.84 ms での観測によるものとし、D=40 ms で解けるとしたが、構造上の原因は R1 の下の `readyFresh` と stamp の条件だった**（K6/5 の起案の取り違え）。K6/5-P1 の試験（`followup.test.mjs:132-147`）と検出力の記録（contracts `3675c50e` の `k65-detection-2026-11-07/k64-k65-synthetic-detection-record.md:111`。枝 `claude/k65-harness`）は、R1 の下で起きない fixture（`test-support.mjs:73-74`）を使っていた。
- **観測の後の改訂であること**: この draft は s6r1 の受領書・集計・品質判定、Opus の独立検査と独立レビュー（初版）、Sonnet の 4 観点のレビューと反証（改訂 1）を見た後に起案・改訂した。K6/2:617、:620、K6/4 の変える点 16（K6/4:110）に従い、新しい draftRef（/6）で行い、ユーザーの確認を要し、/6 の凍結の後に始めた run だけで判定する。**s6r1 の受領書は /6 の判定に使わない**（この draft の s6r1 の値はすべて予告の参考値）。s6r1 は HOLD のまま。
- **ユーザーの決定と選択（2026-11-07。どれも起案の指示で、確認ではない）**: `user-confirmation-2026-11-07-s6r1-hold-k66.md`（`1e6ede44`）と `user-confirmation-2026-11-07-k66-r6-stamp.md`（`e704f28f`。問 1「読み替える（推奨）」、問 2「取れない分は ② で数える・厳しい形（推奨）」＝案 (ii′)）。**問 2 の問いの文面は「取れなかった」を「接続が混んでいて読めなかった」と要約したが、S0 が None になる原因はそれより広い**（「鮮度の印の句」の節）。また問いの文面は「② を通った分を数える」と読めるが、今の harness では ② は合流した `stamp0-missing` の親を独立に落とさない（同節）。確認の質問でこの 2 点を示す。

## 緩和の一覧（と、足す狭める項目）

K6/5 の行より弱い読みになるのは次の 2 つで、ほかの物差しは変えない。

| # | 緩和 | 旧 → 新 | 効く規則・判定 | 根拠 | 「変える点」 |
| - | ---- | ------- | -------------- | ---- | ------------ |
| R-6 | 準備の句の読み（first-render の候補だけ） | 「開始時に新しい READY」（R1 の下では常に偽）→「R1 を満たし、その sample のための準備が 1 回だけ行われ、その worker の答えである」 | 定常状態の first-render の窓内（K6/4:167、K6/4-P2）、定常状態の first-render の窓外率（開示）、表示の可用性の欠落率、**品質**（表示された sample の範囲。K6/4:171） | `e704f28f` の問 1 | 1 |
| R-7 | 鮮度の印の句（案 (ii′)） | stamp が `fresh` のときだけ（/5 の harness と DR-CP4-S1C1-8）→ `fresh` と `stamp0-missing` を数える（`unavailable`・null は数えない） | 同上 | `e704f28f` の問 2 | 2 |

- **品質への効き方**: /5 の harness の読みでは、窓内に合流した親は「表示されなかった sample」で、Graph が表示に寄与していれば品質は FAIL（「変える点」の 6）。R-6・R-7 で数える範囲が広がると、その親は FAIL ではなく表示された sample として品質を測られる（s6r1 の参考: 窓内の 163 件。うち Scene の一覧が R+IR と違うのは G-01 30、G-02 6、G-08/base-usable 30、G-08/graph-recovered 30 の 96 件、同じで path の添付だけを足すのは G-03 30、G-05 7、G-06 30 の 67 件）。
- **R-7 の実効**: 「② を条件に」の ② のうち harness が見られる項目（ticket が `available`、宣言 `used`、`graph-ready`・`joined`、`revalidation: "passed"`、整数の `edgeCount`）は、窓内に合流した親なら必ず満たされる（`revalidation` は `graph-ready` と整数の `edgeCount` からの推論〔`run-sample.mjs:154-170`〕で、`joined` なのに passed でないものは `classifyJoin` が止める〔`join.mjs:76-79`〕。製品は unavailable の Graph を合流させない）。**したがって今の harness では ② は合流した `stamp0-missing` の親を落とさず、R-7 の実効は案 (ii)（`matched !== false`）から `unavailable` を除いたものと同じ**である。落とせるのは N-d の記録の誤りの検査だけ。② の判別力は (ii-b) の後に初めて生まれる。
- R-7 は K6/2:695 の字義（「一致しなかった sample」）には沿う（null は字義に書かれていない）。null を窓外にしたのは DR-CP4-S1C1-8 と /5 の harness の読みなので、それらに対する緩和として載せる。
- 足す狭める項目（「変える点」の 3）: N-a first-render にも R1 を当てる（今の harness は first-render なら `followup.mjs:585` で返り、R1 の検査〔:587-595〕を当てない）。N-b first-render にも owner の counter と Native の begin の記録の整合を求める。N-c first-render にも「Graph を持つ」（material-revision の寄与の記録、`unresolvedEdges` 0）を求める。N-d 記録の誤りの検出（`stale` で合流、`driftAtQuery` か `prepareFailures` の差分が 0 でない記録は `[artifact]`）。

## 鮮度の印の句

### 字義と読みの比較

| 出所 | `fresh`（一致） | `stale`（不一致） | `stamp0-missing`（S0 なし） | `unavailable`（S0 あり、S1 なし） |
| ---- | --------------- | ----------------- | --------------------------- | ------------------------------- |
| K6/2:695 の字義 | 窓内にしうる | 窓外 | 書いていない | 書いていない |
| DR-CP4-S1C1-8 と /5 の harness（`join.mjs:118`） | 窓内にしうる | 窓外 | 窓外 | 窓外 |
| **/6（案 (ii′)。採用）** | 窓内にしうる | 製品は query を投げず合流しない。合流した記録は `[artifact]` | 窓内にしうる（② の項目は実質無条件。上の「R-7 の実効」） | 窓外（分母に残す） |

### stamp、②、LP-GATE が何を保証するか（コードで確かめた事実。製品 repo は origin/master `a2309b95`）

- **①stamp（S0／S1）**: S0 は `admit`（product.rs:2633。D′ では release の後の `build_worker` の中）で、S1 は query の直前（product.rs:2793）で、同じ関数 `try_read_c_query_freshness_stamp` が親の main connection の `ReadIdentity` を wait 0 で読む。**None になる条件は S0 と S1 で同じで、接続が再利用できない、foreground の待ち手か maintenance の finalization の予約がある、mutex が握られている、transaction の中にある、読取中に commit が競合した、のどれか**（`c_query_freshness.rs:10-24`）。したがって `stamp0-missing` にも `unavailable` にも commit の競合が含まれうる。両方あって違えば `Stale` で query を投げない（product.rs:2797-2806）。片方でも無ければ query を続ける（:2808）。モジュールの注記は「Never an authority: the worker's own registration-drift check stays final」（`c_query_freshness.rs:1-2`）。評価 build の記録（`nir1_graph_eval/mod.rs:308-317`）は S0 が無いと S1 を見ずに `stamp0-missing` とするので、**`stamp0-missing` には S1 も読めなかった sample が含まれうる**（区別は (ii-b) で S1 の結果を記録して初めてできる）。stamp の一致が保証するのは、「admit から query の直前まで、親の connection から見て commit が無かった」ことの、sample ごとの Native の観測である。
- **②-1 worker の drift の検査**: query の snapshot を開いた直後と query の後に `ReadIdentity` を registration の時と比べ、B の seal も確かめる（`src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_graph.rs:1021-1033`、:1131-1148）。違えば `RegistrationDrift` で unavailable（product.rs:2852-2864）。準備の失敗も unavailable（product.rs:2400-2406）。admit から registration までの commit は覆わないが、その場合 worker はその commit の後の状態で registration するので、答えが admit の時点より古くなることはない（コードの読み。実機では確かめていない）。
- **②-2 返却時の再検証**: 親の participant read で、seed、B の seal の世代、表示する各 Scene の代表 path を照合し、all-or-nothing（`related_scenes_requalification.rs:1-19`、:192-210）。製品はこれを通った Graph だけを合流させる（`related_scenes/graph.rs:739-751`）。harness の `revalidation: "passed"` は推論（`run-sample.mjs:154-170`、`k64-record.mjs:300-306`）。
- **LP-GATE**（`nir1_graph_commit_gate.rs:1-27`、product.rs:2290-2301）: 保留した query の window の間、背景の incremental Freshness の cycle を入れない。止めるのは Freshness だけで、Graph の owner は `graph_wait`（既定 100 ms。`nir1_graph_commit_gate.rs:39`）まで待てなければ window なしで進む。window の有無の sample ごとの記録は受領書に無い。stamp の代わりの観測にはならない。
- **比べた結論（コードの読み）**: 表示した Graph の現在性の範囲としては、②-1 と ②-2 が stamp の覆う区間を、admit から registration までを除いて覆い、その区間の commit は答えを古くしない。**保証の範囲は stamp の一致と同等かそれ以上と読める**（実機では未確認）。一方、**証拠の形は弱まる**（②-1 は製品のコードの契約、②-2 は推論）。`stamp0-missing` を数える根拠はこのコードの読みである。**`unavailable` を数えないのは、安全上の差による区別ではなく、ユーザーの選択（厳しい形）である**（②-1・②-2 の論拠は `unavailable` にも同じように当たる）。

### 決定と、検討して採らなかった案

- **採用: 案 (ii′)**（`e704f28f` の問 2）。数える: `fresh`、`stamp0-missing`（② の項目つき。実効は上のとおり）。数えない: `unavailable`、stamp の記録が無い（null）親。`stale` で合流した記録は `[artifact]`。
- **後続の lane（(ii-b)）**: ②-1 の drift の検査と ②-2 の再検証の結果（drop の理由を含む）と、S0 が無いときの S1 の結果を、評価 build の Native の記録として sample ごとに出す。Native（評価 feature）のコードの変更なので、この確認では行わない（批准 9）。入ったら、推論を観測に替える狭める変更を、新しい draftRef か K6/4 の変える点 16 の手続きで行う。

| 案 | 中身 | 採らなかった理由 | s6r1 での参考値（予告。R-6 を当てた場合） |
| -- | ---- | ---------------- | ---------------------------------------- |
| **(ii′)（採用）** | `fresh` と `stamp0-missing` を数える | — | first-render 163、follow-up 107、欠落 0/270（許容 2）。**ただし FR-7（親の寄与の記録）と `preparesStarted`・`preparesReady` の差分は s6r1 の受領書に無く検証できない。FR-7 を字義どおり当てると first-render 0、欠落 163 で、163 件はすべて品質 FAIL（7 variant）** |
| (i) 句を残す | `fresh` だけを数える | S0 をほとんど取れず（267/270）、HOLD が続く見込み | first-render 2、follow-up 107、欠落 161/270 |
| (ii) `unavailable` も数える | `matched !== false` を数える | ユーザーが厳しい形を選んだ | s6r1 の pool に `unavailable` は無く、(ii′) と同じ |
| (iii) 分母から外す | `matched !== true` の sample を分母から外す | 「分母から除かず」と「分母を pool すること」を弱め、s6r1 の時点で事実上判定できない | pool 3、pool 0 の variant 6 つで HOLD |
| (iii′) 窓内の `stamp0-missing` だけ外す | 失敗になる sample だけを結果を見て外す | K6/2:617 と K6/4 の In-scope attack 5 に当たる | pool 109、pool 0 の variant 3 つで HOLD |
| (iv) 製品で stamp を取る | S0 を確実に取れるようにする | 製品の変更で契約の外。D′ の準備の時間と、D-final（`owner.begin`〔`nir1_graph_dfinal.rs:325`〕を通り、busy の原因を owner の `stamp0_missing`＋`stamp_unavailable` で推す。:298-312、:406-425）の到達と busy の帰属に影響しうる | 出せない |

## ユーザーが批准すること

1 回の明示の承認で扱うのは次の 9 点と、各項目が指す節の記述である。範囲の正本はこの一覧で、台帳の `confirmedScope` はこの一覧を指すだけにする。

1. 行の内容: /6 の行は、/5 の行に、この draft の「変える点」の 1〜8 を当てたものとする。表にない /5 の行の記述は変えない。
2. 準備の句（「変える点」の 1、R-6）。first-render の候補だけに当て、follow-up の数え方（F1〜F7、X1〜X13）は変えない。
3. 鮮度の印の句（「変える点」の 2、R-7。案 (ii′)）と、その実効（② は今の harness では合流した親を独立に落とさない）と、(ii-b) を後続の lane とすること。
4. first-render の条件の明文と狭める項目（「変える点」の 3、FR-1〜FR-8、N-a〜N-d）と、K6/4-P2・K6/5 の変える点 5・K6/5-P1 の読み替え（「変える点」の 3・4）。
5. 開示、品質（窓内に合流して Graph が表示に寄与したのに first-render の条件を欠く親は FAIL）、記録（「変える点」の 5〜7）。
6. 緩和の一覧（R-6、R-7。品質への効き方を含む）と、これらが合格基準の緩和に当たること。
7. 効力と事前登録の凍結（「変える点」の 8。K6/5 の批准 7 と同じ 2 段）: (i) は /6 の行のうち (ii) 以外のすべてで、この承認で確認される。(ii) は K6/2 の 614 行の Delta、620 行の末尾の Lane unlocked、621 行の受入れへの影響に /4・/5・/6 の読み替えを当てたもので、事前の確認にとどまる。/6 で判定する CP-4 の run と条件の判定に使う診断は、/6 の凍結の後に始めたものに限る。s6r1 を含む /6 の凍結の前の receipt は使わない。
8. 変えないもの: 「前書き」の「変えないもの」。
9. 許さないもの: この確認そのものによる製品のコードの変更（(ii-b) を含む）。/6 の後に first-render の条件を広げること（新しい draftRef でだけ行う）。D、Hybrid p95 の上限、T_late、W_f、T_show、1%、手順のファイルの値の変更。Gold、G-case の fixture と setup（seed の pin を含む）、凍結済みの trace の file の変更。dev の予行で凍結の fixture やその材料の写しを使うこと。新しい authority・保存先・送信先・製品の入口。Graph の公開（PUB-G）、local 送信の公開、activation UI の公開と Session C-1 の承認。条件の成立の判定そのもの。/5 の行と /6 の行を結果を見て選び分けること。s6r1 の受領書を /6 の行で読み直して判定に使うこと。依存する契約と、ほかの contractId の行（`nir1-final-request-packing-eval`、`g01-eval-revision`）と `nir1-l6-l9-contract-proposal/7` の行は確認しない。

注記（批准の対象ではない）: 2026-11-07 のユーザーの回答（`1e6ede44`、`e704f28f`）は起案の指示と選択で、確認文ではない。FR-1〜FR-8 の書き分け、N-a〜N-d、品質の FAIL の判定の条件、harness の表、dev の予行の形は、起案者が integrator の指示とレビューを受けて置いたもので、ユーザーの選択を経ていない。

## 前書き

| 項目 | 値 |
| ---- | -- |
| draftRef | `nir1-final-request-eval-proposal/6` |
| contractId | `graph-eval-procedure` |
| 版 | 改訂 2（2026-11-07）。下の「改訂の履歴」 |
| 起案日と基点 | 2026-11-07。製品 repo は origin/master `a2309b95`（#827。候補の worktree `cp4-formal-k65` と同じ commit）で確かめた。契約の bytes は `claude/nir1-contracts` の worktree で読んだ。K6/5 の SHA-256 `1ad1088498e43dc3cd0deb1b7d74f18396eb3c07d4bd3834a8787de30ecd24a7`、K6/4 の `d205b35f71da6db3fe94ae881e1e500941090a8261b95343a3a50def5f6323c3`、K6/2 の `4ccca08314c022fd969308fa969e6fcb3e2c439fe12757bfec0e901b905676f8` は、`k65-freeze-record.md` と K6/5 の前書きの値と一致した |
| baseline | `nir1-final-request-eval-proposal/5#graph-eval-procedure`（2026-11-07 に確認。凍結は `07fc80ec`） |
| 前提 | 候補は K6/4 の批准 5 の (a)〜(c) と K6/5 の変える点 6 を満たす。定常状態の sample の前提は K6/4 の R1 |
| 変えないもの | K6/5 の「変えないもの」（K6/5:63）と、K6/5 の「変える点」の 1〜4・6・7 の値と読み（D 40 ms、Hybrid p95 の上限 94.2 ms、B 54.2 ms、T_late 100 ms）。手順のファイル v2（`k64-procedure.v2.json`。下の「手順のファイルの扱い」）。W_f 100 ms、T_show 2 s、1%、失効率の定義と物差し、F1〜F7、X1〜X13、R1〜R6・R8 の文面、R7 の既存の項目、K6/4-P1・P3、K6/4-N1〜N40、K6/5-N1〜N4、技術点 1〜3、批准 5 の候補の限定、批准 12 の製品の変更の要件、K6/4 の「品質」の文（K6/4:171）。(b)（実際の操作の trace）の規則（K6/2:715-737、K6/4 の変える点 15。trace の first-render は K6/2 の規則 2 のままで、`readyFresh`・stamp・R-7 を当てない）。K6/2 の規則 4 の区分（開示: `readyFresh` を使う〔`availability.mjs:557-563`〕ので、R1 の下では graph-late がすべて「開始時に READY でない」になり、s6r1 の browsing の「freshness 174（`graph-late:stale-start`）」は実際の鮮度の問題を意味しない呼び名である）。K6/2 の品質の手順 8 の K6/2 の読み。Gold、G-case の fixture と setup、trace の file。K6/2、K6/4、K6/5 の bytes |
| 読み替えるもの（変えないものから外す） | K6/4-P2（K6/4:227）、K6/4:167・:52 の first-render の定義（「変える点」の 3）。K6/5 の変える点 5（K6/5:92）と K6/5-P1（K6/5:121）（「変える点」の 4。K6/5-P1 は K6/6-P1 で置き換える） |

### 手順のファイルの扱い（確認の前の決定）

手順のファイルは **v2 のまま**とし、v3 を作らない。理由: /6 は値（D、B、上限、T_late ほか）を変えず、変えるのは harness の code（S4 の pin で固定）が実装する数え方だけなので、手順のファイルの `contract` が /5 を指していても値の照合は正しい。v3 にすると `frozen-k64-admission.mjs:49` の `FORMAL_PROCEDURE_VERSION`、`quality-verdict-cli.mjs:40` の `PROCEDURE_FILE`、`observation-prep.mjs` の `k64-procedure-v2` の key（:452、:1681-1682、:4129）、`evals/nir1-graph/observation-prep-freeze.v1.json:24`、`observation-prep.v1.json`、`quality-manifest.yaml` に波及し、凍結の束縛が増える。/6 の束縛は、S2 の `contracts`・`userConfirmations`・`k66Readings` と、受領書の `head.k66` で置く。

### 改訂の履歴

| 版 | 日付 | 中身 |
| -- | ---- | ---- |
| 初版 | 2026-11-07 | 最初の起案（contracts `02af2760`）。鮮度の印の句は 4 案を並べたまま |
| 改訂 1 | 2026-11-07 | ユーザーの選択（`e704f28f`）と Opus の独立レビュー（P1×5、P2×11、P3）を反映（contracts `f2e0fe0f`）。レビューの依頼には起案者の要約が含まれ、完全な盲検ではなかった |
| 改訂 2 | 2026-11-07 | 改訂 1 への Sonnet の 4 観点のレビューと、各指摘の反証（確認された 30 件: P1 1、P2 12、P3 17。反証で落ちた 12 件は直していない）を反映。この方法も完全な盲検ではない（レビューの依頼は改訂 1 の bytes と起案の経緯を含む）。主な直し: (1) **P1**: 窓内に合流したが first-render に数えない親の品質の FAIL を、Scene の一覧の差ではなく「Graph が合流して表示に寄与した（`graph.joined`、宣言 `used`、`edgeCount` 1 以上）のに条件を欠いた」事実で定めた（path の添付だけを足す G-03・G-05・G-06 で FAIL にならない穴を閉じた）。(2) R-7 の実効（② は合流した親を独立に落とさない）と、S0 が None になる原因の全条件、`unavailable` を除くのはユーザーの選択であることを開示した。(3) (c) の「次の sample」を定義し、最後の sample の扱いを書いた。(4) `dPrimeCounters` の新しい key は定常状態だけで求め、trace は変えない。(5) `requeries[]` は定常状態の受領書に無いことを書いた。(6) 負例を下位条件ごとに分け、FR-1・FR-5・ticket の負例を足した。(7) dev の予行に最低件数と割合の止める条件を置き、確認の前の非判定の予行を手順に入れた。(8) FR-7 の記録の形と置き場、`head.k65` を扱う file の網羅、手順のファイルを v2 のままにする決定、台帳の行と手順を K6/5 にそろえた、ほか |

## 引き継ぐもの

1. /5 の行の内容を baseline とし、この draft の「変える点」の表を当てたものを /6 の行の内容とする。番号は「/6 の変える点 n」と呼ぶ。
2. /5 の行との関係: /6 の確認の後、CP-4 の判定は /6 の行で行う。/5 の行と凍結（`07fc80ec`）は履歴として残す。/5 の下の receipt（s6r1）は HOLD の記録として残し、/6 の判定に使わない。/6 の確認の後は /5 の行で新しい判定をしない。
3. 事前登録: /5 の凍結の記録は残す。/6 の凍結は別の新しい commit で行う。/5 の凍結の後に起案者が見た観測: s6r1 の正式 run の受領書（Gold 13、parity 12、negative 3、trace 2、SP-P4、G-01 の診断）、S6 の集計（訂正 `ce302ea1` を含む）、品質判定、Opus の独立検査、初版と改訂 1 のレビュー、起案者が Gold の受領書から数えた stamp・D′ の counter・`startSlot.preparesReady` の差・Scene の一覧の一致の内訳。**この draft の規則は、すべてこれらを見た後に選ばれた**。どの観測も予告で、/6 の判定に使わない。

## 変える点（/5 の行との関係）

次の表の文だけを置き換える（または読み替える）。表にない記述は変えない。**1 と 2 は /5 の行（の harness の読み）より弱い読み**（R-6、R-7）。3 は狭める防御と K6/4-P2 の読み替え、4 は K6/5 の読み替え、5〜7 は開示・品質・記録、8 は事前登録の扱い。3〜5 はすべて**定常状態**の規則で、(b) の trace には当てない。

| n | 箇所 | 旧（要旨） | 新 | 理由 |
| - | ---- | ---------- | -- | ---- |
| 1 | 準備の句: K6/2:695 の最終文「開始時に READY でなかった sample …も、分母から除かず窓外に数える」を、定常状態の first-render の候補（親の合流が D の窓内に結果を受けた sample）に当てる箇所 | 開始時に slot が新しい READY でなかった sample は窓外。harness は `startSlot.readyFresh === true` を求める | first-render の候補について、「開始時に READY でなかった sample」は次のどれかに当たる sample と読む: (a) R1 の (1)〜(4) を満たさなかった（`reachedQuiet` が true でない、または R1 の 4 項目を記録から計算し直した値が自己申告と合わない）。(b) その sample のための準備が 1 回だけ行われ、その worker が答えたことが確かめられない: 親の Native の begin の記録がちょうど `["pending"]` でない、`startSlot.kind` が `empty` でない、`dPrimeCounters`（(afterRelease か atEnd) − before。`k64-record.mjs:413-417`、:457-459）の `preparesStarted` が 1 でない、`preparesReady` が 1 でない、`deferredReleased` が 1 でない（0 も 2 以上も）、`staleReadyRetired` が 0 でない。(c) **同じ受領書の中で、samples の並びで次に来る、同じ phase の Graph arm の sample（hybrid arm の sample は飛ばす）**の `startSlot.preparesReady` との差（次 − この）が 1 でない。同じ受領書の同じ phase に次の Graph arm の sample が無い（その phase の最後の sample）なら (c) は当てず、(b) の counter の差分だけで判定する。(c) の不一致は数えず、理由を開示する（その親が Graph を表示に寄与していれば、「変える点」の 6 によりその variant の品質は FAIL になる）。これらは分母から除かず、first-render に数えない。`readyFresh` は条件に使わず、開示（`notReadyAtStart`）にだけ残す。**follow-up の数え方（F1〜F7、X1〜X13、X10 の R1）は変えない**（follow-up の sample の begin は `["pending","cached"]`。`followup.mjs:709`） | 前の準備の残りや cache の結果ではなく、その sample のために 1 回だけ準備した worker の答えだけを数える、という K6/2 の目的を D′ の観測できる形で保つ（R-6） |
| 2 | 鮮度の印の句: K6/2:695 の最終文「鮮度の stamp が一致しなかった sample も…窓外に数える」を first-render の候補に当てる箇所。DR-CP4-S1C1-8 | stamp が `fresh` でない親は窓外 | 案 (ii′): (1) `fresh` は数えうる。(2) `stamp0-missing` は、② の項目（親の Graph の ticket が `available`、宣言 `used`、合流の outcome が `graph-ready` で `joined`、窓内、`revalidation: "passed"`、整数の `edgeCount`）を満たせば数えうる（「緩和の一覧」の「R-7 の実効」のとおり、合流した親では実質無条件）。(3) `unavailable` は数えない（窓外。分母に残す）。(4) stamp の記録が無い（null）親は数えない。(5) `stale` で合流した記録は `[artifact]`（N-d） | ユーザーの選択（R-7） |
| 3 | 定常状態の first-render の窓内の定義: K6/4:167、K6/4:52（用語）、K6/4-P2（:227）、K6/2:705 を定常状態に当てる箇所、K6/2:708 | 窓内・worker 由来（harness はさらに `readyFresh` と stamp の一致） | 定常状態の sample を first-render の窓内に数えるのは、次をすべて満たすときだけ: **FR-1** 親の合流が D（40 ms）の窓内に、返却時の再検証を通った worker の結果を受けた（`classifyJoin` の窓内。境界の扱いは変えない。出所が `Cached` なら数えない〔K6/4-N39〕）。**FR-2** 1 の (a)〜(c) に当たらない。**FR-3** 2 の (1) か (2) に当たる。**FR-4**（N-b）owner の counter の差分が、`counters.after`（atEnd − before）と `countersAfterRelease`（afterRelease − before）の両方で `begins` 1・`lateCached` 0・`cacheHits` 0（`followup.mjs:680-712` の F2 と同じ読み方）で、R2 の終わりの cache が空。**FR-5** 親の宣言（`followUp.parent.declaration`）が `used`、`publishCount` が 1、親の窓（`graphWindowMs`）が D と一致（窓の不一致は K6/5 の変える点 6 のとおり `[precheck]`。`followup.mjs:571-578`）。**FR-6** sample の終わり（R4）までに、`graph-ready` の通知が無く、origin を問わず `followUp.child` が無く、親の IR の再試行の timer（`followUp.parent.irRetryTimer`）が動いていない（K6/4-P2 の「子は出ない」を観測で確かめる。あれば数えず、開示）。定常状態の受領書の `followUp` には `requeries[]` の key が無い（DR-CP4-C7 の trace の record にだけ作られる。`trace-record.mjs:1270-1277`）ので、key が無ければ空と読み、再 query の有無は `followUp.child`、`nativeBegins`、通知で見る。**FR-7**（N-c）「Graph を持つ」: 親の寄与の記録 `followUp.parent.contribution`（子と同じ形の `contributionBasis` と `materialRevision`）があり、`contributionBasis === "material-revision"`、`materialRevision.unresolvedEdges === 0`、再検証を通った Graph の edge が 1 件以上、事前登録した期待寄与の材料（K6/2 の手順 4）から寄与がある（F6 と同じ単位。DR-CP4-F-6）。記録が無い、基準が違う（`scene-level-preview` など）、`unresolvedEdges` が 1 以上の親は数えない。**FR-8**（N-d）`stale` で合流した記録、`dPrimeCounters` の `driftAtQuery` か `prepareFailures` が 0 でない記録は `[artifact]` で止める（製品はこれらの場合に合流させないので、記録の誤り）。親の表示に D の後の Graph が混ざった、または親が 2 回以上公開した場合は、first-render の成否と別に FAIL（K6/4-N1。変えない） | 1 と 2 を当てた条件を 1 か所に書き、R1 と同じ水準の狭める防御を first-render にも当てる。K6/4-P2 の「first-render の窓内に数え」はこの条件で読む |
| 4 | K6/5 の変える点 5（K6/5:92）と K6/5-P1（K6/5:121）。K6/4:299（H1） | D=40 ms の窓内に親が Graph を受けた sample を数える（R1 との関係は書かれていない） | 「K6/4-P2 で first-render の窓内に数える」sample は 3 の FR-1〜FR-8 を満たす sample と読む。構造上の HOLD の原因は D ではなく R1 の下の `readyFresh` と stamp の条件だった。K6/5-P1 は K6/6-P1 で置き換える。H1 の `steadyStateInWindow` は、K6/2 の字義の関数（K6/4 の候補の限定を満たさない候補の判定と開示に使う）と、/6 の first-render の関数に分ける | (甲)(乙) の食い違いを解く |
| 5 | 定常状態の first-render の窓外率（K6/4 の変える点 1。開示） | K6/2 の字義の条件で求める | 3 の条件で求めて書く。あわせて、K6/2 の字義の条件での件数（`notReadyAtStart`、`stampMismatch`、`stampWithoutComparison`、stamp の result の内訳）、1 の (a)〜(c) と 3 の FR-1〜FR-7 の下位条件のどれで数えられなかったかの件数、境界の食い違い（`joinedLateWithinTolerance`）の件数を case ごとに書く（開示だけ）。trace の窓外率は変えない | どの条件で数えたかを結果を見て選ばせない |
| 6 | 品質（K6/4:171、K6/2:708） | 表示された sample の表示の結果で測る。表示されなかった sample は R+IR に混ざりなく戻ったことを確かめる | 文は変えない。first-render の表示の結果は親の合流の結果で、FR-7 の記録で Evidence を照合する。**「R+IR に混ざりなく戻った」は、Scene の一覧の比較ではなく、表示に Graph の寄与が無いことで確かめる。親の合流が Graph を受けて表示に寄与した（`graph.outcome === "graph-ready"`、`graph.joined === true`、`followUp.parent.declaration === "used"`、`graph.edgeCount >= 1`）のに表示された sample に数えられなかった（3 の条件のどれかを欠く）親が 1 件でもあれば、Scene の一覧が R+IR と同じでも（path の添付だけを足す場合）、その variant の品質は FAIL とする**。follow-up で表示されなかった親（graph-late で子が出ない、子が失敗した）は、親の表示に Graph が混ざっていない（K6/4-N1 の検査）ことと Scene の一覧の比較で確かめる（今の `outcome.mjs:399-407` のまま）。可用性の 1% の許容はこの FAIL には効かない | K6/4:171 の文を保ち、path の添付だけの variant で効かない穴を閉じる。新しい緩和を足さない |
| 7 | R7（query ごとの記録） | （既存の項目） | 既存の項目を変えずに足す（定常状態の記録だけ。trace の record は変えない）: `startSlot.kind` と `preparesReady`、親の Native の begin の記録の並び、`dPrimeCounters` の `preparesStarted`・`preparesReady`、stamp の result と `matched`、sample の終わりまでの通知・子・IR の再試行の timer、`followUp.parent.contribution`、3 の判定の内訳（FR-1〜FR-8 の下位条件のどれを満たしたか） | 3 の判定を記録から計算し直せるようにする |
| 8 | 事前登録の凍結と効力の時点: K6/5 の変える点 7（K6/5:94） | 「この file」は /5 の bytes | 「この file」は /6 の bytes。/6 で判定する CP-4 の run と条件の判定に使う診断は、/6 の凍結の後に始めたものに限り、receipt の先頭に /6 の凍結の commit と SHA-256（`head.k66`）を書く（/5 と /4 の凍結も併せて書く）。/6 の凍結の前の観測（s6r1 の受領書を含む）は予告で、/6 の判定に使わない | /5 の変える点 7 と同じ形 |

## 本文に入れないもの（手順の側で扱うもの）と理由

| 事項 | 本文に入れるか | 理由 |
| ---- | -------------- | ---- |
| 品質判定の G-08 の子の扱い（`1e6ede44` の問 2） | **入れない**。品質判定の事前登録 v2（`docs/plans/nir1-cp4-records/quality-verdict-prereg-v2-draft.md`）で扱う | 品質判定は手順外の補助の記録。K6/4:52 の「子」の定義は /6 で変えない |
| DR-CP4-S1C1-8 の改訂 | 入れない。/6 の確認の後に `cp4-decisions.md` に新しい DR を足す | lane の判断記録 |
| (ii-b)（② の結果と S0 なしの S1 の結果の評価の記録） | 入れない。後続の lane | Native（評価 feature）の変更。この確認による製品のコードの変更を許さない（批准 9） |

## threat model（/5 の行への加算）

この draft は新しい外への通信、保存、authority、subprocess、背景の処理、async の lifecycle を加えない（評価の読みと記録の項目だけを変える）。

- In-scope attacks（加える）: 21. R1 を満たさない、または準備が 1 回だけと確かめられない親を first-render に数える。22. 前の sample の準備の残りの結果を first-render に数える。23. stamp の結果によって数えるかを結果を見て選ぶ（2 で (ii′) に固定する）。24. `unavailable` の親を `stamp0-missing` と同じに数える。25. stamp が取れなかった sample のうち失敗になるものだけを分母から外す（(iii′)）。26. 寄与の空の Graph、material-revision でない寄与、未解決の edge のある寄与を first-render の成功と数える。27. 子・IR の再試行・`graph-ready` の通知が出た sample を first-render と数える。28. 準備の句と鮮度の印の句の試験を、R1 の下で起きない fixture だけで済ませる（K6/5-P1 で起きた形）。29. R-6 の (b) を follow-up に当てて F1〜F7 を満たす follow-up を落とす、または follow-up の条件で first-render を数える。30. s6r1 の受領書、または dev の予行を /6 の判定に使う、/5 と /6 の行を結果を見て選び分ける。31. 窓内に合流して Graph が表示に寄与したのに数えない親を、Scene の一覧が R+IR と同じであることを理由に品質の FAIL から外す（path の添付だけの variant）、または hold に留める。32. ② の項目が合流した親を独立に落とすかのように説明して、R-7 の実効を小さく見せる。
- Mandatory defenses（加える）: 「変える点」の 1〜3、5〜8。3 の条件は観測の前に、/6 の凍結と、harness の code の S4 の pin で固定し、独立 reviewer のレビューを受ける。分類器は、R1 の下の現実の形の合成の記録で受入れの K6/6-P・N を期待どおりに分けることを観測の前に示して記録する。**負例は下位条件ごとに 1 例（その条件だけを破る）とし、検出力の記録は下位条件ごとに落とした理由の code を並べる**。FR のどれかが全件で成立することは止める理由にしないが、その条件が空の検査でないことはこの負例で示す。
- **dev の予行（Mandatory defense）**:
  1. 形: D=40 ms の候補で、R1 の下の dev fixture（G-case の構造をまねた非凍結の fixture。凍結の G-case の fixture とその材料の写しは使わない。`admission.mjs:816-837` の `admitDevPreview` と `dev-fixture.mjs` の E-7 の防御のまま）で、定常状態の予行（preview。判定に使わない）を行う。Gold の G-case は正式の受入れの経路（`admitGraphCaseRun`）でだけ見る。試した全回の記録（fixture の版、件数、結果）を残す。
  2. 有効とする下限（凍結の前に固定する）: 窓内に合流した親が 30 件以上あり、FR-7 の記録が窓内に合流した親の全件にあること。満たさなければ予行は「未実施」で、fixture を直して取り直す（凍結に進まない）。
  3. 止める条件: 窓内に合流した親のうち、1 の (a)〜(c) か FR-1〜FR-8 のどれか 1 つの下位条件で落ちた割合が 1/30 を超えたら、凍結に進まず integrator に返す。落ちた親には理由を付け、構造的か偶発かを予行の記録に書く。
  4. 時期: 確認の前に、確認なしにできる非判定の予行（今の harness に /6 の読みを足した試作で、`admitDevPreview` の範囲。DR-CP4-N-8 の前例）を 1 回行い、未確認の点（`stamp0-missing` の頻度、`preparesStarted`・`preparesReady` の差分、FR-7 の記録の取得、FR ごとの件数）を埋めることを推奨する（integrator が決める）。確認の後には、実装した harness で S4 の 7 回目の凍結の前に予行を行う。**確認の後の予行が落ちた場合に取れる道は、新しい draftRef（/7）と再確認だけ**（K6/4 の変える点 16〔K6/4:110〕が観測の後に許す狭める変更の対象は T_late、W_f、T_show、F1〜F7、X1〜X13、R1／R4 の待ちの上限で、FR-1〜FR-8 と R-6・R-7 を含まない）。予行の結果は予告で、/6 の判定に使わない。
- Acceptance implications（読み替え）: K6/5 のとおり。定常状態の first-render は「変える点」の 3、品質の FAIL は 6 で読む。
- 残余（開示）: (1) ②-2 の passed は推論で、(ii-b) まで観測にならない。(2) 境界: s6r1 の窓内の 163 件のうち 8 件が Raw-ready の 39 ms 後より遅く、境界の許容は 0.01 ms（`constants.mjs:153`）。first-render を数えると、境界の食い違いが欠落と品質に効く重みが増す。境界の扱いは変えず、件数を開示する（5）。(3) (c) は sample の外の出来事に依存し、背景の再準備が次の sample の前に走ると、その親は数えられず品質 FAIL に及ぶ。

## 受入れ（/5 の行への加算）

番号は `K6/6-` を付ける。合成の記録の基は、s6r1 の受領書の実際の sample の形（R1 の下の値）にする。負例は下位条件ごとに 1 例で、ほかの条件はすべて満たす。

- K6/6-P1（K6/5-P1 を置き換える）: `startSlot.kind: empty`、`readyFresh: false`、R1 を満たし、begin が `["pending"]`、`dPrimeCounters` が `preparesStarted` 1・`preparesReady` 1・`deferredReleased` 1・`staleReadyRetired` 0・`driftAtQuery` 0・`prepareFailures` 0、次の Graph arm の sample の `preparesReady` との差が 1（間に hybrid arm の sample を挟む例を含む）、counter の差分が after と afterRelease で `begins` 1・`lateCached` 0・`cacheHits` 0、親が D=40 ms の窓内（11、25、40 ms）に worker の結果を受けて `used`・`publishCount` 1・窓 40 ms、通知・子・IR の再試行が無く、`followUp.parent.contribution` が material-revision で `unresolvedEdges` 0 で寄与がある sample は、stamp が `fresh` でも `stamp0-missing` でも first-render の窓内で、子は出ない。
- K6/6-P2: 同じ case に first-render と follow-up の sample があり、表示の結果が同じなら、品質を両方の表示の結果で測る。
- K6/6-P3: follow-up の sample（begin `["pending","cached"]`、F1〜F7 を満たす）は R-6 の (b) を当てずに follow-up の成功に数える。
- K6/6-P4: phase の最後の Graph arm の sample で (c) を当てられない親は、(b) の counter の差分で判定する（他の条件を満たせば数える）。
- K6/6-P5: trace の record（`dPrimeCounters` が従来の 7 key で `preparesStarted`・`preparesReady` を持たない）は X10 の記録の欠けにならない。

Negative（数えない、または止まる。分母から除かない）:

| 番号 | 破る下位条件 | 期待 |
| ---- | ------------ | ---- |
| K6/6-N1a | R1 の `reachedQuiet: false` | 数えない（X10） |
| K6/6-N1b | R1 の 4 項目の計算し直しが自己申告と合わない | 数えない（X10） |
| K6/6-N2a | 親の begin の記録が `["pending","pending"]` など `["pending"]` でない | 数えない |
| K6/6-N2b | `startSlot.kind` が `empty` でない | 数えない |
| K6/6-N2c | `preparesStarted` の差分が 1 でない | 数えない |
| K6/6-N2d | `preparesReady` の差分が 1 でない | 数えない |
| K6/6-N2e | `deferredReleased` の差分が 0 | 数えない |
| K6/6-N2f | `deferredReleased` の差分が 2 | 数えない |
| K6/6-N2g | `staleReadyRetired` の差分が 1 | 数えない |
| K6/6-N2h | 次の同じ phase の Graph arm の sample の `preparesReady` との差が 2（間に hybrid arm を挟む） | 数えず、開示 |
| K6/6-N3a | stamp が `unavailable` | 数えない（分母に残る） |
| K6/6-N3b | stamp の記録が null | 数えない |
| K6/6-N3c | stamp が `stamp0-missing` で親の ticket が `available` でない（記録の上で） | 数えない |
| K6/6-N4 | 窓内に合流した親の stamp が `stale` | `[artifact]` |
| K6/6-N5a | `counters.after` の `begins` が 2 | 数えない |
| K6/6-N5b | `countersAfterRelease` の `lateCached` が 1 | 数えない |
| K6/6-N5c | `cacheHits` が 1 | 数えない |
| K6/6-N5d | R2 の終わりに cache が残った | 数えない |
| K6/6-N6a | 窓内に合流した親の後に `graph-ready` の通知 | 数えず、開示 |
| K6/6-N6b | 子（origin が `index-ready` の例）がある | 数えず、開示 |
| K6/6-N6c | 親の IR の再試行の timer が動いた | 数えず、開示 |
| K6/6-N7a | `followUp.parent.contribution` が無い | 数えない |
| K6/6-N7b | `contributionBasis` が `scene-level-preview` | 数えない |
| K6/6-N7c | `unresolvedEdges` が 1 | 数えない |
| K6/6-N7d | edge が 0 件 | 数えない |
| K6/6-N7e | 期待寄与の材料からの寄与が無い | 数えない |
| K6/6-N8 | 窓内に合流した `stamp0-missing` の親だけを分母から外した receipt（(iii′)） | 拒否 |
| K6/6-N9 | receipt の先頭に `head.k66` が無い、または /6 の凍結の前に始めた run（s6r1 を含む）を /6 で判定した | 拒否 |
| K6/6-N10a | 窓内に合流した親で `driftAtQuery` の差分が 1 | `[artifact]` |
| K6/6-N10b | 窓内に合流した親で `prepareFailures` の差分が 1 | `[artifact]` |
| K6/6-N11a | FR-1: 出所が `Cached` の窓内の親 | 数えない（K6/4-N39） |
| K6/6-N11b | FR-1: `joined` なのに `revalidation` が null | `classifyJoin` が止める（`[artifact]`） |
| K6/6-N12a | FR-5: 宣言が `used` でない | 数えない |
| K6/6-N12b | FR-5: `publishCount` が 2 | 数えず、K6/4-N1 の FAIL |
| K6/6-N12c | FR-5: 親の窓が 40 ms でない | `[precheck]` |
| K6/6-N13a | 窓内に合流して Graph が表示に寄与した（`edgeCount` 1 以上）のに条件を欠いた親で、Scene の一覧が R+IR と違う | 品質 FAIL |
| K6/6-N13b | 同上で、Scene の一覧が R+IR と同じ（path の添付だけ。G-06 の形） | 品質 FAIL |

## 範囲と他の lane への影響

| lane | 影響 |
| ---- | ---- |
| CP-4 の手順（S2 追補、S3、S4 の 7 回目の凍結） | harness の変更（下の表）、`head.k66`、K6/6-P・N の検出力の記録の取り直し、dev の予行 |
| 品質判定（手順外の補助） | 事前登録 v2（別 file）。表示の判定が /6 の 3 に従い、窓内に合流して Graph が表示に寄与したのに数えない親は FAIL にそろえる |
| DR-CP4（lane の判断記録） | DR-CP4-S1C1-8 の改訂 |
| (ii-b) の lane（後続） | 評価 build の Native に、② の結果と S0 なしの S1 の結果を出す記録を足す |
| 製品 | 影響しない |
| PUB-G／Session C-1 | 開示の項目（定常状態の first-render の窓外率）の求め方が 3 になる。PUB-G の承認は置き換えない |
| parity、診断の負例（N2〜N4）、SP-P4、G-01 の診断 | 影響しない（parity は Graph を測らない。負例は `returnedSceneIds` で判定し、表示の判定を使わない〔`frozen-diagnostics.mjs:790-850`〕） |
| DD-1、DP-H、K6/3、P の評価 | 影響しない |

### この draft が確認されたときに変わる harness の file（実装はしない。製品 repo の `a2309b95` の行。引用の行番号は実装の前に取り直す）

| file | 変わる中身 | pin（S2 の `SOURCE_PINS`） |
| ---- | ---------- | --- |
| `scripts/quality/nir1-graph-eval/join.mjs` | `:113-120` の `steadyStateInWindow`（K6/2 の字義）を別名（例: `k62SteadyStateInWindow`）で残し、/6 の first-render の関数を足す（または followup.mjs に置く）。注記（`:108-112`）を直す | `p1-harness-core`（`865a3e2b`。pin のし直し） |
| `scripts/quality/nir1-graph-eval/followup.mjs` | `:485-490` の定常状態の `firstRender` を FR-1〜FR-8 にする（R1 の検査〔`:587-595`〕を first-render の候補にも当てる、counter〔after と afterRelease〕・通知・子・IR の再試行・寄与・宣言・公開の回数の条件、N-d の `[artifact]`）。`:600-608` の F1 `parent-joined` は 3 を満たさない窓内の親の理由として残し、どの下位条件で落ちたかを detail に書く。**`:68-76` の `DPRIME_COUNTER_KEYS` と `:296-301` の `missingR7` の検査は、`preparesStarted`・`preparesReady` を context が steady のときだけ求める**（trace の record は従来の 7 key のまま。`trace-record.mjs` は変えない）。follow-up の経路と trace の側の first-render は変えない | `k65-merge-followup`（`8489ae57`。pin のし直し） |
| `scripts/quality/nir1-graph-eval/outcome.mjs` | `:29` と `:323` の import を K6/2 の字義の別名に替える。`k64AvailableQuality`（`:370-`）の `:399-407` の「表示されない sample」の検査を、Scene の一覧の比較に加えて、「親の合流が Graph を受けて表示に寄与した（`graph.joined`、宣言 `used`、`edgeCount` 1 以上）のに表示されなかった」なら FAIL（「変える点」の 6）にする | `p2p3-harness-admission`（pin のし直し） |
| `scripts/quality/nir1-graph-eval/availability.mjs` | `:71-72` の import と `:77-83` の再 export（`availability.test.mjs:11` が `steadyStateInWindow` をここから import する）を整理する。`:283` の `entry.inWindow`（K6/2 の窓内）・`:296` の `qualityHold` と、/6 の first-render の件数を分けて持つ（K6/2 の窓内は開示、/6 の first-render は判定）。case ごとの開示に 1 の (a)〜(c)、FR の下位条件ごとの件数、境界の食い違いの件数を足す。`:270-279`・`:860-866` の DR-CP4-F-6 の形式の関門（子の `contributionBasis`）を親の `followUp.parent.contribution` にも当てる。`:557-563` の (b) の K6/2 の区分は変えない | `p1-harness-core`（pin のし直し） |
| `scripts/quality/nir1-graph-eval/receipt.mjs` | `:850-858` の DR-CP4-F-6 の形式の関門を親の寄与にも当てる。`head.k66` の照合 | `k65-receipt-p95-head`（pin のし直し） |
| `scripts/quality/nir1-graph-eval/run-sample.mjs` | `:361-375` の `windowOutCause` の `not-ready-at-start` を、1 の (a)〜(c) の理由に置き換える。`:390-430` の `previewSummary` も同じ | `p1-harness-core`（pin のし直し） |
| `scripts/quality/nir1-graph-eval/k64-record.mjs` | `:59-67` の `DPRIME_COUNTER_KEYS` に `preparesStarted`・`preparesReady` を足す（評価 build の JSON はすでに出している: `nir1_graph_eval/mod.rs:695-696`。Native の変更は要らない）。親の寄与の記録 `followUp.parent.contribution` を、子と同じ `contributionOf`（`:496-517`）を親の fetch（`fetches[0]`。`:142`）の `paths` に当てて作る。renderer の probe はすでに親を含む全 fetch に `paths` を出している（`renderer/cp4-k64-probe.tsx:355-363`）ので、probe の変更は要らない見込み | 実装の時に `harnessPinOf` で確かめる |
| `scripts/quality/nir1-graph-eval/constants.mjs` | /6 の凍結の descriptor（`K66_FREEZE`）を足す | `k65-freeze-source`（pin のし直し） |
| `head.k65` を扱う file（`admission.mjs`、`frozen-k64-admission.mjs`、`receipt.mjs`、`frozen-diagnostics.mjs`、`diagnostic-runner.mjs`、`trace-frozen.mjs`〔:30、:377、:396、:413、:450〕、`trace-runner.mjs`〔:14、:943〕、`frozen-k64-run.mjs`〔:36、:199、:1514、:1556、:1572〕、`k64-runner.mjs`〔:203〕、`followup.mjs`、`quality-verdict-cli.mjs`、`scripts/quality/nir1-graph/observation-prep.mjs`、`test-support.mjs`） | `head.k66` の受け渡しと照合を足す（`head.k65` は残す） | `k65-g01-e2e-admission`、`k65-harness-d40`、`k65-receipt-p95-head`、`k65-n2-n3-enforcement`、`k65-merge-followup`（pin のし直し） |
| 手順のファイル（`procedure-file.mjs`、`procedure/k64-procedure.v2.json`） | **変えない**（「手順のファイルの扱い」）。`frozen-k64-admission.mjs:49` の `FORMAL_PROCEDURE_VERSION`、`quality-verdict-cli.mjs:40` の `PROCEDURE_FILE`、`observation-prep.mjs` の `k64-procedure-v2` の key、`observation-prep-freeze.v1.json:24` も変えない | — |
| `scripts/quality/nir1-graph-eval/dev-fixture.mjs` と dev fixture（新規か既存の拡張） | R1 の下の dev の予行のために、G-case の構造をまねた非凍結の fixture（窓内に合流する親が 30 件以上出る大きさ）を用意する。E-7 の防御は変えない | 実装の時に確かめる |
| `scripts/quality/nir1-graph/observation-prep.mjs` | `CONTRACTS` に /6 を別の key で足す（`CONTRACTS.k64` は trace の束縛のため K6/4 のまま）。`:473` の `K64_VALUES` は変えない | 凍結の検査そのもの |
| `scripts/quality/nir1-graph-eval/quality-verdict.mjs`、`quality-verdict-cli.mjs` | 品質判定の事前登録 v2 に合わせる（`:368-371` の表示されない sample を「Graph の寄与」で `fail` に、G-08 の子の扱い） | pin の外（DR-CP4-QV-1） |
| `evals/nir1-graph/observation-prep.v1.json`（S2 追補） | `contracts` に /6、`userConfirmations` に /6、`k66Readings`（R-6、R-7 とその実効、FR-1〜FR-8、品質の FAIL の条件、dev の予行の全回の記録、s6r1 を見た後の改訂であることとレビューが完全な盲検でなかったことの開示） | S4 が束縛 |
| `evals/nir1-graph/observation-prep-freeze.v1.json` | S4 の 7 回目の凍結（手順のファイルの entry は変えない） | — |
| 試験（`followup.test.mjs`、`join.test.mjs`、`availability.test.mjs`、`outcome.test.mjs`、`k64-record.test.mjs`、`receipt.test.mjs`、`run-sample.test.mjs`、`trace-record.test.mjs`、`native-sample.test.mjs`、`test-support.mjs`、quality-verdict の試験） | K6/6-P1〜P5、K6/6-N の全例を R1 の下の現実の形で足す。`test-support.mjs` の既定の fixture は K6/2 の読みの試験に残し、/6 の試験には R1 の形の fixture を別に足す。K6/5-P1 の試験は K6/6-P1 に置き換える。`readyFresh`・`notReadyAtStart`・`windowOutCause`・`previewSummary` に触れる既存の試験を直す | 試験は pin の対象外 |
| 検出力の記録 | K6/6-P・N の合成の記録で、下位条件ごとに取り直す | — |
| 変えないもの | trace の file、`trace-record.mjs`、(b) の分類、T_late・W_f・T_show・D の定数と照合、手順のファイル、Gold、凍結の fixture、`K64_VALUES` | — |

S4 が pin する harness の変更は、S4 の枝でだけ merge する（2026-11-07 の C7 #826 の前例）。

## 確かめられなかったこと

1. `stamp0-missing` がこの経路でほぼ全件になる原因（release の直後の admit で main connection を何が握っているか、commit の競合を含むか）。
2. ② が実機の G-case で stamp の一致と同じ件を落とすか（コードの読みだけ）。s6r1 の pool では `driftAtQuery` の差分は全件 0、`stale` は 0 件。(ii-b) の後に確かめられる。
3. FR-7: s6r1 の受領書には親の寄与の記録が無い（`followUp.parent` に `contributionBasis`・`materialRevision` が無い）。probe は親の `paths` をすでに出しているので、`k64-record.mjs` の読取の追加で取れる見込みだが、実装と予行で確かめる。**FR-7 を s6r1 に字義どおり当てると first-render は 0、欠落 163、品質 FAIL 163 件（7 variant）**。
4. `preparesStarted`・`preparesReady` の差分は s6r1 の受領書に無い（今の `DPRIME_COUNTER_KEYS` に無い）。窓内に合流した 163 件では、同じ受領書・同じ phase の次の Graph arm の sample との `startSlot.preparesReady` の差が 158 件で 1、5 件は phase の最後で (c) を当てられない。
5. D=40 ms の G-case で、R-6・R-7 の下の first-render の率（s6r1 の値は予告）。
6. 改訂 2 のレビューはまだない。

## 確認の扱い

- 確認は、台帳の Confirmation protocol に従い、`nir1-final-request-eval-proposal/6` と `graph-eval-procedure` を曖昧さなく特定するユーザーの明示の承認で行う。構造化質問なら、質問の文が draftRef、contractId、確認に出す版の SHA-256 を名指し、ちょうど 1 つの `draftRef#contractId` を示す。承認の効力は批准 7 の 2 段。
- 確認の質問の文には次を書く。(1) 緩和の一覧（R-6、R-7）と、品質への効き方（数える親は FAIL から測定へ移る）。(2) **R-7 の実効: ② は今の harness では合流した `stamp0-missing` の親を独立に落とさず、実効は `unavailable` を除くだけ。`stamp0-missing` を数える根拠はコードの読み（実機未確認）で、S0 が None になる原因は混雑だけでなく transaction の中・commit の競合を含み、`stamp0-missing` には S1 も読めなかった sample が含まれうる。`unavailable` を除くのは安全上の差ではなく選択**。(3) **窓内に合流して Graph が表示に寄与した親が first-render の条件を 1 つでも欠くと、Scene の一覧が R+IR と同じでも variant の品質は FAIL（可用性の 1% の許容は効かない）。`unavailable` の親と (c) の不一致の親もこれに当たる**。(4) 狭める項目（FR-1〜FR-8、N-a〜N-d）。(5) D・p95 の上限・T_late ほかの値、手順のファイル、follow-up の数え方は変えないこと。(6) s6r1 は HOLD のままで、/6 の判定は /6 の凍結の後の run に限ること。s6r1 の参考値の「欠落 0」は FR-7 と準備の counter を仮定した値で、字義どおりなら欠落 163 であること。(7) この改訂は s6r1 の観測の後に起案したこと。(8) 確認の後の dev の予行が落ちれば /7 と再確認になること（確認の前の非判定の予行を行ったなら、その結果を添える）。
- 2026-11-07 のユーザーの回答（`1e6ede44`、`e704f28f`）、計画への同意、merge の指示、包括的な返答は、確認として扱わない。
- この draft は合格基準の緩和を含むので、続行計画 §12.1 の「重要な変更」にあたる。CP-4 は AGENTS.md の NIR-1 の残レーンに入っておらず、技術判断の事前委任も無い。

### 確認までの手順（K6/5 の順にそろえる）

1. 初版、Opus の独立レビュー、ユーザーの選択（`e704f28f`）、改訂 1、Sonnet の 4 観点のレビューと反証、改訂 2（この file）。
2. 改訂 2 のレビュー（または最終 pass）の要否は integrator が決める（行う場合は read-only で、起案者の結論は渡さない）。確認の前の非判定の dev 予行を行うかも integrator が決める（「dev の予行」の 4）。確認に出す版の SHA-256 を確定する。
3. ユーザーの確認（上の形）。
4. 確認の記録: `claude/nir1-contracts` に `user-confirmation-2026-11-xx-k66-graph-eval-procedure.md`（質問と回答の逐語、日付、draftRef#contractId、SHA-256）を commit する。続行計画（`docs/plans/nir1-continuation-2026-10.md`）の §10 に節を足す。
5. 台帳の更新（master への PR）: draft を確認された版から byte 同一で取り込み（`git show <commit>:<path>` の出力をそのまま置く）、`sha256sum` の一致を確かめ、補足・行・注を足す。
6. contracts の凍結: S2 追補と S4 の 7 回目の前、かつ /6 で判定する最初の run の前に、確認された bytes を commit・push し、K6/2 の「事前登録の凍結」の 1〜7 の記録（`k66-freeze-record.md`。凍結の commit、file の SHA-256、`git ls-remote`、push の時刻、remote 側の時刻〔repository activity と PushEvent〕、`git merge-base --is-ancestor` による前の凍結との順序）を作る。凍結の後、`claude/nir1-contracts` は fast-forward だけで進める。
7. その後に、harness の実装、試験と検出力の記録、品質判定 v2 の確定・実装・独立のコードレビュー・push（remote 側の時刻つき。v2 の §0）、R1 の下の dev fixture での予行、S2 追補、S3 の独立レビュー、S4 の 7 回目の凍結、取り直しの正式 run。

## 確認後の記録（この draft の外で行う。台帳への取り込みの提案）

- 台帳の補足の見出し: 「2026-11-xx補足（K6/6）」。経緯に s6r1 の HOLD と機構、(甲)(乙) の食い違い、K6/5:92 の取り違え、ユーザーの決定と選択（`1e6ede44`、`e704f28f`）と問 2 の文面の要約の狭さ、R-7 の実効を書く。行 ID は `K6/6-1`。
- 確認台帳の行の案（/5 の行の下に足す。/5 の行は消さない。実際の行は lane、startStatus、blockers、英文の記録の列を含む 10 列で書き、startStatus は `condition-not-met`〔(ii) について〕）:

| contractId | draftRef | confirmedRef | confirmedScope | 備考 |
| ---------- | -------- | ------------ | -------------- | ---- |
| `graph-eval-procedure` | `nir1-final-request-eval-proposal/6` | `nir1-final-request-eval-proposal/6#graph-eval-procedure`（批准7の(i)についてだけ。(ii)は `preConfirmationRef` で、効力の根拠にしない） | K6/6の範囲: draft冒頭の「ユーザーが批准すること」の1〜9（この一覧が範囲の正本）。/6の行の内容は、/5の行に/6の「変える点」の1〜8を当てたもの。定常状態のfirst-renderは、窓内に合流した親のうち、R1を満たし、そのsampleのための準備が1回だけ行われ（ownerの `preparesStarted`・`preparesReady` の差分1ほか）、stampが `fresh` か `stamp0-missing`（②の項目は合流した親では実質無条件）で、counter・宣言・公開・通知・子・寄与の条件（FR-1〜FR-8）を満たすものだけを数える。`unavailable` は数えず、`stale` は[artifact]。窓内に合流してGraphが表示に寄与したのに数えない親は、Sceneの一覧によらず品質FAIL（K6/4:171）。**合格基準の緩和（2つ）**: 準備の句の読み（R-6。first-renderの候補だけ）、鮮度の印の句の(ii′)（R-7）。D 40 ms、Hybrid p95の上限94.2 ms、T_late 100 ms、W_f 100 ms、T_show 2 s、1%、失効の読み、F1〜F7、X1〜X13、R1〜R6・R8の文面、手順のファイルv2、follow-upの数え方は/5のまま。(b)の規則、Gold、fixture、trace、(ii-b)の製品の記録、依存する契約、ほかのcontractIdの行、proposal/7の行は確認しない | (i)は確認済みで、記録の時点からCP-4の可用性と品質の判定に使う（/5の行に替わる。/5の行とs6r1のreceiptは履歴として残し、/5の行で新しい判定はしない）。(ii)は/4・/5の行と同じく、条件の成立、診断とreceiptの照合、改めての確認の後にだけ効く。/6の凍結の前に始めたrunは/6の判定に使わない。この確認は、Graphの製品公開、local送信の公開、activation UIの公開、新しいauthority・保存先・送信先・製品の入口、製品のコードの変更を許可しない |

- 台帳の注の案: /5 の行の備考の末尾に「2026-11-xx 追記（K6/6）: /6 の確認の後、CP-4 の判定は /6 の行で行い、この行で新しい判定はしない。s6r1 の receipt は、この行の下の HOLD の記録として残る」。
- 確認されなければ、CP-4 は /5 の行のままで、R1 の下では定常状態の first-render が数えられず、D=40 ms の候補では (a) が構造上 HOLD に寄る。別の案は /7 で起案する。

## 確認文

contractId の選択: **`graph-eval-procedure`**（K6/2 の条件付きの行、K6/4・K6/5 の行と同じ）。

- 理由: (1) この差分は、/5 の行の定常状態の first-render の数え方と品質の FAIL の判定の明文化と、それに連動する記録・開示の改訂で、新しい契約の主題ではない。(2) 新しい authority、保存先、送信先、製品の入口を加えない。(3) `nir1-final-request-packing-eval`（K6/3 の行）の内容に触れない。(4) 確認は contractId ごとの 1 回の承認。

承認の例（固定の文でなくてよい）:

- I confirm draftRef nir1-final-request-eval-proposal/6 for contractId graph-eval-procedure.
