# D1 に本文起点の AI 抽出を新設する：区切りの起案（未確認、2026-11-25）

状態：**起案（scoping）**。ユーザーの回答（原文）：「D1 に AI 抽出を新設」（[自動再解釈の起案](m4-auto-reinterpret-design-draft.md) §3 の丙）。
**これは方向の決定で、送信先・送る中身・契約は未確認。送信の経路は開けず、実装もしない。** `GDX-PRECHECK-001` の外部送信に当たる。

## 1. 分かっていること（確認済み。出典は自動再解釈の起案 §1）

- typed の Entity／Relation（D1）の source は Codex・Relation・Scene Scope だけで、本文の辺が無い。Evidence の source は Codex の項目。
- typed の revision は作者が選んだ既存の Codex の項目から作る。Codex に無い Entity は拒否される（`NIR1_ENTITY_SOURCE_MISSING`）。
- AI の task（`runEntityResolutionTask`）は実装だけで呼び手が無く、返すのは `CodexEntityHypothesis`。typed bundle への変換は無い。
- 変更レビューは typed の revision だけを読む。
- 送信の守り：役割の割り当てが空なら既定の provider に落ちる。データ同意の broker は Electron で効かない。実行中の取消の仕組みは無い。

## 2. 新設に要るもの（区切り。依存順）

| #   | 区切り                    | 中身                                                                                                                                    | 新しい契約／送信                                                    |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| P1  | 本文の source と Evidence | typed の Evidence が場面の本文の範囲を指せるようにする（今の Evidence の source は Codex）。`scene-body` の依存の辺を D1 に足す         | **契約の変更**（bundle の Evidence の source の種類）               |
| P2  | AI の抽出（Producer）     | 本文の抜粋と Codex の一覧（hidden を除く）を送り、結果を受ける。まず**作者の手動**で起こす                                              | **新しい AI への送信**                                              |
| P3  | 変換                      | 結果を typed の bundle にする。**既存の Codex の項目に当たるものだけ**。当たらないものは typed に入れず、Codex の候補の経路へ回す       | 同一性の宣言の拡張（`narrative-object-identity-declarations.json`） |
| P4  | 変更レビューへの接続      | 本文起点の revision を変更レビューで読めることを確かめる（今の reader は typed の set だけ。P1 の Evidence の比較が本文の範囲に効くか） | 読み取りの拡張                                                      |
| P5  | 自動の起点                | P1 の本文の辺が `rebuild-required` になったら P2 を再実行する（上限・同意・記録・取消）。**P1〜P4 が手動で動いてから**                  | **自動の送信**                                                      |

最初の版は P1〜P4（手動）を提案する。P5 は後で改めて伺う。

## 3. 確かめる前提（未確認）

1. bundle の Evidence の source を増やすのに、envelope・Review・index の roster・digest のどこを直すか（`narrative_nir1.rs`、`nir1_entity_relation.rs`、`nir1_entity_relation_index.rs`）。
2. 本文の `scene-body` の辺を D1 の revision に足す経路と、その token が行全体の版である影響（本文以外の保存でも `rebuild-required` になる）。
3. 送る中身の作り方（場面の中の抜粋の範囲、cluster の作り方）。既存の observation の抽出（Chronicle）の窓の形を流用できるか。
4. hidden の除外（`listCodexIdsHiddenFromAiInAnyPhase` と同じにするか）、ADR 013 の経路の表の扱い。
5. 送信の守り（既定の provider への落ち込みを止めるか、取消、失敗を「出来事なし」にしない戻り）。

## 4. 脅威モデルの下書き（`GDX-PRECHECK-001`。**確認前の draft**）

| 項目           | 下書き                                                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 信頼する actor | ローカルの作者。作者が設定した provider                                                                                                                                                   |
| 信頼しない入力 | AI の応答（参照の捏造、注入された指示）、本文に混ざる指示文                                                                                                                               |
| 守る資産       | 未公開の本文、hidden の Codex の名前・別名・本文、承認済み revision の不変性、作者の Story Bible（黙って書き換えない）                                                                    |
| 対象の攻撃     | hidden の漏れ、想定外の provider への送信（既定への落ち込み）、応答の参照の捏造で別の項目に結びつくこと、restricted の profile での送信                                                   |
| 防御（案）     | 送る前の hidden の除外（fail-closed）、役割の割り当てが無ければ送らない（新設）、応答は不透明な参照だけを解く、typed への書き込みは未承認の Proposal にとどめる、restricted は D2a が拒む |
| 受入れ         | 送る中身を作者が見られる、送らずに組み立てた request で中身を確かめる試験、hidden を含まない試験、応答の捏造を拒む試験                                                                    |

lifecycle の表（開始・再入・取消・終了の確認）は、実行主体（renderer／main）を決めた段で起こす。

## 5. 次の手順

1. §3 を read-only で確かめる。
2. 確認できた行だけで、P1（契約の変更）と P2（新しい送信）を分けて伺う。

## 6. 回答と、A の前提の確認（2026-11-25、read-only。静的な読みで実行していない）

回答（原文）：順番「手動が先（推奨）」、hidden「hidden は送らない（推奨）」、同定「先に測る（推奨）」、見える結果「Aで」（構造抽出に載せる。typed の契約は変えない）。送信先・送る中身・保存の範囲は未確認で、配線の前に 1 問にまとめて伺う。

- **訂正**：「A なら AI で新しい人物・関係の候補が出る」は誤り。候補（表記ごと 1 件）と関係の seed は、今の heuristic が AI なしで出している（`codexStructureExtractionApi.ts:505-512, 1011-1060`）。
- **同定を除くと、AI が足せるのは `coarseClass`・type の候補・summary だけ**。AI の `canonicalName` は既存項目との照合（`matchExistingEntity`）の結果を変えうるので使わず、`explicitIdentityRefs` は同定そのもの。
- **関係の合成は使えない**：`runRelationSynthesisTask` は同定済みの Entity と観測の段が入力で、本文を送らない（`runRelationSynthesisTask.ts:32-56`）。観測を作る呼び手が無い。
- 依存を「読んだ場面」に絞る：heuristic は全場面を走査するので「言及が無かった」も読んだ結果で、絞る根拠は Chronicle より弱い。絞ると、外した場面の新しい言及で古くならない。**最初の版は全場面のままにする**（絞るなら別に伺う）。
- stale になると、適用は `NEX_SOURCE_BASIS_STALE` で失敗し、画面には生の文字列が出る（`CodexStructureExtractDialog.tsx:334-352`）。Work Layer の件数は `proposal-revision` の stale 系を数える（行ができるかは未実行）。
- 同定の測定の道具（`scripts/quality/identity-review-load/`）の B は、候補画面の `judgeCandidates` の review の負荷を測るもので、`runEntityResolutionTask` の精度は測らない。評価データの Codex は 0 件。A の最初の版の同定を測るには、新しい測り方が要る。
