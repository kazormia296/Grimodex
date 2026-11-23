# 影響チェックの「要りそう」の知らせ（レベル 0）の判断の記録

- 状態：**実装済み・試作の確認待ち**（2026-11-23。枝 `claude/impact-check-nudge`、`origin/master` `fa6f1af26` から。未 push）。
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
| 整合性タブ | タブの右上に小さな点（主色）。タブのアイコンと文字の幅・位置は変わらない（absolute で重ね、ボタンの padding の内側）。狭幅でアイコンだけになっても同じ（8 タブ・詳細がアクティブ・整合性が非アクティブの状態を実 Chromium で確認）。スクリーンリーダーには sr-only の語を足す | 影響チェックが未実施の変更があります | Changes not yet checked for impact |
| ボタン上の 1 行 | 整合性タブの中、「この変更の影響をチェック」ボタンの上に 1 行。小さな点＋文言（`text-xs`、muted の文字色）。折り返しても親の幅の内側 | 前回のチェック以降に N 件の変更があります | 1 change since the last check ／ N changes since the last check |

- 押したときの挙動・toast（no-change／no-candidates／source-changed／started）・既存の locale 文言は**変えない**。
- 押して完走する（または候補 0 件で baseline が進む）と、点も 1 行も消える。変更を undo などで baseline に戻しても、再計算の契機のあとに消える（状態比較のため）。
- toast・音・ダイアログでの通知は無い。「あとで」「無視」「影響なしとして確認済み」も無い。設定のオン／オフ、本文の小さな変更の閾値も無い。

## 2. 出す条件（`runImpactReview` の実行時の判定と同じ）

| 状態 | 条件 | 表示 | 押したとき（run） |
| --- | --- | --- | --- |
| `pending`（件数 N） | baseline があり値が確認済み、現在 Phase が制限的でない、base の contextMode が `current-mention` を満たす、`effectiveRestrictedPhaseIds` が空、`computeCodexDiff` が N>0 件、AI gate が `enabled`、影響チェックの実行中でない | 出す | `no-change` でなく、`changeCount === N`、候補絞りまで進む |
| `unchecked` | baseline が無い（一度も押していない）／値がすべて空の tombstone だけの baseline | 出さない（初回に全項目が「変更あり」になるのを避ける） | 初回は全フィールドを「変更」と数える（従来どおり） |
| `gated`（現在の制限・contextMode） | 現在 Phase が 1 つでも制限的／base の contextMode が `current-mention` を満たさない（hidden・suppress・不明な値） | 出さない。「確認できません」とも言わない（DR-MP4-44 の Q-C は現状維持） | 差分があっても `no-candidates` で止まり baseline は進まない |
| `gated`（unresolved-phase-restriction） | run の redact が Phase を除外する（証明の無い Phase の削除、baseline の restrictedPhaseIds の Phase が現在無い、など） | 出さない（素の差分は run の差分と食い違うため。偽陽性を避け、偽陰性は許容） | Phase を除いた差分で動く |
| `none` | 差分なし（空白・全半角・別名の順だけの違いは `cmp()` が無視） | 出さない | `no-change` |
| （hook の条件） | AI gate が `enabled` でない／影響チェックの実行中／読みの失敗／項目が無い | 出さない（表示なし。toast も出さない）。gate が `hidden` ならボタンごと出ない（従来どおり） | — |

写し元：`runImpactReview.ts` の `contextMode ?? "mentioned"`、`hasRestrictedPhases ?? false`、`snapshot.restrictedPhaseIds`、
`effectiveRestrictedPhaseIds`（現在制限中の Phase ∪ baseline の restrictedPhaseIds のうち現在無いもの ∪ baseline の phases のうち現在無く `visibleDeletedPhaseIds` に無いもの）、
`allPhaseIds ?? phases.map(...)` の fallback、`canIncludeResolvedCodexContext(mode, "current-mention")`（同じ関数を import）。

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

### 3.1 規則が 2 か所になる点

