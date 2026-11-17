# unrestricted の generic SQL で `reconciliation_envelope_json` を拒否する — 判断の記録（DR-GSQLENV）

この文書は、generic SQL の guard（`execute.rs` の `renderer_typed_payload_read_rejection`）に列を足す変更の最初の mutation の前に、技術判断と信頼境界を残す。
契約と脅威モデルの確認ではない。確認は下の「出所」のとおりユーザーが行った。確認済みの脅威モデルの文書は書き換えない（追補の下書きは repo の外に置く。DR-GSQLENV-6）。

## 置き場所の判断

- 既存の lane 文書に、`execute.rs` の generic SQL guard を変える lane の判断を持つものは無い。`chat-ir-s1-decisions.md` の DR-CHATIR-S1-10 はこの非対称を「事実の記録。別の lane で扱う」とだけ書き、guard を変えない判断だった。
- 契約の PUB-G の前提の一覧（contracts `pubg-prereq-inventory-2026-11-03.md` の 2026-11-17 追記 6）には、この項目の番号が付いていない。`DR-PUBG-<番号>` の形の ID は作らず、lane の名前で `DR-GSQLENV-<連番>` とする。
- そのため新しい文書にする。README の表と続行計画の作業記録にそれぞれ 1 行足す。

## 出所

| 項目 | 内容 |
| ---- | ---- |
| この lane の位置 | **NIR-1 の残レーンの事前委任の外**。AGENTS の事前委任は適用しない。根拠はユーザーの回答（下）で、技術判断はその回答の範囲内に限る |
| ユーザーの回答（逐語） | contracts の commit `a56a808b9e9e331457bd48e1771a0a146fc895cc`（枝 `claude/nir1-contracts`）の `docs/plans/nir1-fusion-records/ir-chat-pilot-2026-11/user-confirmation-2026-11-17-generic-sql-envelope.md`（git blob `31fb6d0424d4583b45c4ca33f26c9c8bf81f5077`、SHA-256 `b2eec6d021468633420898a8ae0687f7383820f08a71364b112b47e429ff9aeb`）。回答：「envelope だけ閉じる (Recommended)」（2026-11-17）。内容：unrestricted の generic SQL で `reconciliation_envelope_json` を拒否する。`plan_fragment_json` は中身を確かめてから決める。artifacts の `payload_json`、review bundle、restricted の unlisted 28 表は変えない。時期は公開の直前の凍結の前。凍結の pin に当たる file を変えるなら 9 回目の正式 run の後に merge する |
| 資料 | repo の外の `/home/grimodex/fusion-eval-data/design-notes/generic-sql-envelope-asymmetry-question-2026-11-17.md`（確認の資料）と `generic-sql-envelope-asymmetry-2026-11-17.md`（先行調査。基点 `27d71179`、コードの読み） |
| 先例 | #572 の `payload_json` の guard（同じ関数・同じエラーコード）。DR-CHATIR-S1-10（非対称の事実の記録） |
| 基点 | `origin/master` `1dcc7b88437b4720350d7e537811d595a716c055` |

## 信頼境界

| 境界・actor | 扱い |
| ---- | ---- |
| 乗っ取られた renderer | 範囲外のまま（確認済みの脅威モデル §4.1・§4.4）。この変更は guard の主張と実態を合わせるもので、**chronicle の IR ではこの actor の到達を減らさない**（artifacts の `payload_json` と review bundle が残る。ユーザーが閉じないと決めた）。typed Entity/Relation の run では review bundle が `NIR1_ENTITY_RELATION_REVIEW_BUNDLE_UNAVAILABLE` で拒否するので、envelope を閉じると generic SQL 上の写しが減る。typed の artifacts に Evidence の本文があるかは**未確認**で、この変更は確かめない |
| renderer（正規の製品コード） | generic SQL でこの列を読む箇所は無い（先行調査の grep、0 件）。製品の画面は変えない |
| journey／fixture（harness の `db_execute`） | この列を読んでいた 3 journey と fixture 1 本を、走行中も読める別 process の read-only 読取に移す（DR-GSQLENV-4）。renderer の拒否を弱める読取面を renderer に足さない |
| 呼び出しの順 | renderer → typed preload IPC → Main → N-API → 共有 Rust。renderer は Node／Electron／N-API を直接 import しない。この変更は共有 Rust の authorizer だけ |
| 新しい読取面・authority | 作らない。typed reader も新しい command も足さない |
| 送信先 | 新しい宛先を作らない |
| 保存 | 保存範囲を広げない。migration・schema を変えない |
| 閾値 | 触れない |
| restricted | 変わらない（`reconciliation_envelope_json` は closed の表の列で、既に `D2A_EGRESS_DENIED`）。closed／read-open のどちらにも入らない 28 表は変えない |

