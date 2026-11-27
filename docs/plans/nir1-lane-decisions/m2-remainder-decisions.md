# M2-D1 の残り（移行の証跡と Retrieval への参加）— 判断の記録（DR-M2R）

この文書は、M2-D1 の残り 2 項目の判断と信頼境界を残す。この版は docs だけで、製品のコード・データ・送信は変えない。
委任の根拠は、ユーザーの決定（contracts `user-confirmation-2026-11-24-m4-pullforward.md`。M2 の残りを別のセッションの担当にしたのは追記 13）：
M4 と同じ範囲で技術判断を任され、新しい契約・authority、保存範囲の拡大、AI への新しい送信、閾値の緩和、公開、製品の認可の削除、
feature-private な要約や Freshness の store の削除は個別に伺う。

## 出所

| 項目           | 内容                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------- |
| 設計           | [M2-D1 の残りの起案](../m2-d1-remainder-design-draft.md)                                 |
| 調査           | read-only、基点は origin/master `ada7d3527`（2026-11-26）。根拠の file:line は起案の §1  |
| ユーザーの確認 | M2 の残りを別のセッションの担当にすること（contracts の追記 13）だけ。下の判断は確認の前 |
| 実装           | なし                                                                                     |

## 判断

- **DR-M2R-1（M2-D1 で消すもの）**：消す候補は 0 件。Codex の要約（`codex_entries.summary`）は作者が書く正本で、共通の層から導出できない。FTS・embedding・言及の索引は共通の Freshness と対象が違い、重複でない。`staleBind` は共有の台帳から作る表示の状態。feature を横断する旧い dependency の store（`narrative_projection_dependencies`）は、Codex 専用でなく片付けが Gate C2 の cutover の範囲なので、M2-D1 の候補に数えない。「移行の証跡」は M2-D1 では「対象なし」とし、完了の印は付けない。
- **DR-M2R-2（消す前の証跡の規則、全 wave 共通）**：(1) データの種類ごとに中身を集合か digest で比べる（件数だけでは足りない）。(2) 古い store を読む製品の経路が 0 件になったことを、静的な走査と試験で示す。(3) 公開版の workspace と保存済みの Artifact が収束するまで互換 adapter を残す。公開版の fixture に行を足すことは「互換 adapter」の証跡として分けて書く。(4) 消すこと自体はユーザーに伺う。D2〜D4 の起案（M4）はこの規則を参照する。
- **DR-M2R-3（Retrieval への参加の今の形）**：承認済みの typed ER は、NIR-1 の Graph の index（#596）を通じて Related Scenes の Graph の経路にだけ参加する。#1108 より前からあり、同一性の宣言には依らない。経路は `NIR1_GRAPH_UI_ENABLED`／`PRODUCT_GRAPH_PUBLISHED` で閉じ、PUB-G で開く。M2-D1 の実装とは数えない。
- **DR-M2R-4（この版で新しい経路を足すか）**：検索結果の印（案 A）は、新しい契約が要るのに役に立つ根拠が無いので見送る。Related Scenes の Graph の経路（案 C）は現状のまま。Chat の候補の並べ替え（案 B）は、ユーザーの回答「案 B も検討する」（contracts の追記 15）を受けて起案の §3.4 で検討した。起案者の勧めは B1（選び終えた後の並べ替えだけ、旗を閉じて入れて測る）。B1〜B3 はどれも AI への送信の変更と新しい読み口の契約にあたるので、**形と送信をユーザーに伺うまで実装しない**。
- **DR-M2R-5（公開版の fixture）**：v2.0.10 の `migrate()` は `codex_relations`・`change_events`・`undo_journal` を開くたびに作る（tag の `migrate.rs:1135`・`:1495`・`:2037`）。しかし Gate A2 の fixture は seed（見本データ用の部分集合）から作るので、この 3 表の行を覆っていない。3 表は M2 が別の product PR（試験だけ）で覆う（統合者と合意）。seed に無い残りの 26 表は、この版では覆わず、公開の前に扱いを決める（未決）。（最初は「seed に無いので足す行は無い」と書いたが、M4 の指摘で v2.0.10 の migration を確かめて改めた。）

