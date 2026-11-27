# ERM PR 3（抽出・取込みへの適用と保存直後の当て直し）の設計草稿

Status: 草稿（起案者 WrokLayer/M3、2026-11-27）。ADR 015（Proposed）の PR 3 にあたる技術設計で、実装・公開の承認ではない。
判断の ID は DR-M3-40 とする（M3 の前倒し〔2026-11-23 のユーザー決定〕による技術判断。新しい保存・送信先・閾値・契約・脅威モデルの変更は伺う）。
前提：PR 1（#1177、schema 48）の表と規則の writer。下調べは handoff の codex-jobs/m3-erm-pr3-facts.out.md と m3-rule-ui-facts.out.md。

## 0. 範囲

入れるもの：

- 規則を当てる native の読み取り（規則の中身を native の外に出さない形）と、その N-API・IPC。
- 構造抽出（`startCodexStructureExtraction`）の候補の照合への適用と、適用の記録（`identity_correction_applications`）。
- 規則を保存した直後の、同じ表記の確認待ちの提案への当て直し（AI を使わない）と、理由ごとの件数。
- 規則を書く命令の IPC（PR 1 の writer を画面から呼べるようにする）。画面は別の PR（下の §6）。

入れないもの：

- 検索・関連シーン・chat の文脈への適用（PR 4）、健全性の検査（PR 5）、統合・分割（PR 2）。
- 取込みへの適用：今の取込み（`importCodexEntries`）は候補を既存の項目と照合せずに項目を作る（下調べの 5）。照合が無い所に規則を当てる場所が無いので、取込みに照合を足すかは別に決める【未決・伺う候補】。

## 1. 規則を当てる場所（最初の分かれ目）

| 案 | 内容 | 利点 | 欠点 |
| --- | --- | --- | --- |
| A. native で当てる（推奨） | renderer は「表記と、それが出る場面の ID」を native に渡し、native が規則を読んで場面ごとの結果（結ぶ項目の ID／競合／当たらない）だけを返す | 規則の中身（表記・理由・組）が native の外に出ない。AI の道具と同じ場所（renderer）に規則が載らない | 表記の正規化（`candidateKey`：前後の空白の除去・NFC・英大文字の小文字化）の Rust 実装が要る。TS と同じ結果になることを共通の試験値で固定する |
| B. renderer で当てる | 規則の一覧を typed reader で renderer に渡し、`matchExistingEntity` の前で当てる | 実装が短い | 隠した人物の表記を含む規則が renderer に載る。chat の AI の道具も renderer で動く |

【起案者案】A。返す結果に入るのは項目の ID（renderer が名簿で既に知っている）と結果の種類だけで、規則の中身は入らない。

## 2. 当て方（ADR 015 §2・§4 の具体）

- 照合は正規化した表記の完全一致だけ（敬称の除去・部分一致はしない）。
- 1 つの表記が複数の場面に出るときは、場面ごとに当てる（場面の規則は作品全体の規則に優先する。ADR 015 §1）。場面で結果が分かれたら、提案を 1 つの結び付けに強制せず、確認待ちに残す（ADR 015 §5）。
- 当たる規則：後継の無い active の revision で、同じ作品、指す項目が今もあるもの。消えた項目・別の作品の規則は当たらない（数えて返す）。
- 競合：同じ優先度で別の項目を指す `must-link-surface`／`preferred-binding`、`cannot-link-entries` に反する結び付けは、勝者を選ばず「競合」として返す。
- `cannot-link-entries`・`suppressed-merge-candidate` は「同一人物・別名の候補」を出す所に当てる。今の製品では候補画面の AI 判定（`candidateJudgment.ts` の `aliasOfId`）が該当する【要確認：これを PR 3 に含めるか、PR 2 の統合の候補と一緒にするか】。
- `preferred-canonical-name` は表示名の提案にだけ使い、照合には使わない。

## 3. 抽出への適用と記録

- 今の抽出は、照合のあと同じ処理の中で提案を保存する（`saveProposalSet`）。照合の時点では提案の版がまだ無い（下調べの 1）。
- 【起案者案】規則を当てる前の結果で提案を保存し（origin の版）、規則で結び付けが変わった提案には、既存の `appendRevision`（OCC は今の版の ID）で新しい版を足す。適用の記録は `origin`＝`input`＝最初の版、`output`＝足した版、`route`＝`extraction`、`reapply_batch_id`＝抽出の run の ID。結び付けが変わらなかった・当たらなかった・競合は `output` なしの行（理由の語つき）。
- これで「モデルの出力と規則を別々に保つ」（ADR 015 §4 の 4）を満たす。版が 1 つ増えるぶん、確認画面の表示が変わらないか（最新の版を出すか）を確かめる。
- 規則が 0 件の作品では、抽出の結果も保存される版も今と同じであることを最初の試験にする（公開前の評価に差を出さない）。

## 4. 保存直後の当て直し

- 規則を保存した writer の後で、同じ作品の確認待ちの提案のうち、同じ正規化の表記を持つものを読む（native）。
- 1 件ずつ、読んだ時の今の版を確かめて（OCC）新しい版を足す。失敗した提案は `stale` か `conflict` の行に残し、成功の件数に混ぜない。適用済み・承認済みの提案には触れない（脅威モデル v3 の (4)）。
- 応答：更新した件数と、更新しなかった理由ごとの件数。画面は件数を出す（文言は §6 で伺う）。
- AI を使わない。規則の中身は応答に入れない。

## 5. 守りの試験（この PR）

