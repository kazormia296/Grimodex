# Gate B2 スタックPR レビュー総括（#509〜#525）

> **このドキュメントについて**
> AI解釈層（Narrative Reconciliation Boundary）とその認証を巡る一連のスタックPRを、3フェーズに分けて敵対的にレビューした記録。
> すべて**実コード・実CI・実差分で独立に裏取り**しており、PR本文の自己申告は証拠として採用していない。
> 対象: **#509〜#518**（Narrative Native cutover）／**#520〜#524（C0〜C4）**（認証ハーネス構築）／**#525**（認証ハーデニング）。

---

## 0. エグゼクティブサマリ

このスタック群は「AIの意味判断（Reconciler）を非権威的な Proposal に留め、DB書き込みの権威を prepare-apply 2相コミット・OCC・SQL authorizer・runtime policy に集約する」という野心的な認可アーキテクチャ（ADR-004）の実装と、その**認証**の構築である。

| フェーズ | 対象 | 評定 | 一言 |
|---|---|---|---|
| 1 | #509–#518 Narrative cutover | **設計に要修正** | 実装(cutover)は堅牢だが、中核保証「Native writerが唯一のwrite path」が**3経路で破れ**、Iron Law 8/9 が**宣言のみ・未実装** |
| 2 | #520–#524 C0–C4 認証ハーネス | **request-changes（空虚）** | 認証の足場を約5,700行組んだが、CI未配線・自己申告証跡・freeze未結合・**gold漏洩**で「より精巧な green theater」 |
| 3 | #525 認証ハーデニング | **Approve with nits** | フェーズ2の偽陽性経路を実効的に fail-closed 化。**現時点で構築可能な false-PASS は無し**。ただし Formal Gate B2 は正しく **INCOMPLETE** |

**通底するテーマ**: 「認証されている」という**主張の信頼性**が一貫して最も脆かった。#525 でハーネス自体は「精巧な足場」から「実効的なゲート」へ移行したが、Gate B2 の**機能要件**（Iron Law 8/9 実装・6 Journey・real browser consent）は依然未完で、Formal PASS は構造的に到達不能（=正しい状態）。

---

## 1. スタック全体像

```
master
 └ #507 Release Gate B Foundation（Narrative Runtime Authority / SQL Protection, マージ済）
    └ #509 B2-0 Restack + schema renumber + writer inventory   (base: master)
       └ #510 B2-1 Prepared Plan seal & apply authority
          └ #511 B2-2 runtime guard matrix 配線
             └ #512 B2-3 Chronicle Native cutover
                └ #513 B2-6 Plot/Foreshadow Native cutover
                   └ #514 B2-4 Codex Native cutover（最大）
                      └ #515 B2-5 Temporal Native cutover
                         └ #516 B2-7 thin Reconciler contract + deferred=0 certification
                            └ #518 close Gate B2 review gaps（+3.8万行、多数のcriticalを収束）
                               └ #520 C0 certification manifest + runner
                                  └ #521 C1 ADR checklist + negative contracts
                                     └ #522 C2 production Chronicle certification
                                        └ #523 C3 web AI consent live journey
                                           └ #524 C4 candidate freeze + decision artifacts
                                              └ #525 harden certification against false PASS
```

- 規模: #509 単体で +101K行（大半は既存 vertical slice の restack）、#518 +3.8万行、C0–C4 計 +5.7K行、#525 +5.2K行。
- 中間PR（#509–#515）は**個別にはCI赤**で単体マージ不能だが、**先端は完全収束グリーン**（後述）。

---

## 2. 根本設計の評価（ADR-003 / ADR-004）

### 設計思想
- **ADR-003**: 責務ごとに一方向の authority を固定（物理schema=migration、tracked write=typed native writer、renderer型=Drizzle projection）。schema contract を JSON 生成し drift を CI 検出。
- **ADR-004**: 「Deterministic Core / Typed Writer は prose から意味的妥当性を推論しない」。Reconciler は**非権威的 Proposal** のみ生成。12の **Iron Laws** で境界を宣言。

