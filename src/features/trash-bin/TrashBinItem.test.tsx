// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { TrashBinItem } from "./TrashBinItem";
import type { TrashItemData, TrashSubKind } from "./types";

function makeItem(
  subKind: TrashSubKind,
  overrides: Partial<TrashItemData> = {},
): TrashItemData {
  return {
    id: `id-${subKind}`,
    projectId: "p",
    kind: subKind === "text-fragment" ? "text-fragment" : "structure-item",
    subKind,
    originSceneId: null,
    originCodexId: null,
    previewText: `preview-${subKind}`,
    previewMeta: null,
    payload: subKind === "text-fragment" ? { text: "preview", spans: [] } : {},
    charCount: 7,
    isInteresting: false,
    deletedAt: new Date().toISOString(),
    ...overrides,
  } as TrashItemData;
}

describe("TrashBinItem subKind dispatch", () => {
  it("text-fragment は font-mono の box にレンダリング", () => {
    const { container } = render(
      <TrashBinItem item={makeItem("text-fragment")} registerNode={vi.fn()} />,
    );
    const el = container.querySelector('[data-subkind="text-fragment"]');
    expect(el).not.toBeNull();
    expect(el!.className).toContain("font-mono");
  });

  it("scene は SceneTrashItem (folder hint chip 含む)", () => {
    const item = makeItem("scene", {
      previewText: "夜の散歩",
      previewMeta: { folderName: "Chapter 1", bodyPreview: "本文..." },
    });
    const { container } = render(
      <TrashBinItem item={item} registerNode={vi.fn()} />,
    );
    expect(container.querySelector('[data-subkind="scene"]')).not.toBeNull();
    expect(container.textContent).toContain("夜の散歩");
    expect(container.textContent).toContain("Chapter 1");
    expect(container.textContent).toContain("本文...");
  });

  it("codex-entry は CodexTrashItem (緑系背景 + アイコン)", () => {
    const item = makeItem("codex-entry", {
      previewText: "ミレー",
      previewMeta: { categoryLabel: "人物", iconName: "User" },
    });
    const { container } = render(
      <TrashBinItem item={item} registerNode={vi.fn()} />,
    );
    const el = container.querySelector('[data-subkind="codex-entry"]');
    expect(el).not.toBeNull();
    expect(el!.className).toMatch(/emerald/);
    expect(container.textContent).toContain("ミレー");
    expect(container.textContent).toContain("人物");
  });

  it("snippet は SnippetTrashItem (タグ chip 含む)", () => {
    const item = makeItem("snippet", {
      previewText: "メモ",
      previewMeta: {
        bodyPreview: "本文プレビュー",
        tagsCache: '[{"name":"foo","color":"#aa0000"}]',
      },
    });
    const { container } = render(
      <TrashBinItem item={item} registerNode={vi.fn()} />,
    );
    expect(container.querySelector('[data-subkind="snippet"]')).not.toBeNull();
    expect(container.textContent).toContain("メモ");
    expect(container.textContent).toContain("foo");
  });

  it("未対応 subKind はフォールバック box でレンダリング", () => {
    const item = makeItem("map-sticky", { previewText: "sticky" });
    const { container } = render(
      <TrashBinItem item={item} registerNode={vi.fn()} />,
    );
    const el = container.querySelector('[data-subkind="map-sticky"]');
    expect(el).not.toBeNull();
    expect(container.textContent).toContain("sticky");
  });

  it("registerNode は item.id と DOM 要素で呼ばれる", () => {
    const registerNode = vi.fn();
    render(
      <TrashBinItem
        item={makeItem("scene", { id: "scene-1" })}
        registerNode={registerNode}
      />,
    );
    expect(registerNode).toHaveBeenCalledWith(
      "scene-1",
      expect.any(HTMLElement),
    );
  });
});
