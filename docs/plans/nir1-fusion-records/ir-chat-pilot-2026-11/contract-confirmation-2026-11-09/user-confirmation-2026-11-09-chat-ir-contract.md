# ユーザーの回答の記録：chat IR の契約と脅威モデル（2026-11-09 JST）

- 状態：contracts に置く前の候補（2026-11-17 に起案）。commit は統合者が行う。
- 位置づけ：chat IR（`chat-agent-ir-read`）の S1 の最初の mutation の前に、GDX-PRECHECK-001 の「確認済みの脅威モデルの版の ref」と回答の逐語を git の管理下に置くための記録。CP-4 の証拠ではない。
- chat IR は NIR-1 の残レーンの外。AGENTS の事前委任は適用されない。この記録は、ユーザーが個別に確認した版と回答を引くためのもの。

## 1 回答（選択肢のラベルの逐語）

経路は Claude Code の AskUserQuestion。逐語は、同じフォルダの `user-decisions-2026-11-09.md` の表と、統合者の session（main session）の記録で照合した。
- (a)、(c) の最初の回答、★1〜★4、△6〜△8：tool_result（`"…"="<ラベル>"` の形）。
- (c) の訂正後のラベル：tool_result には無い（ユーザーの発言で推奨に変えた）。AskUserQuestion の選択肢（options の label）で照合した。
- (c) の訂正の発言：user の message。
- 時刻は記録の timestamp（UTC）と JST。

| 項目 | 回答（逐語） | 時刻（UTC／JST） |
|---|---|---|
| (a) 年表の `search_events` の「今の Scene より後を除く」filter | 「Scene に結ばれた event にだけ掛ける (推奨)」 | 2026-11-08T15:54:46Z／11-09 00:54 |
| (c) tool の結果の、local の会話の履歴への保存（最初の回答） | 「quote と要約を残す」 | 2026-11-08T15:54:46Z／11-09 00:54 |
| (c) の訂正（ユーザーの発言の逐語） | 「tool 結果の保存はやっぱり推奨で」 | 2026-11-08T15:58:44Z／11-09 00:58 |
| (c) 訂正後の扱い | 推奨の選択肢「本文は残さない。tool 名・query・件数と使った ID だけ (推奨)」（最初の回答は撤回） | 同上 |
| ★3 audit に IR の本文が残る件 | 「audit で IR の本文を置き換える (推奨)」 | 2026-11-08T22:52:35Z／11-09 07:52 |
| ★4 外部へ送るデータの範囲 | 「承認の文言どおり要約と quote に限る (推奨)」 | 同上 |
| ★1 契約 | 「§3 のとおり承認する (推奨)」 | 同上 |
| ★2 脅威モデル | 「draft のとおり確認する。前提は S1 の前に実物で確かめる (推奨)」 | 同上 |
| △6 L8 との食い違い | 「受け入れて記録する (推奨)」 | 2026-11-08T23:00:12Z／11-09 08:00 |
| △7 年表の filter の細部 | 「一番前の Scene で見る。今の Scene が無ければ年表は filter しない (推奨)」 | 同上 |
| △8 「今の Scene」の定義 | 「Scene の scope ならその Scene、それ以外は turn 開始時の activeSceneId (推奨)」 | 同上 |

質問せずに技術判断で進めた項目（`user-decisions-2026-11-09.md` の記録のとおり）：△5（新しい command は restricted で拒否の区分 `plaintext-publication`）、△9（agent の capability に結ばない）、△10（research sub-agent には IR を返さない）、△11（turn ごとの IR の字数の累積上限を置く。値は閾値として後で決める）。

各回答の帰結（読み）は `user-decisions-2026-11-09.md` の「帰結」の列のとおり。この記録は帰結を足さない。

## 2 確認された脅威モデルの版

