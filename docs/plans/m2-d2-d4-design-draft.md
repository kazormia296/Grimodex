# M2 の D2〜D4：同一性と変更レビューを広げる設計（起案 第 2 版、2026-11-26）

状態：**起案。実装の根拠にしない。**
- 第 2 版の事実は 2026-11-26 の origin/master（`a977e8b74`）を静的に読んだもので、実行していない。実データでも確かめていない。
- 読んだのは read-only の別の agent で、結論ごとに反証役をつけた（workflow `wf_144cbbff-ba9`・`wf_2c0abf68-15b`・`wf_071adc20-04b`）。D2 の結論を支える引用は、起案者が `git show` で確かめた。
- 第 1 版（2026-11-25、基点 `dd014db91`）の §5 の 4 点に答え、その後に入った CED/1・SRD/1・CSR/1・M3・ADR 015 を反映した。
- 本文は「確かめた事実」「起案者の読み」「未確認」を分けて書く。

前提：[M2-D1 の同一性の設計](m2-d1-identity-design-draft.md)、[assertionId の契約案](m4-assertion-identity-contract-draft.md)、
ロードマップ M2（[narrative-semantic-core-roadmap.md](narrative-semantic-core-roadmap.md)）。
各 wave が満たす 7 項目と順序（D2→D3→D4）はロードマップのとおり。7 項目は、typed payload、互換 adapter、Producer の依存宣言、Review と Projection の対応、Structure Health、Retrieval 参加、移行の証跡。
このうち「移行の証跡」と「Retrieval 参加」の共通の規則は、M2-D1 の残りの担当が `docs/plans/m2-d1-remainder-design-draft.md`（枝 `claude/m2-d1-remainder`、未 merge）で決める。この起案は wave ごとの固有の点だけを書く。

## 0. 第 2 版の要点

- **D2（Chronicle）は、D1 と同じ形では広げられない。**
  - 年表の提案の版があるのは取り込む前だけで、取り込んだ後は版を作れない。出来事の行（`events`）ができるのは取り込んだ後だけ。
  - 抽出のたびに出来事に新しい id が振られる。既存の出来事に一致すると判定されても、id は新しいまま。
  - そのため、第 1 版の案 1（`events.id` を key）でも案 2（内容から key を作る）でも、抽出の run をまたいで「同じ出来事」とは扱えない。
- D3 は Phase に、D4 は Plot Thread／Foreshadow の根に絞る。State Track／Transition と Plot Thread の仮説の id は乱数か並び順の連番で、製品にそれを作る経路も無い。
- 新しい契約・保存の拡大・新しい送信に当たる点は §7 に集めた。どれも実装の前に伺う。

## 1. D1 で作ったもの（広げる時の起点）

確かめた事実：
- 同一性の宣言は別の file（`policies/narrative/narrative-object-identity-declarations.json`）で、entry は `nir1-reviewed-entity-relation-v1` の 1 件。
- 比較する側は宣言を読まず、`codex:`／`codex-relation:` の接頭辞をコードに持つ。Rust の `grimodex-core/src/narrative_change_review.rs:13,17` と `grimodex-db/src/narrative_extraction/nir1_change_review_read.rs:316,333` がそう。
  - #1135 の renderer（`src/features/codex/CodexEntityRelationChangeReviewSection.tsx`）も接頭辞から名前を引く。ただし未知の接頭辞では生の identity をそのまま表示し、壊れはしない。
- D1 の「前の版」は、より前に作られた**別の ProposalSet** の proposal のうち、current かつ承認済みの版（`nir1_change_review_read.rs:225-247`、走査の上限 64）。つまり D1 は run をまたいで比べている。比べる単位は版の中の object の集合（roster）。
- IPC `nir1_change_review_read` は #1129 で `expectedWorkspacePath` が必須になった。応答は `status`＋`content` の形に固定されている。

