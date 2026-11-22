// MP-4b PR-8a: the pure decision of which Codex entries the AI may see.
// Relative imports only (the electron vitest config has no `@` alias).
import { describe, expect, it } from "vitest";

import type { CodexEntryPhase } from "../../../db/schema.js";
import type { TreeNodeData } from "../../tree/types.js";
import {
  decideCodexAiVisibility,
  type CodexResolutionState,
} from "./codexAiVisibility.js";
import { buildSceneTimeIndex } from "./sceneTimeIndex.js";

const NOW = "2026-01-01T00:00:00.000Z";

const scene = (
  id: string,
  sortOrder: string,
  storyTimeOrder: string | null = null,
): TreeNodeData => ({
  id,
  projectId: "p",
  parentId: null,
  nodeType: "scene",
  title: id,
  synopsis: null,
  intent: null,
  sortOrder,
  status: null,
  storyTimeOrder,
  storyTimeLabel: null,
  povCharacterId: null,
  locationId: null,
  charCount: 0,
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
});

/** Reading order s1 < s2 < s3. Story time: s3 (a2) is before s2 (a3). */
const FULL_STORY = [
  scene("s1", "a0", "a1"),
  scene("s2", "a1", "a3"),
  scene("s3", "a2", "a2"),
];
const NO_STORY = [scene("s1", "a0"), scene("s2", "a1"), scene("s3", "a2")];

const phase = (
  id: string,
  entryId: string,
  anchorNodeId: string | null,
  over: Partial<CodexEntryPhase> = {},
): CodexEntryPhase => ({
  id,
  entryId,
  anchorNodeId,
  label: id,
  summaryOverride: null,
  contentOverride: null,
  contextModeOverride: null,
  createdAt: NOW,
  updatedAt: NOW,
  version: 0,
  ...over,
});

const entry = (id: string, contextMode: string) => ({
  id,
  summary: `${id} summary`,
  content: `${id} content`,
  contextMode,
});

const PUBLIC = entry("pub", "mentioned");
const HIDDEN = entry("hid", "hidden");
const UNKNOWN = entry("odd", "not-a-mode");

const resolved = (
  mode: "reading" | "story" | "auto",
): CodexResolutionState => ({ kind: "resolved", mode });

const decide = (over: {
  entries?: Array<ReturnType<typeof entry>>;
  phases?: CodexEntryPhase[];
  sceneId?: string | null | undefined;
  nodes?: TreeNodeData[];
  resolutionMode?: CodexResolutionState;
}) =>
  decideCodexAiVisibility({
    entries: over.entries ?? [PUBLIC, HIDDEN, UNKNOWN],
    phases: over.phases ?? [],
    sceneId: "sceneId" in over ? over.sceneId : "s1",
    sceneTimeIndex: buildSceneTimeIndex(over.nodes ?? NO_STORY),
    resolutionMode: over.resolutionMode ?? resolved("reading"),
  });

