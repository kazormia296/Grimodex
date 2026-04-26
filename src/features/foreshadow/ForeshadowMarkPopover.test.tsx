// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";

const { mockLoad, mockCreate, ALL_LABEL_ITEMS } = vi.hoisted(() => {
  const mockLoad = vi.fn().mockResolvedValue(undefined);
  const mockCreate = vi.fn();
  const ALL_LABEL_ITEMS = [
    {
      id: "f-planned",
      projectId: "p",
      title: "計画中の伏線",
      label: "planned",
      setupCount: 0,
      intent: null,
      notes: null,
      payoffSceneId: null,
      payoffFromPos: null,
      payoffToPos: null,
      payoffConfirmed: false,
      abandoned: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: "f-seeded",
      projectId: "p",
      title: "播種済みの伏線",
      label: "seeded",
      setupCount: 1,
      intent: null,
      notes: null,
      payoffSceneId: null,
      payoffFromPos: null,
      payoffToPos: null,
      payoffConfirmed: false,
      abandoned: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: "f-seeded-anchored",
      projectId: "p",
      title: "播種済みだが回収先あり",
      label: "seeded",
      setupCount: 1,
      intent: null,
      notes: null,
      payoffSceneId: "scene-55",
      payoffFromPos: 2,
      payoffToPos: 12,
      payoffConfirmed: false,
      abandoned: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: "f-paid",
      projectId: "p",
      title: "回収済みの伏線",
      label: "paid",
      setupCount: 1,
      intent: null,
      notes: null,
      payoffSceneId: "scene-99",
      payoffFromPos: 0,
      payoffToPos: 10,
      payoffConfirmed: true,
      abandoned: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: "f-needs",
      projectId: "p",
      title: "強化が必要な伏線",
      label: "needs_strengthening",
      setupCount: 1,
      intent: null,
      notes: null,
      payoffSceneId: null,
      payoffFromPos: null,
      payoffToPos: null,
      payoffConfirmed: false,
      abandoned: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: "f-orphan",
      projectId: "p",
      title: "孤立した回収",
      label: "orphan_payoff",
      setupCount: 0,
      intent: null,
      notes: null,
      payoffSceneId: "scene-99",
      payoffFromPos: 0,
      payoffToPos: 10,
      payoffConfirmed: false,
      abandoned: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: "f-abandoned",
      projectId: "p",
      title: "放棄された伏線",
      label: "abandoned",
      setupCount: 0,
      intent: null,
      notes: null,
      payoffSceneId: null,
      payoffFromPos: null,
      payoffToPos: null,
      payoffConfirmed: false,
      abandoned: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];
  return { mockLoad, mockCreate, ALL_LABEL_ITEMS };
});

vi.mock("./foreshadowStore", () => {
  const state = {
    items: ALL_LABEL_ITEMS,
    isLoading: false,
    load: mockLoad,
    create: mockCreate,
  };
  const useForeshadowStore = Object.assign(() => state, {
    getState: () => state,
  });
  return { useForeshadowStore };
});

import { ForeshadowMarkPopover } from "./ForeshadowMarkPopover";

function makeEditor(): Editor {
  return {
    state: {
      selection: { from: 0, to: 5 },
    },
    view: {
      coordsAtPos: () => ({ left: 100, bottom: 200, top: 180, right: 110 }),
    },
    commands: { focus: vi.fn() },
  } as unknown as Editor;
}

describe("ForeshadowMarkPopover - payoff-unanchored フィルタ", () => {
  const editor = makeEditor();

  beforeEach(() => {
    useCursorSettingsStore.setState({
      foreshadowPickerOpen: true,
      foreshadowPickerInitialMode: "payoff-unanchored",
    });
  });

  afterEach(() => {
    useCursorSettingsStore.setState({
      foreshadowPickerOpen: false,
      foreshadowPickerInitialMode: null,
    });
  });

  it("planned と seeded のアイテムだけ表示される", async () => {
    render(<ForeshadowMarkPopover editor={editor} />);

    await waitFor(() => {
      expect(screen.getByText("計画中の伏線")).toBeInTheDocument();
      expect(screen.getByText("播種済みの伏線")).toBeInTheDocument();
    });
  });

  it("paid / needs_strengthening / orphan_payoff / abandoned のアイテムは表示されない", async () => {
    render(<ForeshadowMarkPopover editor={editor} />);

    await waitFor(() => {
      expect(screen.getByText("計画中の伏線")).toBeInTheDocument();
    });

    expect(screen.queryByText("回収済みの伏線")).not.toBeInTheDocument();
    expect(
      screen.queryByText("播種済みだが回収先あり"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("強化が必要な伏線")).not.toBeInTheDocument();
    expect(screen.queryByText("孤立した回収")).not.toBeInTheDocument();
    expect(screen.queryByText("放棄された伏線")).not.toBeInTheDocument();
  });

  it("「新規伏線を作成して追加」ボタンが表示されない", async () => {
    render(<ForeshadowMarkPopover editor={editor} />);

    await waitFor(() => {
      expect(screen.getByText("計画中の伏線")).toBeInTheDocument();
    });

    expect(
      screen.queryByText("新規伏線を作成して追加"),
    ).not.toBeInTheDocument();
  });
});

describe("ForeshadowMarkPopover - setup モードはフィルタしない", () => {
  const editor = makeEditor();

  afterEach(() => {
    useCursorSettingsStore.setState({
      foreshadowPickerOpen: false,
      foreshadowPickerInitialMode: null,
    });
  });

  it("setup モードでは全ラベルのアイテムが表示される", async () => {
    useCursorSettingsStore.setState({
      foreshadowPickerOpen: true,
      foreshadowPickerInitialMode: "setup",
    });

    render(<ForeshadowMarkPopover editor={editor} />);

    await waitFor(() => {
      expect(screen.getByText("計画中の伏線")).toBeInTheDocument();
      expect(screen.getByText("回収済みの伏線")).toBeInTheDocument();
      expect(screen.getByText("放棄された伏線")).toBeInTheDocument();
    });
  });

  it("setup モードでは「新規伏線を作成して追加」ボタンが表示される", async () => {
    useCursorSettingsStore.setState({
      foreshadowPickerOpen: true,
      foreshadowPickerInitialMode: "setup",
    });

    render(<ForeshadowMarkPopover editor={editor} />);

    await waitFor(() => {
      expect(screen.getByText("新規伏線を作成して追加")).toBeInTheDocument();
    });
  });
});
