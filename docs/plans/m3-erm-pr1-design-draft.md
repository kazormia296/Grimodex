# ERM PR 1（規則・lineage の保存の基盤）の設計草稿

Status: 草稿（起案者 grimodex-13、2026-11-26）。実装の前の技術設計で、ADR 015（Proposed）の PR 1 にあたる。
作者が確認した事項は ADR 015 §1・脅威モデル（版 v4）・保存の承認（「作品のファイルに次の記録を足します（ファイルの構造の版が 1 つ上がります）」）。
この草稿の判断は、M3 の前倒し（2026-11-23 のユーザー決定：技術判断は NIR-1 と同じ範囲で委任）による技術判断で、判断の ID は DR-M3-39 とする。新しい保存・送信先・閾値・契約・脅威モデルの変更は委任に含まれず、伺う。

## 0. 範囲

入れるもの：

- schema の版上げ 1 回。承認された 3 群（規則の版の履歴／統合・分割の履歴と項目の対応表／提案が使った規則と当て直しの結果）の表を**全部この版で作る**。この 3 群について後の PR で版を上げ直さない（「版上げ 1 回」はこの 3 群に限る。位置つきの言及の索引など、ADR 015 §5.2 の別の索引は別の版上げになりうる）。
- 規則の revision の typed native writer（作成・置き換え・撤回）と reader（Rust だけ）。
- 4 つの台帳への登録：profile egress、Change Feed writer／protected writer、スナップショットの復元（対象外の分類と park）、schema contract。`policies/narrative/*.json` を変えるので impact gate の対象。
- 守りの試験（§6）。

入れないもの（後の PR）：

- N-API・IPC・renderer の command と画面。最初の画面の PR で足す。
- 統合・分割の writer（PR 2）、規則の適用と当て直しの writer（PR 3）、検索・関連シーン・chat への適用（PR 4）、健全性の検査（PR 5）。
- 語の一覧、finding の契約の変更、統合の「隠す／見せる」の文言。どれも伺いが要る。

## 1. 表（版 47 または 48。番号は merge の順で、年表の CED/1 と合わせる）

すべて project 単位で、`project_id` は `projects(id)` に `ON DELETE CASCADE`。Codex の項目と場面は **FK を張らずに ID で参照**する。張ると、Codex の範囲の復元（項目を消して入れ直す）で版の履歴が CASCADE で消えるか、復元が止まる。存在・project・削除済みの確認は適用の時に native が行い、当たらない規則は「当たらない」として数える（ADR 015 §2）。

### 1.1 `identity_correction_rule_revisions`（規則の版の履歴）

| 列 | 意味 |
| --- | --- |
| `id` TEXT PK | revision の ID |
| `project_id` | 作品 |
| `rule_id` TEXT | 規則の系列の ID（最初の revision の作成時に振る） |
| `revision_no` INTEGER ≥ 1 | `UNIQUE(rule_id, revision_no)` |
| `supersedes_revision_id` TEXT NULL | 前の revision。`UNIQUE` にして、1 つの revision の後継は 1 つだけ（同時の置き換えは片方が制約で落ちる＝OCC） |
| `state` | `active`／`retired`（撤回は `retired` の新しい revision） |
| `kind` | 5 種（`must-link-surface`／`cannot-link-entries`／`preferred-binding`／`preferred-canonical-name`／`suppressed-merge-candidate`）の CHECK |
| `scope_kind`・`scope_scene_id` | ADR 009 の `any`／`exact`。`exact` のときだけ場面 ID を持つ CHECK |
| `surface_text` | 表記の原文だけを保存する（正規化した値は保存しない）。表記を使う 2 種（must-link-surface・preferred-binding）で必須の CHECK |
| `entry_id`・`other_entry_id` | 対象の項目。組を使う 2 種（cannot-link・suppressed-merge）は `entry_id < other_entry_id` に並べ替えて保存する CHECK |
| `canonical_name`・`keep_previous_as_alias` | preferred-canonical-name だけ |
| `reason` TEXT NULL | 作者の理由の文 |
| `provenance_kind`・`provenance_ref` | 作った画面の文脈（例：review の提案の版から）。種類は CHECK |
| `actor_id`・`created_at`・`request_id` | `UNIQUE(project_id, request_id)` で再送を同じ結果にする |

