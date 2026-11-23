# 影響チェックの「要りそう」の知らせ（レベル 0）の判断の記録

- 状態：**実装済み・試作の確認待ち**（2026-11-23。枝 `claude/impact-check-nudge`、`origin/master` `fa6f1af26` から。未 push）。独立レビュー（P1 なし）の P2・P3 を反映済み（第 10 節）。
- 順序：この文書は**実装の後**に書いた（実装→試験→文書の順。編集前の matrix は 5.1 の読みで不要と判断した）。
- ID：`DR-INN-1`。PR 本文にも同じ ID を載せる。
- 親の検討書：`design-impact-nudge-20261123.md`（read-only の検討。Codex の変更を契機に「影響チェックが要りそう」と知らせる案。
  fusion-eval-data の handoff 配下にあり、リポジトリには入れていない）。
- 関連：影響確認の門（base の contextMode が `current-mention` を満たさない・Phase が 1 つでも制限的だと `no-candidates` で止まり baseline は進まない）は
  `DR-MP4-44`（PR #1048、この base には未 merge）。この変更はその門を**変えない**（同じ集合の項目には知らせない）。
- 区別：**決定**＝ユーザー決定（2026-11-23。推奨の既定で承認。試作を見て最終確認）。**技術判断**＝この lane の判断。
  **残る制限**＝画面で見える挙動のうち、直さずに出したもの（第 6 節）。

## 1. 画面で見える変化

Codex の項目の詳細で、**影響チェックのボタンを押す前に**、前回のチェック以降の変更の件数を知らせる。

| 場所 | 見え方 | ja | en |
| --- | --- | --- | --- |
| 整合性タブ | タブの右上に小さな点（主色）。タブのアイコンと文字の幅・位置は変わらない（absolute で重ね、ボタンの padding の内側）。狭幅でアイコンだけになっても同じ（8 タブ・詳細がアクティブ・整合性が非アクティブの状態で、点がタブの内側に収まり幅・畳み込みが変わらないことだけを実 Chromium で確認した。8 タブ・240px では整合性タブ自体が右端に隠れて点が見えない。§6 の 8）。スクリーンリーダーには sr-only の語を足す（「整合性 (影響チェックが未実施の変更があります)」と括弧で区切り、名前が連結しない） | 影響チェックが未実施の変更があります | Changes not yet checked for impact |
| ボタン上の 1 行 | 整合性タブの中、「この変更の影響をチェック」ボタンの上に 1 行。小さな点＋文言（`text-xs`、muted の文字色）。折り返しても親の幅の内側 | 前回のチェック以降に N 件の変更があります | 1 change since the last check ／ N changes since the last check |

- 押したときの挙動・toast（no-change／no-candidates／source-changed／started）・既存の locale 文言は**変えない**。
- 押して完走する（または候補 0 件で baseline が進む）と、点も 1 行も消える。変更を undo などで baseline に戻しても、再計算の契機のあとに消える（状態比較のため）。
- toast・音・ダイアログでの通知は無い。「あとで」「無視」「影響なしとして確認済み」も無い。設定のオン／オフ、本文の小さな変更の閾値も無い。

## 2. 出す条件（`runImpactReview` の実行時の判定と同じ）

| 状態 | 条件 | 表示 | 押したとき（run） |
| --- | --- | --- | --- |
| `pending`（件数 N） | baseline があり値が確認済み、現在 Phase が制限的でない、base の contextMode が `current-mention` を満たす、`effectiveRestrictedPhaseIds` の Phase を baseline・現在の両方から除いた `computeCodexDiff` が N>0 件、AI gate が `enabled`、影響チェックの実行中でない | 出す | `no-change` でなく、`changeCount === N`、候補絞りまで進む |
| `unchecked` | baseline が無い（一度も押していない）／値がすべて空の tombstone だけの baseline | 出さない（初回に全項目が「変更あり」になるのを避ける） | 初回は全フィールドを「変更」と数える（従来どおり） |
| `gated`（現在の制限・contextMode） | 現在 Phase が 1 つでも制限的／base の contextMode が `current-mention` を満たさない（hidden・suppress・不明な値） | 出さない。「確認できません」とも言わない（DR-MP4-44 の Q-C は現状維持） | 差分があっても `no-candidates` で止まり baseline は進まない |
| `none` | 差分なし（空白・全半角・別名の順だけの違いは `cmp()` が無視）。証明の無い Phase 削除だけで、その Phase を除くと差分なしの場合も含む | 出さない | `no-change` |
| （hook の条件） | AI gate が `enabled` でない／影響チェックの実行中／読みの失敗／項目が無い | 出さない（表示なし。toast も出さない）。gate が `hidden` ならボタンごと出ない（従来どおり） | — |