describe("decideCodexAiVisibility", () => {
  it("hides hidden entries and unknown modes, and gives the others their own text unchanged", () => {
    const r = decide({});
    expect([...r.hidden]).toEqual(["hid", "odd"]);
    expect([...r.texts.entries()]).toEqual([
      [
        "pub",
        {
          summary: "pub summary",
          content: "pub content",
          released: false,
          mode: "mentioned",
        },
      ],
    ]);
    expect(r.released).toEqual([]);
  });

  it("releases a hidden entry that a phase turns visible at the current scene, with the text after the phase", () => {
    const phases = [
      phase("ph", "hid", "s2", {
        contextModeOverride: "mentioned",
        summaryOverride: "after summary",
        contentOverride: "after content",
      }),
    ];
    const before = decide({ entries: [HIDDEN], phases, sceneId: "s1" });
    expect([...before.hidden]).toEqual(["hid"]);
    expect(before.released).toEqual([]);

    const at = decide({ entries: [HIDDEN], phases, sceneId: "s2" });
    expect([...at.hidden]).toEqual([]);
    expect(at.texts.get("hid")).toEqual({
      summary: "after summary",
      content: "after content",
      released: true,
      mode: "mentioned",
    });
    expect(at.released).toHaveLength(1);
    expect(at.released[0]!.id).toBe("hid");
  });

  it("keeps the entry objects it was given in `released` (identity)", () => {
    const hid = entry("hid", "hidden");
    const r = decideCodexAiVisibility({
      entries: [hid],
      phases: [phase("ph", "hid", "s1", { contextModeOverride: "mentioned" })],
      sceneId: "s1",
      sceneTimeIndex: buildSceneTimeIndex(NO_STORY),
      resolutionMode: resolved("reading"),
    });
    expect(r.released[0]).toBe(hid);
  });

  it("a phase that hides a public entry hides it from its scene on, and not before", () => {
    const phases = [
      phase("ph", "pub", "s2", { contextModeOverride: "hidden" }),
    ];
    expect([
      ...decide({ entries: [PUBLIC], phases, sceneId: "s1" }).hidden,
    ]).toEqual([]);
    expect([
      ...decide({ entries: [PUBLIC], phases, sceneId: "s2" }).hidden,
    ]).toEqual(["pub"]);
    expect([
      ...decide({ entries: [PUBLIC], phases, sceneId: "s3" }).hidden,
    ]).toEqual(["pub"]);
  });

  it("a visible entry whose phase changes the text but not the mode is not released (the base text stays)", () => {
    const phases = [
      phase("ph", "pub", "s1", {
        summaryOverride: "phase summary",
        contentOverride: "phase content",
        contextModeOverride: "suppress",
      }),
    ];
    const r = decide({ entries: [PUBLIC], phases, sceneId: "s2" });
    expect(r.texts.get("pub")).toEqual({
      summary: "pub summary",
      content: "pub content",
      released: false,
      mode: "suppress",
    });
  });

  it("a phase that turns a hidden entry to an unknown mode keeps it hidden", () => {
    const phases = [phase("ph", "hid", "s1", { contextModeOverride: "weird" })];
    expect([...decide({ entries: [HIDDEN], phases }).hidden]).toEqual(["hid"]);
  });

  describe("unresolved", () => {
    it("hides every entry it is given, whatever its own mode and its phases, and releases nothing", () => {
      const phases = [
        phase("ph", "hid", "s1", { contextModeOverride: "mentioned" }),
      ];
      for (const resolutionMode of [
        { kind: "unresolved" } as const,
        // A `ReadInputMode` carries a reason; it is not read.
        { kind: "unresolved", reason: "project-missing" } as const,
        { kind: "unresolved", reason: "mode-unknown" } as const,
      ]) {
        const r = decide({
          entries: [PUBLIC, HIDDEN, UNKNOWN],
          phases,
          sceneId: "s1",
          resolutionMode,
        });
        expect([...r.hidden]).toEqual(["pub", "hid", "odd"]);
        expect(r.texts.size).toBe(0);
        expect(r.released).toEqual([]);
      }
    });

    it("is not the base anchor: a public entry stays hidden even where no phase applies", () => {
      const r = decide({
        entries: [PUBLIC],
        sceneId: null,
        resolutionMode: { kind: "unresolved" },
      });
      expect([...r.hidden]).toEqual(["pub"]);
      expect(r.texts.size).toBe(0);
    });
  });

  describe("the anchor", () => {
    const phases = [
      phase("ph-hide", "pub", "s2", { contextModeOverride: "hidden" }),
      phase("ph-rel", "hid", "s2", { contextModeOverride: "mentioned" }),
    ];
    const baseResult = {
      hidden: ["hid"],
      visible: ["pub"],
    };

    it("no scene (null, undefined, empty, only spaces) is the base anchor: no phase applies", () => {
      for (const sceneId of [null, undefined, "", "   "]) {
        const r = decide({ entries: [PUBLIC, HIDDEN], phases, sceneId });
        expect([...r.hidden], String(sceneId)).toEqual(baseResult.hidden);
        expect([...r.texts.keys()], String(sceneId)).toEqual(
          baseResult.visible,
        );
        expect(r.anchor, String(sceneId)).toEqual({ kind: "base" });
      }
    });

    it("a scene that is not in the reading order: the anchor is still that scene, and no phase applies", () => {
      // DR-MP4-41 changed the visibility result for this input (see the next describe);
      // the anchor handed back to the caller is unchanged.
      const r = decide({
        entries: [PUBLIC, HIDDEN],
        phases,
        sceneId: "archived-or-missing",
      });
      expect(r.anchor).toEqual({
        kind: "scene",
        sceneId: "archived-or-missing",
      });
      // `hid` stays hidden: it is hidden at base and its phase (which would release it) does not apply.
      expect(r.hidden.has("hid")).toBe(true);
      expect(r.released).toEqual([]);
    });

    it("the scene id is trimmed", () => {
      const r = decide({ entries: [PUBLIC, HIDDEN], phases, sceneId: "  s2 " });
      expect([...r.hidden]).toEqual(["pub"]);
      expect(r.anchor).toEqual({ kind: "scene", sceneId: "s2" });
    });
  });

  describe("the resolution mode", () => {
    // The phase is at s3: after s2 in reading order, before it in story time.
    const phases = [
      phase("ph", "pub", "s3", { contextModeOverride: "hidden" }),
    ];
    const at = (mode: "reading" | "story" | "auto", nodes: TreeNodeData[]) => [
      ...decide({
        entries: [PUBLIC],
        phases,
        sceneId: "s2",
        nodes,
        resolutionMode: resolved(mode),
      }).hidden,
    ];

    it("reading orders by the reading order only", () => {
      expect(at("reading", FULL_STORY)).toEqual([]);
    });

    it("story and auto (every scene scheduled) order by story time", () => {
      expect(at("story", FULL_STORY)).toEqual(["pub"]);
      expect(at("auto", FULL_STORY)).toEqual(["pub"]);
    });

    it("auto falls back to the reading order when a scene has no story time of its own", () => {
      const partial = [
        scene("s1", "a0", "a1"),
        scene("s2", "a1", "a3"),
        scene("s3", "a2", "a2"),
        scene("s4", "a3"),
      ];
      expect(at("auto", partial)).toEqual([]);
      expect(at("story", partial)).toEqual(["pub"]);
    });
  });

  // DR-MP4-41 (a): a scene id is given but the reading order does not have it, so no
  // phase can be resolved. An entry that one of its phases hides is hidden (fail closed).
  describe("a scene that cannot be resolved (DR-MP4-41)", () => {
    const MISSING = "archived-or-missing";
    const hideLater = phase("ph-hide", "pub", "s2", {
      contextModeOverride: "hidden",
    });

    it("hides a public entry that a phase hides (it was visible before DR-MP4-41)", () => {
      const r = decide({
        entries: [PUBLIC],
        phases: [hideLater],
        sceneId: MISSING,
      });
      expect([...r.hidden]).toEqual(["pub"]);
      expect(r.texts.size).toBe(0);
      expect(r.released).toEqual([]);
    });

    it("hides it when the phase that hides it is not the only phase (any phase that hides)", () => {
      const r = decide({
        entries: [PUBLIC],
        phases: [
          phase("ph-a", "pub", "s1", { contextModeOverride: "always" }),
          phase("ph-b", "pub", "s2", { contextModeOverride: "hidden" }),
          phase("ph-c", "pub", "s3", { contextModeOverride: null }),
        ],
        sceneId: MISSING,
      });
      expect([...r.hidden]).toEqual(["pub"]);
    });

    it("hides it when the phase turns the mode to an unknown value (an unknown mode is hidden)", () => {
      const r = decide({
        entries: [PUBLIC],
        phases: [
          phase("ph", "pub", "s2", { contextModeOverride: "not-a-mode" }),
        ],
        sceneId: MISSING,
      });
      expect([...r.hidden]).toEqual(["pub"]);
    });

    it("keeps a hidden entry hidden when a phase would make it public", () => {
      const r = decide({
        entries: [HIDDEN],
        phases: [
          phase("ph", "hid", "s1", { contextModeOverride: "mentioned" }),
        ],
        sceneId: MISSING,
      });
      expect([...r.hidden]).toEqual(["hid"]);
      expect(r.released).toEqual([]);
    });

    it("leaves an entry with no phase as it was (public stays public)", () => {
      const r = decide({
        entries: [PUBLIC, HIDDEN, UNKNOWN],
        sceneId: MISSING,
      });
      expect([...r.hidden]).toEqual(["hid", "odd"]);
      expect([...r.texts.keys()]).toEqual(["pub"]);
    });

    it("leaves an entry whose phases hide nothing as it was (only text, or a visible mode, or null)", () => {
      const r = decide({
        entries: [PUBLIC],
        phases: [
          phase("ph-t", "pub", "s1", { summaryOverride: "new summary" }),
          phase("ph-m", "pub", "s2", { contextModeOverride: "suppress" }),
          phase("ph-n", "pub", "s3", { contextModeOverride: "always" }),
        ],
        sceneId: MISSING,
      });
      expect([...r.hidden]).toEqual([]);
      // The base text and mode stay: no phase applied.
      expect(r.texts.get("pub")).toEqual({
        summary: "pub summary",
        content: "pub content",
        released: false,
        mode: "mentioned",
      });
    });

    it("only the entry whose phase hides is hidden, the others in the same call are not", () => {
      const other = entry("other", "always");
      const r = decide({
        entries: [PUBLIC, other],
        phases: [hideLater],
        sceneId: MISSING,
      });
      expect([...r.hidden]).toEqual(["pub"]);
      expect([...r.texts.keys()]).toEqual(["other"]);
    });

    it("is decided by the scene being absent from the index, in every resolution mode", () => {
      for (const mode of ["reading", "story", "auto"] as const) {
        const r = decide({
          entries: [PUBLIC],
          phases: [hideLater],
          sceneId: MISSING,
          nodes: FULL_STORY,
          resolutionMode: resolved(mode),
        });
        expect([...r.hidden], mode).toEqual(["pub"]);
      }
    });

    it("trims the scene id first: a padded id of a scene in the index is resolved, and a padded missing one is not", () => {
      const inIndex = decide({
        entries: [PUBLIC],
        phases: [hideLater],
        sceneId: "  s1  ",
      });
      expect([...inIndex.hidden]).toEqual([]);
      const missing = decide({
        entries: [PUBLIC],
        phases: [hideLater],
        sceneId: "  nope  ",
      });
      expect([...missing.hidden]).toEqual(["pub"]);
    });

    it("no scene (null, undefined, empty, only spaces) is unchanged: base anchor, a phase that hides does not hide", () => {
      for (const sceneId of [null, undefined, "", "   "]) {
        const r = decide({ entries: [PUBLIC], phases: [hideLater], sceneId });
        expect([...r.hidden], String(sceneId)).toEqual([]);
        expect([...r.texts.keys()], String(sceneId)).toEqual(["pub"]);
      }
    });

    it("a scene that is in the index is unchanged: the phases are resolved as before", () => {
      const before = decide({
        entries: [PUBLIC],
        phases: [hideLater],
        sceneId: "s1",
      });
      expect([...before.hidden]).toEqual([]);
      const after = decide({
        entries: [PUBLIC],
        phases: [hideLater],
        sceneId: "s2",
      });
      expect([...after.hidden]).toEqual(["pub"]);
      const released = decide({
        entries: [HIDDEN],
        phases: [
          phase("ph", "hid", "s2", { contextModeOverride: "mentioned" }),
        ],
        sceneId: "s3",
      });
      expect([...released.hidden]).toEqual([]);
      expect(released.released).toEqual([HIDDEN]);
    });

    it("an empty reading order (index just reset) with a scene id is the unresolved case", () => {
      const r = decide({
        entries: [PUBLIC],
        phases: [hideLater],
        sceneId: "s2",
        nodes: [],
      });
      expect([...r.hidden]).toEqual(["pub"]);
    });

    it("with an unresolved resolution mode every entry is hidden, as before", () => {
      const r = decide({
        entries: [PUBLIC],
        sceneId: MISSING,
        resolutionMode: { kind: "unresolved" },
      });
      expect([...r.hidden]).toEqual(["pub"]);
    });
  });

  it("an entry with several phases is resolved with all of them (the order is the resolver's)", () => {
    const phases = [
      phase("ph-2", "hid", "s2", { contextModeOverride: "hidden" }),
      phase("ph-1", "hid", "s1", { contextModeOverride: "mentioned" }),
    ];
    expect([
      ...decide({ entries: [HIDDEN], phases, sceneId: "s1" }).hidden,
    ]).toEqual([]);
    expect([
      ...decide({ entries: [HIDDEN], phases, sceneId: "s2" }).hidden,
    ]).toEqual(["hid"]);
  });

  it("the tie of two phases at one scene and one time is broken by id, so the later id wins", () => {
    // The same created_at and the same anchor: ordered by id with localeCompare (K-4).
    const phases = [
      phase("ph-b", "hid", "s1", { contextModeOverride: "hidden" }),
      phase("ph-a", "hid", "s1", { contextModeOverride: "mentioned" }),
    ];
    expect([
      ...decide({ entries: [HIDDEN], phases, sceneId: "s1" }).hidden,
    ]).toEqual(["hid"]);
    const reversed = [
      phase("ph-b", "hid", "s1", { contextModeOverride: "mentioned" }),
      phase("ph-a", "hid", "s1", { contextModeOverride: "hidden" }),
    ];
    expect([
      ...decide({ entries: [HIDDEN], phases: reversed, sceneId: "s1" }).hidden,
    ]).toEqual([]);
  });

  it("does not change its input and returns fresh collections", () => {
    const entries = [PUBLIC, HIDDEN];
    const phases = [
      phase("ph", "pub", "s1", { contextModeOverride: "hidden" }),
    ];
    const before = JSON.stringify({ entries, phases });
    const a = decide({ entries, phases });
    const b = decide({ entries, phases });
    expect(JSON.stringify({ entries, phases })).toBe(before);
    expect(a.hidden).not.toBe(b.hidden);
    expect(a.texts).not.toBe(b.texts);
  });

  it("no entries is nothing hidden and nothing visible", () => {
    const r = decide({ entries: [] });
    expect(r.hidden.size).toBe(0);
    expect(r.texts.size).toBe(0);
  });
});
