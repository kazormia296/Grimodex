import { describe, it, expect } from "vitest";
import "@/lib/i18n";
import {
  formatEventCaption,
  collectOpenPanels,
  docStepEntityKeys,
  entityKeyForEvent,
  parseEventPayload,
} from "./formatEventCaption";
import type { BodyDiff } from "./bodyDiff";

const base = {
  domain: "codex" as const,
  opType: "entry.update",
  entityId: "e1",
  payload: "{}",
};

describe("formatEventCaption", () => {
  it("returns null for editor scene doc.step", () => {
    expect(
      formatEventCaption({
        domain: "editor",
        opType: "doc.step",
        entityId: "s1",
        payload: "{}",
      }),
    ).toBeNull();
  });

  it("formats codex doc.step as editing label", () => {
    const cap = formatEventCaption({
      domain: "codex",
      opType: "doc.step",
      entityId: "e1",
      payload: "{}",
    });
    expect(cap?.segments[0].text).toMatch(/Codex|コーデックス/i);
  });

  it("formats entry.update with diffs", () => {
    const diffs: Record<string, BodyDiff> = {
      summary: { segments: [[-1, "old"], [1, "new"]] },
    };
    const cap = formatEventCaption({
      ...base,
      payload: JSON.stringify({ fields: ["summary"], diffs }),
    });
    expect(cap).not.toBeNull();
    expect(cap!.segments.some((s) => s.kind === "del" && s.text === "old")).toBe(
      true,
    );
    expect(cap!.segments.some((s) => s.kind === "add" && s.text === "new")).toBe(
      true,
    );
  });

  it("formats structural entry.update (fields only)", () => {
    const cap = formatEventCaption({
      ...base,
      payload: JSON.stringify({ fields: ["name", "icon"] }),
    });
    expect(cap?.segments[0].text).toMatch(/name|icon/i);
  });

  it("formats snippet.update with diffs", () => {
    const cap = formatEventCaption({
      domain: "snippet",
      opType: "snippet.update",
      entityId: "s1",
      payload: JSON.stringify({
        fields: ["content"],
        diffs: { content: { segments: [[1, "hello"]] } },
      }),
    });
    expect(cap?.segments.some((s) => s.kind === "add")).toBe(true);
  });

  it("formats sticky.update with body diff", () => {
    const cap = formatEventCaption({
      domain: "map",
      opType: "sticky.update",
      entityId: "st1",
      payload: JSON.stringify({
        fields: ["body"],
        diffs: { body: { segments: [[1, "note"]] } },
      }),
    });
    expect(cap?.segments.some((s) => s.text.includes("note"))).toBe(true);
  });

  it("formats chat.message.add", () => {
    const cap = formatEventCaption({
      domain: "chat",
      opType: "chat.message.add",
      entityId: "m1",
      payload: JSON.stringify({
        role: "user",
        text: "Hello world",
        sessionId: "sess",
      }),
    });
    expect(cap?.segments[0].text).toMatch(/user|ユーザー/i);
    expect(cap?.segments[0].text).toContain("Hello");
  });

  it("formats chat.message.delete", () => {
    const cap = formatEventCaption({
      domain: "chat",
      opType: "chat.message.delete",
      entityId: "m1",
      payload: JSON.stringify({ messageId: "m1" }),
    });
    expect(cap?.segments[0].text).toMatch(/delete|削除/i);
  });

  it("formats layout.snapshot with panel diff", () => {
    const payload = {
      layout: {
        regions: {
          left: {
            slots: [{ activePanel: "map" }],
          },
        },
        center: { editorOpen: true, segments: [] },
      },
    };
    const cap = formatEventCaption(
      {
        domain: "layout",
        opType: "layout.snapshot",
        entityId: "workspace",
        payload: JSON.stringify(payload),
      },
      { prevLayoutPanels: [] },
    );
    expect(cap?.segments[0].text).toMatch(/map|editor/i);
  });

  it("returns null for unknown opType", () => {
    expect(
      formatEventCaption({
        domain: "synopsis",
        opType: "future.op",
        entityId: null,
        payload: "{}",
      }),
    ).toBeNull();
  });
});

describe("docStepEntityKeys", () => {
  it("collects codex/snippet doc.step keys", () => {
    const keys = docStepEntityKeys([
      {
        domain: "codex",
        opType: "doc.step",
        entityId: "c1",
      },
      {
        domain: "snippet",
        opType: "doc.step",
        entityId: "s1",
      },
    ]);
    expect(keys).toEqual(new Set(["codex:c1", "snippet:s1"]));
  });
});

describe("collectOpenPanels", () => {
  it("reads active panels from layout payload", () => {
    const panels = collectOpenPanels(
      parseEventPayload({
        payload: JSON.stringify({
          layout: {
            regions: { left: { slots: [{ activePanel: "codex" }] } },
            center: { editorOpen: true, segments: [] },
          },
        }),
      }),
    );
    expect(panels).toContain("codex");
    expect(panels).toContain("editor");
  });
});

describe("entityKeyForEvent", () => {
  it("returns codex key for codex doc.step", () => {
    expect(
      entityKeyForEvent({
        domain: "codex",
        opType: "doc.step",
        entityId: "x",
      }),
    ).toBe("codex:x");
  });
});
