# Grimodex — 執筆タイムラプス設計書（動画エクスポート / P7）

> 最終更新: 2026-06-18
> ステータス: **P7 v1 実装済み**（2026-05-30、master 直 commit）。記録基盤（P2〜P5）は従前から本番稼働中。本書は P7「Canvas ビジュアル再生 → WebM 動画エクスポート」+ 記録 ON/OFF 制御（§15）の設計と実装記録（実装乖離は §16）。
> （2026-06-18 追記）その後 **P5 compositor**（複数 entity cursor + chrome キャプション）・**プロジェクト全体書出**・**chat/layout 記録（P0, §17）**・**見出し/リスト/引用の構造描画（P2）**が出荷済み。本書の旧記述（renderer は段落のみ／対象はシーン単位／replayEngine 未配線／ホストは `TimelapsePanel`／§17 は記録フックのみで描画は将来）は **stale**。各節に追記で訂正する。
> 依存: Grimodex_統合DBスキーマ.md（`change_events` / `state_snapshots` の DDL はそちらが正本。本書では再掲しない）、Grimodex_Editorパネル設計書.md（doc.step 記録）、Grimodex_リビジョン履歴設計書.md（モーダルホストの先例）、Grimodex_エクスポートダイアログ設計書.md（save-to-disk パターン）

実装ディレクトリ: `src/features/timelapse/`
（記録: `recorder.ts`, `queryEvents.ts`, `hashChain.ts`, `snapshots.ts` / 記録フック: `captureChat.ts`, `captureLayout.ts`, `seedSession.ts` / 再生: `replayEngine.ts`, `replayStart.ts`, `renderers/editorRenderer.ts` / compositor: `compositeTimelapse.ts`, `frameProducer.ts`, `formatEventCaption.ts`, `bodyDiff.ts`, `chromeRenderer.ts`, `resolveEditorTheme.ts` / 書出: `exportTimelapse.ts`, `videoExport.ts`, `zipExport.ts`, `verifyHtmlTemplate.ts` / UI: `TimelapseExportSection.tsx`, `TimelapsePlayer.tsx`）

---

## 0. TL;DR / この設計の結論

- **動画化は「ゼロから作る」のではなく、既存ピースの配線**である。`replayEditorSteps`（step→doc）・`renderDocToCanvas`（doc→canvas）・`captureCanvasToWebm`（canvas→WebM Blob）は実装済み・ユニットテスト済みだが、**3つを繋ぐ frame producer が存在せず、どこからも呼ばれていない**。
- **ただし最大の制約は「再生可能性の射程」**。editor の payload は full snapshot ではなく **incremental ProseMirror step**。replay は「空 doc から forward 適用」しか正しく復元できず、**forward step からは逆算（過去 doc の復元）が原理的に不可能**。`state_snapshots` は実装されているが production で一度も書かれていない（caller 0 件）。
- 従って **本機能は forward-looking**。「記録開始前から本文があったシーンの過去執筆」はタイムラプス化できない。**v1 は「記録開始時点で空だったシーン」**（= 記録基盤稼働後に新規作成されたシーン）を対象とし、既存シーンは **baseline snapshot を一度焼く**ことで「それ以降の執筆」を対象化する。
- v1 スコープは **editor 系ドメイン（editor / codex / snippet 本文）の描画**。見出し/リスト/引用は **構造描画済み**（2026-06-18 追記、§6 / `editorRenderer.ts:258-353`）。map/grid 等の視覚状態は依然 renderer 未対応（chat/layout は本文描画ではなく下部 chrome キャプションとして合成、§17 / `formatEventCaption.ts`）。
- ホストは **`AnimatedOverlay` ではなく `ExportDialog` の「タイムラプス動画」タブ**に着地した（2026-06-18 追記、§16-1）。当初推奨の全画面オーバーレイは save-only のため不要だった。

---

## 1. 用語とフェーズ

コード内コメントに散在するフェーズ呼称を整理する（本書は P7 の設計）。

| フェーズ | 内容 | 実装状況 | 典拠 |
| --- | --- | --- | --- |
| P0 | chat / layout の forward-only 記録（§17） | **実装済**（`captureChat`/`captureLayout`/`seedSession` + chatApi/layoutStore/loadProject 配線） | `recorder.ts:37-42`（`chat`/`layout` domain） |
| P2 | editor 系 step replay + 見出し/リスト/引用の構造描画 | 実装済（editor/codex/snippet のみ） | `replayEngine.ts:1-13`, `editorRenderer.ts:258-353` |
| P3+ | grid/map など他ドメインの本文 replay | 未着手（grid/map は chrome キャプションのみ） | `replayEngine.ts:10-12` |
| P5 | compositor（複数 entity cursor + chrome キャプション + render-target 選択） | **実装済・出荷** | `compositeTimelapse.ts`, `frameProducer.ts`, `formatEventCaption.ts` |
| **P7** | **Canvas ビジュアル再生 → 動画化** | **実装済（v1, §16）** | `exportTimelapse.ts`, `videoExport.ts`, `editorRenderer.ts` |
| P8 | `verify.html` ドロップイン検証 | 実装済（zip 内）・UI 未配線 | `zipExport.ts` |

> （2026-06-18 追記）`TimelapsePlayer`（scrubber UI）は debug/将来用に残るが出荷経路ではない。出荷 UI は `TimelapseExportSection`（ExportDialog タブ）。

---

## 2. 現状アセット（既にあるもの）

| 部品 | 役割 | シグネチャ / 要点 | 状態 |
| --- | --- | --- | --- |
| `recorder.ts` | 変更イベント記録（append-only, hash chain, 100ms バッチ） | `recordChangeEvent(input)`（L241-254）/ `flushNow()`（L270-332）/ default `enabled:false`（L97） | **本番稼働中**（§3） |
| `queryEvents.ts` | イベント読み出し | `loadProjectChangeEvents(projectId)`（L21-27）/ `loadSceneChangeEvents(projectId, sceneId)`（L35-49, ASC by sequence） | project 版のみ配線済 |
| `hashChain.ts` | sha256 チェーン検証 | `verifyChain(events)`（L139-176）/ `canonicalSerializeEvent`（L43-70） | 配線済（verify ボタン） |
| `replayEngine.ts` | step→doc 再構成 | `createReplayCursor(schema, initialDoc, events)`（L74）の逐次カーソル / `replayEditorSteps`（L194）は cursor で実装 / editor/codex/snippet のみ（`isEditorBodyDomain` L212） | **配線済**（`compositeTimelapse.ts` が cursor を呼ぶ, 2026-06-18 追記） |
| `renderers/editorRenderer.ts` | doc→canvas 描画（authorship 色付き） | `renderDocToCanvas(ctx, doc, w, h, theme)`（L64-119）/ text-only（L4-16） | **未配線** |
| `videoExport.ts` | canvas→WebM Blob | `captureCanvasToWebm(canvas, opts)`（L42-91）/ `CaptureWebmOptions`（L17-40） | **未配線** |
| `snapshots.ts` | replay 起点アンカー | `recordStateSnapshot`（L32-51）/ `loadLatestSnapshot`（L66-111）/ `shouldCreateSnapshot`（L117-128） | **未配線（production caller 0）** |
| `zipExport.ts` | 検証可能 zip（report+chain+verify.html） | `buildAuthorshipExportZip(input)`（L64-76, `level:0` STORE） | 未配線 |
| `TimelapsePlayer.tsx` | scrubber プレイヤー UI（debug/将来用） | props 無し / 全イベント load | **どこにもマウントされていない**（出荷経路は `TimelapseExportSection`） |
| `ZipExportDialog.tsx` | save-to-disk の定番実装 | `saveZipBlob(blob, filename)`（L21-46） | 参照元（reuse 対象） |

> **結論（旧 / 2026-05-29）**: 未実装は「繋ぎ込み（frame producer）」「ホスト UI」「保存配線」。
> **（2026-06-18 追記）解消済み**: 繋ぎ込みは `frameProducer.ts`（schedule + makeDrawFrame）と `compositeTimelapse.ts`（複数 entity cursor + chrome キャプション）に実装。書出は `exportTimelapse.ts`（`produceSceneTimelapseWebm` / `produceProjectTimelapseWebm` / `saveWebmBlob`）。ホストは `TimelapseExportSection`（ExportDialog タブ）。新規アセット: `compositeTimelapse.ts` / `frameProducer.ts` / `formatEventCaption.ts` / `bodyDiff.ts`（本文 diff キャプション）/ `chromeRenderer.ts`（下部キャプション帯）/ `resolveEditorTheme.ts` / `replayStart.ts`（snapshot or 空 doc から起点 doc を構築）。

---

## 3. データモデル前提

### 3.1 記録は本番で ON（forward-looking の前提）

`projectStore.loadProject` が実ブラウザ時（vitest / SSR 以外）に `setRecorderEnabled(true)` + `initRecorderForProject(projectId)` を呼ぶ（`projectStore.ts:86-102`）。**プロジェクトを開くたびに記録が走る**。よって記録基盤の稼働開始以降に書かれた編集は素材として溜まっている。

### 3.2 change_events スキーマ（要点）

> 列定義・型・index・FK の正本は Grimodex_統合DBスキーマ.md の `change_events` / `state_snapshots` を参照（本書では再掲しない）。タイムラプス再生に効く要点だけ抜粋:

- `projectId`(FK cascade) / `sceneId`(FK set null, nullable, treeNodes 参照) / `domain` / `opType` / `entityType?` / `entityId?`(FK 無し) / `payload`(canonical JSON TEXT) / `sessionId`(録画 run id) / `sequence`(project 内 monotone) / `timestamp`(epoch ms) / `prevHash` / `hash`。`unique(projectId, sequence)`。
- **`prevHash`/`hash` は hex TEXT**（当初 blob 32B 設計だったが drizzle sqlite-proxy が BLOB を round-trip できず hex TEXT 化、§16-7）。

