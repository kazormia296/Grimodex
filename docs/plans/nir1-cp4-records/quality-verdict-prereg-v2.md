# CP-4 品質の判定：事前に固定する定義 v2（確定版。2026-11-08）

> 状態：**確定版**（判定の結果ではない）。元の草稿は `quality-verdict-prereg-v2-draft.md`（SHA-256 `41520857e22d8ac1c591a3fc259142480d8e9717f53df6acae75f8d5b1212838`。草稿は書き換えずに残す）。確定は integrator が行い、ユーザーの確認の対象ではない（草稿 §5 の 2）。v1 は `quality-verdict-prereg-2026-11-06.md`（以下「v1」。本文は書き換えない）。v2 は、K6/6（`nir1-final-request-eval-proposal/6#graph-eval-procedure`。凍結の commit `56fb4fad`）の凍結の後に始めた正式 run の品質の判定にだけ当てる。s6r1 の判定（`quality-verdict-s6r1-1/`、全体 hold、条件 5 の (a) は fail）は v1 のまま残し、v2 で読み直さない。
> 根拠：ユーザーの決定（2026-11-07、`user-confirmation-2026-11-07-s6r1-hold-k66.md` の問 2「契約の『子』の定義にそろえる（推奨）」）。位置づけは v1 と同じ手順外の補助の記録（DR-CP4-QV-0・QV-1）で、S6 の可用性の規則を置き換えない。製品・harness・S2・S4 の bytes、閾値、fixture、Gold は変えない。**確定は観測の後なので、草稿から新しい緩和を入れず、草稿の範囲を明確にする・狭める差分だけを入れた**（下の表）。

## 改訂の履歴

| 版 | 日付 | 中身 |
| -- | ---- | ---- |
| 初版〜改訂 3（草稿） | 2026-11-07 | 草稿の履歴のとおり（初版 contracts `02af2760`、改訂 1 は Opus、改訂 2 は Sonnet の 4 観点のレビュー、改訂 3 は K6/6 の Fable の最終 pass の任意の指摘 b）。確定の元は SHA-256 `41520857…` の bytes |
| 確定版 | 2026-11-08 | 独立のコードレビュー（PR #840 の `quality-verdict.mjs`・`quality-verdict-cli.mjs` と DR-CP4-QV-2 が対象）が「確定版に書くべき」とした 8 点のうち 7 点を入れた（C3 は統合者の判断で入れなかった）。草稿からの差分は次の表 |
| 確定版 改訂 1 | 2026-11-08 | Opus の再レビューを反映：C1 の key 名を凍結の fixture の `revisions` に直し、setup の記録（`logicalToRuntime.typedRevisions`、`setupReceipt.refusedAtSetup`）との対応を書いた。C5 の hybrid の除外を「草稿 D4 の字義からの除外」として開示し、既知の variant に無い `variantKey` を hold にした。§0 に 6 種の受領書の head の key（G-01 の診断の runner は S4 の 7 回目で `head` を書くよう直す。統合者の判断）と、CLI の枝・実装の bytes・v2 の path・組の検査を足した |
| 確定版 改訂 2 | 2026-11-08 | Opus の最終確認（P1 0、P2 0、P3 2）を反映：C7′ の G-01 の診断の head の記述を「実装の枝で直し、S4 の 7 回目で取り込む」に直した。§3 に、s6r1 の setupReceipt が `refusedAtSetup` を持たず、C1 (iii) の飛ばす経路が実物では通らない（fail closed）ことを足した。判定を変える差分は無い |