`effectiveRestrictedPhaseIds` の算出は `runImpactReview.ts` の inline で、外から呼べない。この lane は `runImpactReview.ts` を変えない（lane C と重ならないため）ので、
**同じ規則を `impactPending.ts` に別に書き**、`impactPending.parity.test.ts` が**実物の `runImpactReview`** と突き合わせて一致を固定する。
恒久策：#1048 の merge の後に、run の redact を純関数へ切り出して `runImpactReview.ts` と `impactPending.ts` で共有する（別 PR）。

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
この変更は次のとおり、いずれの資源も新しく持たない。

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
| 実行の終了（`running` が落ちる） | 再読込。ただし `post-effect/api.ts` は store の `complete`（`running` が落ちる）を `callbacks.onDone`（`runImpactReview` が baseline を進めた後に呼ぶ）より**先**に走らせるので、この読みは古い baseline を見て「N 件」が一瞬戻りうる | 同上 | 下の 2 行で収束 |
| ボタンの `onDone`／`onError`（baseline の前進の後） | `epoch` を `bump`。**debounce せず**すぐ再読込（タブを離れて unmount していても global store なので効く） | 同上 | 試験：complete が baseline の前進より先でも、onDone の合図で印が消える／onError でも再読込 |
| 押下の終わり（ボタンの `finally` が `bump`） | 再読込（`no-candidates`／`no-change` は run を作らずに baseline を進めるので、`running` の変化に頼らない） | 同上 | 試験：押下後に再計算して印が消える |
| 読みの失敗 | 結果を消して表示なし（toast も出さない） | — | 試験：失敗は表示なし・前の結果を残さない |
| unmount | 読みは止められないが、結果は捨てる（state を書かない） | `cancelled` | 試験：unmount 後に返った読みで警告なし |

## 6. 残る制限（画面で見える。作者に見せる）

1. **詳細タブで編集した直後、タブの点はすぐには出ないことがある**。点の再計算の契機は mount・アクティブなタブの切替・項目の `updatedAt` の変化・実行の終了・押下の終わりだけ。
   detail 値や Phase の編集は `codexStore` を通らず、`codex_entries` の `updatedAt` を上げるか未確認。タブを切り替えれば出る。
   整合性タブを開けば、ボタン上の 1 行は常に最新（mount で読む）。書込み経路ごとの配線（検出点が増える）は、この PR では行わない。
2. **制限中（hidden・suppress・Phase 制限）の項目には何も出ない**。「システムは変更を見ていない」ように読めるが、「変更なし」ではなく「確認できない」の場合がある（DR-MP4-44 の Q-C の現状維持）。
3. **候補シーンが 0 件のときの空振り**：知らせが出た後に押すと「影響しそうなシーンは見つかりませんでした」になり、baseline が進んで印が消える。知らせの段で候補絞りは呼ばない（AI 0 回・低コストを保つため）。
4. **非公開 Phase の変更だけでは何も出ない**（押しても「変更がありません」。現状どおり）。
5. **1 行が遅れて現れる**：整合性タブを開いた直後、読みが終わるとボタンの上に 1 行が現れ、ボタンが 1 行ぶん下がる（レイアウトシフト）。高さの予約はしていない。
6. **点と 1 行は別々に読む**（同じ項目で DB 読み 2 回×2）。整合性タブを開いた瞬間は重なって読む。件数は純関数で同じ判定。
7. **ライセンス未認証でも印は出る**（押すと従来どおり弾く）。**別窓で開きっぱなし**の項目は次の契機まで更新されない。
8. **狭い幅（例 240px）では整合性タブは行の右端に隠れ、点が見えない**：8 タブの行はアイコンに畳んでも入り切らないと横スクロールになる（既存の挙動）。整合性は最後のタブなので、
   スクロールするまで点が見えない。そのときもボタン上の 1 行は整合性タブを開けば見える。点を先頭側へ寄せる・タブの順を変えることはしていない（既存のタブ構成を変えない）。
9. **完走の直後、一瞬「N 件」が戻ることがある**：store の `complete`（実行中でなくなる）が baseline の前進より先に走るため、その時点の読みは古い baseline を見る。
   baseline の前進の後の `onDone` の合図ですぐ再読込して消える（短い残像）。部分失敗（baseline を進めない）では残り続ける（再実行すべきなので正しい）。
10. ja の `pending_one`／`pending_other` は同じ文（ja に単複は無い。既存の `consistencyTab.count_*` に揃えた）。

## 7. 試験

- `impactPending.test.ts`：判定の表（baseline なし・tombstone・差分なし・空白／全半角／別名の順・各フィールドの件数・contextMode・Phase 制限・Phase 削除の証明・制限の解除・undo）。
- `impactPending.parity.test.ts`：**実物の `runImpactReview`** と一致（pending(n)⇒run の `changeCount===n` で候補絞りまで進む／none⇒`no-change`／gated⇒`no-candidates` で候補絞りを呼ばない／
  unresolved-phase-restriction は run の差分が素の差分と食い違う実例／unchecked は run が全変更と数える）。15 ケース＋2（gated のうち unresolved な 3 ケースは、run が実際に数える件数 `runChangeCount` を固定する）。
