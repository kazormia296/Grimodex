# NIR-1 最終 request 評価の契約提案 proposal/6（draft）: Graph の評価の手順の、定常状態の最初の表示（first-render）の数え方を R1 の下で明文にする（K6/5 の行の改訂）

Status: draft／未確認。鮮度の印の句（「変える点」の 2）は選択肢を並べたままで、ユーザーの選択の後に改訂して 1 案にする。確認後はこの bytes の SHA-256 を台帳に記録し、本文は編集しない

## あなたが決めること（3 行）

- CP-4 の Graph の評価で、定常状態の sample の前提が「slot が新しい READY」から「slot が `empty`（R1）」に替わった（K6/4 の変える点 4）ことに合わせ、K6/2 の手順 3 の最終文の「開始時に READY でなかった sample は窓外」を「R1 を満たさず、その sample のための新しい準備が観測されなかった sample は窓外」と読み替えてよいか（「変える点」の 1。準備の句）。
- 同じ文の「鮮度の stamp が一致しなかった sample は窓外」（鮮度の印の句）を、(i) 残す、(ii) 窓内に合流し再検証を通った親は stamp が無くても数える、(iii) stamp が一致した sample だけで分母を作る、(iv) 製品側で stamp を確実に取る、のどれにするか（「変える点」の 2。起案者は選ばない）。
- それ以外の K6/5 の行（D 40 ms、Hybrid p95 の上限 94.2 ms〔B 54.2 ms〕、T_late 100 ms、W_f 100 ms、T_show 2 s、1%、失効の読み、F1〜F7・X1〜X13・R1〜R8 の文面、Gold・fixture・trace の file）は変えない。first-render に数える条件に、R1 と同じ水準の狭める項目（「変える点」の 3）を足す。

## 冒頭の開示（何が起きたか、緩和に当たりうること、観測の後の改訂であること）

- **正式 run s6r1 で起きたこと**（候補 master `a2309b95`、S4b `63bc9b90`、K6/5 の凍結 `07fc80ec`。記録は contracts の `docs/plans/nir1-cp4-records/s6-aggregation-s6r1/`、`quality-verdict-s6r1-1/`、訂正 `ce302ea1`）: harness の記録どおりの読みで、Gold の定常状態の pool の欠落が 163/270（許容 2）で HOLD。163 件はすべて、親の合流が D=40 ms の窓内に worker の Graph を受けた sample（`graph.outcome: graph-ready`、`joined: true`、再検証 passed、出所 `worker`、到着は Raw-ready の 20.8〜39.9 ms 後）で、子は出ていない（親は `used` で cache に入らない）。分類器はこれを first-render に数えず、follow-up も無いので F1 `parent-joined`（`followup.mjs:600-608`）で「表示されなかった」とした。表示 0/30 の variant は G-01/v1、G-03/base、G-06/base、G-08/base-usable、G-08/graph-recovered の 5 つで、それぞれが K6/4:167 の「表示された sample が 1 件もない case は HOLD」にも当たる。
- **機構（コードで確かめた）**: 定常状態の first-render は `steadyStateInWindow`（`scripts/quality/nir1-graph-eval/join.mjs:113-120`）で決まり、窓内・出所 worker に加えて `startSlot.readyFresh === true` と `freshnessStamp.matched === true` を要る（`followup.mjs:485-490`）。(1) `readyFresh` は `kind == Ready && prepares_ready > LAST_CONSUMED_PREPARES_READY`（`electron/native/grimodex-node/src/nir1_graph_eval/mod.rs:446-453`）で、K6/4 の R1（各 sample の前に slot を `empty` にする。K6/4:192）の下では `kind == Ready` が成り立たず**構造的に false**。D′ の製品は保留した query のために worker を準備してすぐ答え、READY を公開しない（`nir1_graph_product.rs:2376-2381` の `run_deferred` の注記）。(2) stamp は製品の状態で、S0 を admit で wait 0 で読み（`nir1_graph_product.rs:2633-2636`、`c_query_freshness.rs:10-29`）、foreground の待ち手・maintenance の予約・`try_lock` の失敗・autocommit でない・読取中の commit のどれかで None（`stamp0-missing`）になる。s6r1 の pool の 270 件のうち 267 件が `stamp0-missing`、3 件が `fresh`。したがって **D の値に関わらず、R1 の下では Gold の定常状態の first-render は数えられなかった**。D=10.84 ms では親が常に graph-late で follow-up で表示されたので表に出なかった（s5r6 も `notReadyAtStart` 30/30）。
- **文面の食い違い（規定の欠落・矛盾）**: (甲) K6/2:695 の最終文「開始時に READY でなかった sample や、鮮度の stamp が一致しなかった sample も、分母から除かず窓外に数える」、K6/4:52（first-render の可用性 ＝ K6/2 の (a) の窓内）、K6/4:299（H1。`steadyStateInWindow` は first-render の記録として残す）、DR-CP4-S1C1-8（`cp4-decisions.md:231`。`stamp0-missing` も窓内にしない）。(乙) K6/5 の変える点 5（K6/5:92）と K6/5-P1（K6/5:121）「D=40 ms の窓内に親が Graph を受けた sample を first-render の窓内に数え、子を出さない（K6/4-P2 を 40 ms で読んだもの）」、K6/4-P2（K6/4:227）、K6/4:167（「K6/2 の手順の 5 のまま、D、worker 由来の結果だけ」。手順 3 に触れない）。K6/5-P1 の試験（`followup.test.mjs:132-147`）と検出力の記録（contracts `3675c50e` の `k65-detection-2026-11-07/k64-k65-synthetic-detection-record.md:111`。枝 `claude/k65-harness`）は、R1 の下で起きない fixture（`test-support.mjs:73-74` の `startSlot: { readyFresh: true }`、stamp `fresh`）を使っていた。**K6/5 は「規則は変えない」と書いたが、R1 の下で手順 3 の最終文がどう読まれるかを確かめていなかった**（K6/5 の起案の見落とし。この draft の起案の動機）。
- **緩和に当たりうること**: 準備の句の読み替え（「変える点」の 1）は、K6/4 の変える点 4 が sample の前提を R1 に替えたことの帰結を明文にするもので、K6/4 の行の読みとしては新しい規則ではない。しかし **s6r1 の harness の読み（K6/2:695 の字義）よりは窓内に数える側を広げる**ので、緩和の一覧に入れる（R-6）。鮮度の印の句（「変える点」の 2）の案 (ii) と (iii) は緩和にあたり（R-7、R-8）、(i) と (iv) は緩和にあたらない。**起案者は鮮度の印の句の案を選ばない**（ユーザーの決定 2026-11-07 の 2。選択肢と、守っていたもの・弱まるもの・s6r1 での参考値・harness の変更は「鮮度の印の句の選択肢」の節）。
- **観測の後の改訂であること**: この draft は s6r1 の受領書・集計・品質判定と、Opus の独立検査の結果を見た後に起案した。K6/2:617（「観測の後に定常状態や trace の定義を変えること」は攻撃）、:620（Negative「観測の後に定義を変える」）、K6/4 の変える点 16（広げる変更は新しい draftRef でだけ行う。K6/4:110）に従い、**この改訂は新しい draftRef（/6）で行い、ユーザーの確認を要し、/6 の凍結の後に始めた run だけで判定する**。s6r1 の受領書は /6 の判定に使わない（この draft に書く s6r1 の値はすべて予告の参考値で、判定に使わない）。s6r1 は HOLD のまま記録する（ユーザーの決定 2026-11-07 の 1）。
- **ユーザーの決定（2026-11-07）**: contracts `docs/plans/nir1-cp4-records/user-confirmation-2026-11-07-s6r1-hold-k66.md`（commit `1e6ede44`）。問 1「HOLD と記録して新版を起案（推奨）」、問 2「契約の『子』の定義にそろえる（推奨）」。**これらは起案の指示と選択で、この draft の確認ではない**。問 2 は品質判定の事前登録（手順外の補助の記録）の新しい版で扱い、この draft の本文には入れない（「本文に入れないもの」）。

