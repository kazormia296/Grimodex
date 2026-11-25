# M2 の D2〜D4：同一性と変更レビューを広げる設計（起案、2026-11-25）

状態：**起案。実装の根拠にしない。** 事実は 2026-11-25 の origin/master（`dd014db91`）を静的に読んだもので、実行していない。大半は read-only の別の agent の調査で、起案者が確かめたのは一部。
前提：[M2-D1 の同一性の設計](m2-d1-identity-design-draft.md)、[assertionId の契約案](m4-assertion-identity-contract-draft.md)、
ロードマップ M2（[narrative-semantic-core-roadmap.md](narrative-semantic-core-roadmap.md)）。
各 wave が満たす 7 項目（typed payload、互換 adapter、Producer の依存宣言、Review と Projection の対応、Structure Health、Retrieval 参加、移行の証跡）と順序（D2→D3→D4）はロードマップのとおり。

## 1. D1 で作ったもの（広げる時の起点）

- 同一性の宣言は別 file（`policies/narrative/narrative-object-identity-declarations.json`）で、entry は `nir1-reviewed-entity-relation-v1` の 1 件。
- 比較する側は宣言を読まず、`codex:`／`codex-relation:` の接頭辞をコードに持つ（`narrative_change_review.rs`、`nir1_change_review_read.rs`）。**Producer が 2 つになる D2 で、宣言を読む形に直す。**

## 2. D2：Chronicle／Timeline／Temporal Constraint

ある：`nir1-reviewed-chronicle-v1` の依存宣言と index、`events` 表、temporal の node／constraint／projection の書き込み、抽出の途中の記録の契約。
無い：同一性の宣言。Timeline を独立の Aggregate とする表（見つからない。実体は未確認）。

**同一性の key が最初の問題。** 新しい出来事の提案は run ごとに `createId()` の `eventId` を持つ（`chronicle/extraction/proposalPlanner.ts`）。
したがって `events.id` を key にすると、続くのは「適用済み」か「既存の出来事に一致した」ものだけで、未適用の提案どうしは同じ出来事でも別物になる（起案者の読み）。

- 案 1（推奨）：key は `chronicle:{events.id}`。比較は Domain に在る出来事だけを対象にし、未適用の提案は `Unresolved` とする。D1（Codex の id）と同じ形で、同一性を推測しない。
- 案 2：temporal の semantic key を使う。内容が変われば key が変わるので、「同じ出来事の改訂」を表せない。

進め方：(1) 比較する側が宣言を読む形にする（挙動は変えない）、(2) Chronicle の宣言を足す、(3) 承認済み revision の履歴 reader と変更レビューの読み取りを Chronicle に広げる。
(3) の前に、Chronicle の roster が出来事ごとの source object を持つかを確かめる（未確認。見えたのは project 単位の source key）。

秘匿：出来事の secret はやめる決定（CSR/1）で、撤去は段を分けて進行中（Native は書かない：#1118。残りの段がある）。守る印は Codex の hidden で、Chronicle の引用を出口で返す時の扱いは改めて確かめる。
AI：Chronicle の抽出は製品の既定で AI を使う（`chronicleExtractionApi.ts`）。この起案は**送信を足さない・変えない**。自動の再実行は別の確認が要る。

## 3. D3：Phase／State／State Transition

ある：Phase の書き込みと表、Codex の detail と semantic binding、IR の型（`stateTransition`、`stateTrack` ほか）、検出の code。
無い：Producer の依存宣言、同一性の宣言、State／State Transition 専用の永続表（見つからない）。`transitionId`／`trackId` が安定かは未確認。

State Transition を永続化するなら新しい表になり、**保存範囲の拡大**に当たる（伺う）。最初の版は Phase（Codex の Phase の id がそのまま key になる見込み）に絞る案を、id の安定を確かめてから出す。

## 4. D4：Plot Thread／Foreshadow

ある：`plot_threads`／`foreshadows` ほかの表と書き込み、IR の型、新しい pipeline の planner（旗で切替）。
無い：依存宣言、同一性の宣言、index の Producer。新しい plot の pipeline は場面から IR への変換が未完。
旧経路は本文を AI に送っている（`plot-threads/extractThreadsApi.ts`）。新しい pipeline への移し替えは送る中身が変わり得るので、**新しい送信として伺う**対象。D1・D2 の同一性の後に起案し直す。

## 5. 先に確かめること（read-only）

1. Chronicle の承認済み revision の形と、履歴 reader を作れるか（束縛・digest・Decision の検査を D1 と同じ強さにできるか）。
2. Chronicle の roster の object 単位。
3. `transitionId`／`trackId`／`threadId` の生成規則。
4. 各 wave の互換 adapter が要る released の保存物。

## 6. やらないこと

AI への送信の追加・変更、新しい保存、旗を開けること、Story Bible の自動書き換え。新しい契約や保存の拡大に当たる段は、実装の前に伺う。
