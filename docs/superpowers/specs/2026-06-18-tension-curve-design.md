# テンション波形（meta_structure tension 可視化）— 設計仕様

- 日付: 2026-06-18
- ブランチ: `feat/tension-curve`（worktree: `.claude/worktrees/feat+tension-curve`）
- 機能ID: H（feature-idea-backlog 監査の「部分重複＝バックエンド有りでUIだけ安い」枠。③メタ構造レビュー指摘の延長）

## 目的

既存 `meta_structure` ポストエフェクトが各シーンに対し算出する `plot_structure` lens の **tension 値**を、**読了順の折れ線**で可視化する。あわせて **中だるみ（低テンション連続区間）** と **章末フック強度（章境界の最終シーンの tension）** を示し、物語のペース配分を一望できるようにする。完全に read-only（DB・本文・スキーマ変更なし）。

## 背景・データ契約（重要）

- `metrics` はパイプラインを既に往復している: prompt が AI に `metrics` を返させ → `post_effect.rs:3508` が `scene_lens_data.metrics`(TEXT) へ verbatim INSERT → 読み戻しで `SceneLensRecord.metrics: Record<string, unknown>`（`types.ts:296`）に同梱 → `lensStore.bySceneId: Map<sceneId, SceneLensRecord[]>` で保持。
- **唯一の弱点**: `tension` は prompt 上「例」フィールド（`prompts/ja/postEffect.ts:232` "e.g. {…,"tension":0.6}"）にすぎず、必須でも 0-1 正規化でもない → **疎・未正規化で信頼できない**。本仕様で prompt 契約を強化して解消する。
- Rust・DB は metrics を内容非依存で保存するため**無改修**。本機能は**フロントエンド + prompt テキストのみ**。

## スコープ

### やること
- meta_structure prompt（ja/en）改訂で `plot_structure` lens の `tension`(0.0–1.0) を必須化、`META_STRUCTURE_PROMPT_VERSION` を bump。
- 純関数: テンション系列構築 / 中だるみ検出。
- SVG 折れ線コンポーネント（中だるみ帯・章境界線・章末フックマーカー・クリックでシーンへ）。
- 校閲 MetaStructure の **project スコープ view 上部**へ埋め込み。
- i18n（ja/en）。

### やらないこと（YAGNI / 確定済み判断）
- チャートライブラリ導入（recharts 等）。SVG 自前描画（Timeline 前例）。
- 手動 tension スライダ / schema 追加（Q1 で却下）。
- Rust / DB / migration 変更（metrics は verbatim 保存済み）。
- pacing lens の `pace`/`drag_points` 可視化（tension 一本に絞る）。
- current（単一シーン）スコープでの表示（project のみ）。
- 閾値のユーザー設定化（定数）。

## アーキテクチャ（フロントエンドのみ）

### ① データ契約強化（prompt）
- `src/prompts/ja/postEffect.ts` と `src/prompts/en/postEffect.ts` の `metaStructureSystem`:
  - `plot_structure` lens の `metrics` に **`tension` を 0.0–1.0 の数値で必ず含める**ことを明記（緊張/盛り上がりの高さ。0=平穏、1=最高潮）。
  - 出力例の metrics にも `tension` を残す。
- `src/features/post-effect/metaStructurePayloadBuilder.ts`: `META_STRUCTURE_PROMPT_VERSION = "meta_structure_v1.1"` に bump。
  - 効果: input_hash が変わり既存キャッシュは無効化 → 再診断で tension が埋まる（意図的）。
- Rust / schema は無改修。

### ② 純関数 `src/features/post-effect/tensionSeries.ts`（新規）
```ts
export interface TensionPoint {
  sceneId: string;
  title: string;
  tension: number | null;   // plot_structure lens の metrics.tension（0-1）。無ければ null
  parentId: string | null;  // 章境界判定用
  isChapterEnd: boolean;     // 次シーンの parentId が異なる or 末尾
}
export interface SaggyRun { startIdx: number; endIdx: number; } // series 上の連続区間（両端含む）

// nodes（TreeNodeData[]）を読了順に走査し、各シーンの plot_structure lens の tension を引く
export function buildTensionSeries(
  nodes: TreeNodeData[],
  bySceneId: Map<string, SceneLensRecord[]>,
): TensionPoint[];

// tension <= threshold が連続 2 点以上の極大区間を返す（null は「低」に含めない＝区間を分断）
export function detectSaggyRuns(series: TensionPoint[], threshold?: number): SaggyRun[]; // default 0.35
```
- 読了順は既存 `computeGlobalSceneOrder(nodes)`（phaseResolver）流用。
- `tension` 抽出: `bySceneId.get(sceneId)` から `lensType==="plot_structure"` の record を探し `metrics.tension` が有限数なら採用、それ以外 null。
- 章末フック強度は別関数を作らず、`isChapterEnd && tension!=null` の点の tension を UI 側でマーカー色に使う。