- 規則の中身（表記・理由・組）が、当てる読み取りの応答、IPC の応答、Change Feed の記録に入らない。
- 訂正を書く命令と当てる読み取りが、AI の道具の一覧と standalone MCP に無い（PR 1 から持ち越し）。
- `without_renderer_authority_context` の呼び手が `identity_correction.rs` だけ（PR 1 から持ち越し）。
- 外部書き込みの feed（`externalWriteFeedRead.ts`）と執筆統計が、知らない domain の event で止まらない（PR 1 から持ち越し）。
- 規則 0 件で抽出の結果が変わらない。場面の規則が作品全体の規則に優先する。競合で勝者を選ばない。消えた項目・別の作品の規則は当たらない。当て直しが適用済み・承認済みに触れない。部分失敗を成功に混ぜない。
- TS の `candidateKey` と Rust の正規化が、共通の試験値（日本語・英語・全角・結合文字・前後の空白）で同じ結果になる。

## 6. 作者に伺うこと（画面の PR の前）

- 確認画面の「次からも覚える（作品全体／この場面だけ）」の文言と、場面の例外を作るときの表示（ADR 015 §7）。
- 項目の詳細の画面の規則の一覧と撤回の文言。
- 当て直しの件数の表示の文言。
- 取込みに照合を足すか（§0）。

## 7. 未決・残る危険

- 候補画面の AI 判定への `cannot-link` の適用を、この PR と PR 2 のどちらに入れるか（§2）。
- 抽出で版が 1 つ増えることの、確認画面と評価への影響（§3）。
- 当て直しの対象を「同じ表記」で探すための索引（提案の payload の表記を native で引けるか）。下調べの 3 では、版を足す writer はあるが表記での検索は未確認。

## 8. 下調べ 2（codex-jobs/m3-erm-pr3-facts2.out.md）と、それを受けた案

- **隠した人物**：照合の名簿（`readCurrentCodexEntries`）には「AI に隠す」項目も入り、照合の前に場面ごとの判定は無い。今の構造抽出は AI を使わない（`CodexStructureExtractDialog.tsx` の `useAi: false`、AI の分岐は stub）ので、照合の結果は AI に送られない。ADR 013 は抽出の経路を例外に挙げている。【限界・DR に記録】抽出に AI を使う経路を開けるときは、名簿と規則の結果に場面ごとの隠す判定を掛ける。当てる読み取りは「表記を渡すと結び先が返る」ので、規則を 1 件ずつ引ける入口になる（renderer の中の呼び手に限る。AI の道具と MCP には載せない）。
- **規則で足す版の出所**：`narrative_proposal_revisions.origin_kind` は CHECK の無い TEXT（今の値は `legacy-unbound`・`enveloped`・`nir1-typed`）。`human-derived` は envelope の `revisionBasis.kind` で、一括承認から外れ、apply は root の系譜を確かめる（`bulk_approval.rs`、`v2_apply_sources.rs`）。作者が確認画面で選ぶ経路（`resolveCodexStructureBinding`）は親の envelope を引き継いで版を足す。【未決・PR 3 の 2 本目の前に決める】規則で足す版を `human-derived` にすると、作者が見ていない結び付けに人の編集の扱いが付く。別の basis の種類にするなら envelope の語彙（契約）が変わるかを先に確かめ、変わるなら伺う。
- **取込み**：scan import（`scanImportOperations.ts` の `importCodex`・`importRelations`）も novel／Novelcrafter（`importCodexEntries`）も、取り込む項目を既存の項目と名前・別名で照合しない。照合を足すかは伺う（§6）。
- **変更の伝播**：提案は source basis に `project:codex-catalog:<projectId>` を持ち、名簿（名前・別名）が変わると freshness が古くなる（`source_revision.rs`、`incremental_freshness.rs`）。【起案者案】規則の revision の event も同じ `project:codex-catalog` の identity に対応づけ、規則を変えたら同じ作品の提案を古くする（別名を変えたときと同じ粒度）。古くなった提案は当て直し（§4）か再抽出で新しくなる。DR-M3-39 の「Source なし」はこの PR で改める。
- **正規化の移植**：JS の `String.prototype.trim` と Rust の `str::trim` は落とす空白が違う（U+FEFF、U+0085 など）。小文字化は ASCII の A〜Z だけ（全角の英字は変えない）。NFC は Unicode の版の差がありうる。共通の試験値にこれらを入れる。
- **PR の分け方**：(1) 規則の読み書きの IPC と、PR 1 から持ち越した守りの試験 3 件（挙動は変わらない。renderer の wrapper が増えるので perf:budget を先に測る）、(2) 当てる読み取り・抽出への適用・適用の記録・freshness の対応づけ、(3) 当て直し。

## 9. 2026-11-27 午後の回答（原文は handoff の `m3-user-answers-20261127k.md`）

- **取込み**：回答「名前と別名でも照合」（推奨の「規則だけ当てる」ではない）。取込みで、規則に加えて既存の項目の名前・別名と一致するものも、重複の候補として確認に出す。今の取込みは確認を挟まずに項目を作るので、確認の段を足す新しい挙動になる。**ERM PR 3 とは別の PR**（取込みの照合）にし、確認の画面の形と文言は実装の前に伺う。規則の当て方は §2 と同じ native の読み取りを使う。§0 の【未決】はこれで閉じる。
- **点検の規則**：元の資料に根拠はあるが本文に出ない項目には注意を出さない（`zero-mentions` を単独で出さない）。語の一覧は項目の種類に合う語だけを当てる。どちらも PR 5（健全性の検査）で使う。

