# M2 の D2〜D4：同一性と変更レビューを広げる設計（起案 第 2 版、2026-11-26）

状態：**起案。実装の根拠にしない。**
- 第 2 版の事実は 2026-11-26 の origin/master を静的に読んだもので、実行していない。実データでも確かめていない。基点は §2.1〜§2.5・§3〜§6 が `a977e8b74`、§2.6 が `2db49f806`。
- 読んだのは read-only の別の agent で、結論ごとに反証役をつけた（workflow `wf_144cbbff-ba9`・`wf_2c0abf68-15b`・`wf_071adc20-04b`・`wf_2778772d-c1c`・`wf_e3e586c7-139`・`wf_c5910485-58e`・`wf_770f3d00-d74`・`wf_2979fa90-e36`）。起案者が自分で `git show` で確かめたのは §2.1 の版の形・取り込み・抽出ごとの id・source の文法・Change Feed・ADR 015 の引用だけで、§2.4 以降の引用は agent の報告による。
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
- 利用者が選んだ案 D2-1（取り込む前の手直しの差）は、決定済みの SRA/1 で承認と取り込みが 1 つになるため取り下げた（§2.5）。考え直した案は D2-3（取り込んだ後の出来事の変化、§2.6）。
- **今の製品で実装に入れる段は、D2〜D4 には無い。** 上流の前提が 3 つ足りない。
  - 年表の取り込みが製品で開くこと（SRA/1 の P1）。
  - Codex の構造抽出が Phase の提案を製品で作ること（D3）。
  - 抽出の run をまたぐ年表の同一性（新しい契約、D1 と同じ比較の前提）。

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
  - `narrative_change_events`（Change Feed、objectKey `chronicle-event`）：前後の version と digest、変えた path を持つ。値は持たない。消す経路は見つからなかった。ただし表は未公開の schema で作られたもので、残るのは表ができた後の分だけ。
  - 取り込みの時に日時を補う処理（metadata patch）は、`undo_journal` でなく `narrative_commit_journals` に日時の前後を残す。

起案者の読み：比べる元は 2 つの候補があった。利用者は案 D2-1 を選んだ（2026-11-26 19:44、contracts の M4 の記録 追記 14）。
- **案 D2-1：取り込む前の手直しの差。（いったん採用し、§2.5 のとおり取り下げた）**
  - 承認版と手直しした子の差を見せる。違いに出るのは題・補足だけ。secret は落とす（下の設計）。
  - 新しい保存も新しい契約も要らない。
  - ただし手直しの後は承認が外れ、同じ画面で再承認するので、見せる価値は小さい見込み。
- **案 D2-2：取り込んだ後の出来事の変化。**
  - 変更レビューの前に承認した時点から、出来事の何が変わったかを Change Feed から見せる。
  - 変えた path と回数なら期限なしで出せ、新しい保存は要らない。前後の値は `undo_journal` から 90 日までなら出せる。
  - 90 日を越えて前後の値を見せるなら、Feed に値を持つ**保存の拡大**になる。
  - 比べるのは版でなく Domain の履歴で、D1 の「前に承認した版との違い」とは別の種類の画面になる。
- 抽出の run をまたぐ同一性（§2.2）は、どちらの案にも入らない。
- §2.6 の案 D2-3 は、案 D2-2 の比べる基準を、Change Feed の履歴でなく取り込んだ版（後から変わらない）に置き直したもの。

### 2.5 案 D2-1 の設計（**取り下げ**。記録として残す）

**取り下げた（2026-11-26 20:17、contracts の M4 の記録 追記 18）。** 決定済みの SRA/1（`nir1-chronicle-scene-review-apply-proposal/1`、2026-11-22 確認済み、未実装）の E1・E3 では、承認するとその場で年表に入る。入った提案は手直しできず、場面の節のカード（S3）に手直しの欄も無い。そのため SRA/1 の後にこの欄が出るのは、取り込みに失敗して承認済みのまま残った提案だけになる。利用者の回答は「場面の節の形に合わせて考え直す」で、考え直した案は §2.6。
実装の枝 `claude/m4-d2-1-chronicle-approved-diff` はローカルに残し、push していない。製品 PR は出さない。下の設計と点検の結果は、§2.6 の材料として残す。