## 2. D2：Chronicle／Timeline／Temporal Constraint

### 2.1 確かめた事実

- **版の形**：年表の提案は generic な経路を通る。
  - set_kind は `chronicle.extract.review@1`、surface は `chronicle.extract`、origin は enveloped、kind は `chronicle.create-event@1`。
  - **1 つの版は出来事 1 件**で、D1 の bundle にあたるものは無い。
  - `nir1-reviewed-chronicle-v1` は index の Producer で、版の Producer ではない。
- **版の検査**：版そのものと系譜の検査は D1 と同じかそれ以上にある（`lineage.rs:112-128,179-200`）。
  - 検査するもの：Envelope V2、digest、payload の束縛、親子の鎖。
  - 人の編集で変えてよいのは title／note／disclosure だけ。
- **版が作れるのは取り込む前だけ**：
  - 人の編集は、取り込み済みの提案を拒む（`human_derivation.rs:109` の `ensure_proposal_not_applied`）。
  - 年表の Envelope は `changeKind=add` だけを許す（`narrative_ir.rs:1461`）。
  - 取り込みは常に新しい行を作り、id は提案の `eventId` そのもの（`chronicle_operations.rs:310`）。
- **抽出ごとの id**：
  - 提案の `eventId` は抽出のたびに `createId()` で振られる（`proposalPlanner.ts:170`）。
  - 既存と一致した判定のうち、`already-satisfied` は提案を捨てる（`:121`）。`probable-duplicate` は一致の情報を付けるだけで、新しい id の提案になる。
- **出来事ごとの Source object が無い**：版の source basis で年表を指すのは、project 単位の 1 本（`project:nir1-chronicle-eligibility:{project}`）だけ。
  - 依存の辺の source の文法（`dependency_edges.rs` の `source_identity_prefix_for`、閉じた一覧）に、出来事を指す接頭辞は無い。
  - 未知の接頭辞は保存の時点で拒まれる。
- **出来事の名前（Object Address）はすでにある**：Change Feed の objectKey `chronicle-event`（`policies/narrative/change-feed-writers.json:316`）。
  - 書き手は `chronicle.aggregate`。cause は forward／undo／redo で、paths は title・content・sceneLinks・participants。
  - Codex の側は objectKey が `codex-entry` で、source の接頭辞が `codex:`。**名前の層が 2 つある。**
- **SRD/1**（ADR 004 の 2026-11-23 の追補 §1）：出来事が無くなると、本体が同じ transaction の中で、それを取り込んだ提案の承認を外す（却下の決定を 1 件足す）。
  - 出来事が戻っても、承認は自動では戻らない。作者が承認し直す（RA）。
  - 対象を選ぶ SQL が除くのは型付きの Entity/Relation の kind だけ（`repository.rs:6107`、`reapproval.rs:88`）。**年表の新しい型付き kind を足すと、X・RA が自動でその kind にも及ぶ。**
  - 本体が外した承認の決定には `cause='event-removed'` と actor `native:event-existence-sync` が付く。
- **CED/1**：取り込みの時に、日時の無い提案に限って Native が日時を補う。補う欄は 7 つで、出所は system、確度は unknown（DR-CED-19）。
  - 補った欄の分だけ、版の payload と出来事の行の値が食い違う。
- **CSR/1**：読む側の `events.secret` による除外は外れ、開示の場面の印（revealScene）に置き換わった（#1124・#1127・#1128）。
  - 残っているのは 3 つ。`events.secret` の列、提案の payload で必須の `disclosure.secret`（planner の既定は `secret: true`）、本文宣言の veto が `events.secret` を読むこと（`scene_body_declaration/veto.rs`）。
- **ADR 015**（#1147、Proposed）：通常の Codex の同一性は同じ Codex ID だけ。Merge／Split の対応は ERM の側で記録し、M2 の identity 契約の代わりにはしない（:62）。
  - 「Phase／State／Chronicle の実体の変更が要る時、M2-D2〜D4 の identity 契約をどの段で確定するか」は未決の問いとして残っている（:247）。