## 緩和の一覧（と、足す狭める項目）

K6/5 の行より弱い読みになりうるのは次で、ほかの物差し（D 40 ms、1%、W_f、T_late、T_show、lease、失効率の定義、Hybrid p95 の上限）は変えない。

| # | 緩和 | 旧 → 新 | 効く規則・判定 | 根拠 | 「変える点」 |
| - | ---- | ------- | -------------- | ---- | ------------ |
| R-6 | 準備の句の読み | 「開始時に新しい READY」（R1 の下では常に偽）→「R1 の (1)〜(4) を満たし、その sample のための新しい準備（D′ の保留の release と prepare）が観測された」 | 定常状態の first-render の窓内（K6/4:167、K6/4-P2）、first-render の窓外率（開示）、表示の可用性の欠落率 | K6/4 の変える点 4（R1）の帰結。ユーザーの確認を要する | 1 |
| R-7 | 鮮度の印の句（案 (ii) を選んだ場合だけ） | stamp の一致を要る → 一致しなかった（`stale`）ことが無ければよい（`stamp0-missing`・`unavailable` も数える） | 同上 | ユーザーの選択（未決） | 2 |
| R-8 | 分母（案 (iii) を選んだ場合だけ） | 全 sample の pool → stamp が `fresh` の sample だけの pool | 定常状態の欠落率の分母（K6/4:167、K6/2:695「分母から除かず」、K6/4 の「変えないもの」の「分母を pool すること」） | ユーザーの選択（未決） | 2 |

足す狭める項目（「変える点」の 3。ユーザーの確認の範囲に入る）: N-a first-render にも R1 を当てる（今の harness は first-render なら `followup.mjs:585` で返り、R1 の検査〔X10。:587-595〕を当てない）。N-b first-render の sample にも owner の counter と Native の begin の記録の整合を求める（F2 と同じ形）。N-c first-render の Graph にも「Graph を持つ」（F6 と同じ、edge 1 件以上と事前登録の材料からの寄与。K6/4 の In-scope attack 11）を求める。N-d 窓内に合流した親の stamp が `stale`（`matched: false`）なら `[artifact]` で止める（製品は `stale` で query を投げないので、その形は記録の誤り）。

## 鮮度の印の句の選択肢（未決。ユーザーが選ぶ）

### 鮮度の stamp と再検証が何を保証するか（コードで確かめた事実。製品 repo は origin/master `a2309b95`）

- **stamp（S0／S1）**: S0 は `admit`（`nir1_graph_product.rs:2633`。D′ では release の後の `build_worker` の中）で、親の main connection の `ReadIdentity`（`read_identity.rs:10-16`。source revision、main と temp の schema_version、user_version）を wait 0 で読む。S1 は query の直前（`serve_query`、:2793）。両方あって違えば `Stale` を返して worker に query を投げない（:2797-2806）。片方でも無ければ `stamp_unavailable` を数えて query を続ける（:2808）。モジュールの注記は「Never an authority: the worker's own registration-drift check stays final」（`c_query_freshness.rs:1-2`）。評価 build の記録（`TicketNotes::stamp`、`nir1_graph_eval/mod.rs:308-317`）は `fresh`／`stale`／`stamp0-missing`／`unavailable` で、S0 が無いときは S1 の結果を残さない。**stamp の一致が保証するのは、「admit から query の直前まで、親の connection から見て commit が無かった」ことの、sample ごとの Native の観測である**。
- **worker 自身の検査**: worker は query の snapshot を開いた直後に `ReadIdentity` が registration の時の identity と同じかを確かめ（`nir1_graph.rs:1021-1026`、違えば `NIR1_GRAPH_QUERY_DRIFT`）、B の seal が期待どおりかを確かめ（:1029-1033）、query の後にもう一度 identity を読んで比べる（:1131-1148）。違えば `RegistrationDrift`（区分は stale。`worker_frame.rs:614`）で unavailable になり、合流しない。これは registration から query の終わりまでの commit を覆う。admit から registration までの commit は覆わないが、その場合 worker はその commit の後の状態で registration するので、答えが admit の時点より古くなることはない（コードの読み。実機では確かめていない）。
- **返却時の再検証（requalification）**: 親の participant read の transaction で、(1) seed を D-final の規則で読み直し、B の seal が worker の答えた世代と同じかを確かめ（`SeedChanged`、`SealUnavailable`、`SealMismatch`）、(2) 表示する各 Scene の代表 path を、この snapshot の A3 と pin で照合する（`PathNotCurrent`。全体で all-or-nothing）（`related_scenes_requalification.rs:1-19`、:192-210）。製品はこれを通った Graph だけを合流させる（`related_scenes/graph.rs:739-751`）。**ただし harness の `revalidation: "passed"` は観測ではなく推論**で、`graph-ready` の outcome と整数の `edgeCount` が renderer に届いたことから推す（`run-sample.mjs:154-170`、`k64-record.mjs:300-306`）。品質判定の事前登録（contracts `quality-verdict-prereg-2026-11-06.md:53`）は、この推論値を根拠にしないとした。
- **比べた結論（コードの読み）**: 表示した Graph の現在性の範囲としては、worker の検査（registration から query の終わり）と再検証（query の後から合流まで。seed、seal の世代、表示する path）が、stamp の覆う区間（admit から query の直前）を、admit から registration までの区間を除いて覆い、その区間の commit は答えを古くしない。**保証の範囲は stamp の一致と同等かそれ以上と読める**。一方、**証拠の形は弱い**: stamp は sample ごとの Native の観測だが、worker の検査は「drift なら合流しない」という製品のコードの契約で、受領書に検査の結果の記録は無く（`dPrimeCounters.driftAtQuery` の差分だけ）、再検証の passed は推論である。
- **s6r1 の受領書の値（参考。判定に使わない）**: pool 270 件の stamp は `stamp0-missing` 267、`fresh` 3（窓内に合流した 163 件では 161 と 2、graph-late の 107 件では 106 と 1）。窓内に合流した 163 件はすべて、`startSlot.kind: empty`、R1 の 4 項目と `reachedQuiet` が true、Native の begin が `pending` の 1 件、`dPrimeCounters` の差分が `deferredReleased` 1・`staleReadyRetired` 0・`prepareFailures` 0・`driftAtQuery` 0、counter の差分が `begins` 1・`lateCached` 0・`cacheHits` 0、宣言 `used`、`publishCount` 1、`lateGraphInDisplay` false、親の窓 40 ms、通知と子が無く sample は T_show の経過で終わり、cache は終わりに空、`edgeCount` 1〜3 だった（起案者が受領書から数えた。期待寄与の照合は、親の寄与の記録が受領書に無いので確かめられない）。