| # | 草稿からの差分 | 別 |
| - | -------------- | -- |
| C1 | D3 の (d) の「その材料の最新の typed Revision」を §1a の (i)〜(iv) で定めた。順序の出所は凍結の fixture の `revisions` の配列の順。setup で `prepare` を拒まれた行だけ飛ばし、`refusedAtSetup: "decision"` の行も数えて decision を問わず置き換える。対応の取れない行は hold（DR-CP4-QV-2 の、setup の記録の key の順に頼り `refusedAtSetup` の全行を除く読みより狭い） | 明確化 |
| C2 | (d) の Revision は製品が返すものではなく、harness が両端・型・向き・quote の一致から推定したものと書いた（§1a、§3） | 明確化 |
| C3 | C3 は統合者の判断で入れなかった（字義のまま）。草稿 §3 の「記録の無い子は `hold`」を、`outcome`・`edgeCount` によらずそのまま当てる（観測の後に hold を pass に変える方向は入れない） | 入れない |
| C4 | Graph を出したかもしれない子で、`observed` が空の記録、または Scene が論理 ID に無い（`sceneId` が null の）path は hold | 狭める |
| C5 | D4 の最上位の `requeries` のうち R+IR arm（`arm: "hybrid"`）の行を対象から外す。**草稿 D4 の字義からの除外**として開示する（理由：R+IR の arm の行は Graph の寄与を含まない。今の runner は `requeries` を `[]` に固定している）。`variantKey` が無い、または既知の variant に無い行は hold | 前半は字義からの除外（開示）、後半は狭める |
| C6 | 定常状態の `followUp.requeries` の行は、N29・N32 に加え、条件 5 の (a) の検査（Scene の一覧を持つ行）と K6/6 の FR-6（行があれば first-render にしない）で見る | 狭める |
| C7 | §0 の「最初の正式 run」に入れる受領書の 6 種、CLI の入力・検査・出力の形を書いた | 明確化 |
| C7′ | §0 の検査：6 種の受領書がすべて `head.observationPrep.commit`・`head.runStartedAtUtc`・`candidate.commit` を持つこと（G-01 の診断の runner `pubg16-e2e-run.mjs` は、実装の枝 `claude/k66-harness` で `head` を書くよう直し、S4 の 7 回目で取り込む。実リポジトリの git で head を書けることは、S4 の 7 回目の凍結の前の dev の予行で確かめる）、remote 側の時刻の記録の枝、`--impl-commit` と動いている 2 file の bytes、`--v2-file` の固定の path、置き場の受領書の組。どれかが欠ける・違えば `[precheck]` | 狭める |
| C8 | D8 で表示が 0 件の variant の条件 2 の集計は、D8 の fail を hold の判断と平均の計算より先に置く（§1a） | 明確化 |
| C9 | §5 を確定の後の手順に書き直し、§3 に C2・C4 の開示を足した。冒頭の状態を確定版にした | 明確化（手順） |

草稿の判定を通りやすくする差分は無い。草稿の字義から外したものは C5 の hybrid の行の除外だけで、理由とともに開示する（今の runner では効かない）。レビューの 8 点のうち、Graph を出していない子の記録の無い場合を pass とする案（C3）は hold を pass に変える方向なので、統合者の判断で入れず、草稿の字義（hold）のままとした。

## 0. 観測の規律と、v2 の前に見たもの

- **v2 は観測の後の改訂である**。起案者は次を見た後に v2 を書いた：s5r6 の判定（`quality-verdict-s5r6-1/`）、s6r1 の判定（`quality-verdict-s6r1-1/`、訂正 `ce302ea1`）、s6r1 の Gold の受領書の G-08 の 5 variant の sample（子の `origin`・`refreshTrigger`・`outcome`・`edgeCount`・`chronicleIndexUsable`、親の IR の outcome と snapshot。下の 4）、fixture の G-08/chronicle-index-unusable の `forbiddenSceneIds`（`g08-cass-attic`）と `blockedCandidates`（空）。確定版の起案者はさらに PR #840 の実装と DR-CP4-QV-2 を読んだ（受領書の本文は読んでいない）。
- **v2 が変えるのは、G-08/chronicle-index-unusable の `index-ready` の再 query の扱いと、K6/6 と K6/4 の字義に連動する箇所だけ**（下の 1）。D2・D3 は s6r1 の条件 5 の (a) の fail を消す方向に働く（緩和。ユーザーの問 2 の選択）。D5・D8 と確定版の C1・C4・C6〜C8 は狭める側か明確化、C5 の前半は草稿 D4 の字義からの除外（開示）。v2 は s6r1 に当てない。
- **先に固定したことを git で示す**：v2 の確定版（`claude/nir1-contracts`）と、それを実装した `quality-verdict.mjs`・`quality-verdict-cli.mjs` と試験の commit（実装の枝）は、独立のコードレビューの後、S4 の 7 回目の凍結の前に push する（§5）。**「最初の正式 run」**は、v2 で判定する `(s4Commit, candidate.commit)` の組の受領書の 6 種（SP-P4、trace、parity、Gold、negative、G-01 の診断）の全件のうち、最も早い `head.runStartedAtUtc` とする。
- **CLI の入力**：`--v2-file`（path は `docs/plans/nir1-cp4-records/quality-verdict-prereg-v2.md` に固定）と v2 の commit、`--impl-commit`、remote 側の時刻の記録（JSON。commit ごとに `commit`、枝、`remoteTimeUtc`、出所〔`repository-activity` か `PushEvent`〕）、6 種の受領書の置き場。**検査**（どれかを満たさなければ `[precheck]` で止まる）：(1) 6 種の受領書がすべて `head.observationPrep.commit`・`head.runStartedAtUtc`・`candidate.commit` を持ち、組（`head.observationPrep.commit` が `s4Commit`、`candidate.commit`）が allow list と一致する。置き場に組の違う受領書が 1 件でもあるか、ある種がその組で 0 件か読めなければ止まる。G-01 の診断（`pubg16-e2e-run.mjs` の出力）は今 `head` を持たないので、runner が `head.observationPrep.commit` と `head.runStartedAtUtc` を書くよう S4 の 7 回目で直す（統合者の判断）。(2) 記録の枝が、v2 の commit は `claude/nir1-contracts`、実装の commit は harness の枝（`claude/k66-harness`）。(3) remote 側の時刻が 2 つの commit の両方について、最初の正式 run より前。(4) `--v2-file` の bytes が `git show <v2 の commit>:<固定の path>` の bytes と同じ。(5) 動いている `quality-verdict.mjs`・`quality-verdict-cli.mjs` の bytes が `git show <--impl-commit>:<その path>` の bytes と同じ。**出力**：両方の commit、v2 の file の sha256、両方の remote 側の時刻と枝と出所、最初の正式 run の時刻とその受領書。
- 以降の定義は、v2 の確定の後に変えない。変えるなら v3 を作り、変える前の結果を残す。