- **domain**（`recorder.ts:28-42` / `queryEvents.ts`）: `editor | codex | snippet | grid | map | synopsis | intent | beat | chat | layout`。`chat`/`layout` は P0（§17）で capture site 実装済み（doc.step は持たず chrome キャプション/snapshot として再生）。`synopsis`/`intent`/`beat` は capture site 未実装（予約）。列は enum でなく TEXT のため domain 追加に migration 不要。
- **sequence は project 単位の単調増加**（scene/chapter 単位ではない）。順序の真の基準は `sequence`（同一 ms に複数 step が入りうるので timestamp では順序を決めない）。
- **書き込み**: `recordChangeEvent` は非ブロッキング enqueue → 100ms デバウンスで単一 `INSERT ... VALUES(複数行)`（`recorder.ts:170-248`）。

### 3.3 【核心】editor payload は incremental step（snapshot ではない）

`EditorPane.onTransaction` が `payload = { steps: transaction.steps.map(s => s.toJSON()) }`, `opType='doc.step'` で記録（`EditorPane.tsx:719-739`）。`isApplyingExternalUpdate` のときは記録しない（シーン切替ロード/同期は「執筆」ではないため、`EditorPane.tsx:719`）。

- **replayable なのは editor 系のみ**。`replayEditorSteps` は `opType==='doc.step'` かつ domain ∈ {editor, codex, snippet} だけを `Step.fromJSON` + `step.apply` で前進適用（`replayEngine.ts:44-83`）。
- grid/map/codex メタ/snippet メタの payload は **メタデータのみ**（例 `{ fields: [...] }`）で、視覚状態を再構成できない。codex 本文 diff は editor の doc.step 経路を通る（`codexStore.ts:282-286`）。

---

## 4. 【最重要】再生可能性の射程 = この機能が見せられるもの

設計判断の最も硬い制約。ここで v1 の射程が決まる。

### 4.1 forward replay は「起点 doc」を必要とする

`replayEditorSteps(schema, initialDoc, events)` は呼び出し側が **起点 doc を渡す**前提（`replayEngine.ts:36`）。step は「ある doc に対する差分」なので、起点が正しくないと `step.apply` が位置ズレで失敗する（`failedAt`/`reason` を返す, `replayEngine.ts:71-79`）。

### 4.2 forward step から過去 doc は復元できない（原理）

ProseMirror の step を逆適用するには `step.invert(doc_{N-1})` が必要で、これには **適用前の doc** が要る。記録しているのは forward step のみ・適用前 doc は保存していない。よって「現在の doc + forward steps」から開始 doc を逆算することは**できない**。

### 4.3 state_snapshots は存在するが未稼働

`recordStateSnapshot`（`snapshots.ts:32-51`）と `shouldCreateSnapshot`（同 L117-128, 既定: 1000 events / 1h ごと）は実装済みだが **production caller が 0**。`state_snapshots` テーブルは常に空。つまり今は **どのシーンにも replay 起点アンカーが無い**。

### 4.4 結論: v1 が対象にできるもの

| シーンの状態 | タイムラプス化 | 理由 |
| --- | --- | --- |
| 記録稼働後に **新規作成**され、空から書かれた | ◯ 概ね可能 | seq 1 から forward 適用すれば空 doc 起点で復元。ただし下記の前提あり |
| 記録稼働前から本文があった既存シーン | ⚠️ 部分的 | 起点 doc 不明。**baseline snapshot を今焼けば「それ以降」のみ対象化** |
| 既存シーンの「過去（baseline 前）の執筆」 | ❌ 不可能 | 原理的に逆算不能（§4.2） |

> 「空から」行の前提は2つ: (a) シーンが**真に空で始まった**こと（テンプレート/雛形の初期本文があると最初の step が非空 doc に対して差分となり `step.apply` が失敗する）、(b) `loadProject` の **recorder 非同期有効化ウィンドウ**で初期 step が取りこぼされていないこと。どちらも完全保証ではないため、**堅牢解は baseline snapshot（§4.5 / P7.7）**。「空起点で必ず復元できる」と過信しない。

> **設計書冒頭で誠実に明示すべき点**: 「タイムラプス」という語感（＝過去の全執筆を遡って動画化）と、データが提供できるもの（＝アンカー以降の forward 執筆）にはギャップがある。UI のコピーでも「これ以降の執筆を記録して動画化します」と forward-looking に伝える。

### 4.5 baseline 戦略（推奨）

1. **snapshots を production 配線する**: `recorder.flushNow` 経路で `shouldCreateSnapshot` を評価し、editor 系 entity ごとに `recordStateSnapshot({ projectId, domain:'editor', entityId: sceneId, anchorSequence, payload: doc.toJSON() })` を焼く。
2. **encoding は既に整合（当初「不整合」と書いたが過大）**: `recordStateSnapshot` は `'gzip-json'` を書き `loadLatestSnapshot` も gzip で読むため write/read は一致している（`snapshots.ts:39,48,96`）。schema 既定 `'zstd-json'`（`schema.ts:1563`）は**未使用の latent risk のみ**。対応は「reader を `encoding` カラムで分岐させ gunzip 決め打ちをやめる」（将来 encoding を増やしたとき安全、低優先）。snapshot payload は `loadSceneContent` の **PM-JSON 文字列**（= `doc.toJSON()` 相当）をそのまま格納。**実装済み（C1）**。
3. **既存シーンの一回焼き（v1 採用）**: 記録を ON にした時点で、現在の各シーン doc を baseline snapshot として焼く（§15 の ON/OFF 制御と連動）。以後の編集は replay 可能になる。
4. replay 起点 = `loadLatestSnapshot(asOfSequence)` → 末尾の trailing steps を forward 適用。snapshot が無ければ空 doc から（= 新規シーンのみ正しい）。

---

## 5. アーキテクチャ設計（再生パイプライン）

### 5.1 全体パイプライン

```
loadSceneChangeEvents(projectId, sceneId)        // §3.2 ASC by sequence
  → filter(opType==='doc.step')                  // editor 本文のみ
  → 起点 doc 決定（snapshot or 空 doc, §4.5）
  → frame schedule（frame i → target sequence, §5.5）を先に計算
  → ① 1個のオフスクリーン canvas + 1個の replay cursor を保持
  → ② drawFrame(i) 内で: cursor.applyUntil(schedule[i])（delta 前進）→ renderDocToCanvas で都度描画
  → ③ captureCanvasToWebm(canvas, { drawFrame }) で WebM Blob 化
  → ④ saveWebmBlob(blob, "<title>.webm")          // §8
```

ポイントは **「フレーム毎にゼロから replay し直さない」**こと（= cursor で delta 前進）。**全フレームを事前 raster 化してバッファに溜めるのではない**（§5.4）— メモリは常に doc 1個 + canvas 1枚だけ。

### 5.2 replayEngine の incremental cursor 化（最大レバレッジ）

現状 `replayEditorSteps` は **全 step を一括適用して終端 doc だけ**を返す（`replayEngine.ts:42-84`）。N フレーム欲しいときに `events.slice(0, k)` を毎回最初から replay すると **O(n²)**。

**改修案**: 中間状態を出せる API を追加する。既存の一括 API は壊さず、内部を共有する。

```ts
// 既存（維持）: replayEditorSteps(schema, initialDoc, events): EditorReplayResult
// 追加: 逐次カーソル
export interface ReplayCursor {
  readonly doc: ProseMirrorNode;       // 現在の doc 状態
  readonly appliedSteps: number;
  readonly atSequence: number | null;  // 直近適用イベントの sequence
  applyUntil(sequence: number): void;  // 指定 sequence まで delta だけ前進適用（O(delta)）
  applyNext(): boolean;                 // 1 step 前進（false=末尾）
}
export function createReplayCursor(schema, initialDoc, events): ReplayCursor
```

- `applyUntil` は **前回フレームの sequence から今フレームの sequence までの差分 step のみ**を `step.apply` する。累積 doc を保持するので全体は O(total steps)。
- 既存 `replayEditorSteps` は `createReplayCursor(...).applyUntil(last)` で実装し直してもよい（挙動互換をテストで担保）。

### 5.3 frame producer（新規モジュール `frameProducer.ts`）

```ts
export interface TimelapsePlan {
  schema: Schema;            // ライブ TipTap と同一拡張（authorship mark 解決のため）
  initialDoc: ProseMirrorNode;
  events: ChangeEvent[];     // 単一 entityId に filter 済・sequence ASC
  width: number; height: number;
  fps: number;
  targetDurationSec?: number; // §5.5 圧縮の目標尺
  theme?: EditorRenderTheme;
}
export function buildFrameSchedule(plan): number[]  // frame i → target sequence
export function makeDrawFrame(plan, ctx): (i: number) => boolean
```

- `buildFrameSchedule` が **frame index → target sequence** を返す（§5.5 のケイデンス）。
- `makeDrawFrame` は cursor を保持し、フレーム i で `cursor.applyUntil(schedule[i])` → `renderDocToCanvas(ctx, cursor.doc, w, h, theme)` → 末尾超過で `true`。
- これを `captureCanvasToWebm(canvas, { fps, drawFrame })` に渡すだけ。

> **（2026-06-18 追記）実装シグネチャ**: 出荷版は上記 `TimelapsePlan` 一括 props ではなく分割された:
> - `frameProducer.buildFrameSchedule(events, { fps?, targetDurationSec?, maxIdleMs? }): number[]`（events は `{sequence,timestamp}` のみ要求, idle gap を `maxIdleMs`(既定2000) でクランプ）。
> - `frameProducer.makeDrawFrame({ cursor, ctx, width, height, schedule, theme? })`（単一 entity 用）。
> - プロジェクト全体/複数 entity は `compositeTimelapse.ts` 側が schedule + 複数 cursor を束ね、`exportTimelapse.makeCompositeDrawFrame` がフレーム毎に `pickRenderTarget`→`advanceCursorForTarget`→`renderDocToCanvas`＋`renderChromeOverlay` を呼ぶ。

### 5.4 MediaRecorder は real-time / 非決定的（許容する）

