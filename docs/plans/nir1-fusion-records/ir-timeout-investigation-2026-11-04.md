> 注（integrator、2026-11-04）：read-only の workflow（調査 3・反証の検証 3・まとめ 1。model は sonnet）。計測はしていない。数値の内訳は仮説。

# IR の timeout 調査まとめ(読むだけ・計測なし)

## 1. 結論

- **なぜ間に合わないか(仮説):** IR は「過去場面との関連」を出す機能です。この機能では、IR の検査が承認済みの件数や Scene 数に応じて重くなります。待ち時間 D=10.84 ms は件数が少ない前提で固定されているので、65 件までは何とか間に合い、123 件以上では 84/84 が timeout しました。ただし IR の到着時刻は記録に無く、実測では確かめていません。
- **作者に見えないこと:** 間に合わないと、安全な Raw(従来の検索結果)に黙って戻ります。通知も特別な表示もありません。害はありませんが、IR の価値もゼロになります。
- **後追いの有無:** 遅れた IR を同じ query に足す仕組みはありません。契約でも禁止です。あるのは「400 ms 後に新しい検索をやり直す(最大 2 回)」だけで、この再試行は IR を最初から計算し直します。規模が原因なら、同じ timeout になる見込みが高いです(推測)。
- **試運転 96 sample の注意:** 試運転は `fetchRelatedPastScenes` を直接呼んだ可能性が高く、その場合は再試行が含まれていません(未確認)。

## 2. 締切と後追いの仕組み

### 締切 D の数え方(確認済み)

- D は、画面側で Raw の選択が終わった瞬間(`tRawReadyMs`)から数えます。検索開始や IPC 返却からではありません。(`fetchNir1RelatedScenes.ts:290-296`、`nir1RelatedScenesDeadline.ts:43`)
- Native 側の IR 計算は、begin 処理の終わり近くで始まります(`begin.rs:195-227`、起動は `:267`)。そのため IR が得る先行時間は、IPC の返却と sparse の残り待ちだけです。
- 判定の終点は経路で違います。
  - Graph なしの経路は「最終の安全な結果ができた時刻」です。融合の所要時間も判定に入ります。IR が D の前に着いても、融合後に締切を過ぎれば timeout です(`awaitNir1RelatedScenes.ts:42-73`)。
  - Graph 合流の経路は「IR が着いた時刻」で判定します。融合は後で行うので、融合の時間は判定に入りません(`nir1RelatedScenesGraphJoin.ts:247-272`)。
- D の後にも、`continue` の IPC 往復と DB 再検証(`related_scenes.rs:159-207`)の時間がかかります。これは IR の到着時刻に入ります。

### 後追いの仕組み

- 遅れた IR を同じ query に足す経路も、IR 用の結果 cache もありません(確認済み)。締切を過ぎたら Raw で確定し、IR は破棄します。仕様にも「late IR を同 query に後付けしない」とあります。
- 通知用の event は 3 つです。`index-ready`、`graph-ready`、`invalidated`(撤回の信号)です。IR の遅着を知らせるものはありません。
- 製品が持つ手当ては次のとおりです。
  - **(a) timeout の再試行:** 400 ms 後に最大 2 回。毎回新しい検索になり、IR を最初から計算して D も取り直します(`useNir1RelatedScenes.ts:17-18, 365-376`)。
  - **(b) index-ready での再 query:** 索引の構築が終わった時だけです。
  - **(c) graph-ready の副作用(検証で追加):** IR が timeout し、Graph がまだ着いていないと結果は `graph-late` になります。後で Graph が届くと再 query が起き、IR も新しい D で再実行されます。ただしこれは IR を拾う仕組みではなく、副作用です。
  - **(d)** 編集やシーン切替による通常の再 query。
- W_f=100 ms は Graph 専用の窓で、IR の締切は常に D です(`relatedScenesConfig.ts:9-15`)。

## 3. 重い処理の候補と内訳の測り方

### 実測の根拠は小さい規模の値だけ