写し元：`runImpactReview.ts` の門の値（`contextMode`・`hasRestrictedPhases`。#1048 以降の run は既定値を持たず、欠落を公開として補わずに門で止める。第 11 節）、`snapshot.restrictedPhaseIds`、
`effectiveRestrictedPhaseIds`（現在制限中の Phase ∪ baseline の restrictedPhaseIds のうち現在無いもの ∪ baseline の phases のうち現在無く `visibleDeletedPhaseIds` に無いもの）、
`allPhaseIds ?? phases.map(...)` の fallback、`redactRestrictedPhases`、`canIncludeResolvedCodexContext(mode, "current-mention")`（共有関数内で同じ正本を利用）。

**Phase の削除・制限の解除**：run は門で止まらず、`effectiveRestrictedPhaseIds`（証明の無い Phase 削除、非公開だった Phase を消した後、来歴の無い legacy baseline での削除など）の Phase を baseline・現在の両方から除いて差分を取り、候補絞りへ進む。
知らせも同じ除外をした件数を数える（以前の版は「素の差分と食い違う」として出さなかったが、押せば AI まで進む状態で知らせない偽陰性だったため、レビュー指摘で直した）。
件数だけを出すので、除いた（非公開だった）Phase の内容は表示に出ない。

**`unchecked` の注意**：値がすべて空の baseline（確認済みで名前も本文も空だった項目）も、tombstone と区別できないため `unchecked` として出さない（保守的な側。名前が空の項目はほぼ無い）。

## 3. 構成と信頼境界

- 追加（renderer だけ）：`impact-review/impactPending.ts`（純関数 `deriveImpactPending`）、`readImpactPending.ts`（`buildCodexSnapshot`＋`getBaseline` の読み 2 回）、
  `impactPendingEpoch.ts`（押下完了の合図。メモリ内の連番）、`codex/components/useImpactPending.ts`、`ImpactPendingTabMarker.tsx`、
  `DetailTabs` の任意の `marker`、`ImpactCheckButton` の 1 行、`CodexDetailContent` の JSX の配線、locale ja・en。
- **変えない**：`runImpactReview.ts`・`snapshot.ts`（lane C の PR #1048 と重ならないため）、IPC・契約・authority・schema・Rust・送信先・保存範囲・閾値。
- **AI は 0 回**。`runPostEffectMulti`・`resolveRoleSendOverride`・`narrowCandidateScenes`・`saveBaseline` は知らせの経路から呼ばない（`runImpactReview.ts` も import しない。試験で固定、第 8 節）。
  AI に渡る内容は 1 byte も変わらない（ADR 013・`CONTEXT_INJECTION.md` は触らない）。
- **新しい保存は無い**。baseline と現在の DB から毎回計算する。`impactPendingEpoch` はメモリ内の連番で、永続化しない（保存範囲の拡大に当たらない）。
- 読みは renderer の Drizzle 経由（既存の `buildCodexSnapshot`・`getBaseline`。`impact_review_baselines` は D2a の台帳で read-open、ボタンの経路が既に同じ読みをしている）。
- 表示するのは件数と locale の固定語だけ。old／new の値・`summarizeChanges` の文（日本語固定）は出さない。gated の項目には何も出さないので、hidden の項目の変更は表示しない。

### 3.1 規則の共有（恒久策）

`impactGate.ts` の純関数を `runImpactReview.ts` と `impactPending.ts` が共有し、`impactPending.parity.test.ts` は引き続き**実物の `runImpactReview`** と知らせの一致を固定する。
恒久策は本枝で実装済み。共有する範囲は Phase ID 集合、redact と `effectiveRestrictedPhaseIds` に加え、門の判定（`contextMode` が `current-mention` を満たすか・`currentHasRestrictedPhases`）まで含む。