`captureCanvasToWebm` は `canvas.captureStream(fps)` の **ライブ canvas を MediaRecorder が wall-clock でサンプリング**する方式（`videoExport.ts:54,80-86`）。`drawFrame` の呼び出し回数と実際のフレーム数は厳密 1:1 ではない。

- 録画は実時間で進む（600 frame @30fps ≒ 20 秒ブロック）。`drawFrame` 内の処理が frameMs（≒33ms@30fps）を超えると **ドリフト / 重複フレーム / 録画遅延**が起きる。
- → 対策は **「フレーム毎にゼロから replay し直さない」**こと（cursor の delta 前進で根治, §5.2）。`renderDocToCanvas` は `fillText`/`measureText` のテキスト描画のみで frameMs 内に収まるので、**`drawFrame` 内で cursor の現在 doc を都度描画して問題ない**。事前に全フレームを bitmap 化してバッファに溜める必要は **ない**（900 frame × 1280×720×4 ≒ 3GB のメモリ爆発になるため明確に避ける）。保持するのは doc 1個 + canvas 1枚。
- フレーム厳密一致が必要なら別エンコーダ（WebCodecs / ffmpeg.wasm）が要るが **v1 はスコープ外**。「執筆が育つのを眺める」用途では MediaRecorder の実時間サンプリングで十分。

### 5.5 フレームケイデンス（idle 圧縮）

| 方式 | 特徴 | 採否 |
| --- | --- | --- |
| 1 step = 1 frame | 滑らか・決定的。ただし実執筆は step 数が膨大＆休止が長い | △ 短いシーン向け |
| timestamp バケット + idle 圧縮 | 実時間を等間隔バケットに割り当て、長い休止を上限クランプ。目標尺に収める | **◎ 推奨** |

**推奨（採用）**: `targetDurationSec`（**既定 30s**）と `fps`（既定 30 → 総 900 frame）から、`buildFrameSchedule` が timestamp を等間隔バケットに割り、各バケット末尾の sequence を割り当てる。連続 step が無い idle 区間は最小限のフレームに圧縮。長尺プロジェクトでも一定尺（30s）の動画になる。尺はユーザー可変にしてよい（既定 30s）。

---

## 6. スコープと制約（期待値管理）

- **対象ドメイン（本文描画）**: v1 は **editor 本文（+ codex/snippet 本文の doc.step）**を canvas に描く。grid/map/synopsis/beat の視覚状態は本文描画対象外（payload がメタのみ・本文 renderer 無し）。
- **chat/layout は本文ではなく chrome キャプション**（2026-06-18 追記）: chat（追加/削除）・layout（パネル開閉/プリセット）・codex/snippet/map/grid の操作は `formatEventCaption.ts` で下部キャプション帯（`chromeRenderer.renderChromeOverlay`）に合成され、フレーム下端に最大 2 行表示される。本文 doc.step の編集は描画に出るため抑制（`shouldSuppressCaption`）。
- **renderer 忠実度**（2026-06-18 追記）: `editorRenderer` は段落に加え **見出し（em scale + bold）・bullet/ordered リスト（マーカー + インデント・ネスト再帰）・blockquote（左罫 + インデント + italic + muted）**を構造描画する（P2, `renderBlock` `editorRenderer.ts:258-353`）。テーブル/ruby/sceneBeat/圏点は依然スコープ外（canvas 手描きの ROI 判断）で lossy。authorship は `attrs.source` から **AI/unknown ラン背後の背景 tint**として反映（`showAttribution` ゲート, human は無着色, `editorRenderer.ts:92-100`）。テーマ色・エディタフォントは `resolveEditorTheme` でライブテーマ追従。`focusPos` 指定時は直近編集位置を中心にスクロール（`computeScrollOffset`）。
- **mapRenderer は不在**: 本文 map renderer は存在しない。map 操作はキャプション止まり。map/grid 本文タイムラプスは P3+ の別タスク。
- **pagination 無し**: `queryEvents` は全件メモリロード（`queryEvents.ts:20` "fits in memory"）。長大プロジェクトの動画化前に **sequence range のキーセットページング**が必要（`uq_change_events_project_seq` を cursor に）。v1 はシーン単位（`loadSceneChangeEvents`）で件数を抑える。
- **schema drift**: replay は呼び出し側のライブ Schema を使う（`replayEngine.ts:36`）。TipTap 拡張が将来変わると過去 step の `Step.fromJSON` が失敗しうる。長期検証用途なら session ごとに schema version を残す検討（v1 ではログ警告に留める）。

---

## 7. UI / ホスト面設計

> **（2026-06-18 追記）本節（全画面オーバーレイ + 独立 `timelapse` パネル登録）は不採用**。実装は `ExportDialog` の「タイムラプス動画」タブに `TimelapseExportSection` をマウントする形に着地した（§16-1）。`useTimelapseStore`・§7.2 のパネル登録チェックリスト・§7.3 の `TimelapsePlayer` 動画ボタンは出荷経路では使わない。i18n キー（§7.4）は実装で `timelapse.export*` / `scope*` / `pace*` 系に拡張されている。以下は当初設計として残す。

### 7.1 ホストは全画面オーバーレイ（dock パネルではない）

center-bottom dock は最小 120px（`layoutConstants.ts:4`）で timeline/grid/matrix 等と帯を共有し、**16:9 動画プレビューには狭い**。

**推奨**: `RevisionHistoryModal` 方式の全画面オーバーレイ。
- `AnimatedOverlay`（`animated-overlay.tsx:20-60`, document.body へ portal / Escape 閉じ / `fixed inset-0 z-50` 中央）を host に使う。
- 開閉は専用 Zustand `useTimelapseStore().isOpen/open/close`。
- サイズは `RevisionHistoryModal.tsx:459-466` 同様 `h-[80vh] w-[1100px] max-w-[95vw]`。
- マウントは `RevisionHistoryModal` が `SceneEditor.tsx:222/308` に置かれているのに倣い、App/SceneEditor 近傍に一度だけ。

### 7.2 ハイブリッド（推奨）: 起動用ランチャーパネル + オーバーレイ本体

「Panels」ドロップダウンから発見できるよう、**軽量な `timelapse` ランチャーパネルを登録**し、その中の「全画面で再生 / 動画書き出し」ボタンが `useTimelapseStore().open()` を呼ぶ。重い動画面はオーバーレイに置く。

> コンポーネントの責務分担: **ランチャー（`TimelapseLauncherPanel`）は新規作成**（パネル枠に入る小さな起動 UI）。**動画面 = 既存 `TimelapsePlayer` をオーバーレイ内で流用**（§7.3、scrubber/verify はそのまま、動画ボタンを追加）。

#### パネル登録チェックリスト（`timelapse` を Panels メニューに出す最小手順）

> 既存 `TimelapsePlayer.tsx` は実在する（調査リーダー1件の「存在しない」報告は誤り。他4リーダーが読了済み）。下記は **新規 PanelId 登録**の手順。

1. `panelIds.ts` の `PanelId` union に `"timelapse"` を追加（L2-18）。
2. `panelComponents.tsx` `PANEL_COMPONENT_MAP` に `timelapse: TimelapseLauncherPanel` を追加＋import（L23-40, **コンパイル強制**）。
3. `panelRegions.ts` `PANEL_REGION_MAP` に `timelapse: "center-bottom"`（L6-25, **コンパイル強制**）。
4. `panelIcons.ts` `PANEL_ICON_MAP` に `timelapse: Film`（等の Lucide）＋import（L26-42, **コンパイル強制**）。
5. `toolWindowDefaults.ts` `DEFAULT_SLOT_MAP` に `timelapse: "BL"`（L39-58, **コンパイル強制**。region/index/TOOL_WINDOW_PANEL_IDS は自動導出）。
6. `panelRegions.ts` `TOGGLEABLE_PANELS` に `"timelapse"` 追加（L47-66, **型非強制だがメニュー表示に必須**）。
7. `en.json` / `ja.json` の `layout.panel` ブロックに `"timelapse"` ラベル追加（en L502-520 / ja 同位置, 未追加だと生キー表示）。
8. （任意）`App.tsx` keyMap にショートカット（L391-405, 例 `p: "timelapse"`）。空きレターは少ない（`p` が候補）。

> パネルは props 無し `FunctionComponent`。レイアウトは store/provider を注入しない（`MapPanel` が自前で `ReactFlowProvider` を抱える先例, `MapPanel.tsx:4-16`）。**`TimelapsePlayer`/ランチャーは必要な store を自己マウント**する。`layoutInvariants.browser.test.tsx` は `PANEL_COMPONENT_MAP` を Proxy mock するので **テスト stub 追加は不要**。

### 7.3 既存 `TimelapsePlayer` への動画ボタン配置

P5 プレイヤーをオーバーレイ内に流用する場合、ヘッダのアクション群（`TimelapsePlayer.tsx:98` の `flex items-center gap-1`、Verify/Refresh の隣）に「動画書き出し」ボタンを追加。既存アクションには testid が無いので、新ボタンに `data-testid="timelapse-export-video"` を付与。

### 7.4 i18n

既存 9 キー（`timelapse.title/refresh/verify/verifyTitle/verifyOk/verifyBroken/scrub/scrubHint/noEvents`）は en（`en.json:2103-2113`）/ ja（`ja.json:2112-2122`）で対。新規キー（例 `timelapse.exportVideo`, `exportingFrame`, `exportDone`, `videoUnsupported`, `forwardOnlyHint`）は **両ロケールに同時追加**。

---

## 8. 保存（save-to-disk）配線

> **（2026-06-18 追記）実装は Rust 側 save ダイアログ**。下記の JS `save()`+`writeFile()` 直叩き案ではなく、security audit PIO-2 に従い `saveWebmBlob`（`exportTimelapse.ts:205`）は `@/lib/exportFile` の `saveBinaryFile(filename, { name:"WebM", extensions:["webm"] }, bytes, "video/webm")` を呼ぶ（保存ダイアログは Rust、キャンセルは null）。以下の当初案は履歴として残す。