### 2.2 起案者の読み

- D1 と同じ「前に承認した版との違い」が年表で成り立つのは、**承認した後・取り込む前に作者が手直しした提案**の親子だけ。
  - しかも親が承認済みの場合に限る。
  - D1 は run をまたいで比べるが、年表の親子は 1 つの提案の中の比較で、D1 には無い種類の比較になる。
- 取り込んだ後の出来事の違いを見せるなら、比べる元は版ではなく、出来事の行の履歴（Change Feed など）になる。
- 抽出の run をまたいで同じ出来事を表したいなら、案 1 でも案 2 でもない、別の同一性の仕組みが要る。
  - 例：`probable-duplicate` を作者が「同じ出来事」と確かめた時に、既存の `events.id` に結ぶ。
  - これは**新しい契約**で、§7 で伺う。

### 2.3 判断点（まだ決めない）

- **key の綴り**：`chronicle-event:{id}`（Change Feed の objectKey と同じ）か、`chronicle:{id}` か。
  - 確かめた事実：Codex では objectKey（`codex-entry`）と source の接頭辞（`codex:`）が別の層。
  - 比べる側の key だけに使い、保存しないなら、どちらでも依存の辺の文法には当たらない。
  - 依存の辺に保存するなら、source の文法に新しい kind を足す契約の変更になる。その場合は、source の revision の解決と restore の逆写像も同時に触る。
- **X・RA と比較の関係**：
  - 本体が外した承認（`event-removed`）を作者の却下と区別するか。
  - 戻った出来事を、RA まで Unresolved にするか。
  - 年表の新しい型付き kind を X・RA の対象に入れるか。
- **日時の 7 欄**：Native が補った欄（出所 system）は「変更」と数えない。
- **秘匿**：typed payload に `disclosure.secret` を持ち込むか。持ち込まないなら、planner の既定 `secret: true` との食い違いをどう扱うか。
- **履歴を読む部品**：D1 と同じ強さにするには、次の 3 つを新しく作る。
  - (a) 版ごとの Decision を読む reader。同時刻が並んだら fail-closed にする。
  - (b) 系譜の側の epoch（restore）の検査。index の current の経路（`revision_bindings.rs`）には既にあり、系譜の側に無い。
  - (c) decisions を起点に前の承認版を特定する reader。
  - 今ある `retrieval_admission/current.rs` と `nir1_chronicle_index/revision_bindings.rs` は current の版の専用で、履歴には使えない。

### 2.4 進め方の案

確かめた事実（`wf_2c0abf68-15b`、反証つき）：
- **承認した後・取り込む前の手直しの窓は、製品にある。**
  - 承認（一覧のカード）と取り込み（年表の抽出の dialog の「取り込む」）は別の操作。
  - 詳細ペインの題・補足・secret の欄は、status に関係なく出る。出ないのは取り込み済みか `already-satisfied` の時だけ（`ChronicleProposalReview.tsx:319-388`）。
  - 手直しは `narrative_extraction_create_human_derived_revision` で人の子の版を作る（`chronicleExtractionApi.ts:1674`）。ただし envelope が V2 の run の時だけで、V1 は通常の版の追記になる。
  - 手直しの後は status が `unreviewed` に戻り、承認し直すまで取り込めない（`chronicleExtractionStore.ts:735-790`）。
- **取り込んだ後の出来事の編集・削除は、3 つの履歴を同じ transaction で残す。**
  - 経路：年表の画面、AI のチャットの tool、MCP のどれも `agent_event_update`／`agent_event_delete` に入る。参加者は `agent_event_set_participants`。
  - `undo_journal`：前後の値を丸ごと持つ。**90 日で消える**（`prune_old_logs_for_workspace_maintenance`）。
  - `change_events`：変えた項目の名前だけ持つ。消えない（hash chain）。
  - `narrative_change_events`（Change Feed、objectKey `chronicle-event`）：前後の version と digest、変えた path を持つ。値は持たない。消す経路は見つからなかった。
  - 取り込みの時に日時を補う処理（metadata patch）は、`undo_journal` でなく `narrative_commit_journals` に日時の前後を残す。