## 4. 検討書の伺う点（Q1〜Q8）の既定とした回答

ユーザーが推奨の既定で承認した（2026-11-23）。試作を見て最終確認する。

| # | 問い | 既定（回答） |
| --- | --- | --- |
| Q1 | どこに知らせるか | (a) 整合性タブの点＋ボタン上の 1 行（レベル 1・2 は作らない） |
| Q2 | 文言 | 「前回のチェック以降に N 件の変更があります」 |
| Q3 | baseline が無い項目 | (a) 出さない |
| Q4 | 「あとで」「無視」「確認済み」 | (a) 付けない。印は押すか変更を戻すまで残る |
| Q5 | 設定のオン／オフ | (a) 設けない（AI policy が OFF なら元から出ない） |
| Q6 | 本文の小さな変更 | (a) すべて数える（空白・全半角は既に無視）。閾値は設けない |
| Q7 | 制限中の項目 | (a) 何も出さない（Q-C の現状維持と整合） |
| Q8 | 一覧の点・校閲パネルの行 | 後で判断（使われ方を見てから）。この PR では作らない |

NIR の語（「変更レビュー」「Attention」「Finding」「Freshness」「影響プレビュー」）は UI・locale・識別子・testid に使わない（NIR の作業レイヤー〔fixture 専用〕と重ならないため）。

## 5. 非同期の読みの lifecycle と GDX-PRECHECK-001

### 5.1 適用外の根拠

`policies/quality/iron-laws.md` の GDX-PRECHECK-001 は、**外部送信・subprocess・background work・async lifecycle** を足す変更に、編集前の owner／lifecycle matrix を要求する
（entry／start／retry／reentrant・admission closure・active handle の所有・cancellation・実際の終了の証拠・persisted restart state を網羅）。
この変更は次のとおり、いずれの資源も新しく持たない（外部送信・subprocess・background・所有する handle・終了の証拠・restart state を持たない。1 回きりの DB 読みと `cancelled` flag、cleanup で必ず clear される debounce timer だけ）。
§5.2 の表は参考の matrix。bounded wait：読みが返らなければ表示なしのままになるだけで実害は無い（待ちを所有しない）。

- **外部送信なし**：AI・network を呼ばない。ローカルの SQLite 読み 2 回だけ。
- **subprocess なし**。
- **background work なし**：push・購読・定期再計算・常駐 timer が無い。再計算は React の effect の契機（mount・props の変化・store の変化）だけ。
  500 ms の debounce の `setTimeout` は effect の cleanup で必ず `clearTimeout` され、unmount を越えて残らない。
- **async lifecycle**：所有する handle・queue・restart state が無く（読みは 1 回きりの Promise。cancel できない読みは `cancelled` flag で結果を捨てる）、
  persisted state も無い。既存の `ConsistencyTab.tsx` の effect と同じ型（cancelled flag）。したがって owner／lifecycle matrix の対象（資源の所有と終了の証明）には当たらないと読む。

これは基準の**解釈**である（検討書 §3・§8 の 10）。レビューで確認する。念のため、下の小さな表で非同期の読みの lifecycle を残す。

### 5.2 非同期の読みの lifecycle

