# IR の qualify が fast path を外れる理由と設計案（read-only 調査、2026-11-04）

> 注（integrator）：read-only の agent（Opus）の報告の要旨。integrator が実物で確かめたのは、fast path の条件（`src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_chronicle_index/canonical.rs:60-80`：runtime epoch の一致と `proof.validated_read == ReadIdentity::read(conn)`）と、DR-CP4-V-1（`docs/plans/nir1-lane-decisions/cp4-decisions.md:1070`）の (3) が「監査の commit をまたぐ proof の検証済み判定の引継ぎ」を「ReadIdentity による鮮度判定の新しい規則になり、`cq-deferred-decisions.md:5,87` が変えないとした監査の順序と ReadIdentity の検査、GDX-AI-AUDIT-001 に触れる。委任の外の新しい authority にあたる可能性があり、行うならユーザーの確認が要る」として採らなかったこと。

## 外れる理由
- ReadIdentity は connection_epoch、total_changes、data_version、schema_version、user_version（`read_identity.rs:9-14`）。begin の検査の後、query の埋め込みの audit が同じ接続で 2 回 commit し（`runtime_audited_query.rs:114,135`）、`total_changes` が進むので、qualify では 300/300 で外れて完全検査になる。仕組みは DR-CP4-V-1 の経緯（G06 の計装）に既にある。新しいのは規模（約 4.1 ms → 承認 236 件で 55.8 ms）。
- 同じ identity を key にする query context の cache も外れる（約 1.5 ms）。

## 設計案
| 案 | 内容 | 安全性 | ユーザーの確認 |
|---|---|---|---|
| A（推奨） | audit の append だけの commit を、その前後の identity の組として process 内・同じ接続で記録し、`validated_read == before` かつ `current == after` のときだけ完全検査を省く（ctx cache も同じ組で付け替え） | 保たれる見込み：ほかの書込み（自分・別の接続・schema）があれば total_changes か data_version が外れて完全検査に戻る。接続 mutex と IMMEDIATE で割込みは無い | **要る**（DR-CP4-V-1 (3)） |
| B | audit の commit を begin の検査より前へ移す | 安全だが効果なし（完全検査が Raw-ready の前に移るだけ） | 要る。推奨しない |
| C | 同一性を IR の材料の表の世代に絞る | 上げ漏れで気づかれない古さ | 要る。推奨しない |

- A の前に確かめること：append が `ai_audit_events` の INSERT だけか（trigger を含め）、完全検査が audit の行を読まないこと（前例：build の input guard は「new embedding audit events are deliberately outside this input domain」〔`input_guard.rs:1-4`〕）。
- A が断られた場合の委任内の代替：段 1 の延長（封印済みの世代を key に、run をまたいで scope-dependency の bindings を保持。不変性の確認が要る）。

## 見込み（推測）
- 段 1 だけ：qualify 約 26 ms（D=10.84 ms に収まらない）。
- A＋段 1：中央値 6〜9 ms、p90 は D に近い。

## Raw の側
- query は場面の末尾 500 字（UTF-16）。PD の場面は L0 の ja（45〜85 字）の約 7 倍の長さで、埋め込みの推論が長さとともに増えるのが第一の候補。埋め込みの session に intra-thread の上限が無い（CPU の競合）が第二の候補。102.7 ms には audit の commit 2 回を含む。B（54.2 ms）は固定 24 case の値で、実際の長さの小説では Raw だけで約 2 倍。P を変えるのは委任の外なので提案しない。