材料は workflow `wf_e3e586c7-139`（調べ 4 本と点検 1 本）。
- **新しい IPC は足さない。** 年表のレビューの読み `narrative_extraction_get_run_review_bundle` の提案の行に、任意の項目を 1 つ足す（名前は仮に `approvedRevision`）。
  - main はこの応答を JSON のまま通している（`ipcContract.ts:11794-11804` の `parseWire`）。そのため契約の file は変えない。型は `nativeApi.ts` の `ReviewBundleProposal` に足す。
  - D2a の区分は own-data-read のまま。そのため**外部送信を制限中の profile でも差が出る**。D1 の欄（制限中は「違いを表示できません」）とは挙動が違う。
- **「承認した版」の定義**：今の版でない版に付いた決定のうち、approved で最新のものが指す版。proposal と project で束縛する。
  - `parentRevisionId` では定めない。承認の後に 2 回手直しすると、親は承認していない版を指す。
  - `latestDecision` でも定めない。手直しの後に保留・却下すると、承認が見えなくなる。
  - 承認の判定に proposal の status は使わない。子ができた時点で必ず unreviewed に戻る。
  - 子を作っても親の決定は消えない。また決定は今の版にしか書けないので、過去の版の決定は後から増えない（`human_materialization.rs:853-868`、`repository.rs` の `NEX_PROPOSAL_REVISION_MISMATCH`）。
  - 同時刻の決定が並ぶ時と、payload が読めない時は、項目を付けない。
- **項目の中身**：承認した版の revisionId・title・note・決定の日時だけ。本文・根拠・evidence・`revealDocumentRef`・参加者は返さない。
  - 該当が無い時は null にせず、key ごと省く。bundle の形を固定している試験・journey・harness を動かさないため。
- **secret を差から落とす理由**：Native はどの surface でも出来事の secret=true を拒む（#1118）。承認の時に store も `disclosure.secret` を false に書き換える（年表の担当の確認）。作者が選べる差ではない。
- **置き場所**：年表の抽出の dialog の詳細ペイン（`ChronicleProposalReview.tsx`）の、編集の分岐の末尾。補足の後、根拠引用の前。
  - 文言は ja.json に足さず、#1135 と同じ日本語の直書きにする。dialog は lazy なので起動時の graph に乗らない。
  - 文言は出す前に利用者に伺う。
- **他の担当との順序**：
  - 年表の担当の RD（`get_run_review_bundle` に rejectedBy などを足す、`nativeApi.ts` の型を広げる）が先に merge する見込み。D2-1 はその後に master を取り込む。
  - RA7（承認し直すボタン）は 11-27 以降で、置き場所は詳細ペインの状態・決定のボタンの所。D2-1 の欄とは離れている。

実装の前に確かめること：
- 承認した提案を人が手直しすると、Native が受け、親の承認の決定が残ること。今は推定なので、手書きの最小 schema でなく実際の migrate の schema で、最初の試験として確かめる。拒まれるなら D2-1 は成り立たない。
- ~~S4 の枝の 61 file との重なり~~：重ならない（統合者が S4 の枝 6754614ce の `scripts/quality/nir1-graph/observation-prep.mjs` で確認）。ただし `cp4-harness.ts:78-87` が `chronicleExtractionApi` の `decideChronicleProposal`・`recordChronicleProposalDecision`・`reviseChronicleProposal`・`startChronicleExtraction`、`useChronicleExtractionStore`、`loadChronicleExtractionScenes` を静的に import する。**これらの名前と引数の形は変えず、足すだけにする。**
- まとめて承認（bulk approve）の決定の actor。承認の判定を actor で絞るかを決める前に確かめる。
- bundle の行を丸ごと AI・MCP・書き出し・ログに渡す読み手が無いこと（全数を grep）。
- 応答の拡張が own-data-read の台帳（K3/2、draftRef）の改訂に当たるか。
- 正本の iron-laws の「immutable child／revision・bounded lookup」と GDX-PRECHECK-001。

選択肢の前提の点検（`wf_2778772d-c1c`、反証つき）：
- **製品の年表の抽出の run は V2 の envelope で作られる。** V2 を作る旗は定数 true で（`extractionCoordinator.ts:129`、`chronicleV2Production.ts:37`）、dialog は AI の実行になる。V1 が残るのは、AI を使わない実行、V2 にする前の古い run、receipt が空の例外の場合だけ。→ 案 D2-1 の親子は製品で作られる。
- **取り込み（apply）は、製品の既定では閉じている。**
  - prepare（`commit.rs:204`）と apply（`commit.rs:995`）の両方で `require_narrative_apply_allowed` が働く。runtime の mode が `manual-apply` か `automatic` でないと `NARRATIVE_REVIEW_ONLY` で拒む。
  - 既定の mode は `review-only`（`narrative_runtime_policy.rs:100,282`）。
  - mode を変える IPC `narrative_runtime_policy_set` は契約にあるが、renderer の呼び手は無い（定数 `narrativeRuntimePolicy.ts:28` だけ）。
  - したがって製品では、抽出で取り込んだ出来事はできない。承認済みで取り込んでいない状態がふつうになる。