| 契機 | 動き | 古い結果の扱い | 停止の証拠 |
| --- | --- | --- | --- |
| mount（整合性タブを開く＝ボタン、`DetailTabs` の表示＝点） | 待たずに 1 回読む | — | cleanup で `cancelled=true`・`clearTimeout` |
| `refreshKey` の変化（アクティブなタブ・項目の `updatedAt`） | 500 ms の debounce 後に再読込 | 前の effect の cleanup が `cancelled=true` にするので、遅れて返った読みは state を書かない | 同上（試験：同じ項目で再計算が重なったとき古い読みが上書きしない） |
| `entryId` の変化（詳細パネルは項目間で共有され再 mount されない） | 待たずに読む | 描画時に `result.entryId !== entryId` なら出さない（前の項目の結果を一瞬も出さない）＋ cancelled | 試験：古い項目の遅れた結果を捨てる |
| 影響チェックの実行中（`running`）／AI gate が `enabled` でない | 読まない・前の結果も消す | 終了直後に古い件数を出さない | — |
| 実行の終了（`running` が落ちる） | **読まない**。`post-effect/api.ts` は store の `complete`（`running` が落ちる）を `callbacks.onDone`（`runImpactReview` が baseline を進めた後に呼ぶ）より**先**に走らせ、`onDone` の前に候補絞りのやり直しなどで時間がかかる。すぐ読むと古い baseline を見て「N 件」が出続けるため、結果を消したまま、`epoch` の進み（次の行）を待つ | — | 試験：complete の後・onDone の前は 1 行が出ず、読みもしない |
| ボタンの `onDone`／`onError`（baseline の前進の後） | `epoch` を `bump`。**debounce せず**すぐ再読込（タブを離れて unmount していても global store なので効く）。部分失敗（baseline を進めない）の onDone でも `bump` し、変更が残っていれば 1 行が戻る | 同上 | 試験：onDone の合図で再読込・消える／部分失敗では戻る／onError でも再読込 |
| 押下の終わり（ボタンの `finally` が `bump`） | 再読込（`no-candidates`／`no-change` は run を作らずに baseline を進めるので、`running` の変化に頼らない） | 同上 | 試験：押下後に再計算して印が消える |
| 読みの失敗 | 結果を消して表示なし（toast も出さない） | — | 試験：失敗は表示なし・前の結果を残さない |
| unmount | 読みは止められないが、結果は捨てる（state を書かない） | `cancelled` | 試験：unmount 後に返った読みで警告なし |

## 6. 残る制限（画面で見える。作者に見せる。10 項目）

1. **詳細タブで編集した直後、タブの点はすぐには出ないことがある**。点の再計算の契機は mount・アクティブなタブの切替・項目の `updatedAt` の変化・実行の終了・押下の終わりだけ。
   detail 値や Phase の編集は `codexStore` を通らず、`codex_entries` の `updatedAt` を上げるか未確認。タブを切り替えれば出る。
   整合性タブを開けば、ボタン上の 1 行は mount で最新を読み、開いたまま項目が更新された場合も `entry.updatedAt` を `refreshKey` として受けて再計算する（debounce 500 ms。ただし detail・Phase の編集が `updatedAt` を上げない場合は次の契機まで）。書込み経路ごとの配線（検出点が増える）は、この PR では行わない。
2. **制限中（hidden・suppress・Phase 制限）の項目には何も出ない**。「システムは変更を見ていない」ように読めるが、「変更なし」ではなく「確認できない」の場合がある（DR-MP4-44 の Q-C の現状維持）。
3. **候補シーンが 0 件のときの空振り**：知らせが出た後に押すと「影響しそうなシーンは見つかりませんでした」になり、baseline が進んで印が消える。知らせの段で候補絞りは呼ばない（AI 0 回・低コストを保つため）。
4. **非公開 Phase の変更だけでは何も出ない**（押しても「変更がありません」。現状どおり）。
5. **1 行が遅れて現れる**：整合性タブを開いた直後、読みが終わるとボタンの上に 1 行が現れ、ボタンが 1 行ぶん下がる（レイアウトシフト）。高さの予約はしていない。
6. **点と 1 行は別々に読む**（同じ項目で DB 読み 2 回×2）。整合性タブを開いた瞬間は重なって読む。件数は純関数で同じ判定。
7. **ライセンス未認証でも印は出る**（押すと従来どおり弾く）。**別窓で開きっぱなし**の項目は次の契機まで更新されない。
8. **狭い幅（例 240px）では整合性タブは行の右端に隠れ、点が見えない**：8 タブの行はアイコンに畳んでも入り切らないと横スクロールになる（既存の挙動）。整合性は最後のタブなので、
   スクロールするまで点が見えない。そのときもボタン上の 1 行は整合性タブを開けば見える。点を先頭側へ寄せる・タブの順を変えることはしていない（既存のタブ構成を変えない）。