WebM Blob の保存は **`saveZipBlob`（`ZipExportDialog.tsx:21-46`）と同型のバイナリ版**を新設。バイナリ writeFile は `useMapExport.ts:49-59`（PNG）が先例。

```ts
async function saveWebmBlob(blob: Blob, filename: string): Promise<boolean> {
  if ("__TAURI_INTERNALS__" in window) {
    const path = await save({ defaultPath: filename, filters: [{ name: "WebM", extensions: ["webm"] }] });
    if (!path) return false;
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    return true;
  }
  // browser fallback: createObjectURL + a.download + a.click + revokeObjectURL
}
```

- zip 検証パッケージ（§9）の保存は `saveZipBlob` をそのまま再利用（`buildAuthorshipExportZip` は `Uint8Array` を返すので互換）。

---

## 9. 検証可能エクスポート（任意・後続）

「誰がどこを書いたか」を改ざん検証可能な形で配布する経路。`zipExport` は `authorship-report.html` + `.json` + `chain.json` + `verify.html` を **STORE（`level:0`）zip** で束ねる（`zipExport.ts:64-76`）。`verify.html` の内蔵 ZIP リーダは method===0 前提なので **圧縮を有効にしない**こと。

- v1 ではこの zip 経路は動画と独立に「ボタン1つで出せる」状態にできる（save 配線は `saveZipBlob` 既済）。
- 発展: 生成 WebM を chain にバインド（chain head hash + 対象 sequence range + frame 入力の content hash を export パッケージに同梱）。現状 hash chain は **イベントログのみ**を保証し動画とは無関係（`hashChain.ts:139-176`）。

---

## 10. プラットフォーム / CSP

- **VP9 WebM 録画**は3 OSとも Electron Chromium の `MediaRecorder` を使う。ただし配布物ごとの codec 可否はユニットテスト（`MediaRecorderCtor` stub）で検出できないため、Windows / macOS / Linux の署名済み package で実機確認する。
  - 対策: `MediaRecorder.isTypeSupported('video/webm;codecs=vp9')` を feature-detect → 非対応なら mime フォールバック列（`video/webm;codecs=vp8` → `video/webm`）を試し、全滅ならボタンを無効化＋`videoUnsupported` を表示。
- **CSP に `media-src` 無し**（`electron/main/protocol.ts`）→ media は `default-src 'self'` にフォールバック。**`blob:` の `<video>` プレビューは現状ブロックされる**。アプリ内で録画結果をプレビューしたいなら CSP に `media-src 'self' blob:` を追加。保存（main processのsave handler）はプレビュー不要なので CSP 変更なしで可。
- sandbox egress とは無関係（ローカル生成のみ）。[[grimodex-sandbox-egress-firewall]] / [[grimodex-csp-ipc-fallback]] の方針に矛盾しないこと。

---

## 11. 実装フェーズ分解（P7.x）

> （2026-06-18 追記）P7.1〜P7.9 は出荷済み。ただし P7.4（ホスト UI）は `useTimelapseStore`/`AnimatedOverlay` ではなく ExportDialog タブ（`TimelapseExportSection`）に着地、P7.5（独立パネル登録）は不採用（§16-1）。実装乖離の正本は §16。以下は当初計画として残す。

| サブフェーズ | 内容 | 依存 | 規模感 |
| --- | --- | --- | --- |
| **P7.1** | `replayEngine` に incremental cursor 追加（§5.2）+ ユニットテスト（既存一括 API と挙動一致） | なし | 小〜中 |
| **P7.2** | `frameProducer.ts`（schedule + makeDrawFrame, §5.3/5.5）+ ユニットテスト（mock ctx） | P7.1 | 中 |
| **P7.3** | `saveWebmBlob`（§8）+ オフスクリーン canvas 配線 + `captureCanvasToWebm` 結線 | P7.2 | 小 |
| **P7.4** | ホスト UI（`useTimelapseStore` + `AnimatedOverlay` + 動画ボタン, §7）+ i18n | P7.3 | 中 |
| **P7.5** | パネル登録（§7.2 チェックリスト） | P7.4 | 小 |
| **P7.6** | feature-detect / フォールバック / 非対応 UI（§10） | P7.3 | 小 |
| **P7.7** | snapshot encoding 整合の修正 + replay seek（`loadLatestSnapshot`）配線（§4.5）。**baseline の焼き込み本体は §15.6（P7.9）にあるので二重実装しない** | P7.9 と連動 | 小〜中 |
| **P7.9** | 記録 ON/OFF 制御（作成時チェックボックス + Settings トグル + OFF→ON wipe + baseline）（§15、チェックリスト §15.9） | KV 保存・migration 不要 | 中 |
| P7.8（任意） | 検証可能 zip 配線（§9）/ 動画-chain バインド | 独立 | 中 |

**MVP（最短で動くもの）= P7.1 → P7.2 → P7.3 → P7.4**。対象は「記録稼働後に空から書いた新規シーン」。
**v1 完成形 = MVP + P7.5（パネル）+ P7.6（feature-detect）+ P7.7（baseline）+ P7.9（ON/OFF 制御）**。記録 ON/OFF と baseline は §15 の設計に従う。

---

## 12. テスト方針

- **ユニット（happy-dom）**: `replayCursor`（差分適用の正しさ・一括 API 互換）、`buildFrameSchedule`（idle 圧縮・目標尺）、`makeDrawFrame`（mock 2D ctx, `editorRenderer.test.ts` のパターン流用）。`captureCanvasToWebm` は `MediaRecorderCtor` 注入で stub（`videoExport.test.ts` 既存）。
- **ブラウザテスト（`*.browser.test.tsx`）**: オーバーレイの実寸・canvas のレイアウトが絡むなら必須（happy-dom は flex/grid 実寸を測れない, CLAUDE.md テスト方針）。
- **実機手動**: macOS / Linux で VP9 録画可否（§10）。`MANUAL_TEST_CHECKLIST.md` に項目追加。
- **回帰**: `TimelapsePlayer.test.tsx` の testid 契約（scrubber, `timelapse-filter-*`）を壊さない。新規 `timelapse-export-video` を追加。

---

## 13. 決定事項 / 未決事項

### 決定済み（2026-05-29）

- **目標尺デフォルト = 30s**（ユーザー可変可、§5.5）。
- **対象選択 = シーン単位 / プロジェクト全体**（2026-06-18 追記）。当初「全体合成は将来（compositor 未存在）」としていたが、`compositeTimelapse.ts` の compositor が出荷され `produceSceneTimelapseWebm` / `produceProjectTimelapseWebm` の両 scope を `TimelapseExportSection` で選べる（`exportTimelapse.ts:151,178`）。プロジェクト全体は複数 entity の cursor を持ち、フレーム毎に `pickRenderTarget`（最後に編集された entity）の doc を描画する。
- **baseline 一回焼きを v1 に含める**（§4.5-3 / §15 の記録 ON 時に焼く）。
- **記録の ON/OFF をユーザー制御にする**（§15）。Project 作成時チェックボックス + Settings トグル。OFF→ON で既存履歴を wipe。
- **既定値 = ON**（`timelapse.enabled` 既定 `'true'`）。現行の always-on 挙動を保ち、設定行の無い既存プロジェクトも default-on で継続（連続性を壊さない）。作成チェックボックスも初期チェック済み。— ※ opt-in（既定 OFF）にしたい場合のみ要相談。
- **記録データ量は許容**（1 プロジェクトで GB 級に達しなければ可。長編一冊で数十 MB レンジ、§付録 B）。ただし **手動パージ（履歴クリア）を first-class 機能として追加**（§15.10、wipe primitive 再利用でほぼ追加コスト無し）。**自動 retention/プルーニングは当面実装しない**（必要になれば §15.10 の将来枠）。

### 未決（Open Questions）

1. **解像度 / bitrate** をユーザー設定にするか（`ZipExportSettings` 相当の型を新設するか）。当面は固定既定（例 1280×720 / browser 既定 bitrate）で可。
2. **進捗 UI**: 録画は実時間ブロック（§5.4）。`ZipExportDialog`（L78-95）の progress 文字列パターンを流用するか。
3. **検証可能エクスポート**（§9）を動画と同じ UI に同居させるか、別ボタンか。
4. 記録 ON 時の baseline 一括焼きの**対象範囲**: 全シーン一括か、初回 replay 要求時に lazy で焼くか（§15 で詰める）。

---

## 14. リスク

| リスク | 影響 | 緩和 |
| --- | --- | --- |
| 既存原稿の過去執筆を遡及できない（§4.2） | ユーザー期待とのギャップ | UI コピーで forward-looking を明示。baseline 焼き案内 |
| macOS/Linux で WebM 録画不可（§10） | 機能が一部 OS で無効 | feature-detect + フォールバック + 無効化 UI。実機検証必須 |
| 長大プロジェクトの全件メモリロード（§6） | メモリ / 録画時間 | シーン単位・idle 圧縮・目標尺クランプ。将来 keyset ページング |
| naive per-frame replay の O(n²)（§5.2） | 録画前処理が激遅 | incremental cursor（P7.1）で根治 |
| snapshot encoding 不整合（§4.5-2） | 復号失敗 | encoding カラムを正に。読み側分岐 |
| renderer の lossy 表示（§6） | 見出し/リストが段落扱い | v1 は editor プレーン text と割り切り。期待値明示 |
| schema drift で過去 step 失敗（§6） | 古いシーンが replay 不能 | ログ警告。将来 schema version 保存 |
| OFF→ON の wipe で過去記録を喪失（§15.6） | 意図せぬ履歴消去 | 仕様（連続性契約 §15.1）。UI で破棄を明示警告 |
| wipe が非アトミック（2 回の DELETE, §15.8） | クラッシュ時に部分 wipe | 許容。必要なら単一 Tauri command 化 |
| 再有効化時の chain head 取り残し（§15.5） | 連続性契約違反（seq 非リセット / phantom 先頭 prevHash）。verifyChain 自体は通る（中） | `resetRecorderChain()` を唯一の再有効化経路に（実装済み B1） |