### 比較の表

| 案 | 中身 | 守っていたもの（弱まるもの） | s6r1 での参考値（予告。判定に使わない。R-6 を当てた場合） | 要る harness の変更 | 緩和か |
| -- | ---- | ---------------------------- | -------------------------------------------- | ------------------- | ------ |
| (i) 句を残す | first-render は stamp が `fresh`（`matched: true`）の sample だけ。`stamp0-missing`・`unavailable` の親は窓内に合流しても窓外（分母に残す） | 何も弱めない | first-render 2、follow-up 107、欠落 **161/270**（許容 2）。表示 0 の variant は G-03/base、G-08/base-usable、G-08/graph-recovered の 3 つ。**HOLD が続く見込み**（製品の stamp の読取を変えない限り。窓内に合流する親が多いほど欠落が増える） | `steadyStateInWindow` の `readyFresh` を R-6 の条件に置き換え、stamp の一致の条件は残す。試験 | いいえ |
| (ii) 再検証で代える | 窓内に合流し、再検証を通り（harness の推論）、R-6 と N-a〜N-d と `driftAtQuery`・`prepareFailures` の差分 0 を満たす親は、stamp が `stamp0-missing`・`unavailable` でも数える。`stale` は [artifact] | sample ごとの「admit から query まで commit が無かった」という Native の観測を、製品のコードの契約（worker の identity の検査、合流の前の再検証）と harness の推論で代える。保証の範囲は同等かそれ以上と読めるが、証拠は観測から契約と推論に弱まる。条件に `driftAtQuery` の差分 0 と `prepareFailures` 0 を入れ、観測できる部分を足す | first-render 163、follow-up 107、欠落 **0/270**（ただし N-c の期待寄与の照合は s6r1 の受領書に親の寄与の記録が無く当てられない。表示された一覧は variant の中で first-render と follow-up が一致した） | (i) の変更に加え、stamp の条件を「`matched !== false`」に、`readyFresh` を R-6 に。親の寄与の記録（`k64-record.mjs` の child と同じ `material-revision` の照合）を足す。試験 | はい（R-7） |
| (iii) 分母から外す | `matched !== true`（`stamp0-missing`・`unavailable`）の sample を、窓内に合流したかどうかに関わらずすべて分母から外し、件数と理由を別に開示する。残りで欠落率と case ごとの表示を求める | K6/2:695 の「分母から除かず」と K6/4 の「分母を pool すること」を弱める。stamp が取れなかった sample の振舞いが判定から消える（stamp の取れやすさが Graph の振舞いと独立でなければ偏る） | pool **3**（first-render 2、follow-up 1）、欠落 0、許容 floor(0.03)=0。表示 0（pool 0）の variant が 6 つ（G-02、G-03、G-04、G-07、G-08/base-usable、G-08/graph-recovered）で、K6/4:167 により **HOLD** | availability（`summarizeSteadyState` の分母）、quality-verdict、受領書の schema の開示欄、試験 | はい（R-8） |
| (iv) 製品で stamp を取る | 製品の owner が S0 を確実に取れるようにする（例: release の後に上限つきで待って読む、読めなければ取り直す）。契約は (i) のまま、候補の限定にその製品の変更を足す | 何も弱めない。ただし製品の変更で、D′ の準備の時間（Graph の到着、first-render の窓内の率）と D-final（同じ `admit` を通る。`nir1_graph_dfinal.rs:423`）に影響しうる | 参考値は出せない（製品が変わる）。s6r1 では 267/270 が `stamp0-missing` で、今の製品はこの経路で S0 をほとんど取れていない | 製品の変更（この契約の外で、別の lane、独立レビュー、試験、GDX-PRECHECK-001 の lifecycle の確認が要りうる）。harness は (i) と同じ。admission に候補の祖先の照合 | いいえ（契約の値と規則は弱めない） |

- **採らない形（記録）**: (iii′) 窓内に合流した `stamp0-missing` の親だけを分母から外す形は、失敗になる sample だけを結果を見て外すことになり、K6/2:617 の「分母から除く」攻撃と K6/4 の In-scope attack 5 に当たるので、選択肢に置かない（参考: s6r1 では pool 109、欠落 0 だが、G-03・G-08/base-usable・G-08/graph-recovered が pool 0 で HOLD）。(ii-b) 再検証と worker の検査の結果を評価 build の Native の記録に足して観測にする形は、Native（評価 feature）のコードの変更で、この契約の確認だけでは行えない（K6/5 の批准 9）。(ii) を選んだ後に別の lane で足すことはできる。
- **どの案でも R-6 は要る**: R-6 を当てないと、R1 の下では定常状態の first-render が構造上 0 件のまま（s6r1 と同じ）で、D=40 ms で窓内に合流する親が増えるほど欠落が増える。

## ユーザーが批准すること

1 回の明示の承認で扱うのは次の 9 点と、各項目が指す節の記述である。範囲の正本はこの一覧で、台帳の `confirmedScope` はこの一覧を指すだけにする。

1. 行の内容: /6 の行は、/5 の行（/4 の行に /5 の「変える点」の 1〜7 を当てたもの。K6/5 の批准 1）に、この draft の「変える点」の 1〜8 を当てたものとする。表にない /5 の行の記述は変えない。
2. 準備の句（「変える点」の 1、R-6）。
3. 鮮度の印の句（「変える点」の 2）: ユーザーが選んだ 1 案（選んだ後の改訂で 1 案だけを残す）。(ii) なら R-7、(iii) なら R-8 が緩和に加わる。(iv) なら候補の限定（「変える点」の 6）に製品の変更が加わる。
4. first-render の条件の明文と狭める項目（「変える点」の 3、N-a〜N-d）と、K6/5 の変える点 5・K6/5-P1 の読み替え（「変える点」の 4）。
5. 開示と品質と記録（「変える点」の 5、6 の前半、7）。
6. 緩和の一覧（R-6 と、選んだ案に応じて R-7 か R-8）と、これらが合格基準の緩和に当たること。
7. 効力と事前登録の凍結（「変える点」の 8。K6/5 の批准 7 と同じ 2 段）: (i) は /6 の行のうち (ii) 以外のすべてで、この承認で確認される。(ii) は K6/2 の 614 行の Delta、620 行の末尾の Lane unlocked、621 行の受入れへの影響に /4・/5・/6 の読み替えを当てたもので、事前の確認にとどまる。/6 で判定する CP-4 の run と条件の判定に使う診断は、/6 の凍結の後に始めたものに限る。s6r1 を含む /6 の凍結の前の receipt は使わない。
8. 変えないもの: 「前書き」の「変えないもの」。
9. 許さないもの: この確認そのものによる製品のコードの変更（案 (iv) を選んでも、製品の変更は別の lane で行う）。/6 の後に first-render の条件を広げること（新しい draftRef でだけ行う）。D、Hybrid p95 の上限、T_late、W_f、T_show、1% の変更。Gold、G-case の fixture と setup（seed の pin を含む）、凍結済みの trace の file の変更。新しい authority・保存先・送信先・製品の入口。Graph の公開（PUB-G）と Session C-1 の承認。条件の成立の判定そのもの。/5 の行と /6 の行を、結果を見て選び分けること。s6r1 の受領書を /6 の行で読み直して判定に使うこと。依存する契約と、K6/2・K6/3 のほかの contractId の行（`nir1-final-request-packing-eval`、`g01-eval-revision`）と `nir1-l6-l9-contract-proposal/7` の行は確認しない。