9. **完走の直後、`onDone`（baseline の前進と完了の確認）が終わるまで 1 行・点は出ない**：store の `complete` から `onDone` の合図までは読まずに隠す（古い baseline を読んで「N 件」が戻らないため）。
   部分失敗（baseline を進めない）では `onDone` の後に再読込して、変更が残っていれば 1 行が戻る（再実行すべきなので正しい）。`onDone`／`onError`／`finally` のどの合図も来なかった場合（例：callbacks を経ずに run が閉じた）は、
   次の契機（タブの切替・項目の更新・別の合図）まで表示なしのまま（偽りの「N 件」ではなく、表示なしの側に倒れる）。
10. ja の `pending_one`／`pending_other` は同じ文（ja に単複は無い。既存の `consistencyTab.count_*` に揃えた）。

## 7. 試験

- `impactPending.test.ts`：判定の表（baseline なし・tombstone・差分なし・空白／全半角／別名の順・各フィールドの件数・contextMode・Phase 制限・Phase 削除の証明・制限の解除・undo）。
- `impactPending.parity.test.ts`：**実物の `runImpactReview`** と一致（pending(n)⇒run の `changeCount===n` で候補絞りまで進む／none⇒`no-change`／gated⇒`no-candidates` で候補絞りを呼ばない／
  Phase の削除（証明の無い削除・legacy・制限 id の Phase が現在無い）は run も知らせも Phase を除いた同じ件数で候補絞りへ進む／素の差分 2 件に対し 1 件の食い違いの実例／unchecked は run が全変更と数える）。17 ケース＋3。
- `impactGate.test.ts`：Phase ID、null／tombstone／legacy／通常 baseline、削除証明、redact、contextMode、hasRestrictedPhases と停止理由を共有する純関数の単体試験。
- `impactPending.noAiImports.test.ts`：知らせの経路の 6 file（`impactPending.ts`・`impactGate.ts`・`readImpactPending.ts`・`impactPendingEpoch.ts`・`useImpactPending.ts`・`ImpactPendingTabMarker.tsx`）が
  `runImpactReview`・`narrowing`・`post-effect/api`・`semantic-search`・`modelRouting` などを import（静的・動的）せず、AI／候補絞り／保存の識別子を持たないことを file の文字列で照合する
  （`semanticSearch` は試験で mock していないので spy の 0 回では落ちないため）。
- `ImpactCheckButton.test.tsx`：出る・出ない条件（baseline なし・変更なし・空白のみ・hidden・suppress・Phase 制限・項目なし・gate disabled／hidden・実行中）、
  AI 経路・候補絞り・保存・`runImpactReview` が 0 回、古い結果の破棄（項目切替・同じ項目の再計算の重なり）、失敗は表示なし、unmount、en の単複、
  4 つの status の toast が不変、押下後に再計算、開いたまま項目が更新された（`refreshKey`）ときの再計算。
- `ImpactCheckButton.test.tsx` の「started の完走後」：`runImpactReview` の mock で callbacks を捕まえ、store の `complete` → （まだ古い baseline のまま）**1 行が出ず読みもしない** → baseline を進める → 捕まえた `onDone` で再読込して消えること。部分失敗の `onDone` では 1 行が戻ること。
- `ImpactPendingTabMarker.test.tsx`：点（aria-hidden＋sr-only）、計測行に出ない、出ない状態、gate、失敗、タブ切替・epoch での再計算、entryId 切替。
- `ImpactNudge.browser.test.tsx`（実 Chromium、1 file）：ja・en × 幅 1100／320／220 で、1 行が親からはみ出さず折り返しても崩れない・点がタブの内側でアイコンに重ならない、
  点を足してもタブの幅・位置が変わらない、**8 タブ・詳細がアクティブ・幅 240／1100 で、非アクティブの整合性タブ（アイコンのみに畳まれる幅）の点がタブの内側に収まり、marker の有無で各タブの畳み込みと幅が変わらない**、light／dark のコントラスト（文字 4.5 以上・点 3 以上）。`VITE_IMPACT_NUDGE_SHOT` を付けると見た目の PNG を保存する（CI では保存しない）。

### 7.1 変異試験（1 つずつ入れて試験が落ちることを確認し、戻した）

対象 5 file（`impactPending.test.ts`・`impactPending.parity.test.ts`・`impactPending.noAiImports.test.ts`・`ImpactCheckButton.test.tsx`・`ImpactPendingTabMarker.test.tsx`、85 件）。

