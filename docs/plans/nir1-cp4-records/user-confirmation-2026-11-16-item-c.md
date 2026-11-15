# ユーザーの回答の記録：次の S4 の項目 C（not-evaluable の測り方）（2026-11-16 JST）

## 回答の前提

- 材料は 2 つです。いずれも contracts の外にあります。
  - 設計：`/home/grimodex/fusion-eval-data/db-stage1-pr3-2026-11-15/item-c-design.md`（sha256 `5784926d…`）
  - Opus のレビュー：`item-c-review-opus.md`
- 経路：Claude Code の AskUserQuestion。
- 日時：2026-11-15T15:25Z ごろ（直後に読んだ時計の値）。

## 質問と回答

### U1a：FAIL を受け入れるか

- 質問：測ると、hold から FAIL に変わる可能性がある。合格基準・fixture・Gold を変えずに受け入れるか。
- 回答：**「はい (Recommended)」**
- 回答に付けた条件：v3 の定義は、測る前に fixture と README だけから決めて固定する。

### U2：既存 24 件の Graph arm と (c) の測り方

- 選択肢は次の 4 つです。
  - D：evidence の 4 件だけを測る（推奨）
  - A：評価 build で測る（DR-CP4-S1B-6・§15.2・T-2 の改訂が要る）
  - B：製品 build で測る
  - C：6 件とも測らずに開示する
- 回答：**「D：evidence 4 件だけ測る (Recommended)」**

## 読み

**今回の S4 で測るもの**

- evidence-validity の 4 件：utf16-range、explicit-pin-association、raw-excerpt-unchanged、added-scene-body-anchor
- Gold の run のついでに測ります。

**今回は測らず、開示に回すもの**

- macro 非回帰の、既存 24 件の Graph arm
- 禁止寄与の (c)

PUB-G #11 は、このうち 2 件分が残ります。

**変えないもの**

- 契約
- DR-CP4-S1B-6、§15.2、T-2（脅威モデル）

**これからユーザーに出すもの**

- 4 件の定義の中身、utf16-range の対応づけ、G-01 の扱い。
- 出す時期は、v3 の草案の段で、測る前です。