- **Change Feed を object key で読む読み手は無い。** Rust・N-API・IPC・renderer のどこにも無く、公開の読みは project 単位の `get_changes_since` だけ。→ 案 D2-2 には新しい IPC が要る。
- 案 D2-2 の「取り込んだ時点」の起点は、上の門のため製品には無い。手で作った出来事の編集・削除は Feed に残る。

未確認：
- Native が承認済みの親の手直しを受けること（検査に承認を拒む分岐が見当たらない、という推定）。
- RA で承認し直した後に、提案の status が approved に戻るか。

- 第 1 版の (1)「比べる側が宣言を読む形にする」は、D2 に同一性の宣言を足す前提が立つ場合だけの段にする。
  - 対象は Rust だけでなく、#1135 の renderer と #1129 の IPC の形も含む。

AI：年表の抽出は製品の既定で AI を使う（`chronicleExtractionApi.ts`）。この起案は**送信を足さない・変えない**。

### 2.6 案 D2-3：取り込んだ後の出来事の変化（起案。実装の前に伺う）

SRA/1 の後は承認と取り込みが 1 つになる。そこで、取り込んだ出来事が**取り込んだ時からどう変わったか**を見せる。
年表の担当によると、役に立つ場面は 2 つある。
- 取り込みの取り消しは、取り込んだ後に出来事が直されていると `NEX_COMMIT_EVENT_EDITED` で拒まれる（#1151 の残る制限）。「なぜ取り消せないか」を見せる場所として使える。
- SRD/1 の承認し直し（RA）の前に、外れた解釈の版と今の出来事の違いが見えれば、意図して外したのか事故で外れたのかを作者が見分けやすい（RD1 の目的と同じ向き）。
どちらも、年表の担当の画面（RA7）には置かない予定。

確かめた事実（`wf_770f3d00-d74`、基点 `2db49f806`、反証つき。起案者が `git show` で確かめたのは、trigger〔`migrate.rs:3449-3457`〕・題と補足の写し〔`compiler.ts:113-117`〕・`undo.rs` の書き換え〔`:256,913,1677`〕の 3 つ。ほかは agent の報告）：
- **比べる基準は取り込んだ版で、後から変わらない。**
  - 取り込みの application が指す版は、trigger で UPDATE も DELETE もできない（`migrate.rs:3449-3457,3480-3488`）。application 行と決定も同じ。
  - application がある project は削除できない（`domain_writes.rs:2118-2130`）。スナップショットの復元も版を変えない。
- **取り込みは、題と補足をそのまま写す。**
  - 版の `title`・`note` は、そのまま `events.title`・`events.note` に入る（`compiler.ts:113-117`、`agent_writes.rs:7832-7860`）。digest の照合で同一性も確かめている。
  - Native が取り込みの時に変えるのは、日時（CED/1 の補い）・kind・secret・開示の場面だけ。
  - したがって題と補足に差があれば、取り込んだ後の変更と言える。日時・参加者・場面の紐づけは、取り込みの時に補いや正規化が入るので比べない。
  - 同じ値に戻した変更（A→B→A）は「変わっていない」になる。
  - 比べるのは `application_kind='normal'` の行だけで、取り消しの補償の行は除く。
- **「誰が変えたか」は、一部しか言えない。**
  - 出来事の変更は、どの経路でも Change Feed（`narrative_change_transactions`）に 1 行ずつ残る。`origin` は human／ai-apply／undo／redo／restore／import。
  - アプリ内の AI の道具と MCP は、どちらも `ai-apply` になる。見分けるには `undo_journal.surface` を辿る（未確認の点が残る）。
  - **スナップショットの復元は、出来事ごとの記録を書かない**（project に印を 1 件だけ）。復元で変わった場合は「誰か」を言えない。
  - Feed の `changed_paths` は `"/"` などで粗く、どの欄が変わったかは分からない。欄の差は、版の値と今の値を比べて作る。
  - `narrative_field_authority` は最後に書いた者ではなく、人が一度書くと AI が書けなくなる印。「誰が変えたか」には使えない。