| 変異 | 落ちた件数 |
| --- | --- |
| baseline null を unchecked にしない | 2 |
| tombstone を unchecked にしない | 2 |
| contextMode の門を外す | 11 |
| 現在の Phase 制限の門を外す | 5 |
| redact（baseline 側）を外す（Phase の削除・制限の解除の件数） | 8 |
| `visibleDeletedPhaseIds` を無視 | 2 |
| 件数を +1 | 22 |
| 押下完了の合図を出さない（`finally`） | 2 |
| 古い結果を捨てない（cancelled を無視） | 1 |
| AI gate を見ない | 2 |
| 実行中でも出す | 3 |
| entryId 不一致でも前の結果を出す | 1 |
| 失敗で前の結果を残す | 1 |
| ボタンが pending 以外でも 1 行を出す | 4 |
| タブの点を unchecked でも出す | 2 |
| `DetailTabs` が marker を描画しない | 8 |
| 読みで候補絞りを呼ぶ（動的 import） | 2 |
| 読みで `semanticSearch` を直接呼ぶ（動的 import） | 1 |
| `onDone` の合図を出さない | 2 |
| `onError` の合図を出さない | 1 |
| 終了直後に epoch の合図を待たない（P2-b） | 1 |
| ボタンが `refreshKey` を渡さない（P3-1） | 1 |
| sr-only に区切りの括弧が無い（P3-2） | 1 |

- redact（現在側）を外す変異は落ちない。**等価変異**：除外の対象は「baseline の制限 id のうち現在の Phase 集合に無いもの」などで、現在の snapshot の Phase には元から含まれない
  （現在制限的な Phase は先の門で止まる）。run の写しとして残している。
- epoch 起点の再計算を debounce しない変更は、試験が時間を測らないので落ちない（挙動は即時だが、試験は固定していない）。
- AI gate を見ない変異は、最初は 0 件で生き残った（読みの timer が走る前に assert していた）。実時間で待つようにして落ちることを確認した。
- 最初の走行で「古い結果を捨てない」と「失敗で前の結果を残す」が生き残ったため、試験（同じ項目で再計算が重なる・再計算の失敗）を足して落ちることを確認した。

## 8. 検証

- `pnpm lint`、`tsc --noEmit`、`tsc -p electron/tsconfig.json --noEmit`、`pnpm validate:architecture`、`CI=true pnpm exec vitest --run src/features/codex src/features/impact-review`、
  browser 試験 1 file（`ImpactNudge.browser.test.tsx`）と、`DetailTabs`／`codexContentFocusAutosave` の browser 試験、`impact-map.test.mjs`／`ci-change-scope.test.mjs`、main の 3 bundle の sha256（不変）。
  実行結果は PR 本文に書く。
- `vi.mock` の洗い出し：変更した module（`ImpactCheckButton`・`DetailTabs`・`CodexDetailContent`・新規 3 module）を差し替える試験は、`DetailTabs` を `null` にする
  `CodexDetailContent.test.tsx` と `codexContentFocusAutosave.browser.test.tsx` だけ。点の hook は `DetailTabs` 経由でだけ mount されるので、この 2 つで DB 読みや `useAiGate` が走らない。
- `evals/quality-manifest.yaml` の `CodexDetailContent.tsx`（`GDX-POLICY-001` の `implementedBy` の一覧）は、file を追加・削除していないので追従は不要。
- 初期 graph の size（locale の key 追加による数十 byte の見込み）は未実測。CI の perf:budget に委ねる。
- **CI の Browser job が落ちた（2026-11-24。PR の ci.yml）**：`ImpactNudge.browser.test.tsx` の目視用スクリーンショットの試験を `it.skipIf(!SHOT_DIR)` にしていたため、CI（env なし）で skip（pending）1 件になった。
  browser CI の benchmark（`scripts/browser-ci-benchmark.mjs`）は `allTestsPassed`（pending 0 件・全 assertion が passed）を要求するので、vitest の要約は全件成功（81 file・657 件）でも run が失敗と判定された。
  `if (SHOT_DIR) it(...)`（env を付けたときだけ試験を登録）に直し、env なしで skip 0 件になることと、同じ benchmark script の local 実行が `passedRuns:1` になることを確かめた。master の browser 試験に skip が無いのは、この要求のため。