### ③ SVG コンポーネント `src/features/post-effect/TensionCurve.tsx`（新規）
- props: `series: TensionPoint[]`, `saggy: SaggyRun[]`, `onSelectScene(sceneId)`。
- 描画（recharts 不使用・手描き SVG）:
  - 折れ線＋点。x = series 内の位置（等間隔）、y = tension（0 下〜1 上）。**tension===null の点で線を分断**（前後を繋がない）。
  - 中だるみ `SaggyRun` 区間に薄い背景帯。
  - 各 `isChapterEnd` の直後に縦の章境界線。章末点は tension 値で色付け（高=暖色フック強・低=寒色）したマーカー。
  - 点 hover で `title` + tension 値（最小ツールチップ／`title` 属性可）。点クリック→`onSelectScene`。
  - `prefers-reduced-motion` ガード（アニメーションは入れないか、入れる場合は無効化）。read-only。

### ④ 配線 & 空状態（`MetaStructureView.tsx` 改修）
- `scope === "project"` のときのみ、`projectGroups` リストの**上**に:
  ```tsx
  const nodes = useTreeStore((s) => s.nodes); // 折れ線の読了順とフォルダ境界に必須（scenes だけでは不足）
  const series = useMemo(() => buildTensionSeries(nodes, bySceneId), [nodes, bySceneId]);
  const saggy = useMemo(() => detectSaggyRuns(series), [series]);
  const hasTension = series.some((p) => p.tension !== null);
  // scope==="project" && hasTension のとき:
  //   <TensionCurve series={series} saggy={saggy} onSelectScene={(id)=>useTreeStore.getState().setActiveScene(id)} />
  ```
- tension を持つシーンが 0 件なら波形は非表示（既存の「診断」実行ボタン＋`EmptyState` が誘導）。current スコープでは一切出さない。

### ⑤ i18n（`src/locales/{ja,en}.json`）
`kouetsu.tension.title` / `saggy`（中だるみ）/ `chapterHook`（章末フック）/ `axisTension` / `noData`（未データ hint）。

## エッジケース
- meta_structure 未実行 or 全シーン tension 欠落 → 波形非表示（hasTension=false）。
- 一部シーンのみ tension → 欠落点は null で線分断（穴が見える）。
- フラット構成（フォルダ無し）→ 全シーンが同一 parentId ＝ 章境界は末尾のみ（実質1章）。
- 旧 v1.0 結果（tension 無し）は再診断するまで波形に出ない（version bump の意図的挙動）。
- シーン 0/1 件 → 折れ線が引けない場合も落ちない（点のみ/空）。

## テスト
- `tensionSeries.test.ts`:
  - `buildTensionSeries`: 読了順、plot_structure の tension 抽出、pacing しか無いシーンは null、isChapterEnd（parent 変化・末尾）、metrics.tension が数値でない/欠落で null。
  - `detectSaggyRuns`: 連続2以上で検出 / 単発は無視 / null で分断 / 閾値境界（==threshold は「低」に含む）。
- `TensionCurve.test.tsx`（happy-dom）: 点描画数、中だるみ帯、章末マーカー、点クリックで `onSelectScene` 呼び出し。
- `MetaStructureView`: project で hasTension 時に波形あり / 空データで波形なし / current スコープで波形なし。

## 影響ファイル
| ファイル | 変更 |
|---|---|
| `src/prompts/ja/postEffect.ts` / `en/postEffect.ts` | metaStructureSystem に tension 必須を明記 |
| `src/features/post-effect/metaStructurePayloadBuilder.ts` | PROMPT_VERSION を v1.1 へ |
| `src/features/post-effect/tensionSeries.ts` (+test) | 新規（純関数） |
| `src/features/post-effect/TensionCurve.tsx` (+test) | 新規（SVG） |
| `src/features/kouetsu/views/MetaStructureView.tsx` (+test) | project view へ配線 |
| `src/locales/ja.json` / `en.json` | kouetsu.tension.* |

## 既知の制約（記録）
- tension は AI 主観のため絶対値の意味は限定的（相対的な起伏の可視化として使う）。
- 章境界はフォルダ境界ヒューリスティック（明示的な章モデルは持たない）。
- version bump により、出荷直後は全プロジェクトで再診断するまで波形が空。