- 小さな fixture では、begin の応答から IR 到着まで中央値 6.5 ms、p90 7.2 ms でした(#768 の後)。D との余裕は約 4 ms です。
- 検査全体(proof の完全検査)が約 4.1 ms という値は `docs/plans/nir1-lane-decisions/cp4-decisions.md:1070`(DR-CP4-V-1)にあります。ただしこれは内訳ではなく全体の値です。
- 236 件規模の内訳は誰も測っていません。以下は、コードから見た候補です。

### 候補の一覧(順位づけの根拠はまだ無い)

| # | 候補 | 状況 |
|---|---|---|
| 1 | **scope-dependency の edge 再評価。** edge ごとに、その run の元データ(corpus)全体を JSON として読み直し、正準化・ハッシュ・検証する。 | 検証でコード経路を確認(`scope_authority_runtime.rs` 付近)。試運転の index にこの edge が含まれるかは未確認。含まれれば Scene 数に応じて伸びるので、「5 Scene は可、9 Scene 以降は全滅」の観測と整合する。 |
| 2 | **承認 roster の二重読み。** 完全検査の中で、全 proposal を読んで SHA-256 する処理が 2 回走る。1 回目は `canonical.rs:99`。2 回目は edge 再評価が同じ roster を再計算するため。 | 読みで確認。実行はしていない。トランザクション内で使い回せば 1 回にできる見込み。 |
| 3 | **`still_current` の 2 本の JOIN。** `revision_bindings.rs:13-127` | 承認済みだけでなく、現行 revision を持つ全 proposal を読む。2 本目は行ごとの線形探索があり、承認数×edge 数の 2 乗に近い。proposals 側の index は見つからず、全件走査の見込み(EXPLAIN は未確認)。 |
| 4 | **roster の書き出しでの制御確認。** 書き込みのたびに check を 2 回呼び、各 check が mutex を 3 回取る(`source.rs:39-52`)。 | 回数は実物と合う(write 約 1.1 万、check 約 2.2 万、mutex 約 6.5 万)。ただし 1 回 15〜20 ns 程度と見ると約 1 ms で、「数 ms」は言い過ぎ(未測定)。 |
| 5 | **admission の判定。** 候補ごとの disclosure／scope／reveal の判定。 | 「in-memory で軽い」は誤りだった。scope-dependency の control ごとに、hex デコード・JSON 解析・正準化 SHA-256 を走らせる(`narrative_scope_dependency_projection.rs:71-142`)。候補数×scope 数が数百なら数 ms になりうる(未測定)。 |
| 6 | query context の読み(約 1.9〜2.1 ms)と現在 Scene 本文の読み(5 回) | Scene 数に応じて伸びる。件数には依存しない。 |
| 7 | cosine 計算、並べ替え | 軽い(1 ms 未満の見込み)。 |
| 8 | DB 接続の取り合い(1 ms 単位の待ち) | 根拠が弱い。build の周期処理は 250 ms に 1 回で、数 ms の窓に当たる確率は低い。96 sample 中 86 の timeout は説明しにくい。 |

### 内訳を測る方法

1. **既存の仕組みで取れるもの。** `timing`(`tRawReadyMs` など)と `completion`(`deadlineExceeded`)、harness の `measure.ipc[]` の `calledAt`/`resolvedAt`。これで「begin の応答から IR 到着まで何 ms か」までは分かります。
2. **段階別の内訳。** Native に Instant 計装を足した、commit しない dev 専用 build が要ります。#768 の調査もこの方式でした。区間は次を候補にします。
   - qualify 全体と、その中の roster 読み×2、`still_current`、edge 再評価、`pending::read`
   - query context の読み、cosine、題名取得、`current_operation`
   - 接続待ちの sleep 回数
3. **規模の傾き。** 同じ project で、承認数を N=20/60/120/236 と変えて同じ query を繰り返し、区間ごとの中央値と p90 を取ります。
4. **件数と Scene 数の切り分け。** 承認数を固定して Scene 数だけ増やす条件も取ります。
5. **SQL。** `still_current` の 2 本と roster の SQL に `EXPLAIN QUERY PLAN` をかけ、全件走査の有無を確かめます。

## 4. CP-4・L0 との違いと、品質の条件への含意

### 規模の違い

| 測定 | IR の量 | IR の timeout |
|---|---|---|
| CP-4 の G-case | 1 case の承認 Revision は 2〜6 件、Scene は 4〜12 | SP-P4(正式測定 s5r6)で期限切れ 2/480(約 0.4%) |
| L0(固定 corpus) | 言語あたり 22 Scene 中 14 Scene に seed。承認数は上限の目安 14 件程度(harness の setup 次第で未確認) | build6 で 7/720(0.9722%)と 1% 上限の直下。L5 受入れ記録は 0/720。いずれも一般化を主張していない。L0 の run の timeout 数は repo 内で見つからなかった |
| 試運転(この調査) | 累計 65 / 123 / 191 / 236 件(5 / 9 / 14 / 18 Scene) | 65 件で ir-ready 10・timeout 2(12 sample)。123 件以降は 84/84 が timeout |

- 小規模では余裕が約 4 ms しかない状態でした。#768 の前は、期限切れが 60/174 でした。
- 試運転の build には #768 が含まれます(`0b1984dd` は `0e44bf23` の祖先)。それでも全滅したので、「0.3〜0.5 ms の境界効果」では説明がつきません。
- **規模が主因と言い切れない理由:** 65→123 件の間では、Scene 数 5→9 と Raw chunk 22→44 も同時に動いています。抽出直後の maintenance が並行していた可能性も排除できていません。
- **規模依存の前例:** 2026-09 の 100-current 調査で、canonical 確認 1 回が約 7〜12 ms でした(`nir1-product-impact-matrix.md:270-285`)。ただし同じ文書の後ろに、130〜160 ms という値の記録もあります。1 Revision あたりの傾きは信用できません。
- **ir-ready 10 件の中身:** 8 件は ir-empty、2 件は Raw と重複でした。IR が補充枠を使った sample は 0 件です。
- **timeout を待てば救えたか:** 試運転の counterfactual では、待てば枠を使えた候補があったのは 86 件中 3 件です。「待てば回復する」とは言い切れません。

### 契約と品質の条件への含意

- IR の timeoutRate ≤ 1% は、小規模 fixture でしか測っていません。分母は「Index が usable な全 call」で、timeout した call も分母に残ります。大きな project ではこの条件を満たせない見込みですが、「実規模で 1,300 件、4,000 件」という外挿は検証していません(推測)。
- P(Hybrid p95 ≤ 65.04 ms = B+D)は、timeout しても Raw+D で戻るので、IR の欠落を検出できません。
- 品質条件(IR が効いたか)は、IR が届いた sample でしか意味を持ちません。試運転では slot-used が 0 で、評価の分母がほぼ 0 になりました。
- 契約が固定している値は次のとおりです。
  - D、B、L0 の値、IR の timeoutRate は K6/2・K6/4 と fusion-slot material が「変えない」と明記しています。
  - post-B の計画書は B・D・65.04・T の維持までは書いていますが、timeoutRate への言及は見つかりませんでした。
  - 契約は「late IR の後付け」も許していません。
- IR の再 query を分母から外してよいかは、契約に明文がありません。graph-ready の再 query を分母に入れない規則は DSN にあります(§3.5、`nir1-dsn-2026-10.md:455-456`)。
- IR の hybrid は PUB-G(Graph の公開 gate)とは別に、現行の関連場面パネルがすでに使っています(`RelatedScenesSection.tsx:92`)。よって PUB-G の前提というより、今の製品と IR 評価の分母の問題です。Graph も同じ D の窓に乗るので、PUB-G の前に規模依存を測るのが妥当です。

## 5. 次の一手

### 読むだけ

- 試運転の harness が hook を通したか、直接呼んだかを確かめる。
- 試運転 project の index に scope-dependency の edge が含まれるかを読みで確かめる(世代 2 の revision か)。
- 承認 236 件が実使用の上限かどうかを、著者の承認傾向から見積もる。

### 計測(dev 専用・commit しない)

- 3 章の方法 2〜5 を実行する。優先は次の 3 点です。
  - 承認数 N の曲線
  - Scene 数だけを変えた対照
  - edge ごとの corpus 再読込の時間
- 試運転の Raw-ready が約 90 ms と長い理由(日本語 sparse、埋め込み、project 規模)を切り分ける。
- 並行する maintenance が IR の到着を遅らせていないかを確かめる。

### 製品の修正(原因確定後。技術判断の範囲)

- roster の二重読みを、トランザクション内で 1 回にする。digest の byte 列は変えない。
- `still_current` の 2 本の SQL をまとめる。
- scope-dependency の edge ごとの corpus 再読込を、共有または memo する。
- check を粒度の粗い境界にする。cancellation の契約に触れるので、decisions 文書で扱う必要があります。
- 完全検査を begin と qualify で 1 回にする案は、DR-CP4-V-1 で不採用です。

### ユーザーの判断

- D を延ばす、timeout 率の閾値を緩める、遅れた IR を後付けする、IR の再 query を分母から外す。いずれも AGENTS.md の委任に含まれないか、含まれるか不明です。決めていません。
- 計測のタイミングと、PUB-G の前に規模の測定を先に行うかどうか。

## 6. 確かめられなかったこと

- 236 件規模での IR 到着時刻と、各処理の実時間(内訳の測定が無い)。
- `EXPLAIN QUERY PLAN`、proposals 系の index の有無。
- scope-dependency の edge の数と payload の大きさ。
- L0 の run での IR timeout 件数(repo 内に数値が見つからない)。
- G-01 の承認 Revision 件数(fixture に一覧が無い)。
- 規模の効く主因が、承認件数か、Scene 数か、Raw chunk 数か。
- 再試行(最大 2 回)の成功率と、IR timeout 時の実際の画面。
- 実規模(100 Scene で約 1,300 件、300 Scene で約 4,000 件)での挙動。これは 1 Scene 約 13.9 件を全承認する前提の外挿で、検証していません。
- 接続の取り合いや、Graph worker が同じ接続を使うか。

参照した主なファイル:
- `src/features/related-scenes/fetchNir1RelatedScenes.ts`
- `src/features/related-scenes/awaitNir1RelatedScenes.ts`
- `src/features/related-scenes/nir1RelatedScenesDeadline.ts`
- `src/features/related-scenes/nir1RelatedScenesGraphJoin.ts`
- `src/features/related-scenes/useNir1RelatedScenes.ts`
- `src/features/related-scenes/relatedScenesConfig.ts`
- `electron/native/grimodex-node/src/related_scenes/begin.rs`
- `electron/native/grimodex-node/src/related_scenes/scoring.rs`
- `src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_chronicle_index/canonical.rs`
- `docs/plans/nir1-lane-decisions/cp4-decisions.md`

試運転の記録は `origin/claude/nir1-contracts` の `docs/plans/nir1-fusion-records/ir-trial-t-ja-1-2026-11-04/` にあります。