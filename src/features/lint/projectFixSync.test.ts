import { beforeEach, describe, expect, it } from "vitest";

import { useLintStore } from "./lintStore";
import { useLintIgnoreStore } from "./lintIgnoreStore";
import { useLintProjectStore } from "./lintProjectStore";
import {
  subscribeProjectSnapshotToLiveLint,
  syncProjectSceneFromLiveLint,
} from "./projectFixSync";
import type { Diagnostic } from "./types";
import type { ScannedScene } from "./projectScan";

/**
 * Regression: in Project スコープ、Fix を押すと本文編集＋再 Lint
 * (runLintNow) の結果は lintStore にだけ反映され、Project パネルが
 * 描画している lintProjectStore.scenes[] は scan 時のスナップショットの
 * まま固まっていた。よって直したはずの診断（ja/dash-single 等）が
 * 出続ける。current シーンは lintStore を直接読むため起きない。
 *
 * syncProjectSceneFromLiveLint は runLintNow 後にライブ Lint の最新結果を
 * Project ストアへ反映し、この乖離を解消する。
 */
const dashDiag: Diagnostic = {
  rule_id: "ja/dash-single",
  severity: "error",
  message: "ダッシュは 2 つ組で使います",
  range: { start: 3, end: 4 },
  fix: {
    label: "「——」に置き換える",
    replacement: "——",
    range: { start: 3, end: 4 },
  },
};

const baseScene: ScannedScene = {
  sceneId: "s1",
  sceneTitle: "Scene 1",
  sceneText: "テスト—です", // pre-fix: 単一ダッシュ
  diagnostics: [dashDiag],
  warnings: [],
};

function resetStores() {
  useLintIgnoreStore.setState({ bySceneId: {}, loading: {} });
  useLintProjectStore.setState({ scenes: [] });
  useLintStore.setState({
    currentSceneId: null,
    rawDiagnostics: [],
    diagnostics: [],
    lastSceneText: "",
    isLinting: false,
  });
}

describe("syncProjectSceneFromLiveLint", () => {
  beforeEach(() => {
    resetStores();
  });

  it("clears a fixed dash diagnostic from the project store after re-lint", () => {
    useLintProjectStore.setState({ scenes: [structuredClone(baseScene)] });
    // runLintNow が post-fix 本文を再 Lint した状態を模す: 診断なし。
    useLintStore.setState({
      currentSceneId: "s1",
      rawDiagnostics: [],
      diagnostics: [],
      lastSceneText: "テスト——です", // post-fix: ダッシュ2つ組
    });

    syncProjectSceneFromLiveLint("s1");

    const updated = useLintProjectStore
      .getState()
      .scenes.find((s) => s.sceneId === "s1")!;
    expect(updated.diagnostics).toEqual([]);
    // sceneText も最新へ更新する（後続 onIgnore のオフセット照合のため）。
    expect(updated.sceneText).toBe("テスト——です");
  });

  it("keeps remaining diagnostics when only one of several is fixed", () => {
    const ellipsis: Diagnostic = {
      rule_id: "ja/ellipsis-single",
      severity: "error",
      message: "三点リーダーは 2 つ組で使います",
      range: { start: 10, end: 11 },
      fix: {
        label: "「……」に置き換える",
        replacement: "……",
        range: { start: 10, end: 11 },
      },
    };
    useLintProjectStore.setState({
      scenes: [
        { ...structuredClone(baseScene), diagnostics: [dashDiag, ellipsis] },
      ],
    });
    // post-fix 再 Lint: dash は消え、三点リーダーだけ残る。
    useLintStore.setState({
      currentSceneId: "s1",
      rawDiagnostics: [ellipsis],
      diagnostics: [ellipsis],
      lastSceneText: "テスト——です……",
    });

    syncProjectSceneFromLiveLint("s1");

    const updated = useLintProjectStore
      .getState()
      .scenes.find((s) => s.sceneId === "s1")!;
    expect(updated.diagnostics).toEqual([ellipsis]);
  });

  it("does not overwrite the scene when a different scene's lint superseded ours", () => {
    useLintProjectStore.setState({ scenes: [structuredClone(baseScene)] });
    // await runLintNow の後に別シーンの再 Lint が割り込んで lintStore を
    // 上書きしていた場合、その診断は s1 のものではない。
    useLintStore.setState({
      currentSceneId: "OTHER",
      rawDiagnostics: [],
      diagnostics: [],
      lastSceneText: "別シーンの本文",
    });

    syncProjectSceneFromLiveLint("s1");

    const updated = useLintProjectStore
      .getState()
      .scenes.find((s) => s.sceneId === "s1")!;
    // 別シーンのデータで汚染するより、stale なスナップショットを温存する方が安全。
    expect(updated.diagnostics).toEqual([dashDiag]);
    expect(updated.sceneText).toBe("テスト—です");
  });

  it("drops a still-present diagnostic matched by a persistent ignore (fresh sceneText)", () => {
    // post-fix 再 Lint がまだ dash 診断を返すが、その診断はユーザーが永続無視
    // 済み。Project 同期は raw 診断に対し最新 sceneText で ignore フィルタを
    // かけ直すので、無視済みは出さない。
    const liveDash: Diagnostic = {
      rule_id: "ja/dash-single",
      severity: "error",
      message: "ダッシュは 2 つ組で使います",
      range: { start: 1, end: 2 },
      fix: {
        label: "「——」に置き換える",
        replacement: "——",
        range: { start: 1, end: 2 },
      },
    };
    useLintProjectStore.setState({
      scenes: [{ ...structuredClone(baseScene), diagnostics: [] }],
    });
    useLintIgnoreStore.setState({
      bySceneId: {
        s1: [
          {
            id: "ig1",
            rule_id: "ja/dash-single",
            scene_id: "s1",
            text_snippet: "—",
            context_before: "あ",
            context_after: "",
            note: null,
            created_at: 0,
          },
        ],
      },
      loading: {},
    });
    useLintStore.setState({
      currentSceneId: "s1",
      rawDiagnostics: [liveDash],
      // lintStore 側は既に filter 済みだが、Project 同期は raw を自前で
      // filter する契約であることを示すため、あえて生 raw を置く。
      diagnostics: [liveDash],
      lastSceneText: "あ—",
    });

    syncProjectSceneFromLiveLint("s1");

    const updated = useLintProjectStore
      .getState()
      .scenes.find((s) => s.sceneId === "s1")!;
    expect(updated.diagnostics).toEqual([]);
    expect(updated.sceneText).toBe("あ—");
  });
});

