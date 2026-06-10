// @vitest-environment happy-dom
//
// 設計書 §10 の不変条件テスト:
// 1. 制限状態 (trial_expired / license_stale / revoked) で write 系 store
//    アクションが拒否され、IPC に到達しない。
// 2. エクスポートは制限状態でも動く (原則 1「原稿を人質に取らない」の機械的
//    保証 — 最重要)。export 経路が将来ライセンスゲートと結合したら落ちる。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/i18n", () => ({ default: { t: (k: string) => k } }));

import { invoke } from "@/lib/tauri";
import { useLicenseStore } from "./store";
import { useTreeStore } from "@/features/tree/treeStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useProjectStore } from "@/features/project/projectStore";
import {
  generateExport,
  renderPmDocToMarkdown,
} from "@/features/export/exportEngine";
import { DEFAULT_EXPORT_SETTINGS } from "@/features/export/types";
import type { TreeNodeData } from "@/features/tree/treeStore";

const mockInvoke = vi.mocked(invoke);

function setRestricted() {
  useLicenseStore.setState({
    licensingEnabled: true,
    status: "trial_expired",
    initialized: true,
  });
}

function resetLicense() {
  useLicenseStore.setState({
    licensingEnabled: false,
    status: "disabled",
    initialized: false,
  });
}

describe("license/gateEnforcement: 制限状態で write 系が拒否される", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRestricted();
  });
  afterEach(() => {
    resetLicense();
  });

  it("treeStore の作成系 3 メソッドは throw し IPC に到達しない", async () => {
    const tree = useTreeStore.getState();
    await expect(tree.createScene()).rejects.toThrow();
    await expect(tree.createNote()).rejects.toThrow();
    await expect(
      tree.createNode({ nodeType: "scene", parentId: null }),
    ).rejects.toThrow();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("snippetStore.create は throw し IPC に到達しない", async () => {
    await expect(
      useSnippetStore.getState().create({ title: "t", content: "{}" }),
    ).rejects.toThrow();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("codexStore.create は throw し IPC に到達しない", async () => {
    await expect(
      useCodexStore.getState().create({ type: "character", name: "n" }),
    ).rejects.toThrow();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("projectStore.createNewProject は throw し IPC に到達しない", async () => {
    await expect(
      useProjectStore.getState().createNewProject({
        title: "t",
        genre: "",
        language: "",
        pov: "",
        tense: "",
      }),
    ).rejects.toThrow();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("beatOperations は制限状態で editor に一切触れない (editable 迂回の回帰)", async () => {
    // TipTap の editable:false は commands/dispatch を止めないため、Beat の
    // 配置・移動・削除はモジュール先頭の一括ゲートで塞ぐ (レビュー確定指摘)。
    const { placeBeatAtEnd, moveBeatToPosition, unplaceBeat, deleteBeatOnly } =
      await import("@/features/editor/beat/beatOperations");
    const untouchable = new Proxy(
      {},
      {
        get() {
          throw new Error("制限中に editor へ触れてはならない");
        },
      },
    ) as never;
    expect(
      placeBeatAtEnd(untouchable, "s1", {
        id: "b1",
        beatType: "free",
        pov: null,
        collapsed: false,
        content: [],
      }),
    ).toBe(false);
    expect(moveBeatToPosition(untouchable, "b1", 0)).toBe(false);
    expect(unplaceBeat(untouchable, "b1", "s1")).toBe(false);
    expect(deleteBeatOnly(untouchable, "b1")).toBe(false);
  });

  it("非制限 (trial) なら treeStore のゲートは素通りする", async () => {
    useLicenseStore.setState({ licensingEnabled: true, status: "trial" });
    // ゲートを抜けた先で IPC (モック) に到達することだけ確認する。
    mockInvoke.mockResolvedValue([]);
    await useTreeStore
      .getState()
      .createNode({ nodeType: "scene", parentId: null })
      .catch(() => {
        // ゲート以外の理由 (ストア未初期化等) の失敗は許容 — ここで見たいのは
        // 「ゲートで止まらず先へ進んだ」ことだけ。
      });
    expect(mockInvoke).toHaveBeenCalled();
  });
});

describe("license/gateEnforcement: エクスポートは制限状態でも動く (最重要)", () => {
  beforeEach(() => {
    setRestricted();
  });
  afterEach(() => {
    resetLicense();
  });

  function makeScene(id: string, title: string): TreeNodeData {
    return {
      id,
      projectId: "p1",
      parentId: null,
      nodeType: "scene",
      title,
      synopsis: null,
      intent: null,
      sortOrder: "a0",
      status: null,
      storyTimeOrder: null,
      storyTimeLabel: null,
      povCharacterId: null,
      locationId: null,
      createdAt: "2024-01-01T00:00:00Z",
      charCount: 0,
      updatedAt: "2024-01-01T00:00:00Z",
    } as TreeNodeData;
  }

  const docJson = JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "制限中でも書き出せる本文" }],
      },
    ],
  });

  it("generateExport は制限状態でも本文を出力する", () => {
    const result = generateExport({
      nodes: [makeScene("s1", "シーン1")],
      contentMap: { s1: docJson },
      checkedIds: new Set(["s1"]),
      settings: { ...DEFAULT_EXPORT_SETTINGS },
    });
    expect(result).toContain("制限中でも書き出せる本文");
  });

  it("renderPmDocToMarkdown は制限状態でも変換する", () => {
    const md = renderPmDocToMarkdown(docJson);
    expect(md).toContain("制限中でも書き出せる本文");
  });
});
