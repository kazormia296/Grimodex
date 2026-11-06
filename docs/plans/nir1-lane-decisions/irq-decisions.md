# IRQ の判断の記録（関連場面の IR の query が、承認済み提案の件数 N に線形に遅くなる件）

出所は PD 評価の本測定 第 6 版（`fusion-eval-data/pd-2026-11`）の g-ja-1。最終 workspace（承認済み提案 N＝884、Scene 117）で、IR の到着が窓 D（40 ms）の直下に来ていた。m-ja-2（N＝551）でも同じ形で、N が小さい分だけ早かった。基点は `origin/master` の `fba8cbaf`、branch は `claude/ir-admission-perf`。測定の装備は dev 専用の枝 `claude/ir-admission-perf-diag`（PR に入れない。末尾の「記録の置き場」）。

根拠は、ユーザーの依頼（2026-11-06、integrator 経由の「関連場面の IR の query が N に線形に遅くなる件の計測と高速化」）の範囲の性能の修正であること。IRQ が AGENTS.md の U3 の対象レーンに入るかは確かめていないので、U3 は根拠にしない。委任の外の項目（閾値の緩和、新しい送信先、保存範囲の拡大、新しい契約）には当たらない。**窓 D（40 ms、DR-IRW）・閾値・Gold・送信先・保存・契約は変えない。**

## 1. 事実（測定。第 6 版の最終 workspace の写しを使った）

測定は、既存の `scripts/quality/fusion-slot-eval/ir-timing.mjs`（複製した workspace を実 Electron で開き、末尾の Scene から 10 地点、100％ 地点の hybrid を 20 回ずつ、300 ms 間隔で呼ぶ。LLM・key は使わない）で行った。1 条件 200 サンプル。計測は Native の区間（`GRIMODEX_IR_TIMING_FILE`）で、admission の候補ごとの小区間は thread-local に合計して loop の終わりに 1 回出す。

| 事実 | 確認の結果 |
|---|---|
| cache は外れていない | 3 つの op（begin／continue／scoring）の `proof.fast_hit` はどの条件でも 200／200 が hit。`proof.total` は p50 0.15 ms。DR-CP4-V-5／V-6（#792）の audit-only の引継ぎは効いている |
| 支配項は qualify の admission loop | g-ja-1 の修正前：`scoring.run` p50 37.6 ms のうち `qualify.admit_loop` が 33.8 ms（90％）。cosine 0.84 ms、sort 2.0 ms、title 0.5 ms。loop は候補 884 件で、1 件あたり約 38 µs |
| loop の内訳（修正前、g-ja-1、p50） | `BuildCandidate::admits` の合計 29.6 ms。うち `disclosure.check_query` 2.5 ms（その中の `mappings.iter().find` は 0.46 ms）、`check_material_constraints` 26.7 ms。後者の中の `active_scope_controls` の filter が 26.6 ms で、`projection_revision` は 6.5 ms。**残りの約 20 ms は、filter が候補ごとにやり直す `ScopeDependencyIdentity::from_source_key`（hex の decode、serde_json の parse、canonical の再エンコードと比較）** |
| 事前の推定との差 | 事前の推定は `mappings.iter().find` と `projection_revision` を主とした（候補数×Scene 数）。実測では find は 1.4％ にとどまり、Scene 数への依存は小さい。支配項は、候補ごとに不変の control の Source key の decode だった。`projection_revision` は 2 番目（約 22％）。Scene 117 件でこれなので、N への線形性は decode と `projection_revision` の分 |
| 候補ごとの control | `active_scope_controls` は build 時に確定する値で、候補ごとに高々 1 件（`disclosure::prepare` が 2 件以上を拒む）。decode の結果は Source key だけで決まる |
| 評価への影響 | g-ja-1 の修正前：200 サンプル中 69 件が窓 D を超えて `timeout`。到着（begin の応答から）は p50 34.5 ms、p90 38.8 ms（到着したものだけ）。m-ja-2：18 件が timeout、p50 25.9 ms、p90 34.6 ms |

## 2. 判断の表