起案者の読み：比べる元は 2 つの候補がある。どれを採るかは利用者に伺う（§7）。
- **案 D2-1：取り込む前の手直しの差。**
  - 承認版（親）と手直しした子の差を見せる。違いに出るのは題・補足・secret だけ。
  - 部品は §2.3 の (a)〜(c) で、新しい保存も新しい契約も要らない。
  - ただし手直しの後は承認が外れ、同じ画面で再承認するので、見せる価値は小さい見込み。
- **案 D2-2：取り込んだ後の出来事の変化。**
  - 変更レビューの前に承認した時点から、出来事の何が変わったかを Change Feed から見せる。
  - 変えた path と回数なら期限なしで出せ、新しい保存は要らない。前後の値は `undo_journal` から 90 日までなら出せる。
  - 90 日を越えて前後の値を見せるなら、Feed に値を持つ**保存の拡大**になる。
  - 比べるのは版でなく Domain の履歴で、D1 の「前に承認した版との違い」とは別の種類の画面になる。
- 抽出の run をまたぐ同一性（§2.2）は、どちらの案にも入らない。

- 第 1 版の (1)「比べる側が宣言を読む形にする」は、D2 に同一性の宣言を足す前提が立つ場合だけの段にする。
  - 対象は Rust だけでなく、#1135 の renderer と #1129 の IPC の形も含む。

AI：年表の抽出は製品の既定で AI を使う（`chronicleExtractionApi.ts`）。この起案は**送信を足さない・変えない**。

## 3. D3：Phase／State／State Transition

確かめた事実：
- IR の `transitionId`／`trackId` は、既定では毎回 `crypto.randomUUID()` で振られる。
- 製品の経路（`codexStructureExtractionApi.ts`）が付ける id は、並び順の連番（`boundary-${n}`、`tr-${n}`）。
- `grimodex-core/src/narrative_ir.rs` には、State Transition／Track／Phase の型も検証も無い。
- 安定した key になるのは DB の Phase の行 id（`codex_entry_phases.id`）だけ。作成の時に振られ、その後は変わらない。
  - 既存の DomainObjectKey に `codex-phase` の行 id がある。
  - Phase の行は削除できる。

起案者の読み：
- 最初の版は Phase に絞る（第 1 版と同じ。根拠が増えた）。
- 対象は、製品の経路にある Phase の提案（bind-existing／create-new／unresolved）。
- State／State Transition は、公開版にも未公開版にも永続物が無い。id も安定しないので、同一性の宣言の対象にできない。永続化するなら**保存の拡大**（§7）。
- Rust の側に Phase の型の検証を新しく置くのは**新しい契約**になりうる（§7）。
- 削除された Phase の宣言の扱い（孤児）を決める必要がある。

## 4. D4：Plot Thread／Foreshadow

確かめた事実：
- IR の `threadId`（`plot-thread:*`）は型の宣言だけで、生成の規則も製品の呼び手も無い。
- 新しい pipeline の planner（`planPlotThreadProposals`）にも、テスト以外の呼び手が無い。
- 安定した key は `plot_threads`／`foreshadows` の行 id だけ（DomainObjectKey に `plot-thread` がある）。
- 旧経路は本文を AI に送っている（`plot-threads/extractThreadsApi.ts`）。

起案者の読み：
- 最初の版は根（Plot Thread／Foreshadow の行）に絞る。子（setup／payoff／marker／branch）まで広げるなら、legacy-payoff の id と semantic_key の `#dup` の扱いを決める必要がある。
- AI の仮説を既存の行にどう束ねるかは、別の規則が要る。
- 新しい pipeline への移し替えは送る中身が変わり得るので、**新しい送信**として伺う（§7）。D2 の後に起案し直す。