## 9. 影響を受けないこと

IPC・契約・authority・schema・Rust・送信先・保存範囲・閾値・AI に渡る内容・`runImpactReview` の挙動・toast・既存の locale 文言・既存の試験の期待。

## 10. 独立レビュー（Opus、`fa6f1af26..21cee0867`）の反映

P1 なし。次を直した（コミットは枝の最後）。

- **P2-a（偽陰性）**：Phase の削除・制限の解除で、run は `effectiveRestrictedPhaseIds` の Phase を除いて差分を取り候補絞りまで進むのに、知らせは `gated` で出さなかった。
  `redactRestrictedPhases` を写して同じ件数を数える（第 2 節）。parity 試験の 3 ケースの期待を `gated` から `pending`（run の件数と一致）へ反転した（自分の追加分）。
- **P2-b**：store の `complete` と `onDone` の間に古い baseline を読んで「N 件」が出続ける問題を、実行終了直後は読まずに `onDone`／`onError` の合図を待つ形で直した（5.2、6 の 9）。
- **P3**：1 行にも `refreshKey`（`entry.updatedAt`）を渡す／sr-only に括弧／5.1 の一文／§1 の参照／残る制限の数／静的 import の試験／`unchecked` の注意。

## 11. #1048（DR-MP4-44）の取り込みで割れたこと（2026-11-24）

この枝は #1048 より前の master を基点にしていた。master（`dd4c95330`）を取り込む（衝突なし）と、次の 2 つが落ちた。

1. `tsc --noEmit`：`CodexSnapshotResult.contextMode`・`hasRestrictedPhases` が必須になった（#1048）のに、`ImpactCheckButton.test.tsx` の `built` fixture が省略していた。
2. `impactPending.parity.test.ts` の 10 件：pending を期待する case で「`narrowCandidateScenes` が呼ばれていない」。

**診断（訂正）**：当初は「`deriveImpactPending` と #1048 後の `runImpactReview` の restricted Phase の扱いが食い違う」と読んだが、**誤り**だった。
parity 試験の `arrange` は `contextMode` を明示した case にしか値を載せず、#1048 が run の `?? "mentioned"`・`?? false` を外した（欠落を公開として補わず、門で止める）ので、
fixture に値の無い case で run が `no-candidates` に止まっていた。`changeCount` の一致（redact の規則）は通っていた。
同時に、`deriveImpactPending` 側には同じ既定値（`contextMode = "mentioned"`・`hasRestrictedPhases = false`）が残っていた。**run が外した fail-open の既定値の取り残し**である。

**直し**（`runImpactReview.ts` は触らない。AI に渡る内容・止まる条件は変わらない）：

- `impactPending.ts`：2 つの既定値を外す（#1048 ② の写し）。`contextMode` の欠落は `gated`（context-mode）に倒れ、run と同じ fail-closed になる。header に「門の既定値も写す」と明記した。
- parity 試験：`arrange` が公開・制限なしの値を載せる。「contextMode が runtime で欠落」の case（run も知らせも `gated`）を足した。
- `impactPending.test.ts`：fail-open を固定していた「contextMode 未指定は mentioned として pending」を、「欠落は `gated`（context-mode）」に反転した。`built` helper は既定値を持つ。
- `ImpactCheckButton.test.tsx`：`built` fixture に公開・制限なしの既定値を足した。

**変異の確認**：`impactPending.ts` の既定値を一時的に戻すと、追加した 2 件（unit・parity）だけが赤になる。戻して `cmp` で一致を確認した。

redact と門の共有は第 12 節のとおり実装済み（§3.1）。

## 12. 恒久策の実装（2026-11-24）

`src/features/impact-review/impactGate.ts` に IO・AI・DB・store・IPC を import しない純関数を置いた。