| ID | 日付 | 判断 | 信頼境界 | 代替案 | 状態 |
|---|---|---|---|---|---|
| DR-IRQ-1 | 2026-11-06 | **「`proof_current` の cache が毎回外れる」仮説は採らない（検証の結果）**。上の表のとおり hit が 200／200、`proof.total` は p50 0.15 ms で、O(N) の本命は qualify の admission loop | 読むだけ（dev の計装での測定）。製品の挙動は変えない | 仮説の側を直す案（cache の key の作り直し）は、外れていないので採らない | 確定 |
| DR-IRQ-2 | 2026-11-06 | **admission の候補ごとの検索・decode を、候補・query の入力から 1 回にする（意味は変えない）**。(a) `RetrievalQueryContext` に `authority.mappings` の **source_key → 位置** の `HashMap` を、authority を置く 1 か所の構築（`query_context.rs`）で 1 回だけ作り、`disclosure::check_query` の `mappings.iter().find(source_key)` をそれで引く。同じ key が複数あるときは最初の位置を残す（`find` と同じ。`entry().or_insert`）。(b) `BuildCandidate.active_scope_controls` を `ParsedScopeControl`（control と、kind が `scope-dependency-projection-v1` で key が decode できるときだけ `Some` の identity）にし、build 時に 1 回だけ decode する。`check_material_constraints` の filter はその identity を使う。他の kind は今まで通り `None`（decode しなかったのと同じ結果）。単発の caller（`retrieval_admission.rs`）は呼出しごとに `parse_all` する | native の読取の内部だけ。同じ入力は同じ判定、判定の順序（disclosure → authority token → material constraints）、`Reason` の分類、control 数が 1 でないときの `MaterialAuthorityUnavailable`、secret・legacy・unknown の扱い、floor・順位付け・窓 D・契約・閾値・送信先・保存は変えない | (a) `projection_revision` の memo を第一段にする：キー（query の binding・authority の revision token・proof の identity）が複雑で、decode の除去だけでも足りるか確かめられるので、この段では採らない（実測は §3。足りなかったので DR-IRQ-3）。(b) `from_source_key` を速くする（core の変更）：結果が Source key だけで決まるので、候補ごとの繰返しをなくす方が小さい | 確定 |
| DR-IRQ-3 | 2026-11-06 | **`projection_revision` の答えを、1 回の qualify の pass（1 つの query、1 つの authority）の中だけ memo する**。`ProjectionRevisionMemo`（Source key → `Option<revision>`）を `qualify_proof` の loop の前で作り、`admits_with_memo` → `check_material_constraints_with_memo` に渡す。`projection_revision` は identity（Source key と 1 対 1）と authority だけで決まる純関数で、pass の中の authority は 1 つ。memo は pass の局所変数で、`BuildSnapshot`・runtime・proof には入れず、pass の後で drop する。1 つの memo は 1 つの authority にだけ使う（debug build で authority のアドレスの一致を assert）。`projection_revision` を呼ぶ前の条件（project・run・非 secret）は今まで通りで、条件を満たす control だけが memo に入る。`admits`（単発）は新しい memo で呼ぶ | 同上。memo は query・authority・proof をまたがない（キーに authority を入れる代わりに、寿命を pass に限る）。判定は同じ入力で同じ | DR-IRQ-2 の代替案 (a)。DR-IRQ-2 の後の実測で、`projection_revision` が loop の約 7 割になったため（§3 の表の「+DR-IRQ-2」）採った。pass をまたぐ memo（proof に持たせる）は、authority の revision token・proof の identity をキーに入れる必要があり、無効化の面が増えるので採らない | 確定 |
| DR-IRQ-4 | 2026-11-06 | **`NirEvidenceHandle` の `QueryBinding` を `Arc` で共有する**。qualify の loop は candidate ごと・evidence ごとに `QueryBinding`（String 6 本ほど）を clone していた。pass の `QueryBinding` を 1 回 `Arc::new` し、handle は `Arc::clone` する。`QueryBinding` の中身・比較（`Eq`）は同じで、handle の検証は `&QueryBinding` に deref する | 同上。handle の外部への型・serialize・権限は変えない（handle は Native 内の registry の値のまま） | handle から query を外して proof だけにする案：検証の API が変わるので採らない | 確定 |

変えないもの（DR-IRQ-2〜4 を通して）：admission の意味と判定の順序、`Reason` の分類、floor（rank の下限）、順位付け、窓 D（40 ms）、契約、閾値、送信先、保存範囲、IPC の型。

## 3. 測定の表

N＝承認済み提案（候補）の数。いずれも `proof.fast_hit`＝hit が 200／200。単位は ms、p50／p90（到着の max は別欄）。1 条件 200 サンプル（20 回×10 地点）。機械は他のレーンと共有で、条件間の雑音は数 ms ある。

「修正前」は master `fba8cbaf` ＋ 計装、「+DR-IRQ-2」はその上に DR-IRQ-2、「全部」は DR-IRQ-2〜4。