## 判断

| ID | 判断 | 理由 |
| ---- | ---- | ---- |
| DR-GSQLENV-1 | **guard を（表, 列）の対の集合に広げる。対は `narrative_proposals.payload_json`、`narrative_proposal_revisions.payload_json`、`narrative_proposal_revisions.reconciliation_envelope_json`。** エラーコードは `RENDERER_SQL_TYPED_PAYLOAD` を流用し、新しいコードは足さない。mode（unrestricted／restricted）を問わず常に走る（`payload_json` と同じ位置・同じ関数）。`narrative_proposals` に envelope 列は無いので対に入れない | ユーザーの回答。IR の statement と `evidenceSet[].quote` を持つ envelope は、`payload_json` と同じ「Native-only の typed payload」で、guard が `payload_json` だけを拒否していたのが漏れ（先行調査の推測、確度は高め）。コードの流用は、呼び出し側（renderer の wrapper、main の分類）が `RENDERER_SQL_TYPED_PAYLOAD` の文字列で扱っているため、新しいコードは契約の変更になる。列名・表名を message に含めるので原因は区別できる |
| DR-GSQLENV-2 | **`plan_fragment_json` は変えない（拒否しない）。** 根拠：基点 `1dcc7b88` の `git grep -n "plan_fragment_json\|planFragmentJson\|plan_fragment"`（`docs/` を除く repo 全体）で、この列に値を書く箇所が 0 件。`narrative_proposal_revisions` に INSERT する製品の writer（`repository.rs` の 2 箇所、`human_derivation.rs`、`nir1_entity_relation.rs`）は列の一覧にこの列を含めず、値は常に NULL。列は `migrate.rs` の `add_column_if_missing` で足されるだけ。出てくる他の箇所は schema の宣言（`schema.ts`、`schema-contract.json`、`workspace_schema.rs` の列の存在確認）、immutability の trigger の比較（`OLD.plan_fragment_json IS NOT NEW.plan_fragment_json`）、その比較を確かめる試験（`narrative_c2a_persistence.rs` が `'{}'` を UPDATE する）だけ。`commit.rs` の `planFragments` は prepared plan の sealed plan（別の表）の中の key で、この列ではない。つまり **IR の本文を持たない**（持つ writer が無い）。**再判断の条件**：この列に値を書く writer を足す変更は、その PR で本文を持つかを判断し、持つなら guard に足す | ユーザーの回答「IR の本文を持つなら同じく拒否し、持たないなら変えない」。持たないものを閉じると、空の列を読む正当な読取（digest と同じ並びの検査など）を理由なく壊す。grep は静的で、網羅の保証はない（動的に組んだ SQL は見つからない）が、書く経路は Rust の writer に限られ、renderer は narrative の表を DML できない（protected writer） |
| DR-GSQLENV-3 | **trigger 経由の Read が guard に当たらないことを試験で固定する。** envelope 列を読む trigger は 4 本（`narrative_proposal_revisions_v2_monotonicity_guard`〔BEFORE INSERT〕、`narrative_proposals_v2_pointer_monotonicity_guard`〔BEFORE UPDATE OF current_revision_id〕、`narrative_proposal_revisions_v2_immutable_update_guard`、`narrative_revision_envelope_immutable_update`〔BEFORE UPDATE〕）。authorizer は trigger の本体の Read も報告する。これらを発火できるのは revisions／proposals への DML で、renderer の DML は protected writer（Table 保護）で、direct も cascade（`DELETE FROM projects`）も最初に拒否される。試験で、renderer のこれらの DML の拒否のコードが `PROTECTED_WRITER_SQL` のままで `RENDERER_SQL_TYPED_PAYLOAD` に変わらないことを固定する。変わる／発火できる経路が見つかれば accessor（trigger 名）での除外を設計し直す（その場合は止めて相談） | trusted の writer（Native）は authorizer の対象外で壊れない。renderer の経路の拒否の理由が変わる退行を検出する |
| DR-GSQLENV-4 | **journey 3 本と fixture 1 本は、走行中の別 process による read-only 読取に移す**（資料の「移行の 2 形」のうち走行中も読める形）。`sqlite3 -readonly -nofollow -bail -json <workspace>/grimodex.db` を子 process で実行する（harness が既に使う `sqlite3` CLI と同じ道具。同じ process 内で別の SQLite library が同じ DB を開くと Native の POSIX lock を落とす恐れがあるので、必ず別 process）。helper は `electron/scripts/nir1-reviewed-child-db.mjs` に足す（既に closed fixture の外部読取を担う file。新しい file を増やさない）。既存の `readClosedRevisionSnapshot` は「全 process の終了後」「全列が非 NULL」の契約なので流用しない。`product-journey-harness.mjs` は変えない。呼び出し側は `inspectNative`／`inspectEditedNative` に workspace の path を渡す（current-scene journey の 5 箇所を含む）。assert の中身（envelope の schemaVersion、revisionBasis、digest の一致）は変えない | 「製品の画面は壊さない」（ユーザーの回答）。renderer 経由の代替の typed reader は作らない（新しい authority）。inspect が走行中に複数回呼ばれるので、process 終了後の読取（形 (i)）は assert の位置を変える。形 (ii)（走行中の別 process）は assert の位置を保てる。WAL の DB を `-readonly` で読む別 process は writer の process と共存できる（試験で確かめる） |
| DR-GSQLENV-5 | **merge の時期は凍結の照合の結果で決める。** 変更 file が `origin/master` の `observation-prep.mjs` の `SOURCE_PINS`（74 path）、`r5-check-runner.mjs` の静的 import の閉包＋`electron/scripts/build.mjs`、`scripts/quality/nir1-graph-eval`・`scripts/quality/nir1-graph`・`evals/nir1-graph` のどれかに入るなら、この PR は 9 回目の正式 run の後まで merge しない。入らないなら通常の merge の手順に従う。結果は PR 本文に書く。この PR では push・PR を作らない（依頼の範囲外） | ユーザーの回答（凍結の pin に当たる file を変える場合の停止点）。凍結の pin の内容は照合してから報告する |
| DR-GSQLENV-6 | **脅威モデルの追補は repo に入れず、下書きを repo の外に置く**（`/home/grimodex/fusion-eval-data/design-notes/generic-sql-envelope-addendum-draft.md`）。書く内容：guard は 3 つの（表, 列）の対。envelope を閉じた後も artifacts の `payload_json`（generic SQL）と review bundle は設計上の公開面として読める。乗っ取られた renderer は範囲外のまま。★3 (b) の理由 2 が成り立つとは書かず、理由 1 が残ると書く。typed の artifacts の本文の有無は未解決として残す | 確認済みの脅威モデル（SHA 固定）は書き換えない。追補の採否（追補か新版か）はユーザーに伺う項目で、この lane では決めない |

## 実施しないこと（ユーザーの回答で閉じたもの）

- `narrative_extraction_artifacts.payload_json` の拒否、review bundle の変更、restricted の unlisted 28 表の closed 化。
- 新しい typed reader・command。
- 閾値・送信先・保存範囲の変更。