- **種類ごとの列の組み合わせ**（CHECK、必須の列は NOT NULL 相当の条件を CHECK の中で書き、NULL で通らないようにする）：
  - `must-link-surface`・`preferred-binding`：`surface_text` と `entry_id` が必須、`other_entry_id`・`canonical_name`・`keep_previous_as_alias` は NULL。
  - `cannot-link-entries`・`suppressed-merge-candidate`：`entry_id` と `other_entry_id` が必須で `entry_id < other_entry_id`、`surface_text`・`canonical_name`・`keep_previous_as_alias` は NULL。
  - `preferred-canonical-name`：`entry_id`・`canonical_name`・`keep_previous_as_alias`（0／1）が必須、`surface_text`・`other_entry_id` は NULL。
  - `scope_kind IN ('any','exact')`、`any` なら `scope_scene_id IS NULL`、`exact` なら NOT NULL。`state IN ('active','retired')`。`revision_no = 1` なら `supersedes_revision_id IS NULL`、2 以上なら NOT NULL。
- index：`(project_id, kind)`、`(project_id, entry_id)`、`(project_id, other_entry_id)`、`(project_id, scope_scene_id)`。表記の照合は規則が少数の見込みなので、project の今の規則を全部読んで renderer 側で正規化して比べる。
- **書き換えない**：`BEFORE UPDATE` の TRIGGER で常に拒む（既存の `narrative_revision_source_basis` と同じ形）。DELETE は project の削除と復元だけが行い、writer には削除の API を作らない。
- 今の規則＝後継の無い revision のうち `state='active'` のもの。系列の先頭の表は作らない（書き換える行が要らない）。
- 正規化：保存しない。照合する側が、今の抽出の照合と同じ関数（`src/features/codex/codexCandidates.ts` の `candidateKey`：前後の空白の除去・NFC・英大文字の小文字化）で原文から都度求める。書き換えられない行に正規化済みの値を持つと、正規化を変えたときに照合し直せないため。規則は作品あたり少数の見込みで、都度の計算で足りる。敬称の除去と部分一致には使わない（ADR 015 §2。`matchExistingEntity` は敬称を除いた照合もするが、規則には当てない）。native 側で表記の重複を検査する必要が出たら、同じ規則の Rust 実装と共通の試験の値を足す（PR 3／PR 5）。

### 1.2 `identity_lineage_operations` と `identity_lineage_mappings`（統合・分割の履歴と対応表）

- operations：`id`、`project_id`、`op_kind`（`merge`／`split`／`undo`）、`undoes_operation_id` NULL（取り消しは `op_kind='undo'` の新しい行。同じ project の operations に FK、`UNIQUE`＝同じ操作を 2 回取り消さない、`undo` のときだけ NOT NULL の CHECK）、`reason`、`actor_id`、`created_at`、`request_id`（`UNIQUE(project_id, request_id)`）、`narrative_commit_id` NULL（PR 2 の atomic commit との対応）、`applied_change_sequence` INTEGER（適用した transaction で追記した canonical の `change_events` の sequence）。
- mappings：`operation_id`（operations に FK・CASCADE）、`ordinal`、`source_entry_id`、`target_entry_id`、`source_disposition`（`retired`／`retained`。統合では退役、分割では元を残すか）。PK は `(operation_id, ordinal)`。
- reference_assignments（3 つ目の表 `identity_lineage_reference_assignments`）：`operation_id`（FK・CASCADE）、`ordinal`、`reference_kind`（参照の型。語彙は PR 2 で決め、CHECK は付けない＝型の追加で版を上げない）、`reference_id`、`from_entry_id`、`to_entry_id`。統合・分割で動かした参照ごとの before／after。分割の参照の割当て（ADR 015 §5.2 で未決）が決まったときに、この表に書く。PK は `(operation_id, ordinal)`、index は `(reference_kind, reference_id)`。
- 部分復元の後のずれ：operation の `applied_change_sequence` より後に Codex の範囲の復元の event があれば、その lineage は「復元で実態と違う可能性がある」と読み取り時に判定する（PR 2・PR 5。列はこれで足りる）。復元の event の op_type は PR 2 で照合する。
- 3 表とも UPDATE を拒む TRIGGER。PR 1 では書き手が無い（表だけ）。
- 残る危険：Split の参照の割当て（ADR 015 で未決）と、M2-D2〜D4 の同一性（M4 の 2026-11-26 の知らせ：年表の出来事は抽出ごとに ID が変わり、安定な key は Phase・Plot Thread／Foreshadow の行 ID だけ）が決まる前に表の形を固める。参照の型ごとの割当ては mappings の 1 行＝(source, target) では表せない可能性があり、そのときは PR 2 で表を足す（3 群の外の索引として別の版上げ）か、割当ての表を operations にぶら下げる形にする。Codex の範囲の復元の後に lineage が実態とずれる件は §5。