## 1. v1 からの差分

D1・D5・D6・D7 は草稿の表の文のまま（D7 の出力は §0 の出力を含む）。D2・D3・D4・D8 は草稿の文に §1a の読みを足したものを確定とする。

| # | v1 の箇所 | v2 の文（草稿の文に足すもの） |
| - | --------- | ----------------------------- |
| D2 | §3 の 3 つ目（v1:33）。期待 `unavailable` の variant | 草稿のとおり（D3 の (1)〜(6) をすべて満たす `index-ready` の子だけを「子」から外し、それ以外の子は v1 のまま判定に残す。fail closed）。`followUp.requeries` の行の扱いは §1a の C6 |
| D3 | （新設。§7 の後に §7a） | 草稿の (1)〜(6)・(a)〜(d)・component `a2-index-ready-requery-forbidden`・開示のとおり。(d) の読みは §1a の C1・C2、`materialRevision` の記録の無い子は草稿 §3 の字義のまま `outcome`・`edgeCount` によらず `hold`、記録が在れば `outcome`・`edgeCount` によらず (b)(d) を検査する。空の記録などは C4 |
| D4 | §7 の (a)・(b)（v1:59-60） | 草稿のとおり（親、origin を問わないすべての子、受領書の最上位の `requeries` のうち `trigger` が `user-operation` でなく Scene の一覧を持つ行）。対象外と hold は §1a の C5 |
| D8 | §3 の 2 つ目（v1:32）と `quality-verdict.mjs:368-371` | 草稿のとおり（親の合流が Graph を受けて表示に寄与したのに表示に数えない、または Scene の一覧が R+IR と違う、表示されない sample があれば、条件 1・2・4 は `fail`）。集計の順は §1a の C8 |

v1 の §1・§2・§5・§9 と、§3 の 4 つ目（R+IR arm）、§7 の (c) は変えない。

## 1a. 確定で明確にした読み

- **C1（D3 (d) の「最新」）**：(i) 「その材料」は、観測した `revision|edge` の `edge`（Relation）。(ii) 「最新」は、凍結の fixture（g02〜g08）の `revisions` の配列の順で、その Relation を `relationIds` に持つ最後の行（論理 ID の `id`）。setup の記録 `settings.setupReceipt.logicalToRuntime.typedRevisions`（論理 ID → runtime の object）の key の順には頼らない。(iii) fixture の行が `typedRevisions` に無いときは、`settings.setupReceipt.refusedAtSetup` にその `revisionId` で stage が `prepare` の記録があれば（製品に Revision が作られていない）その行を飛ばし、無ければ (d) は `hold`。`typedRevisions` の行に `refusedAtSetup: "decision"` があっても（Revision は作られている）数える。(iv) 後の行は decision（approved・`none` ほか）を問わず前の行を置き換える。観測した Revision が (ii) と違えば `fail`。
- **C2（Revision の出所）**：`materialRevision` の Revision は製品が返すものではない（製品の wire の edge は Revision ID を持たない）。harness が凍結の setup の plan から各 typed Revision の材料を導き、観測した edge を両端の Entity・relation の型と向き・両端の quote の sha256 の一致で 1 つの typed Revision に推定したもの（`material-revision.mjs`）。推定が 0 件か 2 件以上なら `unresolvedEdges` に数え、(d) は `fail`。
- **C4（Graph を出したかもしれない子）**：`outcome` が `graph-ready` で `edgeCount` が 0 と確定していない子は、記録が在っても、記録の `observed` が空、または `observed` に Scene が論理 ID（`logicalToRuntime.scenes`）に無い path（`sceneId` が null）がある、のどちらかなら `hold`（記録の無い子は D3 の行のとおり、子を問わず `hold`）。
- **C5（D4 の対象）**：最上位の `requeries` の R+IR arm（`arm: "hybrid"`）の行は対象から外す。これは草稿 D4 の字義（`trigger` が `user-operation` でなく Scene の一覧を持つ行すべて）からの除外で、理由は、R+IR の arm の行は Graph の寄与を含まず（v1 §7 の baseline）、今の runner は `requeries` を `[]` に固定していること。`variantKey` が無い、または既知の variant（Gold の受領書と fixture の variant）に無い行は、どの variant の行か決められないので、すべての Graph arm の variant の条件 5 を `hold` にする。
- **C6（定常状態の `followUp.requeries`）**：定常状態の受領書には通常この key が無い（key が無ければ空と読む。K6/6 の FR-6）。行があれば、(i) その sample は K6/6 の FR-6 により first-render として測らない、(ii) Scene の一覧を持つ行は、条件 5 の (a)（対の R+IR に足した寄与が禁止 Scene・blocked 候補に入らない）を親・子と同じに当てる、(iii) 一覧を持たない行は N29・N32 で見る。
- **C8（D8 と条件 2 の集計）**：variant の D8 の `fail` を先に決め、その variant（表示が 0 件で表示の一覧と指標が無いものを含む）は条件 2 の hold の判断と平均の計算に入れない。D8 の `fail` が 1 つでもあれば条件 2 は `fail`。

