/**
 * あらすじ欄と意図(狙い)欄の左端整列を実 Chromium で gate する幾何 invariant テスト。
 *
 * happy-dom は flex/box の実寸を計算しないため、px-3 の body 直下で両テキストエリアが
 * 同じインセットへ揃うことは単体テストでは測れない。かつて SynopsisArea が自前の
 * 外枠 `border-t p-2` を持ち込み、意図欄より 8px 内側へズレていた（bare 化で解消）。
 * その回帰を CI で永続的にガードする。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { SynopsisHeader } from "./SynopsisHeader";
import { useTreeStore } from "@/features/tree/treeStore";

const NODE_DEFAULTS = {
  projectId: "p",
  parentId: null as null,
  sortOrder: "a1",
  status: null as null,
  synopsis: "あらすじ本文" as string | null,
  intent: "狙い本文" as string | null,
  storyTimeOrder: null as string | null,
  storyTimeLabel: null as string | null,
  povCharacterId: null as string | null,
  locationId: null as string | null,
  createdAt: "2024-01-01T00:00:00Z",
  charCount: 0,
  updatedAt: "2024-01-01T00:00:00Z",
};

beforeEach(() => {
  useTreeStore.setState({
    nodes: [
      { ...NODE_DEFAULTS, id: "s1", nodeType: "scene", title: "テストシーン" },
    ],
  });
});

describe("SynopsisHeader — あらすじ欄と意図欄の左端整列 (幾何 invariant)", () => {
  it("両テキストエリアが同じ左右インセットへ揃う", () => {
    const { getByTestId } = render(
      <div style={{ width: 320 }}>
        <SynopsisHeader sceneId="s1" />
      </div>,
    );
    const syn = getByTestId("synopsis-field").querySelector("textarea");
    const intent = getByTestId("intent-field").querySelector("textarea");
    expect(syn).not.toBeNull();
    expect(intent).not.toBeNull();

    const a = syn!.getBoundingClientRect();
    const b = intent!.getBoundingClientRect();
    // 幅 0 の潰れではない（実測できている前提）。
    expect(a.width).toBeGreaterThan(0);
    expect(b.width).toBeGreaterThan(0);
    // 左端・右端が一致すること（過去の 8px ズレ回帰を検出）。
    expect(Math.abs(a.left - b.left)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(a.right - b.right)).toBeLessThanOrEqual(0.5);
  });
});