### 🔴 最重要: 脅威モデルの取り違え
実装された防御の大半（SQLite authorizer、certification gate、3つの手書きregistry）は **「renderer / MCP generic SQL という untrusted origin」** を固めることに集中している。しかし **Grimodex はローカル単一ユーザーの Electron アプリで、renderer はアプリ自身**。真の脅威は悪意あるリモート攻撃者ではなく **AIエージェント（extraction / reconciler / scaffold）の暴走・バグによる、ユーザー自身の原稿・Codex の自己破壊**である。

ところが **AI の実際の書き込み経路（typed writer + `agent_write_bundle`）は authorizer を一切通らない trusted 経路**であり、certification はこの trusted 経路を構造的に検査対象から除外していた。→「守っている境界」と「守るべき脅威」がずれている。

### Iron Laws の実装乖離
- **Iron Law 8**（locked / user-authored field の AI 上書き禁止）: ADR で Native Writer 不変条件かつ Gate B2 必須検証と宣言。**実装ゼロ**（`grimodex-db` 内の "locked" 参照13件はすべて DBロック / 移行スナップショット / ChronicleパネルUI設定で、フィールド保護enforcementではない）。**脅威モデルに最も直結する保護が不在**。
- **Iron Law 9**（Reconciler は SQL / DB Operation / Writer command を返さない）: reconciler contract が `payload: Record<string, unknown>` で素通し、かつ**どの本番コードからも import されない死蔵モジュール**。boundary テストは contract 自身の型ファイルを grep するだけで実装を拘束しない。

---

## 3. フェーズ1: #509–#518（Narrative Native cutover）

### CI の実態（スタック層順序ハザード）
| | 実測 |
|---|---|
| **先端 #518** | 全20チェック **GREEN** |
| **#509 単体** | 8ジョブ **FAILED**（Shared Rust, Frontend, Quality, Electron各種, CodeQL） |

→ **各段が独立レビュー可能・独立マージ可能という前提は不成立**。認可コアが #509(10万行)・#518(3.8万行) の巨大 restack に埋没し、中間層は壊れた状態で積まれ、最後にまとめて直っている。二分探索性・部分ロールバック性を喪失。

### #518 が多数の critical を収束（先端で検証）
per-PR エージェントは各段を単体レビューしたため severe な指摘が多いが、その多くを **#518 が系統的に修正**していた（先端コードで確認）:
- ✅ #509 critical: semantic_key グローバル UNIQUE が legacy/restore 経路（DEFAULT ''）と非互換 → 先端では明示INSERT/検証で解消
- ✅ #515 critical: `tree_node_patch` OCC 事後比較レースでエディタ本文が無音消失 → 先端では `WHERE id=? AND version=?` のアトミックCASに修正（`domain_writes.rs:1070-1125`）
- ✅ #513 important: `plot_thread_branch_update/_delete` 非アトミックOCC → 先端で CAS 化

### 🔴 中核保証の破れ: 認可を迂回する3経路（先端で残存）
「Native typed writer が唯一の write path」という保証に対し、renderer から到達可能な迂回経路:

| # | 経路 | 証跡 |
|---|---|---|
| A | **`agent_write_bundle`** が生connで任意SQLを実行。authorizer も runtime guard も通らない | `agent_writes.rs:1420`（`db.with_conn`→`execute_with_conn`）。guardは typed writer/commit/undo にのみ配線 |
| B | **`undo_journal` replay forge**（Aと独立） | `undo_journal` テーブルは registry 未登録 → renderer generic SQL で偽 journal 行を INSERT → `agent_apply_undo_journal`（gate無し）で replay → 保護表 `foreshadows` に任意内容を書き戻せる |
| C | **registry 未登録の保護対象テーブルへの直接DML** | authorizer は登録済み active エントリのみ拒否。未登録は fail-open |

C の未登録テーブル（native writer が書くのに `protected-writers.json`(29件) に不在）:
`foreshadow_setup_payoff_links`, `codex_detail_semantic_bindings`, `codex_phase_detail_overrides`, `narrative_temporal_nodes/constraints/projections`, `narrative_extraction_runs/tasks/attempts/artifacts`, `import_sessions/commits/captures` ほか。
→ data-migration レンズはこれを**実データ損失**に一般化: 子表は独立OCCも保護も無いのに apply/undo が root版だけをゲートに blind DELETE+再INSERT する（`phase_snapshots.rs:132`）ため、帯域外書き込みが無警告で消える。