- `ImpactCheckButton.test.tsx`：出る・出ない条件（baseline なし・変更なし・空白のみ・hidden・suppress・Phase 制限・項目なし・gate disabled／hidden・実行中）、
  AI 経路・候補絞り・保存・`runImpactReview` が 0 回、古い結果の破棄（項目切替・同じ項目の再計算の重なり）、失敗は表示なし、unmount、en の単複、
  4 つの status の toast が不変、押下後に再計算。
- `ImpactCheckButton.test.tsx` の「started の完走後」：`runImpactReview` の mock で callbacks を捕まえ、store の `complete` → まだ古い baseline → baseline を進める → 捕まえた `onDone` を呼ぶ、の順で印が消えること。
- `ImpactPendingTabMarker.test.tsx`：点（aria-hidden＋sr-only）、計測行に出ない、出ない状態、gate、失敗、タブ切替・epoch での再計算、entryId 切替。
- `ImpactNudge.browser.test.tsx`（実 Chromium、1 file）：ja・en × 幅 1100／320／220 で、1 行が親からはみ出さず折り返しても崩れない・点がタブの内側でアイコンに重ならない、
  点を足してもタブの幅・位置が変わらない、**8 タブ・詳細がアクティブ・幅 240／1100 で、非アクティブの整合性タブ（アイコンのみに畳まれる幅）の点がタブの内側に収まり、marker の有無で各タブの畳み込みと幅が変わらない**、light／dark のコントラスト（文字 4.5 以上・点 3 以上）。`VITE_IMPACT_NUDGE_SHOT` を付けると見た目の PNG を保存する（CI では保存しない）。

### 7.1 変異試験（1 つずつ入れて試験が落ちることを確認し、戻した）

| 変異 | 落ちた件数（対象 4 file。※以外は 70 件中、※は試験を足した後の 72 件中） |
| --- | --- |
| baseline null を unchecked にしない | 2 |
| tombstone を unchecked にしない | 2 |
| contextMode の門を外す | 11 |
| 現在の Phase 制限の門を外す | 4 |
| effective 制限（Phase 削除）の門を外す | 6 |
| `visibleDeletedPhaseIds` を無視 | 2 |
| 件数を +1 | 14 |
| 押下完了の合図を出さない | 4 |
| 古い結果を捨てない（cancelled を無視）※ | 1 |
| AI gate を見ない | 1 |
| 実行中でも出す | 1 |
| `onDone` の合図を出さない（started の完走後に印が残る）※ | 1 |
| `onError` の合図を出さない ※ | 1 |
| entryId 不一致でも前の結果を出す | 1 |
| 失敗で前の結果を残す ※ | 1 |
| ボタンが pending 以外でも 1 行を出す | 4 |
| タブの点を unchecked でも出す | 2 |
| `DetailTabs` が marker を描画しない | 8 |
| 読みで候補絞りを呼ぶ（AI 経路の起動） | 1 |

※の `onDone`／`onError` は 74 件中。epoch 起点の再計算を debounce しない変更は、試験が時間を測らないので落ちない（挙動は即時だが、試験は固定していない）。

最初の走行で「古い結果を捨てない」と「失敗で前の結果を残す」が生き残ったため、試験（同じ項目で再計算が重なる・再計算の失敗）を足して落ちることを確認した。

## 8. 検証

- `pnpm lint`、`tsc --noEmit`、`tsc -p electron/tsconfig.json --noEmit`、`pnpm validate:architecture`、`CI=true pnpm exec vitest --run src/features/codex src/features/impact-review`、
  browser 試験 1 file（`ImpactNudge.browser.test.tsx`）と、`DetailTabs`／`codexContentFocusAutosave` の browser 試験、`impact-map.test.mjs`／`ci-change-scope.test.mjs`、main の 3 bundle の sha256（不変）。
  実行結果は PR 本文に書く。
- `vi.mock` の洗い出し：変更した module（`ImpactCheckButton`・`DetailTabs`・`CodexDetailContent`・新規 3 module）を差し替える試験は、`DetailTabs` を `null` にする
  `CodexDetailContent.test.tsx` と `codexContentFocusAutosave.browser.test.tsx` だけ。点の hook は `DetailTabs` 経由でだけ mount されるので、この 2 つで DB 読みや `useAiGate` が走らない。
- `evals/quality-manifest.yaml` の `CodexDetailContent.tsx`（`GDX-POLICY-001` の `implementedBy` の一覧）は、file を追加・削除していないので追従は不要。
- 初期 graph の size（locale の key 追加による数十 byte の見込み）は未実測。CI の perf:budget に委ねる。

## 9. 影響を受けないこと

IPC・契約・authority・schema・Rust・送信先・保存範囲・閾値・AI に渡る内容・`runImpactReview` の挙動・toast・既存の locale 文言・既存の試験の期待。