## 2. 守ること（v2 の In-scope な誤り）

- 草稿 §2 の 5 項のとおり（`index-ready` の帰属だけで判定から外さない、G-08/chronicle-index-unusable 以外の `index-ready` を D3 に入れない、`graph-ready` の子が期待 `unavailable` で Graph を出せば `fail`、D3 は一覧と path と Revision の解決まで見る、D8 を見逃さない・hold に留めない、s6r1 に当てない）。
- 加える：(d) の「最新」を setup の記録の key の順や approved だけで決めない（C1）。記録の無い子を、`outcome`・`edgeCount` を理由に pass にしない（草稿 §3 の字義）。Graph を出したかもしれない子の空の記録・論理 ID に無い Scene を pass にしない（C4）。`variantKey` の無い再 query の行を黙って飛ばさない（C5）。

## 3. 確かめられないこと（v1 の §9 に足す）

- `index-ready` の子が出る理由（測定中に Chronicle の Index が戻ること）は未確認。D3 は戻った後の取り直しの禁止寄与だけを見る（開示だけ）。
- D3 の (b)(d) は `materialRevision` の記録と、harness の quote の一致による Revision の推定（C2）に頼る。推定は製品の Revision の束縛の観測ではない。
- (d) の順序は凍結の fixture の `revisions` の配列の順に頼る。fixture の順と製品の作成の順が違えば (d) は誤りうる（setup driver は配列の順に準備する）。
- s6r1 の Gold の受領書の `settings.setupReceipt` は `path`・`sha256`・`logicalToRuntime` だけを持ち、`refusedAtSetup` を持たない。この形のままでは、C1 の (iii)（setup で `prepare` を拒まれた行を飛ばす）は実物では通らず、拒まれた行があれば必ず `hold` になる（安全側。fail closed）。

## 4. s6r1 に当てた場合の参考値（予告。判定に使わない）

草稿 §4 のとおり（G-08/chronicle-index-unusable の 30 sample は (a)〜(c) で違反 0、(d) は未確認。G-08/both-indexes-unusable は違反 0。D8 は 7 variant で `fail` 相当。s6r1 の全体は v1 でも hold）。C1〜C8 で参考値は変えていない（起案者は受領書の本文を読み直していない）。

## 5. 確定の後の手順

1. 実装（`claude/k66-harness`）を確定版に合わせる：C1 の順序の出所と `refusedAtSetup: "decision"` の行、記録の無い子を `outcome`・`edgeCount` によらず `hold` にすること（PR #840 は `graph-ready` でない子と `edgeCount` 0 の子を `hold` にしていない）、C4、C5 の `variantKey` の無い行・既知の variant に無い行、C6、C8、§0 の CLI の入力・検査 (1)〜(5)・出力（DR-CP4-K66-1 の残る穴 (d)）と、それぞれの試験。G-01 の診断の runner の `head` は S4 の 7 回目で取り込む。
2. 確定版と実装の独立のコードレビュー（read-only。起案者の結論は渡さない）を受け、指摘を直す。
3. integrator が確定版（`claude/nir1-contracts`）と実装の commit を push し、両方の remote 側の時刻（repository activity か PushEvent）を記録する。
4. 3 の時刻の後に、S4 の 7 回目を凍結し、取り直しの正式 run を始める（§0 の検査が通る順）。
5. 正式 run の後に v2 で判定し、v1 の判定（s6r1）と並べて記録する。