- **出来事が消えた場合**は、SRD/1 の却下の決定（`removedVia`）が提案の側に残る。
- **取り消しの拒否の判定**は、出来事の全体の snapshot（version を含む）と、取り込みの journal の after snapshot の全体一致で行う。
  - ただし journal の `after_json` は、undo・redo のたびに書き換わる（`undo.rs:256,913`）。差の基準には使わず、版の値を使う。
- **新しい読みが要る。**
  - 画面の汎用 SQL は版の payload を読めない（`execute.rs:40-55`、`D2A_EGRESS_DENIED`）。
  - 出来事ごとに Feed を読む処理も無い。
  - したがって Native の型付きの読みと、新しい IPC が要る。**新しい契約**で、利用者に伺い、`/add-electron-command` を利用者に実行していただく。
  - D2a の区分（own-data-read に足すなら新しい draftRef）も、その時に決める。

起案者の読み（案の形。未確定）：
- 読みは「取り込んだ出来事 1 件」を単位にする。返すのは、取り込んだ版の題・補足、今の題・補足、取り込んだ後の変更の回数と origin ごとの内訳、復元を挟んだかどうか。本文・根拠は返さない。
- 置き場所の候補は 2 つ。
  - 年表の画面の出来事の詳細。「AI の提案から取り込み、その後に直された」ことを見せる。
  - SRA/1 の場面の節のカード。承認し直しの前の見分けに使う。
  - どちらにするかは、SRA/1 の段の進み具合と、年表の担当との分担で決める。
- 時期は SRA/1 の後。SRA/1 で承認と取り込みの形が固まる前に作ると、作り直しになる。

前提の点検（`wf_2979fa90-e36`、反証つき。確認済みで未実装の起案とも照らした）：
- **使い道の 1 つ目（なぜ取り消せないか）には、今の製品に置き場所が無い。** 取り込みの取り消し（`narrative_extraction_undo_commit`）は IPC と薄い関数（`commitCoordinator.ts:165`）まで配線されているが、画面・ボタン・Ctrl+Z の呼び手は 0 件。SRA/1・SRD/1・AWA/1 にも取り消しの画面を作る予定は無い。
- **使い道の 2 つ目（承認し直しの前の見分け）は、SRD/1 の確認 87 と向きが違う。** SRD/1 は、承認し直しの時に取り込んだ時の版と今の出来事を照合しないと決めている（比べ方で崩れるため。SRD/1 の起案 :328）。表示だけなら判定には効かないが、同じ比較を画面に出す理由は改めて要る。
- **SRA/1 の場面のカードの「年表の状態」は 2 値（取り込み済み／未取り込み）だけ**で、「取り込んだ後に直された」は含まない（`scene_proposals.rs:129-132,296-319`）。「消された」は SRD/1 の RD1（未実装）が足す。「直された」と「誰が変えたか」は、どの起案の範囲にも入らない。
- **似た既存の契約がある。** Contribution の台帳（`narrative_application_contributions`、roadmap の C2-4、#536 で完了）は、取り込んだ欄ごとに `modified`／`missing` の状態を持つ。
  - ただし製品の読み手も、状態を進める処理（`pump_out_of_band_edits`）の呼び手も無い（`application_contributions.rs:270,806-860`、「No production reader yet」）。製品の DB では `modified` は一度も書かれない見込み。
  - 出来事の手直しは Change Feed の `changed_paths` が `"/"` なので、`modified` は欄ごとでなく出来事の全体に付く。
  - 値も「誰が」も持たない。
  - 案 D2-3 を作るなら、この台帳を動かして「変わったか」の印に使い、値は取り込んだ版と今の行から取る形が候補になる。どちらにしても新しい読みの契約が要る。

起案者の読み：**案 D2-3 は、今の製品にも決まっている起案にも置き場所が無い。** SRA/1 の段が進み、取り消しや承認し直しの画面の形が決まってから、改めて置き場所を決める。

未確認：
- アプリ内の AI の道具と MCP の区別が、`undo_journal.surface` で製品の経路で付くか。
- undo・redo を挟んだ時の version と token の変化。
- 復元の後に通常の編集をした時の、Feed の連続性の検査の挙動。

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