### registry の構造的欠陥（同種バグの製造源）
- **opt-in / fail-open**（未登録=許可）。deny-by-default に反転できず、テーブル追加のたびに登録漏れが恒常的に無防備を生む。
- **物理スキーマとの completeness gate が無い**（code→registry の登録漏れ検出テストが存在しない。`active_entries()` すら未使用）。
- ※ RustとNode validator は `include_str!` で**同一JSONを単一ソース**として読むため、Rust⇔Node のドリフトは無い（良い点）。

### 実装バグ（先端で残存）
| severity | バグ | 場所 |
|---|---|---|
| important | `createCodexEntry` が contextMode/icon/childrenBudget/notes を native payload に渡さず**黙って捨てる** | `src/features/codex/api.ts` |
| important | source-basis OCC（Iron Law 10）が `event_create` の1種のみ、他は entity version CAS のみ（TOCTOU） | `commit.rs:1177` |
| important | 子表 blind DELETE+再INSERT データ損失 | `phase_snapshots.rs:132` |
| minor | `ai_audit_events` ハッシュ鎖が open/migrate/restore で自動検証されない（authorizer一枚のみ） | `execute.rs:158` |

### #516（deferred=0 certification）の空洞
- **enforcement の net delta = 0**。active=29/deferred=0 のフリップは base 時点で完了済み、#516 の Rust 変更はテストのアサーション反転のみ。
- 認証の**分母が「registry登録済みテーブル」のみ**で、未登録テーブル（=上記C）を検査しない。
- **active→deferred フリップで enforcement を無検出失効**できる（29テーブル中 active維持を Rustテストが守るのは4つのみ）。
- certification runner が**CIのどのジョブからも呼ばれない**。

---

## 4. フェーズ2: #520–#524（C0–C4 認証ハーネス）

「認証が実際にはゲートしない（green theater）」を最優先で探索。**フェーズ1で指摘した空洞（#1〜#6）は6件すべて依然open**で、その周りに足場が組まれた状態だった。

### 公平な改善点
C0 の判定関数 `decideVerdict` は #516 の死蔵スクリプトより実質改善（`deferredIsPass must be false`、failed/deferred/skipped→BLOCK の fail-closed）。問題は判定関数の**入力・配線・拘束**側に移動した。

### 各PRの穴（ユーザー判定を file:line で裏取り、すべて正）
| PR | 確認した穴 |
|---|---|
| #520 C0 | freeze=`Boolean(--candidate)`だけ／`requireTreeShaMatch`は**runner未参照のデッド設定**／外部証跡が**schema未検証の任意JSON**（手書き `{"passed":true}` で full-ci + 6 journeys 通過）／heavy が `shell:true`+env素通し（`OPENROUTER_API_KEY=...`上書き）／report digest が**中間版hash**で保存ファイルと不一致／`--preflight`+部分run で INCOMPLETE→exit0 |
| #521 C1 | `validate-gate-b2-adr.mjs:141` が**FAILを受理して exit 0**（checklist は実際に9件FAIL、Iron Law 8 含む）／classification の mixed を無条件受理 |
| #522 C2 | live認証テストが `certificationEligible=false` でも exit 0／**gold漏洩**（`productionChronicleScoring.ts:113/94` で actual の clustering/semanticKey に gold期待値を代入 → **常に一致 = 評価が最初から不正**）／production merge段を省略（`matchExisting` に空配列）／appliedProposalIds ハードコード |
| #523 C3 | "live journey"が jsdom／runner が journey Report の中身を検証しない |
| #524 C4 | freeze を runner が読まない（`frozen` は `--candidate` をSHA形式で渡せば自明にtrue）／**Decision Schema の消費者がゼロ**／provisional count drift |

### 先行指摘の閉塞状況（C0–C4 適用後）
| 先行指摘 | 閉じたか |
|---|---|
| #1 認証runnerがCI未配線 | ❌ |
| #2 分母漏れ（未登録テーブル） | ❌ |
| #3 active→deferred 無検出失効 | ❌ |
| #4 Iron Law 8 未実装 | ❌（checklistにFAIL明記のみ） |
| #5 Iron Law 9 未強制 | ❌ |
| #6 registry completeness | ❌ |