注記（批准の対象ではない）: 2026-11-07 のユーザーの回答（問 1、問 2）は起案の指示と選択で、確認文ではない。R-6 の読み、「変える点」の 3 の狭める項目、harness の表、鮮度の印の句の 4 案の書き分けは、起案者が integrator の指示（定常状態の first-render の数え方と、それに連動して直す箇所だけを変える）を受けて置いたもので、ユーザーの選択を経ていない。

## 前書き

| 項目 | 値 |
| ---- | -- |
| draftRef | `nir1-final-request-eval-proposal/6` |
| contractId | `graph-eval-procedure`（K6/2 の条件付きの行、K6/4・K6/5 の行と同じ。理由は「確認文」） |
| 版 | 初版（2026-11-07）。下の「改訂の履歴」 |
| 起案日と基点 | 2026-11-07。製品 repo は origin/master `a2309b95`（#827。候補の worktree `cp4-formal-k65` と同じ commit）で確かめた。契約の bytes は `claude/nir1-contracts`（`ce302ea1`）の worktree で読んだ。K6/5 の SHA-256 `1ad1088498e43dc3cd0deb1b7d74f18396eb3c07d4bd3834a8787de30ecd24a7`、K6/4 の `d205b35f71da6db3fe94ae881e1e500941090a8261b95343a3a50def5f6323c3`、K6/2 の `4ccca08314c022fd969308fa969e6fcb3e2c439fe12757bfec0e901b905676f8` は contracts で再計算し、K6/5 の凍結の記録（`k65-freeze-record.md`）と K6/5 の前書きの値と一致した。以下「K6/5:n」「K6/4:n」「K6/2:n」はそれぞれの draft の行 |
| baseline | `nir1-final-request-eval-proposal/5#graph-eval-procedure`（2026-11-07 に確認。凍結は `claude/nir1-contracts` の `07fc80ec`。`k65-freeze-record.md`） |
| 前提 | 候補は K6/4 の批准 5 の (a)〜(c) と K6/5 の変える点 6（製品の D が 40 ms）を満たす。定常状態の sample の前提は K6/4 の R1。D′ の製品は保留した query のために worker を準備してすぐ答え、READY を公開せず、query の後に slot を `empty` に戻す（`nir1_graph_product.rs:2376-2381`） |
| 変えないもの | K6/5 の「変えないもの」（K6/5:63）と、K6/5 の「変える点」の 1〜7 の値と読み（D 40 ms、Hybrid p95 の上限 94.2 ms、B 54.2 ms、T_late 100 ms）。W_f 100 ms、T_show 2 s、1%、失効率の定義と物差し、F1〜F7、X1〜X13、R1〜R6・R8 の文面、R7 の既存の項目、K6/4-P1〜P3、K6/4-N1〜N40、K6/5-N1〜N4、技術点 1〜3、批准 5 の候補の限定、批准 12 の製品の変更の要件。(b)（実際の操作の trace）の規則（K6/2:715-737 と K6/4 の変える点 15。trace の first-render は K6/2 の規則 2 のままで、`readyFresh` と stamp を要らない。`followup.mjs:485-490` の `trace` の側）。K6/2 の規則 4 の区分（K6/2 の読みの記録に使う）。K6/2 の品質の手順 8 の K6/2 の読み（K6/4 の候補の限定を満たさない候補に使う）。Gold、G-case の fixture と setup、trace の file。K6/2、K6/4、K6/5 の bytes |

### 改訂の履歴

| 版 | 日付 | 中身 |
| -- | ---- | ---- |
| 初版 | 2026-11-07 | 最初の起案。鮮度の印の句は 4 案を並べたまま |

## 引き継ぐもの

1. /5 の行の内容を baseline とし、この draft の「変える点」の表を当てたものを /6 の行の内容とする。表にない記述は変えない。番号は「/6 の変える点 n」と呼ぶ。
2. /5 の行との関係: /6 の確認の後、CP-4 の可用性と品質の判定（批准 7 の (i)）は /6 の行で行う。/5 の行は確認の履歴として残し、台帳の行と /5 の凍結（`07fc80ec`）は消さない。/5 の下で取った receipt（s6r1）は、その時点の候補の記録として有効なまま（HOLD）で、/6 の判定には使わない。/6 の確認の後は /5 の行で新しい判定をしない。
3. 事前登録: /5 の凍結の記録は残す。/6 の凍結は別の新しい commit で行う。K6/2 の 157 行（事前登録の凍結の 4）に従い、/5 の凍結の後にこの起案者が見た観測を書く: s6r1 の正式 run の受領書（Gold 13、parity 12、negative 3、trace 2、SP-P4、G-01 の診断）、S6 の集計（`s6-aggregation-s6r1/`、訂正 `ce302ea1`）、品質判定（`quality-verdict-s6r1-1/`）、Opus の独立検査の結論（ユーザーの決定の記録の前提）、起案者が Gold の受領書から数えた stamp と D′ の counter の内訳（「鮮度の比較」の節）。**この draft の規則（R-6、N-a〜N-d、4 案の書き分け）は、すべてこれらを見た後に選んだ**。どの観測も /6 の判定に使える診断ではなく、予告として扱う。

## 変える点（/5 の行との関係）

次の表の文だけを置き換える（または読み替える）。表にない記述は変えない。**1 は /5 の行（の harness の読み）より弱い読み**（R-6）。**2 は案によって弱い読み**（(ii) は R-7、(iii) は R-8）。3 は狭める防御、4 は 1〜3 に伴う読み、5〜7 は開示・品質・記録・候補、8 は事前登録の扱い。