| workspace（N） | 条件 | `scoring.run` | qualify | `admit_loop` | `check_query`（うち find） | `controls` filter（うち `projection_revision`） | cosine／sort | IR の到着 p50／p90／max | 窓 D 超過 |
|---|---|---|---|---|---|---|---|---|---|
| g-ja-1（884） | 修正前 | 37.6／54.2 | 34.0／45.6 | 33.8／45.5 | 2.52（0.46） | 26.6（6.5） | 0.84／2.03 | 34.5／38.8／41.3 | 69／200 |
| g-ja-1（884） | +DR-IRQ-2 | 23.9／37.4 | 18.8／30.7 | 18.5／30.5 | 2.61（0.35） | 9.7（8.8） | 0.94／2.87 | 21.8／30.4／41.5 | 13／200 |
| g-ja-1（884） | 全部 | **10.5／17.9** | **6.3／11.1** | **6.1／10.9** | 2.61（0.33） | 2.3（1.6） | 0.90／2.38 | **9.8／16.6／36.8** | **1／200** |
| m-ja-2（551） | 修正前 | 27.8／41.8 | 25.3／38.5 | 25.1／37.9 | 1.77（0.36） | 20.2（4.9） | 0.64／1.27 | 25.9／34.6／42.5 | 18／200 |
| m-ja-2（551） | +DR-IRQ-2 | 12.6／19.7 | 10.2／16.5 | 10.0／16.4 | 1.48（0.21） | 5.6（5.1） | 0.57／1.24 | 11.9／18.4／35.3 | 0／200 |
| m-ja-2（551） | 全部 | **6.1／7.5** | **3.9／4.7** | **3.8／4.5** | 1.37（0.19） | 1.9（1.5） | 0.60／0.99 | **5.4／6.9／9.3** | **0／200** |

到着は begin の応答から continue の応答まで（`beginResolved→IR到着`）。窓 D 超過は harness が `timeout`／`unavailable` にした数。「全部」の g-ja-1 の 1 件は max 36.8 ms の外れ値（並走するレーンの負荷による雑音の可能性が高いが、原因は確かめていない）。

## 4. 試験と確かめたこと

- 追加：`retrieval_admission/types.rs` の `mapping_index_tests`（HashMap の答えが `find` と同じ：存在する・しない・逆順・同じ key の重複〔最初が勝つ。重複を前へ回しても〕・空の authority）、`scene_scope.rs` の `parsed_scope_control_tests`（decode が `from_source_key` と同じ、decode できない key・非 canonical の key は `None`、他の kind は identity を持たない、`parse_all` が順序と entry を保つ、memo の答えが直接の `projection_revision` の比較と同じ・不能な identity は一致しない・identity ごとに key で分かれる）。
- 結果（候補は DR-IRQ-2〜4 を入れた head）：`cargo test -p grimodex-db --lib` は 2467 件成功・0 失敗・52 ignored（872 s。既存の admission・disclosure・scene_scope・chronicle index・graph の試験を全部含む）。統合試験 `narrative_nir1_retrieval_admission`（22）・`narrative_nir1_material_membership`（18）・`narrative_nir1_revision_eligibility`（18）も成功。`cargo clippy -p grimodex-db --lib --tests -- -D warnings` は警告なし。変更した 6 ファイルの `rustfmt --edition 2021 --check` は差分なし（crate 全体の `cargo fmt --check` は master の時点で差が出るため、変更ファイルだけを確かめた）。

## 5. 確かめられなかったこと

- 計測は skip-extraction の写し（LLM・key なし）で、Electron の実 build（計装あり）。計装の無い製品 build での再測は未実施。計装の overhead は候補 1 件あたり数十 ns の `Instant` で、修正前・後の両方に同じように乗る。
- N＝884 より大きい場合の伸び方は測っていない。修正後も `check_query`（約 3 µs／候補、JSON の `scope[field]` の比較）と sort が N に線形に残る。N＝884 で loop の約 4 割が `check_query`。
- 実際の評価 run（ir-slot の全部の段）の合否は、この PR の外。

## 6. 記録の置き場

- 計測の装備（dev 専用、PR に入れない）：branch `claude/ir-admission-perf-diag`。`dev_timing.rs`、`ir-timing.mjs` と、それが読む `ir-slot.mjs`・`pd-corpus.mjs`・`raw-fullness.mjs`・`ir-classify.mjs`（`claude/ir-timing-diag` から写した）。
- 測定の生データと分析：`fusion-eval-data/ir-admission-perf/runs/`（`*.analysis.txt` と `records.json`）、build の receipt は同じ下の `build-*/`、workspace の写しは `base-g-ja-1/`、`base-m-ja-2/`（原本は読み取りだけ）。
