# 脅威モデルの追補：generic SQL の guard が拒否する列（2026-11-17）

- 状態：**追補**。形はユーザーの回答「追補にする (Recommended)」（`user-confirmation-2026-11-17-s2-effort-budget-preflight-and-envelope-addendum.md`）による。確認済みの chat IR の脅威モデル（`contract-confirmation-2026-11-09/`、contracts `357a87b7`、SHA 固定）は書き換えない。
- 根拠：ユーザーの回答「envelope だけ閉じる (Recommended)」（contracts `a56a808b`）。実装は PR #933（merge commit `8452a078`）、判断の記録は repo の `docs/plans/nir1-lane-decisions/generic-sql-envelope-decisions.md`（DR-GSQLENV-*）。
- 下書きは `fusion-eval-data/design-notes/generic-sql-envelope-addendum-draft.md`。本文は下書きと同じで、状態と根拠の行だけを直した。

## 追補の本文

### A. generic SQL の guard の実際の範囲

renderer の generic SQL（`db_execute`／`db_execute_batch`）の authorizer は、次の（表, 列）の対の読みを `RENDERER_SQL_TYPED_PAYLOAD` で拒否する。guard は mode を問わず走る。ただし restricted では、これらの表は closed の表で D2a の `D2A_EGRESS_DENIED` が先に返る（順序は試験で固定。guard は restricted の挙動を変えない）。unrestricted でだけ `RENDERER_SQL_TYPED_PAYLOAD` が返る。

| 表 | 列 | 備考 |
| ---- | ---- | ---- |
| `narrative_proposals` | `payload_json` | #572 から |
| `narrative_proposal_revisions` | `payload_json` | #572 から |
| `narrative_proposal_revisions` | `reconciliation_envelope_json` | この変更で追加。IR の statement（summary、actuality、attribution、narrativeFrame）と `evidenceSet[].quote` を持つ列 |

拒否は直接の読みだけでなく、別名、subquery、CTE、`json_extract`／`length` などの関数、WHERE／ORDER BY での参照、view 越しの参照、`SELECT *` に及ぶ（試験で固定）。列を選んだ読み（`id`、`proposal_id`、`origin_kind`、`reconciliation_envelope_digest`、`plan_fragment_json`、`plan_fragment_digest` など）は通る。

### B. 閉じていないもの（設計上の公開面）と、それが意味すること

- `narrative_extraction_artifacts.payload_json`：generic SQL で読める。IR の summary と quote、原稿の snapshot を持つ（G1 §3 の観測は bundle 経由。generic SQL での読取は guard が artifacts を見ないコードの読みと既存 journey の使用実績による）。
- review bundle（`narrative_extraction_get_run_review_bundle`）：chronicle の run では artifacts の本文を返し、製品の review・適用の画面と抽出 run の再開（cold hydration）が使う。typed Entity/Relation の run では `NIR1_ENTITY_RELATION_REVIEW_BUNDLE_UNAVAILABLE` で拒否する。
- restricted の closed／read-open のどちらにも入らない 28 表：変えていない（確認済みの台帳のまま）。
- `plan_fragment_json`：変えていない。現行の writer が 0 件で値は NULL（DR-GSQLENV-2、DR-GSQLENV-9）。履歴では #510（2026-08-13、`dc712a59`）が一度だけ書き、同じ batch の #526 が 6 秒後に除いた。release の tag には入っていない。この列に値を書く変更は、その時点で本文を持つかを再判断する。

したがって、**chronicle の IR では、envelope を閉じても乗っ取られた renderer の到達は減らない**（artifacts の列と review bundle で同じ内容に届く）。乗っ取られた renderer が範囲外である結論（脅威モデル §4.1・§4.4）は変わらない。この変更の価値は「guard の主張（Native-only の typed payload は generic SQL で読めない）と実態を合わせる」ことにある。

### C. ★3 の推奨 (b) の理由 2 について

- 理由 2「IR の本文が generic SQL で読めない正本の外に写らない」は、**成り立つとは書かない**。envelope を閉じた後も、chronicle の IR の本文は artifacts の列と review bundle という別の経路で generic SQL／typed command から読める（上の B）。
- 理由 1（ユーザーが (c) で訂正した向き「本文は残さない」）は残る。**結論 (b) の向きは変わらない。**

### D. typed Entity/Relation の run

review bundle の迂回路が意図的に無いので、envelope は generic SQL 上の写しだった。envelope を閉じると、generic SQL 上の写しが減る（`payload_json` と同じ扱いになる）。typed の writer（`create_in_tx`）自体は `narrative_extraction_artifacts` に書かない（`nir1_entity_relation.rs` に参照なし。静的な grep）。ただし、typed の run が属する抽出 run に既にある artifacts（原稿の snapshot など）に Evidence の本文が含まれるかは**読んでいない**。

## 未解決・未確認（この追補では決めていない）

1. typed Entity/Relation の run が属する run の artifacts の中身（Evidence の本文の有無）：未確認。
2. 追補か新版か：追補に決まった（2026-11-17）。
3. artifacts の `payload_json` と review bundle を閉じない決定の再訪：公開の直前の凍結の後に必要なら別の確認。
4. 28 表（確認済みの台帳）のうち確認の後に追加された `narrative_scope_project_defaults` の扱い：今回は変えていない。
5. `plan_fragment_json`：現行の writer は 0 件だが、過去の版（#510、2026-08-13、数秒の窓。DR-GSQLENV-9）が書いた値が、その窓の master から作った開発 DB に残りうる（残っていれば `payload` を含み本文を持つ）。据え置きの判断にこれを含めてよいか伺う。