### 1.3 `identity_correction_applications`（提案が使った規則と当て直しの結果）

- `id`、`project_id`、`origin_proposal_revision_id`（元の model output の版。当て直しを重ねても変わらない）、`input_proposal_revision_id`（当てる前の版。抽出・取込みでは origin と同じ）、`output_proposal_revision_id` NULL（規則を当てて記録した新しい版。当てなかった・止めたときは NULL）、`rule_revision_id`（規則の revision に FK。規則は部分復元の対象外で、消えるのは project の削除だけなので張れる）、`route`（`extraction`／`import`／`reapply`）、`outcome`（`applied`／`conflict`／`not-applicable`／`stale`）、`reason_code`（理由ごとの件数はこの列と `outcome` を `reapply_batch_id` で集計して出す）、`reapply_batch_id` NULL、`created_at`。
- CHECK：`outcome='applied'` なら `output_proposal_revision_id` は NOT NULL、それ以外は NULL。`UNIQUE(reapply_batch_id, input_proposal_revision_id, rule_revision_id)`（再送で同じ行を重ねない。抽出・取込みでは batch の代わりに run の ID を入れる）。index：`(project_id, reapply_batch_id)`、`(origin_proposal_revision_id)`、`(input_proposal_revision_id)`、`(output_proposal_revision_id)`、`(rule_revision_id)`。
- 部分失敗：batch の中で 1 件ずつ transaction を分けるか、batch 全体を 1 つにするかは PR 3 で決める。どちらでも、失敗した提案は `outcome='stale'` または `conflict` の行として残し、成功の件数に混ぜない。OCC：PR 3 の writer は、output の版と application の行を保存する同じ transaction の中で、入力の版が今も提案の今の版であることと、規則の revision が今も後継の無い active であることを確かめる（列の保存だけでは OCC にならない）。
- 提案の版への 3 つの参照は `narrative_proposal_revisions` に FK・CASCADE（提案の版が消えれば記録も消える。提案の表は部分復元の対象外なので、復元とはぶつからない）。元の model output との対応は `origin_proposal_revision_id` で辿る（ADR 015 §6）。提案の版を個別に消す経路は今は無い（適用済みの版は既存の TRIGGER が削除を拒み、未適用の版は project の削除でだけ消える）。将来そうした経路を足すときは、適用の記録も一緒に消えることを意図どおりか確かめる。
- UPDATE を拒む TRIGGER。PR 1 では書き手が無い。

## 2. 書き込みの入口（PR 1 は規則の revision だけ）

- `create_rule_revision`・`supersede_rule_revision`・`retire_rule_revision`（`grimodex-db`）。既存の `foreshadow_create` の形（`run_atomic_create` で `BEGIN IMMEDIATE`、同じ transaction で canonical と narrative の Change Feed を追記）に合わせる。
- 呼び手：authority route が `human-direct` のときだけ通す。agent・import・maintenance・mcp の route は native で拒む（ADR 015 の版 v4 の「native 側で呼び手を拒む試験まで足せるか」への答え＝足せる）。画面の操作かどうかは確かめない（版 v4）。
- 引数の検査（native）：project の存在、kind ごとの必須の欄、scope の形、組の並べ替え、置き換え・撤回の前の revision が同じ project の今の revision であること。項目・場面の存在は確かめて、無ければ拒む（作る時点では消えた項目の規則を作らない）。

## 3. Change Feed

- canonical の `change_events`：domain は新しく `identity-correction`、op は `rule.revise`。**payload は `ruleRevisionId`・`ruleId`・`kind`・`state` だけ**。表記・項目 ID・場面 ID・名前・理由は入れない。payload の外の列も固定する：`entity_type`＝`identity_correction_rule`、`entity_id`＝規則の revision の ID、`scene_id`＝NULL（場面 scope でも入れない）。監査の ZIP（`legacyEvidence.ts`）は `change_events` の全列を種類で絞らずそのまま出すため（codex-jobs/m3-erm-pr1-facts.out.md の 5）。
- 規則の event は Undo の対象にしない（取り消しは撤回の revision）。Undo・履歴の表示・timelapse の caption が知らない domain をどう扱うかは facts3 の結果で決める。
- narrative の transaction：依存する提案の freshness を古くする伝播は narrative の表を読む（`load_change_batch_envelope`）。PR 1 では依存先が無いので、無効化の key は規則の ID までにとどめる（表記や項目 ID を key にすると、narrative の表が別の漏れ口になる）。当て直しは PR 3。
- `change-feed-writers.json` の operation は `required`、`protected-writers.json` に表と writer を登録する。