| 項目 | 値 |
|---|---|
| file | `consumer-contract-threat-model-draft.md`（この記録と同じフォルダの写し。元は repo の外の `fusion-eval-data/design-notes/chat-ir-2026-11-08/`） |
| SHA-256 | `08f26f789501e6149852900e2fd537844843fbd9e1aad062ae33d52698a43db3` |
| 大きさ | 72,170 byte |
| 元の file の最終更新（mtime） | 2026-11-09 07:44:48 JST（2026-11-08T22:44:48Z） |
| draft の完成の通知 | 2026-11-08T22:45:24Z（07:45 JST。session の記録） |
| ★2 の回答 | 2026-11-08T22:52:35Z（07:52 JST） |

判断：主な根拠は mtime。元の file の mtime は ★2 の回答より前で、その後は変わっていない（2026-11-17 の時点で mtime は同じ）。補いとして、main session の記録で、回答の後にこの file を Edit／Write した操作は見つからなかった（subagent の記録は調べていない）。**したがって、上の SHA-256 の版が、ユーザーが ★1〜★4 に回答した時点の版と同じ**と判断する。
- 限界：ユーザーが file の全文を読んだか、質問の要約を読んで答えたかは記録から分からない。回答のラベルは「draft のとおり」。
- 限界：mtime は保存の道具で変えうる。ここでは改ざんを想定しない。

## 3 同じ系列の、既に contracts にある記録

| 記録 | contracts の path（`d7ece05a` の時点） | blob | SHA-256 |
|---|---|---|---|
| 2026-11-08 の承認 1・2（送信先と local 保存） | `docs/plans/nir1-fusion-records/ir-chat-pilot-2026-11/user-decision-2026-11-08.md` | `70edb9363ed4aecbcc5098c8c99f1cc5cac58187` | `6d5b139119f7dfe5fa30980c96146fddd7cb5e675689c05d7b9733af09e27fb2` |
| 2026-11-16 の S2 の作品・費用・候補・effort | `docs/plans/nir1-cp4-records/user-confirmation-2026-11-16-chat-ir-s2.md` | `0a4d055c51123f9570b91311b5a8edeeb0682b93` | `1aef39c67c4147408d18db66436237f324f01da02b15eebf44a70b3314190bdd` |

## 4 このフォルダの file

| file | 中身 | 由来 |
|---|---|---|
| `user-confirmation-2026-11-09-chat-ir-contract.md` | この記録 | 新規 |
| `consumer-contract-threat-model-draft.md` | 確認された脅威モデル | byte 単位の写し |
| `user-decisions-2026-11-09.md` | 回答の表と帰結。2026-11-16 の追記を含む | byte 単位の写し |
| `questions-2026-11-09-db-conn-and-chat-ir.md` | (a)・(c) の質問票（選択肢・推奨・理由の全体）。DB 接続の問いを含む。**任意**（依頼の範囲は回答の逐語と脅威モデル。置くかは統合者が決める）。AskUserQuestion のラベルは、ここの選択肢を短くしたもので、ラベルの文字列そのものはこの file には無い（(c) の (A)＝「本文は残さない…」、(B)＝「quote と要約を残す」） | byte 単位の写し |
| `SHA256SUMS` | 上の 4 file の SHA-256 | 新規 |

確かめ方：`sha256sum -c SHA256SUMS`。

## 5 候補の台帳（candidate ledger）から引くときの形

S1 の各 PR の candidate ledger の `threatModelRef` には、次の形で載せる（commit は統合者が contracts に置いた後に埋める）。

```
threatModelRef:
  contractsCommit: <統合者が埋める>
  path: docs/plans/nir1-fusion-records/ir-chat-pilot-2026-11/contract-confirmation-2026-11-09/consumer-contract-threat-model-draft.md
  sha256: 08f26f789501e6149852900e2fd537844843fbd9e1aad062ae33d52698a43db3
  confirmation: docs/plans/nir1-fusion-records/ir-chat-pilot-2026-11/contract-confirmation-2026-11-09/user-confirmation-2026-11-09-chat-ir-contract.md
```

## 6 範囲

この記録に含まれないもの：製品の公開（S3 の開放）、PUB-G、新しい送信先、保存範囲の拡大、閾値の確定、S1 の設計の承認。S1 の設計で脅威モデルに material な変更が出たら、改めて確認する（GDX-PRECHECK-001）。
