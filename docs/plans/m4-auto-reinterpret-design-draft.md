# 自動再解釈の送信の設計（起案・保留、2026-11-25）

状態：**保留**。下の §1 の事実で、当初の起案の土台（本文の編集で D1 の解釈が古くなり、AI で作り直して変更レビューに出す）が成り立たないと分かった。
**送信の経路は開けていない。この文書は実装の根拠にしない。** 前の「送信の形」（追記 3）は前提の誤りで失効している。
2026-11-25 のユーザーの回答（原文）：「自動送信を先に設計し直す」。

## 1. 確かめた事実（read-only の調査。file:line は 2026-11-25 の branch 基点）

1. **本文の編集では、typed の Entity／Relation（D1）は古くならない。** source は `codex:`・`codex-relation:`・`scene-scope-projection` だけで、本文の辺が無い
   （`nir1_entity_relation.rs:653-686, 998-1045, 1296-1362`、`scene_scope_projection.rs:82-100`）。Evidence の quote も Codex の項目が source（同 `:688-715, 4267-4298`）。
2. **AI の結果は、変更レビュー（`read_nir1_change_review`）に届かない。** 読むのは `nir1.entity-relation.revision@1` の set だけで（同 `:2486-2503`）、入力は作者が選ぶ `sceneId`／`entityIds`／`relationIds`。
   AI の Chronicle の結果は `chronicle.extract.review@1` の別の set。`CodexEntityHypothesis` から typed bundle への変換は無い。IPC `nir1_change_review_read` に renderer の呼び手も無い。
3. **本文を AI に送り、結果を残すのは Chronicle の run だけ**（`ChronicleExtractDialog.tsx:493` → `chronicleExtractionApi.ts:686-705`、observation は window の本文、synthesis は observation を送る）。単位は `folderId`＋`sceneIds[]`。
   Codex の構造抽出は `useAi: false` の heuristic。`runEntityResolutionTask` ほかに製品の呼び手は無い。
4. **本文の編集で古くなり得る consumer**：scene-body を source に持つ proposal-revision（Chronicle V2、Codex 構造抽出）と、それに連なる semantic-index（状態遷移は未確認）。
   token は `tree_nodes` の行の版（`source_revision.rs:839-870`）なので、本文以外の保存でも動きうる。`revalidate-exact` に落ちる経路があるが、全再構築の経路は digest を持たない（`restore_rebuild.rs:606`）。
5. **送信の守り**：役割の割り当てが空でも「何もしない」にならず、既定の provider/model に落ちる（`modelRouting.ts:248-367`）。`blockNarrativeAiTask()` は AI policy と license だけ。
   データ同意の broker は web 版だけで、Electron の経路に効かない。D2a は `send_chat_message` を `old-external-ai` として restricted で拒否（`profileEgress.ts:284, 886-930`）。
6. **取消**：narrative の task に AbortSignal は無い。project 切替などは `flushStrictQuiescence` で終了を待つだけ（restricted への切替は Native に停止を依頼する）。
7. **失敗**：guard の block と一部の解析失敗は、例外でなく `[]` を返す。自動起動では「出来事なし」に見える恐れがある。

## 2. 帰結

- D1（Codex Entity／Relation）では、「本文の変更 → 自動再解釈」は成立しない。成立させるには、本文を source にする新しい Producer（AI の抽出の配線、typed bundle への変換、本文の依存）が要り、新しい送信になる。
- 本文の変更で古くなる AI 由来の解釈があるのは Chronicle（D2）だけ。ただし変更レビューは Chronicle の差分を読めないので、別の読み取りが要る。
- これまで作った変更レビュー（読み取り・IPC）は、**Codex の項目や Relation や Scope が変わった時**の差分で、本文の変更ではない。ロードマップ M4 の「本文を書き続けても追従」は、まだ満たしていない。

## 3. 次の方向（ユーザーに伺う）

- 甲（推奨）：自動送信は棚上げ。M4 の最初の版は、今ある Codex 起点の変更レビュー（読むだけ）に絞る。本文起点の追従は、Chronicle（D2）の差分を読む設計を先に作る。
- 乙：Chronicle の run を自動再実行する案を起案する（送るのは本文と observation。単位はフォルダ。送る守り・取消・失敗の扱いを新設）。
- 丙：D1 に本文起点の AI 抽出 Producer を新設する案を起案する（新しい送信・新しい Producer・契約。大きい）。

方向が決まったら、`GDX-PRECHECK-001` の外部送信の項目（信頼する actor、対象と対象外の攻撃、防御、受入れ、owner／lifecycle の表）を起案に入れ、確認をもらってから実装する。