選択肢の前提の点検（`wf_2778772d-c1c`、反証つき）：
- **Codex の構造抽出の Phase の提案は、製品では 1 件も作られない。** 提案の元は `phaseSeeds`／`existingPhases` だけで、製品の唯一の呼び手（dialog）はどちらも渡さない。`useAi:false` なので空になる。`phaseSeeds` を渡すのは試験だけ。
- review 画面の旗（`codexStructureExtractionFlag.ts`）は既定で開いている。閉じているのは取り込み（上の D2 と同じ runtime の門）。
- 取り込んだ後の Phase の編集は Change Feed（`codex-phase`）に残る。`undo_journal` には Phase 単体の編集は入らない。
- → D3 の変更レビューは、Phase の提案を製品で作る経路が先に要る。

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

未確認：MCP や Rust から直接、D4 の narrative の提案が作られる経路があるか（TS の planner に呼び手が無いことまで確かめた）。

## 5. 互換 adapter と公開済みの保存物（第 1 版 §5 の 4 への答え）

確かめた事実：
- 公開版は v2.0.10（schema 2）だけ。`narrative_*` の表（提案・版・Decision・Artifact・依存宣言・index）は、どれも未公開。
- 公開済みで同一性の対象になるのは、`events`・`codex_entry_phases`・`plot_threads`・`foreshadows` の行。どれも TEXT の主キー id を持つ。
  - ほかに `change_events` と `undo_journal`（v2.0.10 の `grimodex-db/src/migrate.rs:1495,2037`。`scripts/schema-seed-ja.sql` には無い）。前後の値を持つのは `undo_journal` だけで、`change_events` は変えた項目の名前だけ（§2.4）。
- Gate A2 の公開版 fixture（`release_schema_fixture.rs`）が覆うのは `events` だけ。Phase・Plot・Foreshadow の行は無い。
  - M2-D1 の残りの担当の確認：fixture は `scripts/schema-seed-ja.sql` から作られ、seed は公開版の schema の全部を覆っていない。`codex_relations`（v2.0.10 の `migrate.rs:1135`）・`change_events`・`undo_journal` の行も覆っていない。表の有無の根拠は seed でなく v2.0.10 の `migrate.rs` で取る。

起案者の読み：
- D1 §2.4 の「データの移行は不要」は、roster に既存の source identity があることが根拠だった。D2〜D4 は**根拠が違う**。key を公開済みの行 id から読む側で計算し、保存しないことが根拠になる。この条件の下で次のとおり。
  - D2 は可。
  - D3 は Phase だけ可。
  - D4 は根だけ可。
- 新しい key を保存したり突き合わせたりするなら、legacy の行の読み手の扱いが要る。
- 証跡は 2 つに分けて書く。
  - **公開版との互換の証跡**（7 項目の「互換 adapter」）：各 wave で、Gate A2 の fixture に Phase・Plot Thread・Foreshadow の行（D4 は子も）を足す。同じ file（`release_schema_fixture.rs`）を M2-D1 の残りの担当の PR（枝 `claude/m2-a2-release-fixture`、`codex_relations`・`change_events`・`undo_journal` を覆う）が先に触るので、その merge の後に足す。seed に無く v2.0.10 が作る表は残り 26 あり、扱いは公開の前に決める（未決、M2-D1 の残りの担当）。
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

- ~~D2 の比べる元~~：案 D2-1 に決まった（2026-11-26 19:44、追記 14）。
- ~~案 D2-1 の画面の文言と見せ方~~：決まった（追記 17）が、案 D2-1 は取り下げた（追記 18）。
- 案 D2-3（§2.6）の新しい読みの IPC（**新しい契約**）と置き場所。**SRA/1 の PR が見えた段で伺う。**
- 案 D2-2 で、90 日を越えて前後の値を見せること。**保存の拡大。**
- 抽出の run をまたいで年表の同じ出来事を表す仕組み。**新しい契約。** 利用者は起案を選んだ（2026-11-26 20:36、追記 19）。起案は [m2-d2-chronicle-cross-run-identity-draft.md](m2-d2-chronicle-cross-run-identity-draft.md)。
- 年表の同一性の宣言を `narrative-object-identity-declarations.json` に足すこと。key を依存の辺に保存するなら、source の文法の変更も含む。**新しい契約面。**
- Rust の側に Phase の型の検証を置くこと。**新しい契約**になりうる。
- State Transition／Track の永続化。**保存の拡大。**
- D4 の新しい pipeline への移し替え。**新しい送信。**

## 8. やらないこと

- AI への送信の追加・変更、新しい保存、旗を開けること、Story Bible の自動書き換え。
- 作業記録・decisions・ロードマップの更新。この版は起案だけで、判断の ID は振らない。