| n | 箇所 | 旧（要旨） | 新 | 理由 |
| - | ---- | ---------- | -- | ---- |
| 1 | 準備の句: K6/2:695 の最終文「開始時に READY でなかった sample …も、分母から除かず窓外に数える」（K6/4 の変える点 4 が同じ手順 3 の前提を R1 に替えた後の読み） | 開始時に slot が新しい READY でなかった sample は (a) で窓外。harness は `startSlot.readyFresh === true` を求める | 「開始時に READY でなかった sample」は、R1 の下では次のどれかに当たる sample と読む: (a) R1 の (1)〜(4) を満たさなかった（`reachedQuiet` が true でない、または R1 の 4 項目を記録から計算し直した値が自己申告と合わない）、(b) その sample のための新しい準備が観測されなかった（親の Native の begin の記録がちょうど `pending` の 1 件でない、その sample の `dPrimeCounters` の差分が `deferredReleased` 1・`staleReadyRetired` 0・`prepareFailures` 0 でない、`startSlot.kind` が `empty` でない）。これらは分母から除かず、first-render にも follow-up にも数えない（X10 と同じ扱い）。`startSlot.readyFresh` は R1 の下では構造的に false なので、first-render の条件に使わず、開示（`notReadyAtStart`）にだけ残す | K6/4 の変える点 4 の帰結の明文化。K6/2 の目的（前の準備の残りではなく、その sample のために新しく準備した worker の結果だけを数える）を D′ の観測できる形で保つ（R-6） |
| 2 | 鮮度の印の句: K6/2:695 の最終文「鮮度の stamp が一致しなかった sample も、分母から除かず窓外に数える」、DR-CP4-S1C1-8 の「`stamp0-missing` も … 窓内にしない」（lane の判断記録。契約ではない） | stamp が `fresh`（`matched: true`）でない sample は (a) で窓外 | **未決（ユーザーが選ぶ）**。(i) そのまま（`matched === true` を求める）。(ii) `matched !== false` を求める（`stamp0-missing`・`unavailable` も数え、`stale` は N-d の [artifact]）。あわせて `dPrimeCounters.driftAtQuery` の差分 0 を求める。(iii) `matched !== true` の sample を分母から外して別に開示し、残りの pool で判定する（K6/4:167 の case ごとの HOLD は残りの pool に当てる）。(iv) (i) のまま、候補の限定に製品の S0 の変更を足す（6）。選んだ案だけを残す改訂の後に確認に出す | 「鮮度の印の句の選択肢」の節 |
| 3 | 定常状態の first-render の窓内の定義: K6/4:167（「K6/2 の手順の 5 のまま、D、worker 由来の結果だけ」）、K6/4:52（用語）、K6/4-P2（:227）、K6/2:705（手順 5）を定常状態に当てる箇所、K6/2:708（手順 8 の「worker 由来の Graph の結果が窓内に届いた sample」） | 窓内・worker 由来（harness はさらに `readyFresh` と stamp の一致） | 定常状態の sample を first-render の窓内に数えるのは、次をすべて満たすときだけ: FR-1 親の合流が D（40 ms）の窓内に、返却時の再検証を通った worker の結果を受けた（`classifyJoin` の窓内。出所が `Cached` なら数えない〔K6/4-N39〕）。FR-2 1 の (a)(b) に当たらない（R-6）。FR-3 2 の選んだ案の stamp の条件。FR-4（N-b）sample の全体で owner の counter の差分が `begins` 1・`lateCached` 0・`cacheHits` 0 で、R2 の終わりの cache が空。FR-5 親の宣言が `used`、`publishCount` 1、親の窓（`graphWindowMs`）が D と一致（K6/5 の変える点 6）。FR-6 sample の終わり（R4）までに `graph-ready` の通知も子も無い（K6/4-P2 の「子は出ない」を観測で確かめる。あれば数えず、記録の異常として開示する）。FR-7（N-c）「Graph を持つ」: 再検証を通った Graph の edge が 1 件以上あり、事前登録した期待寄与の材料（K6/2 の手順 4）から寄与がある（F6 と同じ単位。DR-CP4-F-6 の `material-revision`）。FR-8（N-d）窓内に合流した親の stamp が `stale` なら [artifact] で止める。親の表示に D の後の Graph が混ざった、または親が 2 回以上公開した場合は、first-render の成否と別に FAIL（K6/4-N1。変えない） | 1 と 2 を当てた条件を 1 か所に書き、R1 と同じ水準の狭める防御を first-render にも当てる（F2・F6・X10 と対称にする） |
| 4 | K6/5 の変える点 5（K6/5:92）の「その sample は K6/4-P2 で first-render の窓内に数え、子は出ない（規則は変えない）」と K6/5-P1（K6/5:121）。K6/4:299（H1）の「`steadyStateInWindow` は first-render の記録として残し」 | D=40 ms の窓内に親が Graph を受けた sample を数える（R1 との関係は書かれていない） | 「K6/4-P2 で first-render の窓内に数える」sample は 3 の FR-1〜FR-8 を満たす sample と読む。K6/5-P1 は K6/6-P1 で置き換える（受入れ）。H1 の `steadyStateInWindow` は 3 の条件を実装したものに置き換え、K6/2 の字義の条件（`readyFresh`、stamp の一致）は開示の内訳としてだけ残す | (甲)(乙) の食い違いを解く |
| 5 | first-render の窓外率（K6/4 の変える点 1。開示）と K6/2:695 の「cache から返った結果 … 件数を receipt に出す」 | K6/2 の字義の条件で求める | first-render の窓外率は 3 の条件で求めて書く。あわせて、K6/2 の字義の条件での件数（`notReadyAtStart`、`stampMismatch`、`stampWithoutComparison` と stamp の result の内訳）、1 の (a)(b) に当たった件数、3 の FR-4〜FR-7 のどれで数えられなかったかの件数を case ごとに書く（開示だけ） | どの条件で数えたかを結果を見て選ばせない |
| 6 | 品質（K6/4 の「品質」、K6/2:708）と候補の限定（K6/4 の批准 5、K6/5 の変える点 6） | 表示された sample の表示の結果で測る（first-render は親の合流の結果） | 変えない（first-render なら親の合流の結果）。親の合流の結果について、子と同じ形の寄与の記録（edge の Revision の照合）を取り、Evidence の照合に使う。同じ case の表示の結果は first-render と follow-up を問わず同じでなければ FAIL（K6/4-N13）。候補の限定: 案 (iv) を選んだときだけ、製品の S0 の変更の commit を祖先に含む候補に限る（admission で照合、合わなければ `[precheck]`） | 3 の FR-7 と対にする |
| 7 | R7（query ごとの記録） | （既存の項目） | 既存の項目を変えずに足す: `startSlot.kind`、親の Native の begin の記録の並び、`dPrimeCounters` の差分（`deferredReleased`、`staleReadyRetired`、`prepareFailures`、`driftAtQuery`、`stamp0Missing`）、stamp の result と `matched`、sample の終わりまでの通知の記録、親の寄与の記録、3 の判定の内訳（FR-1〜FR-8 のどれを満たしたか） | 3 の判定を記録から計算し直せるようにする |
| 8 | 事前登録の凍結と効力の時点: K6/5 の変える点 7（K6/5:94） | 「この file」は /5 の bytes | 「この file」は /6 の bytes。/6 で判定する CP-4 の run と条件の判定に使う診断は、/6 の凍結の後に始めたものに限り、receipt の先頭に /6 の凍結の commit と SHA-256 を書く（/6 の行は /5 と /4 の bytes の上に立つので、/5 と /4 の凍結の commit と SHA-256 も併せて書く）。/6 の凍結の前の観測（s6r1 の受領書を含む。「引き継ぐもの」の 3）は予告で、/6 の判定に使わない | /5 の変える点 7 と同じ形 |

## 本文に入れないもの（手順の側で扱うもの）と理由