- **DR-M2R-6（B1 の入力と並べ替えの位置）**：ユーザーの回答「B1 を旗の裏で」（contracts の追記 16）を受ける。`buildSystemPrompt` は同期で、L4 もその中で選ぶ（`contextBuilder.ts:2307`、`:1868-1879`）ので、読み口は「選び終えた id」でなく、builder の前の候補の id（今の並びの先頭から最大 64 件）を受ける。返すのは入力の部分集合だけで、入力の順を保つ（renderer が既に知っている id 以外を返さない）。並べ替えは最後の予算の補正（`:2111-2134`。毎回 `candidateL4Items` から選び直し、その後に L4 を削る処理は無い）の後に、同じ kind の群の中・同じ stability の区分の中だけで、承認済みを先にする安定な並べ替えとして行い、もう一度 materialize する。選ぶ処理には印を使わない。不変条件「承認済みの集合の有無によらず、選ばれる id の集合が一致する」を、scene と scene でない文脈の両方で、いちばん外の入口から試験する。
- **DR-M2R-7（「承認済みで今も有効」の定義と読み方）**：Codex の項目 `X` が印を得るのは、`X` を Entity に持つ typed ER の revision のうち少なくとも 1 つが、(a) 既存の A2 の判定で current かつ最新の Decision が人（`actor_kind = 'human'`）の `approved`（`nir1_entity_relation.rs:2796` の判定を再利用）で、(b) その revision の依存の辺に記録した token（`read_set_json`）が、今の token（`resolve_typed_source_token`、`:1296`。hidden や消えた項目は解決しない）と一致するとき。読み方は `narrative_dependency_edges` の index `(project_id, source_object_identity)`（`migrate.rs:3878`）で id ごとに新しい順に最大 16 本まで引く。16 本を超える分は見ず、その中に当たりが無ければ印を付けない（付けない側に倒す）。schema は変えない。`MAX_PACKING_ITEMS`（512）による project 全体の列挙は、長い作品で常に上限を超えうるので使わない。
- **DR-M2R-8（旗と失敗時）**：renderer の旗 `CHAT_APPROVED_CODEX_RANK_ENABLED = false as const` を置く。旗が閉じている間は読み口を呼ばない。読み口が失敗・使えないを返したら、並べ替えずに今の挙動のままにする。builder は承認済みの集合を引数で受け、旗に依らず試験と評価から注入できる形にする。
- **DR-M2R-9（PR の分け方と測定）**：B1a は Rust の reader・N-API・IPC の契約・`src/lib` の wrapper だけで、呼び手なし。B1b は旗・2 つの context の source・builder の並べ替え。`contextBuilder.ts` は `evals/impact-map.yaml` の `localized-prompts`（suite `prompt-contract`）に当たるので、B1b は AI の挙動の資産の変更として impact gate を通す。Chat の L4 の順序の効果を typed ER つきで測る既存の評価は無い（evals の中で typed ER を使うのは NIR-1 の Packing と Graph だけ）。旗を開ける前に、小さな評価を新しく作り、その結果でユーザーに伺う。

- **DR-M2R-10（B1a の読み口の脅威モデル、委任の範囲内の技術判断）**：主体は今の境界のまま。renderer は信頼しない入力の出し手で、main が引数を再検証し、Native も再検証する。Native と DB は信頼する。新しい受け手・保存・送信先は無い。攻撃の範囲：(1) 任意の id による承認の有無の探り：返すのは入力の部分集合だけで、renderer は元から Codex の項目を読めるので、新しく漏れる情報は承認の有無の 1 bit だけ。作者本人の workspace の中の情報で、範囲の外へ出ない。(2) hidden の項目：今の token の解決（`resolve_typed_source_token`）で外れ、返らない。(3) 別の project・別の workspace：`projectId` と `expectedWorkspacePath` の束縛（既存の `nir1_entity_relation_revision_read` と同じ）で閉じる。(4) 大量の入力・重い読み：入力 64 件・id ごとに辺 16 本の上限で閉じる。(5) 承認の偽装：判定は既存の A2 の人の Decision の判定を再利用し、新しい承認の経路を作らない。範囲の外：作者本人の端末の上での DB の直接の改ざん（既存の脅威モデルと同じ）。必須の防御は (2)〜(5)。受入れ：既存の承認の authority を読むだけで、変えない。新しい契約は追記 16 で確認済み。これは個別のユーザーの承認の主張ではなく、委任の範囲内の技術判断。

- **DR-M2R-11（B1a の独立レビューを受けた判断）**：Opus の read-only のレビュー（2026-11-27、P1 なし・P2 3 件）を受けて決めた。(1) main の前後の空白の判定は、Rust の `trim()` に合わせて U+0085 も拒否する（JS の `trim()` は削らない。main は Native より緩くしない）。(2) 同じ revision の A2 の判定は、1 回の呼び出しの中で 1 回だけにする（id ごとの繰り返しで、DB の唯一の接続を長く持たないため）。(3) この command は main の route の台帳でどの区分にも入れず、未分類のまま閉じる（先例 DR-M4PF-11 の `nir1_change_review_read`。restricted の profile では未分類の command を dispatch の前に拒否する）。K3/2 の区分の構成（`plaintext-publication` などの集合。確認済みの脅威モデル §3.7 で固定）は変えない。最初は denies（`plaintext-publication`）に入れたが、#1179 の ci.yml で `d2aRouteClasses.test.ts` の区分の固定に当たり、区分の構成を黙って変えることになるので改めた（2026-11-27）。呼び手をつなぐときにどの区分に入れるかは、B1b のときの台帳の判断にする。(4) 辺の読み取りの量：index は `(project_id, source_object_identity)` までで、`consumer_kind` と `created_at` を含まないので、その Codex の項目の辺を全部読んで並べ替えてから 16 本に絞る。読む量はその項目を含む revision の数に比例し、16 本は「判定に回す数」の上限で、読む量の上限ではない。schema は変えない（DR-M2R-7）。重さが問題になれば、index を足す案を schema の版とあわせて統合者と決める。

## 信頼境界

- 送信：旗が閉じている間は変えない。旗を開けると、AI に届く Codex の項目の集合は変わらず、prompt の中の順序だけが変わる（DR-M2R-6）。可否の判定は今の `codexVisibilityPolicy` のまま。
- 読み口：入力の id の部分集合だけを返し、新しい情報を renderer に出さない。上限は入力 64 件・id ごとに辺 16 本。main で引数を再検証する。
- 保存：変えない。消すものは無い。
- 公開：Graph の経路は閉じたまま。