- `phaseIds`：`allPhaseIds ?? phases.map(phaseId) ?? []` を ID 集合にする。
- `effectiveRestrictedPhaseIds`：baseline が `null` の場合も受け、現在制限中の ID、現在存在しない baseline の `restrictedPhaseIds`、削除証明のない baseline Phase の ID をまとめる。
- `redactRestrictedPhases`：指定集合にある Phase だけを snapshot から除く。
- `currentHasRestrictedPhases` と `evaluateImpactGate`：`hasRestrictedPhases || snapshot.restrictedPhaseIds.length > 0` を評価し、`restricted-phase` を先に、続いて `context-mode` を返す。contextMode は `canIncludeResolvedCodexContext(contextMode, "current-mention")` に従う。

`runImpactReview.ts` と `impactPending.ts` は同じ関数を使う。run は既存の tombstone 書き込み後に共有除外集合を作り、redact → diff → no-change 時の baseline 前進判定 → 最終 gate の順を保つ。知らせは同じ gate の理由で gated を返し、通過時に同じ除外集合と redact で件数を出す。`impactPending.noAiImports.test.ts` の対象に新 module を足し、知らせ経路の AI・DB・store・IO import がないことを固定した。

dispatch 直前の `captureValidatedImpactInputs` は変更していない。そこは既存どおり source fingerprint の一致後に `latest.contextMode` と `latest.hasRestrictedPhases` を確認する。`snapshot.restrictedPhaseIds` を gate に直接足さないのは、初回の fingerprint に同 field が含まれており、一致確認の意味とその後の二条件を保つため。

条件別 mutation は1つずつ適用し、毎回 helper を保存版へ戻して `cmp` で一致を確認した。全条件で run 側の `runImpactReview.visibility.test.ts` と知らせ側の `impactPending.test.ts` が失敗した。parity も壊れる条件では `impactPending.parity.test.ts` も失敗した。

| mutation | 失敗した試験 | 結果 |
| --- | --- | --- |
| 現在の restricted ID の gate 条件を反転 | run visibility・pending unit・parity | 3 file、50 failed / 32 passed |
| 有効集合から現在の restricted ID を除去 | run visibility・pending unit | 2 file、3 failed / 79 passed |
| baseline の restricted ID loop を除去 | run visibility・pending unit | 2 file、3 failed / 79 passed |
| 証明の無い削除の条件を反転 | run visibility・pending unit・parity | 3 file、12 failed / 70 passed |
| contextMode の gate を反転 | run visibility・pending unit・parity | 3 file、59 failed / 23 passed |
| `hasRestrictedPhases` の条件を除去 | run visibility・pending unit・parity | 3 file、3 failed / 79 passed |

最終検証：`CI=true pnpm exec vitest --run src/features/impact-review src/features/codex` は 155 file・1,811 tests 成功（4 file・7 tests skip）。root と Electron の `tsc --noEmit` は成功。`pnpm -s lint` は 0 errors・43 warnings、`pnpm -s validate:architecture` は 1/1 pass、`git diff --check` も成功。実 Chromium の `ImpactNudge.browser.test.tsx` は UI 変更がないため未実行。

### 12.1 独立レビュー（別の Codex セッション、read-only。`2e4fdec33..392f11532`）の反映

verdict は REVISE（P1 が 1 件。P0 なし）。**等価性は全入力の類で確認された**：`currentHasRestrictedPhases`（旧 `Set(...).size > 0` と新 `length > 0` は、欠落・空・非空・重複あり配列で同じ真偽値）、
tombstone 処理の後に除外集合を作る順序、null・空集合の redact、差分 0 件のときの掃除の条件、最終の `no-candidates` の status・件数・summary・candidateSceneCount、知らせの旧実装との同値。
dispatch 直前の再検査（`captureValidatedImpactInputs`）は差分に含まれず、共有の門も当てていない。

- **P1（反映）**：`impactPending.noAiImports.test.ts` の `impactGate.ts` の検査は禁止リスト方式で、DB を import する `./snapshot`（`@/db/client` と Drizzle を import）などを足しても落ちなかった。
  **許可リスト方式**（`@/features/codex/context/codexVisibilityPolicy`・`./diff` だけ）に直し、「`./snapshot` を足すと許可リストが拒む」ことを空振り防止の試験で固定した。
  変異（`impactGate.ts` に `import "./snapshot"` を一時的に足す）で 2 件が赤になり、戻して差分が空であることを確かめた。