| 事項 | 本文に入れるか | 理由 |
| ---- | -------------- | ---- |
| 品質判定の G-08 の子の扱い（ユーザーの決定 2026-11-07 の問 2） | **入れない**。品質判定の事前登録の新しい版（contracts `docs/plans/nir1-cp4-records/quality-verdict-prereg-v2-draft.md`）で扱う | 品質判定は手順外の補助の記録（DR-CP4-QV-0・QV-1）で、この行の判定（可用性の HOLD の規則）を置き換えない。K6/4:52 の「子」（`graph-ready` で出す 1 回の再 query）の定義は /6 で変えない。`index-ready` の再 query は K6/4 の X7 で follow-up に数えず、この行の可用性の判定にもともと入らない |
| DR-CP4-S1C1-8 の改訂 | 入れない。/6 の確認の後に、選んだ案に合わせて `cp4-decisions.md` に新しい DR を足す | lane の判断記録で、契約の行ではない |
| 案 (iv) の製品の変更 | 入れない。選ばれたら別の lane で起案する | この確認による製品のコードの変更を許さない（批准 9） |

## threat model（/5 の行への加算）

この draft は新しい外への通信、保存、authority、subprocess、背景の処理、async の lifecycle を加えない（評価の読みと記録の項目だけを変える。案 (iv) の製品の変更は別の lane で GDX-PRECHECK-001 を当てる）。

- In-scope attacks（加える）: 21. R1 を満たさない、またはその sample のための新しい準備が観測されない sample を first-render に数える（1）。22. 前の sample の準備の残り（`staleReadyRetired` のあるもの、begin が 2 件以上のもの）の結果を first-render に数える。23. 窓内に合流した親の stamp の結果によって、first-render に数えるか、分母から外すかを、結果を見て選ぶ（2 で 1 案に固定する）。24. stamp が取れなかった sample のうち、失敗になるものだけを分母から外す（(iii′)）。25. 寄与の空の Graph、期待寄与の材料からの寄与の無い Graph を first-render の成功と数える（FR-7）。26. 子や `graph-ready` の通知が出た sample を first-render と数える（FR-6）。27. 準備の句と鮮度の印の句の試験を、R1 の下で起きない fixture（`readyFresh: true`、slot が `ready`）だけで済ませる（K6/5-P1 で起きた形）。28. s6r1 の受領書、または /6 の凍結の前の dev の予行を /6 の判定に使う、/5 と /6 の行を結果を見て選び分ける。
- Mandatory defenses（加える）: 「変える点」の 1〜3、5、7、8。3 の条件は観測の前に /6 の凍結と手順のファイルの版（下の harness の表）で固定し、独立 reviewer のレビューを受ける。分類器は、R1 の下の現実の形の合成の記録（`startSlot: { kind: "empty", readyFresh: false }`、stamp が `stamp0-missing`・`fresh`・`unavailable`・`stale` のそれぞれ、`dPrimeCounters` と counter の差分つき）で受入れの K6/6-P・N を期待どおりに分けることを観測の前に示して記録する。**S4 の凍結の前に、D=40 ms の候補で、Gold の G-case の定常状態の dev の予行（preview。判定に使わない）を 1 回以上行い、3 の FR-1〜FR-8 の各条件について満たした件数と満たさなかった件数を記録し、窓内に合流した親が 1 件以上あるのに first-render が 0 件、または FR のどれかが全件で同じ値（構造的に一定）なら、凍結に進まず integrator に返す**（s6r1 の前にこの予行が無く、構造上数えられないことを見落とした）。予行の結果は予告で、/6 の判定に使わない。
- Acceptance implications（読み替え）: K6/5 の Acceptance implications のとおり（D 40 ms、Hybrid p95 の上限 94.2 ms）。定常状態の first-render は「変える点」の 3 で読む。ほかは変えない。

## 受入れ（/5 の行への加算）

番号は `K6/6-` を付ける。CP-4 の分類器は、合成の記録で次を期待どおりに分けることを観測の前に示して記録する（K6/4:209 と同じ）。**合成の記録の基は、s6r1 の受領書の実際の sample の形（R1 の下の値）にする**（`test-support.mjs` の `readyFresh: true`・slot `ready` の fixture を基にしない）。

- K6/6-P1（K6/5-P1 を置き換える）: `startSlot.kind: empty`、`readyFresh: false`、R1 を満たし、begin が `pending` の 1 件、`deferredReleased` 1、counter の差分 `begins` 1・`lateCached` 0・`cacheHits` 0、親が D=40 ms の窓内（Raw-ready の後 11、25、40 ms）に worker の結果を受けて `used`、通知と子が無く、寄与がある sample は first-render の窓内で、子は出ない。stamp は 2 の選んだ案で数える側の値（(i) と (iv) では `fresh`、(ii) では `fresh`・`stamp0-missing`・`unavailable` の 3 通り、(iii) では `fresh`）で確かめる。
- K6/6-P2: 3 の条件を満たす first-render の sample と follow-up の sample が同じ case にあり、表示の結果が同じなら、品質を両方の表示の結果で測る。
- K6/6-N1: R1 の `reachedQuiet: false`、または R1 の 4 項目の計算し直しが自己申告と合わない sample で親が窓内に合流した（数えない。X10）。
- K6/6-N2: 親の begin が 2 件以上、`staleReadyRetired` 1、`deferredReleased` 0、`prepareFailures` 1 以上、`startSlot.kind` が `empty` でない、のどれかの sample で親が窓内に合流した（数えない）。
- K6/6-N3: 2 の選んだ案で数えない stamp の値の sample（(i)・(iv) では `stamp0-missing` と `unavailable`。(ii) では該当なし。(iii) では分母から外れ、開示の件数に入る）。
- K6/6-N4: 窓内に合流した親の stamp が `stale`（`matched: false`）の記録（[artifact] で止まる）。
- K6/6-N5: counter の差分が `lateCached` 1 以上、`cacheHits` 1 以上、または R2 の終わりに cache が残った sample の窓内の親（数えない）。
- K6/6-N6: 窓内に合流した親の後に `graph-ready` の通知か子が出た sample（first-render に数えず、記録の異常として開示）。
- K6/6-N7: 窓内に合流したが edge が 0 件、または期待寄与の材料からの寄与が無い親（数えない）。親の寄与の記録が欠けた親も数えない（照合できたとしない）。
- K6/6-N8: (iii) を選んだ場合: 窓内に合流した `stamp0-missing` の親だけを外し、graph-late の `stamp0-missing` を分母に残した receipt（(iii′)。拒否）。
- K6/6-N9: receipt の先頭に /6 の凍結の commit と SHA-256 が無い、または /6 の凍結の前に始めた run（s6r1 を含む）の receipt を /6 で判定した。
- K6/6-N10: 案 (ii) を選んだ場合: `dPrimeCounters.driftAtQuery` の差分が 1 以上の sample の窓内の親（数えない）。

## 範囲と他の lane への影響