→ 総括: **「空洞の周りに足場を組んだだけ」**。特に C2 の gold漏洩は「評価が構造的に通るよう組まれている」ため、検査しないより悪い。

---

## 5. フェーズ3: #525（認証ハーデニング）

head `bd32bde` の最新実コードで独立検証。新規 `certify-gate-b2-bootstrap.mjs` / `certify-gate-b2-bindings.mjs`（+1175）、runner 大改修、contractVersion 5。

### 結論
| 判定軸 | 結論 |
|---|---|
| コードレビュー | **Approve with nits** |
| PR #525 マージ | **可**（CI green済み。下記は非マージブロッカーだが追跡必須） |
| Gate B2 Formal PASS | **不可 = INCOMPLETE**（設計通りの正しい状態） |

**現時点で構築可能な false-PASS は存在しない**（runner/verdict層を敵対的に攻撃したが破れず）。

### 前回 blocking finding の閉塞（すべて実コードで確認）
| Finding | 状態 | 決定的証拠 |
|---|---|---|
| **A** runner provenance | **CLOSED** | bootstrap が clean強制→凍結candidateのdetached worktree生成→worktree内runner実行。**runner自身が再検証**（`certify-gate-b2.mjs:1457-1472` `assertDigestsMatchFreeze`＋commit/tree drift→throw）。`GATE_B2_BOUND_EXECUTION=1` 直起動でも `createWorktree:false→head-match`（HEAD==凍結commit かつ clean）のみ許可。改変→digest drift→PASS不能 |
| **B** preflight exit | **CLOSED** | `:174-176` `--preflight`×5実行フラグ全網羅で parse時throw。`:190-194` `certificationExitCode(report)` は verdict/mode のみ参照（args非依存） |
| **C** journey provenance | **CLOSED（今日）/ PARTIAL（将来）** | 6 Journey全 `status:blocked` → evidence読取より前に blockedSuite return → BLOCK短絡（手書きJSONで外せない）。非blocked経路は実runner実行＋fresh output＋Ajv＋assertion集合検証 |
| **D** provisional decision schema | **CLOSED** | committed decision が schema適合（`digests`許可、verdict=INCOMPLETE）。保存前Ajv検証（`:1779-1787`）。report digest は**最終保存バイト列**でhash＋`.sha256`サイドカー（C0の中間版hashバグ解消） |
| Required informational | **CLOSED** | requiredで `certificationCredit:false` を拒否、informational非credit |

### 新規 findings
**P0: なし。**

**P1 / important**
- **`suiteFromCapture` 未定義クラッシュ** — `certify-gate-b2.mjs:727,737` で呼ばれるが**定義・importが存在しない**（grep実証）。現在は6 Journey全blockedで到達不能（デッドコード）だが、Journey有効化＋runner失敗時に `ReferenceError` で全体crash。fail-closed（exit1）だが**ハーデニングの失敗処理が壊れている**。→ **Journey有効化前に必須修正。**

**P2 / minor**
- `runner.command.includes(sourcePath)` の緩い検証（`:307`）→ デコイ引数で凍結runner非実行のまま任意コードが passing evidence を生成可能（false-PASS、journey active化後のみ）。
- report schema `contractVersion` const 5 が top-level `required` に未登録（`schema:7`）→ 古いreportを受理し得る（integrity、低コスト修正）。
- journey `environmentDigest` が等値照合されず SHA形式検査のみ／runId・commandDigest 束縛欠如（`bindings:822`）→ 将来のjourney active化時。
- Chronicle eval が `matchExistingChronicleEvent(…, [])` で既存eventカタログ常時空（`adapter:156`）→ dedup/already-satisfied 未評価（eval understatement、false-PASSではない）。
- （低確度）scoring の `semanticKey: expected?.semanticKey`（`:175`）→ clustering の gold漏洩は正規化採用で修正済みだが、semanticKey が採点対象なら残存leakage（要確認）。