【作者の回答（2026-11-26、原文は handoff の m3-user-answers-20261126i.md の問 1）：「この形でよい」】訂正の記録は規則の ID と種類だけ。作者が自分で出す監査の ZIP と timelapse の ZIP は「AI に隠す」の守る先から外す。AI・検索・読者向けの書き出しがログを読むようになるときは、その時点で隠す判定を掛ける（その機能は別に伺う）。脅威モデルの版 v5 として ADR 015 に記録する。以下は回答の前の起案者の理由：理由：ZIP は作者向けの書き出しで、脅威モデルの (1) が出さない先として挙げるのは AI・検索・読者向けの書き出し。ID と種類からは、隠した人物の名前・表記・対応・理由は分からない。件数（規則の数）は分かるが、隠した人物かどうかとは結び付かない。

## 4. 読み取りの閉じ方（profile egress）

- 5 表とも `closed`（renderer の汎用 `db_execute` の読み書きを native の authorizer が拒む。既存の例は `narrative_proposal_revisions`）。
- AI の読み取りの allowlist（`electron/shared/mastraRead/tables.ts` の `MAIN_READ_TABLES`）には載せない。
- 読む入口は typed reader だけ（PR 1 は Rust のみ）。

## 5. スナップショットと復元

- 作品全体のバックアップ（`VACUUM INTO`）には自動で入り、往復する。
- 作品の部分復元（project snapshot）：**5 表とも部分復元の対象外**（提案の表と同じ。語の一覧の回答「スナップショットで戻しても戻らない」ともそろう）。Codex の範囲を戻しても、規則の履歴・lineage・適用の記録は消えず、変わらない。
  - 理由：同じ DB のスナップショットは、書き換えも削除もしない表について常に今の部分集合になるので、「足すだけ」は何もしない復元と同じ。「置き換え」は確認済みの「版を残して書き換えない」とぶつかる。
  - 前提：スナップショットの中身が別の DB・別の作品から入る経路が無いこと（facts3 の問 4 で確かめる）。あれば前提が崩れるので見直す。
  - 結果：戻した項目に、スナップショットより後に作った規則が残る。項目が無ければ当たらず、PR 5 の健全性で示す。統合の後に Codex を戻すと lineage は実態とずれる。PR 2 がこれを列なしで読み取り時に導けるか（例：lineage の対象の項目が今ある・無いで判定）を、schema の独立レビューの問いに入れる。
  - **画面で見える挙動**。作者の回答（2026-11-26、同じ記録の問 2）：「残す」。作品全体のバックアップからの復元では規則も一緒に戻る。
- park：新しい FK は `project_id`、mappings／reference_assignments→operations、operations→operations（取り消し）、applications→proposal revisions・rule revisions だけで、復元で消える親を指さないので `NOT_PARKED` に理由つきで分類する。

## 6. 守りの試験（PR 1 で入れるもの）

1. 5 表とも、renderer の汎用 `db_execute` から読めず書けない（native の authorizer）。
2. `MAIN_READ_TABLES` と profile egress の台帳で、5 表が `closed` で、AI の読み取りの許可一覧に名前が無いことを固定する。訂正の命令が AI の道具の一覧と standalone MCP に無いことの試験は、命令（IPC）を足す PR に持ち越す（PR 1 には命令が無く、試験が必ず通るため）。
3. writer が `human-direct` 以外の route（agent・import・maintenance・mcp）を拒む。
4. 規則の event の行全体（payload の key と、`entity_type`・`entity_id`・`scene_id` の列）を固定し、表記・項目 ID・場面 ID・名前・理由が入らないことを確かめる。narrative の側の無効化の key も規則の ID だけであることを確かめる。
5. revision の UPDATE を TRIGGER が拒む。置き換えの競合（同じ revision を 2 回置き換える）は片方が落ちる。
6. 別の作品の revision の置き換え、存在しない項目・場面を指す規則の作成を拒む。
7. 作品全体のバックアップと復元で 5 表が往復する。作品の部分復元（Codex の範囲を含む各 scope）で、5 表が変わらず、復元が止まらない。
8. migration：版 46 の DB から上がり、invariant が通る。

## 7. 版の番号の扱い

版番号に触る変更（`grimodex-core` の 3 つの定数、版を固定した試験 5 か所、`src/db/generated/schema-contract.json`）は最後の別の commit にする。年表の CED/1 の移行と merge の順で 47／48 を決める（年表の担当と合意済み、2026-11-26）。