---

## 15. 記録の ON/OFF 制御（per-project トグル + wipe-on-enable）

ユーザーが**プロジェクト単位**でタイムラプス記録を ON/OFF できるようにする。現状 `loadProject` が無条件に `setRecorderEnabled(true)` を呼ぶ（`projectStore.ts:94-101`）だけで、永続フラグも UI も無い（**net-new**）。

### 15.1 連続性契約（この設計の前提）

タイムラプス記録は **hash chain による連続・完全なログ**であることに意味がある。途中で OFF にして穴が空いた記録は信頼性を失う（一部分を OFF にできると記録の意味をなさない）。よって:

- **ON→OFF**: 記録を止めるだけ。既存の連続履歴は保持（後で見られる）。**wipe しない**。
- **OFF→ON（再有効化）**: 過去にギャップが生じている前提なので、**既存の `change_events` + `state_snapshots` を全 wipe して genesis から録り直す**。再有効化時に現在の各シーン doc を baseline として焼く（§4.5 / §15.6）。

> UI コピーで「再開すると、このプロジェクトの既存タイムラプス履歴は破棄されます」と明示警告する。

### 15.2 永続ストレージ = project_settings KV（migration 不要）

- キー `timelapse.enabled`（`'true'`/`'false'`）を **`project_settings` KV テーブル**（`schema.ts:761`）に保存。**新規カラム不要 = blast-radius 最小**。`projects` テーブルへの列追加（migration `migrate.rs:add_column_if_missing`）は採らない。
- **既定値 = `'true'`（全経路で統一）**（§13）。2 つの読み取り経路が**必ず一致して default-on** になるようにする:
  - **loadProject ゲート**: `getProjectSetting` を raw に読む → 設定行が無ければ `null` → `!== 'false'` 判定で **on**（§15.5）。
  - **Settings UI / store**: `DEFAULT_SETTINGS['timelapse.enabled'] = 'true'`（§15.3-2）を介して **on**。
  - ⚠️ ここを `'false'` にすると、loadProject は on なのに UI は OFF 表示という状態不整合になり、store 経路では全プロジェクトが既定 OFF になる。**両方とも `'true'`**。

### 15.3 Settings トグル（既存インフラに乗せる）

per-project settings 基盤は既存。先例は `beat.inferRoles`（project-scoped boolean）。

1. `settings/types.ts` `KEY_SCOPE`（L51）に `'timelapse.enabled': 'project'` を追加。**これがないと UI 上は動くが値が global の `app_settings` に書かれる**（`trashBin.enabled` が踏んでいる罠, `ProjectCategory.tsx:41` / `settingsStore.ts:30`）。
2. `settings/types.ts` `DEFAULT_SETTINGS`（L145）に `'timelapse.enabled': 'true'` を追加。**`settingsStore.test.ts:19-24` が「全 DEFAULT_SETTINGS キーに KEY_SCOPE エントリ必須」を gate するので両方必須**。
3. `settings/categories/ProjectCategory.tsx` に行追加（**UI primitive は §15.3-6 の通り `ControlledToggle`。auto-persist する `SettingToggle` は使わない**）。表示は `useSettingBoolean('timelapse.enabled', true)` で現在値を読み、変更はハンドラ経由（下記 6）。
4. `locales/ja.json` / `en.json` の `settings.project.*` に `timelapse` / `timelapseDesc` ラベル追加（inline fallback も可だが正規キーは両ロケールへ）。
5. `settingsStore.test.ts:57-75`「work-specific keys are per-project」のリストに `'timelapse.enabled'` を追加して scope を lock。
6. **【必須】トグルは必ず §15.6 のオーケストレーターを経由する**。wipe/reset/baseline を伴うため、store に直書きする `SettingToggle`（auto-persist 経路）は **失格**。これを使うと OFF→ON が単に `'true'` を書くだけで **wipe/reset/baseline が走らず**、ユーザーが防ぎたかった「ギャップのある無意味な記録」をそのまま生み（baseline も焼かれない）、かつ設定が二重書きされる。正しくは **非永続の `ControlledToggle`（`SettingToggle.tsx:42`）** を使い、その onChange ハンドラが `setTimelapseEnabled(projectId, next)`（§15.6）**唯一の writer** として呼ぶ。`setProjectSetting` はオーケストレーター内の 1 箇所のみが書く。

### 15.4 Project 作成時チェックボックス

`seedProjectSettingsFromDefaults` は **global projectDefaults からのシード**であってフォーム入力を拾わない（`settings/migration.ts:111`）。よって作成フォームの値は**明示的に書く**必要がある。

1. `CreateProjectDialog.tsx`: `CreateProjectFormData`（L7-13）に `timelapseEnabled: boolean` 追加 + `useState`（L51-61）+ open 時 reset（L63-72）。言語 `<select>`（L184 後）と seed ブロック（L186）の間にチェックボックス追加（既存 checkbox スタイル L228-233 を流用）。初期値 `true`。`onCreate({...})`（L103-110）に含める。
2. `ProjectMenu.tsx` `handleCreate`（L61-81）: data 型に追加し `createNewProject({...})`（L69-75）へ渡す。
3. `projectStore.ts` `CreateProjectInput`（L13-21）に `timelapseEnabled?: boolean` 追加。
4. `projectStore.ts` `createNewProject`（L110-141）の try 内（`seedProjectSettingsFromDefaults` 近傍 L121-123）で `await setProjectSetting(created.id, 'timelapse.enabled', String(input.timelapseEnabled ?? true))`（`settings/api.ts:52` を import）。これが default-seeding では拾えない per-creation 値の明示書き込み。

### 15.5 recorder ライフサイクルの整流化 + 【重大トラップ】

recorder の `enabled` は **global per-tab**（`recorder.ts:9-11`）。Tauri は単一ウィンドウ＝同時に 1 プロジェクトなので「global フラグは常に現在プロジェクトの永続設定を反映する」を不変条件にする。

**`loadProject` の整流化**（`projectStore.ts:94-102`）:
- 無条件 `setRecorderEnabled(true)` を廃し、`getProjectSetting(projectId, 'timelapse.enabled')`（既定 `'true'`、`!== 'false'` で判定）を読んで `setRecorderEnabled(enabled)`。**enabled のときだけ** `initRecorderForProject` を呼ぶ。window/VITEST ガードと dynamic import は維持。
- 順序不変: `setRecorderEnabled(true)` は `initRecorderForProject` より**前**（disabled だと init が tail を読まず projectId だけ設定して early-return, `recorder.ts:101-104`）。

**【トラップ（深刻度 中）】再有効化での chain head 取り残し**: `initRecorderForProject` は同一 projectId の冪等ガード（`recorder.ts:105-107`）で **stale な initPromise を返す**。ON→OFF（`enabled` だけ false、`projectId`/`initPromise`/`lastSequence=42`/`lastHash=oldHead` は残る）→ DB wipe →`initRecorderForProject(samePid)` を呼んでも guard で短絡し tail SELECT を再実行せず、次の flush が **seq 43 / prevHash=old-head を空テーブルに書き込む**。

> 当初「`verifyChain` 破綻」と書いたが**不正確**。`verifyChain`（hashChain.ts:135-137）は先頭イベントの prevHash を genesis 照合せず**そのまま受理**するため、この記録でも検証自体は通ってしまう。実害は「sequence が 1 に戻らない / 新 chain の先頭 prevHash が削除済みイベントを指す phantom になる」という**連続性契約の意味論的不整合**。`resetRecorderChain` はクリーンな genesis 再開のため依然必須だが深刻度は「中」。

→ **production 用リセット primitive を新設**（`_resetRecorderForTests` は `enabled`/`projectId`/`sessionId` まで消すので不可）:

```ts
// recorder.ts に追加（production API）
export function resetRecorderChain(): void {
  state.lastSequence = 0;
  state.lastHash = GENESIS_HASH;
  state.queue = [];
  state.initPromise = null;          // ← guard を素通りさせ、空 tail から genesis を再確認
  if (state.flushTimer) { clearTimeout(state.flushTimer); state.flushTimer = null; }
  // enabled / projectId / sessionId は触らない
}
```

`resetRecorderChain` を**唯一の再有効化経路**にする（直接 `setRecorderEnabled(true)` を別経路で呼ぶと同じ hazard が再発, §15.8）。

### 15.6 OFF→ON シーケンス（オーケストレーター `timelapse/toggle.ts`）

recorder.ts を tree/api・settings/api 依存から守るため、wipe + baseline + 永続化を握る薄いモジュール `src/features/timelapse/toggle.ts` を新設し `setTimelapseEnabled(projectId, enabled)` を公開する。

OFF→ON（`enabled === true`）:
1. `await flushNow()` + timer クリア（防御的。OFF 中は queue 空のはず）
2. `await db.delete(changeEvents).where(eq(changeEvents.projectId, projectId))`
3. `await db.delete(stateSnapshots).where(eq(stateSnapshots.projectId, projectId))`
4. `resetRecorderChain()`（§15.5）
5. `setRecorderEnabled(true)`（`recorder.ts:86`）
6. `await initRecorderForProject(projectId)`（空 tail → genesis 確認, `recorder.ts:126-129`）
7. **baseline 焼き**: `listAllNodes(projectId)`（`tree/api.ts:70`）から `nodeType==='scene'` を抽出し、各シーンで `loadSceneContent(id)`（`tree/api.ts:201`, PM JSON）を読み `recordStateSnapshot({ projectId, domain:'editor', entityType:'scene', entityId: sceneId, anchorSequence: 0, anchorTimestamp, payload })`（`snapshots.ts:32`）。`anchorSequence=0`（= seq<=0 適用後の状態 = genesis 起点 doc）。
8. `await setProjectSetting(projectId, 'timelapse.enabled', 'true')`

### 15.7 ON→OFF シーケンス