| lane | 影響 |
| ---- | ---- |
| CP-4 の手順（S2 追補、S3、S4 の 7 回目の凍結） | harness の変更（下の表）、/6 の凍結の head の receipt への記録、K6/6-P・N の合成の記録による検出力の記録の取り直し、D=40 ms の Gold の定常状態の dev の予行（Mandatory defense） |
| 品質判定（手順外の補助） | 事前登録の新しい版（v2。別 file）。表示の判定が /6 の 3 に従うので、表示された sample が増える見込み |
| DR-CP4（lane の判断記録） | DR-CP4-S1C1-8 の「(a) では窓内にしない」の改訂（選んだ案に合わせる） |
| 製品 | 案 (i)〜(iii) では影響しない。案 (iv) なら別の lane（D-final の到達にも影響しうる） |
| PUB-G／Session C-1 | 開示の項目（first-render の窓外率）の求め方が 3 になる。PUB-G の承認は置き換えない |
| parity、診断の負例（N2〜N4）、SP-P4、G-01 の診断 | 影響しない（parity は R と R+IR だけで Graph を測らない。負例は `returnedSceneIds` で判定し、表示の判定を使わない〔`frozen-diagnostics.mjs:790-850`〕。SP-P4 と G-01 の診断は first-render の数え方を使わない） |
| DD-1、DP-H、K6/3、P の評価 | 影響しない |

### この draft が確認されたときに変わる harness の file（実装はしない。製品 repo の `a2309b95` の行）

| file | 変わる中身 | pin（S2 の `SOURCE_PINS`） |
| ---- | ---------- | --- |
| `scripts/quality/nir1-graph-eval/join.mjs` | `:113-120` の `steadyStateInWindow`: `readyFresh === true` を 1 の条件（R1 と新しい準備の観測）に、`freshnessStamp.matched === true` を 2 の選んだ案の条件に置き換える。注記（`:108-112`）を /6 に。K6/2 の読み（K6/4 の候補の限定を満たさない候補）の判定が要るなら、K6/2 の字義の関数を別名で残す | `p1-harness-core`（`865a3e2b`。pin のし直し） |
| `scripts/quality/nir1-graph-eval/followup.mjs` | `:485-490` の定常状態の `firstRender` を 3 の FR-1〜FR-8 にする（R1 の検査〔`:587-595`〕を first-render の判定の前に当てる、counter・通知・子・寄与の条件、`stale` の [artifact]）。`:600-608` の F1 `parent-joined` は、3 を満たさない窓内の親の失敗の理由として残し、どの FR で落ちたかを detail に書く。trace の側（`context: "trace"`）は変えない | `k65-merge-followup`（`8489ae57`。pin のし直し） |
| `scripts/quality/nir1-graph-eval/availability.mjs` | `:283-288` の case ごとの開示（`inWindow`、`notReadyAtStart`、`stampMismatch`、`stampWithoutComparison`）に、1 の (a)(b) と FR ごとの件数を足す（5）。案 (iii) なら `summarizeSteadyState` の分母と case ごとの HOLD を残りの pool で求め、外した件数と理由を別に出す | `p1-harness-core`（pin のし直し） |
| `scripts/quality/nir1-graph-eval/run-sample.mjs` | `:361-375` の `windowOutCause`（preview の開示）の `not-ready-at-start` を、1 の (a)(b) の理由に置き換える（R1 の下では全件が `not-ready-at-start` になり意味を持たない）。`:390-430` の `previewSummary` の `workerLate` も同じ | `p1-harness-core`（pin のし直し） |
| `scripts/quality/nir1-graph-eval/k64-record.mjs` | 親の合流の結果について、子と同じ `contributionBasis`・`materialRevision`（edge の Revision の照合。DR-CP4-F-6）を記録する（FR-7、「変える点」の 6）。R7 の追加の項目（7）を記録に写す | 実装の時に `harnessPinOf` で確かめる |
| `scripts/quality/nir1-graph-eval/outcome.mjs` | `:370-` の `k64AvailableQuality` は `classifyFollowUp` に従うので中身は変わらない見込み。`:314-` の `k62AvailableQuality`（K6/2 の読み）は変えない | `p2p3-harness-admission`（変えなければ不要） |
| `scripts/quality/nir1-graph-eval/constants.mjs`、`procedure-file.mjs`、`procedure/k64-procedure.v2.json` → v3（新規。値は v2 と同じ） | /6 の凍結の descriptor（path、sha256、draftRef `nir1-final-request-eval-proposal/6`、contractId、confirmedCommit、freezeCommit）を足す。手順のファイルの `contract` を /6 に（値の key と値は変えない）。v2 を残して /6 の束縛を S2 にだけ置く形もありうる（実装の時に決める） | `k65-freeze-source`、`k65-harness-d40`（pin のし直し） |
| `scripts/quality/nir1-graph-eval/admission.mjs`、`frozen-k64-admission.mjs`、`receipt.mjs`、`frozen-diagnostics.mjs`、`diagnostic-runner.mjs` | `head.k66`（/6 の凍結）の読取と照合。案 (iv) なら候補の祖先に製品の S0 の変更を求める照合 | `k65-g01-e2e-admission`、`k65-harness-d40`、`k65-receipt-p95-head`、`k65-n2-n3-enforcement`（pin のし直し） |
| `scripts/quality/nir1-graph/observation-prep.mjs` | `CONTRACTS` に /6 を別の key で足す（`CONTRACTS.k64` は trace の束縛のため K6/4 のまま）。`K64_VALUES`（`:409-414`）は変えない | 凍結の検査そのもの |
| `scripts/quality/nir1-graph-eval/quality-verdict.mjs`、`quality-verdict-cli.mjs` | 品質判定の事前登録 v2 に合わせる（別 file の草稿） | pin の外（DR-CP4-QV-1） |
| `evals/nir1-graph/observation-prep.v1.json`（S2 追補） | `contracts` に /6、`userConfirmations` に /6、`k66Readings`（R-6、選んだ案、FR-1〜FR-8、dev の予行の記録、s6r1 を見た後の改訂であることの開示）、`k64Procedure`（v3 にするなら） | S4 が束縛 |
| `evals/nir1-graph/observation-prep-freeze.v1.json` | S4 の 7 回目の凍結 | — |
| 試験（`followup.test.mjs`、`join.test.mjs`、`availability.test.mjs`、`k64-record.test.mjs`、`test-support.mjs`、quality-verdict の試験） | K6/6-P1・P2、K6/6-N1〜N10 の合成の例を、R1 の下の現実の形（`startSlot: { kind: "empty", readyFresh: false }`、stamp の 4 値、`dPrimeCounters` と counter の差分）で足す。`test-support.mjs` の既定の fixture（`readyFresh: true`、stamp `fresh`）は K6/2 の読みの試験に残し、/6 の試験には R1 の形の fixture を別に足す。K6/5-P1 の試験は K6/6-P1 に置き換える | 試験は pin の対象外 |
| 検出力の記録 | K6/6-P・N の合成の記録で取り直す（前回は contracts `3675c50e` の `k64-k65-synthetic-detection-record.md`） | — |
| 変えないもの | trace の file（`trace-editing.v1.json`・`trace-browsing.v1.json`）、`trace-record.mjs`、(b) の分類、T_late・W_f・T_show・D の定数と照合、Gold、fixture、`K64_VALUES` | — |

S4 が pin する harness の変更は、S4 の枝でだけ merge する（単独で merge すると merge の後の master の照合が赤になる。2026-11-07 の C7 #826 の前例）。

## 確かめられなかったこと

