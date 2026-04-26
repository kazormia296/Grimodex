// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { ForeshadowSetupMark } from "./marks/ForeshadowSetupMark";
import { ForeshadowPayoffMark } from "./marks/ForeshadowPayoffMark";

// vi.mock() is hoisted — use vi.hoisted() so the refs are available in the factory
const { mockFrom, mockInvoke } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockInvoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/db/client", () => ({
  db: {
    select: vi.fn(() => ({ from: mockFrom })),
    insert: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/lib/tauri", () => ({
  invoke: mockInvoke,
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return { ...actual };
});

import {
  extractSetupAnchors,
  extractPayoffAnchors,
  saveForeshadowAnchors,
} from "./saveAnchors";

function createTestEditor(content = "<p>テスト</p>") {
  return new Editor({
    extensions: [StarterKit, ForeshadowSetupMark, ForeshadowPayoffMark],
    content,
  });
}

describe("extractSetupAnchors", () => {
  let editor: Editor;

  beforeEach(() => {
    editor = createTestEditor();
  });

  it("returns empty array when no setup marks present", () => {
    const result = extractSetupAnchors("scene-1", editor.state.doc);
    expect(result).toEqual([]);
  });

  it("extracts setup mark with correct positions and attrs", () => {
    editor.chain().focus().setContent("<p>前振りテキスト</p>").run();
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        const setupMarkType = editor.schema.marks["foreshadowSetup"];
        const from = 1;
        const to = editor.state.doc.content.size - 1;
        tr.addMark(
          from,
          to,
          setupMarkType.create({ setupId: "s-001", foreshadowId: "f-001" }),
        );
        return true;
      })
      .run();

    const result = extractSetupAnchors("scene-1", editor.state.doc);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("s-001");
    expect(result[0].foreshadowId).toBe("f-001");
    expect(result[0].sceneId).toBe("scene-1");
    expect(result[0].fromPos).toBeGreaterThanOrEqual(1);
    expect(result[0].toPos).toBeGreaterThan(result[0].fromPos);
    editor.destroy();
  });

  it("extracts multiple setup marks", () => {
    editor.chain().focus().setContent("<p>テキストA</p><p>テキストB</p>").run();
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        const setupMarkType = editor.schema.marks["foreshadowSetup"];
        tr.addMark(
          1,
          5,
          setupMarkType.create({ setupId: "s-A", foreshadowId: "f-1" }),
        );
        tr.addMark(
          9,
          14,
          setupMarkType.create({ setupId: "s-B", foreshadowId: "f-2" }),
        );
        return true;
      })
      .run();

    const result = extractSetupAnchors("scene-2", editor.state.doc);
    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.id);
    expect(ids).toContain("s-A");
    expect(ids).toContain("s-B");
    editor.destroy();
  });
});

describe("extractPayoffAnchors", () => {
  let editor: Editor;

  beforeEach(() => {
    editor = createTestEditor();
  });

  it("returns empty array when no payoff marks present", () => {
    const result = extractPayoffAnchors("scene-1", editor.state.doc);
    expect(result).toEqual([]);
  });

  it("extracts payoff mark with correct positions and foreshadowId", () => {
    editor.chain().focus().setContent("<p>回収テキスト</p>").run();
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        const payoffMarkType = editor.schema.marks["foreshadowPayoff"];
        const from = 1;
        const to = editor.state.doc.content.size - 1;
        tr.addMark(
          from,
          to,
          payoffMarkType.create({ foreshadowId: "f-payoff" }),
        );
        return true;
      })
      .run();

    const result = extractPayoffAnchors("scene-1", editor.state.doc);
    expect(result).toHaveLength(1);
    expect(result[0].foreshadowId).toBe("f-payoff");
    expect(result[0].sceneId).toBe("scene-1");
    expect(result[0].fromPos).toBeGreaterThanOrEqual(1);
    expect(result[0].toPos).toBeGreaterThan(result[0].fromPos);
    editor.destroy();
  });
});

// ── saveForeshadowAnchors — FK sweep ─────────────────────────────────

describe("saveForeshadowAnchors FK sweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(undefined);
  });

  function addSetupMark(
    editor: Editor,
    from: number,
    to: number,
    setupId: string,
    foreshadowId: string,
  ) {
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        const markType = editor.schema.marks["foreshadowSetup"];
        tr.addMark(from, to, markType.create({ setupId, foreshadowId }));
        return true;
      })
      .run();
  }

  it("includes setup mark for existing foreshadow in batch", async () => {
    // Only f-valid exists in the DB
    mockFrom.mockResolvedValue([{ id: "f-valid" }]);

    const editor = createTestEditor("<p>前振り</p>");
    addSetupMark(editor, 1, 3, "s-1", "f-valid");

    await saveForeshadowAnchors("scene-1", editor.state.doc);

    expect(mockInvoke).toHaveBeenCalledOnce();
    const payload = mockInvoke.mock.calls[0][1] as {
      setups: Array<{ id: string }>;
    };
    expect(payload.setups.some((s) => s.id === "s-1")).toBe(true);
    editor.destroy();
  });

  it("filters out setup mark for deleted foreshadow — no UPSERT with that id in batch", async () => {
    // f-deleted is NOT in the DB
    mockFrom.mockResolvedValue([{ id: "f-other" }]);

    const editor = createTestEditor("<p>前振り</p>");
    addSetupMark(editor, 1, 3, "s-deleted", "f-deleted");

    await saveForeshadowAnchors("scene-1", editor.state.doc);

    expect(mockInvoke).toHaveBeenCalledOnce();
    const payload = mockInvoke.mock.calls[0][1] as {
      setups: Array<{ id: string; foreshadowId: string }>;
    };
    const hasDeleted = payload.setups.some(
      (s) => s.id === "s-deleted" || s.foreshadowId === "f-deleted",
    );
    expect(hasDeleted).toBe(false);
    editor.destroy();
  });

  it("mixed marks: only valid foreshadow's setup appears in UPSERT", async () => {
    // Only f-valid exists
    mockFrom.mockResolvedValue([{ id: "f-valid" }]);

    const editor = createTestEditor("<p>テキストAテキストB</p>");
    addSetupMark(editor, 1, 4, "s-valid", "f-valid");
    addSetupMark(editor, 5, 8, "s-gone", "f-gone");

    await saveForeshadowAnchors("scene-1", editor.state.doc);

    const payload = mockInvoke.mock.calls[0][1] as {
      setups: Array<{ id: string }>;
    };
    const hasValid = payload.setups.some((s) => s.id === "s-valid");
    const hasGone = payload.setups.some((s) => s.id === "s-gone");
    expect(hasValid).toBe(true);
    expect(hasGone).toBe(false);
    editor.destroy();
  });
});