ON→OFF（`enabled === false`）:
1. `await flushNow()`（`recorder.ts:184`、末尾まで確定）
2. `setRecorderEnabled(false)`（`recorder.ts:86`）
3. `await setProjectSetting(projectId, 'timelapse.enabled', 'false')`

**wipe しない**（無効化は既存の連続履歴を保持。wipe は再有効化時のみ §15.1）。

### 15.8 注意点・割り切り

- **wipe 非アトミック**: `db.delete` 2 回は別々の sqlite-proxy invoke（`client.ts:9`、トランザクション無し）。クラッシュ時に部分 wipe の可能性。許容するが、厳密性が要れば単一 Tauri command 化。
- **baseline 部分失敗**: scene ループ中 `recordStateSnapshot` が throw すると一部シーンに baseline が付かない（replay seek が劣化するが chain は壊れない）。**best-effort（per-scene エラーは継続）**を推奨。
- **codex/snippet の baseline は後続**: `replayEngine` は codex/snippet も body 扱い（`replayEngine.ts:87-89`）だが v1 baseline は scene のみ。未焼の codex/snippet は post-enable 編集が空 doc から replay される。今は拡げず flag に留める。
- **再有効化経路の一本化**: `resetRecorderChain` を通さない `setRecorderEnabled(true)` 直呼びは §15.5 の hazard を再発させる。`toggle.ts` を唯一の経路に。
- **テスト**: `recorder.test.ts` に「wipe 後、同一 projectId で seq 1 / prevHash=GENESIS から再開」を追加（`:105-107` stale-promise 回帰の gate）。`projectStore.test.ts` は full-suite でのみ flaky（[[grimodex-projectstore-test-flaky]]）、単体で検証。

### 15.9 実装チェックリスト（P7.9）

| # | ファイル | 編集 |
| --- | --- | --- |
| 1 | `timelapse/recorder.ts` | `resetRecorderChain()` 追加（§15.5） |
| 2 | `timelapse/toggle.ts`（新規） | `setTimelapseEnabled(projectId, enabled)`（§15.6/15.7） |
| 3 | `project/projectStore.ts:94-102` | 設定を読んで条件付き enable（§15.5）/ `CreateProjectInput` + `createNewProject` で `setProjectSetting`（§15.4-3,4） |
| 4 | `project/CreateProjectDialog.tsx` | チェックボックス追加（§15.4-1） |
| 5 | `project/ProjectMenu.tsx:61-81` | `handleCreate` で flag 伝搬（§15.4-2） |
| 6 | `settings/types.ts` | `KEY_SCOPE` + `DEFAULT_SETTINGS` に `timelapse.enabled`（§15.3-1,2） |
| 7 | `settings/categories/ProjectCategory.tsx` | トグル行 + wipe ハンドラ配線（§15.3-3,6） |
| 8 | `locales/ja.json` / `en.json` | `settings.project.timelapse*` ラベル（§15.3-4） |
| 9 | `settings/settingsStore.test.ts` / `timelapse/recorder.test.ts` | scope lock + wipe 回帰テスト（§15.3-5 / §15.8） |
| 10 | `timelapse/toggle.ts` + Settings/Player UI | `purgeTimelapseHistory(projectId)` + パージボタン（§15.10） |

---

## 15.10 パージ（履歴クリア）

記録データが肥大化したとき、ユーザーが明示的に**そのプロジェクトのタイムラプス履歴を全消去**できる first-class アクション。OFF→ON の wipe（§15.6）と**同じ primitive を再利用**するため追加コストは小さい。

### 配置
- Settings の per-project トグル（§15.3）の隣に「タイムラプス履歴をクリア」ボタン、または将来の TimelapsePlayer ヘッダ（§7.3）に置く。**破壊的操作なので確認ダイアログ必須**（「このプロジェクトのタイムラプス記録（{n} 件）を完全に削除します。元に戻せません」）。

### `timelapse/toggle.ts` に `purgeTimelapseHistory(projectId)` を追加
現在の記録状態で挙動が変わる（`getProjectSetting('timelapse.enabled')` で判定）:

- **記録 ON 中のパージ = 「捨てて録り直す」**: `await flushNow()` → `db.delete(changeEvents/stateSnapshots).where(eq(.projectId, projectId))` → `resetRecorderChain()`（§15.5）→ `await initRecorderForProject(projectId)`（genesis 再確認）→ **再 baseline 焼き**（§15.6-7）。記録は止めずに genesis から継続。
- **記録 OFF 中のパージ = 単純消去**: `await flushNow()`（防御）→ 上記 2 つの `db.delete` のみ。`resetRecorderChain()` は呼んでおくと次回 ON 時の chain head 取り残し（§15.5 トラップ）を確実に防げる。再 baseline は不要（録っていないため）。

> 実体は §15.6 の手順 1〜7 とほぼ同一。OFF→ON wipe との違いは「`timelapse.enabled` を変更しない」点だけ。よって `toggle.ts` 内で wipe 部分を共通ヘルパに切り出し、`setTimelapseEnabled` と `purgeTimelapseHistory` の両方から呼ぶ。

### 非機能・注意
- wipe 非アトミック（§15.8）・baseline 部分失敗（§15.8 best-effort）はパージでも同様。
- パージ件数表示用に `SELECT count(*) FROM change_events WHERE projectId=?` を確認ダイアログで使う（軽量、index `uq_change_events_project_seq` あり）。

### 将来枠（今は実装しない）
- **自動 retention**: サイズ上限 / 期間上限（例: 古い側から間引き）。ただし**間引きは hash chain の連続性を壊す**（prevHash リンクが切れ verifyChain が破綻）ので、単純削除ではなく「古い区間を 1 つの baseline snapshot に畳んで chain を genesis から張り直す」compaction が必要 → 非自明。リビジョン履歴の 50 件プルーニング（チェーン無し）とは別物。現状の判断（§13）は「容量許容 + 手動パージ」で、自動 retention は保留。

---

## 16. 実装メモ（P7 v1、設計からの乖離）

実装時に判明した事実に基づく設計からの差分。

1. **save-only / AnimatedOverlay 不採用 / 着地は ExportDialog タブ**: v1 はアプリ内プレビュー無し（§13 決定）のため大きな動画面が不要 → overlay は使わず、エクスポート UI を **`ExportDialog` の「タイムラプス動画」タブにマウント**（`TimelapseExportSection.tsx` を `ExportDialog.tsx:493` でホスト）。`useTimelapseStore` も独立パネル登録（§7.2 のチェックリスト）も不要だった（既存のエクスポートダイアログに同居）。タブ内で scope（現在のシーン / プロジェクト全体）・尺（15/30/60s）・テンポ（fast/standard/slow → `maxIdleMs`）を選び、自前の書き出しボタン（`data-testid="timelapse-export-video"`）で WebM を保存する。— ※ 旧 §7.x（全画面オーバーレイ + 独立パネル登録）は不採用。
2. **settings store バイパス（重要）**: `useSettingsStore` は固定 `PROJECT_ID = "default-project"` に束縛され（`settingsStore.ts:28/43`）、recorder が使う実 `currentProjectId` と一致しない。`change_events` は実 projectId で書かれるため、`timelapse.enabled` は **settings store を経由せず `getProjectSetting`/`setProjectSetting` を実 projectId で直接読み書き**（B3 `toggle.ts` / B4 `loadProject` / B5 作成 / B6 `TimelapseSettings`）。`KEY_SCOPE`/`DEFAULT_SETTINGS` 登録（B2）は scope ドキュメント + テスト不変条件として保持。Settings トグルは **`ControlledToggle`（auto-persist する `SettingToggle` は失格）**。
3. **frame schedule**: clamped-timestamp（既定 `maxIdle=2000ms`）で idle 圧縮し 30s/30fps にサンプル（§5.5 通り、`frameProducer.ts`）。
4. **replay 起点**: baseline snapshot があれば seed、無ければ空 doc（`buildReplayStart`、C1）。baseline は記録 ON 時に scene ごと anchorSequence=0 で焼く（`toggle.ts`）。
5. **VP9 feature-detect**: `pickSupportedWebmMime`（vp9→vp8→webm）で対応 mime を選び、null ならパネルのボタンを無効化（A6）。
6. **コミット**: A1→A6 / B1→B6 / C1 を green-build 単位で master 直 commit（`replayEngine`/`recorder`/`settings`/`toggle`/`frameProducer`/`exportTimelapse`/`videoExport`/`TimelapsePanel` ほか）。Electron移行後は3 OSの Chromium package で VP9 録画可否を MANUAL_TEST_CHECKLIST に沿って確認する。
7. **【実機バグ修正】blob → hex/JSON TEXT 化**（commit 70687944）: recorder/snapshots は当初 `blob(mode:'buffer')` + `Buffer.from` を使っていたが、**webview に `Buffer` が無く（Node グローバル）、かつ drizzle sqlite-proxy 経由では BLOB が round-trip できない**（Rust の param 変換は文字列化のみ・BLOB 読み出しは `[blob N bytes]` プレースホルダ。embeddings だけ専用 Rust command で別経路）。結果 `recorder.flush` が `ReferenceError: Buffer is not defined` で全失敗し、**change_events が一度も書かれていなかった**（記録基盤が本番未動作だった）。修正: `change_events.prevHash/hash` を **hex TEXT**、`state_snapshots.payload` を **plain JSON TEXT**（gzip 廃止）に変更。インメモリのハッシュ計算は Uint8Array のまま、DB 境界のみ `bytesToHex`/`hexToBytes`。SQLite BLOB affinity 列は TEXT 値をそのまま保持するため migration 不要。ユニットは db をモックするため本バグを検出できなかった（修正後も同様 → 実機確認が必須）。

---

## 17. P0 記録スキーマ設計 — 軸C(会話フロー)とUI動作の forward-only 記録