/**
 * Race 対策: applyFix の `runLintNow` は Codex/用語辞書フェッチを await して
 * から runLint を呼ぶ。そのフェッチが debounce(500ms) を跨ぐと、即時 run が
 * デバウンス run に超越され early-return（set なし）→ 直後に store を読むと
 * pre-fix のままになりうる。subscribeProjectSnapshotToLiveLint は「どの run
 * であれ settle した結果」を Project スナップショットへ反映するので、この
 * 競合に強い（current シーンモードが lintStore を直読みするのと同じ鮮度）。
 */
describe("subscribeProjectSnapshotToLiveLint", () => {
  beforeEach(() => {
    resetStores();
  });

  it("mirrors the live lint into the snapshot when a lint settles for a scanned scene", () => {
    useLintProjectStore.setState({ scenes: [structuredClone(baseScene)] });
    const unsub = subscribeProjectSnapshotToLiveLint();
    // lint 開始 (isLinting false→true): まだ同期しない。
    useLintStore.setState({ isLinting: true, currentSceneId: "s1" });
    // lint 完了 (isLinting true→false): post-fix 結果で同期。
    useLintStore.setState({
      isLinting: false,
      currentSceneId: "s1",
      rawDiagnostics: [],
      diagnostics: [],
      lastSceneText: "テスト——です",
    });
    unsub();

    const updated = useLintProjectStore
      .getState()
      .scenes.find((s) => s.sceneId === "s1")!;
    expect(updated.diagnostics).toEqual([]);
    expect(updated.sceneText).toBe("テスト——です");
  });

  it("ignores settles for scenes not present in the snapshot", () => {
    useLintProjectStore.setState({ scenes: [structuredClone(baseScene)] });
    const unsub = subscribeProjectSnapshotToLiveLint();
    useLintStore.setState({ isLinting: true, currentSceneId: "OTHER" });
    useLintStore.setState({
      isLinting: false,
      currentSceneId: "OTHER",
      rawDiagnostics: [],
      lastSceneText: "別シーン",
    });
    unsub();

    const s1 = useLintProjectStore
      .getState()
      .scenes.find((s) => s.sceneId === "s1")!;
    expect(s1.diagnostics).toEqual([dashDiag]);
  });

  it("does not mirror on non-settling updates (no isLinting true→false transition)", () => {
    useLintProjectStore.setState({ scenes: [structuredClone(baseScene)] });
    const unsub = subscribeProjectSnapshotToLiveLint();
    // isLinting は false のまま raw/text を更新（例: cursor 移動の set）。
    useLintStore.setState({
      isLinting: false,
      currentSceneId: "s1",
      rawDiagnostics: [],
      lastSceneText: "テスト——です",
    });
    unsub();

    const s1 = useLintProjectStore
      .getState()
      .scenes.find((s) => s.sceneId === "s1")!;
    expect(s1.diagnostics).toEqual([dashDiag]);
  });

  it("stops mirroring after unsubscribe", () => {
    useLintProjectStore.setState({ scenes: [structuredClone(baseScene)] });
    const unsub = subscribeProjectSnapshotToLiveLint();
    unsub();
    useLintStore.setState({ isLinting: true, currentSceneId: "s1" });
    useLintStore.setState({
      isLinting: false,
      currentSceneId: "s1",
      rawDiagnostics: [],
      lastSceneText: "テスト——です",
    });

    const s1 = useLintProjectStore
      .getState()
      .scenes.find((s) => s.sceneId === "s1")!;
    expect(s1.diagnostics).toEqual([dashDiag]);
  });
});
