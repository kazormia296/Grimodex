/**
 * `acceptsMatrix` の純関数テスト (設計書 §5-C のマトリクス)。
 * dispatch の方は restorers が DB を触るので unit test は restorers 側に委ねる。
 */
import { describe, expect, it } from "vitest";
import { acceptsMatrix } from "./pickupHandlers";
import type { DropTargetKind } from "@/store/dropTargetRegistry";
import type { TrashSubKind } from "./types";

describe("acceptsMatrix", () => {
  // 設計書 §5-C のマトリクスをそのままテスト化
  type Cell = { target: DropTargetKind; sub: TrashSubKind; expect: boolean };
  const cells: Cell[] = [
    // text-fragment は editor 系 / snippets / map で受け入れ
    { target: "scene-editor", sub: "text-fragment", expect: true },
    { target: "snippets-panel", sub: "text-fragment", expect: true },
    { target: "map-panel", sub: "text-fragment", expect: true },
    { target: "scenes-panel", sub: "text-fragment", expect: false },
    { target: "codex-panel", sub: "text-fragment", expect: false },
    { target: "foreshadow-panel", sub: "text-fragment", expect: false },

    // scene → エディタ + scenes パネルのみ
    { target: "scenes-panel", sub: "scene", expect: true },
    { target: "scene-editor", sub: "scene", expect: true },
    { target: "codex-panel", sub: "scene", expect: false },

    // codex-entry → エディタ + codex パネル + map (sticky 化)
    { target: "codex-panel", sub: "codex-entry", expect: true },
    { target: "scene-editor", sub: "codex-entry", expect: true },
    { target: "map-panel", sub: "codex-entry", expect: true },
    { target: "scenes-panel", sub: "codex-entry", expect: false },

    // snippet → snippets パネル + エディタ
    { target: "snippets-panel", sub: "snippet", expect: true },
    { target: "scene-editor", sub: "snippet", expect: true },
    { target: "map-panel", sub: "snippet", expect: false },

    // map-sticky → map パネル + エディタ
    { target: "map-panel", sub: "map-sticky", expect: true },
    { target: "scene-editor", sub: "map-sticky", expect: true },
    { target: "snippets-panel", sub: "map-sticky", expect: false },

    // foreshadow → foreshadow パネル + エディタ
    { target: "foreshadow-panel", sub: "foreshadow", expect: true },
    { target: "scene-editor", sub: "foreshadow", expect: true },

    // grid-chapter → scenes パネル + エディタ
    { target: "scenes-panel", sub: "grid-chapter", expect: true },
    { target: "scene-editor", sub: "grid-chapter", expect: true },
    { target: "map-panel", sub: "grid-chapter", expect: false },
  ];

  for (const cell of cells) {
    it(`${cell.target} ${cell.expect ? "accepts" : "rejects"} ${cell.sub}`, () => {
      expect(acceptsMatrix(cell.target, cell.sub)).toBe(cell.expect);
    });
  }
});
