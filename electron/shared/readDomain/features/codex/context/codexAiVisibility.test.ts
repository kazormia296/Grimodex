// MP-4b PR-8a: the pure decision of which Codex entries the AI may see.
// Relative imports only (the electron vitest config has no `@` alias).
import { describe, expect, it } from "vitest";

import type { CodexEntryPhase } from "../../../db/schema.js";
import type { TreeNodeData } from "../../tree/types.js";
import {
  closeResolvedCodexForUnresolvableScene,
  decideCodexAiVisibility,
  isPhaseAnchorOrphaned,
  listEntryIdsClosedForAi,
  listEntryIdsClosedWhenSceneUnresolvable,
  listEntryIdsWithOrphanedHiddenPhase,
  type CodexResolutionState,
} from "./codexAiVisibility.js";
import { resolveApplicablePhases } from "./resolveApplicablePhases.js";
import { buildSceneTimeIndex, type TemporalAnchor } from "./sceneTimeIndex.js";

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

    it("no scene (null, undefined, empty, only spaces) is the base anchor, and the scene cannot be resolved: no phase applies, so `pub` (which a phase hides) is hidden too (DR-MP4-41, Q1)", () => {
      // Before Q1 the result was hidden = [hid], visible = [pub] (fail open).
      for (const sceneId of [null, undefined, "", "   "]) {
        const r = decide({ entries: [PUBLIC, HIDDEN], phases, sceneId });
        expect([...r.hidden].sort(), String(sceneId)).toEqual(["hid", "pub"]);
        expect([...r.texts.keys()], String(sceneId)).toEqual([]);
        expect(r.released, String(sceneId)).toEqual([]);
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
      // `pub` is hidden too: a phase hides it and the scene cannot be resolved (DR-MP4-41).
      expect(r.hidden.has("pub")).toBe(true);
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

    it("a phase whose anchor scene no longer exists (dangling) counts as a phase that hides", () => {
      // The anchor scene is deleted, so the phase never applies; the entry is hidden when
      // the scene cannot be resolved (which phases would apply is unknown), and, since
      // DR-MP4-46, at a scene that is in the reading order too (the resolver skips the
      // phase, so base alone must not be read as public). Before DR-MP4-46 "s1" was [].
      const dangling = phase("ph-dangling", "pub", "deleted-scene", {
        contextModeOverride: "hidden",
      });
      for (const sceneId of [MISSING, null, "s1"]) {
        const r = decide({ entries: [PUBLIC], phases: [dangling], sceneId });
        expect([...r.hidden], String(sceneId)).toEqual(["pub"]);
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

  // DR-MP4-41 Q1 (2026-11-23): "no scene" cannot be resolved either, so the same rule
  // applies. The anchor stays base; only the visibility decision changes.
  describe("no scene (null, undefined, empty, only spaces; DR-MP4-41 Q1)", () => {
    const NO_SCENE = [null, undefined, "", "   "];
    const hidePhase = (entryId: string) =>
      phase(`ph-hide-${entryId}`, entryId, "s2", {
        contextModeOverride: "hidden",
      });

    it("hides every kind of entry that a phase hides, and only those", () => {
      const entries = [
        entry("pub-phase-hide", "mentioned"), // base public x phase hidden -> hidden (changed by Q1)
        entry("hid-phase-hide", "hidden"), // base hidden x phase hidden -> hidden (as before)
        entry("hid-phase-pub", "hidden"), // base hidden x phase public -> hidden (as before)
        entry("pub-no-phase", "mentioned"), // no phase -> public (as before)
        entry("pub-phase-pub", "mentioned"), // phases that hide nothing -> public (as before)
        entry("odd-phase-pub", "not-a-mode"), // unknown mode -> hidden (as before)
      ];
      const phases = [
        hidePhase("pub-phase-hide"),
        hidePhase("hid-phase-hide"),
        phase("ph-rel", "hid-phase-pub", "s2", {
          contextModeOverride: "mentioned",
        }),
        phase("ph-text", "pub-phase-pub", "s2", {
          contentOverride: "later text",
        }),
        phase("ph-suppress", "pub-phase-pub", "s3", {
          contextModeOverride: "suppress",
        }),
      ];
      for (const sceneId of NO_SCENE) {
        const r = decide({ entries, phases, sceneId });
        expect([...r.hidden].sort(), String(sceneId)).toEqual([
          "hid-phase-hide",
          "hid-phase-pub",
          "odd-phase-pub",
          "pub-phase-hide",
        ]);
        expect([...r.texts.keys()].sort(), String(sceneId)).toEqual([
          "pub-no-phase",
          "pub-phase-pub",
        ]);
        expect(r.released, String(sceneId)).toEqual([]);
        expect(r.anchor, String(sceneId)).toEqual({ kind: "base" });
      }
    });

    it("gives the entries that stay public their own base text", () => {
      const r = decide({
        entries: [PUBLIC],
        phases: [
          phase("ph-text", "pub", "s2", { contentOverride: "later text" }),
        ],
        sceneId: null,
      });
      expect(r.texts.get("pub")).toMatchObject({
        content: "pub content",
        released: false,
        mode: "mentioned",
      });
    });

    it("is the same in every resolution mode and for an empty reading order", () => {
      for (const mode of ["reading", "story", "auto"] as const) {
        for (const nodes of [FULL_STORY, NO_STORY, []]) {
          const r = decide({
            entries: [PUBLIC],
            phases: [hidePhase("pub")],
            sceneId: "  ",
            nodes,
            resolutionMode: resolved(mode),
          });
          expect([...r.hidden], mode).toEqual(["pub"]);
        }
      }
    });

    it("with an unresolved resolution mode every entry is hidden, as before", () => {
      const r = decide({
        entries: [PUBLIC],
        sceneId: null,
        resolutionMode: { kind: "unresolved" },
      });
      expect([...r.hidden]).toEqual(["pub"]);
    });

    it("an entry with no phase at all is unchanged (the whole call is not hidden)", () => {
      const r = decide({ entries: [PUBLIC, HIDDEN, UNKNOWN], sceneId: null });
      expect([...r.hidden].sort()).toEqual(["hid", "odd"]);
      expect([...r.texts.keys()]).toEqual(["pub"]);
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

describe("listEntryIdsClosedWhenSceneUnresolvable (the rule chat's context shares with the agent tool)", () => {
  const index = buildSceneTimeIndex(NO_STORY);
  const phasesByEntry = (rows: CodexEntryPhase[]) => {
    const map = new Map<string, CodexEntryPhase[]>();
    for (const row of rows) {
      map.set(row.entryId, [...(map.get(row.entryId) ?? []), row]);
    }
    return map;
  };
  const KINDS: CodexEntryPhase[] = [
    phase("p-hide", "hide", "s2", { contextModeOverride: "hidden" }),
    phase("p-odd", "odd-mode", "s2", { contextModeOverride: "not-a-mode" }),
    phase("p-pub", "pub-phase", "s2", { contextModeOverride: "mentioned" }),
    phase("p-suppress", "suppress", "s2", { contextModeOverride: "suppress" }),
    phase("p-always", "always", "s2", { contextModeOverride: "always" }),
    phase("p-text", "text-only", "s2", { summaryOverride: "text" }),
    phase("p-dangle", "dangling", "gone", { contextModeOverride: "hidden" }),
    phase("p-null", "null-anchor", null, { contextModeOverride: "hidden" }),
    phase("p-a", "multi", "s1", { contextModeOverride: "mentioned" }),
    phase("p-b", "multi", "s3", { contextModeOverride: "hidden" }),
  ];
  const CLOSED = ["hide", "odd-mode", "dangling", "null-anchor", "multi"];
  const closed = (anchor: TemporalAnchor, rows = KINDS) =>
    [
      ...listEntryIdsClosedWhenSceneUnresolvable({
        anchor,
        sceneTimeIndex: index,
        phasesByEntry: phasesByEntry(rows),
      }),
    ].sort();

  it("names the entries one of whose Phases hides them (hidden, an unknown mode, a dangling or null anchor) when the anchor is base", () => {
    expect(closed({ kind: "base" })).toEqual([...CLOSED].sort());
  });

  it("names the same when the scene is not in the reading order (a note, a deleted id, a padded id)", () => {
    for (const sceneId of ["n-note", "no-such-scene", " s1 ", ""]) {
      expect(closed({ kind: "scene", sceneId }), sceneId).toEqual(
        [...CLOSED].sort(),
      );
    }
  });

  it("names nothing while the scene is in the reading order", () => {
    expect(closed({ kind: "scene", sceneId: "s1" })).toEqual([]);
    expect(closed({ kind: "scene", sceneId: "s3" })).toEqual([]);
  });

  it("names nothing for latest and for a Phase preview (they do not depend on a current scene)", () => {
    expect(closed({ kind: "latest" })).toEqual([]);
    expect(closed({ kind: "phase", phaseId: "p-hide" })).toEqual([]);
  });

  it("names every entry of an empty reading order the same way (the index was just reset)", () => {
    const empty = buildSceneTimeIndex([]);
    const ids = listEntryIdsClosedWhenSceneUnresolvable({
      anchor: { kind: "scene", sceneId: "s1" },
      sceneTimeIndex: empty,
      phasesByEntry: phasesByEntry(KINDS),
    });
    expect([...ids].sort()).toEqual([...CLOSED].sort());
  });

  it("does not name an entry with no Phase, only visible or text-only Phases, or only suppress and always", () => {
    const names = closed({ kind: "base" });
    for (const id of ["pub-phase", "suppress", "always", "text-only"]) {
      expect(names).not.toContain(id);
    }
  });

  it("is the DR-MP4-41 half of the rule decideCodexAiVisibility applies: when the scene cannot be resolved, for a base-public entry its hidden set is the named set", () => {
    const entries = [
      ...new Set(KINDS.map((row) => row.entryId)),
      "no-phase",
    ].map((id) => entry(id, "mentioned"));
    // A scene the reading order has ("s1", and " s1 ", which decide trims) is left out here: since
    // DR-MP4-46 decide also hides the entries with a hiding Phase that lost its anchor there, which
    // this half does not name. The whole rule is compared with listEntryIdsClosedForAi below.
    for (const sceneId of [null, "", "n-note"]) {
      const decision = decideCodexAiVisibility({
        entries,
        phases: KINDS,
        sceneId,
        sceneTimeIndex: index,
        resolutionMode: resolved("reading"),
      });
      const named = listEntryIdsClosedWhenSceneUnresolvable({
        anchor: decision.anchor,
        sceneTimeIndex: index,
        phasesByEntry: phasesByEntry(KINDS),
      });
      expect([...decision.hidden].sort(), String(sceneId)).toEqual(
        [...named].sort(),
      );
    }
  });
});

describe("closeResolvedCodexForUnresolvableScene", () => {
  const resolvedState = (id: string, contextMode: string) => ({
    id,
    summary: `${id} summary`,
    content: `${id} content`,
    contextMode,
    detailValues: new Map([["d", `${id} detail`]]),
  });

  it("replaces only the mode of the named entries and leaves their text, details and the other entries as they are", () => {
    const input = new Map([
      ["a", resolvedState("a", "mentioned")],
      ["b", resolvedState("b", "always")],
      ["c", resolvedState("c", "suppress")],
    ]);
    const out = closeResolvedCodexForUnresolvableScene(
      input,
      new Set(["a", "c"]),
    );
    expect(out.get("a")).toEqual({ ...input.get("a"), contextMode: "hidden" });
    expect(out.get("c")).toEqual({ ...input.get("c"), contextMode: "hidden" });
    expect(out.get("b")).toBe(input.get("b"));
    expect([...out.keys()]).toEqual(["a", "b", "c"]);
  });

  it("returns a copy and does not change the input", () => {
    const input = new Map([["a", resolvedState("a", "mentioned")]]);
    const out = closeResolvedCodexForUnresolvableScene(input, new Set(["a"]));
    expect(out).not.toBe(input);
    expect(input.get("a")?.contextMode).toBe("mentioned");
  });

  it("ignores a named id the map does not have, and changes nothing for an empty set", () => {
    const input = new Map([["a", resolvedState("a", "mentioned")]]);
    expect(
      closeResolvedCodexForUnresolvableScene(input, new Set(["x"])).get("a"),
    ).toBe(input.get("a"));
    expect(
      closeResolvedCodexForUnresolvableScene(input, new Set()).get("a"),
    ).toBe(input.get("a"));
  });
});

// DR-MP4-46: a Phase that hides an entry but whose anchor scene the resolver cannot place
// (null, deleted, archived, under an archived folder) is skipped by `resolveApplicablePhases`
// for every anchor, so base alone would be read as public. The AI visibility closes such an
// entry (fail closed, over-hiding on purpose: where the Phase would have applied cannot be told).
// Before DR-MP4-46 the first test below expected the entry to stay public (the known hole).
describe("a hiding Phase that lost its anchor (DR-MP4-46)", () => {
  const folderArchived = {
    ...scene("f-arch", "a8"),
    nodeType: "folder" as const,
    archivedAt: NOW,
  };
  const NODES: TreeNodeData[] = [
    ...FULL_STORY,
    { ...scene("s-arch", "a9", "a9"), archivedAt: NOW },
    folderArchived,
    { ...scene("s-under", "a0", "a0"), parentId: "f-arch" },
    { ...scene("n-note", "a7"), nodeType: "note" as const },
  ];
  const index = buildSceneTimeIndex(NODES);
  const hide = { contextModeOverride: "hidden" } as const;
  const ORPHANS: Array<[string, CodexEntryPhase]> = [
    ["anchor is null", phase("ph-null", "pub", null, hide)],
    ["anchor scene is deleted", phase("ph-gone", "pub", "deleted-scene", hide)],
    ["anchor scene is archived", phase("ph-arch", "pub", "s-arch", hide)],
    [
      "anchor scene is under an archived folder",
      phase("ph-under", "pub", "s-under", hide),
    ],
    ["anchor is a note", phase("ph-note", "pub", "n-note", hide)],
    [
      "an unknown mode",
      phase("ph-odd", "pub", null, { contextModeOverride: "not-a-mode" }),
    ],
  ];
  const MODES = ["reading", "story", "auto"] as const;
  const byEntry = (rows: CodexEntryPhase[]) => {
    const map = new Map<string, CodexEntryPhase[]>();
    for (const row of rows) {
      map.set(row.entryId, [...(map.get(row.entryId) ?? []), row]);
    }
    return map;
  };

  it.each(ORPHANS)(
    "%s: the entry is hidden at every scene the reading order has, in every resolution mode",
    (_label, orphan) => {
      for (const mode of MODES) {
        for (const sceneId of ["s1", "s2", "s3"]) {
          const r = decide({
            entries: [PUBLIC],
            phases: [orphan],
            sceneId,
            nodes: NODES,
            resolutionMode: resolved(mode),
          });
          expect([...r.hidden], `${mode} ${sceneId}`).toEqual(["pub"]);
          expect(r.texts.size, `${mode} ${sceneId}`).toBe(0);
          expect(r.released, `${mode} ${sceneId}`).toEqual([]);
        }
      }
    },
  );

  it("closes an entry that has an orphaned hiding Phase and a placeable public Phase too (over-hide, fixed as the rule)", () => {
    const r = decide({
      entries: [PUBLIC],
      phases: [
        phase("ph-gone", "pub", "deleted-scene", hide),
        phase("ph-ok", "pub", "s2", { contextModeOverride: "always" }),
      ],
      sceneId: "s3",
      nodes: NODES,
    });
    expect([...r.hidden]).toEqual(["pub"]);
  });

  it("does not close an entry whose hiding Phases all have a placeable anchor (the resolver applies them), nor one whose orphaned Phase does not hide", () => {
    const placeable = decide({
      entries: [PUBLIC],
      phases: [phase("ph-s2", "pub", "s2", hide)],
      sceneId: "s1",
      nodes: NODES,
    });
    expect([...placeable.hidden]).toEqual([]);
    expect(placeable.texts.get("pub")).toBeDefined();
    for (const contextModeOverride of [
      "suppress",
      "mentioned",
      "always",
      null,
    ]) {
      const r = decide({
        entries: [PUBLIC],
        phases: [
          phase("ph-o", "pub", null, { contextModeOverride }),
          phase("ph-d", "pub", "deleted-scene", {
            contextModeOverride,
            summaryOverride: "text only",
          }),
        ],
        sceneId: "s1",
        nodes: NODES,
      });
      expect([...r.hidden], String(contextModeOverride)).toEqual([]);
    }
  });

  it("keeps a base-hidden entry hidden when an orphaned hiding Phase and a placeable Phase would release it (nothing is released)", () => {
    const r = decide({
      entries: [HIDDEN],
      phases: [
        phase("ph-gone", "hid", null, hide),
        phase("ph-rel", "hid", "s1", { contextModeOverride: "mentioned" }),
      ],
      sceneId: "s2",
      nodes: NODES,
    });
    expect([...r.hidden]).toEqual(["hid"]);
    expect(r.released).toEqual([]);
    expect(r.texts.size).toBe(0);
  });

  it("an empty reading order (the index was just reset) closes the entry for any scene id (also by DR-MP4-41)", () => {
    const r = decide({
      entries: [PUBLIC],
      phases: [phase("ph-gone", "pub", "s2", hide)],
      sceneId: "s1",
      nodes: [],
    });
    expect([...r.hidden]).toEqual(["pub"]);
  });

  it("an unresolved resolution state hides everything, as before", () => {
    const r = decide({
      entries: [PUBLIC],
      phases: [phase("ph-gone", "pub", null, hide)],
      resolutionMode: { kind: "unresolved" },
    });
    expect([...r.hidden]).toEqual(["pub"]);
  });

  describe("isPhaseAnchorOrphaned", () => {
    it("is true for a null anchor and for an id the reading order does not have, false for a placeable one", () => {
      const at = (anchorNodeId: string | null) =>
        isPhaseAnchorOrphaned({ anchorNodeId }, index);
      expect(at(null)).toBe(true);
      for (const id of [
        "deleted-scene",
        "s-arch",
        "s-under",
        "f-arch",
        "n-note",
        "",
      ]) {
        expect(at(id), id).toBe(true);
      }
      for (const id of ["s1", "s2", "s3"]) expect(at(id), id).toBe(false);
    });

    it("is the resolver's skip condition: it picks exactly the Phases resolveApplicablePhases puts in skippedPhaseIds, for every index, mode and anchor", () => {
      const phases = [
        ...ORPHANS.map(([, p]) => p),
        phase("ph-gone-2", "pub", "", hide),
        phase("ph-s1", "pub", "s1", hide),
        phase("ph-s2", "pub", "s2", { contextModeOverride: "mentioned" }),
        phase("ph-s3", "pub", "s3", { summaryOverride: "text" }),
      ];
      const indexes = [
        buildSceneTimeIndex(NODES),
        buildSceneTimeIndex(NO_STORY),
        buildSceneTimeIndex(FULL_STORY),
        buildSceneTimeIndex([]),
      ];
      const anchors: TemporalAnchor[] = [
        { kind: "base" },
        { kind: "latest" },
        { kind: "scene", sceneId: "s1" },
        { kind: "scene", sceneId: "s3" },
        { kind: "scene", sceneId: "no-such-scene" },
        { kind: "phase", phaseId: "ph-s1" },
        { kind: "phase", phaseId: "ph-null" },
        { kind: "phase", phaseId: "no-such-phase" },
      ];
      for (const [i, sceneIndex] of indexes.entries()) {
        const picked = phases
          .filter((p) => isPhaseAnchorOrphaned(p, sceneIndex))
          .map((p) => p.id)
          .sort();
        for (const mode of MODES) {
          for (const anchor of anchors) {
            const out = resolveApplicablePhases({
              phases,
              index: sceneIndex,
              mode,
              anchor,
            });
            expect(
              [...out.skippedPhaseIds].sort(),
              `index ${i} ${mode} ${anchor.kind}`,
            ).toEqual(picked);
          }
        }
      }
    });
  });

  describe("no hiding Phase is dropped silently", () => {
    it("whenever decide does not hide an entry, none of its hiding Phases is in skippedPhaseIds (a new reason for the resolver to skip must reach the rule)", () => {
      const phases = [
        ...ORPHANS.map(([, p]) => p).map((p, i) => ({
          ...p,
          id: `${p.id}-${i}`,
          entryId: `e-${i}`,
        })),
        phase("ph-ok-1", "e-ok-1", "s1", hide),
        phase("ph-ok-2", "e-ok-2", "s3", hide),
        phase("ph-ok-3", "e-ok-3", "s2", { contextModeOverride: "suppress" }),
      ];
      const entries = [...new Set(phases.map((p) => p.entryId))].map((id) =>
        entry(id, "mentioned"),
      );
      for (const mode of MODES) {
        for (const sceneId of ["s1", "s2", "s3"]) {
          const decision = decideCodexAiVisibility({
            entries,
            phases,
            sceneId,
            sceneTimeIndex: index,
            resolutionMode: resolved(mode),
          });
          const skipped = new Set(
            resolveApplicablePhases({
              phases,
              index,
              mode,
              anchor: { kind: "scene", sceneId },
            }).skippedPhaseIds,
          );
          for (const p of phases) {
            if (decision.hidden.has(p.entryId)) continue;
            const hides =
              p.contextModeOverride !== null &&
              p.contextModeOverride !== "mentioned" &&
              p.contextModeOverride !== "always" &&
              p.contextModeOverride !== "suppress";
            expect(
              hides && skipped.has(p.id),
              `${mode} ${sceneId} ${p.id}`,
            ).toBe(false);
          }
        }
      }
    });
  });

  describe("listEntryIdsWithOrphanedHiddenPhase", () => {
    const rows: CodexEntryPhase[] = [
      phase("a-null", "null-hide", null, hide),
      phase("a-gone", "gone-hide", "deleted-scene", hide),
      phase("a-arch", "arch-hide", "s-arch", hide),
      phase("a-odd", "odd-mode", null, { contextModeOverride: "not-a-mode" }),
      phase("a-sup", "suppress", null, { contextModeOverride: "suppress" }),
      phase("a-men", "mentioned", "deleted-scene", {
        contextModeOverride: "mentioned",
      }),
      phase("a-alw", "always", null, { contextModeOverride: "always" }),
      phase("a-txt", "text-only", null, { summaryOverride: "t" }),
      phase("a-ok", "placeable", "s2", hide),
      phase("a-m1", "multi", "s1", { contextModeOverride: "mentioned" }),
      phase("a-m2", "multi", "gone", hide),
    ];
    const named = (index_ = index, map = byEntry(rows)) =>
      [
        ...listEntryIdsWithOrphanedHiddenPhase({
          sceneTimeIndex: index_,
          phasesByEntry: map,
        }),
      ].sort();

    it("names the entries with a hiding Phase (hidden or an unknown mode) whose anchor is null or not in the reading order", () => {
      expect(named()).toEqual(
        ["arch-hide", "gone-hide", "multi", "null-hide", "odd-mode"].sort(),
      );
    });

    it("does not name suppress, mentioned, always, text-only or a placeable hiding Phase", () => {
      const names = named();
      for (const id of [
        "suppress",
        "mentioned",
        "always",
        "text-only",
        "placeable",
      ]) {
        expect(names).not.toContain(id);
      }
    });

    it("does not depend on any anchor or scene: an empty reading order names every entry with a hiding Phase", () => {
      expect(named(buildSceneTimeIndex([]))).toEqual(
        [
          "arch-hide",
          "gone-hide",
          "multi",
          "null-hide",
          "odd-mode",
          "placeable",
        ].sort(),
      );
    });

    it("names nothing for no Phases and for an entry with an empty list", () => {
      expect(named(index, new Map())).toEqual([]);
      expect(named(index, new Map([["x", []]]))).toEqual([]);
    });
  });

  describe("listEntryIdsClosedForAi", () => {
    const rows: CodexEntryPhase[] = [
      phase("p-ok", "placeable", "s2", hide),
      phase("p-gone", "orphaned", "deleted-scene", hide),
      phase("p-null", "null-anchor", null, hide),
      phase("p-pub", "orphan-public", null, {
        contextModeOverride: "mentioned",
      }),
    ];
    const closed = (anchor: TemporalAnchor) =>
      [
        ...listEntryIdsClosedForAi({
          anchor,
          sceneTimeIndex: index,
          phasesByEntry: byEntry(rows),
        }),
      ].sort();

    it("is the union of the two rules: base and a scene the reading order lacks close every entry with a hiding Phase", () => {
      const all = ["null-anchor", "orphaned", "placeable"];
      expect(closed({ kind: "base" })).toEqual(all);
      expect(closed({ kind: "scene", sceneId: "no-such-scene" })).toEqual(all);
      expect(closed({ kind: "scene", sceneId: "n-note" })).toEqual(all);
    });

    it("closes only the entries whose hiding Phase lost its anchor while the scene can be resolved", () => {
      expect(closed({ kind: "scene", sceneId: "s1" })).toEqual([
        "null-anchor",
        "orphaned",
      ]);
      expect(closed({ kind: "scene", sceneId: "s3" })).toEqual([
        "null-anchor",
        "orphaned",
      ]);
    });

    it("closes them for latest (the codex scope) and for a Phase preview too (Q-G1)", () => {
      expect(closed({ kind: "latest" })).toEqual(["null-anchor", "orphaned"]);
      expect(closed({ kind: "phase", phaseId: "p-ok" })).toEqual([
        "null-anchor",
        "orphaned",
      ]);
    });

    it("is the rule decideCodexAiVisibility applies: for a base-public entry its hidden set is the named set (where no placeable Phase applies; the named set is always hidden)", () => {
      const entries = [
        ...new Set(KIND_ROWS.map((row) => row.entryId)),
        "no-phase",
      ].map((id) => entry(id, "mentioned"));
      const kindIndex = buildSceneTimeIndex(NO_STORY);
      for (const sceneId of [null, "", "n-note", " s1 ", "s1", "s2", "s3"]) {
        const decision = decideCodexAiVisibility({
          entries,
          phases: KIND_ROWS,
          sceneId,
          sceneTimeIndex: kindIndex,
          resolutionMode: resolved("reading"),
        });
        const named = listEntryIdsClosedForAi({
          anchor: decision.anchor,
          sceneTimeIndex: kindIndex,
          phasesByEntry: byEntry(KIND_ROWS),
        });
        if (sceneId === "s2" || sceneId === "s3") {
          // The placeable Phases (hide at s2, odd-mode at s2, hide at s3) apply here and hide
          // more than the rule closes; what the rule closes is always hidden.
          for (const id of named)
            expect(decision.hidden.has(id), id).toBe(true);
        } else {
          expect([...decision.hidden].sort(), String(sceneId)).toEqual(
            [...named].sort(),
          );
        }
      }
    });
  });
});

/** The rows of the "listEntryIdsClosedWhenSceneUnresolvable" describe above, for the whole-rule comparison. */
const KIND_ROWS: CodexEntryPhase[] = [
  phase("p-hide", "hide", "s2", { contextModeOverride: "hidden" }),
  phase("p-odd", "odd-mode", "s2", { contextModeOverride: "not-a-mode" }),
  phase("p-pub", "pub-phase", "s2", { contextModeOverride: "mentioned" }),
  phase("p-suppress", "suppress", "s2", { contextModeOverride: "suppress" }),
  phase("p-always", "always", "s2", { contextModeOverride: "always" }),
  phase("p-text", "text-only", "s2", { summaryOverride: "text" }),
  phase("p-dangle", "dangling", "gone", { contextModeOverride: "hidden" }),
  phase("p-null", "null-anchor", null, { contextModeOverride: "hidden" }),
  phase("p-a", "multi", "s1", { contextModeOverride: "mentioned" }),
  phase("p-b", "multi", "s3", { contextModeOverride: "hidden" }),
];