> **（2026-06-18 追記）実装済み**。本節は当初「記録フックだけ先に入れる（描画 consumer は P5 で別実装）」という設計だったが、記録フック・P5 consumer の両方が出荷された。実装対応:
> - 記録フック: `captureChat.ts`（`recordChatMessageAdd`/`recordChatMessageDelete`/`recordChatMessagesDeleteFrom`、`chatApi.ts:547/561/576` で配線）・`captureLayout.ts`（`recordLayoutSnapshot`、`layoutStore.ts:397`）・`seedSession.ts`（`seedWorkspaceSnapshot`、`projectStore.loadProject:147` と `toggle.ts:151` で配線）。
> - 描画 consumer: `compositeTimelapse.ts` が chat/layout イベントを `formatEventCaption.ts` で下部キャプションに合成し、`chromeRenderer.renderChromeOverlay` で各フレーム下端に描画（§6）。
> - opType は実装で `chat.message.add` / `chat.message.delete` / `chat.message.deleteFrom` を採用（下表の `regenerate`/`edit` は delete+add の 2 イベントに収斂）。
> 以下の設計記述（payload 形・配置規約・連続性整合）は実装と概ね一致するため残すが、「記録がまだ無い / 描画は将来」という前提語は stale。

### 17.0 前提と本節の境界

P5 描画より前に「記録フックだけ」を入れ、今日からデータ蓄積を始める設計だった（現在は両方出荷済み、上の追記参照）。対象は当時 change_events に一切記録がなかった 2 種:

- 軸C-1 AIチャットの会話フロー(add / delete / regenerate / edit)
- 軸C-2 パネル・レイアウト・activeScene・focus の動き

いずれも forward-only(記録開始後の分しか取れない)で、記録漏れは過去分が永久欠落する。よって「何を・どの粒度で・どんな payload で」を P0 で確定し、後で直せない決定(本文焼き込み・delete 別建て・seed 経路)をすべて入れた。描画 consumer は `compositeTimelapse.ts` で実装済み(`replayEngine` 自体は `opType==='doc.step'` のみ処理 — replayEngine.ts:10-12、chat/layout は本文 replay ではなくキャプション経路)。

### 17.1 前段必須 — Domain union 拡張(これ無しでは全フックが型で空振りする)

`recorder.ts:27-34` の `Domain` union と `queryEvents.ts:5-12` の `Domain` は `editor|codex|snippet|grid|map|synopsis|beat` で、`'chat'`/`'layout'` を持たない。`RecordEventInput.domain` は `Domain` 型固定(recorder.ts:36-37)、strict TS なので呼び出し側がコンパイルできない。

P0 でまず両所に `'chat'` `'layout'` を追加し、`schema.ts:1522` の `domain` コメント(列は enum でなく TEXT。migration 不要)を追記する。`hashChain` は `domain` を不透明 TEXT として正規化 body に含む(hashChain.ts:60)ため新ドメイン追加に支障なし。これは記録フックの前段で、最初に着手する。

### 17.2 chat の payload は本文を inline 焼き込み(参照 id only は lossy — 後で直せない)

`chat_messages` は mutable で破壊的に削除される:

- `deleteMessage` は物理削除 `db.delete(chatMessages).where(eq(id))`(chatApi.ts:452-454)。soft-delete ではない。
- `regenerate` は assistant message を `deleteMessage` 物理削除してから再 insert(chatStore.ts:3134-3142 付近)。
- `deleteMessagesFrom` も createdAt 範囲の物理削除(chatApi.ts:456-468)。

したがって `change_events` に `messageId` 参照だけを残すと、edit/regenerate/delete 後に join 先が dangling し replay 不能になる。**`role`/`text`/`sessionId` を append-only な `change_events.payload` へ snapshot として焼き込む。`messageId` は照合用に併記するが join 必須にしない。**

### 17.3 opType をイベント種別で分ける(snapshot だけにせず「動き」を別建て記録)

軸Cは「会話フロー」の忠実再現であり、メッセージが消える/差し替わる動き自体が再現対象。add 時に本文を焼くだけでは「いつ・どれが消えたか」が記録されず、削除・再生成の演出を timestamp 順に表現できない。delete 系も独立イベントとして append する(forward-only — 今入れないと過去分の削除イベントは永久欠落)。

| opType | payload(JSON TEXT) | 記録点 |
| --- | --- | --- |
| `chat.message.add` | `{ sessionId, messageId, role, text, model?, createdAt(ISO) }` | `chatApi.addMessage` 成功後(chatApi.ts:444-449) |
| `chat.message.delete` | `{ sessionId, messageId }` | `chatApi.deleteMessage`(chatApi.ts:452-454)・`deleteMessagesFrom`(chatApi.ts:456-468) |
| `chat.message.regenerate` | `{ sessionId, oldMessageId }`(または delete→add の 2 イベント) | `chatStore.regenerate`(chatStore.ts:3134-3142 付近) |
| `chat.message.edit`(任意) | `{ sessionId, messageId, text }` | `editUserMessage`(chatStore.ts:454 付近) |

**timestamp 衝突の回避(fix 反映):** user turn と assistant が同一 epoch に潰れると会話のリズムが失われる。`chat.message.add` の timestamp は recorder の per-event 現在時刻(recorder.ts:194)に委ねるので、**user turn は send/optimistic push 地点で 1 件、assistant は完了 add 地点で 1 件**、それぞれ実発生時刻で個別に記録する(まとめて 1 epoch で打たない)。`tokensIn/tokensOut` 等の冗長フィールドは volume 抑制のため payload から外す。

**streaming(fix 明示):** `addMessage` は完了後 1 回の insert(chatApi.ts:428-442)。**P0 では delta を記録しない(完了時 `chat.message.add` の snapshot のみ)** と明示する。打鍵感が欲しくなったら append-only なので後方互換で `chat.message.stream` を足せる。

### 17.4 layout は diff にせず自己完結 full snapshot(ただし発火粒度を contract 化)

diff 復元は baseline からの fold consumer を新規に要し、forward-only + toggle 時 GENESIS wipe + flush 取りこぼし(recorder.ts:270 で再 queue するがタブ閉じで queue 内は消える)のいずれか 1 件欠落で以降全ズレ。**毎イベント `LayoutState` 全体を載せる自己完結 snapshot はこれに免疫。** `LayoutState`(layoutTypes.ts:56-69)は region×3 + 小 slot 配列 + 数 segment + panel-id 文字列配列の有界構造で JSON は通常 1KB 未満、recorder.ts:42 の「<~4KB typical」に収まる。

**volume 爆発の真因は snapshot サイズでなくフック位置(fix 反映 — これを誤ると forward-only の volume bomb):** `layoutStore` は live ドラッグ mutator(`setRegionSizeLive`:1103, `nudgeRegionSize`:1123, `nudgeAdjacentSlotSizes`:1163, `nudgeAdjacentCenterSegmentSizes`:1221)と commit mutator(`setRegionSize`:1097, `setSlotRatios`:1144, `setCenterSegmentRatios`:1197, `finalizeLayoutResize`:1251)が分離している。**フックは確定 mutator のみに張り、live ドラッグ・scroll は非記録。** scroll は replay 時に caret から viewport を再導出する意図的 defer と明記する。

加えて、`finalizeLayoutResize` を通らない離散レイアウト操作を取りこぼさないよう、以下も `domain='layout'` で記録する: `togglePanel`(:701)、`setEditorOpen`(:653)、`applyPreset`(:1449)、`movePanelToSlot`(:795)、`movePanelToRegion`(:807)、`setRegionSize`(:1097)。各イベントは自己完結 snapshot なので「いつ何が起きたか」が単独で復元できる。

**timestamp 順 UI 再生は change_events ストリーム(hash-chain + sequence/timestamp 順)で行う。** `state_snapshots`(schema.ts:1551-1582)は `anchorSequence` で seek する別消費モデルなので playback には使わない、と書き分ける(後述 17.5 の初期 seed のみ snapshots 経路)。

### 17.5 初期状態 seed は「毎セッション開始時 + state_snapshots 経路」(OFF→ON 1 回では支配経路で欠落)

layout/UI は相対イベント(panel toggled 等)だけだと replay 初期状態が未定義になる。だが seed を「ON 直後だけ」焼く案は forward-only で破綻する:

- `stampSceneBaselines` を呼ぶのは `rearmFromGenesis` のみで、それは `setTimelapseEnabled(true)`(toggle.ts:111)と purge 経路(toggle.ts:128)からしか走らない。
- アプリの支配経路 = 既に ON のプロジェクトを開く通常起動は `projectStore.loadProject → initRecorderForProject`(projectStore.ts:104-105)で、seed も baseline も一切焼かない。
- editor scene は last OFF→ON で焼いた baseline から forward replay できるが、layout/UI は editor doc と寿命が違う。ユーザーは毎日同じ ON プロジェクトを開閉するため、その「開いた瞬間の layout/activeScene/focus」が記録されないとそのセッションの初期 UI 状態が欠落する。

**fix:** 通常ロード経路(`projectStore.loadProject`、projectStore.ts:104-105 直後)で、ON のとき layout/activeScene/focus の現在状態を `recordStateSnapshot`(snapshots.ts:32)へ次の条件で焼く:

- `domain='layout'`(activeScene/focus を分けるなら `'ui'` 系の opType でなく entityType で区別)
- **`entityId='workspace'`(固定・非 null)** — `loadLatestSnapshot` は `entityId===null` を扱えない(snapshots.ts:75-81)ため、必ず非 null の固定 id を付与する
- `anchorSequence` = 現在の chain head

replay は `loadLatestSnapshot`(snapshots.ts:65-110)で `asOfSequence` 直前の初期状態を取り、そこから 17.4 の相対イベントで前進する。**seed を change_events 本線に append しない**(毎セッション seed が sequence/hashChain を消費して volume を膨らませ、consumer が「初期 seed」と「実操作」を区別する必要が出る)。