1. `stamp0-missing` がこの経路でほぼ全件になる原因（release の直後の admit で main connection を何が握っているか）。案 (iv) の設計にはこれが要る。
2. worker の identity の検査と返却時の再検証が、実機の G-case で stamp の一致と同じ件を落とすか（コードの読みだけで、`stale` と `RegistrationDrift` と `SealMismatch` の頻度を比べる記録は無い）。s6r1 の pool では `driftAtQuery` の差分は全件 0、`stale` の stamp は 0 件だった。
3. 親の合流の結果の寄与の記録（FR-7）を、今の hook の消費者の記録から取れるか（子と同じ形の記録が親にもあるかは、`k64-record.mjs` の実装の時に確かめる）。取れなければ FR-7 は全件不成立になり、dev の予行で検出される。
4. `dPrimeCounters` が sample ごとの差分であること（s6r1 の受領書では `stamp0Missing` の値が stamp の result と一致したので差分と読んだ。harness の実装で確かめる）。
5. D=40 ms の G-case で、R-6 と各案の下の first-render の率（s6r1 の値は予告の参考値で、取り直しの run で変わりうる）。
6. この draft の独立レビューはまだない。

## 確認の扱い

- 確認は、台帳の Confirmation protocol に従い、`nir1-final-request-eval-proposal/6` と `graph-eval-procedure` を曖昧さなく特定するユーザーの明示の承認で行う。構造化質問なら、質問の文が draftRef、contractId、この draft（選んだ案だけを残した改訂）の SHA-256 を名指し、ちょうど 1 つの `draftRef#contractId` を示す。承認の効力は批准 7 の 2 段。
- 確認の前に、鮮度の印の句の案をユーザーに選んでもらう（選択の質問は確認ではない）。質問の文には、4 案それぞれの守っていたもの・弱まるもの・s6r1 での参考値（予告）・harness の変更・緩和かどうか（比較の表）と、どの案でも R-6 が要ることを書く。
- 確認の質問の文には、(1) 緩和の一覧（R-6 と、選んだ案に応じて R-7 か R-8）、(2) 狭める項目（N-a〜N-d、FR-1〜FR-8）、(3) D・p95 の上限・T_late ほかの値は変えないこと、(4) s6r1 は HOLD のままで、/6 の判定は /6 の凍結の後の run に限ること、(5) この改訂は s6r1 の観測の後に起案したこと、を書く。
- 2026-11-07 のユーザーの回答（問 1、問 2）、計画への同意、merge の指示、包括的な返答は、確認として扱わない。
- この draft は合格基準の緩和を含みうるので（R-6、案によって R-7・R-8）、続行計画 §12.1 の「重要な変更」（(3) 確認済みの閾値・合格基準の緩和）にあたる。CP-4 は AGENTS.md の NIR-1 の残レーンに入っておらず、技術判断の事前委任も無い。

### 確認までの手順（前例どおり）

1. 起案（初版、この file）。
2. 独立レビュー（read-only。この draft、K6/5・K6/4・K6/2 の引いた行、harness の引いた行を渡し、起案者の結論は渡さない）。改訂。
3. ユーザーが鮮度の印の句の案を選ぶ。選んだ案だけを残す改訂。必要なら再レビュー。確認に出す版の SHA-256 を確定する。
4. ユーザーの確認と確認の記録（`user-confirmation-2026-11-xx-k66-graph-eval-procedure.md`。質問と回答の逐語、日付、draftRef#contractId、SHA-256）。
5. contracts の凍結（`k66-freeze-record.md`。K6/2 の「事前登録の凍結」の 1〜7）。台帳の更新（master への PR。byte 同一の取り込み）。
6. その後に、harness の実装、試験と検出力の記録、D=40 ms の Gold の定常状態の dev の予行、S2 追補、S3 の独立レビュー、S4 の 7 回目の凍結、取り直しの正式 run。

## 確認後の記録（この draft の外で行う。台帳への取り込みの提案）

- 台帳の補足の見出し: 「2026-11-xx補足（K6/6）」。経緯に s6r1 の HOLD と機構（R1 の下の `readyFresh`、stamp の状態）、(甲)(乙) の食い違い、K6/5 の起案の見落とし、ユーザーの決定（`1e6ede44`）、選んだ案を書く。行 ID は `K6/6-1`。
- 確認台帳の行の案（/5 の行の下に足す。/5 の行は消さない）:

| contractId | draftRef | confirmedRef | confirmedScope | 備考 |
| ---------- | -------- | ------------ | -------------- | ---- |
| `graph-eval-procedure` | `nir1-final-request-eval-proposal/6` | `nir1-final-request-eval-proposal/6#graph-eval-procedure`（批准7の(i)についてだけ。(ii)は `preConfirmationRef`） | K6/6の範囲: draft冒頭の「ユーザーが批准すること」の1〜9（この一覧が範囲の正本）。/6の行の内容は、/5の行に/6の「変える点」の1〜8を当てたもの。定常状態のfirst-renderは、R1の下で、R1を満たし、そのsampleのための新しい準備（D′の保留のreleaseとprepare）が観測され、選んだ案の鮮度の条件と、counter・宣言・通知・寄与の条件（FR-1〜FR-8）を満たす親だけを数える。**合格基準の緩和**: 準備の句の読み（R-6）と、選んだ案に応じてR-7かR-8。D 40 ms、Hybrid p95の上限94.2 ms、T_late 100 ms、W_f 100 ms、T_show 2 s、1%、失効の読み、F1〜F7、X1〜X13、R1〜R8の文面は/5のまま。(b)の規則、Gold、fixture、trace、依存する契約、ほかのcontractIdの行、proposal/7の行は確認しない | (i)は確認済みで、記録の時点からCP-4の可用性と品質の判定に使う（/5の行に替わる。/5の行とs6r1のreceiptは履歴として残し、/5の行で新しい判定はしない）。/6の凍結の前に始めたrunは/6の判定に使わない。この確認は、Graphの製品公開、新しいauthority・保存先・送信先・製品の入口、製品のコードの変更を許可しない |

- 台帳の注の案: /5 の行の備考の末尾に「2026-11-xx 追記（K6/6）: /6 の確認の後、CP-4 の判定は /6 の行で行い、この行で新しい判定はしない。s6r1 の receipt は、この行の下の HOLD の記録として残る」。
- 確認されなければ、CP-4 は /5 の行のままで、R1 の下では定常状態の first-render が数えられず、D=40 ms の候補では (a) が構造上 HOLD に寄る。別の案は /7 で起案する。

## 確認文

contractId の選択: **`graph-eval-procedure`**（K6/2 の条件付きの行、K6/4・K6/5 の行と同じ）。

- 理由: (1) この差分は、/5 の行の定常状態の first-render の数え方の明文化と、それに連動する記録・開示の改訂で、新しい契約の主題ではない。(2) 新しい authority、保存先、送信先、製品の入口を加えない。(3) `nir1-final-request-packing-eval`（K6/3 の行）の内容に触れない。(4) 確認は contractId ごとの 1 回の承認。

承認の例（固定の文でなくてよい）:

- I confirm draftRef nir1-final-request-eval-proposal/6 for contractId graph-eval-procedure.