## 5. 互換 adapter と公開済みの保存物（第 1 版 §5 の 4 への答え）

確かめた事実：
- 公開版は v2.0.10（schema 2）だけ。`narrative_*` の表（提案・版・Decision・Artifact・依存宣言・index）は、どれも未公開。
- 公開済みで同一性の対象になるのは、`events`・`codex_entry_phases`・`plot_threads`・`foreshadows` の行。どれも TEXT の主キー id を持つ。
  - ほかに `change_events` と `undo_journal`。entity の id と前後の値を持つ。
- Gate A2 の公開版 fixture（`release_schema_fixture.rs`）が覆うのは `events` だけ。Phase・Plot・Foreshadow の行は無い。

起案者の読み：
- D1 §2.4 の「データの移行は不要」は、roster に既存の source identity があることが根拠だった。D2〜D4 は**根拠が違う**。key を公開済みの行 id から読む側で計算し、保存しないことが根拠になる。この条件の下で次のとおり。
  - D2 は可。
  - D3 は Phase だけ可。
  - D4 は根だけ可。
- 新しい key を保存したり突き合わせたりするなら、legacy の行の読み手の扱いが要る。
- 証跡は 2 つに分けて書く。
  - **公開版との互換の証跡**（7 項目の「互換 adapter」）：各 wave で、Gate A2 の fixture に Phase・Plot Thread・Foreshadow の行（D4 は子も）を足す。
  - **消す前の証跡**（7 項目の「移行の証跡」）：feature の要約や Freshness の store を消す前に出す証跡。規則は M2-D1 の残りの担当が決める（消す前に内容の digest か集合の比較と、旧い読み手が 0 件であること。消すこと自体は利用者に伺う）。D2〜D4 で消す候補は、この版では挙げていない（未確認）。

## 6. §5（第 1 版）の 4 点への答え

1. **年表の承認済みの版の形と履歴の reader**：
   - 版そのものと系譜の検査は再利用できる。
   - D1 と同じ強さにするには §2.3 の (a)〜(c) を新しく作る。
   - 比べられる相手は 1 つの提案の中の親子だけ（§2.2）。
2. **年表の roster の object の単位**：project 単位の 1 本だけで、出来事ごとの Source object は無い（§2.1）。
3. **`transitionId`／`trackId`／`threadId` の生成規則**：乱数か並び順の連番、または生成の経路が無い。どれも run をまたいで安定しない（§3・§4）。
4. **互換 adapter が要る公開済みの保存物**：§5 のとおり。

## 7. 伺う対象（実装の前に）

- D2 の比べる元：案 D2-1（取り込む前の手直しの差）か、案 D2-2（取り込んだ後の出来事の変化）か、D2 を後に回して D3（Phase）から始めるか（§2.4）。
- 案 D2-2 で、90 日を越えて前後の値を見せること。**保存の拡大。**
- 抽出の run をまたいで年表の同じ出来事を表す仕組み（例：`probable-duplicate` を作者が確かめて既存の `events.id` に結ぶ）。**新しい契約。**
- 年表の同一性の宣言を `narrative-object-identity-declarations.json` に足すこと。key を依存の辺に保存するなら、source の文法の変更も含む。**新しい契約面。**
- Rust の側に Phase の型の検証を置くこと。**新しい契約**になりうる。
- State Transition／Track の永続化。**保存の拡大。**
- D4 の新しい pipeline への移し替え。**新しい送信。**

## 8. やらないこと

- AI への送信の追加・変更、新しい保存、旗を開けること、Story Bible の自動書き換え。
- 作業記録・decisions・ロードマップの更新。この版は起案だけで、判断の ID は振らない。
