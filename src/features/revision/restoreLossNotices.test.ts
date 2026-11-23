import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import en from "../../locales/en.json";
import ja from "../../locales/ja.json";
import {
  describeRestoreLoss,
  KNOWN_RESTORE_LOSS_KINDS,
} from "./restoreLossNotices";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("describeRestoreLoss", () => {
  it("filters invalid counts, combines kinds, orders known kinds, and totals all losses", () => {
    expect(
      describeRestoreLoss([
        { kind: "scene_labels", count: 1 },
        { kind: "event_participants", count: 2 },
        { kind: "event_participants", count: 3 },
        { kind: "future_kind", count: 4 },
        { kind: "future_kind", count: 1 },
        { kind: "scene_scope_bindings_reset", count: 2 },
        { kind: "scene_scope_bindings_reset", count: 1 },
        { kind: "event_reveal_scene", count: 0 },
        { kind: "scene_codex_links", count: -1 },
        { kind: "scene_labels", count: 1.5 },
        { kind: "scene_labels", count: Number.NaN },
        { kind: "scene_labels", count: Number.POSITIVE_INFINITY },
      ]),
    ).toEqual({
      items: [
        { kind: "event_participants", count: 5 },
        { kind: "scene_labels", count: 1 },
      ],
      otherCount: 5,
      resetCount: 3,
      lostCount: 11,
      total: 14,
    });
  });

  it("returns an empty summary for missing or empty notices", () => {
    const empty = {
      items: [],
      otherCount: 0,
      resetCount: 0,
      lostCount: 0,
      total: 0,
    };
    expect(describeRestoreLoss(undefined)).toEqual(empty);
    expect(describeRestoreLoss([])).toEqual(empty);
  });

  it("matches Rust KIND_ORDER and has localized names for every kind", () => {
    const source = readFileSync(
      resolve(
        REPO_ROOT,
        "src-tauri/crates/grimodex-db/src/project_snapshots/restore_links.rs",
      ),
      "utf8",
    );
    const order = source.match(
      /pub\(super\) const KIND_ORDER:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\n\];/u,
    )?.[1];
    expect(order).toBeDefined();
    const rustKinds = [...order!.matchAll(/"([^"]+)"/gu)].map(
      (match) => match[1],
    );
    expect(KNOWN_RESTORE_LOSS_KINDS).toEqual(rustKinds);

    const translatedKinds = KNOWN_RESTORE_LOSS_KINDS.filter(
      (kind) => kind !== "scene_scope_bindings_reset",
    );
    expect(Object.keys(ja.snapshot.loss)).toEqual(
      Object.keys(en.snapshot.loss),
    );
    expect(Object.keys(ja.snapshot.loss.kind)).toEqual(
      Object.keys(en.snapshot.loss.kind),
    );
    for (const locale of [ja, en]) {
      const loss = (locale as { snapshot: { loss: Record<string, unknown> } })
        .snapshot.loss;
      const names = loss.kind as Record<string, unknown>;
      expect(Object.keys(names)).toEqual(translatedKinds);
      for (const kind of translatedKinds) expect(names[kind]).toBeTruthy();
      expect(loss.resetPreview_one).toBeTruthy();
      expect(loss.resetPreview_other).toBeTruthy();
      expect(loss.resetResult_one).toBeTruthy();
      expect(loss.resetResult_other).toBeTruthy();
      expect(loss.previewResetHeading).toBeTruthy();
      expect(loss.resultResetOnlyDescription).toBeTruthy();
    }
    expect(ja.snapshot.loss.kind.trash_items).toBe(
      "ごみ箱の項目の元の場面・コーデックス",
    );
    expect(en.snapshot.loss.kind.trash_items).toBe(
      "Trash item source scenes and Codex entries",
    );
  });
});
