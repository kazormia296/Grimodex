---
name: polish-motion
description: >
  Grimodex の UI アニメーションやトランジションを追加・修正し、Reduced Motion、
  共有モーション定数、ライフサイクルの規約に揃える。静的なレイアウト変更だけには使わない。
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
---

アニメーションを足す／直す前に、この規律に従ってください。

## 0. そもそも動かす必要があるか

次のいずれかに該当しない場合は**動かさない**。

- 状態変化を伝える（開いた／閉じた、選択された、成功した）
- 空間の連続性を保つ（要素がどこから来たか示す）
- フィードバックを返す（操作が届いたと知らせる）

目的なしのアニメは執筆者の注意を削る。Grimodex は長時間の執筆セッションで使われることを忘れない。

## 1. ライブラリ選択

**迷ったら Framer Motion (`motion/react`)。GSAP は理由が要る。**

| ケース | 使う |
|---|---|
| マウント／アンマウント、条件付き表示 | Framer Motion (`AnimatePresence`) |
| ドロップダウン、ポップオーバー、ダイアログ | Framer Motion + `VARIANTS.*` |
| タイムライン（複数ステップの連続演出） | GSAP |
| 無限ループ（pulse / shimmer / yoyo） | GSAP |
| stagger が絡む大規模演出 | GSAP |
| SVG path / Canvas / 要素外プロパティ | GSAP |

## 2. 必須ルール

違反はレビューで差し戻し。

### Reduced Motion ガード（例外なし）

OS `prefers-reduced-motion` とアプリ設定 `display.reduceMotion` の**両方**を見る。

```ts
// React コンポーネント（Framer Motion 側）
import { useReducedMotion } from "@/lib/animation";
const reduced = useReducedMotion();

// 命令型 GSAP
import { isReducedMotion } from "@/lib/gsap";
if (isReducedMotion()) return;
```

Reduced Motion のときは**動きを弱める**のではなく、**静的な最終状態に置き換える**。

### マジックナンバー禁止

duration / easing は `src/lib/animation.ts` の定数を使う。

- `DURATIONS.fast` (0.15s): ホバー・フォーカスリング
- `DURATIONS.normal` (0.2s): パネル・ポップオーバー開閉
- `DURATIONS.slow` (0.3s): 大きめの空間移動
- `DURATIONS.dialog` (0.25s): モーダル
- `EASINGS.easeOut` / `EASINGS.spring`
- `VARIANTS.fadeIn` / `slideUp` / `scaleIn` / `dropdown` / `popover`

新しい値が必要になったら `animation.ts` に**追加してから**使う。呼び出し側にべた書きしない。

GSAP 側もこの値域に揃える（fast 0.15 / normal 0.2 / slow 0.3）。

### GSAP は必ず cleanup

React コンポーネント内では `useGSAP()` を使う（`@gsap/react`）。

```tsx
import { useGSAP } from "@gsap/react";

useGSAP(() => {
  if (isReducedMotion()) return;
  gsap.fromTo(ref.current, { opacity: 0 }, { opacity: 1, duration: 0.2 });
}, { dependencies: [trigger] });
```

`useEffect` で生に書くなら `gsap.context()` + `ctx.revert()`。例外なし。

### 既存ヘルパーを先に検討

`src/lib/gsap.ts` の以下で足りないか確認する。

- `celebrationBurst` — 成功の瞬間
- `shimmerSweep` — ロード中のハイライト
- `staggerFlourish` — リスト入場
- `pulseHighlight` — 注意喚起

足りない場合は**呼び出し側にべた書きしない**で `src/lib/gsap.ts` に追加する。

## 3. 美学（4つのスローガン）

詳細と具体例は `aesthetics.md` 参照。

- **Chrome は動く、Content は動かない** — エディタ本文領域は静止を守る
- **減速 `*.out` を既定、跳ねる系はセッション数回まで** — `ease-in` 単体は禁止
- **モーションの発生源をトリガーに揃える** — `transform-origin` を意図的に設定
- **退場は入場より速く、中断は巻き戻しではなくキャンセル** — ユーザーを待たせない

## 4. パフォーマンス

動かすプロパティは `transform` / `opacity` / `filter` / `clip-path` に限定。
`width` / `height` / `top` / `left` / `box-shadow` は最小限（tour のハイライトのような意図的な場面のみ）。

## 5. PR前チェックリスト

- [ ] Reduced Motion で動作確認した（設定 ON & OS 設定 ON）
- [ ] `DURATIONS` / `EASINGS` / `VARIANTS` を使った（新値は `animation.ts` に追加）
- [ ] GSAP なら `useGSAP` or `gsap.context()` cleanup がある
- [ ] 共有ヘルパーで足りないか検討した
- [ ] エディタ本文領域に副作用がない
- [ ] 60fps を崩していない（重めの演出は DevTools Performance で確認）
