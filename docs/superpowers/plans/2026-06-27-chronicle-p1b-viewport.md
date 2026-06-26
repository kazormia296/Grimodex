# Chronicle P1b（SVG 人物レーン年表ビューポート）Implementation Plan

> REQUIRED SUB-SKILL: executing-plans / subagent-driven-development。P1a(パネル登録)の後続。**幾何を伴うため browser test 必須**。

**Goal:** ChroniclePanel の一覧を、人物レーン×作中時間(ordinal/連続時刻)軸の SVG 年表に置き換える。point/interval、precision 表示、オフページ中空マーカー。

**Architecture:** 座標数学は純関数 `chronicleTimeScale`(ordinal→x) と `chronicleLaneModel`(events+participants+codex→レーン/マーカー) に閉じ込め happy-dom 単体テスト。描画は `ChronicleViewport` + サブ分割(ChronicleAxis/EntityLane/EventMarker/SeasonGutter)で 200行規約遵守、TimelineViewport の2014行モノリスは複製しない。整列 invariant は `*.browser.test.tsx`。

## Global Constraints
- 純関数に乱数/Date.now 禁止(決定性)。1ファイル1責務200行。
- レイアウト/幾何変更後は `pnpm test:browser` も走らせる(CI で検証)。
- アニメは `@/lib/animation` の DURATIONS/EASINGS/VARIANTS 経由。

## File Structure
- Create `src/features/chronicle/chronicleTimeScale.ts`(+test): `projectOrdinalsToX(events, {width, padX, zoom, scrollOffset})` 等。startTime があれば連続射影、無ければ ordinal 等間隔。precision→描画属性。
- Create `src/features/chronicle/chronicleLaneModel.ts`(+test): `buildChronicleLanes({events, participants, codexPeople})` → `{lanes: {codexId, name, y, markers}[], laneHeight, contentHeight}`。主参加=実線レーン、副参加=淡いタイ(後続)。オフページ=hollow フラグ。決定性(codexId/ordinal tiebreak)。
- Create `src/features/chronicle/ChronicleViewport.tsx` + `ChronicleAxis.tsx` + `EntityLane.tsx` + `EventMarker.tsx`(point/interval/hollow)。
- Create `src/features/chronicle/ChronicleViewport.browser.test.tsx`: マーカー x がレーン内・軸目盛りと整列・interval 幅が start..end に比例・hollow がオフページのみ。
- Modify `ChroniclePanel.tsx`: 一覧の代わりに(or 併置で) ChronicleViewport をマウント。participants/scene_events をロード(listEventParticipants/listSceneEvents)。
- Create `src/features/chronicle/ChronicleInspector.tsx`: 選択 event の time/precision/primaryCodex/participants/scene 参照を編集(updateEvent/setEventParticipants/link/unlink)。

## タスク順(TDD)
1. `chronicleTimeScale`(+test) — ordinal→x・precision。純関数先行。
2. `chronicleLaneModel`(+test) — レーン構築。純関数。
3. `EventMarker`/`EntityLane`/`ChronicleAxis` — 小 SVG コンポーネント。
4. `ChronicleViewport` — 合成。
5. `ChronicleViewport.browser.test.tsx` — 幾何 invariant(push まで sandbox 未検証→CI 初回赤を1巡見込む)。
6. `ChroniclePanel` 配線 + `ChronicleInspector`。
7. 検証: tsc/lint/単体/`pnpm test:browser`(CI)。

## 後続
- P2 季節整合(seasonOf×シーン記述)。P3 Timeline 連動(共有selection+pull/stamp+C案タイ線)。P4 場所/勢力レーン・年齢・2か所同時・因果・AI抽出。