### CI 評価
- 最新 head 全20チェック **GREEN**。
- Browser 失敗（`ChatPanel.virtualization.browser.test.tsx`, scrollTop 13964 vs <50）は**同一run内で再実行され green**。#525の差分は ChatPanel/virtualization に一切触れておらず、スクロール計時の**既存flake**。
- **通常PR CI green ≠ Formal Gate B2 PASS**。Formal full-CI contract は `acceptedEvents` から `pull_request` を除外（merge commit は candidate tree でない）。Formal には candidate commit 上の push/workflow_dispatch run を checkout-identity artifact で束縛する必要がある。

### full-CI 証跡の堅牢化（前回#2「任意JSON」の実効閉塞）
`verifyFullCiWithGithub`（`bindings:595-761`）が実 GitHub run の head_sha==candidate / run_attempt / conclusion=success / workflow_id / path / event / required jobs を照合し、checkout-identity artifact の commit＋tree==candidate を検証。`gh` 不通は catch→failed（**fail-closed**）。手書きJSONでは偽造不能。

---

## 6. 通底する構造的教訓

1. **認証の信頼性 ≠ 機能の完成**。#525 でハーネスは fail-closed になったが、Iron Law 8/9・6 Journey・real browser consent が未完な限り Gate B2 は INCOMPLETE（正しく）。両者を混同しない。
2. **opt-in / fail-open registry は同種バグを製造し続ける**。deny-by-default + code→registry の completeness gate に反転すべき（フェーズ1 #2/#6、フェーズ2 の分母漏れの共通根）。
3. **宣言だけの Gate は認証の信頼を毀損する**。Iron Law 8/9 のように「ADRで必須検証と宣言 → 実装ゼロ → checklistで[x]/FAID」は、認証の看板と実態の乖離そのもの。実装するか ADR から降ろすかの二択。
4. **stacked-PR 運用の限界**。10万行 restack に認可コアを埋めると、中間層が壊れた状態で積まれ、レビュー可能性・二分探索性・部分ロールバック性を失う。認可コアは独立の小PRに切り出すべき。
5. **脅威モデルを製品に合わせる**。ローカル単一ユーザーアプリでは、renderer/リモートより **AIの自己破壊**が主脅威。防御リソースをそちらへ寄せる（guard matrix・prepare-apply authority・OCC/undo は正対しており残す芯）。

---

## 7. 未解決 / 後続課題一覧

### 認可の芯（フェーズ1由来、Formal PASS に必須）
- [ ] `agent_write_bundle` / `undo_journal` replay を authorizer / runtime policy gate 配下に入れる（trusted 任意SQLバックドアを塞ぐ）
- [ ] registry を deny-by-default + completeness gate（code→registry 登録漏れ検出）に反転。未登録テーブル（temporal / foreshadow子表 / extraction・import台帳）を登録
- [ ] active維持を守る Rustテストを 29テーブル全部に（現状4/29）
- [ ] **Iron Law 8**（lock enforcement）を writer に実装、または ADR から降ろす
- [ ] **Iron Law 9**（reconciler返り値からSQL/DbOp排除）を型・実行時に強制、または降ろす
- [ ] source-basis OCC を event_create 以外の全 operation に配線（TOCTOU）
- [ ] `createCodexEntry` の silent field drop 修正（contextMode/icon/childrenBudget/notes）

### 認証ハーネス（フェーズ3由来）
- [ ] **P1: `suiteFromCapture` 実装**（Journey 有効化の前提）
- [ ] P2: `runner.command` 直接実行の厳密化（デコイ引数拒否）
- [ ] P2: journey `environmentDigest` 等値照合 + runId/commandDigest 束縛
- [ ] P2: report schema `contractVersion` を required に追加
- [ ] P2: Chronicle eval に実 existing-event catalog 注入、semanticKey の採点関連性確認

### Gate B2 Formal PASS（別軸）
- [ ] 6 Journey（prepared-plan-toctou / locked-field-enforcement 等）の runner 実装
- [ ] real browser consent Heavy の実装
- [ ] ADR checklist の FAIL（Iron Law 8/9 等）の解消

---

*レビュー手法: 各フェーズで敵対的サブエージェント群（PR別 + 設計レンズ）を並列起動し、その指摘を本文が実コード・実CI・実差分で独立に裏取り。「壊れている前提で壊し方を構築する」姿勢で、スタイルではなくバグ・脆弱性・偽陽性経路・保証と実装の乖離のみを対象とした。*