**chat の seed:** OFF→ON 直後は空会話なので seed 不要は正しい。ただし 2 回目以降のセッション開始時点では既存会話が `chat_messages` に存在する(change_events には無い)。過去会話を初期表示したいなら chat も per-session-open の seed snapshot(`domain='chat'`)を同経路で焼く。**P0 のスコープ決定: replay 初期画面は「空チャット」から始め、過去会話の初期表示は defer する**(forward-only だが、空起点 + 以後 `chat.message.add` の前進再生で会話フローは成立する。過去会話の初期表示が必要になった時点で seed snapshot を足す)。

### 17.6 連続性契約(§15)との整合 — wipe は domain 非依存で自動波及(改修不要)

`wipeHistory` は `db.delete(changeEvents).where(eq(projectId))`(toggle.ts:55)で domain 絞りが無く、`state_snapshots` も同様(toggle.ts:56-58)。将来の chat/layout 行も同じ projectId なら巻き込まれて消える。OFF→ON の「全 wipe → genesis 録り直し」は新ドメインにも自動で効くため改修不要。production toggle 時は `resetRecorderChain` で head リセットを忘れない(冪等ガード recorder.ts:105-107 の罠 — §15)。

### 17.7 sceneId / entityId / sessionId の正しい配置(sound 判定 + 必須補完)

- **sceneId は treeNode id のみ。** `change_events.sceneId` は `treeNodes` への FK で `onDelete:set null`(schema.ts:1519-1521)。PRAGMA foreign_keys=ON が単一 `Mutex<Connection>` 上で有効(database.rs:25-29)なので、非 treeNodes 値(chat session id 等)を sceneId に入れると flush insert(recorder.ts:264)が FK 制約で落ち、catch で batch 再 queue → 永久リトライ失敗 = 全 flush 停止。sceneId は scene-scope 時の `activeSceneId`(treeNode id)のみに限定する。
- **chat session/panel 等の非 treeNodes id は FK 無しの `entityId` へ。** `entityType`/`entityId` は FK 無し nullable text(schema.ts:1524-1525)。既存 precedent: `EditorPane.tsx:831-838` で codex/snippet モードは `sceneId:null` + `entityId:非treeNodes id` を本番運用済み。chat session/panel id はこれと完全同型。`entityType` を `chat_session`/`chat_message`/`panel`/`focus` 等で命名する。
- **sessionId カラムは触らない。** `change_events.sessionId`(schema.ts:1527, recorder.ts:240)は録画 run id であって chat session id ではない。chat session id を sessionId カラムに入れると recorder が上書きする。**chat session id は必ず payload の `sessionId` フィールドへ**(17.2-17.3)。再生は payload の sessionId 基準でグルーピングする(チャット scope は scene/folder/project 可変 — chatStore.ts:393-404。sceneId だけだと folder/project scope の会話を拾えない)。
- **1 本の entityId の表現力:** chat は session+message の 2 階層、UI は panel+focus の複数次元だが FK 無しカラムは 1 本。階層は `entityType` でタグ付けし、副次 id は payload(JSON TEXT)へ載せる。

### 17.8 hash / TEXT / 索引の整合

payload は `canonicalisePayload`(recorder.ts:280-291)で top-level key sort → JSON TEXT 化され、drizzle TEXT-only 制約(メモリ grimodex-drizzle-proxy-no-blobs / commit 70687944)に適合。hash は hex TEXT。`hashChain` は payloadStr 経由(recorder.ts:231,245)で計算するので本文 inline 焼き込みも hash 連鎖と整合する。**注意: `canonicalisePayload` は top-level キーのみソート(nested は素通し)** ため、hash 安定が要る nested 構造は呼び出し側で事前ソートする。

再生 consumer は `loadProjectChangeEvents`(queryEvents.ts:21-27)+ クライアント側 domain/entityId フィルタが前提(sceneId:null の chat/UI は `loadSceneChangeEvents` で拾えない — queryEvents.ts:35-49、`idx_change_events_scene_ts` も NULL に効かない)。

### 残存リスク

- chat 過去会話の初期表示を defer(17.5)したため、2 回目以降セッションの replay は空チャット起点になる。会話の「途中から開いた」感が必要になったら後追いで seed snapshot を要する(append-only なので前方互換)。
- `chat.message.add` の payload は本文 inline で 1 件が大きく(長文 assistant 応答)、editor step より総量が重い。`loadProjectChangeEvents` は project 全ロードのため、長期蓄積でメモリ・ロード時間が膨らむ。entityType/domain 単位の部分索引・ページングを P5 再生 consumer で要検討。
- layout フックを live mutator(setRegionSizeLive 等)に誤って張ると 1 ドラッグで数十〜数百件の full snapshot が出る volume bomb。確定 mutator 限定の contract を実装レビューで gate する。
- streaming delta 非記録のため「AI が打っている」途中経過は再生されない(完了 snapshot のみ)。
- seed を毎セッション開始で焼くため、ON プロジェクトを頻繁に開閉すると `state_snapshots` の workspace 行が積み増す(seek は最新 1 件 limit なので replay は無害、ストレージのみ)。

### 実装順(P0)

1. `recorder.ts:27-34` と `queryEvents.ts:5-12` の `Domain` union に `'chat'` `'layout'` を追加し、`schema.ts:1522` の domain コメントを更新する。
2. `chatApi.addMessage`(:444-449 成功後)に `chat.message.add`(payload に role/text/sessionId/messageId inline)を user turn / assistant それぞれ実発生時刻で記録するフックを置く。
3. `chatApi.deleteMessage`(:452)・`deleteMessagesFrom`(:456)・`chatStore.regenerate`(:3134-3142)・`editUserMessage`(:454)に `chat.message.delete`/`regenerate`/`edit` 記録フックを置く(delete を別建て append)。
4. `layoutStore` の確定 mutator(`finalizeLayoutResize`:1251, `togglePanel`:701, `setEditorOpen`:653, `applyPreset`:1449, `movePanelToSlot`:795, `movePanelToRegion`:807, `setRegionSize`:1097)に `domain='layout'` の full LayoutState snapshot 記録を置く(live mutator・scroll は非記録)。
5. `projectStore.loadProject`(projectStore.ts:104-105 直後)に、ON のとき layout/activeScene/focus を `recordStateSnapshot`(`entityId='workspace'`, anchorSequence=chain head)へ焼く per-session seed を追加する。
6. payload に sceneId=treeNode id のみ / chat session id は payload.sessionId / 非 treeNodes id は entityId、の配置規約を各フックで徹底し、`canonicalisePayload` の nested 非ソートに備え nested を事前ソートする。

---

## 付録 A: 主要シンボル早見

- 記録: `recordChangeEvent`（recorder.ts:156）, `flushNow`（:184）, `setRecorderEnabled`（:86）, `initRecorderForProject`（:97）
- 読み: `loadProjectChangeEvents`（queryEvents.ts:21）, `loadSceneChangeEvents`（:35）
- 検証: `verifyChain`（hashChain.ts:139）, `canonicalSerializeEvent`（:43）
- replay: `replayEditorSteps`（replayEngine.ts:34）, `isEditorBodyDomain`（:87）
- 描画: `renderDocToCanvas`（editorRenderer.ts:64）, `DEFAULT_THEME`（:34）
- 録画: `captureCanvasToWebm`（videoExport.ts:42）, `CaptureWebmOptions`（:17）
- snapshot: `recordStateSnapshot`（snapshots.ts:32）, `loadLatestSnapshot`（:66）, `shouldCreateSnapshot`（:117）
- zip: `buildAuthorshipExportZip`（zipExport.ts:64）, `eventsToChainJson`（:45）
- 保存先例: `saveZipBlob`（ZipExportDialog.tsx:21）, PNG バイナリ（useMapExport.ts:49）
- ホスト先例: `AnimatedOverlay`（animated-overlay.tsx:20）, `RevisionHistoryModal`（:459）
- ON/OFF 制御: `resetRecorderChain`（recorder.ts 新規, §15.5）, `setTimelapseEnabled`（toggle.ts 新規, §15.6）, `getProjectSetting`/`setProjectSetting`（settings/api.ts:36/52）, `SettingToggle`（components/SettingToggle.tsx:9）, `KEY_SCOPE`/`DEFAULT_SETTINGS`（settings/types.ts:51/145）, `listAllNodes`/`loadSceneContent`（tree/api.ts:70/201）, wipe = `db.delete(t).where(eq(t.projectId,id))`

---

## 付録 B: 保存容量の概算（order-of-magnitude）

> 実データなしの推測。書き方・推敲量・IME の確定単位に強く依存し、桁の見積もりであることに注意。精度が要れば実プロジェクトで `SELECT count(*), sum(length(payload)) FROM change_events WHERE projectId=?` を実測。

### change_events（連続増加の本命）
1 編集イベント（≒ docChanged な transaction）= 1 行。**1 行 ≈ 0.4〜0.6 KB**:
- UUID 4個（project/scene/entity/session, text 格納）~144B
- hash 2個（prevHash+hash, 各32B）64B（chain 固定コスト）
- payload `{"steps":[…]}` 数文字分 ~100〜200B
- + index 3本（`project+seq` / `project+ts` / `scene+ts`）のエントリ

| 規模 | イベント数(概算) | change_events |
| --- | --- | --- |
| 短編 1万字 | 〜数千〜1万 | 数 MB |
| 長編 10万字（一冊） | 〜5万前後 | **20〜100 MB** |

前提: 日本語 IME 確定で数文字/イベント、推敲・削除の churn 込み（events ≈ 文字数 × 約0.5）。Latin 直打ち/大量推敲で上振れ。**現状プルーニング無し**＝ wipe/パージまで単調増加（§15.10）。

### state_snapshots（小さい）
`doc.toJSON()` を gzip。1 シーン ~数 KB。ON 時の全シーン baseline でも 50 シーンで ~0.5 MB 程度。イベントログに対し誤差レベル。

### WebM 書き出し（一過性）
30s / 1280×720 / VP9。白背景＋テキストで低モーション → **~1〜8 MB/本**。明示書き出しの一過性ファイルで蓄積コストではない。

**結論**: 1 プロジェクトで GB 級に達するのは極端なケースのみ。容量許容 + 手動パージ（§15.10）で十分（§13）。
